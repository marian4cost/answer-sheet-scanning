// Cópia de dados restrita às tabelas do SIRENIA e às contas. Não copia roles,
// sessões, configurações internas ou triggers do Supabase gerenciado.
import {Pool} from 'pg';
import {readFile} from 'node:fs/promises';
import {parse} from 'dotenv';
const args=process.argv.slice(2),apply=args.includes('--apply');
const option=(name,fallback)=>{const index=args.indexOf(name);return index<0?fallback:args[index+1];};
const source=parse(await readFile(option('--source-env','.env')));
const target=parse(await readFile(option('--target-env','infra/aws/runtime/migration.env')));
if(!source.DATABASE_URL || !target.DATABASE_URL || source.DATABASE_URL===target.DATABASE_URL)throw Error('Configure duas conexões diferentes. Nenhuma credencial deve ser passada no argumento do comando.');
function pool(env){return new Pool({connectionString:env.DATABASE_URL,max:1,connectionTimeoutMillis:15000,...(env.DATABASE_SSL==='true'?{ssl:{rejectUnauthorized:true,...(env.DATABASE_SSL_CA_BASE64?{ca:Buffer.from(env.DATABASE_SSL_CA_BASE64,'base64').toString()}: {})}}:{})});}
const a=pool(source),b=pool(target),src=await a.connect(),dst=await b.connect();
const tables=['auth.users','auth.identities',
  'public.core_simulado','public.core_lotecorrecao','public.core_resultadoaluno','public.student_contacts','public.report_feedback',
  'public.report_deliveries','public.report_delivery_plans','public.contacts_import_plans','public.uploaded_files','public.essay_import_plans',
  'public.report_access_links','public.proof_import_plans','public.proof_import_pages','public.storage_deletions','public.account_admin_locks',
  'public.answer_review_events','public.simulado_shares'];
const quote=value=>'"'+value.replaceAll('"','""')+'"';
const qualified=table=>table.split('.').map(quote).join('.');
async function columns(client,table){const [schema,name]=table.split('.');return (await client.query('SELECT column_name,is_generated,data_type FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 ORDER BY ordinal_position',[schema,name])).rows;}
try {
  await src.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await dst.query('BEGIN');await dst.query('SELECT pg_advisory_xact_lock(593617206)');
  // MFA exige migrar seus fatores com procedimento próprio; não reduzir sua segurança.
  const mfa=await src.query("SELECT count(*)::int total FROM auth.mfa_factors WHERE status='verified'");
  if(mfa.rows[0].total)throw Error('Há contas com MFA. Prepare a migração dos fatores antes de copiar.');
  const snapshots=[];
  for(const table of tables){
    const sourceCols=await columns(src,table),targetCols=await columns(dst,table);
    if(!sourceCols.length || !targetCols.length)throw Error('Tabela ausente: '+table);
    const writable=targetCols.filter(c=>c.is_generated==='NEVER'),names=new Set(writable.map(c=>c.column_name));
    const selected=sourceCols.filter(c=>names.has(c.column_name));
    const missing=sourceCols.filter(c=>!targetCols.some(t=>t.column_name===c.column_name));
    if(missing.length)throw Error('Diferença de schema em '+table+': '+missing.map(c=>c.column_name).join(', '));
    const rows=(await src.query('SELECT '+selected.map(c=>quote(c.column_name)).join(',')+' FROM '+qualified(table))).rows;
    const count=(await dst.query('SELECT count(*)::int total FROM '+qualified(table))).rows[0].total;
    // Única linha criada pelo schema da aplicação: o lock de administração.
    if(count && table!=='public.account_admin_locks')throw Error('Destino precisa estar vazio: '+table);
    snapshots.push({table,cols:selected,rows});console.log(table+': '+rows.length+' registros');
  }
  if(apply){
    for(const snapshot of snapshots){
      const {table,cols,rows}=snapshot;if(table==='public.account_admin_locks')await dst.query('DELETE FROM public.account_admin_locks');
      for(const row of rows){
        const values=cols.map(c=>{const value=row[c.column_name];return value!==null && ['json','jsonb'].includes(c.data_type)?JSON.stringify(value):value;});
        await dst.query('INSERT INTO '+qualified(table)+' ('+cols.map(c=>quote(c.column_name)).join(',')+') VALUES ('+cols.map((_,i)=>'$'+(i+1)).join(',')+')',values);
      }
      const actual=(await dst.query('SELECT count(*)::int total FROM '+qualified(table))).rows[0].total;
      if(actual!==rows.length)throw Error('Contagem divergente: '+table);
      // Ajusta sequências somente quando a coluna é serial, preservando UUIDs.
      for(const col of cols){const serial=(await dst.query('SELECT pg_get_serial_sequence($1,$2) name',[table,col.column_name])).rows[0].name;
        if(serial)await dst.query('SELECT setval($1,COALESCE((SELECT MAX('+quote(col.column_name)+') FROM '+qualified(table)+'),1),EXISTS(SELECT 1 FROM '+qualified(table)+'))',[serial]);}
    }
    const before=(await src.query('SELECT id,email,encrypted_password,raw_app_meta_data,banned_until FROM auth.users ORDER BY id')).rows;
    const after=(await dst.query('SELECT id,email,encrypted_password,raw_app_meta_data,banned_until FROM auth.users ORDER BY id')).rows;
    if(JSON.stringify(before)!==JSON.stringify(after))throw Error('Contas, senhas ou permissões divergentes; rollback aplicado.');
    await dst.query('COMMIT');console.log('Migração confirmada: IDs, hashes de senha, roles e contagens preservados.');
  } else {await dst.query('ROLLBACK');console.log('Prévia concluída, sem alterações. Use --apply somente durante a janela de manutenção.');}
  await src.query('ROLLBACK');
} catch(error) {
  await dst.query('ROLLBACK').catch(()=>{});await src.query('ROLLBACK').catch(()=>{});
  // Não imprime row/parameters do PostgreSQL, que podem conter dados privados.
  console.error(error instanceof Error ? error.message : 'Falha na migração.');process.exitCode=1;
} finally {src.release();dst.release();await Promise.all([a.end(),b.end()]);}
