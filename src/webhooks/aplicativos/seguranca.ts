/** Comparações e assinaturas dos adaptadores (R32.9): sempre em tempo constante. */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** Compara dois textos em tempo constante (o tamanho diferente sai rápido, sem revelar o conteúdo). */
export function iguaisEmTempoConstante(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  return bufferA.length === bufferB.length && timingSafeEqual(bufferA, bufferB);
}

/** `Typeform-Signature`: `sha256=` + base64 do HMAC-SHA256 do corpo bruto. */
export function assinaturaDoTypeform(
  segredo: string,
  corpoBruto: Buffer | string,
): string {
  return `sha256=${createHmac('sha256', segredo).update(corpoBruto).digest('base64')}`;
}

/** O primeiro valor de um cabeçalho (o Node entrega listas para alguns). */
export function cabecalho(
  cabecalhos: Readonly<Record<string, string | string[] | undefined>>,
  nome: string,
): string | null {
  const valor = cabecalhos[nome.toLowerCase()];
  if (Array.isArray(valor)) {
    return valor[0] ?? null;
  }
  return valor ?? null;
}

/** HMAC do corpo bruto com a chave, na codificação pedida (Kiwify: SHA-1 em hexadecimal; Eduzz: SHA-256 em hexadecimal ou base64). */
export function assinaturaHmac(
  algoritmo: 'sha1' | 'sha256',
  segredo: string,
  corpoBruto: Buffer | string,
  codificacao: 'hex' | 'base64',
): string {
  return createHmac(algoritmo, segredo).update(corpoBruto).digest(codificacao);
}
