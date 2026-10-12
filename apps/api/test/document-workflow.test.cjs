const {test,before,after} = require('./account-fixture.cjs');
const assert = require('node:assert/strict');
const {mkdtempSync,rmSync,readFileSync,readdirSync,existsSync} = require('node:fs');
const {tmpdir} = require('node:os');
const {join,resolve} = require('node:path');
const {execFileSync,spawnSync} = require('node:child_process');
const ExcelJS = require('exceljs');
const root=resolve(__dirname,'../../..'),temp=mkdtempSync(join(tmpdir(),'enem-document-workflow-'));
Object.assign(process.env,{DATABASE_URL:'',DATABASE_PATH:join(temp,'workflow.sqlite3'),MEDIA_ROOT:join(temp,'media'),STORAGE_MODE:'local',OMR_REMOTE_URL:'',OMR_REMOTE_SECRET:'',AUTH_ENABLED:'true',AUTH_REGISTRATION_ENABLED:'false',EMAILJS_ENABLED:'false',EMAILJS_SERVICE_ID:'',EMAILJS_TEMPLATE_ID:'',EMAILJS_PUBLIC_KEY:'',EMAILJS_PRIVATE_KEY:'',RESEND_API_KEY:'',SMTP_HOST:'',SMTP_USER:'',SMTP_PASS:'',SUPABASE_URL:'',SUPABASE_ANON_KEY:'',SUPABASE_SERVICE_ROLE_KEY:'',WEB_URL:'http://localhost:3010',CRON_SECRET:'',REPORT_LINK_TTL_DAYS:'7'});
delete process.env.VERCEL;
const {AuthService}=require('../dist/auth.js');
const {createApplication}=require('../dist/bootstrap.js');
const {DatabaseService}=require('../dist/database.service.js');
const {ReportEmailGateway}=require('../dist/reports.service.js');
const {grade}=require('../dist/grading.js');
let app,base,key,truth;
before(async()=>{
  execFileSync(resolve(root,process.env.PYTHON_EXECUTABLE || 'venv/bin/python'),['-c',`
import json,sys
from pathlib import Path
from PIL import Image,ImageDraw
from variable_cards import printed_card,_font
out=Path(sys.argv[1])
key={str(q):'ABCDE'[(q-1)%5] for q in range(1,51)}
second={str(q):'B' for q in range(1,51)};second.update({'2':'BNK','3':'RAS'})
images=[]
for index,answers in enumerate((key,second)):
    canvas,_=printed_card(50,answers,seed=17+index)
    image=Image.fromarray(canvas[:,:,::-1]);draw=ImageDraw.Draw(image)
    draw.rectangle((70,135,1160,205),fill='white')
    draw.text((90,145),'Matricula: '+('000123' if index==0 else '000124'),font=_font(36),fill=(15,15,15))
    images.append(image)
images[0].save(out/'cartoes-coletivos.pdf','PDF',resolution=150,save_all=True,append_images=images[1:])
(out/'truth.json').write_text(json.dumps({'key':key,'answers':[key,second]}))
`,temp],{env:{...process.env,PYTHONPATH:[join(root,'python'),join(root,'python/tests')].join(':')},timeout:60000});
  const expected=JSON.parse(readFileSync(join(temp,'truth.json'),'utf8'));key=expected.key;truth=expected.answers;
  app=await createApplication(false);
  // Somente este processo de teste usa uma identidade fictícia; a aplicação mantém o middleware ativo.
  app.get(AuthService).user=async()=>({id:'11111111-1111-4111-8111-111111111111',email:'professor-ficticio@example.test'});await app.listen(0,'127.0.0.1');base='http://127.0.0.1:'+app.getHttpServer().address().port+'/api';
});
after(async()=>{await app?.close();rmSync(temp,{recursive:true,force:true});});
async function json(path,method='GET',body) {
  const response=await fetch(base+path,{method,headers:{'X-OMR-Client':'web',...(body!==undefined?{'Content-Type':'application/json'}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});
  return {status:response.status,body:await response.json()};
}
async function multipart(path,name,buffer,filename) {
  const data=new FormData();data.append(name,new Blob([buffer]),filename);
  const response=await fetch(base+path,{method:'POST',headers:{'X-OMR-Client':'web'},body:data});return {status:response.status,body:await response.json()};
}
function rows(sheet) {
  const headers=sheet.getRow(1).values.slice(1);return Array.from({length:sheet.rowCount-1},(_,index)=>Object.fromEntries(headers.map((header,column)=>[header,sheet.getRow(index+2).getCell(column+1).value])));
}
function mediaFiles(directory) {return existsSync(directory) ? readdirSync(directory,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?mediaFiles(join(directory,entry.name)):[join(directory,entry.name)]).sort() : [];}
function textOfPdf(buffer) {const result=spawnSync('pdftotext',['-','-'],{input:buffer,maxBuffer:2*1024*1024});assert.equal(result.status,0);return result.stdout.toString();}

test('HTTP real importa PDF digitalizado completo, extrai matrículas, compara questões e importa critérios da redação', {timeout:180000}, async()=>{
  const created=await json('/simulados','POST',{titulo:'Workflow fictício de duas páginas',total_questoes:50,gabarito_manual:key,temas:[{inicio:1,fim:15,tema:'Linguagens'},{inicio:16,fim:30,tema:'Ciências da Natureza'},{inicio:31,fim:40,tema:'Matemática'},{inicio:41,fim:50,tema:'Ciências Humanas'}]});
  assert.equal(created.status,201,JSON.stringify(created.body));const simuladoId=created.body.id;
  const prepared=await multipart(`/simulados/${simuladoId}/provas/importacoes`,'pdf_files',readFileSync(join(temp,'cartoes-coletivos.pdf')),'arquivo-sem-matriculas.pdf');
  assert.equal(prepared.status,201,JSON.stringify(prepared.body));assert.equal(prepared.body.total_paginas,2);assert.equal(prepared.body.total_arquivos,1);assert.equal(prepared.body.estado,'PREVIA');
  const planId=prepared.body.id,identified=await json(`/provas/importacoes/${planId}/identificar`,'POST',{});
  assert.equal(identified.status,201,JSON.stringify(identified.body));assert.equal(identified.body.total_identificadas,2);
  assert.deepEqual(identified.body.paginas.map(page=>page.matricula_detectada),['000123','000124']);
  assert.ok(identified.body.paginas.every(page=>page.identificacao==='CONFIRMADA' && page.fonte==='ocr'));
  const decisions=identified.body.paginas.map(page=>({id:page.id,incluir:true,matricula:page.matricula}));
  const confirmed=await json(`/provas/importacoes/${planId}/confirmar`,'POST',{paginas:decisions,confirmar:'sim',permitir_repetidas:'nao'});assert.equal(confirmed.status,201,JSON.stringify(confirmed.body));
  const processed=await json(`/provas/importacoes/${planId}/processar`,'POST',{});assert.equal(processed.status,201,JSON.stringify(processed.body));assert.equal(processed.body.estado,'CONCLUIDA');assert.equal(processed.body.total_concluidas,2);
  const repeated=await json(`/provas/importacoes/${planId}/processar`,'POST',{});assert.equal(repeated.status,201);assert.equal(repeated.body.envio_id,processed.body.envio_id);
  const result=await json(`/simulados/${simuladoId}/resultados`);assert.equal(result.status,200);assert.equal(result.body.resultados.length,2);
  const results=result.body.resultados;assert.deepEqual(results.map(row=>row.matricula),['000123','000124']);assert.equal(result.body.simulado.total_envios,1);
  for(let index=0;index<2;index++) {
    assert.deepEqual(results[index].respostas_detectadas,truth[index]);assert.deepEqual(results[index].gabarito_do_envio,key);
    assert.equal(results[index].arquivo_origem,'arquivo-sem-matriculas.pdf');assert.equal(results[index].pagina_origem,index+1);assert.equal(results[index].matricula_fonte,'ocr');
    const expected=grade(truth[index],key,index?'ALERTA_RASURA':'SUCESSO',50);for(const field of ['total_acertos','total_erros','total_rasuras','total_brancos','nota_percentual'])assert.equal(results[index][field],expected[field]);
  }
  assert.equal(results[0].nota_percentual,100);assert.equal(results[1].nota_percentual,18);assert.equal(results[1].total_brancos,1);assert.equal(results[1].total_rasuras,1);
  const workbook=new ExcelJS.Workbook(),sheet=workbook.addWorksheet('Respostas ao formulário 1');
  sheet.addRow(['Carimbo de data/hora','Nome do Avaliador','Nome Completo do Aluno','Matrícula do Aluno','Situação do Texto / Anulação','Competência 1','Competência 2','Competência 3','Competência 4','Competência 5','Observações Gerais e Feedback para o Aluno']);
  sheet.addRow(['11/10/2026 09:00:00','Professora fictícia','Estudante fictício A','000123','Texto válido',200,160,120,80,0,'Feedback fictício completo.\nRevise a proposta de intervenção.']);
  sheet.addRow(['11/10/2026 09:05:00','Professor fictício','Estudante fictício B','000124','Texto válido',0,0,0,0,0,'Nota zero informada pelo professor.']);
  const preview=await multipart(`/simulados/${simuladoId}/redacoes/preview`,'arquivo',Buffer.from(await workbook.xlsx.writeBuffer()),'forms-ficticio.xlsx');
  assert.equal(preview.status,201,JSON.stringify(preview.body));assert.deepEqual(preview.body.erros,[]);assert.equal(preview.body.total,2);assert.equal(preview.body.total_resultados,2);
  assert.deepEqual(preview.body.linhas.map(row=>row.nota_redacao),[560,0]);
  const imported=await json(`/simulados/${simuladoId}/redacoes/importar`,'POST',{token:preview.body.token,confirmar:'sim',atualizar_existentes:'nao'});assert.equal(imported.status,201,JSON.stringify(imported.body));assert.equal(imported.body.total_resultados,2);
  const report=await json(`/resultados/${results[0].id}/boletim`);assert.equal(report.status,200);assert.equal(report.body.nota_geral_dez,10);assert.equal(report.body.redacao.nota_redacao,560);assert.deepEqual(report.body.redacao.competencias_redacao,[200,160,120,80,0]);assert.equal(report.body.redacao.avaliador_redacao,'Professora fictícia');assert.equal(report.body.redacao.situacao_redacao,'Texto válido');assert.equal(report.body.redacao.origem_redacao,'planilha');assert.match(report.body.redacao.feedback_redacao,/Revise a proposta/);
  const zero=await json(`/resultados/${results[1].id}/boletim`);assert.equal(zero.body.redacao.nota_redacao,0);assert.deepEqual(zero.body.redacao.competencias_redacao,[0,0,0,0,0]);assert.equal(zero.body.nota_geral_dez,1.8);
  const beforePdf=(await app.get(DatabaseService).all('SELECT * FROM report_feedback')).length,filesBeforePdf=mediaFiles(process.env.MEDIA_ROOT);
  const pdfResponse=await fetch(`${base}/resultados/${results[0].id}/boletim/pdf`);assert.equal(pdfResponse.status,200);const pdf=Buffer.from(await pdfResponse.arrayBuffer());assert.equal(pdf.subarray(0,5).toString(),'%PDF-');
  const text=textOfPdf(pdf);for(const value of ['000123','560 / 1000','COMPETÊNCIA 1','COMPETÊNCIA 5','0 / 200','Professora fictícia','Revise a proposta'])assert.ok(text.includes(value),value);
  assert.equal((await app.get(DatabaseService).all('SELECT * FROM report_feedback')).length,beforePdf);assert.deepEqual(mediaFiles(process.env.MEDIA_ROOT),filesBeforePdf);
  const response=await fetch(`${base}/simulados/${simuladoId}/exportar`);assert.equal(response.status,200);const exported=new ExcelJS.Workbook();await exported.xlsx.load(Buffer.from(await response.arrayBuffer()));
  const objective=rows(exported.getWorksheet('Resultados_OMR'));assert.equal(objective[0]['Arquivo_Origem'],'arquivo-sem-matriculas.pdf');assert.equal(objective[1]['Pagina_Origem'],2);assert.equal(objective[1]['Fonte_Matricula'],'ocr');
  const essays=rows(exported.getWorksheet('Redacoes'));assert.equal(essays.length,2);assert.equal(essays[0]['Matrícula'],'000123');assert.equal(essays[0]['Competência 5'],0);assert.equal(essays[0]['Nota Redação'],560);assert.equal(essays[0]['Avaliador'],'Professora fictícia');assert.equal(essays[0]['Origem'],'planilha');assert.match(essays[0]['Observações e Feedback'],/Revise a proposta/);assert.equal(essays[1]['Nota Redação'],0);assert.equal(essays[1]['Competência 1'],0);
  assert.equal(app.get(ReportEmailGateway).availability().envio_disponivel,false);
  assert.equal((await app.get(DatabaseService).all('SELECT * FROM report_deliveries')).length,0);assert.equal((await app.get(DatabaseService).all('SELECT * FROM report_access_links')).length,0);
});
