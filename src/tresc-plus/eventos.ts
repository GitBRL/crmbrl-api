/**
 * Eventos do socket do 3C+ (R34.4): normalização do envelope, leitura dos campos e mapeamento para o
 * estado da ligação e do agente. Funções puras, testadas em `eventos.spec.ts`.
 *
 * O formato do envelope e dos payloads é lacuna da referência (§5, §11.1): a leitura é tolerante e o
 * formato do envelope é configurável (`AUTO`, `EVENTO_DADOS`, `OBJETO`).
 */
import type { DirecaoLigacao, EstadoLigacao } from '../generated/prisma/client';
import { comoObjeto, numeroDe, textoDe } from './cliente-tresc-plus';
import {
  EVENTO_HISTORICO,
  EVENTOS_DE_AGENTE,
  EVENTOS_DE_CHAMADA,
  type EstadoDoAgente,
  type FormatoDeEnvelope,
} from './tresc-plus.constantes';
import { lerIdentifier, telefoneDoTresc } from './telefone';

export interface EventoNormalizado {
  tipo: string;
  dados: Record<string, unknown>;
}

const CONHECIDOS: ReadonlySet<string> = new Set([
  ...EVENTOS_DE_CHAMADA,
  ...EVENTOS_DE_AGENTE,
  EVENTO_HISTORICO,
]);

export function ehEventoConhecido(tipo: string): boolean {
  return CONHECIDOS.has(tipo);
}

/**
 * Transforma o que chegou no socket em `{tipo, dados}`.
 * - `OBJETO`: o nome do evento do socket é o tipo e o primeiro argumento são os dados;
 * - `EVENTO_DADOS`: o argumento é `{event|type|name, data|payload}` (de qualquer evento do socket);
 * - `AUTO`: se o nome do evento do socket é um tipo conhecido, como `OBJETO`; senão tenta `EVENTO_DADOS`.
 */
export function normalizarEvento(
  nome: string,
  argumentos: readonly unknown[],
  formato: FormatoDeEnvelope = 'AUTO',
): EventoNormalizado | null {
  const primeiro = comoObjeto(argumentos[0]);
  const comoObjetoDireto = (): EventoNormalizado | null => {
    if (!CONHECIDOS.has(nome)) return null;
    return { tipo: nome, dados: primeiro ?? {} };
  };
  const comoEnvelope = (): EventoNormalizado | null => {
    if (!primeiro) return null;
    const tipo =
      textoDe(primeiro.event) ??
      textoDe(primeiro.type) ??
      textoDe(primeiro.name);
    if (!tipo || !CONHECIDOS.has(tipo)) return null;
    const interno = comoObjeto(primeiro.data) ?? comoObjeto(primeiro.payload);
    // `type` também é o campo do BaseEvent: sem `data`, o próprio objeto é o payload.
    return { tipo, dados: interno ?? primeiro };
  };
  if (formato === 'OBJETO') return comoObjetoDireto();
  if (formato === 'EVENTO_DADOS') return comoEnvelope();
  return comoObjetoDireto() ?? comoEnvelope();
}

// ---------------------------------------------------------------------------
// Campos
// ---------------------------------------------------------------------------

export interface AgenteDoEvento {
  id: number | null;
  nome: string | null;
}

export interface ChamadaDoEvento {
  id: string;
  telefone: string | null;
  /** Telefone como veio (para o aviso do receptivo quando não dá para normalizar). */
  telefoneBruto: string | null;
  modo: string | null;
  agente: AgenteDoEvento;
  campanhaId: number | null;
  campanhaNome: string | null;
  identifier: string | null;
}

/** O agente de um objeto (`{id, name}`), de um id solto ou de um nome. */
export function lerAgente(valor: unknown): AgenteDoEvento {
  const o = comoObjeto(valor);
  if (o) {
    return {
      id: numeroDe(o.id) ?? numeroDe(o.user_id) ?? numeroDe(o.agent_id),
      nome: textoDe(o.name) ?? textoDe(o.nome),
    };
  }
  const n = numeroDe(valor);
  if (n !== null && typeof valor !== 'string') return { id: n, nome: null };
  if (typeof valor === 'string' && /^\d+$/.test(valor.trim())) {
    return { id: Number(valor), nome: null };
  }
  return { id: null, nome: textoDe(valor) };
}

