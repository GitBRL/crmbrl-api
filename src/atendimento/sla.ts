/**
 * SLA das filas (R12): prazo de primeira resposta e de resolução, em minutos
 * corridos, contados da chegada da conversa — ou da abertura seguinte do
 * canal, quando ela chega fora do horário de atendimento (`inicioDaContagem`).
 */
import type { Conversa, FilaAtendimento } from '../generated/prisma/client';

const MINUTO_MS = 60_000;

export interface PrazosDoSla {
  slaPrimeiraRespostaAte: Date | null;
  slaResolucaoAte: Date | null;
}

/** Os dois prazos a partir de `inicio` (sem fila ou sem SLA: nulos). */
export function prazosDoSla(
  fila: Pick<
    FilaAtendimento,
    'slaPrimeiraRespostaMinutos' | 'slaResolucaoMinutos'
  > | null,
  inicio: Date,
): PrazosDoSla {
  const somar = (minutos: number | null | undefined) =>
    minutos && minutos > 0
      ? new Date(inicio.getTime() + minutos * MINUTO_MS)
      : null;
  return {
    slaPrimeiraRespostaAte: somar(fila?.slaPrimeiraRespostaMinutos),
    slaResolucaoAte: somar(fila?.slaResolucaoMinutos),
  };
}

export interface SituacaoDoSla {
  /** Ainda sem primeira resposta e o prazo já passou. */
  primeiraRespostaEstourada: boolean;
  /** Em aberto e o prazo de resolução já passou. */
  resolucaoEstourada: boolean;
}

/** O SLA da conversa está estourado agora? (O selo coral da lista.) */
export function situacaoDoSla(
  conversa: Pick<
    Conversa,
    | 'status'
    | 'primeiraRespostaEm'
    | 'slaPrimeiraRespostaAte'
    | 'slaResolucaoAte'
  >,
  agora: Date = new Date(),
): SituacaoDoSla {
  const emAberto = conversa.status !== 'RESOLVIDA';
  return {
    primeiraRespostaEstourada:
      emAberto &&
      conversa.primeiraRespostaEm === null &&
      conversa.slaPrimeiraRespostaAte !== null &&
      conversa.slaPrimeiraRespostaAte <= agora,
    resolucaoEstourada:
      emAberto &&
      conversa.slaResolucaoAte !== null &&
      conversa.slaResolucaoAte <= agora,
  };
}

/** Texto curto de uma duração ("12 min", "2 h 5 min", "3 dias"). */
export function descreverMinutos(minutos: number): string {
  if (minutos < 60) {
    return `${minutos} min`;
  }
  if (minutos < 24 * 60) {
    const horas = Math.floor(minutos / 60);
    const resto = minutos % 60;
    return resto ? `${horas} h ${resto} min` : `${horas} h`;
  }
  const dias = Math.floor(minutos / (24 * 60));
  const horas = Math.floor((minutos % (24 * 60)) / 60);
  const rotulo = dias === 1 ? '1 dia' : `${dias} dias`;
  return horas ? `${rotulo} e ${horas} h` : rotulo;
}
