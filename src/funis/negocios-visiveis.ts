import type { Tx } from '../prisma/prisma.service';
import type { QuemAcessa } from './acesso-funis';
import { funisAcessiveis, type LeitorDeAcessos } from './acessos-no-banco';

/** O pedaço do cliente Prisma usado para saber quais negócios uma pessoa vê. */
export type LeitorDeNegocios = LeitorDeAcessos & Pick<Tx, 'negocio'>;

/**
 * R5.9: dos negócios informados, os que a pessoa vê (os ids). Quem não vê um negócio não o recebe
 * nem pelo id (ligação, conversa, linha do tempo, tempo real).
 */
export async function negociosQueVe(
  db: LeitorDeNegocios,
  pessoa: QuemAcessa,
  ids: Iterable<string | null | undefined>,
): Promise<Set<string>> {
  const unicos = [
    ...new Set([...ids].filter((id): id is string => typeof id === 'string')),
  ];
  if (unicos.length === 0) return new Set();
  const acesso = await funisAcessiveis(db, pessoa);
  if (acesso.todos) return new Set(unicos);
  const negocios = await db.negocio.findMany({
    where: { id: { in: unicos } },
    select: { id: true, funilId: true, responsavelId: true },
  });
  return new Set(
    negocios.filter((n) => acesso.podeVerNegocio(n)).map(({ id }) => id),
  );
}

/** A pessoa vê este negócio? (`null` não é negócio: não há o que esconder.) */
export async function veNegocio(
  db: LeitorDeNegocios,
  pessoa: QuemAcessa,
  negocioId: string | null | undefined,
): Promise<boolean> {
  if (!negocioId) return true;
  return (await negociosQueVe(db, pessoa, [negocioId])).has(negocioId);
}
