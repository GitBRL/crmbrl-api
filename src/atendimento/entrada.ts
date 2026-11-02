/**
 * Formatos de entrada do Atendimento (§4 do contrato da Onda A): o que cada
 * módulo de canal entrega ao `AtendimentoService` depois de normalizar o que
 * chegou do provedor.
 */
import { normalizarEmail } from '../comum/dominio/email';
import { normalizarTelefone } from '../comum/dominio/telefone';
import type {
  OrigemContato,
  StatusMensagem,
  TipoCanal,
  TipoIdentificador,
  TipoMensagem,
} from '../generated/prisma/client';

/** Quem mandou a mensagem, como o canal o identifica. */
export interface RemetenteDaEntrada {
  /** Tipo do identificador (`WHATSAPP`, `EMAIL`, `INSTAGRAM`…). */
  tipo: TipoIdentificador;
  /**
   * Valor no canal: telefone (qualquer formato; vira E.164 só com dígitos),
   * e-mail (vira minúsculas), IGSID/PSID ou o id do visitante do chat do site.
   */
  valor: string;
  /** Nome de exibição (pushName do WhatsApp, nome do remetente do e-mail…). */
  nome?: string;
  /** Telefone conhecido além do identificador (ex.: informado no formulário do chat do site). */
  telefone?: string;
  /** E-mail conhecido além do identificador. */
  email?: string;
}

/** A mensagem recebida. */
export interface MensagemDaEntrada {
  /** Id no provedor: torna a entrada idempotente (único por canal). */
  idExterno?: string;
  tipo: TipoMensagem;
  /** Texto puro (o e-mail chega aqui como texto, nunca HTML). */
  texto?: string;
  /** Mídia já salva pelo canal com `ArquivosService.salvar` (contexto `MENSAGEM`). */
  arquivoId?: string;
  /** Id externo da mensagem citada, se for resposta. */
  respondeAIdExterno?: string;
  /** Horário do provedor. */
  recebidaEm: Date;
  /** Detalhes por tipo (localização, vcard, reação, cabeçalhos do e-mail…). */
  metadados?: Record<string, unknown>;
}

/** `AtendimentoService.receber(entrada)` — chamado pelos canais na entrada. */
export interface EntradaDeAtendimento {
  canalId: string;
  remetente: RemetenteDaEntrada;
  /** Id da conversa no provedor (jid, Message-ID da raiz do e-mail, id da conversa da Meta…). */
  idExternoConversa?: string;
  /** Assunto (e-mail). */
  assunto?: string;
  mensagem: MensagemDaEntrada;
}

export interface ResultadoDaEntrada {
  conversaId: string;
  mensagemId: string;
  /** `false` quando a mensagem já tinha sido recebida (mesmo `idExterno` no canal). */
  nova: boolean;
}

/** Status que um canal informa para uma mensagem de saída (`atualizarStatus`). */
export type StatusDeEntrega = Extract<
  StatusMensagem,
  'ENVIADA' | 'ENTREGUE' | 'LIDA' | 'FALHOU'
>;

/** Ordem do status de entrega: só avança (um "entregue" atrasado não desfaz o "lida"). */
export const ORDEM_DO_STATUS: Readonly<Record<StatusMensagem, number>> = {
  PENDENTE: 0,
  ENVIADA: 1,
  ENTREGUE: 2,
  LIDA: 3,
  FALHOU: -1,
};

/** Origem do contato criado por uma mensagem que chega pelo canal (R4.3). */
export const ORIGEM_DO_CANAL: Readonly<Record<TipoCanal, OrigemContato>> = {
  WHATSAPP: 'WHATSAPP',
  WEBCHAT: 'SITE',
  EMAIL: 'EMAIL',
  INSTAGRAM: 'INSTAGRAM',
  MESSENGER: 'MESSENGER',
  WHATSAPP_OFICIAL: 'WHATSAPP',
};

/**
 * Valor do identificador normalizado como o banco exige (CHECK): telefone do
 * WhatsApp em E.164 só com dígitos, e-mail em minúsculas, o resto aparado.
 * Lança `TypeError` com o motivo se o valor não serve.
 */
export function normalizarIdentificador(
  tipo: TipoIdentificador,
  valor: string,
): string {
  const texto = valor.trim();
  if (texto === '') {
    throw new TypeError('Identificador vazio.');
  }
  if (tipo === 'WHATSAPP') {
    const telefone = normalizarTelefone(texto);
    if (!telefone.valido) {
      throw new TypeError(telefone.motivo);
    }
    return telefone.telefone;
  }
  if (tipo === 'EMAIL') {
    return normalizarEmail(texto);
  }
  return texto;
}
