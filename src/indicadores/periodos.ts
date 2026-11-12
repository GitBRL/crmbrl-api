/**
 * Períodos predefinidos (R33.3) e baldes da série (R33.2), no fuso de São Paulo
 * (o mesmo do BI): funções puras.
 */
import { DIA_MS, FUSO_DO_BI } from '../bi/bi.constantes';
import { diaLocal } from '../bi/periodo';
import type { Agrupamento, TipoDePeriodo } from './indicadores.tipos';

interface DataLocal {
  ano: number;
  mes: number; // 1-12
  dia: number;
}

function dataLocalDe(instante: Date): DataLocal {
  const [ano, mes, dia] = diaLocal(instante).split('-').map(Number);
  return { ano, mes, dia };
}

const formatadorDeHora = new Intl.DateTimeFormat('en-GB', {
  timeZone: FUSO_DO_BI,
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** Meia-noite local (São Paulo) do dia dado, como instante UTC. Aceita mês/dia fora da faixa (o `Date.UTC` normaliza). */
export function meiaNoiteLocal(ano: number, mes: number, dia: number): Date {
  const base = Date.UTC(ano, mes - 1, dia);
  for (let deslocamento = 0; deslocamento <= 14; deslocamento += 1) {
    const candidato = new Date(base + deslocamento * 3_600_000);
    const normalizado = new Date(base);
    const esperado = diaLocal(
      new Date(
        Date.UTC(
          normalizado.getUTCFullYear(),
          normalizado.getUTCMonth(),
          normalizado.getUTCDate(),
          12,
        ),
      ),
    );
    if (
      diaLocal(candidato) === esperado &&
      formatadorDeHora.format(candidato) === '00:00'
    ) {
      return candidato;
    }
  }
  return new Date(base + 3 * 3_600_000);
}

/** Intervalo `[de, ate)` de um período predefinido, em relação a `agora`. `PERSONALIZADO` não tem intervalo fixo. */
export function intervaloDoPeriodo(
  tipo: Exclude<TipoDePeriodo, 'PERSONALIZADO'>,
  agora: Date,
): { de: Date; ate: Date } {
  const hoje = dataLocalDe(agora);
  const amanha = meiaNoiteLocal(hoje.ano, hoje.mes, hoje.dia + 1);
  switch (tipo) {
    case 'HOJE':
      return { de: meiaNoiteLocal(hoje.ano, hoje.mes, hoje.dia), ate: amanha };
    case 'ULTIMOS_7_DIAS':
      return {
        de: meiaNoiteLocal(hoje.ano, hoje.mes, hoje.dia - 6),
        ate: amanha,
      };
    case 'ULTIMOS_30_DIAS':
      return {
        de: meiaNoiteLocal(hoje.ano, hoje.mes, hoje.dia - 29),
        ate: amanha,
      };
    case 'MES_ATUAL':
      return { de: meiaNoiteLocal(hoje.ano, hoje.mes, 1), ate: amanha };
    case 'MES_ANTERIOR':
      return {
        de: meiaNoiteLocal(hoje.ano, hoje.mes - 1, 1),
        ate: meiaNoiteLocal(hoje.ano, hoje.mes, 1),
      };
    case 'TRIMESTRE': {
      const primeiroMes = Math.floor((hoje.mes - 1) / 3) * 3 + 1;
      return { de: meiaNoiteLocal(hoje.ano, primeiroMes, 1), ate: amanha };
    }
    case 'ANO':
      return { de: meiaNoiteLocal(hoje.ano, 1, 1), ate: amanha };
  }
}

/** Chave do balde (dia `AAAA-MM-DD`, segunda da semana ou 1º do mês) de um dia local. */
export function chaveDoBalde(dia: string, agrupamento: Agrupamento): string {
  if (agrupamento === 'DIA') {
    return dia;
  }
  if (agrupamento === 'MES') {
    return `${dia.slice(0, 7)}-01`;
  }
  const [ano, mes, dd] = dia.split('-').map(Number);
  const data = new Date(Date.UTC(ano, mes - 1, dd));
  const diaDaSemana = (data.getUTCDay() + 6) % 7; // segunda = 0
  return new Date(data.getTime() - diaDaSemana * DIA_MS)
    .toISOString()
    .slice(0, 10);
}

/** Todos os baldes que o intervalo toca, em ordem, para a série sem buracos. */
export function baldesDoIntervalo(
  de: Date,
  ate: Date,
  agrupamento: Agrupamento,
): string[] {
  const baldes: string[] = [];
  const ultimo = diaLocal(new Date(ate.getTime() - 1));
  let t = de.getTime();
  for (let i = 0; i < 400; i += 1) {
    const dia = diaLocal(new Date(t));
    const balde = chaveDoBalde(dia, agrupamento);
    if (baldes.at(-1) !== balde) {
      baldes.push(balde);
    }
    if (dia >= ultimo) {
      break;
    }
    t += DIA_MS;
  }
  return baldes;
}

const MESES = [
  'jan',
  'fev',
  'mar',
  'abr',
  'mai',
  'jun',
  'jul',
  'ago',
  'set',
  'out',
  'nov',
  'dez',
];

/** Rótulo curto do balde para a série (`05/11`, `nov/2026`). */
export function rotuloDoBalde(chave: string, agrupamento: Agrupamento): string {
  const [ano, mes, dia] = chave.split('-');
  if (agrupamento === 'MES') {
    return `${MESES[Number(mes) - 1]}/${ano}`;
  }
  return `${dia}/${mes}`;
}
