#!/usr/bin/env node
// Migração explícita dos registros antigos. Sem --apply, apenas apresenta a prévia.
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import dotenv from 'dotenv';
import pg from 'pg';
const args=process.argv.slice(2);
const arg=name=>args[args.indexOf(name)+1];
if(!args.includes('--email') || !args.includes('--days')) throw Error('Informe --email da conta existente e --days entre 1 e 365. Use --apply após revisar a prévia.');
const email=arg('--email').trim().toLowerCase(),days=Number(arg('--days'));
if(!Number.isInteger(days)||days<1||days>365) throw Error('Prazo inválido.');
const env={...dotenv.parse(readFileSync(resolve(args.includes('--env')?arg('--env'):'.env.cloud'))),...process.env};
if(!env.DATABASE_URL||!env.SUPABASE_URL||!env.SUPABASE_SERVICE_ROLE_KEY) throw Error('Configure a conexão de servidor e o Supabase Auth.');
const response=await fetch(env.SUPABASE_URL+'/auth/v1/admin/users?page=1&per_page=1000',{headers:{apikey:env.SUPABASE_SERVICE_ROLE_KEY,Authorization:'Bearer '+env.SUPABASE_SERVICE_ROLE_KEY},signal:AbortSignal.timeout(10000)});
if(!response.ok) throw Error('Não foi possível validar o proprietário.');
const owner=(await response.json()).users.find(user=>user.email?.toLowerCase()===email);
if(!owner?.email_confirmed_at || !/^[0-9a-f-]{36}$/i.test(owner.id)) throw Error('A conta proprietária precisa existir e ter e-mail confirmado.');
const ca=env.DATABASE_SSL_CA_BASE64?Buffer.from(env.DATABASE_SSL_CA_BASE64,'base64').toString():env.DATABASE_SSL_CA;
const pool=new pg.Pool({connectionString:env.DATABASE_URL,max:1,ssl:env.DATABASE_SSL==='false'?false:{rejectUnauthorized:true,...(ca?{ca}: {})}});
const client=await pool.connect();
function expiry(value) {
  const text=String(value);const date=Date.parse(text.includes('T')?text:text.replace(' ','T')+'Z');
  if(!Number.isFinite(date)) throw Error('Há datas legadas inválidas; a migração foi interrompida.');
  return new Date(date+days*86400_000).toISOString();
}
try {
  if(!args.includes('--apply')) {
    const columns=(await client.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='core_simulado'")).rows.map(row=>row.column_name);
    const simulations=(await client.query('SELECT * FROM core_simulado'+(columns.includes('owner_id')?" WHERE owner_id=''":''))).rows;
    console.log(JSON.stringify({modo:'previa',proprietario:email,retencao_dias:days,simulados:simulations.map(row=>({id:row.id,titulo:row.titulo,expira_em:expiry(row.data_criacao)})),nenhum_dado_alterado:true},null,2));
  } else {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(593617205)');
    const tables=(await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows.map(row=>row.tablename);
    const backup={criado_em:new Date().toISOString(),tables:{}};
    for(const name of tables) {
      if(!/^[a-z_]+$/.test(name)) throw Error('Tabela inesperada.');
      backup.tables[name]=(await client.query('SELECT * FROM public.'+name)).rows;
    }
    const directory=resolve('backups');mkdirSync(directory,{recursive:true,mode:0o700});
    writeFileSync(resolve(directory,'before-account-migration-'+randomUUID()+'.json'),JSON.stringify(backup),{mode:0o600});
    await client.query(readFileSync(resolve('infra/sql/001-schema.sql'),'utf8'));
    const simulations=(await client.query("SELECT id,data_criacao FROM core_simulado WHERE owner_id='' FOR UPDATE")).rows;
    const contacts=(await client.query("SELECT matricula,atualizado_em FROM student_contacts WHERE owner_id='' FOR UPDATE")).rows;
    for(const row of simulations) await client.query("UPDATE core_simulado SET owner_id=$1,expira_em=$2 WHERE id=$3 AND owner_id=''",[owner.id,expiry(row.data_criacao),row.id]);
    for(const row of contacts) await client.query("UPDATE student_contacts SET owner_id=$1,expira_em=$2 WHERE matricula=$3 AND owner_id=''",[owner.id,expiry(row.atualizado_em),row.matricula]);
    await client.query("UPDATE uploaded_files SET owner_id=$1 WHERE owner_id=''",[owner.id]);
    await client.query("UPDATE contacts_import_plans SET owner_id=$1 WHERE owner_id=''",[owner.id]);
    await client.query('COMMIT');
    console.log(JSON.stringify({modo:'aplicado',proprietario:email,retencao_dias:days,simulados_atribuidos:simulations.length,contatos_atribuidos:contacts.length,backup_privado:true}));
  }
} catch(error) {await client.query('ROLLBACK').catch(()=>{});throw error;}
finally {client.release();await pool.end();}
