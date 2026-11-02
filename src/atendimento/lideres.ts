import { liderDaArea } from '../comum/dominio/papeis';
import type { Area } from '../generated/prisma/client';
import type { Tx } from '../prisma/prisma.service';

/**
 * Quem é avisado quando algo de uma conversa precisa do líder (SLA estourado,
 * avaliação baixa — R12): o líder direto de quem atende, se estiver ativo e
 * for o líder da área da fila; senão (sem responsável, sem líder ou líder de
 * outra área) os líderes ativos da área da fila. Conversa sem fila e sem
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
      select: { id: true, papel: true },
    });
    if (lider && (!area || lider.papel === liderDaArea(area))) {
      return [lider.id];
    }
  }
  if (!area) {
    return [];
  }
  const lideres = await tx.usuario.findMany({
    where: { papel: liderDaArea(area), ativo: true },
    select: { id: true },
  });
  return lideres.map((lider) => lider.id);
}
