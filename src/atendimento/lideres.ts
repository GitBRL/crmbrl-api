import { ehLiderDoSetor } from '../comum/dominio/papeis';
import type { Tx } from '../prisma/prisma.service';
import type { Area } from '../comum/dominio/setores';

/**
 * Quem é avisado quando algo de uma conversa precisa do líder (SLA estourado,
 * avaliação baixa — R12): o líder direto de quem atende, se estiver ativo e
 * for o líder do setor da fila; senão (sem responsável, sem líder ou líder de
 * outro setor) os líderes ativos do setor da fila. Conversa sem fila e sem
 * líder direto: ninguém.
 */
export async function lideresParaAvisar(
  tx: Tx,
  liderId: string | null,
  area: Area | null,
): Promise<string[]> {
  if (liderId) {
    const lider = await tx.usuario.findFirst({
      where: { id: liderId, ativo: true },
      select: { id: true, papel: true, area: true },
    });
    if (lider && (!area || ehLiderDoSetor(lider, area))) {
      return [lider.id];
    }
  }
  if (!area) {
    return [];
  }
  const lideres = await tx.usuario.findMany({
    where: { papel: 'LIDER', area, ativo: true },
    select: { id: true },
  });
  return lideres.map((lider) => lider.id);
}
