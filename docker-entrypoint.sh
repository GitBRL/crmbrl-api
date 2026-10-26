#!/bin/sh
# Ponto de entrada do container da crmbrl-api. A mesma imagem roda dois
# processos, escolhidos pelo primeiro argumento (o `command` do compose):
#
#   (nenhum) ou "api"  a API HTTP:
#     1. aplica as migrations pendentes (prisma migrate deploy), a menos que
#        MIGRAR_AO_INICIAR=false. Se falhar, o container para: subir a API com
#        o banco fora do schema esperado só esconderia o problema;
#     2. troca este processo pelo Node (exec), que recebe os sinais de parada.
#   "whatsapp"         o gateway de WhatsApp (node dist/whatsapp/main.js). Não
#                      aplica migrations: sobe depois que a API está saudável.
set -eu

if [ -z "${DATABASE_URL:-}" ]; then
  echo "docker-entrypoint: DATABASE_URL não definida (ex.: postgresql://crmbrl:crmbrl@banco:5432/crmbrl?schema=public)." >&2
  exit 1
fi

if [ "${1:-}" = "whatsapp" ]; then
  shift
  echo "docker-entrypoint: iniciando o gateway de WhatsApp..."
  exec node dist/whatsapp/main.js "$@"
fi

if [ "${1:-}" = "api" ]; then
  shift
fi

if [ "${MIGRAR_AO_INICIAR:-true}" != "false" ]; then
  echo "docker-entrypoint: aplicando migrations pendentes (prisma migrate deploy)..."
  ./node_modules/.bin/prisma migrate deploy
else
  echo "docker-entrypoint: MIGRAR_AO_INICIAR=false — migrations não aplicadas."
fi

exec node dist/main.js "$@"
