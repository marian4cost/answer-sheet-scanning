import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Pool, PoolClient } from 'pg';
import { DATABASE_PATH, DATABASE_URL, DATABASE_SSL, PROJECT_ROOT } from './config';
import { assetPath } from './assets';

export interface DatabaseRunResult { changes: number; lastInsertRowid?: number }
type TransactionContext = {postgres?: PoolClient; sqlite?: true};
const ID_TABLES = new Set(['core_simulado', 'core_lotecorrecao', 'core_resultadoaluno', 'report_deliveries']);

/** Traduz apenas placeholders fora de literais SQL; valores continuam parametrizados. */
export function postgresPlaceholders(sql: string): string {
  let result = '', i = 0, index = 0, quote: string | null = null;
  while (i < sql.length) {
    const char = sql[i];
    if (quote) {
      result += char;
      if (char === quote) {
        if (sql[i + 1] === quote) result += sql[++i];
        else quote = null;
      }
      i++; continue;
    }
    if (char === "'" || char === '"') { quote = char; result += char; i++; continue; }
    if (sql.slice(i, i + 2) === '--') {
      const end = sql.indexOf('\n', i), length = end < 0 ? sql.length : end;
      result += sql.slice(i, length); i = length; continue;
    }
    if (sql.slice(i, i + 2) === '/*') {
      const end = sql.indexOf('*/', i + 2), length = end < 0 ? sql.length : end + 2;
      result += sql.slice(i, length); i = length; continue;
    }
    const dollar = char === '$' ? sql.slice(i).match(/^\$(?:[a-zA-Z_][a-zA-Z0-9_]*)?\$/)?.[0] : undefined;
    if (dollar) {
      const end = sql.indexOf(dollar, i + dollar.length);
      if (end < 0) throw new Error('Literal SQL incompleto.');
      result += sql.slice(i, end + dollar.length); i = end + dollar.length; continue;
    }
    result += char === '?' ? '$' + ++index : char;
    i++;
  }
  return result;
}

@Injectable()
export class DatabaseService implements OnModuleDestroy, OnModuleInit {
  private readonly sqlite?: DatabaseSync;
  private readonly pool?: Pool;
  private readonly context = new AsyncLocalStorage<TransactionContext>();
  private sqliteQueue: Promise<void> = Promise.resolve();
  private readonly ready: Promise<void>;
  private poolShutdown?: Promise<void>;
  readonly dialect: 'postgres' | 'sqlite';

