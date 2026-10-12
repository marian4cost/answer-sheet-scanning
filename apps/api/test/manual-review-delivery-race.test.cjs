const {test,after} = require('node:test');
const assert = require('node:assert/strict');
const {mkdtempSync,rmSync} = require('node:fs');
const {tmpdir} = require('node:os');
const {join} = require('node:path');
const dir=mkdtempSync(join(tmpdir(),'sirenia-review-delivery-'));
Object.assign(process.env,{DATABASE_URL:'',DATABASE_PATH:join(dir,'race.sqlite'),MEDIA_ROOT:join(dir,'media'),STORAGE_MODE:'local',VERCEL:'',WEB_URL:'https://race.example.test',REPORT_LINK_TTL_DAYS:'7',DATA_RETENTION_DAYS:'30'});
const {DatabaseService,postgresPlaceholders}=require('../dist/database.service');
const {SimuladosService}=require('../dist/simulados.service');
const {ReportsService}=require('../dist/reports.service');
const {ContactsService,sha256}=require('../dist/contacts.service');
const {withAccount}=require('../dist/account-context');
const account={id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',email:'teacher@example.test',nome:'Professor Fictício'};
const scope=work=>withAccount(account,work);
const key=Object.fromEntries(Array.from({length:50},(_,i)=>[String(i+1),'A']));
const sqlite=new DatabaseService();let sequence=0;
after(async()=>{await sqlite.onModuleDestroy();rmSync(dir,{recursive:true,force:true});});
function latch(){let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};}
const statusError=status=>error=>error.getStatus?.()===status;
async function fixture(db=sqlite,deliver) {
  const simulados=new SimuladosService(db,{},{}),now=new Date().toISOString(),matricula='FICTICIO-'+(++sequence);
  const sim=await scope(()=>simulados.create(matricula,undefined,50,[{inicio:1,fim:50,tema:'Linguagens'}],key));
  const lote=(await db.run('INSERT INTO core_lotecorrecao(criado_em,simulado_id,gabarito_snapshot) VALUES(?,?,?)',now,sim.id,JSON.stringify(key))).lastInsertRowid;
  const id=Number((await db.run(`INSERT INTO core_resultadoaluno(matricula,respostas_detectadas,total_acertos,total_erros,total_rasuras,total_brancos,total_incertas,nota_percentual,status,lote_id)
    VALUES(?,?,50,0,0,0,0,100,'SUCESSO',?)`,matricula,JSON.stringify(key),lote)).lastInsertRowid);
  await db.run('INSERT INTO student_contacts(matricula,email,nome,curso,atualizado_em,owner_id,expira_em) VALUES(?,?,?,?,?,?,?)',matricula,'student@example.test','Aluno fictício','Curso fictício',now,account.id,new Date(Date.now()+30*86400_000).toISOString());
  const messages=[],gateway={availability:()=>({envio_disponivel:true,envio_motivo:'Provedor fictício'}),deliver:async(report,url)=>{messages.push({report,url});if(deliver)await deliver();return 'fake-'+messages.length;}};
  return {db,sim,id,lote,matricula,simulados,reports:new ReportsService(db,simulados,new ContactsService(db),gateway),messages};
}
const revise=f=>scope(()=>f.simulados.reviewAnswers(f.id,{versao_esperada:0,respostas:{'1':'B'},motivo:'Conferência visual.'}));

test('SQLite: envio vence transação, reserva ENVIANDO e bloqueia revisão durante gateway pendente',async()=>{
  const entered=latch(),release=latch(),f=await fixture(sqlite,async()=>{entered.resolve();await release.promise;});
  const plan=await scope(()=>f.reports.plan(f.sim.id,[f.id]));
  const sending=scope(()=>f.reports.send(f.sim.id,plan.token,'sim'));
  try {
    await entered.promise;
    await assert.rejects(revise(f),statusError(409));
    assert.equal((await sqlite.all('SELECT * FROM answer_review_events WHERE resultado_id=?',f.id)).length,0);
    assert.equal(f.messages[0].report.geral.total_acertos,50);
  } finally {release.resolve();await sending;}
  assert.equal(f.messages.length,1);assert.equal((await revise(f)).resultado.total_acertos,49);
});

