const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const config = require('../dist/config');
const {DatabaseService, postgresPlaceholders} = require('../dist/database.service');

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'enem-db-test-'));
  config.DATABASE_URL = '';
  config.DATABASE_PATH = path.join(dir, 'test.sqlite');
  const db = new DatabaseService();
  return {db, close: async () => { await db.onModuleDestroy(); await fs.rm(dir, {recursive: true, force: true}); }};
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; }

test('placeholders PostgreSQL preservam valores e literais com ponto de interrogação', () => {
  assert.equal(postgresPlaceholders("SELECT '?' literal, ? value, 'it''s ?' escaped, \"?\" column -- ?\n WHERE id=? /* ? */"), "SELECT '?' literal, $1 value, 'it''s ?' escaped, \"?\" column -- ?\n WHERE id=$2 /* ? */");
  assert.equal(postgresPlaceholders('SELECT $$?$$, $code$?$code$, ?'), 'SELECT $$?$$, $code$?$code$, $1');
});

test('Vercel sem DATABASE_URL falha antes de criar um banco SQLite local', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'enem-cloud-db-test-'));
  const previousVercel = process.env.VERCEL;
  const previousUrl = config.DATABASE_URL, previousPath = config.DATABASE_PATH;
  process.env.VERCEL = '1'; config.DATABASE_URL = ''; config.DATABASE_PATH = path.join(dir, 'never-created.sqlite');
  try {
    assert.throws(() => new DatabaseService(), /Configure DATABASE_URL/);
    await assert.rejects(fs.access(config.DATABASE_PATH), {code: 'ENOENT'});
  } finally {
    if (previousVercel === undefined) delete process.env.VERCEL; else process.env.VERCEL = previousVercel;
    config.DATABASE_URL = previousUrl; config.DATABASE_PATH = previousPath;
    await fs.rm(dir, {recursive: true, force: true});
  }
});

test('SQLite interface assíncrona guarda matrícula com zeros e resultados anteriores', async () => {
  const f = await fixture();
  try {
    await f.db.run('INSERT INTO student_contacts(matricula,email,nome,atualizado_em) VALUES(?,?,?,?)', '0000123', 'example@example.test', 'Aluno', new Date().toISOString());
    assert.equal((await f.db.get('SELECT * FROM student_contacts WHERE matricula=?', '0000123')).matricula, '0000123');
    await f.db.run('INSERT INTO student_contacts(matricula,email,nome,atualizado_em) VALUES(?,?,?,?)', '0000124', 'another@example.test', 'Aluno2', new Date().toISOString());
    assert.equal((await f.db.all('SELECT * FROM student_contacts')).length, 2);
  } finally { await f.close(); }
});

test('SQLite legado acrescenta curso sem alterar contato nem zeros da matrícula', async () => {
  const {DatabaseSync} = require('node:sqlite');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'enem-db-course-migration-'));
  const previousUrl = config.DATABASE_URL, previousPath = config.DATABASE_PATH;
  const file = path.join(dir, 'legacy.sqlite');
  const legacy = new DatabaseSync(file);
  legacy.exec("CREATE TABLE student_contacts(matricula TEXT PRIMARY KEY,email TEXT NOT NULL,nome TEXT NOT NULL DEFAULT '',atualizado_em TEXT NOT NULL)");
  legacy.prepare('INSERT INTO student_contacts(matricula,email,nome,atualizado_em) VALUES(?,?,?,?)').run('0000123', 'fixture@example.test', 'Aluno fictício', 'previous-date');
  legacy.close();
  config.DATABASE_URL = ''; config.DATABASE_PATH = file;
  const db = new DatabaseService();
  try {
    assert.deepEqual({...await db.get('SELECT * FROM student_contacts WHERE matricula=?', '0000123')}, {
      matricula: '0000123', email: 'fixture@example.test', nome: 'Aluno fictício', atualizado_em: 'previous-date', curso: '', owner_id:'', expira_em:null,
    });
    await db.run('UPDATE student_contacts SET curso=? WHERE matricula=?', 'Edificações', '0000123');
    assert.equal((await db.get('SELECT * FROM student_contacts WHERE matricula=?', '0000123')).curso, 'Edificações');
  } finally {
    await db.onModuleDestroy(); config.DATABASE_URL = previousUrl; config.DATABASE_PATH = previousPath;
    await fs.rm(dir, {recursive: true, force: true});
  }
});

