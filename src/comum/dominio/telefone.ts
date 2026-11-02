/**
 * Telefone (R4.1): normalizado para E.164 só com dígitos (`5511987654321`).
 * Números brasileiros com 10 ou 11 dígitos (DDD + número) ganham o `55`, e o
 * DDD é validado. Números de outros países vêm com o código do país (e,
 * de preferência, com `+`).
 */

/** DDDs em uso no Brasil (Anatel). */
export const DDDS_VALIDOS: ReadonlySet<string> = new Set([
  '11',
  '12',
  '13',
  '14',
  '15',
  '16',
  '17',
  '18',
  '19',
  '21',
  '22',
  '24',
  '27',
  '28',
  '31',
  '32',
  '33',
  '34',
  '35',
  '37',
  '38',
  '41',
  '42',
  '43',
  '44',
  '45',
  '46',
  '47',
  '48',
  '49',
  '51',
  '53',
  '54',
  '55',
  '61',
  '62',
  '63',
  '64',
  '65',
  '66',
  '67',
  '68',
  '69',
  '71',
  '73',
  '74',
  '75',
  '77',
  '79',
  '81',
  '82',
  '83',
  '84',
  '85',
  '86',
  '87',
  '88',
  '89',
  '91',
  '92',
  '93',
  '94',
  '95',
  '96',
  '97',
  '98',
  '99',
]);

export type ResultadoTelefone =
  | { readonly valido: true; readonly telefone: string }
  | { readonly valido: false; readonly motivo: string };

/** E.164 só com dígitos: de 8 a 15, sem zero no começo (o mesmo CHECK do banco). */
const E164 = /^[1-9]\d{7,14}$/;

/**
 * Normaliza um telefone digitado de qualquer jeito: `(11) 98765-4321`,
 * `+55 11 98765-4321`, `011 98765-4321`, `5511987654321`…
 *
 * ```ts
 * normalizarTelefone('(11) 98765-4321') // { valido: true, telefone: '5511987654321' }
 * normalizarTelefone('(20) 98765-4321') // { valido: false, motivo: 'DDD 20 não existe.' }
 * ```
 */
export function normalizarTelefone(entrada: string): ResultadoTelefone {
  const texto = entrada.trim();
  const internacional = texto.startsWith('+') || texto.startsWith('00');
  let digitos = texto.replace(/\D/g, '');
  if (texto.startsWith('00')) {
    digitos = digitos.slice(2);
  }
  if (digitos.length === 0) {
    return { valido: false, motivo: 'Telefone vazio.' };
  }

  // Formato nacional com o zero do prefixo de longa distância: 0 + DDD + número.
  if (
    !internacional &&
    digitos.startsWith('0') &&
    [11, 12].includes(digitos.length)
  ) {
    digitos = digitos.slice(1);
  }

  // Brasil sem o código do país: DDD + 8 ou 9 dígitos.
  if (!internacional && (digitos.length === 10 || digitos.length === 11)) {
    return validarBrasileiro(digitos);
  }

  // Brasil com o código do país: 55 + DDD + 8 ou 9 dígitos.
  if (
    digitos.startsWith('55') &&
    (digitos.length === 12 || digitos.length === 13)
  ) {
    return validarBrasileiro(digitos.slice(2));
  }

  if (!E164.test(digitos)) {
    return {
      valido: false,
      motivo:
        'Telefone inválido: use DDD + número (Brasil) ou o código do país (+…) com até 15 dígitos.',
    };
  }
  return { valido: true, telefone: digitos };
}

function validarBrasileiro(nacional: string): ResultadoTelefone {
  const ddd = nacional.slice(0, 2);
  if (!DDDS_VALIDOS.has(ddd)) {
    return { valido: false, motivo: `DDD ${ddd} não existe.` };
  }
  const numero = nacional.slice(2);
  if (numero.length === 9 && !numero.startsWith('9')) {
    return {
      valido: false,
      motivo: 'Celular com 9 dígitos precisa começar com 9.',
    };
  }
  return { valido: true, telefone: `55${nacional}` };
}

/** Telefone normalizado, ou `null` se vazio. Lança `TypeError` com o motivo se for inválido. */
export function normalizarTelefoneOpcional(
  entrada: string | null | undefined,
): string | null {
  if (entrada === null || entrada === undefined || entrada.trim() === '') {
    return null;
  }
  const resultado = normalizarTelefone(entrada);
  if (!resultado.valido) {
    throw new TypeError(resultado.motivo);
  }
  return resultado.telefone;
}
