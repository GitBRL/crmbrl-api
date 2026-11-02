#!/bin/sh
# Restaura um dump do serviço de backup (formato custom, crmbrl-AAAAMMDD-HHMMSS.dump) num banco.
#
#   restaurar-backup.sh ARQUIVO.dump [--banco NOME] [--substituir] [--sim] [--comparar BANCO_DE_ORIGEM]
#
#   --banco NOME        banco de destino (padrão: <PGDATABASE>_restaurado). Sem --substituir, ele NÃO pode existir.
#   --substituir        apaga o banco de destino (se existir) e o recria. Para restaurar sobre o banco em uso,
#                       PARE a API e o gateway antes (docker compose stop api whatsapp web).
#   --sim               não pergunta a confirmação do --substituir (uso em scripts).
#   --comparar ORIGEM   depois de restaurar, compara a contagem de linhas de cada tabela com a do banco ORIGEM.
#
# Conexão: PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE (padrão do compose: banco, 5432, crmbrl, crmbrl).
# Precisa de psql, pg_restore e createdb/dropdb (versão 17): rode dentro de um container postgres:17-alpine
# (passo a passo em docs/DEPLOY.md, "Restauração") ou numa máquina com o cliente do PostgreSQL 17.
# Códigos de saída: 0 ok · 1 falha na restauração ou contagens diferentes · 2 uso incorreto.
set -eu

export PGHOST="${PGHOST:-banco}" PGPORT="${PGPORT:-5432}" PGUSER="${PGUSER:-crmbrl}"
BASE="${PGDATABASE:-crmbrl}"

uso() { sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }
falhar() { echo "restaurar-backup: $*" >&2; exit 1; }

ARQUIVO="" DESTINO="" SUBSTITUIR=false SIM=false ORIGEM=""
while [ $# -gt 0 ]; do
  case "$1" in
    --banco) [ $# -ge 2 ] || uso; DESTINO="$2"; shift 2 ;;
    --substituir) SUBSTITUIR=true; shift ;;
    --sim) SIM=true; shift ;;
    --comparar) [ $# -ge 2 ] || uso; ORIGEM="$2"; shift 2 ;;
    -h | --help) uso ;;
    -*) echo "opção desconhecida: $1" >&2; uso ;;
    *) [ -z "$ARQUIVO" ] || uso; ARQUIVO="$1"; shift ;;
  esac
done
[ -n "$ARQUIVO" ] || uso
DESTINO="${DESTINO:-${BASE}_restaurado}"
case "$DESTINO" in *[!a-zA-Z0-9_]* | '') echo "nome de banco inválido: use letras, dígitos e _." >&2; exit 2 ;;
esac

echo "1/5 conferindo o arquivo $ARQUIVO"
[ -f "$ARQUIVO" ] || falhar "arquivo não encontrado: $ARQUIVO"
pg_restore --list "$ARQUIVO" > /dev/null || falhar "o arquivo não é um dump válido (formato custom do pg_dump)."

echo "2/5 conferindo a conexão com $PGHOST:$PGPORT"
psql -d postgres -tAc 'select 1' > /dev/null || falhar "não conectou ao PostgreSQL (confira PGHOST, PGPORT, PGUSER e PGPASSWORD)."
existe="$(psql -d postgres -tAc "select 1 from pg_database where datname = '$DESTINO'")"

echo "3/5 preparando o banco de destino \"$DESTINO\""
if [ -n "$existe" ]; then
  [ "$SUBSTITUIR" = true ] || falhar "o banco \"$DESTINO\" já existe. Use --banco com outro nome ou --substituir."
  if [ "$SIM" != true ]; then
    printf 'ATENÇÃO: o banco "%s" em %s será APAGADO e recriado a partir do backup. Digite SIM para continuar: ' "$DESTINO" "$PGHOST"
    read -r resposta
    [ "$resposta" = "SIM" ] || falhar "cancelado."
  fi
  psql -d postgres -qc "select pg_terminate_backend(pid) from pg_stat_activity where datname = '$DESTINO' and pid <> pg_backend_pid()" > /dev/null
  dropdb "$DESTINO"
fi
createdb "$DESTINO"

echo "4/5 restaurando (pode demorar conforme o tamanho)"
pg_restore --no-owner --no-privileges --exit-on-error -d "$DESTINO" "$ARQUIVO" || falhar "pg_restore falhou; o banco \"$DESTINO\" ficou incompleto."

contar() { # banco -> "tabela contagem" por linha
  psql -d "$1" -tAF ' ' -c "select table_schema || '.' || table_name, (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text from information_schema.tables where table_type = 'BASE TABLE' and table_schema not in ('pg_catalog', 'information_schema') order by 1"
}

echo "5/5 contagem de linhas do banco restaurado"
contar "$DESTINO" > "${TMPDIR:-/tmp}/restaurado.$$"
tabelas="$(wc -l < "${TMPDIR:-/tmp}/restaurado.$$")"
total="$(awk '{ soma += $2 } END { print soma + 0 }' "${TMPDIR:-/tmp}/restaurado.$$")"
echo "    $tabelas tabela(s), $total linha(s) no total"

if [ -n "$ORIGEM" ]; then
  contar "$ORIGEM" > "${TMPDIR:-/tmp}/origem.$$"
  if diff "${TMPDIR:-/tmp}/origem.$$" "${TMPDIR:-/tmp}/restaurado.$$" > "${TMPDIR:-/tmp}/dif.$$"; then
    echo "    contagens IGUAIS às do banco \"$ORIGEM\" em todas as tabelas."
  else
    echo "    contagens DIFERENTES do banco \"$ORIGEM\" (< origem, > restaurado):" >&2
    cat "${TMPDIR:-/tmp}/dif.$$" >&2
    echo "    Obs.: se o banco de origem continuou recebendo dados depois do backup, a diferença é esperada." >&2
    rm -f "${TMPDIR:-/tmp}"/*.$$
    exit 1
  fi
fi
rm -f "${TMPDIR:-/tmp}"/*.$$
echo "Restauração concluída no banco \"$DESTINO\"."
