/**
 * SDR com IA (Onda G, R31): nomes estáveis, modelos aceitos, limites e padrões.
 * O que o Admin muda fica nas tabelas `sdr_*` (configuração, canais, base de
 * conhecimento, critérios).
 */
import type { TipoCanal } from '../generated/prisma/client';

/** Código da regra (vai em `detalhes.regra`, nunca no texto). */
export const REGRA_SDR = 'R31';

/** Fila dos turnos da IA: um job por mensagem do lead, com a espera de agrupamento. */
export const FILA_TURNO_SDR = 'sdr.turno';

/** Canais em que o SDR pode atuar (e-mail fica fora). */
export const TIPOS_DE_CANAL_COM_SDR: readonly TipoCanal[] = [
  'WHATSAPP',
  'WHATSAPP_OFICIAL',
  'WEBCHAT',
  'INSTAGRAM',
  'MESSENGER',
];

/** Modelos aceitos para o SDR, com o que cada um aceita da API. */
export interface ModeloDoSdr {
  id: string;
  rotulo: string;
  /** Aceita `fallbacks: "default"` (refazer a chamada se a política recusar). */
  recuo: boolean;
}

export const MODELOS_DO_SDR: readonly ModeloDoSdr[] = [
  { id: 'claude-sonnet-5-5', rotulo: 'Claude Sonnet 5.5', recuo: true },
  { id: 'claude-opus-5-5', rotulo: 'Claude Opus 5.5', recuo: true },
  { id: 'claude-sonnet-5', rotulo: 'Claude Sonnet 5', recuo: false },
  { id: 'claude-haiku-5-5', rotulo: 'Claude Haiku 5.5', recuo: false },
];
export const MODELO_PADRAO_DO_SDR = 'claude-sonnet-5-5';

/** Esforço do raciocínio (`output_config.effort`): conversa de chat pede pouco. */
export const ESFORCOS_DO_SDR = ['low', 'medium', 'high'] as const;
export type EsforcoDoSdr = (typeof ESFORCOS_DO_SDR)[number];

/** Teto de tokens de saída por turno (raciocínio incluído). */
export const MAX_TOKENS_DO_TURNO = 8000;

/** Limites da configuração (a tela valida igual). */
export const LIMITES_DO_SDR = {
  nomeAssistente: { min: 2, max: 40 },
  tom: { min: 3, max: 400 },
  apresentacao: { min: 5, max: 300 },
  mensagemPassagem: { min: 5, max: 500 },
  esperaAgrupamentoSegundos: { min: 0, max: 60 },
  maxMensagensPorConversa: { min: 1, max: 200 },
  maxMensagensSemAvanco: { min: 1, max: 50 },
  maxTokensPorConversa: { min: 10_000, max: 5_000_000 },
  orcamentoMensalTokens: { min: 100_000, max: 2_000_000_000 },
  nota: { min: 0, max: 100 },
  artigoTitulo: { min: 2, max: 120 },
  artigoConteudo: { min: 1, max: 20_000 },
  artigos: 100,
  criterioChave: { min: 2, max: 40 },
  criterioRotulo: { min: 2, max: 80 },
  criterioInstrucao: { min: 3, max: 600 },
  criterioOpcoes: 20,
  criterioOpcao: 80,
  criterios: 30,
  peso: { min: 1, max: 100 },
} as const;

/** Tamanhos do que vai e volta do modelo. */
export const MAX_CARACTERES_RESPOSTA_SDR = 1500;
export const MAX_CARACTERES_MOTIVO_SDR = 300;
export const MAX_CARACTERES_RESUMO_SDR = 1200;
export const MAX_CARACTERES_VALOR_SDR = 300;
export const MENSAGENS_NO_HISTORICO = 40;
export const MAX_CARACTERES_MENSAGEM_NO_HISTORICO = 1500;
export const MAX_CARACTERES_ARTIGO_NO_PROMPT = 20_000;

/** O turno em andamento mais antigo que isto é tratado como abandonado (a trava vence). */
export const TRAVA_DO_TURNO_MS = 4 * 60_000;

