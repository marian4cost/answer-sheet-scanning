const {test}=require('node:test');
const assert=require('node:assert/strict');
const {resolve}=require('node:path');
// This suite does not load .env or contact real services; all configuration is in-memory.
const configPath=require.resolve('../dist/config');
require.cache[configPath]={id:configPath,filename:configPath,loaded:true,exports:{PROJECT_ROOT:resolve(__dirname,'../../..'),DATABASE_URL:'',DATABASE_PATH:':memory:',DATABASE_SSL:false,DATABASE_SSL_CA:'',MEDIA_ROOT:'/tmp/sirenia-retention-fixture',STORAGE_MODE:'local',OMR_REMOTE_URL:'',MAX_FILE_SIZE:20*1024*1024}};
Object.assign(process.env,{VERCEL:'',DATA_RETENTION_DAYS:'30',WEB_URL:'https://retention.example.test',CRON_SECRET:'fixture-cron-secret-'.repeat(3)});
const {DatabaseService,postgresPlaceholders}=require('../dist/database.service');
const {SimuladosService}=require('../dist/simulados.service');
const {ReportsService}=require('../dist/reports.service');
const {ContactsService}=require('../dist/contacts.service');
const {withAccount,retentionDays}=require('../dist/account-context');
const ownerA={id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',email:'a@example.test'},ownerB={id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',email:'b@example.test'};
const key=JSON.stringify(Object.fromEntries(Array.from({length:50},(_,i)=>[String(i+1),'A'])));
async function expired(db,count=45) {
  const ids=[];
  await db.transaction(async()=>{for(let i=0;i<count;i++) ids.push(Number((await db.run('INSERT INTO core_simulado(titulo,data_criacao,gabarito_oficial,owner_id,expira_em) VALUES(?,?,?,?,?)','Simulado fictício '+i,'2026-01-01T00:00:00.000Z',key,i%2?ownerA.id:ownerB.id,'2026-01-31T00:00:00.000Z')).lastInsertRowid));});
  return ids;
}
test('uma invocação drena 45 registros vencidos em batches e preserva ativos e legados sem proprietário',async()=>{
  const db=new DatabaseService(),service=new SimuladosService(db,{}, {remove:async()=>{}});
  try {
    assert.equal(retentionDays(),30);await expired(db);
    const active=await withAccount(ownerA,()=>service.create('Ativo fictício',undefined,50,[],JSON.parse(key)));
    await db.run('INSERT INTO core_simulado(titulo,data_criacao,gabarito_oficial,expira_em) VALUES(?,?,?,?)','Legado fictício','2026-01-01T00:00:00.000Z',key,'2026-01-31T00:00:00.000Z');
    assert.equal(await service.cleanupExpired(),45);
    assert.equal((await db.get("SELECT COUNT(*) total FROM core_simulado WHERE owner_id<>'' AND expira_em<=?",new Date().toISOString())).total,0);
    assert.equal((await db.all('SELECT * FROM core_simulado')).length,2);
    assert.equal((await withAccount(ownerA,()=>service.dashboard())).simulados[0].id,active.id);
    assert.equal((await withAccount(ownerB,()=>service.dashboard())).simulados.length,0);
    assert.ok(Date.parse(active.expira_em)>=Date.now()+29*86400_000);
  } finally {await db.onModuleDestroy();}
});
test('primeiro simulado com lease ativo não impede limpar batches posteriores; a próxima chamada remove o restante',async()=>{
  const db=new DatabaseService(),service=new SimuladosService(db,{}, {remove:async()=>{}});
  try {
    const ids=await expired(db),plan='aaaaaaaa-aaaa-4aaa-8aaa-000000000001',page='aaaaaaaa-aaaa-4aaa-8aaa-000000000002',now=new Date().toISOString();
    await db.run('INSERT INTO proof_import_plans(id,simulado_id,payload,estado,criado_em,expira_em) VALUES(?,?,?,?,?,?)',plan,ids[0],JSON.stringify({files:[]}),'CONFIRMADA',now,new Date(Date.now()+86400_000).toISOString());
    await db.run('INSERT INTO proof_import_pages(id,plan_id,file_index,page_number,estado,claim_at) VALUES(?,?,0,1,?,?)',page,plan,'PROCESSANDO',now);
    assert.equal(await service.cleanupExpired(),44);assert.equal((await db.all('SELECT * FROM core_simulado')).length,1);
    await db.run('UPDATE proof_import_pages SET claim_at=? WHERE id=?',new Date(Date.now()-180_000).toISOString(),page);
    assert.equal(await service.cleanupExpired(),1);assert.equal((await db.all('SELECT * FROM core_simulado')).length,0);
  } finally {await db.onModuleDestroy();}
});
test('duas limpezas concorrentes não contam registros duas vezes e esgotam todos os vencidos',async()=>{
  const db=new DatabaseService(),service=new SimuladosService(db,{}, {remove:async()=>{}});
  try {
    await expired(db,43);const outcomes=await Promise.all([service.cleanupExpired(),service.cleanupExpired()]);
    assert.equal(outcomes.reduce((sum,value)=>sum+value,0),43);assert.equal((await db.all('SELECT * FROM core_simulado')).length,0);
  } finally {await db.onModuleDestroy();}
});
test('storage drena mais de 100 objetos, mantém falhas e respeita orçamento de execução sem perder fila',async()=>{
  const db=new DatabaseService();let fail=true,active=0,max=0;
  const service=new SimuladosService(db,{}, {remove:async key=>{active++;max=Math.max(max,active);try{await new Promise(resolve=>setTimeout(resolve,1));if(fail&&key==='fixture/000')throw Error('Falha fictícia');}finally{active--;}}});
  try {
    const now=new Date().toISOString();for(let i=0;i<205;i++)await db.run('INSERT INTO storage_deletions(path,criado_em) VALUES(?,?)','fixture/'+String(i).padStart(3,'0'),now);
    assert.equal(await service.cleanStorage(Date.now()-1),0);assert.equal((await db.all('SELECT * FROM storage_deletions')).length,205);
    assert.equal(await service.cleanStorage(),204);assert.equal((await db.all('SELECT * FROM storage_deletions')).length,1);assert.ok(max<=5);
    fail=false;assert.equal(await service.cleanStorage(),1);assert.equal((await db.all('SELECT * FROM storage_deletions')).length,0);
  } finally {await db.onModuleDestroy();}
});
test('cron retorna total completo da retenção e número real de objetos removidos após limpar banco',async()=>{
  const db=new DatabaseService(),removed=[],service=new SimuladosService(db,{}, {remove:async path=>removed.push(path)});
  try {
    await expired(db,24);const now=new Date().toISOString();for(let i=0;i<120;i++)await db.run('INSERT INTO storage_deletions(path,criado_em) VALUES(?,?)','fixture/'+i,now);
    const reports=new ReportsService(db,service,new ContactsService(db),{}),outcome=await reports.cleanupAccess('Bearer '+process.env.CRON_SECRET);
    assert.equal(outcome.simulados_removidos,24);assert.equal(outcome.arquivos_removidos,120);assert.equal(removed.length,120);
    assert.equal((await db.all('SELECT * FROM core_simulado')).length,0);assert.equal((await db.all('SELECT * FROM storage_deletions')).length,0);
  } finally {await db.onModuleDestroy();}
});
test('PostgreSQL/PGlite drena batches completos e obtém lock em cada simulado antes da exclusão',async()=>{
  const {PGlite}=require('@electric-sql/pglite'),{readFile}=require('node:fs/promises'),{AsyncLocalStorage}=require('node:async_hooks');
  const pg=new PGlite(),context=new AsyncLocalStorage();let locks=0;
  const db={dialect:'postgres',all:async(sql,...parameters)=>{const result=await pg.query(postgresPlaceholders(sql),parameters);if(sql.startsWith('SELECT id FROM core_simulado')&&sql.includes('FOR UPDATE')){assert.ok(context.getStore());locks++;}return result.rows;},
    get:async(sql,...parameters)=>(await db.all(sql,...parameters))[0],run:async(sql,...parameters)=>{let query=postgresPlaceholders(sql);if(/^\s*INSERT INTO (core_simulado|core_lotecorrecao|core_resultadoaluno|report_deliveries)\b/.test(sql)&&!query.includes('RETURNING'))query+=' RETURNING id';const result=await pg.query(query,parameters);return {changes:result.affectedRows,lastInsertRowid:result.rows[0]?.id};},
    transaction:async work=>{if(context.getStore())return work();await pg.exec('BEGIN');try{const value=await context.run(true,work);await pg.exec('COMMIT');return value;}catch(error){await pg.exec('ROLLBACK');throw error;}}};
  try {
    await pg.exec(await readFile(resolve(__dirname,'../../../infra/sql/001-schema.sql'),'utf8'));await expired(db);
    const service=new SimuladosService(db,{}, {remove:async()=>{}});
    assert.equal(await service.cleanupExpired(),45);assert.equal(locks,45);assert.equal((await db.all('SELECT * FROM core_simulado')).length,0);
  } finally {await pg.close();}
});
