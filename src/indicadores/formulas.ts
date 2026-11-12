/**
 * Fórmulas puras dos indicadores (R33.1) e das metas (R33.5): sem banco, testáveis.
 */
import { arredondar, percentual } from '../bi/periodo';
import type { ProgressoDeMeta } from './indicadores.tipos';

export { arredondar, percentual };

/** `parte / total` em %, 2 casas; `null` com total zero. */
export function taxa(parte: number, total: number): number | null {
  return percentual(parte, total);
}

/** Comparecimento = compareceu ÷ (compareceu + não compareceu). */
export function taxaDeComparecimento(
  compareceu: number,
  naoCompareceu: number,
): number | null {
  return taxa(compareceu, compareceu + naoCompareceu);
}

/** No-show = não compareceu ÷ (compareceu + não compareceu). */
export function taxaDeNoShow(
  compareceu: number,
  naoCompareceu: number,
): number | null {
  return taxa(naoCompareceu, compareceu + naoCompareceu);
}

/** Conversão = ganhos ÷ (ganhos + perdidos) fechados no período. */
export function taxaDeConversao(
  ganhos: number,
  perdidos: number,
): number | null {
  return taxa(ganhos, ganhos + perdidos);
}

/** Ticket médio = valor ganho ÷ ganhos; `null` sem ganhos. */
export function ticketMedio(valorGanho: number, ganhos: number): number | null {
  return ganhos > 0 ? arredondar(valorGanho / ganhos, 2) : null;
}

/** Mediana de uma lista (`null` se vazia). */
export function mediana(valores: readonly number[]): number | null {
  if (valores.length === 0) {
    return null;
  }
  const ordenados = [...valores].sort((a, b) => a - b);
  const meio = Math.floor(ordenados.length / 2);
  return ordenados.length % 2 === 1
    ? ordenados[meio]
    : (ordenados[meio - 1] + ordenados[meio]) / 2;
}

/**
 * Progresso de uma meta: percentual do alvo e se foi atingida. Em indicador em
 * que "menos é melhor" (tempo até o atendimento, atrasadas) a meta é um teto:
 * atingida quando o valor não passa do alvo.
 */
export function progressoDaMeta(
  valor: number | null,
  alvo: number | null | undefined,
  melhorQuando: 'maior' | 'menor' | null,
): ProgressoDeMeta | null {
  if (alvo === null || alvo === undefined) {
    return null;
  }
  const progresso =
    valor === null
      ? null
      : alvo > 0
        ? arredondar((valor / alvo) * 100, 1)
        : null;
  const atingida =
    valor === null
      ? false
      : melhorQuando === 'menor'
        ? valor <= alvo
        : valor >= alvo;
  return { alvo, progresso, atingida };
}
