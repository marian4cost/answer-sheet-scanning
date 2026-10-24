import {parse} from 'dotenv';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const apply=process.argv.includes('--apply');
const source=parse(await readFile('.env'));
const target=parse(await readFile('infra/aws/runtime/.env'));
if(!source.SUPABASE_URL || !source.SUPABASE_SERVICE_ROLE_KEY || !target.S3_BUCKET)throw Error('Configure origem e destino.');
Object.assign(process.env,{AWS_REGION:target.AWS_REGION,S3_REGION:target.S3_REGION,S3_BUCKET:target.S3_BUCKET,S3_PREFIX:target.S3_PREFIX});
const {S3Storage}=await import('../apps/api/dist/s3-storage.js');const storage=new S3Storage();
const bucket=encodeURIComponent(source.SUPABASE_STORAGE_BUCKET||'omr-private');
async function request(path,body){const result=await fetch(source.SUPABASE_URL+'/storage/v1/'+path,{method:body?'POST':'GET',headers:{apikey:source.SUPABASE_SERVICE_ROLE_KEY,Authorization:'Bearer '+source.SUPABASE_SERVICE_ROLE_KEY,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(30000)});if(!result.ok)throw Error('Storage de origem HTTP '+result.status);return result;}
const keys=[];
async function walk(prefix=''){for(let offset=0;;offset+=1000){const list=await(await request('object/list/'+bucket,{prefix,limit:1000,offset,sortBy:{column:'name',order:'asc'}})).json();if(!Array.isArray(list))throw Error('Lista inválida.');for(const item of list){const key=prefix?prefix+'/'+item.name:item.name;if(!item.id)await walk(key);else keys.push(key);}if(list.length<1000)return;}}
await walk();console.log(keys.length+' objetos privados encontrados.');
const digest=buffer=>createHash('sha256').update(buffer).digest('hex');let copied=0;
if(apply)for(const key of keys){
  const encoded=key.split('/').map(encodeURIComponent).join('/');const response=await request('object/authenticated/'+bucket+'/'+encoded);
  if(Number(response.headers.get('content-length')||0)>50*1024*1024)throw Error('Objeto excede o limite da migração.');
  const buffer=Buffer.from(await response.arrayBuffer());if(buffer.length>50*1024*1024)throw Error('Objeto excede o limite.');
  let existing;try{existing=await storage.get(key,buffer.length);}catch(error){if(error?.getStatus?.()!==404)throw error;}
  if(existing){if(digest(existing.buffer)!==digest(buffer))throw Error('O destino contém objeto diferente; migração interrompida sem sobrescrever.');}
  else await storage.put(key,buffer,response.headers.get('content-type')||'application/octet-stream');
  const check=await storage.get(key,buffer.length);if(digest(check.buffer)!==digest(buffer))throw Error('Hash divergente.');copied++;
}
console.log(apply?copied+' objetos conferidos por SHA-256.':'Prévia sem alterações. Use --apply para copiar; a origem será preservada.');
