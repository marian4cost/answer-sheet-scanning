#!/usr/bin/env bash
# Smoke test isolado: sem portas públicas, volumes ou acesso a serviços externos.
set -euo pipefail
service="${1:?Informe api ou web}"
image="${2:?Informe a imagem de teste}"
case "$service" in api|web) ;; *) echo 'Serviço inválido.' >&2; exit 2 ;; esac
container_id=''
cleanup() {
  result=$?
  if [[ -n "$container_id" ]]; then
    if [[ "$result" -ne 0 ]]; then docker logs --tail=100 "$container_id" >&2 || true; fi
    docker rm --force "$container_id" >/dev/null || true
  fi
  exit "$result"
}
trap cleanup EXIT
user="$(docker image inspect "$image" --format '{{.Config.User}}')"
[[ -n "$user" && "$user" != root && "$user" != 0 && "$user" != 0:* ]] || { echo 'A imagem precisa executar sem root.' >&2; exit 1; }
options=(--detach --network none --read-only --cpus 2 --memory 1g --memory-swap 1g
  --cap-drop ALL --security-opt no-new-privileges:true
  --label org.sirenia.purpose=ci-smoke
  --tmpfs /tmp:rw,nosuid,size=128m,mode=1777)
if [[ "$service" == api ]]; then
  options+=(-e DATABASE_URL= -e DATABASE_PATH=/tmp/sirenia-ci.sqlite3 -e MEDIA_ROOT=/tmp/sirenia-media
    -e STORAGE_MODE=local -e OMR_REMOTE_URL= -e WEB_URL=https://sirenia.morea-ifs.org
    -e CORS_ORIGINS=https://sirenia.morea-ifs.org)
fi
container_id="$(docker run "${options[@]}" "$image")"
docker exec -e TEST_SERVICE="$service" -i "$container_id" node <<'NODE'
const assert = require('node:assert/strict');
const fs = require('node:fs');
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
(async () => {
  for (const path of ['/app/.env', '/app/infra/aws/runtime/.env', '/app/.git', '/app/db.sqlite3']) {
    assert.equal(fs.existsSync(path), false, 'Arquivo privado incluído na imagem: ' + path);
  }
  const api = process.env.TEST_SERVICE === 'api';
  const base = 'http://127.0.0.1:' + (api ? '3001' : '3000');
  let response;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      response = await fetch(base + (api ? '/api/health' : '/login'), {signal: AbortSignal.timeout(5000)});
      if (response.ok) break;
    } catch { /* Aguarda somente a inicialização do contêiner criado pelo teste. */ }
    await delay(1000);
  }
  assert.ok(response?.ok, 'A aplicação empacotada não ficou pronta.');
  if (api) {
    const health = await response.json();
    assert.equal(health.backend, 'NestJS');
    assert.equal(health.database, 'ok');
    assert.equal(health.processor.ok, true);
    assert.equal(health.processor.pdf_engine, 'PDFium');
    const config = await (await fetch(base + '/api/auth/config')).json();
    assert.equal(config.required, true);
    assert.equal(config.registration_enabled, false);
    assert.equal((await fetch(base + '/api/simulados')).status, 401);
    const {assetPath} = require('/app/apps/api/dist/assets.js');
    for (const file of ['schema.sql', 'report-fonts/OpenSans-Regular.ttf', 'report-fonts/OpenSans-Bold.ttf']) {
      assert.ok(fs.statSync(assetPath(file)).size > 0, 'Recurso ausente: ' + file);
    }
    const headers = {'Content-Type': 'application/json', 'X-OMR-Client': 'web', Origin: 'https://sirenia.morea-ifs.org'};
    const publicReport = await fetch(base + '/api/boletim/consultar', {method: 'POST', headers, body: JSON.stringify({token: 'invalid'})});
    assert.equal(publicReport.status, 410, 'Origem autorizada deve alcançar a validação do token.');
    const rejected = await fetch(base + '/api/boletim/consultar', {method: 'POST', headers: {...headers, Origin: 'https://untrusted.example'}, body: JSON.stringify({token: 'invalid'})});
    assert.equal(rejected.status, 403);
    console.log('PASS: NestJS, SQLite temporário, OpenCV/PDFium, recursos PDF e proteção de acesso/origem dentro da imagem.');
  } else {
    assert.match(response.headers.get('content-type') || '', /text\/html/);
    assert.match(await response.text(), /SIRENIA/);
    console.log('PASS: servidor Next.js standalone inicia e serve o login dentro da imagem.');
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
NODE
