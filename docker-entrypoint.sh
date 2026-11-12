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
#
# Banco (R35.1): com DATABASE_URL_MIGRACAO (o dono do banco) e BANCO_APP_SENHA,
# as migrations e o papel da aplicação (BANCO_APP_USUARIO, padrão crmbrl_app)
# são feitos pelo dono, e a API e o gateway conectam pela DATABASE_URL (o papel
# da aplicação: só DML, com RLS). Sem BANCO_APP_SENHA, tudo continua pelo dono,
# como antes (a API avisa no log e na Saúde do sistema). As variáveis do dono e
# a senha não passam para os processos Node.
set -eu

if [ -n "${DATABASE_URL_MIGRACAO:-}" ] && [ -z "${BANCO_APP_SENHA:-}" ]; then
  echo "docker-entrypoint: BANCO_APP_SENHA não definida — a API conecta com o dono do banco (sem o papel próprio nem a RLS valendo)." >&2
  DATABASE_URL="$DATABASE_URL_MIGRACAO"
  export DATABASE_URL
fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo "docker-entrypoint: DATABASE_URL não definida (ex.: postgresql://crmbrl_app:<senha>@banco:5432/crmbrl?schema=public)." >&2
  exit 1
fi

if [ "${1:-}" = "whatsapp" ]; then
  shift
  echo "docker-entrypoint: iniciando o gateway de WhatsApp..."
  exec env -u DATABASE_URL_MIGRACAO -u BANCO_APP_SENHA node dist/whatsapp/main.js "$@"
fi

if [ "${1:-}" = "api" ]; then
  shift
fi

if [ "${MIGRAR_AO_INICIAR:-true}" != "false" ]; then
  # prisma.config.ts usa DATABASE_URL_MIGRACAO quando existe (o dono).
  echo "docker-entrypoint: aplicando migrations pendentes (prisma migrate deploy)..."
  ./node_modules/.bin/prisma migrate deploy
  if [ -n "${DATABASE_URL_MIGRACAO:-}" ] && [ -n "${BANCO_APP_SENHA:-}" ]; then
    echo "docker-entrypoint: preparando o papel da aplicação no banco..."
    node dist/banco/preparar-banco.js
  fi
else
  echo "docker-entrypoint: MIGRAR_AO_INICIAR=false — migrations e papel da aplicação não aplicados."
fi

exec env -u DATABASE_URL_MIGRACAO -u BANCO_APP_SENHA node dist/main.js "$@"
