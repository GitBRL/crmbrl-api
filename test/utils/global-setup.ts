import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import pg from 'pg';
import { prepararPapelDaAplicacao } from '../../src/banco/papel-da-aplicacao';
import {
  PAPEL_DA_APLICACAO_DE_TESTE,
  SENHA_DO_PAPEL_DE_TESTE,
  urlDoBancoDeTeste,
} from './ambiente-teste';

/**
 * Antes de todos os testes de integração: aplica as migrations no banco de
 * teste com o dono (`prisma migrate deploy`, rápido quando já estão aplicadas)
 * e cria o papel da aplicação (R35.1), com que a API dos testes conecta — sem
 * superusuário, só DML e com a RLS valendo.
 */
export default async function prepararBancoDeTeste(): Promise<void> {
  const url = urlDoBancoDeTeste();
  const raiz = join(__dirname, '..', '..');
  try {
    execFileSync(
      join(raiz, 'node_modules', '.bin', 'prisma'),
      ['migrate', 'deploy'],
      {
        cwd: raiz,
        // As duas: o prisma.config.ts prefere DATABASE_URL_MIGRACAO, e o .env
        // da pasta (o do ambiente do usuário) não pode valer aqui.
        env: {
          ...process.env,
          DATABASE_URL: url,
          DATABASE_URL_MIGRACAO: url,
          CHECKPOINT_DISABLE: '1',
        },
        stdio: 'pipe',
      },
    );
  } catch (erro) {
    const saida =
      (erro as { stderr?: Buffer; stdout?: Buffer }).stderr?.toString() ?? '';
    throw new Error(
      `prisma migrate deploy falhou no banco de teste:\n${saida}`,
    );
  }
  const dono = new pg.Client({ connectionString: url });
  await dono.connect();
  try {
    await prepararPapelDaAplicacao(dono, {
      nome: PAPEL_DA_APLICACAO_DE_TESTE,
      senha: SENHA_DO_PAPEL_DE_TESTE,
    });
  } finally {
    await dono.end();
  }
}