test('SQLite: revisão vence transação, envio aguarda commit e rejeita prévia antiga sem mensagem',async()=>{
  const f=await fixture(),plan=await scope(()=>f.reports.plan(f.sim.id,[f.id])),entered=latch(),release=latch(),originalRun=sqlite.run.bind(sqlite);
  sqlite.run=async(sql,...parameters)=>{if(sql.includes('INSERT INTO answer_review_events')){entered.resolve();await release.promise;}return originalRun(sql,...parameters);};
  const revising=revise(f);let sending;
  try {
    await entered.promise;
    // Starts while the review holds BEGIN IMMEDIATE, before it writes/commits.
    sending=scope(()=>f.reports.send(f.sim.id,plan.token,'sim'));
    const sendChecked=assert.rejects(sending,statusError(400));
    release.resolve();await revising;await sendChecked;
    assert.equal(f.messages.length,0);assert.equal((await sqlite.all('SELECT * FROM report_deliveries WHERE resultado_id=?',f.id)).length,0);
    assert.equal((await scope(()=>f.simulados.result(f.id))).resultado.total_acertos,49);
  } finally {release.resolve();sqlite.run=originalRun;await revising;}
});

test('fila longa: revisão após lease vencer bloqueia a próxima mensagem antes do gateway e revoga acesso inativo',async()=>{
  const entered=latch(),release=latch(),f=await fixture(sqlite,async()=>{entered.resolve();await release.promise;});
  const second=Number((await sqlite.run(`INSERT INTO core_resultadoaluno(matricula,respostas_detectadas,total_acertos,total_erros,total_rasuras,total_brancos,total_incertas,nota_percentual,status,lote_id)
    VALUES(?,?,50,0,0,0,0,100,'SUCESSO',?)`,f.matricula,JSON.stringify(key),f.lote)).lastInsertRowid);
  const plan=await scope(()=>f.reports.plan(f.sim.id,[f.id,second]));
  const sending=scope(()=>f.reports.send(f.sim.id,plan.token,'sim'));
  try {
    await entered.promise;
    const stale=new Date(Date.now()-180_000).toISOString();
    await sqlite.run('UPDATE report_deliveries SET criado_em=?,tentativa_em=? WHERE resultado_id=?',stale,stale,second);
    await scope(()=>f.simulados.reviewAnswers(second,{versao_esperada:0,respostas:{'1':'B'},motivo:'Conferi a próxima prova enquanto aguardava na fila.'}));
  } finally {release.resolve();}
  const outcome=await sending;
  assert.equal(outcome.total_enviados,1);assert.equal(f.messages.length,1);
  assert.equal(outcome.resultados[1].status,'BLOQUEADO');assert.match(outcome.resultados[1].erro,/antes de chamar o provedor/);
  const row=await sqlite.get('SELECT * FROM report_deliveries WHERE resultado_id=?',second);
  assert.equal(row.status,'BLOQUEADO');assert.equal(row.message_id,'');
  const access=await sqlite.get('SELECT * FROM report_access_links WHERE delivery_id=?',row.id);
  assert.ok(access.revogado_em);assert.equal(access.ativado_em,null);
  const retry=await scope(()=>f.reports.plan(f.sim.id,[second]));assert.equal(f.messages.length,1);
  await scope(()=>f.reports.send(f.sim.id,retry.token,'sim'));
  assert.equal(f.messages.length,2);assert.equal(f.messages[1].report.geral.total_acertos,49);
  assert.equal((await sqlite.get('SELECT status FROM report_deliveries WHERE id=?',row.id)).status,'BLOQUEADO');
});

test('reverificação antes do gateway renova lease vencido e recusa revisão concorrente da mensagem atual',async()=>{
  let f;
  f=await fixture(sqlite,async()=>{
    const row=await sqlite.get('SELECT criado_em,tentativa_em FROM report_deliveries WHERE resultado_id=?',f.id);
    assert.ok(Date.now()-Date.parse(row.criado_em)>120_000);assert.ok(Date.now()-Date.parse(row.tentativa_em)<5000);
    await assert.rejects(revise(f),statusError(409));
  });
  const original=f.reports.refreshReserved.bind(f.reports);
  f.reports.refreshReserved=async entry=>{
    const expired=new Date(Date.now()-180_000).toISOString();
    await sqlite.run('UPDATE report_deliveries SET criado_em=?,tentativa_em=? WHERE id=?',expired,expired,entry.row.id);
    return original(entry);
  };
  const plan=await scope(()=>f.reports.plan(f.sim.id,[f.id]));
  const outcome=await scope(()=>f.reports.send(f.sim.id,plan.token,'sim'));
  assert.equal(outcome.total_enviados,1);assert.equal(f.messages.length,1);assert.equal(outcome.resultados[0].status,'ENVIADO');
  assert.equal((await sqlite.all('SELECT * FROM answer_review_events WHERE resultado_id=?',f.id)).length,0);
});

