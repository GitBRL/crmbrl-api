/**
 * Rodízio (R5.8): a escolha do próximo da vez, sem banco. A lista de
 * candidatos chega em ordem estável (quem entrou primeiro no CRM primeiro;
 * empate pelo id) e o ponteiro é o último escolhido — que pode nem estar mais
 * na lista (desligado, tirado do rodízio): o próximo é o primeiro candidato
 * depois da posição que ele ocupava, voltando ao começo no fim da lista.
 */

/** Um usuário na ordem do rodízio. */
export interface PosicaoNoRodizio {
  readonly id: string;
  readonly criadoEm: Date;
}

/** Ordem estável do rodízio: `criadoEm` crescente e, no empate, o id. */
export function compararNoRodizio(
  a: PosicaoNoRodizio,
  b: PosicaoNoRodizio,
): number {
  const diferenca = a.criadoEm.getTime() - b.criadoEm.getTime();
  if (diferenca !== 0) {
    return diferenca;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Cópia ordenada da lista, na ordem do rodízio. */
export function ordenarParaRodizio<T extends PosicaoNoRodizio>(
  candidatos: readonly T[],
): T[] {
  return [...candidatos].sort(compararNoRodizio);
}

/**
 * O próximo da vez depois de `ponteiro` (o último escolhido). Sem ponteiro, o
 * primeiro da lista; sem candidatos, `null`.
 *
 * ```ts
 * proximoDoRodizio([ana, bia, caio], bia)  // caio
 * proximoDoRodizio([ana, bia, caio], caio) // ana (volta ao começo)
 * proximoDoRodizio([ana, caio], bia)       // caio (bia saiu do rodízio)
 * ```
 */
export function proximoDoRodizio<T extends PosicaoNoRodizio>(
  candidatos: readonly T[],
  ponteiro: PosicaoNoRodizio | null,
): T | null {
  const ordenados = ordenarParaRodizio(candidatos);
  if (ordenados.length === 0) {
    return null;
  }
  if (!ponteiro) {
    return ordenados[0];
  }
  return (
    ordenados.find((candidato) => compararNoRodizio(candidato, ponteiro) > 0) ??
    ordenados[0]
  );
}
