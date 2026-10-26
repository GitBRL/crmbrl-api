# syntax=docker/dockerfile:1

# Imagem da crmbrl-api: o Bun instala as dependências e o Node 24 executa.
# A mesma imagem roda dois processos (docker-entrypoint.sh):
#   - a API (padrão): migrations + node dist/main.js;
#   - o gateway de WhatsApp (comando "whatsapp"): node dist/whatsapp/main.js.
# Para subir tudo (banco, arquivos, API, gateway e front), use o
# docker-compose.yml deste repositório.

# 1. Dependências completas (com as de desenvolvimento), para compilar.
FROM oven/bun:1-alpine AS dependencias
WORKDIR /app
# bunfig.toml: peer=false (não instala o `sharp`, peer do baileys fora das
# dependências aprovadas).
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile

# 2. Build: Prisma Client + compilação do Nest (o script "build" do package.json).
FROM node:24-alpine AS build
WORKDIR /app
COPY --from=dependencias /app/node_modules ./node_modules
COPY . .
RUN npm run build

# 3. Só as dependências de produção. Inclui o CLI do Prisma e o schema engine
#    para Alpine, usados pelo `prisma migrate deploy` quando o container sobe.
FROM oven/bun:1-alpine AS producao
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile --production

# 4. Imagem final, sem código-fonte nem dependências de desenvolvimento.
FROM node:24-alpine
# ffmpeg: o gateway de WhatsApp converte o áudio gravado no navegador
# (webm/opus) em ogg/opus, o formato das mensagens de voz.
RUN apk add --no-cache ffmpeg
# CHECKPOINT_DISABLE: o CLI do Prisma não consulta atualizações a cada partida.
ENV NODE_ENV=production \
    CHECKPOINT_DISABLE=1
WORKDIR /app
COPY --from=producao /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY prisma ./prisma
COPY package.json prisma.config.ts docker-entrypoint.sh ./
USER node
# 3000: API. O gateway de WhatsApp ouve em WHATSAPP_PORTA (3100), só na rede
# interna, com o healthcheck próprio no compose (GET /saude).
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT:-3000}/api/saude" || exit 1
ENTRYPOINT ["/bin/sh", "/app/docker-entrypoint.sh"]
