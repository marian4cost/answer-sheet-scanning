const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const config = require('../dist/config');
const {DatabaseService} = require('../dist/database.service');
const {StorageService} = require('../dist/storage.service');
const {UploadsService} = require('../dist/uploads.service');
const {OmrService} = require('../dist/omr.service');

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'enem-upload-test-'));
  config.DATABASE_URL = ''; config.DATABASE_PATH = path.join(dir, 'test.sqlite'); config.MEDIA_ROOT = path.join(dir, 'media');
  const db = new DatabaseService();
  const objects = new Map();
  const storage = {privateCloud: true, signedUploadURL: async key => `https://storage.example.test/${key}?token=fixture`,
    get: async (key, max) => { const buffer = objects.get(key); if (!buffer) throw new Error('missing'); if (buffer.length > max) throw new Error('too large'); return {buffer, contentType: 'image/png'}; },
    remove: async key => objects.delete(key), put: async (key, value) => objects.set(key, value), signedDownloadURL: async key => `https://storage.example.test/storage/v1/object/sign/omr-private/${key}?token=fixture`};
  const omr = {validate: async () => ({ok: true}), process: async () => ({respostas_detectadas: {'1': 'RAS'}, status: 'ALERTA_RASURA', debug_image_path: null, erro_msg: ''})};
  const simulados = {get: async () => ({id: 1}), upload: async (_id, files, matriculas, loader) => { for (let index = 0; index < files.length; index++) { const file = await loader(index); await fs.rm(file.path, {force: true}); } return {total_provas: files.length, matriculas}; }};
  return {dir, db, objects, storage, omr, simulados, service: new UploadsService(db, storage, omr, simulados),
    close: async () => { await db.onModuleDestroy(); await fs.rm(dir, {recursive: true, force: true}); }};
}
async function serverFixture(handler) {
  const server = http.createServer(handler);
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  return {url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(done => server.close(done))};
}

test('recibos de upload só permitem nomes, tamanhos e finalidades aceitos', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.service.prepare([{name: 'bad.exe', size: 3, purpose: 'prova'}]), /PDF/);
    await assert.rejects(f.service.prepare([{name: 'good.png', size: 21 * 1024 * 1024, purpose: 'prova'}]), /20 MB/);
    await assert.rejects(f.service.prepare([{name: 'good.png', size: 3, purpose: 'arbitrary'}]), /Finalidade/);
    assert.equal((await f.db.all('SELECT * FROM uploaded_files')).length, 0);
  } finally { await f.close(); }
});

test('preview aceita rasura do professor e consome somente recibo próprio de gabarito', async () => {
  const f = await fixture();
  try {
    const prepared = await f.service.prepare([{name: 'sheet.png', size: 3, purpose: 'gabarito'}]);
    const id = prepared.uploads[0].id;
    const receipt = await f.db.get('SELECT * FROM uploaded_files WHERE id=?', id);
    f.objects.set(receipt.path, Buffer.from('png'));
    const result = await f.service.readOfficial(id, 60);
    assert.equal(result.respostas_detectadas['1'], 'RAS');
    assert.ok((await f.db.get('SELECT * FROM uploaded_files WHERE id=?', id)).consumed_at);
    await assert.rejects(f.service.readOfficial(id, 60), /já foi utilizado/);
    assert.equal(f.objects.size, 0);
  } finally { await f.close(); }
});

test('IDs arbitrários, finalidade trocada, uploads repetidos e recibos adulterados são bloqueados', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.service.readOfficial('uploads/path.png', 60), /identificadores/);
    const prepared = await f.service.prepare([{name: 'student.png', size: 3, purpose: 'prova'}]);
    const id = prepared.uploads[0].id;
    await assert.rejects(f.service.readOfficial(id, 60), /outra finalidade/);
    await assert.rejects(f.service.uploadStudents(1, [id, id], ['1', '2']), /repetições/);
    await f.db.run('UPDATE uploaded_files SET path=? WHERE id=?', 'uploads/secret.png', id);
    await assert.rejects(f.service.uploadStudents(1, [id], ['1']), /recibo/);
  } finally { await f.close(); }
});

test('dois usos simultâneos de um recibo geram um único processamento', async () => {
  const f = await fixture();
  try {
    const prepared = await f.service.prepare([{name: 'student.png', size: 3, purpose: 'prova'}]);
    const id = prepared.uploads[0].id;
    const receipt = await f.db.get('SELECT * FROM uploaded_files WHERE id=?', id);
    f.objects.set(receipt.path, Buffer.from('png'));
    let processed = 0;
    f.simulados.upload = async (_id, files, _matriculas, loader) => { processed++; const file = await loader(0); await fs.rm(file.path, {force: true}); return {ok: true}; };
    const results = await Promise.allSettled([f.service.uploadStudents(1, [id], ['0001']), f.service.uploadStudents(1, [id], ['0001'])]);
    assert.equal(processed, 1);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  } finally { await f.close(); }
});

