/**
 * Hierarquia de usuários (R1.2, R1.3) — regras puras, sem banco.
 *
 * - Membro responde a um líder **ativo do mesmo setor**; líder, a um C-level
 *   ativo (o "C-level responsável"); Admin e C-level não têm líder (R1.2).
 * - Mudar o papel ou o setor revalida a hierarquia: quem tem liderados não
 *   pode ir para um papel ou setor que não os lidere (R1.3).
 */
import {
  type ComPapel,
  liderEsperado,
  nivelDoPapel,
  podeLiderar,
  rotuloDaPessoa,
  rotuloDoLiderEsperado,
} from '../../comum/dominio/papeis';

/** O que a validação precisa saber do líder escolhido. */
export interface LiderCandidato extends ComPapel {
  readonly id: string;
  readonly nome: string;
  readonly ativo: boolean;
}

/** Um liderado, para a checagem do R1.3. */
export interface Liderado extends ComPapel {
  readonly id: string;
  readonly nome: string;
}

/** Violação de regra encontrada (vira `422 regra_violada`). */
export interface ProblemaDeRegra {
  readonly regra: string;
  readonly mensagem: string;
  readonly detalhes?: Record<string, unknown>;
}

/** "um Líder Comercial", "um C-level" — o líder que o papel exige. */
function descreverLiderEsperado(pessoa: ComPapel): string {
  const esperado = liderEsperado(pessoa);
  return esperado ? `um ${rotuloDoLiderEsperado(esperado)} ativo` : 'nenhum';
}

/**
 * Confere o líder de quem tem (ou vai ter) o papel e o setor de `pessoa`
 * (R1.2). `null` = tudo certo. `usuarioId` evita que alguém seja líder de si
 * mesmo.
 *
 * ```ts
 * problemaDeLideranca({ papel: 'MEMBRO', area: 'COMERCIAL' }, liderDeMarketing)
 * // { regra: 'R1.2', mensagem: 'O líder de quem é Comercial precisa ser um Líder Comercial ativo …' }
 * ```
 */
export function problemaDeLideranca(
  pessoa: ComPapel,
  lider: LiderCandidato | null,
  usuarioId?: string,
): ProblemaDeRegra | null {
  const { papel, area } = pessoa;
  const esperado = liderEsperado(pessoa);
  const rotulo = rotuloDaPessoa(pessoa);
  if (esperado === null) {
    return lider
      ? {
          regra: 'R1.2',
          mensagem: `Quem é ${rotulo} não tem líder: deixe o líder em branco.`,
          detalhes: { papel, area, liderId: lider.id },
        }
      : null;
  }
  if (!lider) {
    return {
      regra: 'R1.2',
      mensagem:
        nivelDoPapel(papel) === 'LIDER'
          ? `Quem é ${rotulo} precisa de um C-level ativo como líder (o C-level responsável).`
          : `Quem é ${rotulo} precisa de um líder: ${descreverLiderEsperado(pessoa)} do mesmo setor.`,
      detalhes: { papel, area, liderEsperado: esperado },
    };
  }
  if (usuarioId && lider.id === usuarioId) {
    return {
      regra: 'R1.2',
      mensagem: 'Ninguém pode ser líder de si mesmo.',
      detalhes: { papel, area, liderId: lider.id },
    };
  }
  if (!podeLiderar(lider, pessoa)) {
    const motivo =
      nivelDoPapel(papel) === 'MEMBRO' && nivelDoPapel(lider.papel) === 'LIDER'
        ? `${lider.nome} é ${rotuloDaPessoa(lider)}, de outro setor`
        : `${lider.nome} é ${rotuloDaPessoa(lider)}`;
    return {
      regra: 'R1.2',
      mensagem:
        nivelDoPapel(papel) === 'LIDER'
          ? `O líder de quem é ${rotulo} precisa ser um C-level ativo — ${motivo}.`
          : `O líder de quem é ${rotulo} precisa ser ${descreverLiderEsperado(pessoa)}, do mesmo setor — ${motivo}.`,
      detalhes: {
        papel,
        area,
        liderId: lider.id,
        papelDoLider: lider.papel,
        areaDoLider: lider.area,
        liderEsperado: esperado,
      },
    };
  }
  if (!lider.ativo) {
    return {
      regra: 'R1.2',
      mensagem: `O líder escolhido, ${lider.nome}, foi desligado: o líder precisa estar ativo.`,
      detalhes: { papel, area, liderId: lider.id },
    };
  }
  return null;
}

/**
 * Liderados que `novo` (o papel e o setor depois da mudança) não pode liderar
 * (R1.3) — os que precisariam de outro líder se a mudança acontecesse.
 */
export function lideradosSemLiderValido<T extends Liderado>(
  novo: ComPapel,
  liderados: readonly T[],
): T[] {
  return liderados.filter((liderado) => !podeLiderar(novo, liderado));
}

/** "Ana", "Ana e Bia", "Ana, Bia e Caio". */
export function juntarNomes(nomes: readonly string[]): string {
  if (nomes.length <= 1) {
    return nomes.join('');
  }
  return `${nomes.slice(0, -1).join(', ')} e ${nomes[nomes.length - 1]}`;
}

/**
 * A mudança de papel ou de setor de quem tem liderados (R1.3): `null` se todos
 * continuam com um líder válido; senão, o problema com a lista de quem precisa
 * de novo líder.
 */
export function problemaDeMudancaDePapel(
  usuario: ComPapel & { readonly nome: string },
  novo: ComPapel,
  lideradosAtivos: readonly Liderado[],
): ProblemaDeRegra | null {
  if (novo.papel === usuario.papel && novo.area === usuario.area) {
    return null;
  }
  const semLider = lideradosSemLiderValido(novo, lideradosAtivos);
  if (semLider.length === 0) {
    return null;
  }
  const quantidade =
    semLider.length === 1 ? '1 liderado' : `${semLider.length} liderados`;
  return {
    regra: 'R1.3',
    mensagem:
      `${usuario.nome} tem ${quantidade} que ${semLider.length === 1 ? 'precisa' : 'precisam'} de um novo líder antes de ` +
      `mudar para ${rotuloDaPessoa(novo)}: ${juntarNomes(semLider.map(({ nome }) => nome))}.`,
    detalhes: {
      papelAtual: usuario.papel,
      areaAtual: usuario.area,
      novoPapel: novo.papel,
      novaArea: novo.area,
      liderados: semLider.map(({ id, nome, papel, area }) => ({
        id,
        nome,
        papel,
        area,
      })),
    },
  };
}

/**
 * O liderado responde a quem o papel dele espera? `false` no estado provisório
 * do R7.3: depois do desligamento de um líder, os liderados respondem ao
 * destinatário (um C-level) até o Admin definir um novo líder.
 */
export function temLiderEsperado(
  pessoa: ComPapel,
  lider: (ComPapel & { readonly ativo: boolean }) | null,
): boolean {
  if (liderEsperado(pessoa) === null) {
    return lider === null;
  }
  return lider !== null && lider.ativo && podeLiderar(lider, pessoa);
}
