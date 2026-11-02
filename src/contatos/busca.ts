import type { Prisma } from '../generated/prisma/client';

/**
 * Escapa os curingas do `LIKE` (`%`, `_` e a barra de escape). O Prisma 7 não
 * escapa o texto de `contains`/`startsWith` nem o de `equals` com
 * `mode: 'insensitive'` (vira `ILIKE` puro): sem isto, buscar "50%" acharia
 * "500".
 */
export function escaparLike(texto: string): string {
  return texto.replace(/[\\%_]/g, (caractere) => `\\${caractere}`);
}

/** Só dígitos, sem os zeros do prefixo de longa distância (`011…` → `11…`). */
export function digitosDaBusca(texto: string): string {
  return texto.replace(/\D/g, '').replace(/^0+/, '');
}

/** O texto parece um telefone digitado: só dígitos e pontuação de telefone. */
export function pareceTelefone(texto: string): boolean {
  return /^[\d\s()+.-]+$/.test(texto) && /\d/.test(texto);
}

/** Termos de uma busca livre: até 6 palavras, sem vazios. */
export function termosDaBusca(texto: string): string[] {
  return texto.trim().split(/\s+/).filter(Boolean).slice(0, 6);
}

/**
 * Busca de contatos por nome, e-mail ou telefone.
 *
 * - Texto com cara de telefone (`(11) 98765-4321`, `+55 11…`): compara os
 *   dígitos com o telefone em E.164 (e com o e-mail, que pode ter números).
 * - Senão, cada palavra precisa aparecer no nome (sem diferenciar maiúsculas)
 *   ou no e-mail: "maria gmail" acha Maria Souza <maria@gmail.com>.
 */
export function filtroDeBuscaDeContatos(
  busca: string | undefined,
): Prisma.ContatoWhereInput | undefined {
  const texto = busca?.trim();
  if (!texto) {
    return undefined;
  }
  if (pareceTelefone(texto)) {
    const digitos = digitosDaBusca(texto);
    return {
      OR: [
        ...(digitos ? [{ telefone: { contains: digitos } }] : []),
        { email: { contains: escaparLike(texto.toLowerCase()) } },
      ],
    };
  }
  return {
    AND: termosDaBusca(texto).map((termo) => ({
      OR: [
        {
          nome: { contains: escaparLike(termo), mode: 'insensitive' as const },
        },
        { email: { contains: escaparLike(termo.toLowerCase()) } },
      ],
    })),
  };
}

/** Busca de empresas por nome, CNPJ (com ou sem pontuação), e-mail ou telefone. */
export function filtroDeBuscaDeEmpresas(
  busca: string | undefined,
): Prisma.EmpresaWhereInput | undefined {
  const texto = busca?.trim();
  if (!texto) {
    return undefined;
  }
  const alternativasExtras: Prisma.EmpresaWhereInput[] = [];
  const cnpj = texto.replace(/[\s./-]/g, '').toUpperCase();
  if (/^[0-9A-Z]{4,14}$/.test(cnpj) && /\d/.test(cnpj)) {
    alternativasExtras.push({ cnpj: { contains: escaparLike(cnpj) } });
  }
  if (pareceTelefone(texto)) {
    const digitos = digitosDaBusca(texto);
    if (digitos.length >= 3) {
      alternativasExtras.push({ telefone: { contains: digitos } });
    }
  }
  const porTermos: Prisma.EmpresaWhereInput = {
    AND: termosDaBusca(texto).map((termo) => ({
      OR: [
        {
          nome: { contains: escaparLike(termo), mode: 'insensitive' as const },
        },
        { email: { contains: escaparLike(termo.toLowerCase()) } },
      ],
    })),
  };
  return alternativasExtras.length > 0
    ? { OR: [porTermos, ...alternativasExtras] }
    : porTermos;
}
