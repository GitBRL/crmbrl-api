/**
 * Posição fracionária dos cartões no kanban (R5.3): cada negócio guarda um
 * `double` e o quadro ordena por ele. Para pôr um cartão entre dois outros,
 * basta a média das posições vizinhas — só o cartão movido é gravado. Quando a
 * folga entre vizinhos fica pequena demais para o `double`, a etapa é
 * renumerada (1, 2, 3…) e a conta é refeita.
 */

/** Distância mínima entre dois vizinhos para ainda caber um cartão no meio. */
export const FOLGA_MINIMA_POSICAO = 1e-9;

/** Distância entre posições na renumeração e no começo/fim da coluna. */
export const PASSO_POSICAO = 1;

/**
 * Posição para um cartão entre `anterior` (o de cima) e `posterior` (o de
 * baixo). Sem vizinhos, `0`; só com o de baixo, um passo acima dele; só com o
 * de cima, um passo abaixo. Devolve `null` quando não há folga entre os dois
 * (é hora de renumerar a etapa).
 *
 * ```ts
 * posicaoEntre(1, 2)       // 1.5
 * posicaoEntre(null, 3)    // 2 (topo da coluna)
 * posicaoEntre(5, null)    // 6 (fim da coluna)
 * posicaoEntre(1, 1)       // null
 * ```
 */
export function posicaoEntre(
  anterior: number | null,
  posterior: number | null,
): number | null {
  if (anterior === null && posterior === null) {
    return 0;
  }
  if (anterior === null) {
    return (posterior as number) - PASSO_POSICAO;
  }
  if (posterior === null) {
    return anterior + PASSO_POSICAO;
  }
  if (posterior - anterior < FOLGA_MINIMA_POSICAO) {
    return null;
  }
  const meio = anterior + (posterior - anterior) / 2;
  return meio > anterior && meio < posterior ? meio : null;
}
