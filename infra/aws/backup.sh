#!/usr/bin/env bash
set -euo pipefail
project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$project_dir"
env_file=infra/aws/runtime/.env
bucket="$(sed -n 's/^S3_BUCKET=//p' "$env_file")"
prefix="$(sed -n 's/^S3_PREFIX=//p' "$env_file")"
region="$(sed -n 's/^S3_REGION=//p' "$env_file")"
[[ "$bucket" =~ ^[a-z0-9][a-z0-9.-]+[a-z0-9]$ && "$prefix" =~ ^[a-zA-Z0-9_-]+/$ ]] || { echo 'Bucket/prefixo inválido.' >&2; exit 1; }
key="${prefix}backups/$(date -u +%Y-%m-%dT%H-%M-%SZ).dump"
# Não grava um dump em texto no disco nem inclui credenciais nos argumentos.
docker compose --env-file "$env_file" -f infra/aws/compose.yaml exec -T db \
  pg_dump -U postgres -d sirenia --format=custom --no-acl \
  | aws s3 cp - "s3://${bucket}/${key}" --region "$region" --sse AES256 --only-show-errors
echo "Backup criptografado salvo em s3://${bucket}/${key}"
