/**
 * Valores em reais: `Decimal(14,2)` no banco e texto decimal na API
 * (`"1500.00"`), nunca `number` — evita erro de arredondamento.
 */
import { Prisma } from '../../generated/prisma/client';

/**
 * Formato aceito na entrada: até 12 dígitos inteiros e até 2 decimais, com
 * ponto (`"1500"`, `"1500.5"`, `"1500.50"`). Use com `@Matches(FORMATO_VALOR)`.
 */
export const FORMATO_VALOR = /^\d{1,12}(\.\d{1,2})?$/;

/** `Decimal` (ou número/texto) → `"1500.00"`; `null`/`undefined` → `null`. */
export function formatarValor(
  valor: Prisma.Decimal | number | string | null | undefined,
): string | null {
  if (valor === null || valor === undefined) {
    return null;
  }
  return new Prisma.Decimal(valor).toFixed(2);
}

/** Texto da API → `Decimal` para gravar. Lança `TypeError` fora do formato. */
export function lerValor(texto: string): Prisma.Decimal {
  if (!FORMATO_VALOR.test(texto)) {
    throw new TypeError(`Valor inválido: ${texto}`);
  }
  return new Prisma.Decimal(texto);
}
