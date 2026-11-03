import { NOTIFICACAO_DE_MENCAO } from '../chat-interno/regras-chat';
import { TIPOS_NOTIFICACAO_ATENDIMENTO } from '../atendimento/atendimento.constantes';
import {
  TIPO_NOTIFICACAO_LIGACAO,
  TIPO_NOTIFICACAO_PROMESSA,
} from '../financeiro/regua-ligacoes.service';
import { TIPOS_NOTIFICACAO_LIGACAO } from '../ligacoes/ligacoes.constantes';
import { TIPOS_NOTIFICACAO } from '../notificacoes/tipos-notificacao';

/** Regra de negócio das notificações push (REGRAS-DE-NEGOCIO, R26). */
export const REGRA_PUSH = 'R26';

/** Fila dos envios: um job por notificação e aparelho. */
export const FILA_PUSH = 'push.enviar';

/** No máximo estes aparelhos por pessoa; ao passar, o mais antigo é removido. */
export const MAX_INSCRICOES_POR_USUARIO = 20;

/** Prazo de cada envio ao serviço de push do navegador. */
export const PRAZO_DO_ENVIO_MS = 10_000;

/** Quanto o serviço de push guarda a mensagem se o aparelho estiver desligado (segundos). */
export const VALIDADE_DO_PUSH_S = 60 * 60;

/** Tipos de preferência (o que a pessoa liga e desliga). */
export const TIPOS_DE_PREFERENCIA = [
  'conversa_atribuida',
  'mencao',
  'atividade_vencendo',
  'sla_estourado',
  'negocio_atribuido',
  'parcela_atrasada',
  'ligacao_recebida',
] as const;

export type TipoDePreferencia = (typeof TIPOS_DE_PREFERENCIA)[number];

/**
 * Qual preferência governa cada tipo de notificação interna (R26). Tipos que não
 * estão aqui (aviso de webhook, campanhas, nota interna…) não geram push.
 */
export const PREFERENCIA_POR_TIPO_DE_NOTIFICACAO: Readonly<
  Record<string, TipoDePreferencia>
> = {
  [TIPOS_NOTIFICACAO_ATENDIMENTO.CONVERSA_ATRIBUIDA]: 'conversa_atribuida',
  [TIPOS_NOTIFICACAO_ATENDIMENTO.CONVERSA_TRANSFERIDA]: 'conversa_atribuida',
  [TIPOS_NOTIFICACAO_ATENDIMENTO.CONVERSAS_ENCAMINHADAS]: 'conversa_atribuida',
  [NOTIFICACAO_DE_MENCAO]: 'mencao',
  [TIPOS_NOTIFICACAO.ATIVIDADE_VENCENDO]: 'atividade_vencendo',
  [TIPOS_NOTIFICACAO.ATIVIDADE_ATRASADA]: 'atividade_vencendo',
  [TIPOS_NOTIFICACAO_ATENDIMENTO.SLA_PRIMEIRA_RESPOSTA]: 'sla_estourado',
  [TIPOS_NOTIFICACAO_ATENDIMENTO.SLA_RESOLUCAO]: 'sla_estourado',
  [TIPOS_NOTIFICACAO.NEGOCIO_ATRIBUIDO]: 'negocio_atribuido',
  [TIPOS_NOTIFICACAO.PASSAGEM_RECEBIDA]: 'negocio_atribuido',
  [TIPO_NOTIFICACAO_PROMESSA]: 'parcela_atrasada',
  [TIPO_NOTIFICACAO_LIGACAO]: 'parcela_atrasada',
  // Onda E (R29): ligação do WhatsApp tocando ou perdida.
  [TIPOS_NOTIFICACAO_LIGACAO.TOCANDO]: 'ligacao_recebida',
  [TIPOS_NOTIFICACAO_LIGACAO.PERDIDA]: 'ligacao_recebida',
};

/** Rota do front aberta quando a notificação não tem `link`. */
export const URL_PADRAO_DO_PUSH = '/notificacoes';

/** Carga do push (JSON), combinada com o front. */
export interface CargaDoPush {
  titulo: string;
  corpo: string;
  /** Rota do front a abrir no clique. */
  url: string;
  /** Mensagens com a mesma tag substituem a anterior no aparelho. */
  tag: string;
  notificacaoId: string | null;
  /** Botões da notificação (ex.: "Abrir ligação"); o clique em qualquer um abre `url`. */
  acoes?: Array<{ acao: string; titulo: string }>;
  /** A notificação não some sozinha (ligação tocando). */
  persistente?: boolean;
}
