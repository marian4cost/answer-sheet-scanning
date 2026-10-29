import {randomBytes,createHmac} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const directory=fileURLToPath(new URL('./runtime/',import.meta.url));
await mkdir(directory,{recursive:true,mode:0o700});
const secret=randomBytes(48).toString('hex');
function jwt(role) {
  const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
  const data=encode({alg:'HS256',typ:'JWT'})+'.'+encode({iss:'sirenia',role,iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+10*365*86400});
  return data+'.'+createHmac('sha256',secret).update(data).digest('base64url');
}
const env={POSTGRES_PASSWORD:randomBytes(32).toString('hex'),APP_DB_PASSWORD:randomBytes(32).toString('hex'),AUTH_DB_PASSWORD:randomBytes(32).toString('hex'),
  AUTH_JWT_SECRET:secret,SUPABASE_ANON_KEY:jwt('anon'),SUPABASE_SERVICE_ROLE_KEY:jwt('service_role'),
  CRON_SECRET:randomBytes(32).toString('hex'),
  WEB_URL:'https://sirenia.mage.dev.br',CORS_ORIGINS:'https://sirenia.mage.dev.br',
  AWS_REGION:'us-east-2',S3_REGION:'us-east-1',S3_BUCKET:'morea',S3_PREFIX:'sirenia/',STORAGE_MODE:'s3',EMAIL_PROVIDER:'ses',
  EMAIL_FROM:'SIRENIA <boletins@mage.dev.br>',EMAIL_REPLY_TO:'officegenisson@gmail.com',SES_CONFIGURATION_SET:'sirenia',SES_RATE_PER_SECOND:'1',
  REPORT_INSTITUTION:'Instituto Federal de Sergipe - Campus Lagarto',DATA_RETENTION_DAYS:'30',REPORT_LINK_TTL_DAYS:'30'};
await writeFile(directory+'.env',Object.entries(env).map(([k,v])=>`${k}=${v}`).join('\n')+'\n',{mode:0o600,flag:'wx'});
console.log('infra/aws/runtime/.env criado com segredos aleatórios. O arquivo existente nunca é sobrescrito.');
