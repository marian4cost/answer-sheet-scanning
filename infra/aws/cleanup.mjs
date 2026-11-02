import {setTimeout as delay} from 'node:timers/promises';
const secret=process.env.CRON_SECRET;
if(!secret || secret.length<32) throw Error('Configure CRON_SECRET.');
while(true) {
  try {
    const result=await fetch('http://api:3001/api/boletim/limpar',{headers:{Authorization:'Bearer '+secret},signal:AbortSignal.timeout(120_000)});
    if(!result.ok) throw Error('HTTP '+result.status);
    console.log(new Date().toISOString(),'Limpeza concluída.');
  } catch {console.error(new Date().toISOString(),'Limpeza falhou; nova tentativa no próximo intervalo.');}
  await delay(6*60*60*1000);
}
