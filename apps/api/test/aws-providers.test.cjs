const {test,beforeEach,afterEach}=require('node:test');
const assert=require('node:assert/strict');
const {Readable}=require('node:stream');
const {SesService}=require('../dist/ses.service');
const {EmailNotSentError}=require('../dist/email-errors');
const {S3Storage}=require('../dist/s3-storage');
const previous={};
beforeEach(()=>{for(const key of ['AWS_REGION','EMAIL_FROM','EMAIL_REPLY_TO','SES_RATE_PER_SECOND','SES_CONFIGURATION_SET','S3_BUCKET','S3_PREFIX'])previous[key]=process.env[key];
  Object.assign(process.env,{AWS_REGION:'us-east-2',EMAIL_FROM:'SIRENIA <boletins@example.test>',EMAIL_REPLY_TO:'teacher@example.test',SES_RATE_PER_SECOND:'100',SES_CONFIGURATION_SET:'sirenia',S3_BUCKET:'private-test-bucket',S3_PREFIX:'sirenia/'});});
afterEach(()=>{for(const [key,value]of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
function ses(send,get=async()=>({next_at:Date.now()})){const service=new SesService({get});service.client={send};return service;}
test('SES envia destinatário individual, texto e HTML UTF-8 e registra MessageId real',async()=>{
  let count=0;
  const result=await ses(async(command,options)=>{count++;assert.deepEqual(command.input.Destination,{ToAddresses:['student@example.test']});assert.equal(command.input.Content.Simple.Body.Text.Data,'Texto');assert.equal(command.input.Content.Simple.Body.Html.Data,'<p>Texto</p>');assert.equal(command.input.ConfigurationSetName,'sirenia');assert.ok(options.abortSignal);return {MessageId:'ses-real-id'};}).send('student@example.test','Boletim','<p>Texto</p>','Texto','op-123');
  assert.equal(result,'ses-real-id');assert.equal(count,1);
});
test('SES rejeita configuração, cabeçalho, destinatário e fila inválidos antes da transmissão',async()=>{
  let calls=0;const service=ses(async()=>{calls++;return {MessageId:'x'};});
  await assert.rejects(service.send('bad','Boletim','html','text'),EmailNotSentError);
  await assert.rejects(service.send('a@example.test','Olá\nBcc: b@example.test','html','text'),EmailNotSentError);
  await assert.rejects(service.send('a@example.test','Olá','x'.repeat(1_000_001),'text'),EmailNotSentError);
  await assert.rejects(ses(async()=>{calls++;},async()=>undefined).send('a@example.test','Olá','html','text'),EmailNotSentError);
  process.env.EMAIL_FROM='invalido';await assert.rejects(service.send('a@example.test','Olá','html','text'),EmailNotSentError);
  assert.equal(calls,0);
});
test('SES não repete recusas, timeout, 5xx ou resposta sem MessageId; incerteza permanece ambígua',async()=>{
  for(const [error,safe]of [[{$metadata:{httpStatusCode:429}},true],[{$metadata:{httpStatusCode:403}},true],[{name:'CredentialsProviderError'},true],[{name:'TimeoutError'},false],[{$metadata:{httpStatusCode:503}},false]]) {
    let calls=0;await assert.rejects(ses(async()=>{calls++;throw error;}).send('a@example.test','Olá','html','text'),e=>(e instanceof EmailNotSentError)===safe);assert.equal(calls,1);
  }
  await assert.rejects(ses(async()=>({})).send('a@example.test','Olá','html','text'),e=>!(e instanceof EmailNotSentError));
});
function s3(send){const service=new S3Storage();service.client={send};return service;}
const privateBlock={PublicAccessBlockConfiguration:{BlockPublicAcls:true,IgnorePublicAcls:true,BlockPublicPolicy:true,RestrictPublicBuckets:true}};
test('S3 recusa bucket sem os quatro bloqueios públicos e caminhos fora do prefixo',async()=>{
  let calls=0;const service=s3(async()=>{calls++;return {};});
  await assert.rejects(service.put('x.png',Buffer.from('x'),'image/png'),/quatro bloqueios/);
  await assert.rejects(service.remove('../other/file'),/Identificador/);assert.equal(calls,1);
});
test('S3 guarda somente no prefixo dedicado, criptografa e impede sobrescrita',async()=>{
  const calls=[];const service=s3(async(command)=>{calls.push(command);return privateBlock;});
  await service.put('debug/a.png',Buffer.from('fixture'),'image/png');
  assert.equal(calls[1].input.Key,'sirenia/debug/a.png');assert.equal(calls[1].input.IfNoneMatch,'*');assert.equal(calls[1].input.ServerSideEncryption,'AES256');
  await service.remove('debug/a.png');assert.equal(calls[2].input.Key,'sirenia/debug/a.png');
});
test('S3 limita o conteúdo também quando Content-Length falta ou está incorreto',async()=>{
  let stream;const service=s3(async(command)=>{if(command.constructor.name==='GetPublicAccessBlockCommand')return privateBlock;stream=Readable.from([Buffer.alloc(6),Buffer.alloc(6)]);return {Body:stream,ContentLength:0,ContentType:'image/png'};});
  await assert.rejects(service.get('x.png',10),/tamanho/);assert.ok(stream.destroyed);
});
