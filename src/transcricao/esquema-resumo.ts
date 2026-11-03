/**
 * Saída estruturada do resumo da ligação (R30): assunto, pontos principais, combinados,
 * próximos passos, sentimento e sugestões de atividade. A API confere de novo o que voltou
 * (tipos, valores conhecidos, tamanhos) antes de gravar.
 */
import { RespostaInvalidaError } from '../bi/analise/esquema-analise';
import {
  SENTIMENTOS,
  type SentimentoDaLigacao,
  TIPOS_DE_SUGESTAO,
  type TipoDeSugestao,
} from './transcricao.constantes';

export const ESQUEMA_RESUMO_DE_LIGACAO = {
  type: 'object',
  additionalProperties: false,
  required: [
    'assunto',
    'pontosPrincipais',
    'combinados',
    'proximosPassos',
    'sentimento',
    'sentimentoMotivo',
    'sugestoesDeAtividade',
  ],
  properties: {
    assunto: {
      type: 'string',
      description: 'O assunto da ligação em uma frase curta.',
    },
    pontosPrincipais: {
      type: 'array',
      items: { type: 'string' },
      description: 'O que foi discutido, em frases curtas.',
    },
    combinados: {
      type: 'array',
      items: { type: 'string' },
      description:
        'O que as duas partes combinaram (valores, datas, condições). Vazio se nada foi combinado.',
    },
    proximosPassos: {
      type: 'array',
      items: { type: 'string' },
      description: 'O que cada lado vai fazer a seguir, dizendo quem.',
    },
    sentimento: { type: 'string', enum: [...SENTIMENTOS] },
    sentimentoMotivo: {
      type: 'string',
      description: 'Uma frase dizendo por que o cliente parece assim.',
    },
    sugestoesDeAtividade: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['titulo', 'descricao', 'tipo', 'prazoEmDias'],
        properties: {
          titulo: { type: 'string' },
          descricao: { type: 'string' },
          tipo: { type: 'string', enum: [...TIPOS_DE_SUGESTAO] },
          prazoEmDias: {
            type: 'integer',
            description: 'Em quantos dias a atividade vence (0 = hoje).',
          },
        },
      },
    },
  },
} as const;

export interface RespostaDoResumo {
  assunto: string;
  pontosPrincipais: string[];
  combinados: string[];
  proximosPassos: string[];
  sentimento: SentimentoDaLigacao;
  sentimentoMotivo: string;
  sugestoes: {
    titulo: string;
    descricao: string;
    tipo: TipoDeSugestao;
    prazoEmDias: number;
  }[];
}

const LIMITES = {
  assunto: 200,
  item: 400,
  itens: 10,
  motivo: 300,
  titulo: 160,
  descricao: 600,
  sugestoes: 5,
  prazoMaximoEmDias: 90,
} as const;

function cortar(texto: string, limite: number): string {
  const limpo = texto.trim();
  return limpo.length > limite ? `${limpo.slice(0, limite - 1)}…` : limpo;
}

function textoObrigatorio(valor: unknown, limite: number, campo: string) {
  if (typeof valor !== 'string' || valor.trim() === '') {
    throw new RespostaInvalidaError(`campo "${campo}" ausente ou vazio`);
  }
  return cortar(valor, limite);
}

function listaDeTextos(valor: unknown, campo: string): string[] {
  if (!Array.isArray(valor)) {
    throw new RespostaInvalidaError(`campo "${campo}" não é uma lista`);
  }
  return valor
    .filter((item): item is string => typeof item === 'string' && !!item.trim())
    .slice(0, LIMITES.itens)
    .map((item) => cortar(item, LIMITES.item));
}

/** Confere o JSON final do modelo. Lança `RespostaInvalidaError` (nova tentativa). */
export function conferirResumo(json: unknown): RespostaDoResumo {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new RespostaInvalidaError('a resposta não é um objeto');
  }
  const r = json as Record<string, unknown>;
  if (!SENTIMENTOS.includes(r.sentimento as SentimentoDaLigacao)) {
    throw new RespostaInvalidaError('sentimento desconhecido');
  }
  if (!Array.isArray(r.sugestoesDeAtividade)) {
    throw new RespostaInvalidaError('sugestões não é uma lista');
  }
  const sugestoes = r.sugestoesDeAtividade
    .filter(
      (s): s is Record<string, unknown> => typeof s === 'object' && s !== null,
    )
    .slice(0, LIMITES.sugestoes)
    .map((s) => {
      if (!TIPOS_DE_SUGESTAO.includes(s.tipo as TipoDeSugestao)) {
        throw new RespostaInvalidaError('tipo de sugestão desconhecido');
      }
      const prazo = Number(s.prazoEmDias);
      return {
        titulo: textoObrigatorio(s.titulo, LIMITES.titulo, 'titulo'),
        descricao:
          typeof s.descricao === 'string'
            ? cortar(s.descricao, LIMITES.descricao)
            : '',
        tipo: s.tipo as TipoDeSugestao,
        prazoEmDias: Number.isFinite(prazo)
          ? Math.min(LIMITES.prazoMaximoEmDias, Math.max(0, Math.round(prazo)))
          : 1,
      };
    });
  return {
    assunto: textoObrigatorio(r.assunto, LIMITES.assunto, 'assunto'),
    pontosPrincipais: listaDeTextos(r.pontosPrincipais, 'pontosPrincipais'),
    combinados: listaDeTextos(r.combinados, 'combinados'),
    proximosPassos: listaDeTextos(r.proximosPassos, 'proximosPassos'),
    sentimento: r.sentimento as SentimentoDaLigacao,
    sentimentoMotivo:
      typeof r.sentimentoMotivo === 'string'
        ? cortar(r.sentimentoMotivo, LIMITES.motivo)
        : '',
    sugestoes,
  };
}
