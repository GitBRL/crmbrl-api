import type { Tx } from './prisma.service';

/**
 * Trava consultiva do PostgreSQL (`pg_advisory_xact_lock`) pela duração da
 * transação: outra transação que pedir a mesma chave espera esta terminar.
 *
 * Serve para serializar decisões que nenhum índice único cobre sozinho, como
 * "um contato não tem dois negócios abertos no mesmo funil vindos de automação"
 * (R5.6) ou a configuração inicial rodando em duas réplicas ao mesmo tempo.
 *
 * ```ts
 * await travarChave(tx, 'negocio-automatico', contatoId, funilId);
 * ```
 *
 * Para o rodízio (R5.8), prefira travar a própria linha da regra
 * (`SELECT … FROM regras_distribuicao WHERE area = … FOR UPDATE`).
 */
export async function travarChave(
  tx: Tx,
  ...partes: readonly string[]
): Promise<void> {
  const chave = partes.join(':');
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${chave}, 0))`;
}
