/**
 * Etiquetas livres (R4.7): aparadas, com espaços internos colapsados e sem
 * duplicatas (sem diferenciar maiúsculas — vale a primeira grafia).
 */

export const TAMANHO_MAXIMO_ETIQUETA = 50;
export const QUANTIDADE_MAXIMA_ETIQUETAS = 50;

/**
 * ```ts
 * normalizarEtiquetas([' VIP ', 'vip', 'Lead  quente', '']) // ['VIP', 'Lead quente']
 * ```
 * Etiquetas maiores que 50 caracteres são cortadas; passam no máximo 50.
 */
export function normalizarEtiquetas(
  etiquetas: readonly unknown[] | null | undefined,
): string[] {
  const resultado: string[] = [];
  const vistas = new Set<string>();
  for (const item of etiquetas ?? []) {
    if (typeof item !== 'string') {
      continue;
    }
    const etiqueta = item
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, TAMANHO_MAXIMO_ETIQUETA)
      .trim();
    if (!etiqueta) {
      continue;
    }
    const chave = etiqueta.toLocaleLowerCase('pt-BR');
    if (vistas.has(chave)) {
      continue;
    }
    vistas.add(chave);
    resultado.push(etiqueta);
    if (resultado.length >= QUANTIDADE_MAXIMA_ETIQUETAS) {
      break;
    }
  }
  return resultado;
}

/** Junta etiquetas novas às existentes, sem duplicar (para reconversões e etiquetas fixas). */
export function juntarEtiquetas(
  existentes: readonly unknown[] | null | undefined,
  novas: readonly unknown[] | null | undefined,
): string[] {
  return normalizarEtiquetas([...(existentes ?? []), ...(novas ?? [])]);
}