/** O agente do evento: `dados.agent` (evento de agente) ou `dados.call.agent` (de chamada). */
export function agenteDoEvento(dados: Record<string, unknown>): AgenteDoEvento {
  const direto = lerAgente(dados.agent);
  if (direto.id !== null || direto.nome !== null) return direto;
  const chamada = comoObjeto(dados.call);
  return chamada ? lerAgente(chamada.agent) : { id: null, nome: null };
}

/** `identifier` do discador: no objeto da chamada ou no `mailing_data`. */
function identifierDe(chamada: Record<string, unknown>): string | null {
  const mailing =
    comoObjeto(chamada.mailing_data) ?? comoObjeto(chamada.mailing);
  return (
    lerIdentifier(chamada.identifier) ??
    lerIdentifier(mailing?.identifier) ??
    lerIdentifier(comoObjeto(mailing?.data)?.identifier)
  );
}

/** A chamada de um evento de chamada ou do histórico (`call-history-was-created`). */
export function lerChamada(
  dados: Record<string, unknown>,
): ChamadaDoEvento | null {
  const chamada = comoObjeto(dados.call) ?? dados;
  const id =
    textoDe(chamada.id) ??
    textoDe(chamada.call_id) ??
    textoDe(chamada.telephony_id);
  if (!id) return null;
  const numero = chamada.phone ?? chamada.number ?? chamada.phone_number;
  const campanha = comoObjeto(chamada.campaign);
  return {
    id,
    telefone: telefoneDoTresc(numero),
    telefoneBruto: textoDe(numero),
    modo: textoDe(chamada.mode) ?? textoDe(chamada.type),
    agente: lerAgente(chamada.agent),
    campanhaId: campanha
      ? numeroDe(campanha.id)
      : numeroDe(chamada.campaign_id ?? chamada.campaign),
    campanhaNome: campanha
      ? textoDe(campanha.name)
      : (textoDe(chamada.campaign_name) ??
        (typeof chamada.campaign === 'string' &&
        numeroDe(chamada.campaign) === null
          ? textoDe(chamada.campaign)
          : null)),
    identifier: identifierDe(chamada),
  };
}

const MODOS_RECEPTIVOS = new Set([
  'receptive',
  'receptivo',
  'receptiva',
  'inbound',
  'incoming',
  'in',
]);

/**
 * A chamada é recebida (receptivo)? Lacuna da referência §11.8: o campo que a distingue não foi
 * confirmado; aceita `mode`/`type`/`direction` com os valores conhecidos.
 */
