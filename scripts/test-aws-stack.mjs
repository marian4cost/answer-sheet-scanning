// Integração real Next -> Nest -> PostgreSQL/GoTrue -> Python -> S3 -> SES.
// Executar apenas no stack local descartável. O SES usa o mailbox simulator.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),ExcelJS=require('exceljs');
const base='http://localhost:3080/api',directory='artifacts/aws-migration-2026-10-24';
const truth=JSON.parse(await readFile(directory+'/truth.json','utf8'));
const log=message=>console.log('PASS:',message);
const credentials={email:`aws-qa-${Date.now()}@example.test`,password:randomBytes(24).toString('hex')};
const create=`let raw='';for await(const chunk of process.stdin)raw+=chunk;const c=JSON.parse(raw);const r=await fetch('http://auth:9999/admin/users',{method:'POST',headers:{Authorization:'Bearer '+process.env.SUPABASE_SERVICE_ROLE_KEY,'Content-Type':'application/json'},body:JSON.stringify({email:c.email,password:c.password,email_confirm:true,app_metadata:{role:c.role},user_metadata:{display_name:'Professor de teste AWS'}})});const d=await r.json();if(!r.ok)throw Error(d.msg||d.message||'Auth error');console.log(JSON.stringify({id:d.id}));`;
function provision(role) {
  const account={...credentials,email:role+'-'+credentials.email,role};
  const result=execFileSync('docker',['exec','-i','sirenia-api-1','node','--input-type=module','-e',create],{input:JSON.stringify(account),encoding:'utf8'});
  return {...account,...JSON.parse(result)};
}
const admin=provision('admin'),other=provision('professor');
await writeFile(directory+'/qa-users.json',JSON.stringify({admin,other}),{mode:0o600});
let cookie='';
async function call(path,method='GET',data,session=cookie) {
  const response=await fetch(base+path,{method,headers:{'X-OMR-Client':'web',...(session?{Cookie:session}:{}),...(data && !(data instanceof FormData)?{'Content-Type':'application/json'}:{})},...(data?{body:data instanceof FormData?data:JSON.stringify(data)}:{})});
  const content=response.headers.get('content-type') || '';
  const body=content.includes('application/json')?await response.json():Buffer.from(await response.arrayBuffer());
  return {status:response.status,body,response};
}
async function ok(path,method='GET',data,session=cookie) {const result=await call(path,method,data,session);assert.ok(result.status<300,`${path}: ${result.status} ${JSON.stringify(result.body)}`);return result.body;}
const unauthorized=await call('/simulados');assert.equal(unauthorized.status,401);
const login=await call('/auth/senha','POST',{email:admin.email,senha:admin.password});assert.equal(login.status,201,JSON.stringify(login.body));
const cookies=login.response.headers.getSetCookie();assert.equal(cookies.length,2);assert.ok(cookies.every(c=>c.includes('HttpOnly')&&c.includes('Secure')));assert.ok(cookies.some(c=>/Max-Age=604800/.test(c)));
cookie=cookies.map(c=>c.split(';')[0]).join('; ');
log('Login real, cookies Secure/HttpOnly, renovação de 7 dias e bloqueio sem sessão.');
const health=await ok('/health');assert.equal(health.database,'ok');assert.equal(health.processor.ok,true);log('PostgreSQL e leitor Python dentro do Docker respondem.');
const otherLogin=await call('/auth/senha','POST',{email:other.email,senha:other.password});assert.equal(otherLogin.status,201);const otherCookie=otherLogin.response.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
async function store(filename,purpose) {
  const buffer=await readFile(directory+'/'+filename);
  const prepared=await ok('/uploads/preparar','POST',{files:[{name:filename,size:buffer.length,purpose}]});
  const upload=prepared.uploads[0];const sent=await fetch(upload.url,{method:'PUT',headers:{...upload.headers,'Content-Type':filename.endsWith('.pdf')?'application/pdf':'image/png'},body:buffer});if(sent.status!==200){const code=(await sent.text()).match(/<Code>([A-Za-z]+)<\/Code>/)?.[1]||'StorageError';throw Error('S3 upload HTTP '+sent.status+' '+code);}
  const duplicate=await fetch(upload.url,{method:'PUT',headers:upload.headers,body:buffer});assert.equal(duplicate.status,412);return upload.id;
}
const officialId=await store('card-1.png','gabarito');
const reading=await ok('/leituras/gabarito/armazem','POST',{upload_id:officialId,total_questoes:50});assert.deepEqual(reading.respostas_detectadas,truth['000123'].key);log('PNG enviado ao S3, sobrescrita bloqueada e gabarito extraído pelo OpenCV.');
const themes=[{inicio:1,fim:20,tema:'Linguagens'},{inicio:21,fim:40,tema:'Ciências Humanas'},{inicio:41,fim:50,tema:'Técnico'}];
const sim=await ok('/simulados','POST',{titulo:'Teste AWS completo - fictício',total_questoes:50,gabarito_manual:truth['000123'].key,temas:themes});
assert.equal((await call('/simulados/'+sim.id,'GET',undefined,otherCookie)).status,404);log('Simulado isolado entre duas contas reais.');
const upload=await store('two-pages.pdf','prova');
let plan=await ok(`/simulados/${sim.id}/provas/importacoes/armazem`,'POST',{upload_ids:[upload]});assert.equal(plan.total_paginas,2);
plan=await ok(`/provas/importacoes/${plan.id}/identificar`,'POST',{});assert.deepEqual(plan.paginas.map(p=>p.matricula_detectada),['000123','000124']);
await ok(`/provas/importacoes/${plan.id}/confirmar`,'POST',{paginas:plan.paginas.map(p=>({id:p.id,incluir:true,matricula:p.matricula})),confirmar:'sim',permitir_repetidas:'nao'});
let processed=await ok(`/provas/importacoes/${plan.id}/processar`,'POST',{});while(processed.estado!=='CONCLUIDA')processed=await ok(`/provas/importacoes/${plan.id}/processar`,'POST',{});
const results=await ok(`/simulados/${sim.id}/resultados`);assert.equal(results.resultados.length,2);
for(const row of results.resultados)assert.deepEqual(row.respostas_detectadas,truth[row.matricula].answers);
assert.equal(results.resultados[0].total_acertos,50);assert.equal(results.resultados[1].total_brancos,1);assert.equal(results.resultados[1].total_rasuras,1);
assert.equal((await ok(`/provas/importacoes/${plan.id}/processar`,'POST',{})).envio_id,processed.envio_id);log('PDF coletivo, OCR das duas matrículas, respostas diferentes, branco/rasura e retomada sem duplicação.');
const sim60=await ok('/simulados','POST',{titulo:'Teste AWS 60 questões',total_questoes:60,gabarito_manual:truth['000125'].key,temas:[{inicio:1,fim:60,tema:'Matemática'}]});
const individual=await store('sixty.pdf','prova');const result60=await ok(`/simulados/${sim60.id}/provas/armazem`,'POST',{upload_ids:[individual],matriculas:['000125']});
const rows60=await ok(`/simulados/${sim60.id}/resultados`);assert.equal(rows60.resultados[0].total_acertos,60);log('PDF individual de 60 questões corrigido corretamente.');
const contacts=new FormData();contacts.append('arquivo',new Blob(['Matrícula;Email;Nome;Curso\n000123;success@simulator.amazonses.com;Estudante fictício;Teste\n000124;second@example.test;Outro estudante;Teste\n']),'contacts.csv');
const preview=await ok('/contatos/preview','POST',contacts);assert.deepEqual(preview.erros,[]);await ok('/contatos/importar','POST',{token:preview.token,confirmar:'sim'});
const wb=new ExcelJS.Workbook(),sheet=wb.addWorksheet('Forms');sheet.addRow(['Matrícula','Competência 1','Competência 2','Competência 3','Competência 4','Competência 5','Observações Gerais e Feedback para o Aluno']);sheet.addRow(['000123',200,160,160,160,120,'Feedback fictício para validar a integração AWS.']);
const essay=new FormData();essay.append('arquivo',new Blob([await wb.xlsx.writeBuffer()]),'essay.xlsx');const essayPreview=await ok(`/simulados/${sim.id}/redacoes/preview`,'POST',essay);assert.deepEqual(essayPreview.erros,[]);await ok(`/simulados/${sim.id}/redacoes/importar`,'POST',{token:essayPreview.token,confirmar:'sim',atualizar_existentes:'nao'});
const id=results.resultados[0].id,report=await ok(`/resultados/${id}/boletim`);assert.equal(report.redacao.nota_redacao,800);assert.deepEqual(report.redacao.competencias_redacao,[200,160,160,160,120]);
const pdf=await ok(`/resultados/${id}/boletim/pdf`);assert.equal(pdf.subarray(0,5).toString(),'%PDF-');await writeFile(directory+'/report.pdf',pdf);
const text=execFileSync('pdftotext',['-','-'],{input:pdf}).toString();assert.match(text,/Técnico/i);assert.match(text,/10\/10|10 \/ 10/);assert.doesNotMatch(text,/MÉDIA GERAL/i);
const exported=await ok(`/simulados/${sim.id}/exportar`);const loaded=new ExcelJS.Workbook();await loaded.xlsx.load(exported);assert.ok(loaded.getWorksheet('Redacoes'));await writeFile(directory+'/results.xlsx',exported);log('Contatos, planilha de redação, competências, tema Técnico, PDF e XLSX completos.');
const deliveryPlan=await ok(`/simulados/${sim.id}/boletins/planejar`,'POST',{resultado_ids:[id]});assert.ok(deliveryPlan.token);const sent=await ok(`/simulados/${sim.id}/boletins/enviar`,'POST',{token:deliveryPlan.token,confirmar:'sim'});
const history=await ok(`/simulados/${sim.id}/boletins/entregas`);await writeFile(directory+'/qa-summary.json',JSON.stringify({simulado:sim.id,simulado60:sim60.id,resultado:id,send:sent,history},null,2));
assert.ok(JSON.stringify(history).includes('ENVIADO'),JSON.stringify(history));log('Envio real ao mailbox simulator da AWS, MessageId do SES e histórico persistido.');
const image=await ok(`/resultados/${id}/imagem`);assert.ok(image.length>1000);log('Imagem de revisão privada recuperada do S3.');
await ok('/auth/logout','POST',{});assert.equal((await call('/auth/me')).status,401);log('Logout revoga o acesso no provedor de autenticação.');
console.log('FULL AWS STACK: PASS');