test('PostgreSQL usa CA explícita e verifica TLS, com pool unitário na Vercel', async () => {
  const pg = require('pg');
  const original = pg.Pool, previousUrl = config.DATABASE_URL, previousSsl = config.DATABASE_SSL;
  const previousCa = config.DATABASE_SSL_CA, previousVercel = process.env.VERCEL;
  let options;
  class FakePool {
    constructor(value) { options = value; }
    async connect() { return {query: async () => ({rows: [], rowCount: 0}), release() {}}; }
    async end() {}
  }
  pg.Pool = FakePool; config.DATABASE_URL = 'postgres://fixture.invalid/tls'; config.DATABASE_SSL = true;
  config.DATABASE_SSL_CA = 'fixture trusted CA'; process.env.VERCEL = '1';
  const db = new DatabaseService();
  try {
    await db.onModuleInit();
    assert.deepEqual(options.ssl, {rejectUnauthorized: true, ca: 'fixture trusted CA'});
    assert.equal(options.max, 1);
  } finally {
    await db.onModuleDestroy(); pg.Pool = original; config.DATABASE_URL = previousUrl; config.DATABASE_SSL = previousSsl; config.DATABASE_SSL_CA = previousCa;
    if (previousVercel === undefined) delete process.env.VERCEL; else process.env.VERCEL = previousVercel;
  }
});

test('SQLite rollback reverte todas as escritas e não contamina leitura concorrente', async () => {
  const f = await fixture();
  const entered = deferred(), release = deferred();
  try {
    const mutation = f.db.transaction(async () => {
      await f.db.run('INSERT INTO student_contacts(matricula,email,nome,atualizado_em) VALUES(?,?,?,?)', 'tmp', 'tmp@example.test', '', 'today');
      entered.resolve(); await release.promise;
      throw new Error('rollback fixture');
    });
    const rejection = assert.rejects(mutation, /rollback fixture/);
    await entered.promise;
    let observed = false;
    const concurrent = f.db.all('SELECT * FROM student_contacts').then(rows => { observed = true; return rows; });
    await new Promise(done => setImmediate(done));
    assert.equal(observed, false);
    release.resolve(); await rejection;
    assert.deepEqual(await concurrent, []);
  } finally { release.resolve(); await f.close(); }
});

test('SQLite duas transações concorrentes mantêm ordem e commit completo', async () => {
  const f = await fixture();
  const entered = deferred(), release = deferred();
  try {
    const order = [];
    const first = f.db.transaction(async () => {
      order.push('first'); entered.resolve(); await release.promise;
      await f.db.run('INSERT INTO student_contacts(matricula,email,nome,atualizado_em) VALUES(?,?,?,?)', '1', 'a@example.test', '', 'today');
      order.push('first-end');
    });
    await entered.promise;
    const second = f.db.transaction(async () => {
      order.push('second');
      await f.db.run('INSERT INTO student_contacts(matricula,email,nome,atualizado_em) VALUES(?,?,?,?)', '2', 'b@example.test', '', 'today');
    });
    await new Promise(done => setImmediate(done));
    assert.deepEqual(order, ['first']);
    release.resolve(); await Promise.all([first, second]);
    assert.deepEqual(order, ['first', 'first-end', 'second']);
    assert.equal((await f.db.all('SELECT * FROM student_contacts')).length, 2);
  } finally { release.resolve(); await f.close(); }
});