export function ehReceptiva(dados: Record<string, unknown>): boolean {
  const chamada = comoObjeto(dados.call) ?? dados;
  for (const campo of ['mode', 'type', 'direction']) {
    const valor = textoDe(chamada[campo])?.toLowerCase();
    if (valor && MODOS_RECEPTIVOS.has(valor)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Estado da ligação
// ---------------------------------------------------------------------------

export interface DecisaoDeChamada {
  estado: EstadoLigacao;
  /** Código do motivo (nos terminais). */
  motivo: string | null;
}

const ORDEM: Readonly<Record<EstadoLigacao, number>> = {
  CHAMANDO: 0,
  TOCANDO: 1,
  EM_ANDAMENTO: 2,
  ENCERRADA: 3,
  PERDIDA: 3,
  RECUSADA: 3,
  SEM_RESPOSTA: 3,
  FALHOU: 3,
};

export function ehEstadoFinal(estado: EstadoLigacao): boolean {
  return ORDEM[estado] >= 3;
}

/** Estado em que a ligação nasce ao ver o primeiro evento dela. */
export function estadoInicial(direcao: DirecaoLigacao): EstadoLigacao {
  return direcao === 'RECEBIDA' ? 'TOCANDO' : 'CHAMANDO';
}

/**
 * Próximo estado da ligação para um evento de chamada, ou `null` se o evento não muda nada
 * (terminal é final; estados ativos só avançam).
 *
 * - `call-was-created` CHAMANDO (feita) / TOCANDO (recebida); `call-was-answered` TOCANDO (o cliente
 *   atendeu, ainda conectando ao agente); `call-was-connected` EM_ANDAMENTO;
 * - `call-was-ended` e `call-was-finished`: ENCERRADA se chegou a conectar; senão a ligação nunca foi
 *   atendida: SEM_RESPOSTA (feita) ou PERDIDA (recebida). O histórico corrige se houve fala;
 * - `call-was-abandoned*`: PERDIDA (o cliente atendeu e ninguém falou com ele); `call-was-not-answered`:
 *   SEM_RESPOSTA; `call-was-failed`: FALHOU.
 */
export function decidirChamada(
  atual: EstadoLigacao,
  direcao: DirecaoLigacao,
  tipo: string,
): DecisaoDeChamada | null {
  if (ehEstadoFinal(atual)) return null;
  const avancar = (estado: EstadoLigacao): DecisaoDeChamada | null =>
    ORDEM[estado] > ORDEM[atual] ? { estado, motivo: null } : null;
  switch (tipo) {
    case 'call-was-created':
      return avancar(estadoInicial(direcao));
    case 'call-was-answered':
      return avancar('TOCANDO');
    case 'call-was-connected':
      return avancar('EM_ANDAMENTO');
    case 'call-was-ended':
    case 'call-was-finished':
      if (atual === 'EM_ANDAMENTO') {
        return { estado: 'ENCERRADA', motivo: 'concluida' };
      }
      return direcao === 'RECEBIDA'
        ? { estado: 'PERDIDA', motivo: 'abandonada' }
        : { estado: 'SEM_RESPOSTA', motivo: 'nao_atendida' };
    case 'call-was-abandoned':
      return { estado: 'PERDIDA', motivo: 'abandonada' };
    case 'call-was-abandoned-due-amd':
      return { estado: 'PERDIDA', motivo: 'abandonada_secretaria' };
    case 'call-was-not-answered':
      return { estado: 'SEM_RESPOSTA', motivo: 'nao_atendida' };
    case 'call-was-failed':
      return { estado: 'FALHOU', motivo: 'falha_3c' };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Estado do agente
// ---------------------------------------------------------------------------

/** Estado do agente que o evento define (`null` = o evento não muda o estado). */
export function estadoDoAgente(tipo: string): EstadoDoAgente | null {
  switch (tipo) {
    case 'agent-is-idle':
    case 'agent-left-work-break':
    case 'agent-left-manual-mode':
      return 'ocioso';
    case 'agent-in-acw':
    case 'agent-entered-manual-acw':
    case 'manual-call-acw-connected':
      return 'pos_atendimento';
    case 'agent-entered-manual':
    case 'agent-left-manual-acw':
    case 'manual-call-acw-disconnected':
      return 'manual';
    case 'agent-entered-work-break':
      return 'pausa';
    case 'agent-was-logged-out':
      return 'desconectado';
    case 'call-was-connected':
      return 'em_ligacao';
    default:
      return null;
  }
}

/** Eventos de agente que são falhas: o vendedor precisa ser avisado. */
export function mensagemDeFalhaDoAgente(tipo: string): string | null {
  switch (tipo) {
    case 'agent-login-failed':
      return 'O 3C+ não deixou entrar na campanha. Confira se ela está ativa e se você tem permissão.';
    case 'agent-failed-to-enter-manual':
      return 'O 3C+ não deixou entrar no modo manual. Termine a ligação ou a pausa e tente de novo.';
    case 'agent-enter-work-break-failed':
      return 'O 3C+ não deixou entrar na pausa agora.';
    default:
      return null;
  }
}

/**
 * Chave de deduplicação (chamada + evento). Eventos de agente não precisam: aplicar o mesmo estado
 * duas vezes não muda nada.
 */
export function chaveDoEvento(
  tipo: string,
  dados: Record<string, unknown>,
): string | null {
  if (EVENTOS_DE_AGENTE.some((t) => t === tipo)) return null;
  const chamada = lerChamada(dados);
  return chamada ? `${tipo}:${chamada.id}` : null;
}

// ---------------------------------------------------------------------------
// Histórico (`call-history-was-created` e `GET /calls`)
// ---------------------------------------------------------------------------

/** Segundos de um número, de `"90"` ou de `"hh:mm:ss"` / `"mm:ss"`. */
export function lerDuracao(valor: unknown): number | null {
  if (typeof valor === 'number') {
    return Number.isFinite(valor) && valor >= 0 ? Math.round(valor) : null;
  }
  if (typeof valor !== 'string') return null;
  const texto = valor.trim();
  if (/^\d+(\.\d+)?$/.test(texto)) return Math.round(Number(texto));
  const partes = /^(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(texto);
  if (!partes) return null;
  return (
    Number(partes[1] ?? 0) * 3600 + Number(partes[2]) * 60 + Number(partes[3])
  );
}

/**
 * Data da chamada: `call_date_rfc3339` (com fuso) ou `call_date` (`Y-m-d H:i:s`, sem fuso: o horário
 * de Brasília, o fuso da operação — lacuna da referência).
 */
export function lerDataDaChamada(
  chamada: Record<string, unknown>,
): Date | null {
  const rfc = textoDe(chamada.call_date_rfc3339);
  if (rfc && !Number.isNaN(Date.parse(rfc))) return new Date(rfc);
  const texto = textoDe(chamada.call_date);
  if (!texto) return null;
  const temFuso = /(Z|[+-]\d{2}:?\d{2})$/.test(texto);
  const iso = temFuso ? texto : `${texto.replace(' ', 'T')}-03:00`;
  const data = new Date(iso);
  return Number.isNaN(data.getTime()) ? null : data;
}

export interface HistoricoDaChamada {
  chamada: ChamadaDoEvento;
  /** Tempo falado, em segundos (`speaking_time`). */
  faladoSegundos: number | null;
  /** Tempo total cobrado (`billed_time`), em segundos. */
  cobradoSegundos: number | null;
  dataDaChamada: Date | null;
  qualificacao: {
    id: number | null;
    nome: string;
    conversao: boolean | null;
  } | null;
  observacao: string | null;
  causaDoFim: string | null;
  temGravacao: boolean;
}

/** O registro final da chamada (`CallHistoryReport`), com a leitura tolerante dos campos. */
export function lerHistorico(
  dados: Record<string, unknown>,
): HistoricoDaChamada | null {
  const registro = comoObjeto(dados.call) ?? dados;
  const chamada = lerChamada(registro);
  if (!chamada) return null;
  let qualificacao: HistoricoDaChamada['qualificacao'] = null;
  const q = comoObjeto(registro.qualification);
  if (q) {
    const nome = textoDe(q.name) ?? textoDe(q.nome);
    if (nome) {
      qualificacao = {
        id: numeroDe(q.id),
        nome,
        conversao: typeof q.conversion === 'boolean' ? q.conversion : null,
      };
    }
  } else {
    const nome = textoDe(registro.qualification);
    if (nome) qualificacao = { id: null, nome, conversao: null };
  }
  const gravacao = registro.recording ?? registro.recording_url;
  return {
    chamada,
    faladoSegundos: lerDuracao(registro.speaking_time),
    cobradoSegundos: lerDuracao(registro.billed_time),
    dataDaChamada: lerDataDaChamada(registro),
    qualificacao,
    observacao: textoDe(registro.qualification_note),
    causaDoFim:
      textoDe(registro.hangup_cause) ?? textoDe(registro.readable_status_text),
    temGravacao:
      typeof gravacao === 'string' ? gravacao.trim() !== '' : !!gravacao,
  };
}
