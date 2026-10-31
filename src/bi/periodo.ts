import { DadosInvalidosException } from '../comum/erros/excecoes';
import {
  DIA_MS,
  FUSO_DO_BI,
  PERIODO_MAXIMO_DIAS,
  PERIODO_PADRAO_DIAS,
} from './bi.constantes';

export interface Intervalo {
  de: Date;
  ate: Date;
}

/**
 * Período pedido (`de` inclusivo, `ate` exclusivo; padrão: 30 dias até agora) e,
 * quando `comparar`, o período anterior de mesma duração, colado no início.
 */
export function resolverPeriodo(
  de: string | undefined,
  ate: string | undefined,
  comparar: boolean,
  agora: Date = new Date(),
): { atual: Intervalo; anterior: Intervalo | null } {
  const fim = ate ? new Date(ate) : agora;
  const inicio = de
    ? new Date(de)
    : new Date(fim.getTime() - PERIODO_PADRAO_DIAS * DIA_MS);
  if (inicio >= fim) {
    throw new DadosInvalidosException('O início precisa ser antes do fim.', {
      campos: [{ campo: 'de', mensagens: ['deve ser antes de "ate"'] }],
    });
  }
  if (fim.getTime() - inicio.getTime() > PERIODO_MAXIMO_DIAS * DIA_MS) {
    throw new DadosInvalidosException('O período pode ter no máximo 1 ano.', {
      campos: [{ campo: 'de', mensagens: ['período maior que 1 ano'] }],
    });
  }
  const duracao = fim.getTime() - inicio.getTime();
  return {
    atual: { de: inicio, ate: fim },
    anterior: comparar
      ? { de: new Date(inicio.getTime() - duracao), ate: inicio }
      : null,
  };
}

/** Variação percentual sobre o anterior (2 casas); `null` sem anterior ou com anterior zero. */
export function variacaoPercentual(
  valor: number | null,
  anterior: number | null,
): number | null {
  if (valor === null || anterior === null || anterior === 0) {
    return null;
  }
  return arredondar(((valor - anterior) / Math.abs(anterior)) * 100, 2);
}

export function arredondar(valor: number, casas = 2): number {
  const fator = 10 ** casas;
  return Math.round(valor * fator) / fator;
}

/** `parte / total` em percentual (2 casas); `null` com total zero. */
export function percentual(parte: number, total: number): number | null {
  return total > 0 ? arredondar((parte / total) * 100, 2) : null;
}

const formatadorDeDia = new Map<string, Intl.DateTimeFormat>();

/** Dia `AAAA-MM-DD` de um instante no fuso do BI. */
export function diaLocal(instante: Date, fuso: string = FUSO_DO_BI): string {
  let formatador = formatadorDeDia.get(fuso);
  if (!formatador) {
    formatador = new Intl.DateTimeFormat('en-CA', {
      timeZone: fuso,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    formatadorDeDia.set(fuso, formatador);
  }
  return formatador.format(instante);
}

/** Todos os dias (no fuso do BI) que o intervalo toca, em ordem, para a série sem buracos. */
export function diasDoIntervalo(de: Date, ate: Date): string[] {
  const dias: string[] = [];
  const ultimo = diaLocal(new Date(ate.getTime() - 1));
  for (
    let t = de.getTime();
    t < ate.getTime() + 3 * 3_600_000;
    t += 3 * 3_600_000
  ) {
    const dia = diaLocal(new Date(t));
    if (dias.at(-1) !== dia) {
      dias.push(dia);
    }
    if (dia === ultimo) {
      break;
    }
  }
  return dias;
}
