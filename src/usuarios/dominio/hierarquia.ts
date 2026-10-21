/**
 * Hierarquia de usuários (R1.2, R1.3) — regras puras, sem banco.
 *
 * - Membro responde a um líder **ativo da mesma área**; líder, a um C-level
 *   ativo (o "C-level responsável"); Admin e C-level não têm líder (R1.2).
 * - Mudar o papel revalida a hierarquia: quem tem liderados não pode ir para
 *   um papel que não os lidere (R1.3).
 */
import {
  liderEsperado,
  nivelDoPapel,
  podeLiderar,
  rotuloDoPapel,
} from '../../comum/dominio/papeis';
import type { Papel } from '../../generated/prisma/client';

/** O que a validação precisa saber do líder escolhido. */
export interface LiderCandidato {
  readonly id: string;
  readonly nome: string;
  readonly papel: Papel;
  readonly ativo: boolean;
}

/** Um liderado, para a checagem do R1.3. */
export interface Liderado {
  readonly id: string;
  readonly nome: string;
  readonly papel: Papel;
}

/** Violação de regra encontrada (vira `422 regra_violada`). */
export interface ProblemaDeRegra {
  readonly regra: string;
  readonly mensagem: string;
  readonly detalhes?: Record<string, unknown>;
}

/** "um Líder Comercial", "um C-level" — o líder que o papel exige. */
function descreverLiderEsperado(papel: Papel): string {
  const esperado = liderEsperado(papel);
  return esperado ? `um ${rotuloDoPapel(esperado)} ativo` : 'nenhum';
}

/**
 * Confere o líder de quem tem (ou vai ter) o `papel` (R1.2). `null` = tudo
 * certo. `usuarioId` evita que alguém seja líder de si mesmo.
 *
 * ```ts
 * problemaDeLideranca('COMERCIAL', liderDeMarketing)
 * // { regra: 'R1.2', mensagem: 'O líder de quem é Comercial precisa ser um Líder Comercial ativo …' }
 * ```
 */
export function problemaDeLideranca(
  papel: Papel,
  lider: LiderCandidato | null,
  usuarioId?: string,
): ProblemaDeRegra | null {
  const esperado = liderEsperado(papel);
  const rotulo = rotuloDoPapel(papel);
  if (esperado === null) {
    return lider
      ? {
          regra: 'R1.2',
          mensagem: `Quem é ${rotulo} não tem líder: deixe o líder em branco.`,
          detalhes: { papel, liderId: lider.id },
        }
      : null;
  }
  if (!lider) {
    return {
      regra: 'R1.2',
      mensagem:
        nivelDoPapel(papel) === 'LIDER'
          ? `Quem é ${rotulo} precisa de um C-level ativo como líder (o C-level responsável).`
          : `Quem é ${rotulo} precisa de um líder: ${descreverLiderEsperado(papel)} da mesma área.`,
      detalhes: { papel, liderEsperado: esperado },
    };
  }
  if (usuarioId && lider.id === usuarioId) {
    return {
      regra: 'R1.2',
      mensagem: 'Ninguém pode ser líder de si mesmo.',
      detalhes: { papel, liderId: lider.id },
    };
  }
  if (!podeLiderar(lider.papel, papel)) {
    const motivo =
      nivelDoPapel(papel) === 'MEMBRO' && nivelDoPapel(lider.papel) === 'LIDER'
        ? `${lider.nome} é ${rotuloDoPapel(lider.papel)}, de outra área`
        : `${lider.nome} é ${rotuloDoPapel(lider.papel)}`;
    return {
      regra: 'R1.2',
      mensagem:
        nivelDoPapel(papel) === 'LIDER'
          ? `O líder de quem é ${rotulo} precisa ser um C-level ativo — ${motivo}.`
          : `O líder de quem é ${rotulo} precisa ser ${descreverLiderEsperado(papel)}, da mesma área — ${motivo}.`,
      detalhes: {
        papel,
        liderId: lider.id,
        papelDoLider: lider.papel,
        liderEsperado: esperado,
      },
    };
  }
  if (!lider.ativo) {
    return {
      regra: 'R1.2',
      mensagem: `O líder escolhido, ${lider.nome}, foi desligado: o líder precisa estar ativo.`,
      detalhes: { papel, liderId: lider.id },
    };
  }
  return null;
}

/**
 * Liderados que o `novoPapel` não pode liderar (R1.3) — os que precisariam de
 * outro líder se a mudança acontecesse.
 */
export function lideradosSemLiderValido<T extends Liderado>(
  novoPapel: Papel,
  liderados: readonly T[],
): T[] {
  return liderados.filter(
    (liderado) => !podeLiderar(novoPapel, liderado.papel),
  );
}

/** "Ana", "Ana e Bia", "Ana, Bia e Caio". */
export function juntarNomes(nomes: readonly string[]): string {
  if (nomes.length <= 1) {
    return nomes.join('');
  }
  return `${nomes.slice(0, -1).join(', ')} e ${nomes[nomes.length - 1]}`;
}

/**
 * A mudança de papel de quem tem liderados (R1.3): `null` se todos continuam
 * com um líder válido; senão, o problema com a lista de quem precisa de novo
 * líder.
 */
export function problemaDeMudancaDePapel(
  usuario: { readonly nome: string; readonly papel: Papel },
  novoPapel: Papel,
  lideradosAtivos: readonly Liderado[],
): ProblemaDeRegra | null {
  if (novoPapel === usuario.papel) {
    return null;
  }
  const semLider = lideradosSemLiderValido(novoPapel, lideradosAtivos);
  if (semLider.length === 0) {
    return null;
  }
  const quantidade =
    semLider.length === 1 ? '1 liderado' : `${semLider.length} liderados`;
  return {
    regra: 'R1.3',
    mensagem:
      `${usuario.nome} tem ${quantidade} que ${semLider.length === 1 ? 'precisa' : 'precisam'} de um novo líder antes de ` +
      `mudar para ${rotuloDoPapel(novoPapel)}: ${juntarNomes(semLider.map(({ nome }) => nome))}.`,
    detalhes: {
      papelAtual: usuario.papel,
      novoPapel,
      liderados: semLider.map(({ id, nome, papel }) => ({ id, nome, papel })),
    },
  };
}

/**
 * O liderado responde a quem o papel dele espera? `false` no estado provisório
 * do R7.3: depois do desligamento de um líder, os liderados respondem ao
 * destinatário (um C-level) até o Admin definir um novo líder.
 */
export function temLiderEsperado(
  papel: Papel,
  lider: { readonly papel: Papel; readonly ativo: boolean } | null,
): boolean {
  const esperado = liderEsperado(papel);
  if (esperado === null) {
    return lider === null;
  }
  return lider !== null && lider.ativo && lider.papel === esperado;
}
