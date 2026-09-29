#!/usr/bin/env bash
# scripts/verify.sh
# Lo mismo que correrá la CI: lint, typecheck, tests y build, en ese orden.
# Requiere el Postgres del docker-compose de atencion-ia-database levantado.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "=== 1/4 lint (eslint + prettier) ===" && npm run lint
echo "=== 2/4 typecheck ===" && npm run typecheck
echo "=== 3/4 tests ===" && npm test
echo "=== 4/4 build ===" && npm run build
echo "Verificación completa: todo en orden."
