/**
 * Peças comuns às consultas por cursor da auditoria (R3.4) e dos logs técnicos
 * (R3.6): cursor opaco, período e busca por texto sem diferenciar maiúsculas
 * nem acentos. Usadas também pelo módulo de administração.
 */
import { DadosInvalidosException } from '../../comum/erros/excecoes';
import { Prisma } from '../../generated/prisma/client';

/** Maior valor de um `bigint` do PostgreSQL (ids sequenciais). */
const MAIOR_BIGINT = 9_223_372_036_854_775_807n;

/** Lista em que o cursor vale: o cursor de uma não é aceito na outra. */
export type TipoDeCursor = 'auditoria' | 'logs';

/**
 * Cursor opaco da próxima página: o id do último item devolvido. As listas são
 * ordenadas por id decrescente, então a página seguinte é `id < cursor` — um
 * evento novo, gravado durante a navegação, nunca desloca as páginas seguintes.
 */
export function codificarCursor(tipo: TipoDeCursor, id: bigint): string {
  return Buffer.from(`${tipo}:${id.toString()}`, 'utf8').toString('base64url');
}

/** Lê o cursor recebido (`undefined` = primeira página); inválido → 400. */
export function lerCursor(
  tipo: TipoDeCursor,
  cursor: string | undefined,
): bigint | undefined {
  if (cursor === undefined || cursor === '') {
    return undefined;
  }
  const texto = /^[A-Za-z0-9_-]+$/.test(cursor)
    ? Buffer.from(cursor, 'base64url').toString('utf8')
    : '';
  const encontrado = /^([a-z]+):(\d{1,19})$/.exec(texto);
  const id =
    encontrado && encontrado[1] === tipo ? BigInt(encontrado[2]) : undefined;
  if (id === undefined || id <= 0n || id > MAIOR_BIGINT) {
    throw new DadosInvalidosException(
      'Cursor inválido: use o proximoCursor devolvido pela página anterior.',
      { campos: [{ campo: 'cursor', mensagens: ['é inválido'] }] },
    );
  }
  return id;
}

/** Próxima página a partir das linhas lidas com `LIMIT limite + 1`. */
export function montarPaginaPorCursor<L extends { id: bigint }, T>(
  tipo: TipoDeCursor,
  linhas: readonly L[],
  limite: number,
  converter: (linha: L) => T,
): { itens: T[]; proximoCursor: string | null } {
  const temMais = linhas.length > limite;
  const pagina = temMais ? linhas.slice(0, limite) : linhas;
  const ultima = pagina.at(-1);
  return {
    itens: pagina.map(converter),
    proximoCursor: temMais && ultima ? codificarCursor(tipo, ultima.id) : null,
  };
}

export interface Periodo {
  /** Início, inclusive. */
  readonly de?: Date;
  /** Fim, exclusivo. */
  readonly ate?: Date;
}

/**
 * Período `[de, ate)` a partir dos textos ISO 8601 já validados no DTO.
 * `de` igual ou depois de `ate` → 400.
 */
export function lerPeriodo(de?: string, ate?: string): Periodo {
  const inicio = de ? new Date(de) : undefined;
  const fim = ate ? new Date(ate) : undefined;
  if (inicio && fim && inicio.getTime() >= fim.getTime()) {
    throw new DadosInvalidosException(
      'O fim do período ("ate") precisa ser depois do início ("de").',
      { campos: [{ campo: 'ate', mensagens: ['deve ser depois de "de"'] }] },
    );
  }
  return { de: inicio, ate: fim };
}

/** Condições SQL do período sobre uma coluna de data (nome fixo do código). */
export function condicoesDoPeriodo(
  coluna: string,
  periodo: Periodo,
): Prisma.Sql[] {
  const nome = Prisma.raw(coluna);
  const condicoes: Prisma.Sql[] = [];
  if (periodo.de) {
    condicoes.push(Prisma.sql`${nome} >= ${periodo.de}::timestamptz`);
  }
  if (periodo.ate) {
    condicoes.push(Prisma.sql`${nome} < ${periodo.ate}::timestamptz`);
  }
  return condicoes;
}

/** `WHERE a AND b …`, ou nada sem condições. */
export function clausulaWhere(condicoes: readonly Prisma.Sql[]): Prisma.Sql {
  return condicoes.length > 0
    ? Prisma.sql`WHERE ${Prisma.join(condicoes, ' AND ')}`
    : Prisma.empty;
}

// ---------------------------------------------------------------------------
// Busca por texto
// ---------------------------------------------------------------------------

const COM_ACENTO = 'áàâãäåéèêëíìîïóòôõöúùûüçñýÿ';
const SEM_ACENTO = 'aaaaaaeeeeiiiiooooouuuucnyy';

/**
 * Tabela do `translate()` do PostgreSQL (e da normalização do termo, aqui):
 * letras acentuadas, maiúsculas e minúsculas, viram a letra sem acento em
 * minúscula. O banco não tem a extensão `unaccent`, e o `translate` não
 * depende do locale.
 */
export const LETRAS_ACENTUADAS = COM_ACENTO + COM_ACENTO.toUpperCase();
export const LETRAS_SEM_ACENTO = SEM_ACENTO + SEM_ACENTO;

/** Termos considerados numa busca (os demais são ignorados). */
export const MAXIMO_DE_TERMOS = 5;

/** O texto como a busca o compara: sem acentos e em minúsculas. */
export function normalizarParaBusca(texto: string): string {
  let resultado = '';
  for (const caractere of texto.normalize('NFC')) {
    const posicao = LETRAS_ACENTUADAS.indexOf(caractere);
    resultado += posicao >= 0 ? LETRAS_SEM_ACENTO[posicao] : caractere;
  }
  return resultado.toLowerCase();
}

/** Termos da busca: separados por espaço, normalizados, sem repetidos, até 5. */
export function termosDaBusca(texto: string | undefined): string[] {
  if (!texto) {
    return [];
  }
  const termos = normalizarParaBusca(texto)
    .split(/\s+/)
    .filter((termo) => termo !== '');
  return [...new Set(termos)].slice(0, MAXIMO_DE_TERMOS);
}

/** Escapa os curingas do `LIKE` (`%`, `_` e a própria barra). */
export function escaparLike(texto: string): string {
  return texto.replace(/[\\%_]/g, (caractere) => `\\${caractere}`);
}

/**
 * Uma condição por termo: cada um precisa aparecer em ao menos uma das colunas,
 * sem diferenciar maiúsculas nem acentos ("negocio" acha "Negócio").
 *
 * `colunas` são nomes fixos do código — nunca venham da requisição.
 */
export function condicoesDeBusca(
  colunas: readonly string[],
  termos: readonly string[],
): Prisma.Sql[] {
  return termos.map((termo) => {
    const padrao = `%${escaparLike(termo)}%`;
    const alternativas = colunas.map(
      (coluna) =>
        Prisma.sql`lower(translate(${Prisma.raw(coluna)}, ${LETRAS_ACENTUADAS}, ${LETRAS_SEM_ACENTO})) LIKE ${padrao}`,
    );
    return Prisma.sql`(${Prisma.join(alternativas, ' OR ')})`;
  });
}
