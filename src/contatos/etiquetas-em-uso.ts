import { Prisma } from '../generated/prisma/client';
import type { Tx } from '../prisma/prisma.service';
import { escaparLike } from './busca';
import type { EtiquetaEmUsoDto } from './dto/comum.dto';

/** Tabelas com coluna `etiquetas text[]` e exclusão lógica. */
export type TabelaComEtiquetas = 'contatos' | 'empresas';

/**
 * Grafias em uso de uma etiqueta, sem diferenciar maiúsculas: o filtro por
 * "vip" acha os registros com "VIP" e com "Vip" (R4.7 guarda a primeira
 * grafia de cada registro).
 */
export async function grafiasDaEtiqueta(
  banco: Tx,
  tabela: TabelaComEtiquetas,
  etiqueta: string,
): Promise<string[]> {
  const linhas = await banco.$queryRaw<{ etiqueta: string }[]>`
    SELECT DISTINCT e AS etiqueta
      FROM ${Prisma.raw(`"${tabela}"`)} t, unnest(t.etiquetas) AS e
     WHERE t.excluido_em IS NULL
       AND lower(e) = lower(${etiqueta.replace(/\s+/g, ' ').trim()})`;
  return linhas.map((linha) => linha.etiqueta);
}

/**
 * Etiquetas em uso nos registros ativos, das mais usadas para as menos, com a
 * grafia mais comum de cada uma. `busca` filtra pelo começo.
 */
export async function listarEtiquetasEmUso(
  banco: Tx,
  tabela: TabelaComEtiquetas,
  filtro: { busca?: string; limite: number },
): Promise<EtiquetaEmUsoDto[]> {
  const prefixo = `${escaparLike(filtro.busca?.trim() ?? '')}%`;
  return banco.$queryRaw<EtiquetaEmUsoDto[]>`
    SELECT mode() WITHIN GROUP (ORDER BY e) AS etiqueta, count(*)::int AS quantidade
      FROM ${Prisma.raw(`"${tabela}"`)} t, unnest(t.etiquetas) AS e
     WHERE t.excluido_em IS NULL
       AND lower(e) LIKE lower(${prefixo})
     GROUP BY lower(e)
     ORDER BY quantidade DESC, etiqueta ASC
     LIMIT ${filtro.limite}::int`;
}
