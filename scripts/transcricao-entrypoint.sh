#!/bin/bash
# Serviço "transcricao" do compose (imagem oficial ghcr.io/ggml-org/whisper.cpp, fixada por digest):
# baixa o modelo do Whisper na primeira subida para o volume /modelos e roda o whisper-server,
# que escuta só na rede do compose (a API chama POST /inference).
#
# Variáveis: WHISPER_MODELO (padrão small; ex.: base, small, medium, large-v3-turbo-q5_0),
# WHISPER_THREADS (padrão 4), WHISPER_MODELO_URL (base dos downloads; padrão o repositório
# ggerganov/whisper.cpp no Hugging Face) e WHISPER_VAD (padrão true: detecção de voz Silero, ~900 KB, que
# corta os silêncios; sem ela os tempos dos trechos saem errados quando um canal fica calado por muito tempo,
# como o do atendente enquanto o cliente fala; WHISPER_VAD_URL é o endereço do modelo de voz).
set -euo pipefail

MODELO="${WHISPER_MODELO:-small}"
THREADS="${WHISPER_THREADS:-4}"
BASE="${WHISPER_MODELO_URL:-https://huggingface.co/ggerganov/whisper.cpp/resolve/main}"
DIR=/modelos
ARQUIVO="$DIR/ggml-${MODELO}.bin"

if [[ ! "$MODELO" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "[transcricao] WHISPER_MODELO inválido: use só letras, números, ponto, hífen e sublinhado." >&2
  exit 1
fi
if [[ ! "$THREADS" =~ ^[0-9]+$ ]] || [ "$THREADS" -lt 1 ]; then
  echo "[transcricao] WHISPER_THREADS precisa ser um número inteiro maior que zero." >&2
  exit 1
fi

mkdir -p "$DIR"
if [ ! -s "$ARQUIVO" ]; then
  echo "[transcricao] baixando o modelo \"$MODELO\" (só na primeira subida; fica no volume)…"
  rm -f "$ARQUIVO.parcial"
  curl -fL --retry 5 --retry-delay 5 --retry-all-errors --connect-timeout 20 \
    -o "$ARQUIVO.parcial" "$BASE/ggml-${MODELO}.bin"
  mv "$ARQUIVO.parcial" "$ARQUIVO"
  echo "[transcricao] modelo \"$MODELO\" pronto."
fi

VAD=()
if [ "${WHISPER_VAD:-true}" = "true" ]; then
  VAD_ARQUIVO="$DIR/ggml-silero-v5.1.2.bin"
  VAD_URL="${WHISPER_VAD_URL:-https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin}"
  if [ ! -s "$VAD_ARQUIVO" ]; then
    echo "[transcricao] baixando o modelo de detecção de voz (VAD)…"
    rm -f "$VAD_ARQUIVO.parcial"
    if curl -fL --retry 5 --retry-delay 5 --retry-all-errors --connect-timeout 20 \
        -o "$VAD_ARQUIVO.parcial" "$VAD_URL"; then
      mv "$VAD_ARQUIVO.parcial" "$VAD_ARQUIVO"
    else
      echo "[transcricao] AVISO: não foi possível baixar o VAD; seguindo sem ele (os tempos dos trechos ficam menos precisos)." >&2
    fi
  fi
  if [ -s "$VAD_ARQUIVO" ]; then
    VAD=(--vad --vad-model "$VAD_ARQUIVO")
  fi
fi

echo "[transcricao] modelo=$MODELO threads=$THREADS vad=${VAD[0]:+sim}"
exec whisper-server -m "$ARQUIVO" --host 0.0.0.0 --port 8080 -t "$THREADS" -l pt --suppress-nst "${VAD[@]}"