  constructor() {
    if (process.env.VERCEL && !DATABASE_URL) throw new Error('Configure DATABASE_URL para executar a API na Vercel.');
    this.dialect = DATABASE_URL ? 'postgres' : 'sqlite';
    if (DATABASE_URL) {
      this.pool = new Pool({connectionString: DATABASE_URL, max: 5, connectionTimeoutMillis: 10_000,
        idleTimeoutMillis: 30_000, ...(DATABASE_SSL ? {ssl: {rejectUnauthorized: true}} : {})});
      this.ready = this.initializePostgres().catch(async error => {
        // Um cold start rejeitado não pode deixar um pool/instância inutilizável vivo.
        await this.closePool().catch(() => {});
        throw error;
      });
      // Guarda a rejeição até a primeira operação/startup para evitar unhandled rejection.
      void this.ready.catch(() => {});
    } else {
      mkdirSync(dirname(DATABASE_PATH), {recursive: true});
      this.sqlite = new DatabaseSync(DATABASE_PATH);
      this.initializeSqlite();
      this.ready = Promise.resolve();
    }
  }
  async onModuleInit() { await this.ready; }
  private closePool(): Promise<void> {
    return this.poolShutdown ??= this.pool ? this.pool.end() : Promise.resolve();
  }
  private async initializePostgres() {
    const client = await this.pool!.connect();
    try {
      await client.query('BEGIN');
      // Impede DDL concorrente durante múltiplos cold starts.
      await client.query('SELECT pg_advisory_xact_lock(593617205)');
      await client.query(readFileSync(assetPath('schema.sql'), 'utf8'));
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  private initializeSqlite() {
    this.sqlite!.exec(`
      PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS core_simulado (
        id INTEGER PRIMARY KEY AUTOINCREMENT, titulo TEXT NOT NULL,
        data_criacao TEXT NOT NULL, gabarito_oficial TEXT NOT NULL CHECK(json_valid(gabarito_oficial))
      );
      CREATE TABLE IF NOT EXISTS core_lotecorrecao (
        id INTEGER PRIMARY KEY AUTOINCREMENT, criado_em TEXT NOT NULL,
        simulado_id INTEGER NOT NULL REFERENCES core_simulado(id)
      );
      CREATE TABLE IF NOT EXISTS core_resultadoaluno (
        id INTEGER PRIMARY KEY AUTOINCREMENT, matricula TEXT NOT NULL,
        respostas_detectadas TEXT NOT NULL CHECK(json_valid(respostas_detectadas)),
        total_acertos INTEGER NOT NULL, total_erros INTEGER NOT NULL,
        total_rasuras INTEGER NOT NULL, total_brancos INTEGER NOT NULL,
        nota_percentual REAL NOT NULL, imagem_debug TEXT, status TEXT NOT NULL,
        lote_id INTEGER NOT NULL REFERENCES core_lotecorrecao(id),
        mensagem_leitura TEXT NOT NULL DEFAULT '', total_incertas INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS omr_envios_simulado ON core_lotecorrecao(simulado_id);
      CREATE INDEX IF NOT EXISTS omr_resultados_envio ON core_resultadoaluno(lote_id);
    `);
    const columns = (table: string) => this.sqlite!.prepare(`PRAGMA table_info(${table})`).all() as {name: string}[];
    if (!columns('core_lotecorrecao').some(column => column.name === 'gabarito_snapshot')) {
      this.sqlite!.exec("ALTER TABLE core_lotecorrecao ADD COLUMN gabarito_snapshot TEXT NOT NULL DEFAULT '{}'");
      this.sqlite!.exec(`UPDATE core_lotecorrecao SET gabarito_snapshot =
        (SELECT gabarito_oficial FROM core_simulado WHERE id = core_lotecorrecao.simulado_id)`);
    }
    if (!columns('core_simulado').some(column => column.name === 'total_questoes')) this.sqlite!.exec('ALTER TABLE core_simulado ADD COLUMN total_questoes INTEGER NOT NULL DEFAULT 50');
    if (!columns('core_simulado').some(column => column.name === 'temas')) this.sqlite!.exec("ALTER TABLE core_simulado ADD COLUMN temas TEXT NOT NULL DEFAULT '[]'");
    this.sqlite!.exec(`
      CREATE TABLE IF NOT EXISTS student_contacts (
        matricula TEXT PRIMARY KEY, email TEXT NOT NULL, nome TEXT NOT NULL DEFAULT '', atualizado_em TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS report_feedback (
        resultado_id INTEGER PRIMARY KEY REFERENCES core_resultadoaluno(id) ON DELETE CASCADE,
        nota_redacao REAL CHECK(nota_redacao IS NULL OR nota_redacao BETWEEN 0 AND 1000),
        feedback_redacao TEXT NOT NULL DEFAULT '', atualizado_em TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS report_deliveries (
        id INTEGER PRIMARY KEY AUTOINCREMENT, resultado_id INTEGER NOT NULL REFERENCES core_resultadoaluno(id) ON DELETE CASCADE,
        destinatario TEXT NOT NULL, status TEXT NOT NULL, content_hash TEXT NOT NULL,
        message_id TEXT, erro TEXT NOT NULL DEFAULT '', criado_em TEXT NOT NULL,
        UNIQUE(resultado_id,destinatario,content_hash)
      );
      CREATE TABLE IF NOT EXISTS uploaded_files (
        id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, size INTEGER NOT NULL CHECK(size>0 AND size<=20971520),
        purpose TEXT NOT NULL CHECK(purpose IN ('gabarito','prova')), created_at TEXT NOT NULL, consumed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS contacts_import_plans (
        token_hash TEXT PRIMARY KEY, payload TEXT NOT NULL CHECK(json_valid(payload)), expira_em TEXT NOT NULL, criado_em TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS report_delivery_plans (
        token_hash TEXT PRIMARY KEY, simulado_id INTEGER NOT NULL REFERENCES core_simulado(id) ON DELETE CASCADE,
        payload TEXT NOT NULL CHECK(json_valid(payload)), expira_em TEXT NOT NULL, criado_em TEXT NOT NULL
      );
    `);
  }
  private async sqliteLock<T>(work: () => T | Promise<T>): Promise<T> {
    const previous = this.sqliteQueue;
    let release!: () => void;
    this.sqliteQueue = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try { return await work(); } finally { release(); }
  }
  async all<T>(sql: string, ...params: SQLInputValue[]): Promise<T[]> {
    await this.ready;
    if (this.pool) {
      const connection = this.context.getStore()?.postgres ?? this.pool;
      return (await connection.query(postgresPlaceholders(sql), params)).rows as T[];
    }
    const work = () => this.sqlite!.prepare(sql).all(...params) as unknown as T[];
    return this.context.getStore()?.sqlite ? work() : this.sqliteLock(work);
  }
  async get<T>(sql: string, ...params: SQLInputValue[]): Promise<T | undefined> { return (await this.all<T>(sql, ...params))[0]; }
  async run(sql: string, ...params: SQLInputValue[]): Promise<DatabaseRunResult> {
    await this.ready;
    if (this.pool) {
      const connection = this.context.getStore()?.postgres ?? this.pool;
      let translated = postgresPlaceholders(sql);
      const table = translated.match(/^\s*INSERT\s+INTO\s+([a-z_]+)/i)?.[1].toLowerCase();
      if (table && ID_TABLES.has(table) && !/\bRETURNING\b/i.test(translated)) translated = translated.replace(/;\s*$/, '') + ' RETURNING id';
      const result = await connection.query(translated, params);
      return {changes: result.rowCount || 0, ...(result.rows[0]?.id !== undefined ? {lastInsertRowid: Number(result.rows[0].id)} : {})};
    }
    const work = () => {
      const result = this.sqlite!.prepare(sql).run(...params);
      return {changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid)};
    };
    return this.context.getStore()?.sqlite ? work() : this.sqliteLock(work);
  }
  async transaction<T>(work: () => T | Promise<T>): Promise<T> {
    await this.ready;
    if (this.context.getStore()) return work();
    if (this.pool) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const result = await this.context.run({postgres: client}, work);
        await client.query('COMMIT'); return result;
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
    return this.sqliteLock(async () => {
      this.sqlite!.exec('BEGIN IMMEDIATE');
      try {
        const result = await this.context.run({sqlite: true}, work);
        this.sqlite!.exec('COMMIT'); return result;
      } catch (error) { this.sqlite!.exec('ROLLBACK'); throw error; }
    });
  }
  async health() { await this.get('SELECT 1 AS ok'); return {ok: true, dialect: this.dialect}; }
  async onModuleDestroy() {
    await this.ready.catch(() => {});
    if (this.pool) await this.closePool();
    if (this.sqlite) await this.sqliteLock(() => this.sqlite!.close());
  }
}
