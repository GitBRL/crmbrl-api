/**
 * Contas das métricas base dos funis (R5.10), sem banco: o serviço busca o
 * histórico e estas funções transformam em conversão e médias.
 */

/**
 * Quantos negócios **alcançaram** cada degrau da sequência do funil (etapas
 * abertas em ordem e, por último, a de ganho). Alcançar um degrau é ter
 * passado por ele ou por qualquer degrau depois dele — quem pulou etapas conta
 * nas que pulou, e voltar atrás não desfaz o que já alcançou. Etapas fora da
 * sequência (a de perda) não contam.
 *
 * ```ts
 * // sequência a → b → ganho; n1 passou por a e b; n2 foi direto ao ganho
 * contarAlcance(['a', 'b', 'g'], [new Set(['a', 'b']), new Set(['g'])]) // [2, 2, 1]
 * ```
 */
export function contarAlcance(
  sequencia: readonly string[],
  visitasPorNegocio: Iterable<ReadonlySet<string>>,
): number[] {
  const indice = new Map(sequencia.map((etapaId, i) => [etapaId, i]));
  const alcance = sequencia.map(() => 0);
  for (const visitas of visitasPorNegocio) {
    let maisLonge = -1;
    for (const etapaId of visitas) {
      const posicao = indice.get(etapaId);
      if (posicao !== undefined && posicao > maisLonge) {
        maisLonge = posicao;
      }
    }
    for (let i = 0; i <= maisLonge; i++) {
      alcance[i] += 1;
    }
  }
  return alcance;
}

/** `numerador / denominador` com 4 casas (proporção de 0 a 1); `null` sem denominador. */
export function proporcao(
  numerador: number,
  denominador: number,
): number | null {
  if (denominador <= 0) {
    return null;
  }
  return Math.round((numerador / denominador) * 10_000) / 10_000;
}

/** Média arredondada para o inteiro mais próximo; `null` para lista vazia. */
export function mediaInteira(valores: readonly number[]): number | null {
  if (valores.length === 0) {
    return null;
  }
  const soma = valores.reduce((total, valor) => total + valor, 0);
  return Math.round(soma / valores.length);
}

/** Segundos → dias, com uma casa (para leitura rápida). */
export function segundosEmDias(segundos: number | null): number | null {
  if (segundos === null) {
    return null;
  }
  return Math.round((segundos / 86_400) * 10) / 10;
}
