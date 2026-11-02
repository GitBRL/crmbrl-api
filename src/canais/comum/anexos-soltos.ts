import type { ArquivosService } from '../../arquivos/arquivos.service';
import type { PrismaService } from '../../prisma/prisma.service';

/**
 * Entrega ao Atendimento mensagens com anexos já salvos (e-mail, Meta). Se a
 * entrega falha (a transação desfez), os arquivos que nenhuma mensagem usa
 * são descartados — a próxima tentativa do job baixa e salva de novo, e sem
 * isto cada tentativa deixaria um arquivo solto no bucket.
 */
export async function entregarComAnexos<T>(
  prisma: PrismaService,
  arquivos: ArquivosService,
  arquivoIds: readonly string[],
  entregar: () => Promise<T>,
): Promise<T> {
  try {
    return await entregar();
  } catch (erro) {
    await descartarSoltos(prisma, arquivos, arquivoIds);
    throw erro;
  }
}

/** Descarta os arquivos da lista que nenhuma mensagem usa (na dúvida, mantém). */
export async function descartarSoltos(
  prisma: PrismaService,
  arquivos: ArquivosService,
  arquivoIds: readonly string[],
): Promise<void> {
  if (arquivoIds.length === 0) {
    return;
  }
  const usados = await prisma.mensagem
    .findMany({
      where: { arquivoId: { in: [...arquivoIds] } },
      select: { arquivoId: true },
    })
    .then((lista) => new Set(lista.map(({ arquivoId }) => arquivoId)))
    .catch(() => null);
  if (!usados) {
    return;
  }
  for (const id of arquivoIds) {
    if (!usados.has(id)) {
      await arquivos.descartarNovo(id).catch(() => undefined);
    }
  }
}
