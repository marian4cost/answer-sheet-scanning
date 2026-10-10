#!/usr/bin/env bash
set -euo pipefail
PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR"
if [[ ! -d node_modules ]]; then
    echo "Instale as dependências com npm ci."
    exit 1
fi
if [[ ! -f apps/web/.next/BUILD_ID || ! -f apps/api/dist/main.js ]]; then
    npm run build
fi
exec npm start
