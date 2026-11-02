import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { urlDoBancoDeTeste } from './ambiente-teste';

/**
 * Antes de todos os testes de integração: aplica as migrations no banco de
 * teste (`prisma migrate deploy`, rápido quando já estão aplicadas).
 */
export default function prepararBancoDeTeste(): void {
  const url = urlDoBancoDeTeste();
  const raiz = join(__dirname, '..', '..');
  try {
    execFileSync(
      join(raiz, 'node_modules', '.bin', 'prisma'),
      ['migrate', 'deploy'],
      {
        cwd: raiz,
        env: { ...process.env, DATABASE_URL: url, CHECKPOINT_DISABLE: '1' },
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
}
