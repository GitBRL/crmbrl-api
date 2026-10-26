import { SeedsService } from '../../src/seeds/seeds.service';
import type { AppTeste } from './app-teste';

/**
 * Deixa o banco de teste como novo: TRUNCATE de todas as tabelas (menos
 * `_prisma_migrations`), jobs da fila apagados, configuração inicial refeita
 * (funis-base, etapas, passagens, rodízios e — se `ADMIN_EMAIL` estiver no
 * ambiente do teste — o Admin inicial), o e-mail falso e os arquivos em
 * memória zerados.
 *
 * A auditoria recusa TRUNCATE (R3.3): o gatilho é desligado só dentro desta
 * transação, pelo dono da tabela.
 */
export async function limparBanco(t: AppTeste): Promise<void> {
  const tabelas = await t.prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
     WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  const lista = tabelas
    .map(({ tablename }) => `"public"."${tablename}"`)
    .join(', ');
  // Com `PROCESSAR_FILAS=true`, os trabalhadores e a sincronização do chat da
  // subida usam as tabelas ao mesmo tempo: o TRUNCATE (que trava uma por uma)
  // pode cair num deadlock com eles. Nesse caso, tenta de novo.
  for (let tentativa = 1; ; tentativa++) {
    try {
      await t.prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          'ALTER TABLE "eventos_auditoria" DISABLE TRIGGER "eventos_auditoria_sem_truncate"',
        );
        await tx.$executeRawUnsafe(
          `TRUNCATE ${lista} RESTART IDENTITY CASCADE`,
        );
        await tx.$executeRawUnsafe(
          'ALTER TABLE "eventos_auditoria" ENABLE TRIGGER "eventos_auditoria_sem_truncate"',
        );
      });
      break;
    } catch (erro) {
      if (tentativa >= 5 || !ehDeadlock(erro)) {
        throw erro;
      }
      await new Promise((resolver) => setTimeout(resolver, 100 * tentativa));
    }
  }
  await t.fila.limparTrabalhos();
  await t.get(SeedsService).executar();
  t.email.limpar();
  if (t.arquivos.nome === 'memoria') {
    t.arquivos.limpar();
  }
}

/** Deadlock do Postgres (40P01), vindo do driver ou embrulhado pelo Prisma. */
function ehDeadlock(erro: unknown): boolean {
  const texto = erro instanceof Error ? erro.message : String(erro);
  return texto.includes('40P01') || texto.includes('deadlock detected');
}
