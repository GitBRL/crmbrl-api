/**
 * Saída estruturada do assistente (R25): `{resposta, resolvido, categoria,
 * resumoDoPedido}`. `resposta` vem primeiro no esquema para o streaming
 * mostrar o texto enquanto o JSON se forma. A API confere de novo o que voltou
 * (tipos, categoria conhecida, tamanhos) antes de gravar e devolver.
 */
import { RespostaInvalidaError } from '../bi/analise/esquema-analise';
import {
  CATEGORIAS,
  type Categoria,
  MAX_CARACTERES_RESPOSTA,
  MAX_CARACTERES_RESUMO,
} from './assistente.constantes';
import type { RespostaDoAssistente } from './prompt-assistente';

export const ESQUEMA_RESPOSTA_ASSISTENTE = {
  type: 'object',
  additionalProperties: false,
  required: ['resposta', 'resolvido', 'categoria', 'resumoDoPedido'],
  properties: {
    resposta: {
      type: 'string',
      description: 'O texto que a pessoa vai ler (Markdown simples).',
    },
    resolvido: {
      type: 'boolean',
      description: 'A resposta resolve o que a pessoa pediu.',
    },
    categoria: { type: 'string', enum: [...CATEGORIAS] },
    resumoDoPedido: {
      type: 'string',
      description:
        'Uma frase curta, sem dados pessoais, do que a pessoa quer (título de chamado e agrupamento de temas).',
    },
  },
} as const;

function cortar(texto: string, limite: number): string {
  const limpo = texto.trim();
  return limpo.length > limite ? `${limpo.slice(0, limite - 1)}…` : limpo;
}

/** Confere o JSON final do modelo. Lança `RespostaInvalidaError` (nova tentativa). */
export function conferirRespostaDoAssistente(
  json: unknown,
): RespostaDoAssistente {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new RespostaInvalidaError('a resposta não é um objeto');
  }
  const r = json as Record<string, unknown>;
  if (typeof r.resposta !== 'string' || !r.resposta.trim()) {
    throw new RespostaInvalidaError('resposta vazia');
  }
  if (typeof r.resolvido !== 'boolean') {
    throw new RespostaInvalidaError('resolvido não é booleano');
  }
  if (
    typeof r.categoria !== 'string' ||
    !CATEGORIAS.includes(r.categoria as Categoria)
  ) {
    throw new RespostaInvalidaError('categoria desconhecida');
  }
  if (typeof r.resumoDoPedido !== 'string') {
    throw new RespostaInvalidaError('resumoDoPedido ausente');
  }
  return {
    resposta: cortar(r.resposta, MAX_CARACTERES_RESPOSTA),
    resolvido: r.resolvido,
    categoria: r.categoria as Categoria,
    resumoDoPedido: cortar(r.resumoDoPedido, MAX_CARACTERES_RESUMO),
  };
}

/**
 * O texto da resposta já formado no JSON parcial do streaming (ou `null`).
 * O `partialParse` do SDK descarta textos ainda abertos; aqui o valor de
 * `"resposta"` é lido até onde chegou, sem um escape cortado no fim.
 */
export function respostaParcial(acumulado: string): string | null {
  const abertura = /"resposta"\s*:\s*"/.exec(acumulado);
  if (!abertura) {
    return null;
  }
  const inicio = abertura.index + abertura[0].length;
  let fim = inicio;
  while (fim < acumulado.length) {
    const c = acumulado[fim];
    if (c === '\\') {
      fim += 2;
      continue;
    }
    if (c === '"') {
      break;
    }
    fim++;
  }
  let trecho = acumulado.slice(inicio, Math.min(fim, acumulado.length));
  // Escape incompleto no fim (`\`, `\u00`): espera o resto.
  trecho = trecho.replace(/\\(u[0-9a-fA-F]{0,3})?$/, '');
  try {
    const texto = JSON.parse(`"${trecho}"`) as string;
    return texto || null;
  } catch {
    return null;
  }
}