test('novas tabelas têm idempotência de envio e cascade apenas nos resultados relacionados', async () => {
  const f = await fixture();
  try {
    const sim = await f.db.run('INSERT INTO core_simulado(titulo,data_criacao,gabarito_oficial) VALUES(?,?,?)', 'fixture', 'today', '{}');
    const batch = await f.db.run('INSERT INTO core_lotecorrecao(criado_em,simulado_id,gabarito_snapshot) VALUES(?,?,?)', 'today', sim.lastInsertRowid, '{}');
    const result = await f.db.run("INSERT INTO core_resultadoaluno(matricula,respostas_detectadas,total_acertos,total_erros,total_rasuras,total_brancos,nota_percentual,status,lote_id) VALUES(?,?,?,?,?,?,?,?,?)", '0001', '{}', 0, 0, 0, 50, 0, 'SUCESSO', batch.lastInsertRowid);
    await f.db.run('INSERT INTO report_feedback(resultado_id,nota_redacao,feedback_redacao,atualizado_em) VALUES(?,?,?,?)', result.lastInsertRowid, 800, 'Revisar conclusão.', 'today');
    const params = [result.lastInsertRowid, 'a@example.test', 'SENT', 'hash', 'today'];
    await f.db.run('INSERT INTO report_deliveries(resultado_id,destinatario,status,content_hash,criado_em) VALUES(?,?,?,?,?)', ...params);
    await assert.rejects(f.db.run('INSERT INTO report_deliveries(resultado_id,destinatario,status,content_hash,criado_em) VALUES(?,?,?,?,?)', ...params), /UNIQUE/);
    await f.db.run('DELETE FROM core_resultadoaluno WHERE id=?', result.lastInsertRowid);
    assert.equal((await f.db.all('SELECT * FROM report_feedback')).length, 0);
    assert.equal((await f.db.all('SELECT * FROM report_deliveries')).length, 0);
    assert.equal((await f.db.all('SELECT * FROM core_simulado')).length, 1);
  } finally { await f.close(); }
});

test('PostgreSQL transaction fixa o client e preserva queries externas no pool', async () => {
  const pg = require('pg');
  const original = pg.Pool;
  const calls = [];
  let clientIndex = 0;
  const clients = [];
  class FakePool {
    async connect() {
      const id = ++clientIndex;
      const client = {query: async (sql, params) => {
        calls.push({connection: id, sql, params});
        return {rows: /^INSERT/.test(sql) ? [{id: 701}] : [{ok: 1}], rowCount: 1};
      }, release() { calls.push({connection: id, sql: 'RELEASE'}); }};
      clients.push(client); return client;
    }
    async query(sql, params) { calls.push({connection: 'pool', sql, params}); return {rows: [{outside: 1}], rowCount: 1}; }
    async end() {}
  }
  pg.Pool = FakePool;
  config.DATABASE_URL = 'postgres://fixture.invalid/isolated';
  config.DATABASE_SSL = false;
  const db = new DatabaseService();
  try {
    await db.health();
    const entered = deferred(), release = deferred();
    const work = db.transaction(async () => {
      const inserted = await db.run('INSERT INTO core_simulado(titulo,data_criacao,gabarito_oficial) VALUES(?,?,?)', 'Fixture', 'today', '{}');
      assert.equal(inserted.lastInsertRowid, 701);
      entered.resolve(); await release.promise;
      await db.get('SELECT * FROM core_simulado WHERE id=?', 701);
    });
    await entered.promise;
    await db.get('SELECT 1 AS outside');
    release.resolve(); await work;
    const insert = calls.find(call => call.sql.startsWith('INSERT'));
    assert.ok(insert.sql.includes('VALUES($1,$2,$3) RETURNING id'));
    assert.deepEqual(insert.params, ['Fixture', 'today', '{}']);
    assert.equal(calls.find(call => call.sql.includes('SELECT * FROM core_simulado')).connection, insert.connection);
    assert.equal(calls.find(call => call.sql.includes('SELECT 1 AS outside')).connection, 'pool');
    assert.ok(calls.some(call => call.connection === insert.connection && call.sql === 'COMMIT'));
  } finally { await db.onModuleDestroy(); pg.Pool = original; config.DATABASE_URL = ''; }
});

