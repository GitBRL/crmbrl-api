/**
 * Datas no fuso horário de quem usa o CRM, sem bibliotecas: o `Intl` do Node
 * conhece os fusos IANA (inclusive horário de verão). Base dos agrupamentos de
 * atividades ("hoje", "próximos 7 dias"…) e dos textos dos lembretes (R6.5).
 */
import { FUSO_HORARIO_PADRAO } from '../fila/fila.service';

/** Fuso padrão das atividades: o mesmo dos agendamentos da fila (America/Sao_Paulo). */
export const FUSO_HORARIO_DAS_ATIVIDADES = FUSO_HORARIO_PADRAO;

/** Data e hora "de parede" num fuso (mês de 1 a 12). */
export interface DataLocal {
  readonly ano: number;
  readonly mes: number;
  readonly dia: number;
  readonly hora: number;
  readonly minuto: number;
  readonly segundo: number;
}

const formatadores = new Map<string, Intl.DateTimeFormat>();

function formatadorDe(fuso: string): Intl.DateTimeFormat {
  let formatador = formatadores.get(fuso);
  if (!formatador) {
    formatador = new Intl.DateTimeFormat('en-US', {
      timeZone: fuso,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatadores.set(fuso, formatador);
  }
  return formatador;
}

/** O fuso é um nome IANA que o Node conhece (ex.: `America/Sao_Paulo`)? */
export function ehFusoHorarioValido(fuso: string): boolean {
  try {
    formatadorDe(fuso);
    return true;
  } catch {
    return false;
  }
}

/** Data e hora locais de um instante no fuso. */
export function dataLocal(instante: Date, fuso: string): DataLocal {
  const partes: Record<string, number> = {};
  for (const parte of formatadorDe(fuso).formatToParts(instante)) {
    if (parte.type !== 'literal') {
      partes[parte.type] = Number(parte.value);
    }
  }
  return {
    ano: partes.year,
    mes: partes.month,
    dia: partes.day,
    hora: partes.hour,
    minuto: partes.minute,
    segundo: partes.second,
  };
}

/** Diferença entre a hora local do fuso e o UTC no instante, em ms (São Paulo: −3 h). */
export function deslocamentoDoFuso(instante: Date, fuso: string): number {
  const local = dataLocal(instante, fuso);
  const localComoUtc = Date.UTC(
    local.ano,
    local.mes - 1,
    local.dia,
    local.hora,
    local.minuto,
    local.segundo,
  );
  const semMilissegundos = Math.floor(instante.getTime() / 1_000) * 1_000;
  return localComoUtc - semMilissegundos;
}

function mesmoDia(
  local: DataLocal,
  ano: number,
  mes: number,
  dia: number,
): boolean {
  return local.ano === ano && local.mes === mes && local.dia === dia;
}

/**
 * Primeiro instante do dia local (ano, mês, dia) no fuso. Normalmente é a
 * meia-noite; num dia em que o horário de verão começa à meia-noite, é a
 * primeira hora que existe. Aceita dia ou mês fora do intervalo (`dia + 1`),
 * como o `Date.UTC`.
 */
export function inicioDoDia(
  ano: number,
  mes: number,
  dia: number,
  fuso: string,
): Date {
  const meiaNoiteUtc = new Date(Date.UTC(ano, mes - 1, dia));
  const alvo = {
    ano: meiaNoiteUtc.getUTCFullYear(),
    mes: meiaNoiteUtc.getUTCMonth() + 1,
    dia: meiaNoiteUtc.getUTCDate(),
  };
  // 1ª aproximação com o deslocamento da meia-noite UTC; a 2ª corrige quando
  // o deslocamento muda entre os dois instantes (horário de verão).
  const primeira =
    meiaNoiteUtc.getTime() - deslocamentoDoFuso(meiaNoiteUtc, fuso);
  const segunda =
    meiaNoiteUtc.getTime() - deslocamentoDoFuso(new Date(primeira), fuso);
  const candidatos = [primeira, segunda].filter((instante) =>
    mesmoDia(dataLocal(new Date(instante), fuso), alvo.ano, alvo.mes, alvo.dia),
  );
  return new Date(
    candidatos.length > 0
      ? Math.min(...candidatos)
      : Math.min(primeira, segunda),
  );
}

/** Limites do calendário usados nos agrupamentos de atividades. */
export interface LimitesDoCalendario {
  /** Início de hoje no fuso. */
  readonly inicioDeHoje: Date;
  /** Início de amanhã no fuso (fim de "hoje"). */
  readonly inicioDeAmanha: Date;
  /** Início do 8º dia a partir de hoje: fim dos "próximos 7 dias" (amanhã até hoje + 7). */
  readonly fimDosProximos7Dias: Date;
}

export function limitesDoCalendario(
  agora: Date,
  fuso: string,
): LimitesDoCalendario {
  const hoje = dataLocal(agora, fuso);
  const inicioDoDiaMais = (dias: number) =>
    inicioDoDia(hoje.ano, hoje.mes, hoje.dia + dias, fuso);
  return {
    inicioDeHoje: inicioDoDiaMais(0),
    inicioDeAmanha: inicioDoDiaMais(1),
    fimDosProximos7Dias: inicioDoDiaMais(8),
  };
}

const doisDigitos = (valor: number) => String(valor).padStart(2, '0');

/** `15:00` no fuso. */
export function formatarHora(instante: Date, fuso: string): string {
  const local = dataLocal(instante, fuso);
  return `${doisDigitos(local.hora)}:${doisDigitos(local.minuto)}`;
}

/**
 * "às 15:00" quando o instante cai no mesmo dia local de `referencia`; senão
 * "em 21/10 às 15:00". Para os textos das notificações.
 */
export function descreverMomento(
  instante: Date,
  referencia: Date,
  fuso: string,
): string {
  const local = dataLocal(instante, fuso);
  const hoje = dataLocal(referencia, fuso);
  const hora = formatarHora(instante, fuso);
  if (mesmoDia(local, hoje.ano, hoje.mes, hoje.dia)) {
    return `às ${hora}`;
  }
  return `em ${doisDigitos(local.dia)}/${doisDigitos(local.mes)} às ${hora}`;
}
