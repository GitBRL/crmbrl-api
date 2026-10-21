/**
 * E-mail (R1.1, R4.1): gravado aparado e em minúsculas; a comparação, por
 * consequência, não diferencia maiúsculas.
 */

/** Tamanho máximo de um endereço (RFC 5321). */
export const TAMANHO_MAXIMO_EMAIL = 254;

const FORMATO_EMAIL =
  /^[^\s@"(),:;<>[\\\]]+@[^\s@"(),:;<>[\\\]]+\.[^\s@"(),:;<>[\\\]]{2,}$/;

/** `'  Fulano@BRL.com.br '` → `'fulano@brl.com.br'`. */
export function normalizarEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Formato plausível de e-mail (depois de normalizado). */
export function ehEmailValido(email: string): boolean {
  const normalizado = normalizarEmail(email);
  return (
    normalizado.length <= TAMANHO_MAXIMO_EMAIL &&
    FORMATO_EMAIL.test(normalizado) &&
    !normalizado.includes('..')
  );
}

/** E-mail normalizado, ou `null` se vazio. Lança `TypeError` se o formato for inválido. */
export function normalizarEmailOpcional(
  email: string | null | undefined,
): string | null {
  if (email === null || email === undefined || email.trim() === '') {
    return null;
  }
  if (!ehEmailValido(email)) {
    throw new TypeError(`E-mail inválido: ${email}`);
  }
  return normalizarEmail(email);
}
