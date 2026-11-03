/**
 * Apagar gravação e transcrição de ligações (R30), pela guarda vencida ou pela anonimização do
 * contato. O registro da ligação, a duração e o resumo ficam (na anonimização o resumo também sai,
 * porque cita o titular). Os arquivos são removidos pelo `ArquivosService` (o conteúdo sai do
 * armazenamento por job depois do commit).
 */
import type { ArquivosService } from '../../arquivos/arquivos.service';
import { Prisma } from '../../generated/prisma/client';
import type { Tx } from '../../prisma/prisma.service';

export interface GravacoesApagadas {
  /** Ids das ligações atingidas. */
  ligacaoIds: string[];
  arquivos: number;
}

export async function apagarGravacoes(
  tx: Tx,
  arquivos: ArquivosService,
  onde: Prisma.LigacaoWhereInput,
  motivo: string,
  opcoes: { apagarResumo?: boolean } = {},
): Promise<GravacoesApagadas> {
  const criterio: Prisma.LigacaoWhereInput = {
    AND: [
      onde,
      {
        OR: [
          { gravacaoArquivoId: { not: null } },
          { gravacaoOriginalArquivoId: { not: null } },
          { transcricaoSituacao: { not: null } },
          { gravacaoSituacao: { not: 'SEM' } },
          ...(opcoes.apagarResumo
            ? [{ resumoSituacao: { not: null } } as const]
            : []),
        ],
      },
      ...(opcoes.apagarResumo ? [] : [{ gravacaoRemovidaEm: null }]),
    ],
  };
  // Trava as ligações atingidas antes de ler os arquivos: o processamento da transcrição também
  // trava a linha para gravar, então ou ele grava antes (e este apaga o que ele gravou) ou
  // grava depois e descobre que a gravação foi removida.
  const candidatas = await tx.ligacao.findMany({
    where: criterio,
    select: { id: true },
  });
  if (candidatas.length === 0) {
    return { ligacaoIds: [], arquivos: 0 };
  }
  const idsCandidatas = candidatas.map((l) => l.id);
  await tx.$queryRaw`SELECT id FROM ligacoes WHERE id = ANY(${idsCandidatas}::uuid[]) FOR UPDATE`;
  const ligacoes = await tx.ligacao.findMany({
    where: { AND: [{ id: { in: idsCandidatas } }, criterio] },
    select: {
      id: true,
      gravacaoArquivoId: true,
      gravacaoOriginalArquivoId: true,
    },
  });
  if (ligacoes.length === 0) {
    return { ligacaoIds: [], arquivos: 0 };
  }
  const ids = ligacoes.map((l) => l.id);
  const arquivoIds = [
    ...new Set(
      ligacoes.flatMap((l) =>
        [l.gravacaoArquivoId, l.gravacaoOriginalArquivoId].filter(
          (id): id is string => id !== null,
        ),
      ),
    ),
  ];
  await tx.ligacao.updateMany({
    where: { id: { in: ids } },
    data: {
      gravacaoRemovidaEm: new Date(),
      gravacaoArquivoId: null,
      gravacaoOriginalArquivoId: null,
      gravacaoSituacao: 'SEM',
      gravacaoErro: null,
      transcricao: Prisma.DbNull,
      transcricaoSituacao: null,
      transcricaoErro: null,
      ...(opcoes.apagarResumo
        ? {
            resumo: Prisma.DbNull,
            resumoSituacao: null,
            resumoErro: null,
          }
        : {}),
    },
  });
  for (const arquivoId of arquivoIds) {
    await arquivos.remover(arquivoId, { tx, motivo });
  }
  return { ligacaoIds: ids, arquivos: arquivoIds.length };
}
