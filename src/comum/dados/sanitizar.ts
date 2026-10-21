import { Prisma } from '../../generated/prisma/client';

/** Valor que pode ir para uma coluna `jsonb` (auditoria, logs técnicos). */
export type ValorJson =
  | string
  | number
  | boolean
  | null
  | ValorJson[]
  | { [chave: string]: ValorJson };

/** Texto que substitui o valor de um campo sensível. */
export const VALOR_OMITIDO = '[omitido]';

/**
 * Campos que nunca são gravados em auditoria nem em log (R3.1): senhas, tokens,
 * hashes, segredos, assinaturas, cookies e credenciais.
 */
const CAMPO_SENSIVEL =
  /senha|password|passwd|token|segredo|secret|hash|cookie|authorization|assinatura|signature|api[-_]?key|credencia/i;

export function ehCampoSensivel(nome: string): boolean {
  return CAMPO_SENSIVEL.test(nome);
}

/**
 * O valor de um campo sensível é omitido quando pode conter o segredo (texto,
 * objeto, lista). Booleanos, números e datas passam: `deveTrocarSenha: true` e
 * `senhaAlteradaEm` não revelam nada.
 */
function deveOmitir(chave: string, valor: unknown): boolean {
  if (!ehCampoSensivel(chave)) {
    return false;
  }
  return !(
    valor === null ||
    valor === undefined ||
    typeof valor === 'boolean' ||
    typeof valor === 'number' ||
    valor instanceof Date
  );
}

const PROFUNDIDADE_MAXIMA = 8;
const TAMANHO_MAXIMO_TEXTO = 10_000;
const ITENS_MAXIMOS_LISTA = 200;

/**
 * Converte qualquer valor num JSON seguro para gravar: tira campos sensíveis,
 * transforma `Date` em ISO 8601, `Decimal` em texto com duas casas, `bigint` em
 * texto, descarta funções e `undefined`, corta textos e listas muito grandes e
 * referências circulares. Devolve `undefined` só quando o próprio valor é
 * descartável (função, símbolo, `undefined`).
 */
export function sanitizarParaJson(valor: unknown): ValorJson | undefined {
  return converter(valor, 0, new WeakSet<object>());
}

/** Como `sanitizarParaJson`, mas sempre devolve um objeto (para `dados`). */
export function sanitizarObjeto(
  valor: Record<string, unknown> | null | undefined,
): { [chave: string]: ValorJson } | undefined {
  if (!valor) {
    return undefined;
  }
  const convertido = sanitizarParaJson(valor);
  return convertido &&
    typeof convertido === 'object' &&
    !Array.isArray(convertido)
    ? convertido
    : undefined;
}

function converter(
  valor: unknown,
  profundidade: number,
  vistos: WeakSet<object>,
): ValorJson | undefined {
  if (valor === null) {
    return null;
  }
  switch (typeof valor) {
    case 'string':
      return valor.length > TAMANHO_MAXIMO_TEXTO
        ? `${valor.slice(0, TAMANHO_MAXIMO_TEXTO)}…`
        : valor;
    case 'number':
      return Number.isFinite(valor) ? valor : null;
    case 'boolean':
      return valor;
    case 'bigint':
      return valor.toString();
    case 'undefined':
    case 'function':
    case 'symbol':
      return undefined;
    default:
      break;
  }
  const objeto = valor as object;
  if (valor instanceof Date) {
    return Number.isNaN(valor.getTime()) ? null : valor.toISOString();
  }
  if (Prisma.Decimal.isDecimal(valor)) {
    return valor.toFixed(2);
  }
  if (Buffer.isBuffer(valor) || valor instanceof Uint8Array) {
    return '[binário]';
  }
  if (valor instanceof Error) {
    return { nome: valor.name, mensagem: valor.message };
  }
  if (vistos.has(objeto)) {
    return '[circular]';
  }
  if (profundidade >= PROFUNDIDADE_MAXIMA) {
    return '[…]';
  }
  vistos.add(objeto);
  try {
    if (Array.isArray(valor) || valor instanceof Set) {
      const itens = [...(valor as Iterable<unknown>)];
      const convertidos = itens
        .slice(0, ITENS_MAXIMOS_LISTA)
        .map((item) => converter(item, profundidade + 1, vistos) ?? null);
      if (itens.length > ITENS_MAXIMOS_LISTA) {
        convertidos.push(`[+${itens.length - ITENS_MAXIMOS_LISTA} itens]`);
      }
      return convertidos;
    }
    const entradas =
      valor instanceof Map
        ? [...valor.entries()].map(
            ([chave, item]) => [String(chave), item] as const,
          )
        : Object.entries(valor as Record<string, unknown>);
    const resultado: { [chave: string]: ValorJson } = {};
    for (const [chave, item] of entradas) {
      if (deveOmitir(chave, item)) {
        resultado[chave] = VALOR_OMITIDO;
        continue;
      }
      const convertido = converter(item, profundidade + 1, vistos);
      if (convertido !== undefined) {
        resultado[chave] = convertido;
      }
    }
    return resultado;
  } finally {
    vistos.delete(objeto);
  }
}

/** Uma alteração de campo, como vai para `dados.alteracoes` da auditoria. */
export interface Alteracao {
  antes: ValorJson;
  depois: ValorJson;
}

/**
 * Campos que mudaram entre `antes` e `depois` — o "antes/depois" da auditoria
 * (R3.1). Compara só os `campos` informados (ou todos os de `depois`), ignora
 * `atualizadoEm` e grava campos sensíveis sem valor (`[omitido]`).
 *
 * ```ts
 * dados: { alteracoes: calcularAlteracoes(negocioAntes, negocioDepois, ['valor', 'titulo']) }
 * ```
 */
export function calcularAlteracoes(
  antes: object | null | undefined,
  depois: object | null | undefined,
  campos?: readonly string[],
): Record<string, Alteracao> {
  const registroAntes = (antes ?? {}) as Record<string, unknown>;
  const registroDepois = (depois ?? {}) as Record<string, unknown>;
  const nomes =
    campos ??
    Object.keys(registroDepois).filter(
      (nome) => nome !== 'atualizadoEm' && nome !== 'criadoEm',
    );
  const alteracoes: Record<string, Alteracao> = {};
  for (const nome of nomes) {
    const valorAntes = converter(registroAntes[nome], 1, new WeakSet()) ?? null;
    const valorDepois =
      converter(registroDepois[nome], 1, new WeakSet()) ?? null;
    if (JSON.stringify(valorAntes) === JSON.stringify(valorDepois)) {
      continue;
    }
    alteracoes[nome] =
      deveOmitir(nome, registroAntes[nome]) ||
      deveOmitir(nome, registroDepois[nome])
        ? { antes: VALOR_OMITIDO, depois: VALOR_OMITIDO }
        : { antes: valorAntes, depois: valorDepois };
  }
  return alteracoes;
}