test('recibo expirado e tamanho adulterado não geram provas nem deixam arquivos temporários', async () => {
  const f = await fixture();
  try {
    const first = (await f.service.prepare([{name: 'expired.png', size: 3, purpose: 'prova'}])).uploads[0].id;
    await f.db.run('UPDATE uploaded_files SET created_at=? WHERE id=?', '2020-01-01T00:00:00.000Z', first);
    await assert.rejects(f.service.uploadStudents(1, [first], ['0001']), /expirou/);
    const second = (await f.service.prepare([{name: 'bad-size.png', size: 3, purpose: 'prova'}])).uploads[0].id;
    const receipt = await f.db.get('SELECT * FROM uploaded_files WHERE id=?', second);
    f.objects.set(receipt.path, Buffer.from('pn'));
    await assert.rejects(f.service.uploadStudents(1, [second], ['0001']), /tamanho diferente/);
    assert.equal(f.objects.has(receipt.path), false);
  } finally { await f.close(); }
});

test('Storage privado emite signed PUT/GET e limita download antes de acumular bytes', async () => {
  const requests = [];
  const srv = await serverFixture(async (req, res) => {
    requests.push({path: req.url, method: req.method, auth: req.headers.authorization});
    res.setHeader('Content-Type', 'application/json');
    if (req.url.startsWith('/storage/v1/bucket/')) res.end(JSON.stringify({public: false}));
    else if (req.url.includes('/object/upload/sign/')) res.end(JSON.stringify({url: '/object/upload/sign/omr-private/incoming/test.png?token=fixture'}));
    else if (req.url.includes('/object/sign/')) res.end(JSON.stringify({signedURL: '/object/sign/omr-private/processing/test.png?token=fixture'}));
    else { res.setHeader('Content-Length', 20); res.end(Buffer.alloc(20)); }
  });
  const original = {url: config.SUPABASE_URL, secret: config.SUPABASE_SERVICE_ROLE_KEY, mode: config.STORAGE_MODE};
  try {
    config.SUPABASE_URL = srv.url; config.SUPABASE_SERVICE_ROLE_KEY = 'fixture-secret'; config.STORAGE_MODE = 'supabase';
    const storage = new StorageService();
    assert.ok((await storage.signedUploadURL('incoming/test.png')).includes('/object/upload/sign/omr-private/'));
    assert.ok((await storage.signedDownloadURL('processing/test.png', 120)).includes('/object/sign/omr-private/'));
    await assert.rejects(storage.get('incoming/test.png', 10), /tamanho permitido/);
    await assert.rejects(storage.get('../secret'), /Identificador/);
    assert.ok(requests.every(req => req.auth === 'Bearer fixture-secret'));
  } finally { config.SUPABASE_URL = original.url; config.SUPABASE_SERVICE_ROLE_KEY = original.secret; config.STORAGE_MODE = original.mode; await srv.close(); }
});

test('Storage se recusa a guardar gabaritos em bucket público', async () => {
  const srv = await serverFixture((_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end('{"public":true}'); });
  const original = {url: config.SUPABASE_URL, secret: config.SUPABASE_SERVICE_ROLE_KEY, mode: config.STORAGE_MODE};
  try {
    config.SUPABASE_URL = srv.url; config.SUPABASE_SERVICE_ROLE_KEY = 'fixture-secret'; config.STORAGE_MODE = 'supabase';
    await assert.rejects(new StorageService().put('uploads/test.png', Buffer.from('png')), /precisa ser privado/);
  } finally { config.SUPABASE_URL = original.url; config.SUPABASE_SERVICE_ROLE_KEY = original.secret; config.STORAGE_MODE = original.mode; await srv.close(); }
});

test('Storage distingue objeto ausente HTTP400/statusCode404 de erro genérico', async () => {
  const srv = await serverFixture((req, res) => {
    res.statusCode = 400; res.setHeader('Content-Type', 'application/json');
    res.end(req.url.includes('missing.png') ? '{"statusCode":"404","error":"not_found","message":"Object not found"}' : '{"statusCode":"400","error":"invalid_request"}');
  });
  const original = {url: config.SUPABASE_URL, secret: config.SUPABASE_SERVICE_ROLE_KEY, mode: config.STORAGE_MODE};
  try {
    config.SUPABASE_URL = srv.url; config.SUPABASE_SERVICE_ROLE_KEY = 'fixture-secret'; config.STORAGE_MODE = 'supabase';
    const storage = new StorageService();
    await assert.rejects(storage.get('missing.png'), error => error.getStatus() === 404);
    await assert.rejects(storage.get('invalid.png'), error => error.getStatus() === 500);
  } finally { config.SUPABASE_URL = original.url; config.SUPABASE_SERVICE_ROLE_KEY = original.secret; config.STORAGE_MODE = original.mode; await srv.close(); }
});

