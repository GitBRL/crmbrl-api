/**
 * Saída estruturada do SDR (R31), no mesmo mecanismo do assistente
 * (`output_config.format` com esquema JSON). O esquema se chama `turno_sdr`
 * (`title`): é por esse nome que a Anthropic falsa do ambiente dos agentes
 * reconhece o pedido do SDR. `resposta` vem primeiro para o texto se formar
 * antes do resto. A API confere de novo tudo o que volta antes de usar.
 */
import type { AcaoSdr } from '../generated/prisma/client';
import { RespostaInvalidaError } from '../bi/analise/esquema-analise';
import {
  MAX_CARACTERES_MOTIVO_SDR,
  MAX_CARACTERES_RESPOSTA_SDR,
  MAX_CARACTERES_RESUMO_SDR,
} from './sdr.constantes';
import type { CriterioDaIa } from './qualificacao';

export const NOME_DO_ESQUEMA_DO_SDR = 'turno_sdr';

export const ACOES_DA_IA = [
  'continuar',
  'qualificado',
  'desqualificado',
  'passar_humano',
] as const;
export type AcaoDaIa = (typeof ACOES_DA_IA)[number];

export const ESQUEMA_TURNO_SDR = {
  title: NOME_DO_ESQUEMA_DO_SDR,
  type: 'object',
  additionalProperties: false,
  required: ['resposta', 'criterios', 'acao', 'motivo', 'resumo'],
  properties: {
    resposta: {
      type: 'string',
      description:
        'O texto que o lead vai ler: curto, no tom de uma conversa de chat.',
    },
    criterios: {
      type: 'array',
      description:
        'Só os critérios que o lead informou ou deixou claro NESTE turno (lista vazia se nenhum).',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['chave', 'valor', 'confianca'],
        properties: {
          chave: {
            type: 'string',
            description: 'A chave exata do critério (linha CRITERIOS).',
          },
          valor: {
            type: 'string',
            description:
              'O valor no formato do tipo: texto, uma das opções, número, data AAAA-MM-DD ou sim/não.',
          },
          confianca: {
            type: 'number',
            description: 'De 0 a 1: quanta certeza você tem desse valor.',
          },
        },
      },
    },
    acao: { type: 'string', enum: [...ACOES_DA_IA] },
    motivo: {
      type: 'string',
      description:
        'Uma frase curta que explica a decisão (a equipe lê na linha do tempo).',
    },
    resumo: {
      type: 'string',
      description:
        'Resumo da conversa para quem vai assumir: quem é o lead, o que quer, o que foi descoberto e o que falta.',
    },
  },
} as const;

/** O turno já conferido. */
export interface TurnoDoSdr {
  resposta: string;
  criterios: CriterioDaIa[];
  acao: AcaoSdr;
  motivo: string;
  resumo: string;
}

const ACAO_PARA_ENUM: Readonly<Record<AcaoDaIa, AcaoSdr>> = {
  continuar: 'CONTINUAR',
  qualificado: 'QUALIFICADO',
  desqualificado: 'DESQUALIFICADO',
  passar_humano: 'PASSAR_HUMANO',
};

function cortar(texto: string, limite: number): string {
  const limpo = texto.trim();
  return limpo.length > limite ? `${limpo.slice(0, limite - 1)}…` : limpo;
}

/** Confere o JSON final do modelo. Lança `RespostaInvalidaError` (nova tentativa). */
export function conferirTurnoDoSdr(json: unknown): TurnoDoSdr {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new RespostaInvalidaError('a resposta não é um objeto');
  }
  const r = json as Record<string, unknown>;
  if (typeof r.acao !== 'string' || !(r.acao in ACAO_PARA_ENUM)) {
    throw new RespostaInvalidaError('ação desconhecida');
  }
  const acao = ACAO_PARA_ENUM[r.acao as AcaoDaIa];
  if (typeof r.resposta !== 'string') {
    throw new RespostaInvalidaError('resposta ausente');
  }
  if (!r.resposta.trim() && acao !== 'PASSAR_HUMANO') {
    throw new RespostaInvalidaError('resposta vazia');
  }
  if (!Array.isArray(r.criterios)) {
    throw new RespostaInvalidaError('criterios não é uma lista');
  }
  const criterios: CriterioDaIa[] = [];
  for (const item of r.criterios.slice(0, 50)) {
    if (typeof item !== 'object' || item === null) {
      continue;
    }
    const c = item as Record<string, unknown>;
    if (typeof c.chave !== 'string' || !c.chave.trim()) {
      continue;
    }
    const valor =
      typeof c.valor === 'string'
        ? c.valor
        : typeof c.valor === 'number' || typeof c.valor === 'boolean'
          ? String(c.valor)
          : '';
    criterios.push({
      chave: c.chave,
      valor,
      confianca: typeof c.confianca === 'number' ? c.confianca : 0,
    });
  }
  return {
    resposta: cortar(r.resposta, MAX_CARACTERES_RESPOSTA_SDR),
    criterios,
    acao,
    motivo: cortar(
      typeof r.motivo === 'string' ? r.motivo : '',
      MAX_CARACTERES_MOTIVO_SDR,
    ),
    resumo: cortar(
      typeof r.resumo === 'string' ? r.resumo : '',
      MAX_CARACTERES_RESUMO_SDR,
    ),
  };
}
