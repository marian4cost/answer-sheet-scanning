const {test,before,after} = require('./account-fixture.cjs');
const assert = require('node:assert/strict');
const {mkdtempSync,rmSync,mkdirSync,writeFileSync,existsSync,readdirSync} = require('node:fs');
const {tmpdir} = require('node:os');
const {join} = require('node:path');
const {randomUUID} = require('node:crypto');
const temp=mkdtempSync(join(tmpdir(),'enem-legacy-identity-'));
Object.assign(process.env,{DATABASE_URL:'',DATABASE_PATH:join(temp,'legacy.sqlite3'),MEDIA_ROOT:join(temp,'media'),STORAGE_MODE:'local',OMR_REMOTE_URL:'',AUTH_ENABLED:'false',EMAILJS_ENABLED:'false',EMAILJS_SERVICE_ID:'',EMAILJS_TEMPLATE_ID:'',EMAILJS_PUBLIC_KEY:'',EMAILJS_PRIVATE_KEY:'',RESEND_API_KEY:'',SMTP_HOST:'',SMTP_USER:'',SMTP_PASS:''});
delete process.env.VERCEL;
const {DatabaseService} = require('../dist/database.service.js');
const {SimuladosService} = require('../dist/simulados.service.js');
const key=Object.fromEntries(Array.from({length:50},(_,i)=>[String(i+1),'ABCDE'[i%5]]));
let db;
before(()=>{db=new DatabaseService();for(const dir of ['.staging','uploads','debug_images'])mkdirSync(join(process.env.MEDIA_ROOT,dir),{recursive:true});});
after(async()=>{await db?.onModuleDestroy();rmSync(temp,{recursive:true,force:true});});
async function fixture(readings=[],count=1,documentInfo=true) {
  const calls=[],omr={validate:async()=>{calls.push({action:'validate'});return {ok:true};},process:async(...args)=>{calls.push({action:'process',args});const index=calls.filter(row=>row.action==='process').length-1;return readings[index] || {respostas_detectadas:key,status:'SUCESSO',erro_msg:'',debug_image_path:null,matricula_detectada:'00003141',matricula_status:'CONFIRMADA',matricula_fonte:'pdf_texto'};}};
  if(documentInfo)omr.documentInfo=async path=>{calls.push({action:'document_info',path});return {page_count:count};};
  const service=new SimuladosService(db,omr,{}),sim=await service.create('Teste fictício',undefined,50,[],key);
  return {service,simuladoId:sim.id,calls};
}
function file(name='arquivo-aleatorio.pdf') {const path=join(process.env.MEDIA_ROOT,'.staging',randomUUID());writeFileSync(path,'fake isolated document');return {path,originalname:name,mimetype:name.endsWith('.pdf')?'application/pdf':'image/jpeg'};}
async function readingCount(id) {return (await db.get('SELECT COUNT(*) AS total FROM core_resultadoaluno r JOIN core_lotecorrecao l ON l.id=r.lote_id WHERE l.simulado_id=?',id)).total;}
const reading=(matricula='00003141',status='CONFIRMADA',answers=key,source='pdf_texto')=>({respostas_detectadas:answers,status:'SUCESSO',erro_msg:'',debug_image_path:null,matricula_detectada:matricula,matricula_status:status,matricula_fonte:source});
const rejection=(promise,pattern=/prévia/)=>assert.rejects(promise,error=>error.getStatus?.()===400 && pattern.test(error.message));

