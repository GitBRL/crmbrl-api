import {
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from 'node:crypto';

/**
 * TOTP (RFC 6238) com `node:crypto`: HMAC-SHA1, passo de 30 s, 6 dígitos (R2.11),
 * e base32 (RFC 4648, sem preenchimento) para a chave que a pessoa digita no aplicativo.
 */
export const PASSO_SEGUNDOS = 30;
export const DIGITOS = 6;
/** O código do passo anterior e do seguinte também valem (relógios levemente fora de hora). */
export const JANELA = 1;

const ALFABETO_BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function codificarBase32(dados: Buffer): string {
  let bits = 0;
  let valor = 0;
  let saida = '';
  for (const byte of dados) {
    valor = (valor << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      saida += ALFABETO_BASE32[(valor >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    saida += ALFABETO_BASE32[(valor << (5 - bits)) & 31];
  }
  return saida;
}

/** Decodifica base32 (aceita minúsculas, espaços, hífens e `=`). Lança erro com caractere inválido. */
export function decodificarBase32(texto: string): Buffer {
  const limpo = texto.replace(/[\s=-]/g, '').toUpperCase();
  let bits = 0;
  let valor = 0;
  const bytes: number[] = [];
  for (const letra of limpo) {
    const indice = ALFABETO_BASE32.indexOf(letra);
    if (indice < 0) {
      throw new Error('Base32 inválido.');
    }
    valor = (valor << 5) | indice;
    bits += 5;
    if (bits >= 8) {
      bytes.push((valor >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** Segredo novo de 160 bits em base32 (32 caracteres). */
export function gerarSegredoBase32(): string {
  return codificarBase32(randomBytes(20));
}

/** HOTP (RFC 4226) para um contador. */
export function hotp(
  segredo: Buffer,
  contador: number,
  digitos = DIGITOS,
): string {
  const mensagem = Buffer.alloc(8);
  mensagem.writeBigUInt64BE(BigInt(contador));
  const hmac = createHmac('sha1', segredo).update(mensagem).digest();
  const deslocamento = hmac[hmac.length - 1] & 0x0f;
  const binario =
    ((hmac[deslocamento] & 0x7f) << 24) |
    (hmac[deslocamento + 1] << 16) |
    (hmac[deslocamento + 2] << 8) |
    hmac[deslocamento + 3];
  return String(binario % 10 ** digitos).padStart(digitos, '0');
}

/** O passo de 30 s que contém o instante. */
export function passoDe(instanteMs: number): number {
  return Math.floor(instanteMs / 1000 / PASSO_SEGUNDOS);
}

/** Código TOTP do instante (para os testes e para o roteiro). */
export function gerarTotp(
  segredoBase32: string,
  instanteMs = Date.now(),
  digitos = DIGITOS,
): string {
  return hotp(decodificarBase32(segredoBase32), passoDe(instanteMs), digitos);
}

/**
 * Confere o código na janela ±1 e devolve o passo que bateu, ou `null`.
 * A comparação é em tempo constante.
 */
export function verificarTotp(
  segredoBase32: string,
  codigo: string,
  instanteMs = Date.now(),
  janela = JANELA,
  digitos = DIGITOS,
): number | null {
  if (!new RegExp(`^\\d{${digitos}}$`).test(codigo)) {
    return null;
  }
  const segredo = decodificarBase32(segredoBase32);
  const centro = passoDe(instanteMs);
  const recebido = Buffer.from(codigo);
  let achado: number | null = null;
  for (let passo = centro - janela; passo <= centro + janela; passo++) {
    if (passo < 0) {
      continue;
    }
    const esperado = Buffer.from(hotp(segredo, passo, digitos));
    if (timingSafeEqual(esperado, recebido) && achado === null) {
      achado = passo;
    }
  }
  return achado;
}

/** `otpauth://` que os aplicativos leem pelo QR. */
export function urlOtpauth(
  segredoBase32: string,
  conta: string,
  emissor: string,
): string {
  const rotulo = `${encodeURIComponent(emissor)}:${encodeURIComponent(conta)}`;
  const parametros = new URLSearchParams({
    secret: segredoBase32,
    issuer: emissor,
    algorithm: 'SHA1',
    digits: String(DIGITOS),
    period: String(PASSO_SEGUNDOS),
  });
  return `otpauth://totp/${rotulo}?${parametros.toString()}`;
}

/** Sem 0/O, 1/I/L: códigos de recuperação fáceis de ler e digitar. */
const ALFABETO_RECUPERACAO = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const TAMANHO_CODIGO_RECUPERACAO = 10;
export const QUANTIDADE_CODIGOS_RECUPERACAO = 10;

/** Um código de recuperação no formato `XXXXX-XXXXX` (≈ 49 bits). */
export function gerarCodigoDeRecuperacao(): string {
  let texto = '';
  for (let i = 0; i < TAMANHO_CODIGO_RECUPERACAO; i++) {
    texto += ALFABETO_RECUPERACAO[randomInt(ALFABETO_RECUPERACAO.length)];
  }
  return `${texto.slice(0, 5)}-${texto.slice(5)}`;
}

/** Forma canônica para comparar: maiúsculas, sem espaços e hífens. */
export function normalizarCodigo(codigo: string): string {
  return codigo.replace(/[\s-]/g, '').toUpperCase();
}