test('falha transitória antes gateway exige NOVA prévia e recupera mesmo hash uma única vez em confirmações concorrentes',async()=>{
  const f=await fixture(),plan=await scope(()=>f.reports.plan(f.sim.id,[f.id])),original=f.reports.refreshReserved.bind(f.reports);
  f.reports.refreshReserved=async()=>{throw new Error('Falha transitória de validação local.');};
  const blocked=await scope(()=>f.reports.send(f.sim.id,plan.token,'sim'));f.reports.refreshReserved=original;
  assert.equal(blocked.resultados[0].status,'BLOQUEADO');assert.equal(f.messages.length,0);
  const before=await sqlite.get('SELECT * FROM report_deliveries WHERE resultado_id=?',f.id);
  await assert.rejects(scope(()=>f.reports.send(f.sim.id,plan.token,'sim')),statusError(400));
  const other={id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',email:'other@example.test'};
  await assert.rejects(withAccount(other,()=>f.reports.send(f.sim.id,plan.token,'sim')),statusError(404));
  const next=await scope(()=>f.reports.plan(f.sim.id,[f.id]));assert.equal(next.alunos[0].content_hash,plan.alunos[0].content_hash);
  const outcomes=await Promise.all([scope(()=>f.reports.send(f.sim.id,next.token,'sim')),scope(()=>f.reports.send(f.sim.id,next.token,'sim'))]);
  assert.equal(outcomes.reduce((sum,row)=>sum+row.total_enviados,0),1);assert.equal(f.messages.length,1);
  const after=await sqlite.get('SELECT * FROM report_deliveries WHERE resultado_id=?',f.id);
  assert.equal(after.id,before.id);assert.equal(after.content_hash,before.content_hash);assert.equal(after.status,'ENVIADO');
  const links=await sqlite.all('SELECT * FROM report_access_links WHERE delivery_id=?',after.id);
  assert.equal(links.length,2);assert.equal(links.filter(link=>link.revogado_em).length,1);assert.equal(links.filter(link=>link.ativado_em&&!link.revogado_em).length,1);
});

test('nova prévia do mesmo conteúdo nunca recupera estados ENVIADO, ENVIANDO ou AMBIGUO',async()=>{
  const f=await fixture(),first=await scope(()=>f.reports.plan(f.sim.id,[f.id]));await scope(()=>f.reports.send(f.sim.id,first.token,'sim'));
  for(const status of ['ENVIADO','ENVIANDO','AMBIGUO']) {
    await sqlite.run('UPDATE report_deliveries SET status=?,message_id=? WHERE resultado_id=?',status,'',f.id);
    const plan=await scope(()=>f.reports.plan(f.sim.id,[f.id])),outcome=await scope(()=>f.reports.send(f.sim.id,plan.token,'sim'));
    assert.equal(outcome.total_enviados,0);assert.equal(outcome.total_ignorados,1);assert.equal(outcome.resultados[0].status,status);assert.equal(f.messages.length,1);
  }
});

test('PostgreSQL/PGlite: envio e reemissão bloqueiam as provas antes de recalcular hash; batch lock ordenado e privado',async()=>{
  const {PGlite}=require('@electric-sql/pglite'),{readFile}=require('node:fs/promises'),{resolve}=require('node:path'),{AsyncLocalStorage}=require('node:async_hooks');
  const pg=new PGlite(),context=new AsyncLocalStorage(),locks=[];
  const db={dialect:'postgres',all:async(sql,...parameters)=>{
    const result=await pg.query(postgresPlaceholders(sql),parameters);
    if(sql.includes('FOR UPDATE OF r')) {assert.equal(context.getStore()?.transaction,true);locks.push({sql,parameters,ids:result.rows.map(row=>row.id)});context.getStore().lockedIds=new Set(result.rows.map(row=>row.id));}
    return result.rows;
  },get:async(sql,...parameters)=>(await db.all(sql,...parameters))[0],run:async(sql,...parameters)=>{
    let query=postgresPlaceholders(sql);if(/^\s*INSERT INTO (core_simulado|core_lotecorrecao|core_resultadoaluno|report_deliveries)\b/.test(sql)&&!query.includes('RETURNING'))query+=' RETURNING id';
    const result=await pg.query(query,parameters);return {changes:result.affectedRows,lastInsertRowid:result.rows[0]?.id};
  },transaction:async work=>{if(context.getStore())return work();await pg.exec('BEGIN');try{const value=await context.run({transaction:true,lockedIds:new Set()},work);await pg.exec('COMMIT');return value;}catch(error){await pg.exec('ROLLBACK');throw error;}}};
  try {
    await pg.exec(await readFile(resolve(__dirname,'../../../infra/sql/001-schema.sql'),'utf8'));
    const f=await fixture(db),now=new Date().toISOString();
    const second=Number((await db.run(`INSERT INTO core_resultadoaluno(matricula,respostas_detectadas,total_acertos,total_erros,total_rasuras,total_brancos,total_incertas,nota_percentual,status,lote_id)
      VALUES(?,?,50,0,0,0,0,100,'SUCESSO',?)`,f.matricula,JSON.stringify(key),f.lote)).lastInsertRowid);
    const originalReport=f.reports.report.bind(f.reports);
    f.reports.report=async id=>{
      // A concurrent review cannot change this row between fingerprint and reservation.
      if(context.getStore()?.transaction) assert.ok(context.getStore().lockedIds.has(id),'fingerprint must follow the same row lock used by manual review');
      return originalReport(id);
    };
    const plan=await scope(()=>f.reports.plan(f.sim.id,[second,f.id]));
    await scope(()=>f.reports.send(f.sim.id,plan.token,'sim'));
    assert.equal(f.messages.length,2);assert.deepEqual(locks[0].ids,[f.id,second]);assert.deepEqual(locks[0].parameters,[f.sim.id,account.id,f.id,second]);
    assert.match(locks[0].sql,/s\.owner_id=\?/);assert.match(locks[0].sql,/ORDER BY r\.id FOR UPDATE OF r/);
    const delivery=await db.get('SELECT id FROM report_deliveries WHERE resultado_id=?',f.id),reissueIndex=locks.length;
    const reissue=await scope(()=>f.reports.planReissue(f.sim.id,delivery.id));
    await scope(()=>f.reports.reissue(f.sim.id,reissue.token,'sim'));
    assert.equal(f.messages.length,3);assert.deepEqual(locks[reissueIndex].ids,[f.id]);assert.deepEqual(locks[reissueIndex+1].ids,[f.id]);
    // A stale preview after a manual review must roll back before any new delivery.
    const stale=await scope(()=>f.reports.plan(f.sim.id,[f.id]));await revise(f);
    await assert.rejects(scope(()=>f.reports.send(f.sim.id,stale.token,'sim')),statusError(400));assert.equal(f.messages.length,3);
    // Plans cannot lock/read a proof owned by another teacher, even if stored payload is tampered.
    const foreign=await fixture(db),different='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    await db.run('UPDATE core_simulado SET owner_id=? WHERE id=?',different,foreign.sim.id);
    const tampered=await scope(()=>f.reports.plan(f.sim.id,[f.id]));
    const saved=await db.get('SELECT payload FROM report_delivery_plans WHERE token_hash=?',sha256(tampered.token));
    const rows=JSON.parse(saved.payload);rows[0].resultado_id=foreign.id;
    await db.run('UPDATE report_delivery_plans SET payload=? WHERE token_hash=?',JSON.stringify(rows),sha256(tampered.token));
    await assert.rejects(scope(()=>f.reports.send(f.sim.id,tampered.token,'sim')),statusError(400));
    assert.deepEqual(locks.at(-1).ids,[]);assert.equal(f.messages.length,3);
  } finally {await pg.close();}
});