test('PostgreSQL rollback usa o mesmo client e libera conexão após falha', async () => {
  const pg = require('pg');
  const original = pg.Pool;
  const calls = [];
  class FakePool {
    async connect() { return {query: async sql => { calls.push(sql); return {rows: [], rowCount: 0}; }, release: () => calls.push('RELEASE')}; }
    async query() { return {rows: [], rowCount: 0}; }
    async end() {}
  }
  pg.Pool = FakePool; config.DATABASE_URL = 'postgres://fixture.invalid/isolated';
  const db = new DatabaseService();
  try {
    await db.health(); calls.length = 0;
    await assert.rejects(db.transaction(async () => { await db.run('UPDATE core_simulado SET titulo=? WHERE id=?', 'test', 1); throw new Error('planned rollback'); }), /planned rollback/);
    assert.deepEqual(calls, ['BEGIN', 'UPDATE core_simulado SET titulo=$1 WHERE id=$2', 'ROLLBACK', 'RELEASE']);
  } finally { await db.onModuleDestroy(); pg.Pool = original; config.DATABASE_URL = ''; }
});

test('cold start aguarda PostgreSQL, fecha pool em falha e tenta uma nova instância na próxima requisição', async () => {
  require('reflect-metadata');
  const pg = require('pg');
  const {Module} = require('@nestjs/common');
  const {NestFactory} = require('@nestjs/core');
  const bootstrap = require('../dist/bootstrap');
  const originalPool = pg.Pool, originalCreateApplication = bootstrap.createApplication;
  const originalUrl = config.DATABASE_URL, originalSSL = config.DATABASE_SSL;
  const pools = [], contexts = [];
  const originalSignalListeners = process.listenerCount('SIGTERM');
  let attempts = 0, handled = 0, closed = 0;
  class FakePool {
    ended = 0;
    constructor() { pools.push(this); }
    async connect() {
      if (++attempts === 1) throw new Error('planned unavailable database');
      return {query: async () => ({rows: [{ok: 1}], rowCount: 1}), release() {}};
    }
    async query() { return {rows: [{ok: 1}], rowCount: 1}; }
    async end() { this.ended++; }
  }
  class TestModule {}
  Module({providers: [DatabaseService]})(TestModule);
  pg.Pool = FakePool;
  config.DATABASE_URL = 'postgres://fixture.invalid/cold-start';
  config.DATABASE_SSL = false;
  bootstrap.createApplication = async () => {
    const context = await NestFactory.create(TestModule, {logger: false, abortOnError: false});
    contexts.push(context);
    context.enableShutdownHooks(['SIGTERM']);
    return {init: () => context.init(), close: async () => { closed++; await context.close(); }, getHttpAdapter: () => ({getInstance: () => (_req, res) => {
      handled++; res.status(200).json({ok: true});
    }})};
  };
  const serverlessPath = require.resolve('../dist/serverless');
  delete require.cache[serverlessPath];
  const {serverlessHandler} = require(serverlessPath);
  const response = () => ({code: null, body: null, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; }});
  try {
    const first = response(), concurrent = response();
    await Promise.all([serverlessHandler({}, first), serverlessHandler({}, concurrent)]);
    assert.equal(first.code, 503);
    assert.equal(concurrent.code, 503);
    assert.deepEqual(first.body, {message: 'O serviço está temporariamente indisponível.'});
    assert.equal(handled, 0);
    assert.equal(pools.length, 1);
    assert.equal(pools[0].ended, 1);
    assert.equal(closed, 1);
    assert.equal(process.listenerCount('SIGTERM'), originalSignalListeners);
    const second = response();
    await serverlessHandler({}, second);
    assert.equal(second.code, 200);
    assert.equal(handled, 1);
    assert.equal(pools.length, 2);
    assert.equal((await contexts[1].get(DatabaseService).health()).ok, true);
    await contexts[1].close();
    assert.equal(pools[1].ended, 1);
    assert.equal(pools[0].ended, 1);
    assert.equal(process.listenerCount('SIGTERM'), originalSignalListeners);
  } finally {
    for (const context of contexts) await context.close().catch(() => {});
    bootstrap.createApplication = originalCreateApplication;
    pg.Pool = originalPool;
    config.DATABASE_URL = originalUrl; config.DATABASE_SSL = originalSSL;
    delete require.cache[serverlessPath];
  }
});
