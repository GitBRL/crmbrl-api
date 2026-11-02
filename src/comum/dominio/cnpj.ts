/**
 * CNPJ (R4.4): opcional, mas, se vier, é validado pelos dígitos verificadores.
 *
 * Aceita o CNPJ numérico e o alfanumérico (Receita Federal, a partir de julho
 * de 2026): 12 caracteres de identificação — dígitos ou letras maiúsculas — e
 * 2 dígitos verificadores numéricos. O cálculo é o mesmo módulo 11 de sempre,
 * com cada caractere valendo o seu código ASCII menos 48 (`'0'..'9'` → 0..9,
 * `'A'` → 17 … `'Z'` → 42); para CNPJs só com dígitos, nada muda.
 */

const FORMATO = /^[0-9A-Z]{12}[0-9]{2}$/;
const PESOS_PRIMEIRO = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
const PESOS_SEGUNDO = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];

/** `'12.ABC.345/01DE-35'` → `'12ABC34501DE35'`: sem pontuação, letras em maiúsculas. */
export function normalizarCnpj(cnpj: string): string {
  return cnpj.replace(/[\s./-]/g, '').toUpperCase();
}

export function ehCnpjValido(cnpj: string): boolean {
  const normalizado = normalizarCnpj(cnpj);
  if (!FORMATO.test(normalizado)) {
    return false;
  }
  // Todos os caracteres iguais passam no módulo 11, mas não são CNPJs.
  if (/^(.)\1{13}$/.test(normalizado)) {
    return false;
  }
  // O formato já garantiu 14 caracteres ASCII (dígitos e letras maiúsculas).
  const valores = Array.from(
    { length: 14 },
    (_valor, indice) => normalizado.charCodeAt(indice) - 48,
  );
  const primeiro = digitoVerificador(valores.slice(0, 12), PESOS_PRIMEIRO);
  const segundo = digitoVerificador(valores.slice(0, 13), PESOS_SEGUNDO);
  return valores[12] === primeiro && valores[13] === segundo;
}

function digitoVerificador(valores: number[], pesos: number[]): number {
  const soma = valores.reduce(
    (total, valor, indice) => total + valor * pesos[indice],
    0,
  );
  const resto = soma % 11;
  return resto < 2 ? 0 : 11 - resto;
}

/** `'11222333000181'` → `'11.222.333/0001-81'` (também para o alfanumérico). */
export function formatarCnpj(cnpj: string): string {
  const n = normalizarCnpj(cnpj);
  if (n.length !== 14) {
    return cnpj;
  }
  return `${n.slice(0, 2)}.${n.slice(2, 5)}.${n.slice(5, 8)}/${n.slice(8, 12)}-${n.slice(12)}`;
}

/** CNPJ normalizado, ou `null` se vazio. Lança `TypeError` se for inválido. */
export function normalizarCnpjOpcional(
  cnpj: string | null | undefined,
): string | null {
  if (cnpj === null || cnpj === undefined || cnpj.trim() === '') {
    return null;
  }
  if (!ehCnpjValido(cnpj)) {
    throw new TypeError(`CNPJ inválido: ${cnpj}`);
  }
  return normalizarCnpj(cnpj);
}