test('transporte OMR envia URL temporária e salva debug sem passar base64 do arquivo pelo servidor remoto', async () => {
  const f = await fixture();
  let payload;
  const srv = await serverFixture(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    payload = JSON.parse(body);
    assert.equal(req.headers['x-omr-secret'], 'fixture-omr-secret');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({respostas_detectadas: {'1': 'C'}, status: 'SUCESSO', erro_msg: '', debug_image_path: 'remote', debug_image_base64: Buffer.from('preview').toString('base64')}));
  });
  const original = {url: config.OMR_REMOTE_URL, secret: config.OMR_REMOTE_SECRET};
  try {
    config.OMR_REMOTE_URL = srv.url; config.OMR_REMOTE_SECRET = 'fixture-omr-secret';
    const file = path.join(f.dir, 'input.png'), debug = path.join(f.dir, 'debug.png');
    await fs.writeFile(file, Buffer.alloc(200_000));
    const reading = await new OmrService(f.storage).process(file, {'1': 'D'}, debug, 60);
    assert.equal(reading.respostas_detectadas['1'], 'C');
    assert.equal(payload.answer_key['1'], 'D');
    assert.equal(payload.question_count, 60);
    assert.ok(payload.file_url.includes('/processing/'));
    assert.equal(payload.file_base64, undefined);
    assert.ok(JSON.stringify(payload).length < 1000);
    assert.equal((await fs.readFile(debug)).toString(), 'preview');
    assert.equal(f.objects.size, 0);
  } finally { config.OMR_REMOTE_URL = original.url; config.OMR_REMOTE_SECRET = original.secret; await srv.close(); await f.close(); }
});

test('OMR remoto mantém no máximo dois trabalhos ativos em uma fila de oito requisições', async () => {
  let active = 0, maximum = 0;
  const srv = await serverFixture((_req, res) => {
    active++; maximum = Math.max(maximum, active);
    setTimeout(() => { active--; res.setHeader('Content-Type', 'application/json'); res.end('{"ok":true,"opencv":"fixture","poppler":true}'); }, 15);
  });
  const original = {url: config.OMR_REMOTE_URL, secret: config.OMR_REMOTE_SECRET};
  try {
    config.OMR_REMOTE_URL = srv.url; config.OMR_REMOTE_SECRET = 'fixture-omr-secret';
    const omr = new OmrService({});
    const results = await Promise.all(Array.from({length: 8}, () => omr.health()));
    assert.equal(maximum, 2); assert.ok(results.every(result => result.ok));
  } finally { config.OMR_REMOTE_URL = original.url; config.OMR_REMOTE_SECRET = original.secret; await srv.close(); }
});

test('lote vindo do Storage libera o cartão anterior antes de baixar o próximo e mantém um único envio', async () => {
  const f = await fixture();
  const {SimuladosService} = require('../dist/simulados.service');
  const originalMode = config.STORAGE_MODE;
  try {
    config.STORAGE_MODE = 'supabase';
    for (const directory of ['uploads', 'debug_images', '.staging']) await fs.mkdir(path.join(config.MEDIA_ROOT, directory), {recursive: true});
    const key = Object.fromEntries(Array.from({length: 50}, (_, index) => [String(index + 1), 'ABCDE'[index % 5]]));
    const omr = {validate: async () => ({ok: true}), process: async (_input, _key, debug) => {
      await fs.writeFile(debug, Buffer.from('preview'));
      return {respostas_detectadas: key, status: 'SUCESSO', debug_image_path: debug, erro_msg: ''};
    }};
    const service = new SimuladosService(f.db, omr, f.storage);
    const simulado = await service.create('Streaming fixture', undefined, 50, [], key);
    const metadata = Array.from({length: 3}, (_, index) => ({originalname: index + '.png', path: path.join(config.MEDIA_ROOT, '.staging', 'placeholder' + index)}));
    let downloaded = 0;
    const result = await service.upload(simulado.id, metadata, ['0001', '0002', '0003'], async index => {
      assert.equal((await fs.readdir(path.join(config.MEDIA_ROOT, 'uploads'))).length, 0);
      assert.equal((await fs.readdir(path.join(config.MEDIA_ROOT, 'debug_images'))).length, 0);
      const filepath = path.join(config.MEDIA_ROOT, '.staging', 'file' + index + '.png');
      await fs.writeFile(filepath, Buffer.from('input'));
      downloaded++;
      return {originalname: index + '.png', path: filepath, mimetype: 'image/png'};
    });
    assert.equal(downloaded, 3);
    assert.equal(result.total_provas, 3);
    assert.equal((await service.get(simulado.id)).total_envios, 1);
    assert.equal((await service.batch(result.envio_id)).resultados.length, 3);
    assert.equal(f.objects.size, 6);
    assert.equal((await fs.readdir(path.join(config.MEDIA_ROOT, '.staging'))).length, 0);
  } finally { config.STORAGE_MODE = originalMode; await f.close(); }
});
