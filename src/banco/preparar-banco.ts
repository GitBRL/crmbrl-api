/**
 * R35.1 — prepara o papel da aplicação no banco (rodado pelo
 * `docker-entrypoint.sh` depois do `prisma migrate deploy`, ou à mão:
 * `node dist/banco/preparar-banco.js`).
 *
 * Lê do ambiente: `DATABASE_URL_MIGRACAO` (o dono do banco), `BANCO_APP_SENHA`
 * e `BANCO_APP_USUARIO` (padrão `crmbrl_app`); em produção (`NODE_ENV`), recusa
 * o dono com a senha de desenvolvimento (salvo
 * `PERMITIR_SEGREDOS_DE_DESENVOLVIMENTO=true`). Nunca escreve a senha nem as
 * URLs no log.
 */
import { existsSync } from 'node:fs';
import pg from 'pg';
import {
  conferirSenhaDoDono,
  PAPEL_DA_APLICACAO_PADRAO,
  prepararPapelDaAplicacao,
} from './papel-da-aplicacao';

async function principal(): Promise<void> {
  if (existsSync('.env')) {
    process.loadEnvFile('.env');
  }
  const urlDoDono = process.env.DATABASE_URL_MIGRACAO?.trim();
  const senha = process.env.BANCO_APP_SENHA ?? '';
  const nome =
    process.env.BANCO_APP_USUARIO?.trim() || PAPEL_DA_APLICACAO_PADRAO;
  if (!urlDoDono) {
    throw new Error(
      'Defina DATABASE_URL_MIGRACAO (a conexão do dono do banco, que roda as migrations).',
    );
  }
  if (!senha) {
    throw new Error('Defina BANCO_APP_SENHA (a senha do papel da aplicação).');
  }
  // U4 + R35.1: em produção, o dono com a senha de desenvolvimento recusa a
  // subida (a API não vê a DATABASE_URL_MIGRACAO para conferir).
  const { problema, aviso } = conferirSenhaDoDono(urlDoDono, {
    producao: process.env.NODE_ENV?.trim() === 'production',
    permitir:
      process.env.PERMITIR_SEGREDOS_DE_DESENVOLVIMENTO?.trim().toLowerCase() ===
      'true',
  });
  if (problema) {
    throw new Error(problema);
  }
  if (aviso) {
    console.warn(`preparar-banco: ${aviso}`);
  }
  const cliente = new pg.Client({
    connectionString: urlDoDono,
    connectionTimeoutMillis: 10_000,
    application_name: 'crmbrl-preparar-banco',
  });
  await cliente.connect();
  try {
    const { criado } = await prepararPapelDaAplicacao(cliente, {
      nome,
      senha,
    });
    console.log(
      `preparar-banco: papel ${nome} ${criado ? 'criado' : 'atualizado'} (só DML; auditoria só leitura e inclusão; RLS ligada).`,
    );
  } finally {
    await cliente.end();
  }
}

principal().catch((erro: unknown) => {
  console.error(
    `preparar-banco: ${erro instanceof Error ? erro.message : String(erro)}`,
  );
  process.exit(1);
});
