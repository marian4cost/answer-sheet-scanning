const {test,before,after,FIXTURE_ACCOUNT}=require('./account-fixture.cjs');
const assert=require('node:assert/strict');
const {mkdtempSync,rmSync,readFileSync}=require('node:fs');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const dir=mkdtempSync(join(tmpdir(),'sirenia-contact-edit-'));
Object.assign(process.env,{DATABASE_URL:'',DATABASE_PATH:join(dir,'contacts.sqlite3'),STORAGE_MODE:'local',MEDIA_ROOT:join(dir,'media'),EMAILJS_ENABLED:'false',RESEND_API_KEY:'',SMTP_HOST:'',WEB_URL:'https://ficticio.example.test'});
delete process.env.VERCEL;
const {DatabaseService,postgresPlaceholders}=require('../dist/database.service');
const {ContactsService}=require('../dist/contacts.service');
const {ReportsService}=require('../dist/reports.service');
const {SimuladosService}=require('../dist/simulados.service');
const {withAccount}=require('../dist/account-context');
const other={id:'22222222-2222-4222-8222-222222222222',email:'outra-conta@example.test',role:'admin'};
let db,contacts;
before(()=>{db=new DatabaseService();contacts=new ContactsService(db);});
after(async()=>{await db.onModuleDestroy();rmSync(dir,{recursive:true,force:true});});
async function seed(matricula,owner=FIXTURE_ACCOUNT.id,expiry=new Date(Date.now()+86400_000).toISOString()) {
  await db.run('INSERT INTO student_contacts(owner_id,matricula,email,nome,curso,atualizado_em,expira_em) VALUES(?,?,?,?,?,?,?)',owner,matricula,'original@example.test','Aluno fictício','Curso fictício',new Date().toISOString(),expiry);
  return withAccount({...FIXTURE_ACCOUNT,id:owner},()=>contacts.get(matricula));
}
function body(contact,patch={}) {return {matricula:contact.matricula,email:contact.email,nome:contact.nome,curso:contact.curso,atualizado_em:contact.atualizado_em,...patch};}
function deletion(contact,patch={}) {return {confirmar:'excluir',matricula:contact.matricula,atualizado_em:contact.atualizado_em,...patch};}

