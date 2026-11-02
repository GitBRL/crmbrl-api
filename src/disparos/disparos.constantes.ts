/** Disparos — campanhas de WhatsApp e e-mail (R17, contrato da Onda B §2.3). */

/** Código da regra de Disparos (vai em `detalhes.regra`, nunca no texto). */
export const REGRA_DISPAROS = 'R17';

/** Fila do envio de uma campanha (`{ campanhaId }`, com `startAfter` para o ritmo). */
export const FILA_DISPAROS_ENVIAR = 'disparos.enviar';

/** Varredura a cada minuto: ativa campanhas agendadas, retoma as paradas e sincroniza os status. */
export const FILA_DISPAROS_VARREDURA = 'disparos.varredura';

/** Chave da configuração do módulo em `configuracoes`. */
export const CHAVE_CONFIGURACAO_DISPAROS = 'disparos';

/** Palavras de saída padrão (opt-out, R4.6), comparadas sem acento nem caixa. */
export const PALAVRAS_DE_SAIDA_PADRAO = ['SAIR', 'PARAR', 'CANCELAR'] as const;

/** Resposta enviada depois de aplicar o opt-out (configurável). */
export const MENSAGEM_DE_SAIDA_PADRAO =
  'Pronto! Você não receberá mais mensagens de campanhas. Se mudar de ideia, é só nos avisar por aqui.';

/** Até quantos dias depois do envio uma resposta conta como resposta à campanha. */
export const JANELA_DE_RESPOSTA_DIAS = 7;

/** Até quantos dias depois do envio uma palavra de saída vale como opt-out. */
export const JANELA_DE_SAIDA_DIAS = 30;

/** Mensagem sem confirmação do gateway por tanto tempo vira falha. */
export const PRAZO_SEM_CONFIRMACAO_HORAS = 6;

/** Teto de destinatários inválidos/excluídos processados numa só rodada de envio. */
export const LIMITE_DE_PULOS_POR_RODADA = 50;

/** Espera entre as conferências enquanto o gateway não confirma as mensagens (s). */
export const ESPERA_DE_CONFIRMACAO_SEGUNDOS = 15;

/** Espera quando nenhum número está disponível (s); cada espera conta como falha seguida. */
export const ESPERA_SEM_CANAL_SEGUNDOS = 60;

/** Quantas campanhas por página nas listas. */
export const TAMANHO_DO_LOTE_DO_PUBLICO = 500;

/** Tipos de notificação de campanha (o front escolhe o ícone pelo prefixo `campanha.`). */
export const TIPOS_NOTIFICACAO_DISPAROS = {
  PAUSADA: 'campanha.pausada',
  CONCLUIDA: 'campanha.concluida',
  APROVACAO_PEDIDA: 'campanha.aprovacao_pedida',
  APROVADA: 'campanha.aprovada',
  REPROVADA: 'campanha.reprovada',
} as const;

/** Rota da campanha no front. */
export function linkDaCampanha(campanhaId: string): string {
  return `/disparos/${campanhaId}`;
}
