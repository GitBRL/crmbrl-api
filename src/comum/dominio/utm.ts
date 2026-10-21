/**
 * Parâmetros UTM da origem de um contato ou negócio (R4.3): `source`, `medium`,
 * `campaign`, `term` e `content`. Ficam em colunas `jsonb` no formato `Utm`.
 */

export const CAMPOS_UTM = [
  'source',
  'medium',
  'campaign',
  'term',
  'content',
] as const;

export type CampoUtm = (typeof CAMPOS_UTM)[number];

export type Utm = Partial<Record<CampoUtm, string>>;

const TAMANHO_MAXIMO = 200;

/**
 * Aceita as chaves com ou sem o prefixo `utm_` (`utm_source` ou `source`),
 * apara os valores e descarta os vazios. Devolve `null` se não sobrar nenhum.
 *
 * ```ts
 * normalizarUtm({ utm_source: ' google ', utm_medium: 'cpc', outra: 'x' })
 * // { source: 'google', medium: 'cpc' }
 * ```
 */
export function normalizarUtm(
  entrada: Readonly<Record<string, unknown>> | null | undefined,
): Utm | null {
  if (!entrada) {
    return null;
  }
  const utm: Utm = {};
  for (const campo of CAMPOS_UTM) {
    const valor = entrada[campo] ?? entrada[`utm_${campo}`];
    if (typeof valor === 'string' || typeof valor === 'number') {
      const texto = String(valor).trim().slice(0, TAMANHO_MAXIMO);
      if (texto) {
        utm[campo] = texto;
      }
    }
  }
  return Object.keys(utm).length > 0 ? utm : null;
}
