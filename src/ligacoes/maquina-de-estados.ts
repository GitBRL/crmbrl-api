/**
 * Máquina de estados da ligação (R29), em funções puras — testada em
 * `maquina-de-estados.spec.ts`.
 *
 * ```
 * Recebida:  TOCANDO ──atendida──▶ EM_ANDAMENTO ──terminate──▶ ENCERRADA
 *               │ └─ tempo esgotado / cliente desligou / fora do horário / sem atendente ─▶ PERDIDA
 *               └─ falha ─▶ FALHOU
 * Feita:     CHAMANDO ──ringing──▶ TOCANDO ──accepted──▶ EM_ANDAMENTO ──terminate──▶ ENCERRADA
 *               │            │  └─ rejected ─▶ RECUSADA
 *               │            └─ terminate sem atender / cancelada ─▶ SEM_RESPOSTA
 *               └─ falha ─▶ FALHOU
 * ```
 *
 * Regras de robustez (webhooks repetidos, fora de ordem ou atrasados):
 *
 * - um estado terminal nunca muda (o webhook atrasado só completa dados, ver
 *   `podeCompletarDados`);
 * - os estados ativos só avançam (CHAMANDO < TOCANDO < EM_ANDAMENTO): um
 *   `RINGING` que chega depois do `ACCEPTED` é ignorado;
 * - o evento que não faz sentido para o estado atual é ignorado, nunca erro.
 */
import type { DirecaoLigacao, EstadoLigacao } from '../generated/prisma/client';
import { ESTADOS_TERMINAIS, type MotivoDaLigacao } from './ligacoes.constantes';

/** O que pode acontecer com uma ligação. */
export type EventoDaLigacao =
  /** Feita: webhook de status `RINGING` (toca no aparelho do cliente). */
  | { tipo: 'tocando_no_cliente' }
  /** Feita: webhook de status `ACCEPTED`. */
  | { tipo: 'cliente_atendeu' }
  /** Feita: webhook de status `REJECTED`. */
  | { tipo: 'cliente_recusou' }
  /** Recebida: o atendente atendeu e a Meta aceitou (`accept` 200). */
  | { tipo: 'atendida_pelo_atendente' }
  /**
   * Webhook `terminate`. `atendida` = veio com `start_time`/`duration`;
   * `falhou` = `status: FAILED`. `canceladaPorNos` = o atendente mandou o terminate.
   */
  | {
      tipo: 'encerrada_pela_meta';
      atendida: boolean;
      falhou: boolean;
      canceladaPorNos?: boolean;
      /** Recebida: já passou do fim do tempo de toque (a Meta desistiu esperando). */
      toqueVencido?: boolean;
      motivoDaFalha?: MotivoDaLigacao;
    }
  /** Recebida: o tempo de toque acabou sem ninguém atender. */
  | { tipo: 'tempo_de_toque_esgotado' }
  /** Recebida: todos os atendentes chamados recusaram (R29.2). */
  | { tipo: 'recusada_por_todos' }
  /** Recebida, ao chegar: sem atendente, fora do horário, desativada ou atrasada. */
  | {
      tipo: 'nao_pode_tocar';
      motivo: Extract<
        MotivoDaLigacao,
        | 'fora_do_horario'
        | 'sem_atendente'
        | 'ligacoes_desativadas'
        | 'atrasada'
      >;
    }
  /** Feita: o atendente cancelou antes de o cliente atender (mandou `terminate`). */
  | { tipo: 'cancelada_pelo_atendente' }
  /** Atendente encerrou e a Meta não mandou o webhook a tempo: o CRM fecha com o que sabe. */
  | { tipo: 'encerramento_forcado'; motivo: MotivoDaLigacao }
  /** Falha do CRM ou da Meta fora de um `terminate` (accept recusado, connect recusado, vigia). */
  | { tipo: 'falhou'; motivo: MotivoDaLigacao }
  /** Feita presa sem tocar/atender além do prazo (vigia): fecha como sem resposta ou falha. */
  | { tipo: 'vigia_esgotada' };

/** A decisão da máquina para um evento. */
export type Decisao =
  | {
      aplicar: true;
      estado: EstadoLigacao;
      /** Motivo do desfecho (só nos terminais). */
      motivo: MotivoDaLigacao | null;
    }
  | { aplicar: false; razao: 'terminal' | 'retrocesso' | 'invalido' };

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

export function ehTerminal(estado: EstadoLigacao): boolean {
  return ESTADOS_TERMINAIS.includes(estado);
}

const aplicar = (
  estado: EstadoLigacao,
  motivo: MotivoDaLigacao | null = null,
): Decisao => ({ aplicar: true, estado, motivo });

const ignorar = (razao: 'retrocesso' | 'invalido'): Decisao => ({
  aplicar: false,
  razao,
});

