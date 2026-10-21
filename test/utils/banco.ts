import { SeedsService } from '../../src/seeds/seeds.service';
import type { AppTeste } from './app-teste';

/**
 * Deixa o banco de teste como novo: TRUNCATE de todas as tabelas (menos
 * `_prisma_migrations`), jobs da fila apagados, configuração inicial refeita
 * (funis-base, etapas, passagens, rodízios e — se `ADMIN_EMAIL` estiver no
 * ambiente do teste — o Admin inicial) e o e-mail falso zerado.
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
  await t.prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      'ALTER TABLE "eventos_auditoria" DISABLE TRIGGER "eventos_auditoria_sem_truncate"',
    );
    await tx.$executeRawUnsafe(`TRUNCATE ${lista} RESTART IDENTITY CASCADE`);
    await tx.$executeRawUnsafe(
      'ALTER TABLE "eventos_auditoria" ENABLE TRIGGER "eventos_auditoria_sem_truncate"',
    );
  });
  await t.fila.limparTrabalhos();
  await t.get(SeedsService).executar();
  t.email.limpar();
}
