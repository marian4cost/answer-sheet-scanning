#!/usr/bin/env node
/** Verificação independente, somente leitura, dos registros e arquivos migrados. */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { config as dotenv } from 'dotenv';
import pg from 'pg';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
dotenv({path: resolve(root, '.env'), quiet: true});
if (!process.env.DATABASE_URL) throw new Error('Configure DATABASE_URL antes de verificar a migração.');
const source = new DatabaseSync(resolve(root, process.env.DATABASE_PATH || 'db.sqlite3'), {readOnly: true});
const pool = new pg.Pool({connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 15_000,
  ...(process.env.DATABASE_SSL === 'true' ? {ssl: {rejectUnauthorized: true,
    ...(process.env.DATABASE_SSL_CA_BASE64 ? {ca: Buffer.from(process.env.DATABASE_SSL_CA_BASE64, 'base64').toString('utf8')} : {})}} : {})});
const tables = [
  ['core_simulado', 'id'], ['core_lotecorrecao', 'id'], ['core_resultadoaluno', 'id'],
  ['student_contacts', 'matricula'], ['report_feedback', 'resultado_id'], ['report_deliveries', 'id'],
  ['report_delivery_plans', 'token_hash'], ['contacts_import_plans', 'token_hash'], ['uploaded_files', 'id'],
];
const hash = buffer => createHash('sha256').update(buffer).digest('hex');
const summary = {records: {}, images: 0, identicalFiles: 0, rowSecurity: false, tlsVerified: false};
let client;
try {
  const snapshots = new Map();
  source.exec('BEGIN');
  for (const [table] of tables) {
    if (source.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)) {
      snapshots.set(table, source.prepare(`SELECT * FROM ${table}`).all());
    }
  }
  source.exec('COMMIT');
  client = await pool.connect();
  summary.tlsVerified = !!client.connection.stream.authorized;
  if (process.env.DATABASE_SSL === 'true') assert.ok(summary.tlsVerified, 'TLS não verificado');
  await client.query('BEGIN READ ONLY');
  for (const [table, primaryKey] of tables) {
    const rows = snapshots.get(table) || [];
    for (const row of rows) {
      const migrated = (await client.query(`SELECT * FROM ${table} WHERE ${primaryKey}=$1`, [row[primaryKey]])).rows[0];
      assert.ok(migrated, `Registro ausente em ${table}`);
      for (const column of Object.keys(row)) {
        assert.equal(String(migrated[column] ?? ''), String(row[column] ?? ''), `Valor alterado em ${table}.${column}`);
      }
    }
    summary.records[table] = rows.length;
  }
  const rls = await client.query('SELECT tablename,rowsecurity FROM pg_tables WHERE schemaname=$1 AND tablename=ANY($2::text[])', ['public', tables.map(([table]) => table)]);
  assert.equal(rls.rows.length, tables.length); assert.ok(rls.rows.every(row => row.rowsecurity));
  summary.rowSecurity = true;
  await client.query('COMMIT');
  if (process.argv.includes('--include-media')) {
    const {StorageService} = await import('../apps/api/dist/storage.service.js');
    const storage = new StorageService();
    assert.ok(storage.privateCloud, 'Configure STORAGE_MODE=supabase para conferir arquivos privados');
    const keys = [...new Set((snapshots.get('core_resultadoaluno') || []).map(row => row.imagem_debug).filter(Boolean))];
    const mediaRoot = resolve(root, process.env.MIGRATION_MEDIA_ROOT || 'media');
    for (const key of keys) {
      assert.ok(!key.startsWith('/') && !key.split('/').includes('..'), 'Caminho de imagem legado inválido');
      const local = await readFile(resolve(mediaRoot, key));
      const remote = await storage.get(key);
      assert.equal(hash(remote.buffer), hash(local), 'Arquivo remoto diverge do original');
      summary.identicalFiles++;
    }
    summary.images = keys.length;
  }
  console.log(JSON.stringify(summary, null, 2));
} catch {
  if (client) await client.query('ROLLBACK').catch(() => {});
  console.error('Verificação falhou. Nenhum dado foi alterado; confira registros e arquivos da migração.');
  process.exitCode = 1;
} finally {
  client?.release(); await pool.end(); source.close();
}
