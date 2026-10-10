import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { config } from 'dotenv';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
config({path: resolve(root, '.env'), quiet: true});
const dev = process.argv.includes('--dev');
const webPort = process.env.WEB_PORT || '3000';
const apiPort = process.env.API_PORT || '3001';
const python = resolve(root, process.env.PYTHON_EXECUTABLE || 'venv/bin/python');
if (!existsSync(python)) {
  console.error('Crie o ambiente Python e instale python/requirements.txt antes de iniciar.');
  process.exit(1);
}
if (!existsSync(resolve(root, 'apps/api/dist/main.js'))) {
  console.error('Execute npm run build antes de iniciar.');
  process.exit(1);
}
const children = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 1000).unref();
}
function start(name, command, args, cwd) {
  const child = spawn(command, args, {cwd, stdio: 'inherit', env: {...process.env, API_BASE_URL: `http://127.0.0.1:${apiPort}`}});
  children.push(child);
  child.on('error', error => { console.error(`${name}: ${error.message}`); stop(1); });
  child.on('exit', code => { if (!stopping) { console.error(`${name} encerrou.`); stop(code || 1); } });
}
console.log(`Interface Next.js: http://localhost:${webPort}\nAPI NestJS: http://127.0.0.1:${apiPort}/api`);
start('NestJS', process.execPath, dev ? ['--watch', 'apps/api/dist/main.js'] : ['apps/api/dist/main.js'], root);
if (dev) start('TypeScript', resolve(root, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.json', '--watch', '--preserveWatchOutput'], resolve(root, 'apps/api'));
start('Next.js', process.execPath, [resolve(root, 'node_modules/next/dist/bin/next'), dev ? 'dev' : 'start', '--hostname', '127.0.0.1', '--port', webPort], resolve(root, 'apps/web'));
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