/** Decide o próximo estado. Não faz nada além de decidir. */
export function decidir(
  atual: EstadoLigacao,
  direcao: DirecaoLigacao,
  evento: EventoDaLigacao,
): Decisao {
  if (ehTerminal(atual)) {
    return { aplicar: false, razao: 'terminal' };
  }
  const recebida = direcao === 'RECEBIDA';
  switch (evento.tipo) {
    case 'tocando_no_cliente':
      if (recebida) {
        return ignorar('invalido');
      }
      return ORDEM[atual] < ORDEM.TOCANDO
        ? aplicar('TOCANDO')
        : ignorar('retrocesso');
    case 'cliente_atendeu':
      if (recebida) {
        return ignorar('invalido');
      }
      return atual === 'EM_ANDAMENTO'
        ? ignorar('retrocesso')
        : aplicar('EM_ANDAMENTO');
    case 'cliente_recusou':
      if (recebida || atual === 'EM_ANDAMENTO') {
        return ignorar(recebida ? 'invalido' : 'retrocesso');
      }
      return aplicar('RECUSADA', 'recusada_pelo_cliente');
    case 'atendida_pelo_atendente':
      return recebida && atual === 'TOCANDO'
        ? aplicar('EM_ANDAMENTO')
        : ignorar(recebida ? 'retrocesso' : 'invalido');
    case 'tempo_de_toque_esgotado':
      return recebida && atual === 'TOCANDO'
        ? aplicar('PERDIDA', 'tempo_esgotado')
        : ignorar('invalido');
    case 'recusada_por_todos':
      return recebida && atual === 'TOCANDO'
        ? aplicar('PERDIDA', 'recusada_pelos_atendentes')
        : ignorar('invalido');
    case 'nao_pode_tocar':
      return recebida && atual === 'TOCANDO'
        ? aplicar('PERDIDA', evento.motivo)
        : ignorar('invalido');
    case 'cancelada_pelo_atendente':
      return !recebida && (atual === 'CHAMANDO' || atual === 'TOCANDO')
        ? aplicar('SEM_RESPOSTA', 'cancelada_pelo_atendente')
        : ignorar('invalido');
    case 'encerramento_forcado':
      return atual === 'EM_ANDAMENTO'
        ? aplicar('ENCERRADA', evento.motivo)
        : ignorar('invalido');
    case 'falhou':
      return aplicar('FALHOU', evento.motivo);
    case 'vigia_esgotada':
      if (recebida) {
        return ignorar('invalido');
      }
      return atual === 'TOCANDO'
        ? aplicar('SEM_RESPOSTA', 'sem_resposta')
        : atual === 'CHAMANDO'
          ? aplicar('FALHOU', 'sem_resposta_da_meta')
          : ignorar('invalido');
    case 'encerrada_pela_meta':
      return decidirTerminate(atual, recebida, evento);
  }
}

function decidirTerminate(
  atual: EstadoLigacao,
  recebida: boolean,
  evento: Extract<EventoDaLigacao, { tipo: 'encerrada_pela_meta' }>,
): Decisao {
  const encerradoPor = evento.canceladaPorNos
    ? 'encerrada_pelo_atendente'
    : 'encerrada_pelo_cliente';
  if (atual === 'EM_ANDAMENTO') {
    // A ligação aconteceu: mesmo com erro de mídia no fim, ela foi atendida.
    return aplicar(
      'ENCERRADA',
      evento.falhou ? (evento.motivoDaFalha ?? 'falha_de_midia') : encerradoPor,
    );
  }
  if (evento.falhou) {
    return aplicar(
      'FALHOU',
      evento.motivoDaFalha ?? (recebida ? 'falha_na_meta' : 'falha_ao_ligar'),
    );
  }
  if (evento.atendida) {
    // `terminate` com duração, mas o CRM não viu o atendimento (webhook perdido): foi uma ligação completa.
    return aplicar('ENCERRADA', encerradoPor);
  }
  if (recebida) {
    return aplicar(
      'PERDIDA',
      evento.toqueVencido ? 'tempo_esgotado' : 'cliente_desligou',
    );
  }
  return evento.canceladaPorNos
    ? aplicar('SEM_RESPOSTA', 'cancelada_pelo_atendente')
    : aplicar('SEM_RESPOSTA', 'sem_resposta');
}

/**
 * Um `terminate` atrasado, depois de o CRM já ter fechado a ligação, ainda
 * pode trazer a duração e o horário reais: completa os dados sem mexer no estado.
 */
export function podeCompletarDados(atual: EstadoLigacao): boolean {
  return ehTerminal(atual);
}

/** O estado só avançou (nunca retrocede)? Útil para testes e conferências. */
export function avanca(de: EstadoLigacao, para: EstadoLigacao): boolean {
  return ORDEM[para] > ORDEM[de];
}
