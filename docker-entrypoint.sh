#!/bin/sh
# Ponto de entrada do container da crmbrl-api.
#
# 1. Aplica as migrations pendentes (prisma migrate deploy), a menos que
#    MIGRAR_AO_INICIAR=false. Se falhar, o container para: subir a API com o
#    banco fora do schema esperado só esconderia o problema.
# 2. Troca este processo pelo Node (exec), que recebe os sinais de parada.
set -eu

if [ -z "${DATABASE_URL:-}" ]; then
  echo "docker-entrypoint: DATABASE_URL não definida (ex.: postgresql://crmbrl:crmbrl@banco:5432/crmbrl?schema=public)." >&2
  exit 1
fi

if [ "${MIGRAR_AO_INICIAR:-true}" != "false" ]; then
  echo "docker-entrypoint: aplicando migrations pendentes (prisma migrate deploy)..."
  ./node_modules/.bin/prisma migrate deploy
else
  echo "docker-entrypoint: MIGRAR_AO_INICIAR=false — migrations não aplicadas."
fi

exec node dist/main.js "$@"
