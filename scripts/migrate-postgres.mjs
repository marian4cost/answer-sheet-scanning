#!/usr/bin/env node
/** Copia os dados locais, preservando IDs, notas, matrícula e snapshots. Nunca sobrescreve conflitos. */
import { DatabaseSync } from 'node:sqlite';
import { readFile, access } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { config as dotenv } from 'dotenv';
import pg from 'pg';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
dotenv({path: resolve(root, '.env'), quiet: true});
if (!process.env.DATABASE_URL) throw new Error('Configure DATABASE_URL do PostgreSQL antes de migrar.');
const source = resolve(root, process.env.DATABASE_PATH || 'db.sqlite3');
await access(source);
const sqlite = new DatabaseSync(source, {readOnly: true});
const pool = new pg.Pool({connectionString: process.env.DATABASE_URL, max: 1,
  connectionTimeoutMillis: 15_000,
  ...(process.env.DATABASE_SSL === 'true' ? {ssl: {rejectUnauthorized: true,
    ...(process.env.DATABASE_SSL_CA_BASE64 ? {ca: Buffer.from(process.env.DATABASE_SSL_CA_BASE64, 'base64').toString('utf8')} : {})}} : {})});
const tables = [
  ['core_simulado', 'id'], ['core_lotecorrecao', 'id'], ['core_resultadoaluno', 'id'],
  ['student_contacts', 'matricula'], ['report_feedback', 'resultado_id'], ['report_deliveries', 'id'],
  ['report_delivery_plans', 'token_hash'], ['contacts_import_plans', 'token_hash'], ['uploaded_files', 'id'],
];
const hash = buffer => createHash('sha256').update(buffer).digest('hex');
const withMedia = process.argv.includes('--include-media');
const snapshot = new Map();
let client;
try {
  sqlite.exec('BEGIN');
  for (const [table] of tables) {
    if (sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)) {
      snapshot.set(table, sqlite.prepare(`SELECT * FROM ${table}`).all());
    }
  }
  sqlite.exec('COMMIT');
  client = await pool.connect();
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(593617205)');
  await client.query(await readFile(resolve(root, 'infra/sql/001-schema.sql'), 'utf8'));
  for (const [table, primaryKey] of tables) {
    const rows = snapshot.get(table) || [];
    const columnResult = await client.query('SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=$1', [table]);
    const allowed = new Set(columnResult.rows.map(row => row.column_name));
    for (const row of rows) {
      const columns = Object.keys(row).filter(column => allowed.has(column));
      const old = (await client.query(`SELECT * FROM ${table} WHERE ${primaryKey}=$1`, [row[primaryKey]])).rows[0];
      if (old) {
        if (columns.some(column => String(old[column] ?? '') !== String(row[column] ?? ''))) {
          throw new Error(`Conflito em ${table}. Migração abortada para preservar o registro existente.`);
        }
        continue;
      }
      await client.query(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map((_, i) => '$' + (i + 1)).join(',')})`, columns.map(column => row[column]));
    }
    if (primaryKey === 'id' && table !== 'uploaded_files') {
      await client.query(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE((SELECT MAX(id) FROM ${table}),1), EXISTS(SELECT 1 FROM ${table}))`);
    }
    console.log(`${table}: ${rows.length} registro(s) conferidos.`);
  }
  // Preenche snapshots apenas quando a versão SQLite anterior ainda não os possuía.
  await client.query("UPDATE core_lotecorrecao l SET gabarito_snapshot=s.gabarito_oficial FROM core_simulado s WHERE l.simulado_id=s.id AND l.gabarito_snapshot='{}'");
  if (withMedia) {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('Configure o Storage privado antes de usar --include-media.');
    const {StorageService} = await import('../apps/api/dist/storage.service.js');
    // O adapter lê STORAGE_MODE ao ser importado; mantenha a opção explícita para migração.
    if (!new StorageService().privateCloud) throw new Error('Configure STORAGE_MODE=supabase para migrar os arquivos.');
    const storage = new StorageService();
    const mediaRoot = resolve(root, process.env.MIGRATION_MEDIA_ROOT || 'media');
    const keys = [...new Set((snapshot.get('core_resultadoaluno') || []).map(row => row.imagem_debug).filter(Boolean))];
    for (const key of keys) {
      if (key.startsWith('/') || key.split('/').some(segment => segment === '..')) throw new Error('Caminho de imagem legado inválido.');
      const content = await readFile(resolve(mediaRoot, key));
      let existing;
      try { existing = await storage.get(key); }
      catch (error) { if (error?.getStatus?.() !== 404) throw error; }
      if (existing) {
        if (hash(existing.buffer) !== hash(content)) throw new Error('O Storage já contém uma imagem diferente no mesmo caminho. Migração abortada.');
      } else await storage.put(key, content, key.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg');
    }
    console.log(`${keys.length} imagem(ns) de conferência guardadas no bucket privado.`);
  }
  await client.query('COMMIT');
  console.log('Migração concluída. O arquivo SQLite original permaneceu intacto.');
} catch (error) {
  if (client) await client.query('ROLLBACK').catch(() => {});
  // Não exponha DATABASE_URL, conteúdo de registros ou stack do driver em logs públicos.
  console.error(error instanceof Error && /^(Conflito|O Storage|Caminho|Configure)/.test(error.message) ? error.message : 'A migração falhou e as alterações no PostgreSQL foram revertidas. Confira a configuração e o schema.');
  process.exitCode = 1;
} finally {
  client?.release();
  await pool.end();
  sqlite.close();
}
