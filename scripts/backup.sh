#!/bin/sh
# Serviço "backup" do compose (imagem postgres:17-alpine): pg_dump diário do banco do CRM no volume
# "backups" (/backups), com retenção por dias. A cada execução escreve /backups/ultimo.json:
#
#   {"inicio":"…","fim":"…","arquivo":"crmbrl-AAAAMMDD-HHMMSS.dump","tamanhoBytes":123,"ok":true,"erro":null}
#
# (datas em ISO 8601, UTC). A API monta o mesmo volume só leitura e mostra o resultado na tela
# "Saúde do sistema". Sem o arquivo, a saúde mostra "nenhum backup registrado".
#
# Uso:  backup.sh            fica rodando: espera o horário e faz um dump por dia
#       backup.sh uma-vez    faz um dump agora e sai (código 0 = ok, 1 = falhou)
#
# Variáveis: BACKUP_DIR (padrão /backups), BACKUP_HORARIO (HH:MM no fuso TZ, padrão 03:00),
# BACKUP_RETENCAO_DIAS (padrão 14), BACKUP_AO_INICIAR (true = faz um dump ao subir o serviço),
# PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE (conexão com o banco; a senha nunca vai para log).
set -u

DIR="${BACKUP_DIR:-/backups}"
HORARIO="${BACKUP_HORARIO:-03:00}"
RETENCAO="${BACKUP_RETENCAO_DIAS:-14}"
export PGHOST="${PGHOST:-banco}" PGPORT="${PGPORT:-5432}" PGUSER="${PGUSER:-crmbrl}" PGDATABASE="${PGDATABASE:-crmbrl}"

log() { echo "backup: $(date -u +%Y-%m-%dT%H:%M:%SZ) $*"; }

case "$HORARIO" in
  [01][0-9]:[0-5][0-9] | 2[0-3]:[0-5][0-9]) ;;
  *) echo "backup: BACKUP_HORARIO inválido ($HORARIO): use HH:MM, ex.: 03:00." >&2; exit 2 ;;
esac
case "$RETENCAO" in
  '' | *[!0-9]*) echo "backup: BACKUP_RETENCAO_DIAS inválido ($RETENCAO): use um número de dias (0 = nunca apagar)." >&2; exit 2 ;;
esac

# Texto seguro para dentro de uma string JSON: sem aspas, barras, quebras de linha nem a senha.
json_texto() {
  printf '%s' "$1" | tr '\n\r\t' '   ' | tr -d '"\\' | cut -c1-500
}

escrever_ultimo() { # inicio fim arquivo tamanho ok erro
  if [ "$5" = "true" ]; then erro_json=null; else erro_json="\"$(json_texto "$6")\""; fi
  if [ -n "$3" ]; then arquivo_json="\"$3\""; else arquivo_json=null; fi
  printf '{"inicio":"%s","fim":"%s","arquivo":%s,"tamanhoBytes":%s,"ok":%s,"erro":%s}\n' \
    "$1" "$2" "$arquivo_json" "$4" "$5" "$erro_json" > "$DIR/ultimo.json.tmp" &&
    chmod 644 "$DIR/ultimo.json.tmp" && mv "$DIR/ultimo.json.tmp" "$DIR/ultimo.json"
}

fazer_backup() {
  inicio="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  nome="crmbrl-$(date -u +%Y%m%d-%H%M%S).dump"
  parcial="$DIR/$nome.parcial"
  mkdir -p "$DIR"
  log "iniciando dump em $nome"
  # Formato custom (-Fc): compactado e restaurável com pg_restore, inclusive por partes.
  # umask 077: o dump (dados de clientes) só o root do serviço lê; ultimo.json fica legível.
  if erro="$( (umask 077; pg_dump -Fc --no-owner --no-privileges -f "$parcial") 2>&1)" &&
     erro="$(pg_restore --list "$parcial" 2>&1 >/dev/null)" &&
     mv "$parcial" "$DIR/$nome"; then
    tamanho="$(stat -c %s "$DIR/$nome")"
    fim="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    escrever_ultimo "$inicio" "$fim" "$nome" "$tamanho" true ""
    log "ok: $nome ($tamanho bytes)"
    if [ "$RETENCAO" -gt 0 ]; then
      apagados="$(find "$DIR" -maxdepth 1 -name 'crmbrl-*.dump' -mtime +"$RETENCAO" -print -delete | wc -l)"
      log "retenção de $RETENCAO dia(s): $apagados arquivo(s) antigo(s) apagado(s)"
    fi
    return 0
  fi
  rm -f "$parcial"
  fim="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  escrever_ultimo "$inicio" "$fim" "" 0 false "${erro:-falha desconhecida}"
  log "FALHOU: $(json_texto "${erro:-falha desconhecida}")"
  return 1
}

segundos_ate_o_horario() {
  agora="$(date +%s)"
  alvo="$(date -d "$(date +%Y-%m-%d) $HORARIO:00" +%s)"
  if [ "$alvo" -le "$agora" ]; then alvo=$((alvo + 86400)); fi
  echo $((alvo - agora))
}

if [ "${1:-}" = "uma-vez" ]; then
  fazer_backup
  exit $?
fi

log "serviço de backup no ar: dump diário às $HORARIO (fuso ${TZ:-UTC}), retenção de $RETENCAO dia(s), pasta $DIR"
if [ "${BACKUP_AO_INICIAR:-false}" = "true" ]; then
  fazer_backup || true
fi
while true; do
  espera="$(segundos_ate_o_horario)"
  log "próximo dump em ${espera}s"
  sleep "$espera"
  fazer_backup || true
  sleep 60 # evita repetir no mesmo minuto
done
