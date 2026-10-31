/**
 * Formato da resposta do Claude (R21): o mesmo JSON Schema na análise e nas
 * perguntas de acompanhamento (o esquema faz parte do prefixo em cache), mais
 * a conferência do que voltou — a saída estruturada garante o formato, mas a
 * API confere de novo e corta textos longos antes de gravar e devolver.
 */

export type Tendencia = 'positiva' | 'negativa' | 'neutra';
export type Nivel = 'alta' | 'media' | 'baixa';

export interface DestaqueModelo {
  titulo: string;
  detalhe: string;
  tendencia: Tendencia;
}

export interface RiscoModelo {
  titulo: string;
  detalhe: string;
  gravidade: Nivel;
}

export interface AcaoModelo {
  titulo: string;
  detalhe: string;
  prioridade: Nivel;
  /** Caminho do front com a consulta, ex.: `/funis/comercial?etapaId=…`. */
  link: string;
  rotuloLink: string;
}

/** O que o modelo devolve (antes de conferir os links). */
export interface RespostaModelo {
  resumo: string;
  destaques: DestaqueModelo[];
  riscos: RiscoModelo[];
  acoes: AcaoModelo[];
}

const TEXTO = { type: 'string' } as const;
const NIVEL = { type: 'string', enum: ['alta', 'media', 'baixa'] } as const;

/** JSON Schema de `output_config.format` (sem restrições numéricas nem de tamanho, que a API não aceita). */
export const ESQUEMA_RESPOSTA = {
  type: 'object',
  additionalProperties: false,
  required: ['resumo', 'destaques', 'riscos', 'acoes'],
  properties: {
    resumo: {
      type: 'string',
      description:
        'Na análise: visão geral em 2 a 4 frases. Na pergunta de acompanhamento: a resposta direta à pergunta.',
    },
    destaques: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['titulo', 'detalhe', 'tendencia'],
        properties: {
          titulo: TEXTO,
          detalhe: TEXTO,
          tendencia: {
            type: 'string',
            enum: ['positiva', 'negativa', 'neutra'],
          },
        },
      },
    },
    riscos: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['titulo', 'detalhe', 'gravidade'],
        properties: { titulo: TEXTO, detalhe: TEXTO, gravidade: NIVEL },
      },
    },
    acoes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['titulo', 'detalhe', 'prioridade', 'link', 'rotuloLink'],
        properties: {
          titulo: TEXTO,
          detalhe: TEXTO,
          prioridade: NIVEL,
          link: {
            type: 'string',
            description:
              'Caminho de uma das rotas permitidas, com a consulta, ex.: /funis/comercial?etapaId=<id>.',
          },
          rotuloLink: TEXTO,
        },
      },
    },
  },
} as const;

/** Respostas com formato errado (o modelo recusou, cortou ou a API falsa errou). */
export class RespostaInvalidaError extends Error {}

const LIMITES = {
  resumo: 2000,
  titulo: 160,
  detalhe: 800,
  rotulo: 80,
  link: 600,
  itens: 8,
} as const;

function texto(valor: unknown, limite: number, campo: string): string {
  if (typeof valor !== 'string' || valor.trim() === '') {
    throw new RespostaInvalidaError(`campo "${campo}" ausente ou vazio`);
  }
  const limpo = valor.trim();
  return limpo.length > limite ? `${limpo.slice(0, limite - 1)}…` : limpo;
}

function opcao<T extends string>(
  valor: unknown,
  opcoes: readonly T[],
  padrao: T,
): T {
  return opcoes.includes(valor as T) ? (valor as T) : padrao;
}

function lista(valor: unknown, campo: string): Record<string, unknown>[] {
  if (!Array.isArray(valor)) {
    throw new RespostaInvalidaError(`campo "${campo}" não é uma lista`);
  }
  return valor
    .filter(
      (item): item is Record<string, unknown> =>
        typeof item === 'object' && item !== null,
    )
    .slice(0, LIMITES.itens);
}

const NIVEIS: readonly Nivel[] = ['alta', 'media', 'baixa'];

/** Confere o JSON do modelo e corta textos longos. Lança `RespostaInvalidaError`. */
export function conferirResposta(json: unknown): RespostaModelo {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new RespostaInvalidaError('a resposta não é um objeto');
  }
  const r = json as Record<string, unknown>;
  return {
    resumo: texto(r.resumo, LIMITES.resumo, 'resumo'),
    destaques: lista(r.destaques, 'destaques').map((d) => ({
      titulo: texto(d.titulo, LIMITES.titulo, 'destaques.titulo'),
      detalhe: texto(d.detalhe, LIMITES.detalhe, 'destaques.detalhe'),
      tendencia: opcao<Tendencia>(
        d.tendencia,
        ['positiva', 'negativa', 'neutra'],
        'neutra',
      ),
    })),
    riscos: lista(r.riscos, 'riscos').map((d) => ({
      titulo: texto(d.titulo, LIMITES.titulo, 'riscos.titulo'),
      detalhe: texto(d.detalhe, LIMITES.detalhe, 'riscos.detalhe'),
      gravidade: opcao<Nivel>(d.gravidade, NIVEIS, 'media'),
    })),
    acoes: lista(r.acoes, 'acoes').map((d) => ({
      titulo: texto(d.titulo, LIMITES.titulo, 'acoes.titulo'),
      detalhe: texto(d.detalhe, LIMITES.detalhe, 'acoes.detalhe'),
      prioridade: opcao<Nivel>(d.prioridade, NIVEIS, 'media'),
      link: typeof d.link === 'string' ? d.link.slice(0, LIMITES.link) : '',
      rotuloLink:
        typeof d.rotuloLink === 'string' && d.rotuloLink.trim()
          ? d.rotuloLink.trim().slice(0, LIMITES.rotulo)
          : 'Ver a lista',
    })),
  };
}
