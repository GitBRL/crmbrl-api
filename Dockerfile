# syntax=docker/dockerfile:1

# Imagem da crmbrl-api: o Bun instala as dependências e o Node 24 executa.
# Para subir tudo (banco, API e front), use o docker-compose.yml deste repositório.

# 1. Dependências completas (com as de desenvolvimento), para compilar.
FROM oven/bun:1-alpine AS dependencias
WORKDIR /app
COPY package.json bun.lock ./
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
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# 4. Imagem final, sem código-fonte nem dependências de desenvolvimento.
FROM node:24-alpine
# CHECKPOINT_DISABLE: o CLI do Prisma não consulta atualizações a cada partida.
ENV NODE_ENV=production \
    CHECKPOINT_DISABLE=1
WORKDIR /app
COPY --from=producao /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY prisma ./prisma
COPY package.json prisma.config.ts docker-entrypoint.sh ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT:-3000}/api/saude" || exit 1
ENTRYPOINT ["/bin/sh", "/app/docker-entrypoint.sh"]
