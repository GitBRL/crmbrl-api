/** Chatbot — fluxos em passos (R18, contrato da Onda B §2.4). */

/** Nome do destino de gatilhos do chatbot (`GatilhosService.registrarDestino`). */
export const DESTINO_DE_GATILHO_CHATBOT = 'chatbot';

/** Eventos do Atendimento que o chatbot acompanha. */
export const EVENTOS_ACOMPANHADOS_PELO_CHATBOT = [
  'mensagem.recebida',
  'mensagem.enviada',
  'conversa.atribuida',
  'conversa.transferida',
  'conversa.resolvida',
] as const;

/** Tentativas de resposta inválida antes de desistir da pergunta. */
export const TENTATIVAS_PADRAO_DA_PERGUNTA = 3;
export const TENTATIVAS_MAXIMAS_DA_PERGUNTA = 10;

/** Tempo máximo (minutos) de "sem resposta": 7 dias. */
export const TEMPO_MAXIMO_SEM_RESPOSTA_MINUTOS = 7 * 24 * 60;

/** Opções por pergunta (o WhatsApp mostra listas de até 10 itens). */
export const OPCOES_MINIMAS = 2;
export const OPCOES_MAXIMAS = 10;

/** Tamanho máximo do texto de uma mensagem do bot. */
export const TAMANHO_MAXIMO_DO_TEXTO = 4_000;

/** Passos por fluxo. */
export const PASSOS_MAXIMOS_POR_FLUXO = 150;

/** Versões publicadas guardadas por fluxo na listagem. */
export const PRAZO_DO_WEBHOOK_DO_BOT_MS = 8_000;

/** Motivos de fim da execução (`execucoes.motivo_fim`). */
export const MOTIVOS_DE_FIM = {
  ATENDENTE_ASSUMIU: 'atendente_assumiu',
  CONVERSA_RESOLVIDA: 'conversa_resolvida',
  CONVERSA_TRANSFERIDA: 'conversa_transferida',
  TRANSFERIDA: 'transferida_para_humano',
  SEM_RESPOSTA: 'sem_resposta',
  RESPOSTAS_INVALIDAS: 'respostas_invalidas',
  FLUXO_EXCLUIDO: 'fluxo_excluido',
  SIMULACAO_ENCERRADA: 'simulacao_encerrada',
} as const;

/** Prefixo das variáveis internas de controle dos passos (não aparecem no editor). */
export const PREFIXO_DE_ESTADO = '__';