/** Vezes que um job espera mais mensagens do lead ou a trava antes de seguir. */
export const MAX_ADIAMENTOS_DO_TURNO = 6;

/** Espera para tentar de novo quando a trava da conversa está ocupada. */
export const ESPERA_DA_TRAVA_SEGUNDOS = 5;

/** Tentativas do job do turno (falha passageira da IA) e espera inicial. */
export const TENTATIVAS_DO_TURNO = 3;
export const ESPERA_ENTRE_TENTATIVAS_SEGUNDOS = 20;

/** Pausa de "digitando…" antes de enviar (por caractere; mínimo e máximo). */
export const DIGITANDO_POR_CARACTERE_MS = 18;
export const DIGITANDO_MINIMO_MS = 600;
export const DIGITANDO_MAXIMO_MS = 3500;

/** Avisos do orçamento mensal: percentuais que avisam o Admin (uma vez por mês cada). */
export const PERCENTUAIS_DE_AVISO = [80, 100] as const;

/** Mensagens de interface (sempre em português, sem código de regra). */
export const AVISO_DO_SIMULADOR =
  'O simulador usa a configuração atual, não envia nada a ninguém e não grava no contato. Os tokens contam no orçamento do mês.';

/** Regras de passagem para humano (padrão). */
export interface RegrasDePassagem {
  /** O lead pede uma pessoa. */
  pedidoHumano: boolean;
  /** Assunto sensível ou fora do escopo (saúde, jurídico, dados pessoais, pedidos de exceção). */
  assuntoSensivel: boolean;
  /** A IA não tem confiança no que o lead quis dizer ou na própria resposta. */
  baixaConfianca: boolean;
  /** Confiança mínima (0 a 1) para gravar um critério e para qualificar. */
  confiancaMinima: number;
  /** Limite de mensagens sem avanço na qualificação. */
  semAvanco: boolean;
  /** O lead reclama ou está insatisfeito. */
  reclamacao: boolean;
}

export const REGRAS_DE_PASSAGEM_PADRAO: RegrasDePassagem = {
  pedidoHumano: true,
  assuntoSensivel: true,
  baixaConfianca: true,
  confiancaMinima: 0.4,
  semAvanco: true,
  reclamacao: true,
};

/** Tipos de notificação do SDR (o front escolhe o ícone pelo prefixo `sdr.`). */
export const TIPOS_NOTIFICACAO_SDR = {
  /** Vendedor: lead qualificado pela IA, com o resumo. */
  LEAD_QUALIFICADO: 'sdr.lead_qualificado',
  /** Responsável da conversa: a IA passou a conversa para uma pessoa. */
  PASSOU_PARA_HUMANO: 'sdr.passou_para_humano',
  /** Admin: o orçamento de tokens chegou a 80% ou a 100%. */
  ORCAMENTO: 'sdr.orcamento',
  /** Admin: a IA não consegue responder (chave recusada). */
  FALHA: 'sdr.falha',
} as const;

/** Eventos de domínio do SDR (outbox; usados também pelas automações e webhooks da G3). */
export const EVENTOS_DO_SDR = {
  /** Lead qualificado pela IA e passado ao Comercial. */
  LEAD_QUALIFICADO: 'sdr.lead_qualificado',
  /** A IA passou a conversa para uma pessoa. */
  PASSOU_PARA_HUMANO: 'sdr.passou_para_humano',
  /** A IA desqualificou o lead. */
  LEAD_DESQUALIFICADO: 'sdr.lead_desqualificado',
} as const;

/** Rótulos das situações (a tela usa os mesmos). */
export const ROTULO_DA_SITUACAO_SDR = {
  ATIVA: 'IA atendendo',
  HUMANO: 'Com uma pessoa',
  PASSADA_HUMANO: 'Passada para a equipe',
  QUALIFICADA: 'Qualificada',
  DESQUALIFICADA: 'Desqualificada',
  ENCERRADA: 'Encerrada',
} as const;

/** Rota da conversa no front. */
export function linkDaConversaSdr(conversaId: string): string {
  return `/atendimento/${conversaId}`;
}
