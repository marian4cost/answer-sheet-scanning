#!/usr/bin/env node
// Testa PostgreSQL real (WASM), sem tocar SQLite de produção nem serviços externos.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packagePath = process.env.PGLITE_MODULE_PATH;
const {PGlite} = packagePath ? await import(pathToFileURL(resolve(packagePath)).href) : await import('@electric-sql/pglite');
const db = new PGlite();
try {
  await db.exec('CREATE ROLE anon; CREATE ROLE authenticated;');
  await db.exec("CREATE TABLE student_contacts(matricula TEXT PRIMARY KEY,email TEXT NOT NULL,nome TEXT NOT NULL DEFAULT '',atualizado_em TEXT NOT NULL)");
  await db.query('INSERT INTO student_contacts(matricula,email,nome,atualizado_em) VALUES($1,$2,$3,$4)', ['0000001', 'legacy@example.test', 'Aluno fictício', 'previous-date']);
  await db.exec(await readFile(resolve(root, 'infra/sql/001-schema.sql'), 'utf8'));
  assert.deepEqual((await db.query('SELECT * FROM student_contacts WHERE matricula=$1', ['0000001'])).rows[0], {
    matricula: '0000001', email: 'legacy@example.test', nome: 'Aluno fictício', atualizado_em: 'previous-date', curso: '', owner_id:'', expira_em:null,
  });
  await db.query('UPDATE student_contacts SET curso=$1 WHERE matricula=$2', ['Edificações', '0000001']);
  await db.exec(await readFile(resolve(root, 'infra/sql/001-schema.sql'), 'utf8'));
  assert.equal((await db.query('SELECT curso FROM student_contacts WHERE matricula=$1', ['0000001'])).rows[0].curso, 'Edificações');
  await db.query('DELETE FROM student_contacts WHERE matricula=$1', ['0000001']);
  console.log('PASS: migração legada de curso preserva contato e é idempotente.');
  const tables = await db.query("SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname='public' AND tablename IN ('core_simulado','core_lotecorrecao','core_resultadoaluno','student_contacts','report_feedback','report_deliveries','report_delivery_plans','contacts_import_plans','uploaded_files','email_provider_slots','auth_attempt_limits','essay_import_plans','report_access_links','proof_import_plans','proof_import_pages','storage_deletions','account_admin_locks','answer_review_events')");
  assert.equal(tables.rows.length, 18);
  assert.ok(tables.rows.every(row => row.rowsecurity));
  console.log('PASS: schema PostgreSQL e RLS em todas as tabelas.');
  const now=Date.now();
  const reserve=`INSERT INTO email_provider_slots(provider,next_at) VALUES($1,$2) ON CONFLICT(provider) DO UPDATE SET next_at=CASE WHEN email_provider_slots.next_at<$3 THEN $4 ELSE email_provider_slots.next_at+1100 END RETURNING next_at`;
  const first=(await db.query(reserve,['emailjs',now,now,now])).rows[0];
  const second=(await db.query(reserve,['emailjs',now,now,now])).rows[0];
  assert.equal(Number(first.next_at),now);assert.equal(Number(second.next_at),now+1100);
  const limit=`INSERT INTO auth_attempt_limits(scope_hash,window_at,total) VALUES($1,$2,1) ON CONFLICT(scope_hash) DO UPDATE SET total=CASE WHEN auth_attempt_limits.window_at<=$3 THEN 1 ELSE auth_attempt_limits.total+1 END, window_at=CASE WHEN auth_attempt_limits.window_at<=$4 THEN $5 ELSE auth_attempt_limits.window_at END WHERE auth_attempt_limits.window_at<=$6 OR auth_attempt_limits.total<$7 RETURNING total`;
  const params=['fake-hash',now,now-60000,now-60000,now,now-60000,1];
  assert.equal((await db.query(limit,params)).rows[0].total,1);assert.equal((await db.query(limit,params)).rows.length,0);
  console.log('PASS: limites de OTP e espaçamento EmailJS persistem em PostgreSQL.');

  const key = JSON.stringify(Object.fromEntries(Array.from({length: 60}, (_, i) => [String(i + 1), 'ABCDE'[i % 5]])));
  await db.query('INSERT INTO core_simulado(id,titulo,data_criacao,gabarito_oficial,total_questoes,temas) VALUES($1,$2,$3,$4,$5,$6)', [91, 'Fixture PostgreSQL', '2026-10-10T12:00:00.000Z', key, 60, '[{"inicio":1,"fim":30,"tema":"Linguagens"}]']);
  await db.query('INSERT INTO core_lotecorrecao(id,criado_em,simulado_id,gabarito_snapshot) VALUES($1,$2,$3,$4)', [97, '2026-10-10T12:00:00.000Z', 91, key]);
  await db.query('INSERT INTO core_resultadoaluno(id,matricula,respostas_detectadas,total_acertos,total_erros,total_rasuras,total_brancos,nota_percentual,status,lote_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [103, '0000042', key, 60, 0, 0, 0, 100, 'SUCESSO', 97]);
  const result = (await db.query('SELECT * FROM core_resultadoaluno WHERE id=$1', [103])).rows[0];
  assert.equal(result.matricula, '0000042'); assert.equal(result.nota_percentual, 100); assert.equal(result.respostas_detectadas, key);
  const envios = await db.query('SELECT l.id,l.simulado_id,l.criado_em,s.titulo,CAST(COUNT(r.id) AS INTEGER) total_provas FROM core_lotecorrecao l JOIN core_simulado s ON s.id=l.simulado_id LEFT JOIN core_resultadoaluno r ON r.lote_id=l.id GROUP BY l.id,l.simulado_id,l.criado_em,s.titulo');
  assert.equal(envios.rows[0].total_provas, 1);
  assert.equal(typeof envios.rows[0].total_provas, 'number');
  console.log('PASS: IDs, zeros da matrícula, chave, nota e queries de agregação preservados.');

  await db.query("SELECT setval(pg_get_serial_sequence('core_simulado','id'),COALESCE((SELECT MAX(id) FROM core_simulado),1),EXISTS(SELECT 1 FROM core_simulado))");
  const next = await db.query('INSERT INTO core_simulado(titulo,data_criacao,gabarito_oficial) VALUES($1,$2,$3) RETURNING id', ['next', 'today', key]);
  assert.equal(next.rows[0].id, 92);
  console.log('PASS: sequência após migração não colide com IDs preservados.');

  await db.query('INSERT INTO report_feedback(resultado_id,nota_redacao,feedback_redacao,atualizado_em) VALUES($1,$2,$3,$4)', [103, 880, 'Fixture.', 'today']);
  const review=['review-test',103,1,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','today','Conferência fictícia',key,key,'[1]','{"1":"A"}','ALERTA_REVISAO','SUCESSO'];
  await db.query('INSERT INTO answer_review_events(id,resultado_id,versao,revisor_id,criado_em,motivo,respostas_antes,respostas_depois,questoes_revisadas,alteracoes,status_antes,status_depois) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',review);
  await assert.rejects(db.query('INSERT INTO answer_review_events(id,resultado_id,versao,revisor_id,criado_em,motivo,respostas_antes,respostas_depois,questoes_revisadas,alteracoes,status_antes,status_depois) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',['duplicate-review',...review.slice(1)]),/unique|duplicate/i);
  assert.equal((await db.query('SELECT revision FROM account_admin_locks WHERE scope=$1',['roles'])).rows[0].revision,0);
  console.log('PASS: versões de revisão são únicas e o lock de administração é preservado na migração idempotente.');
  await db.query('INSERT INTO report_deliveries(resultado_id,destinatario,status,content_hash,criado_em) VALUES($1,$2,$3,$4,$5)', [103, 'fixture@example.test', 'SENT', 'unique-hash', 'today']);
  await assert.rejects(db.query('INSERT INTO report_deliveries(resultado_id,destinatario,status,content_hash,criado_em) VALUES($1,$2,$3,$4,$5)', [103, 'fixture@example.test', 'SENT', 'unique-hash', 'today']), /unique|duplicate/i);
  await db.query('DELETE FROM core_resultadoaluno WHERE id=$1', [103]);
  assert.equal((await db.query('SELECT * FROM report_feedback')).rows.length, 0);
  assert.equal((await db.query('SELECT * FROM report_deliveries')).rows.length, 0);
  assert.equal((await db.query('SELECT * FROM answer_review_events')).rows.length,0);
  assert.equal((await db.query('SELECT * FROM core_simulado')).rows.length, 2);
  console.log('PASS: idempotência e cascade restrito ao resultado excluído.');

  await db.exec('SET ROLE anon;');
  await assert.rejects(db.query('SELECT * FROM core_simulado'), /permission denied/i);
  await db.exec('RESET ROLE; SET ROLE authenticated;');
  await assert.rejects(db.query('SELECT * FROM student_contacts'), /permission denied/i);
  await assert.rejects(db.query('SELECT * FROM auth_attempt_limits'), /permission denied/i);
  await assert.rejects(db.query('SELECT * FROM email_provider_slots'), /permission denied/i);
  for (const table of ['essay_import_plans','report_access_links','proof_import_plans','proof_import_pages','storage_deletions','account_admin_locks','answer_review_events']) {
    await assert.rejects(db.query('SELECT * FROM '+table), /permission denied/i);
  }
  await db.exec('RESET ROLE;');
  console.log('PASS: anon/authenticated não leem gabaritos, contatos ou boletins diretamente.');

  await db.exec('BEGIN;');
  await db.query('INSERT INTO student_contacts(matricula,email,atualizado_em) VALUES($1,$2,$3)', ['rollback', 'fixture@example.test', 'today']);
  await db.exec('ROLLBACK;');
  assert.equal((await db.query('SELECT * FROM student_contacts')).rows.length, 0);
  console.log('PASS: rollback PostgreSQL preserva consistência.');
} finally { await db.close(); }