test('upload individual extrai matrícula do documento, preserva zeros e ignora nome conflitante',async()=>{
  const f=await fixture([reading('00003141')]),uploaded=file('999999999.jpeg');
  await f.service.upload(f.simuladoId,[uploaded]);
  const result=(await f.service.results(f.simuladoId)).resultados[0];
  assert.equal(result.matricula,'00003141');assert.equal(result.arquivo_origem,'999999999.jpeg');assert.equal(result.pagina_origem,1);assert.equal(result.matricula_fonte,'pdf_texto');
  assert.equal(result.total_acertos,50);assert.equal(result.nota_percentual,100);assert.deepEqual(result.gabarito_do_envio,key);
  assert.deepEqual(f.calls.map(row=>row.action),['validate','document_info','process']);
  const process=f.calls.find(row=>row.action==='process');assert.equal(process.args[4],1);assert.equal(process.args[5],true);
});
test('matrícula explícita do professor supera identificação automática e também preserva zeros',async()=>{
  const f=await fixture([reading(null,'AMBIGUA')]);await f.service.upload(f.simuladoId,[file('imagem.jpeg')],JSON.stringify([' 00000007 ']));
  const result=(await f.service.results(f.simuladoId)).resultados[0];assert.equal(result.matricula,'00000007');assert.equal(result.matricula_fonte,'manual');assert.equal(f.calls.find(row=>row.action==='process').args[5],false);
});
test('matrícula ausente, incerta ou ambígua exige prévia e não gera resultado parcial',async()=>{
  for(const state of ['AUSENTE','INCERTA','AMBIGUA']) {
    const f=await fixture([reading('00003141',state)]),uploaded=file('00003141.pdf');
    await rejection(f.service.upload(f.simuladoId,[uploaded]));assert.equal(await readingCount(f.simuladoId),0);assert.equal((await f.service.detail(f.simuladoId)).envios.length,0);assert.equal(existsSync(uploaded.path),false);
  }
});
test('status CONFIRMADA não aceita matrícula inválida, numérica ou com controles',async()=>{
  for(const matricula of [null,123,'','\n0001','0001\0', 'X'.repeat(101)]) {
    const f=await fixture([reading(matricula)]);await rejection(f.service.upload(f.simuladoId,[file()]));assert.equal(await readingCount(f.simuladoId),0);
  }
});
test('PDF com várias páginas é recusado pelo endpoint legado antes de processar qualquer página',async()=>{
  const f=await fixture([],2),uploaded=file('todos-os-cartoes.pdf');await rejection(f.service.upload(f.simuladoId,[uploaded]),/várias páginas.*prévia/);
  assert.equal(f.calls.filter(row=>row.action==='process').length,0);assert.equal(await readingCount(f.simuladoId),0);assert.equal(existsSync(uploaded.path),false);
  await rejection(f.service.upload(f.simuladoId,[file('multi.pdf')],['00001']),/várias páginas/);assert.equal(await readingCount(f.simuladoId),0);
});
test('gabarito oficial multipágina não cria simulado nem altera a chave existente',async()=>{
  const f=await fixture([],3),before=(await f.service.dashboard()).total_simulados;
  await rejection(f.service.create('Professor fictício',file('oficial.pdf'),50),/apenas uma página/);
  assert.equal((await f.service.dashboard()).total_simulados,before);assert.equal(f.calls.filter(row=>row.action==='process').length,0);
  await rejection(f.service.updateKey(f.simuladoId,file('chave.pdf')),/apenas uma página/);assert.deepEqual((await f.service.get(f.simuladoId)).gabarito_oficial,key);
});
test('quantidade de páginas inválida falha em vez de assumir silenciosamente uma página',async()=>{
  for(const count of [0,-1,NaN,'2']) {const f=await fixture([],count);await rejection(f.service.upload(f.simuladoId,[file()],['0001']),/quantidade de páginas/);assert.equal(f.calls.filter(row=>row.action==='process').length,0);}
});
test('overrides rejeitam caracteres de controle, entradas vazias e quantidade divergente',async()=>{
  for(const raw of [['0001\n'],['0001\0'],['\u0085'],[''],[],['1','2'],[123]]) {
    const f=await fixture();await rejection(f.service.upload(f.simuladoId,[file()],raw),/matrícula/);assert.equal(f.calls.length,0);assert.equal(await readingCount(f.simuladoId),0);
  }
});
test('lote individual com segunda identidade pendente faz rollback de todas as provas',async()=>{
  const f=await fixture([reading('0000001'),reading(null,'AUSENTE')]);
  const beforeFiles=new Set(readdirSync(join(process.env.MEDIA_ROOT,'uploads')));
  await rejection(f.service.upload(f.simuladoId,[file('uma.jpeg'),file('duas.jpeg')]));
  assert.equal(await readingCount(f.simuladoId),0);assert.equal((await f.service.detail(f.simuladoId)).envios.length,0);
  assert.deepEqual(new Set(readdirSync(join(process.env.MEDIA_ROOT,'uploads'))),beforeFiles);
});
test('comparação real usa chave histórica e mantém brancos/duplas sem forçar respostas corretas',async()=>{
  const answers={...key,'1':'E','2':'BNK','3':'RAS'},f=await fixture([reading('00000123','CONFIRMADA',answers,'ocr')]);
  await f.service.upload(f.simuladoId,[file('foto.jpeg')]);
  const first=(await f.service.results(f.simuladoId)).resultados[0];assert.equal(first.total_acertos,47);assert.equal(first.total_brancos,1);assert.equal(first.total_rasuras,1);assert.equal(first.total_erros,1);assert.equal(first.nota_percentual,94);assert.equal(first.matricula_fonte,'ocr');
  await f.service.updateKey(f.simuladoId,undefined,undefined,Object.fromEntries(Object.keys(key).map(q=>[q,'B'])));
  const old=(await f.service.results(f.simuladoId)).resultados[0];assert.deepEqual(old.gabarito_do_envio,key);assert.deepEqual(old.respostas_detectadas,answers);assert.equal(old.nota_percentual,94);
});
test('erro de leitura só é guardado se professor informou matrícula explícita, sem fallback de filename',async()=>{
  const failed={respostas_detectadas:{},status:'ERRO_LEITURA',debug_image_path:null,erro_msg:'Erro fictício.'},f=await fixture([failed]);
  await f.service.upload(f.simuladoId,[file('não-identificar-pelo-nome.jpeg')],['00001000']);
  const result=(await f.service.results(f.simuladoId)).resultados[0];assert.equal(result.matricula,'00001000');assert.equal(result.status,'ERRO_LEITURA');assert.equal(result.total_acertos,0);
  const auto=await fixture([failed]);await rejection(auto.service.upload(auto.simuladoId,[file('00001000.jpeg')]));assert.equal(await readingCount(auto.simuladoId),0);
});
test('fake legado sem documentInfo continua suportado apenas com identidade confirmada ou matrícula explícita',async()=>{
  const f=await fixture([reading('00004567')],1,false);await f.service.upload(f.simuladoId,[file('nome-aleatorio.jpeg')]);
  assert.equal((await f.service.results(f.simuladoId)).resultados[0].matricula,'00004567');assert.ok(!f.calls.some(row=>row.action==='document_info'));
});
