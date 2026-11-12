import { existsSync } from 'node:fs';
import { defineConfig } from 'prisma/config';

// Prisma 7 não lê o .env sozinho. Em desenvolvimento ele existe; no container as
// variáveis já vêm do ambiente (e as do ambiente têm prioridade sobre o arquivo).
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    // `env('DATABASE_URL')` do Prisma falharia sem a variável, e o
    // `prisma generate` (que roda no build, sem banco) não precisa dela. Os
    // comandos que falam com o banco (migrate, db) acusam a falta com clareza.
    // R35.1: as migrations rodam com o dono do banco (`DATABASE_URL_MIGRACAO`);
    // a aplicação usa `DATABASE_URL` (o papel dela, sem DDL). Sem a variável
    // nova, vale a `DATABASE_URL` (como antes).
    url: process.env.DATABASE_URL_MIGRACAO || process.env.DATABASE_URL,
  },
});