test('edição normaliza email, salva todos os campos e persiste sem renovar o prazo',async()=>{
  const contact=await seed('000001');
  const result=await contacts.update(contact.matricula,body(contact,{email:' CORRIGIDO@EXAMPLE.TEST ',nome:' Nome corrigido ',curso:' Edificações '}));
  assert.equal(result.email,'corrigido@example.test');assert.equal(result.nome,'Nome corrigido');assert.equal(result.curso,'Edificações');
  assert.equal(result.matricula,'000001');assert.equal(result.expira_em,contact.expira_em);assert.notEqual(result.atualizado_em,contact.atualizado_em);
  const reopened=new ContactsService(db);assert.deepEqual({...await reopened.get('000001')},result);
  assert.equal((await contacts.update(result.matricula,body(result))).atualizado_em,result.atualizado_em);
});
test('trocar matrícula conserva zeros, remove apenas a associação antiga e não altera provas',async()=>{
  const contact=await seed('000002');const result=await contacts.update('000002',body(contact,{matricula:' 000020 '}));
  assert.equal(result.matricula,'000020');assert.equal(await contacts.get('000002'),undefined);assert.equal(await contacts.get('20'),undefined);
  assert.equal((await contacts.get('000020')).email,contact.email);
});
test('matrícula duplicada da própria conta, inclusive expirada, não sobrescreve contatos',async()=>{
  const contact=await seed('000003');await seed('000030');await seed('000031',FIXTURE_ACCOUNT.id,new Date(Date.now()-1).toISOString());
  for(const matricula of ['000030','000031']) await assert.rejects(contacts.update('000003',body(contact,{matricula})),error=>error.getStatus()===409);
  assert.deepEqual(await contacts.get('000003'),contact);assert.equal((await contacts.get('000030')).email,'original@example.test');
});
test('mesma matrícula em outra conta é independente e não impede a edição',async()=>{
  const contact=await seed('000004');await seed('000040',other.id);
  await contacts.update('000004',body(contact,{matricula:'000040',email:'conta-certa@example.test'}));
  assert.equal((await withAccount(other,()=>contacts.get('000040'))).email,'original@example.test');
  assert.equal((await contacts.get('000040')).email,'conta-certa@example.test');
});
test('outra conta, mesmo admin, não edita contato alheio e owner_id não pode ser injetado',async()=>{
  const contact=await seed('000005');
  await assert.rejects(withAccount(other,()=>contacts.update('000005',body(contact))),error=>error.getStatus()===404);
  await assert.rejects(contacts.update('000005',body(contact,{owner_id:other.id})),error=>error.getStatus()===400);
  assert.deepEqual(await contacts.get('000005'),contact);
});
test('e-mail, tipos, comprimentos e caracteres de controle inválidos não causam gravação parcial',async()=>{
  const contact=await seed('000006');
  for(const patch of [{email:'invalido'},{email:'a..b@example.test'},{email:'a@example.test\r\nBcc:x@example.test'},{matricula:6},{matricula:''},{matricula:'x'.repeat(101)},{nome:'x'.repeat(151)},{nome:'Nome\nOutro'},{curso:123},{curso:'x'.repeat(151)},{curso:'Curso\u0000outro'},{atualizado_em:''}]) {
    await assert.rejects(contacts.update('000006',body(contact,patch)),error=>error.getStatus()===400);assert.deepEqual(await contacts.get('000006'),contact);
  }
  const cleared=await contacts.update('000006',body(contact,{nome:'',curso:''}));assert.equal(cleared.nome,'');assert.equal(cleared.curso,'');
});
test('contato inexistente ou expirado retorna 404 e não é recriado',async()=>{
  const contact=await seed('000007',FIXTURE_ACCOUNT.id,new Date(Date.now()-1).toISOString());assert.equal(contact,undefined);
  for(const matricula of ['000007','nao-existe'])await assert.rejects(contacts.update(matricula,{}),error=>error.getStatus()===404);
});
test('contato legado com data textual pode ser corrigido sem perder o controle de versão',async()=>{
  await seed('000011');await db.run('UPDATE student_contacts SET atualizado_em=? WHERE owner_id=? AND matricula=?','data-legada',FIXTURE_ACCOUNT.id,'000011');
  const contact=await contacts.get('000011'),saved=await contacts.update('000011',body(contact,{nome:'Legado corrigido'}));
  assert.ok(Number.isFinite(Date.parse(saved.atualizado_em)));assert.equal(saved.nome,'Legado corrigido');
});
test('duas edições da mesma versão não se sobrescrevem silenciosamente',async()=>{
  const contact=await seed('000008');
  const results=await Promise.allSettled([contacts.update('000008',body(contact,{nome:'Primeira edição'})),contacts.update('000008',body(contact,{nome:'Segunda edição'}))]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);const rejected=results.find(r=>r.status==='rejected');assert.equal(rejected.reason.getStatus(),409);
  assert.equal((await contacts.get('000008')).nome,'Primeira edição');
});
test('edição manual invalida uma prévia anterior de importação',async()=>{
  const contact=await seed('000009');const plan=await contacts.preview(Buffer.from('matricula,email,nome\n000009,planilha@example.test,Nome da planilha\n'),'qa.csv');
  await contacts.update('000009',body(contact,{email:'manual@example.test'}));
  await assert.rejects(contacts.import(plan.token,'sim'),/mudaram/);assert.equal((await contacts.get('000009')).email,'manual@example.test');
});
test('boletim usa o email corrigido, bloqueia o plano antigo e editar não envia mensagens',async()=>{
  const contact=await seed('000010'),key=Object.fromEntries(Array.from({length:50},(_,i)=>[i+1,'A']));
  const sim=await db.run('INSERT INTO core_simulado(titulo,data_criacao,gabarito_oficial,total_questoes,temas,owner_id) VALUES(?,?,?,?,?,?)','QA edição de contato',new Date().toISOString(),JSON.stringify(key),50,'[]',FIXTURE_ACCOUNT.id);
  const batch=await db.run('INSERT INTO core_lotecorrecao(criado_em,simulado_id,gabarito_snapshot) VALUES(?,?,?)',new Date().toISOString(),sim.lastInsertRowid,JSON.stringify(key));
  const result=await db.run('INSERT INTO core_resultadoaluno(matricula,respostas_detectadas,total_acertos,total_erros,total_rasuras,total_brancos,nota_percentual,status,lote_id) VALUES(?,?,?,?,?,?,?,?,?)','000010',JSON.stringify(key),50,0,0,0,100,'SUCESSO',batch.lastInsertRowid);
  const sent=[],reports=new ReportsService(db,new SimuladosService(db,{}),contacts,{availability:()=>({envio_disponivel:true}),deliver:async(...args)=>{sent.push(args);return 'ficticio';}});
  const plan=await reports.plan(sim.lastInsertRowid,[result.lastInsertRowid]);
  const renamed=await contacts.update('000010',body(contact,{email:'email-corrigido@example.test'}));
  assert.equal((await reports.report(result.lastInsertRowid)).email,'email-corrigido@example.test');
  await assert.rejects(reports.send(sim.lastInsertRowid,plan.token,'sim'),/mudou após a prévia/);assert.equal(sent.length,0);
  await contacts.update('000010',body(renamed,{matricula:'000100'}));
  assert.equal((await db.get('SELECT matricula FROM core_resultadoaluno WHERE id=?',result.lastInsertRowid)).matricula,'000010');
  assert.equal((await reports.report(result.lastInsertRowid)).email,null);
});
test('exclusão remove somente o contato confirmado, preservando zeros e a mesma matrícula de outra conta',async()=>{
  const contact=await seed('000012');await seed('12');await seed('000012',other.id);
  const removed=await contacts.remove('000012',deletion(contact));assert.equal(removed.matricula,'000012');
  assert.equal(await contacts.get('000012'),undefined);assert.ok(await contacts.get('12'));
  assert.ok(await withAccount(other,()=>contacts.get('000012')));
  assert.ok(!(await contacts.list()).contatos.some(c=>c.matricula==='000012'));
  assert.equal(await new ContactsService(db).get('000012'),undefined);
});
test('exclusão exige confirmação exata e rejeita campos extras, versões inválidas e matrícula abreviada',async()=>{
  const contact=await seed('000013');
  for(const invalid of [null,[],{},deletion(contact,{confirmar:'sim'}),deletion(contact,{matricula:'13'}),deletion(contact,{matricula:13}),deletion(contact,{atualizado_em:''}),deletion(contact,{atualizado_em:'\n'}),deletion(contact,{atualizado_em:'x'.repeat(101)}),deletion(contact,{owner_id:other.id})]) {
    await assert.rejects(contacts.remove('000013',invalid),error=>error.getStatus()===400);assert.deepEqual(await contacts.get('000013'),contact);
  }
});
test('outra conta, mesmo administradora, não exclui nem descobre um contato alheio',async()=>{
  const contact=await seed('000014');
  await assert.rejects(withAccount(other,()=>contacts.remove('000014',deletion(contact))),error=>error.getStatus()===404);
  assert.deepEqual(await contacts.get('000014'),contact);
});
test('exclusão inexistente, repetida ou de contato expirado retorna 404',async()=>{
  const contact=await seed('000015');await contacts.remove('000015',deletion(contact));
  await seed('000016',FIXTURE_ACCOUNT.id,new Date(Date.now()-1000).toISOString());
  for(const matricula of ['nao-existe','000015','000016'])await assert.rejects(contacts.remove(matricula,deletion(contact,{matricula})),error=>error.getStatus()===404);
});
test('exclusão com a versão antiga não apaga uma correção manual mais recente',async()=>{
  const original=await seed('000017');const updated=await contacts.update('000017',body(original,{email:'corrigido@example.test'}));
  await assert.rejects(contacts.remove('000017',deletion(original)),error=>error.getStatus()===409);
  assert.deepEqual({...await contacts.get('000017')},updated);
});
test('duas exclusões simultâneas não atingem outro contato',async()=>{
  const contact=await seed('000018');const intact=await seed('000019');
  const results=await Promise.allSettled([contacts.remove('000018',deletion(contact)),contacts.remove('000018',deletion(contact))]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.getStatus(),404);
  assert.deepEqual(await contacts.get('000019'),intact);
});
test('exclusão invalida prévia antiga e o cadastro pode ser importado novamente após uma nova prévia',async()=>{
  const contact=await seed('009020');const csv=Buffer.from('matricula,email,nome\n009020,reimportado@example.test,Aluno fictício\n');const old=await contacts.preview(csv,'qa.csv');
  await contacts.remove('009020',deletion(contact));await assert.rejects(contacts.import(old.token,'sim'),/mudaram/);
  assert.equal(await contacts.get('009020'),undefined);
  const fresh=await contacts.preview(csv,'qa.csv');await contacts.import(fresh.token,'sim');assert.equal((await contacts.get('009020')).email,'reimportado@example.test');
});
test('excluir contato preserva resultados e redação e bloqueia envio ao destinatário da prévia anterior',async()=>{
  const contact=await seed('000021'),key=Object.fromEntries(Array.from({length:50},(_,i)=>[i+1,'A']));
  const sim=await db.run('INSERT INTO core_simulado(titulo,data_criacao,gabarito_oficial,total_questoes,temas,owner_id) VALUES(?,?,?,?,?,?)','QA excluir contato',new Date().toISOString(),JSON.stringify(key),50,'[]',FIXTURE_ACCOUNT.id);
  const batch=await db.run('INSERT INTO core_lotecorrecao(criado_em,simulado_id,gabarito_snapshot) VALUES(?,?,?)',new Date().toISOString(),sim.lastInsertRowid,JSON.stringify(key));
  const result=await db.run('INSERT INTO core_resultadoaluno(matricula,respostas_detectadas,total_acertos,total_erros,total_rasuras,total_brancos,nota_percentual,status,lote_id) VALUES(?,?,?,?,?,?,?,?,?)','000021',JSON.stringify(key),50,0,0,0,100,'SUCESSO',batch.lastInsertRowid);
  await db.run('INSERT INTO report_feedback(resultado_id,nota_redacao,feedback_redacao,atualizado_em) VALUES(?,?,?,?)',result.lastInsertRowid,800,'Feedback fictício preservado.',new Date().toISOString());
  let deliveries=0;const reports=new ReportsService(db,new SimuladosService(db,{}),contacts,{availability:()=>({envio_disponivel:true}),deliver:async()=>{deliveries++;return 'ficticio';}});
  const plan=await reports.plan(sim.lastInsertRowid,[result.lastInsertRowid]);const before=await reports.report(result.lastInsertRowid);
  await contacts.remove('000021',deletion(contact));const after=await reports.report(result.lastInsertRowid);
  assert.equal(after.email,null);assert.equal(after.apto_envio,false);assert.deepEqual(after.geral,before.geral);assert.deepEqual(after.redacao,before.redacao);
  assert.equal((await db.get('SELECT matricula FROM core_resultadoaluno WHERE id=?',result.lastInsertRowid)).matricula,'000021');
  await assert.rejects(reports.send(sim.lastInsertRowid,plan.token,'sim'),/mudou após a prévia/);assert.equal(deliveries,0);
});
test('edição e exclusão funcionam com SQL PostgreSQL, rollback e isolamento por proprietário',async()=>{
  const {PGlite}=require('@electric-sql/pglite'),pg=new PGlite();
  try {
    await pg.exec(readFileSync(join(__dirname,'../../../infra/sql/001-schema.sql'),'utf8'));
    const adapter={dialect:'postgres',all:async(sql,...params)=>(await pg.query(postgresPlaceholders(sql),params)).rows,get:async(sql,...params)=>(await pg.query(postgresPlaceholders(sql),params)).rows[0],run:async(sql,...params)=>({changes:(await pg.query(postgresPlaceholders(sql),params)).affectedRows})};
    // PGlite's query queue belongs to the transaction callback; use that client for every service operation.
    adapter.transaction=work=>pg.transaction(async tx=>{const query=async(sql,...params)=>tx.query(postgresPlaceholders(sql),params);const saved={all:adapter.all,get:adapter.get,run:adapter.run};adapter.all=async(...args)=>(await query(...args)).rows;adapter.get=async(...args)=>(await query(...args)).rows[0];adapter.run=async(...args)=>({changes:(await query(...args)).affectedRows});try{return await work();}finally{Object.assign(adapter,saved);}});
    const service=new ContactsService(adapter),stamp=new Date().toISOString(),expiry=new Date(Date.now()+86400_000).toISOString();
    for(const owner of [FIXTURE_ACCOUNT.id,other.id])await pg.query('INSERT INTO student_contacts(owner_id,matricula,email,nome,curso,atualizado_em,expira_em) VALUES($1,$2,$3,$4,$5,$6,$7)',[owner,'000001','pg@example.test','Aluno PostgreSQL','Curso',stamp,expiry]);
    const original=await service.get('000001'),updated=await service.update('000001',body(original,{matricula:'000002',email:'novo-pg@example.test'}));
    assert.equal(updated.email,'novo-pg@example.test');assert.equal((await service.get('000002')).expira_em,expiry);
    assert.equal((await withAccount(other,()=>service.get('000001'))).email,'pg@example.test');
    await assert.rejects(service.update('000002',body(original,{matricula:'000003'})),error=>error.getStatus()===409);assert.equal(await service.get('000003'),undefined);
    await assert.rejects(service.remove('000002',deletion(updated,{atualizado_em:stamp})),error=>error.getStatus()===409);assert.ok(await service.get('000002'));
    await assert.rejects(withAccount(other,()=>service.remove('000002',deletion(updated))),error=>error.getStatus()===404);
    await service.remove('000002',deletion(updated));assert.equal(await service.get('000002'),undefined);
    assert.equal((await withAccount(other,()=>service.get('000001'))).email,'pg@example.test');
  } finally {await pg.close();}
});
