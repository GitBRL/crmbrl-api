/**
 * Checagens de setor que leem o banco (R1.9), usadas pelos serviços que gravam
 * uma coluna `area` (usuários, funis, filas, respostas rápidas, disparos,
 * automações, chatbot, importação…). Funcionam com o `PrismaService` ou dentro
 * de uma transação.
 */
import { RegraVioladaException } from '../comum/erros/excecoes';
import type { Area } from '../comum/dominio/setores';
import type { Tx } from '../prisma/prisma.service';

/** O pedaço do cliente Prisma que estas funções usam (cabe o serviço e a transação). */
export type LeitorDeSetores = Pick<Tx, 'setor'>;

/**
 * R1.9: só um setor existente e ativo vale para um registro novo ou alterado.
 * Senão, `422 regra_violada` com o campo em `detalhes.campo`.
 */
export async function garantirSetorAtivo(
  db: LeitorDeSetores,
  area: Area,
  campo = 'area',
): Promise<void> {
  const setor = await db.setor.findUnique({
    where: { chave: area },
    select: { nome: true, ativo: true },
  });
  if (!setor) {
    throw new RegraVioladaException('R1.9', `O setor ${area} não existe.`, {
      campo,
      area,
    });
  }
  if (!setor.ativo) {
    throw new RegraVioladaException(
      'R1.9',
      `O setor ${setor.nome} está desativado: escolha um setor ativo.`,
      { campo, area },
    );
  }
}

/** `garantirSetorAtivo` só quando há setor (`null`/`undefined` passam). */
export async function garantirSetorAtivoSeHouver(
  db: LeitorDeSetores,
  area: Area | null | undefined,
  campo = 'area',
): Promise<void> {
  if (area) {
    await garantirSetorAtivo(db, area, campo);
  }
}

/** Chaves dos setores ativos, na ordem de exibição (ordem, nome). */
export async function chavesDosSetoresAtivos(
  db: LeitorDeSetores,
): Promise<Area[]> {
  const setores = await db.setor.findMany({
    where: { ativo: true },
    select: { chave: true },
    orderBy: [{ ordem: 'asc' }, { nome: 'asc' }],
  });
  return setores.map(({ chave }) => chave);
}
