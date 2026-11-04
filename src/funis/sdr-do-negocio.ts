import type { SituacaoSdr, TemperaturaSdr } from '../generated/prisma/client';
import type { PrismaService } from '../prisma/prisma.service';

/** O que o cartão do funil mostra do SDR com IA (R31): a temperatura e a nota do lead. */
export interface SdrDoCartao {
  temperatura: TemperaturaSdr;
  nota: number | null;
  situacao: SituacaoSdr;
}

/**
 * A qualificação mais recente do SDR de cada contato (a conversa atendida pela IA
 * mais nova que já tem temperatura). Uma consulta para a página inteira de cartões.
 */
export async function sdrPorContato(
  prisma: PrismaService,
  contatoIds: readonly string[],
): Promise<Map<string, SdrDoCartao>> {
  const mapa = new Map<string, SdrDoCartao>();
  const unicos = [...new Set(contatoIds)];
  if (unicos.length === 0) {
    return mapa;
  }
  const linhas = await prisma.sdrConversa.findMany({
    where: {
      conversa: { contatoId: { in: unicos } },
      temperatura: { not: null },
    },
    orderBy: { criadoEm: 'desc' },
    select: {
      nota: true,
      temperatura: true,
      situacao: true,
      conversa: { select: { contatoId: true } },
    },
  });
  for (const linha of linhas) {
    const contatoId = linha.conversa.contatoId;
    if (!mapa.has(contatoId) && linha.temperatura) {
      mapa.set(contatoId, {
        temperatura: linha.temperatura,
        nota: linha.nota,
        situacao: linha.situacao,
      });
    }
  }
  return mapa;
}
