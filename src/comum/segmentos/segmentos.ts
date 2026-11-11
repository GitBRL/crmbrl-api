/**
 * Segmentos (Onda B, §2.1): filtro declarativo de contatos em JSON → `where` do
 * Prisma. Usado pelo público dos disparos e pelas condições das automações.
 * Funções puras; a consulta fica no `SegmentosService`.
 *
 * ```json
 * {
 *   "combinacao": "todas",
 *   "condicoes": [
 *     { "campo": "etiquetas", "operador": "contem_alguma", "valor": ["cliente", "vip"] },
 *     { "campo": "negocio", "operador": "tem", "valor": { "funilId": "…", "status": ["ABERTO"] } },
 *     { "campo": "ultima_interacao_em", "operador": "mais_de_dias", "valor": 30 },
 *     { "grupo": { "combinacao": "qualquer", "condicoes": [
 *       { "campo": "campos.cidade", "operador": "igual", "valor": "Campinas" },
 *       { "campo": "utm.source", "operador": "igual", "valor": "instagram" }
 *     ] } }
 *   ]
 * }
 * ```
 */
import {
  OrigemContato,
  Prisma,
  StatusNegocio,
} from '../../generated/prisma/client';
import { FORMATO_DA_CHAVE_DE_SETOR } from '../validacao/setor';
import { DadosInvalidosException } from '../erros/excecoes';
import type { Area } from '../dominio/setores';

export type CombinacaoDeSegmento = 'todas' | 'qualquer';

export interface Segmento {
  /** `todas` (E, o padrão) ou `qualquer` (OU). */
  combinacao?: CombinacaoDeSegmento;
  condicoes: CondicaoDeSegmento[];
}

export interface CondicaoSimples {
  campo: string;
  operador: string;
  valor?: unknown;
}

export type CondicaoDeSegmento = CondicaoSimples | { grupo: Segmento };

/** Filtro de negócio das condições `negocio`. */
export interface FiltroDeNegocio {
  funilId?: string;
  etapaIds?: string[];
  status?: StatusNegocio[];
  area?: Area;
}

export type TipoDeValor =
  | 'nenhum'
  | 'textos'
  | 'texto'
  | 'ids'
  | 'origens'
  | 'areas'
  | 'data'
  | 'periodo'
  | 'dias'
  | 'booleano'
  | 'escalar'
  | 'numero'
  | 'negocio';

export interface DefinicaoDeCampo {
  rotulo: string;
  operadores: Readonly<Record<string, { rotulo: string; valor: TipoDeValor }>>;
}

const OPERADORES_DE_DATA = {
  antes: { rotulo: 'antes de', valor: 'data' },
  depois: { rotulo: 'depois de', valor: 'data' },
  entre: { rotulo: 'entre', valor: 'periodo' },
  ultimos_dias: { rotulo: 'nos últimos N dias', valor: 'dias' },
  mais_de_dias: { rotulo: 'há mais de N dias', valor: 'dias' },
} as const;

const OPERADORES_DE_UTM = {
  igual: { rotulo: 'é', valor: 'texto' },
  contem: { rotulo: 'contém', valor: 'texto' },
  vazio: { rotulo: 'está vazio', valor: 'nenhum' },
  preenchido: { rotulo: 'está preenchido', valor: 'nenhum' },
} as const;

const OPERADORES_DE_PRESENCA = {
  preenchido: { rotulo: 'está preenchido', valor: 'nenhum' },
  vazio: { rotulo: 'está vazio', valor: 'nenhum' },
} as const;

const PARTES_DA_UTM = [
  'source',
  'medium',
  'campaign',
  'term',
  'content',
] as const;

/**
 * Campos fixos do segmento (a chave é o `campo`). Além deles:
 * `campos.<chave>` (campo personalizado do contato), `utm.<parte>` (UTM da
 * última origem) e `primeira_utm.<parte>` (UTM da primeira origem).
 */
export const CAMPOS_DE_SEGMENTO: Readonly<Record<string, DefinicaoDeCampo>> = {
  id: {
    rotulo: 'Contato',
    operadores: {
      em: { rotulo: 'é um destes', valor: 'ids' },
      fora_de: { rotulo: 'não é nenhum destes', valor: 'ids' },
    },
  },
  etiquetas: {
    rotulo: 'Etiquetas',
    operadores: {
      contem_alguma: { rotulo: 'tem alguma de', valor: 'textos' },
      contem_todas: { rotulo: 'tem todas', valor: 'textos' },
      nao_contem: { rotulo: 'não tem nenhuma de', valor: 'textos' },
    },
  },
  origem: {
    rotulo: 'Última origem',
    operadores: {
      em: { rotulo: 'é uma de', valor: 'origens' },
      fora_de: { rotulo: 'não é nenhuma de', valor: 'origens' },
    },
  },
  primeira_origem: {
    rotulo: 'Primeira origem',
    operadores: {
      em: { rotulo: 'é uma de', valor: 'origens' },
      fora_de: { rotulo: 'não é nenhuma de', valor: 'origens' },
    },
  },
  responsavel: {
    rotulo: 'Responsável',
    operadores: {
      em: { rotulo: 'é um de', valor: 'ids' },
      fora_de: { rotulo: 'não é nenhum de', valor: 'ids' },
      ...OPERADORES_DE_PRESENCA,
    },
  },
  area_responsavel: {
    rotulo: 'Área do responsável',
    operadores: { em: { rotulo: 'é uma de', valor: 'areas' } },
  },
  empresa: {
    rotulo: 'Empresa',
    operadores: {
      em: { rotulo: 'é uma de', valor: 'ids' },
      ...OPERADORES_DE_PRESENCA,
    },
  },
  email: { rotulo: 'E-mail', operadores: OPERADORES_DE_PRESENCA },
  telefone: { rotulo: 'Telefone', operadores: OPERADORES_DE_PRESENCA },
  negocio: {
    rotulo: 'Negócio',
    operadores: {
      tem: { rotulo: 'tem negócio', valor: 'negocio' },
      nao_tem: { rotulo: 'não tem negócio', valor: 'negocio' },
    },
  },
  criado_em: { rotulo: 'Data de criação', operadores: OPERADORES_DE_DATA },
  ultima_origem_em: {
    rotulo: 'Última conversão',
    operadores: OPERADORES_DE_DATA,
  },
  ultima_interacao_em: {
    rotulo: 'Última interação (mensagem em conversa)',
    operadores: OPERADORES_DE_DATA,
  },
  opt_out: {
    rotulo: 'Opt-out de marketing',
    operadores: { igual: { rotulo: 'é', valor: 'booleano' } },
  },
};

/** Operadores dos campos personalizados (`campos.<chave>`). */
export const OPERADORES_DE_CAMPO_PERSONALIZADO = {
  igual: { rotulo: 'é', valor: 'escalar' },
  diferente: { rotulo: 'não é', valor: 'escalar' },
  contem: { rotulo: 'contém', valor: 'texto' },
  maior: { rotulo: 'maior que', valor: 'numero' },
  menor: { rotulo: 'menor que', valor: 'numero' },
  ...OPERADORES_DE_PRESENCA,
} as const;

export { OPERADORES_DE_UTM, PARTES_DA_UTM };

const LIMITE_DE_CONDICOES = 50;
const PROFUNDIDADE_MAXIMA = 3;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIA_MS = 86_400_000;

export interface ProblemaDeSegmento {
  /** Ex.: `condicoes[2].valor`. */
  caminho: string;
  mensagem: string;
}

/**
 * Confere o formato e devolve o segmento normalizado. Lança
 * `DadosInvalidosException` com `detalhes.problemas` (caminho + mensagem).
 */
export function validarSegmento(entrada: unknown): Segmento {
  const problemas: ProblemaDeSegmento[] = [];
  const contador = { condicoes: 0 };
  const segmento = validarGrupo(entrada, 'segmento', 1, problemas, contador);
  if (problemas.length > 0 || !segmento) {
    throw new DadosInvalidosException(
      problemas[0]?.mensagem ?? 'Segmento inválido.',
      { problemas },
    );
  }
  return segmento;
}

/** Como `validarSegmento`, sem lançar: devolve os problemas. */
export function problemasDoSegmento(entrada: unknown): ProblemaDeSegmento[] {
  try {
    validarSegmento(entrada);
    return [];
  } catch (erro) {
    if (erro instanceof DadosInvalidosException) {
      return (erro.detalhes?.problemas as ProblemaDeSegmento[]) ?? [];
    }
    throw erro;
  }
}

function validarGrupo(
  entrada: unknown,
  caminho: string,
  profundidade: number,
  problemas: ProblemaDeSegmento[],
  contador: { condicoes: number },
): Segmento | null {
  if (!ehObjeto(entrada)) {
    problemas.push({
      caminho,
      mensagem: 'O segmento precisa ser um objeto com "condicoes".',
    });
    return null;
  }
  if (profundidade > PROFUNDIDADE_MAXIMA) {
    problemas.push({
      caminho,
      mensagem: `No máximo ${PROFUNDIDADE_MAXIMA} níveis de grupos.`,
    });
    return null;
  }
  const combinacao = entrada.combinacao ?? 'todas';
  if (combinacao !== 'todas' && combinacao !== 'qualquer') {
    problemas.push({
      caminho: `${caminho}.combinacao`,
      mensagem: 'Use "todas" ou "qualquer".',
    });
  }
  if (!Array.isArray(entrada.condicoes)) {
    problemas.push({
      caminho: `${caminho}.condicoes`,
      mensagem: 'Informe a lista de condições.',
    });
    return null;
  }
  const condicoes: CondicaoDeSegmento[] = [];
  entrada.condicoes.forEach((condicao: unknown, indice: number) => {
    const aqui = `${caminho}.condicoes[${indice}]`;
    if (++contador.condicoes > LIMITE_DE_CONDICOES) {
      if (contador.condicoes === LIMITE_DE_CONDICOES + 1) {
        problemas.push({
          caminho: aqui,
          mensagem: `No máximo ${LIMITE_DE_CONDICOES} condições.`,
        });
      }
      return;
    }
    if (ehObjeto(condicao) && 'grupo' in condicao) {
      const grupo = validarGrupo(
        condicao.grupo,
        `${aqui}.grupo`,
        profundidade + 1,
        problemas,
        contador,
      );
      if (grupo) {
        condicoes.push({ grupo });
      }
      return;
    }
    const simples = validarCondicao(condicao, aqui, problemas);
    if (simples) {
      condicoes.push(simples);
    }
  });
  return { combinacao: combinacao as CombinacaoDeSegmento, condicoes };
}

/** Definição dos operadores de um campo (fixo, `campos.*`, `utm.*`, `primeira_utm.*`). */
export function operadoresDoCampo(
  campo: string,
): DefinicaoDeCampo['operadores'] | null {
  if (CAMPOS_DE_SEGMENTO[campo]) {
    return CAMPOS_DE_SEGMENTO[campo].operadores;
  }
  if (campo.startsWith('campos.') && campo.length > 'campos.'.length) {
    return OPERADORES_DE_CAMPO_PERSONALIZADO;
  }
  const [prefixo, parte, ...resto] = campo.split('.');
  if (
    (prefixo === 'utm' || prefixo === 'primeira_utm') &&
    resto.length === 0 &&
    (PARTES_DA_UTM as readonly string[]).includes(parte)
  ) {
    return OPERADORES_DE_UTM;
  }
  return null;
}

function validarCondicao(
  entrada: unknown,
  caminho: string,
  problemas: ProblemaDeSegmento[],
): CondicaoSimples | null {
  if (
    !ehObjeto(entrada) ||
    typeof entrada.campo !== 'string' ||
    typeof entrada.operador !== 'string'
  ) {
    problemas.push({
      caminho,
      mensagem: 'Cada condição precisa de "campo" e "operador".',
    });
    return null;
  }
  const operadores = operadoresDoCampo(entrada.campo);
  if (!operadores) {
    problemas.push({
      caminho: `${caminho}.campo`,
      mensagem: `Campo desconhecido: "${entrada.campo}".`,
    });
    return null;
  }
  const operador = operadores[entrada.operador];
  if (!operador) {
    problemas.push({
      caminho: `${caminho}.operador`,
      mensagem: `Operador "${entrada.operador}" não vale para "${entrada.campo}".`,
    });
    return null;
  }
  const valor = validarValor(operador.valor, entrada.valor);
  if (valor.erro) {
    problemas.push({ caminho: `${caminho}.valor`, mensagem: valor.erro });
    return null;
  }
  return {
    campo: entrada.campo,
    operador: entrada.operador,
    ...(operador.valor === 'nenhum' ? {} : { valor: valor.valor }),
  };
}

function validarValor(
  tipo: TipoDeValor,
  valor: unknown,
): { valor?: unknown; erro?: string } {
  switch (tipo) {
    case 'nenhum':
      return {};
    case 'texto':
      return typeof valor === 'string' && valor.trim()
        ? { valor: valor.trim() }
        : { erro: 'Informe um texto.' };
    case 'textos':
      return Array.isArray(valor) &&
        valor.length > 0 &&
        valor.every((v) => typeof v === 'string' && v.trim())
        ? { valor: valor.map((v: string) => v.trim()) }
        : { erro: 'Informe ao menos um valor.' };
    case 'ids':
      return Array.isArray(valor) &&
        valor.length > 0 &&
        valor.every((v) => typeof v === 'string' && UUID.test(v))
        ? { valor }
        : { erro: 'Informe ao menos um id válido.' };
    case 'origens':
      return listaDoEnum(valor, Object.values(OrigemContato), 'origem');
    case 'areas':
      return listaDeSetores(valor);
    case 'data':
      return dataValida(valor)
        ? { valor }
        : { erro: 'Informe uma data (AAAA-MM-DD ou ISO 8601).' };
    case 'periodo':
      return Array.isArray(valor) &&
        valor.length === 2 &&
        valor.every(dataValida) &&
        new Date(valor[0] as string) <= new Date(valor[1] as string)
        ? { valor }
        : { erro: 'Informe o período como [início, fim].' };
    case 'dias':
      return Number.isInteger(valor) &&
        (valor as number) >= 0 &&
        (valor as number) <= 36_500
        ? { valor }
        : { erro: 'Informe um número inteiro de dias.' };
    case 'booleano':
      return typeof valor === 'boolean'
        ? { valor }
        : { erro: 'Informe verdadeiro ou falso.' };
    case 'escalar':
      return ['string', 'number', 'boolean'].includes(typeof valor)
        ? { valor }
        : { erro: 'Informe um texto, número ou verdadeiro/falso.' };
    case 'numero':
      return typeof valor === 'number' && Number.isFinite(valor)
        ? { valor }
        : { erro: 'Informe um número.' };
    case 'negocio':
      return validarFiltroDeNegocio(valor);
  }
}

function validarFiltroDeNegocio(valor: unknown): {
  valor?: unknown;
  erro?: string;
} {
  if (valor === undefined || valor === null) {
    return { valor: {} };
  }
  if (!ehObjeto(valor)) {
    return {
      erro: 'Informe o filtro do negócio (funil, etapas, status, área).',
    };
  }
  const filtro: FiltroDeNegocio = {};
  if (valor.funilId !== undefined) {
    if (typeof valor.funilId !== 'string' || !UUID.test(valor.funilId)) {
      return { erro: 'Funil inválido.' };
    }
    filtro.funilId = valor.funilId;
  }
  if (valor.etapaIds !== undefined) {
    if (
      !Array.isArray(valor.etapaIds) ||
      !valor.etapaIds.every((v) => typeof v === 'string' && UUID.test(v))
    ) {
      return { erro: 'Etapas inválidas.' };
    }
    filtro.etapaIds = valor.etapaIds as string[];
  }
  if (valor.status !== undefined) {
    const status = listaDoEnum(
      valor.status,
      Object.values(StatusNegocio),
      'status',
    );
    if (status.erro) {
      return status;
    }
    filtro.status = status.valor as StatusNegocio[];
  }
  if (valor.area !== undefined) {
    if (
      typeof valor.area !== 'string' ||
      !FORMATO_DA_CHAVE_DE_SETOR.test(valor.area)
    ) {
      return { erro: 'Setor inválido.' };
    }
    filtro.area = valor.area;
  }
  return { valor: filtro };
}

/** Chaves de setor (o formato; setor que não existe só não casa com ninguém). */
function listaDeSetores(valor: unknown): { valor?: unknown; erro?: string } {
  if (!Array.isArray(valor) || valor.length === 0) {
    return { erro: 'Informe ao menos um setor.' };
  }
  const invalido = valor.find(
    (v) => typeof v !== 'string' || !FORMATO_DA_CHAVE_DE_SETOR.test(v),
  );
  return invalido === undefined
    ? { valor }
    : { erro: `Valor inválido: "${String(invalido)}".` };
}

function listaDoEnum(
  valor: unknown,
  permitidos: readonly string[],
  nome: string,
): { valor?: unknown; erro?: string } {
  if (!Array.isArray(valor) || valor.length === 0) {
    return { erro: `Informe ao menos uma ${nome}.` };
  }
  const invalido = valor.find((v) => !permitidos.includes(v as string));
  return invalido === undefined
    ? { valor }
    : { erro: `Valor inválido: "${String(invalido)}".` };
}

function dataValida(valor: unknown): boolean {
  return (
    typeof valor === 'string' &&
    /^\d{4}-\d{2}-\d{2}/.test(valor) &&
    !Number.isNaN(new Date(valor).getTime())
  );
}

function ehObjeto(valor: unknown): valor is Record<string, unknown> {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor);
}

// ---------------------------------------------------------------------------
// Segmento → where do Prisma
// ---------------------------------------------------------------------------

export interface OpcoesDoSegmento {
  /**
   * Tirar os contatos com opt-out de marketing (R4.6). Padrão: `true` (disparos
   * e automações de marketing); automações de CS/Comercial passam `false`.
   */
  excluirOptOut?: boolean;
  /** Restringe as condições `negocio` a este negócio (condição de automação sobre um negócio). */
  negocioId?: string;
  /**
   * Restringe as condições `negocio` a estes funis (R5.9): quem não vê todos os
   * funis só enxerga negócios dos funis que vê (os do setor que a visibilidade
   * deixa e os de outros setores por acesso, R5.11).
   */
  funisDosNegocios?: readonly string[];
  /** Filtro extra (ex.: o escopo de visibilidade), combinado com E. */
  escopo?: Prisma.ContatoWhereInput;
  /** "Agora" das condições relativas (testes). */
  agora?: Date;
}

type OpcoesDoNegocio = Pick<OpcoesDoSegmento, 'negocioId' | 'funisDosNegocios'>;

/** Monta o `where` de contatos. Sempre exclui os contatos excluídos. Valide antes. */
export function whereDoSegmento(
  segmento: Segmento,
  opcoes: OpcoesDoSegmento = {},
): Prisma.ContatoWhereInput {
  const agora = opcoes.agora ?? new Date();
  const partes: Prisma.ContatoWhereInput[] = [{ excluidoEm: null }];
  if (opcoes.excluirOptOut ?? true) {
    partes.push({ optOutMarketing: false });
  }
  if (opcoes.escopo) {
    partes.push(opcoes.escopo);
  }
  const doSegmento = whereDoGrupo(segmento, agora, opcoes);
  if (doSegmento) {
    partes.push(doSegmento);
  }
  return { AND: partes };
}

function whereDoGrupo(
  grupo: Segmento,
  agora: Date,
  negocios: OpcoesDoNegocio,
): Prisma.ContatoWhereInput | null {
  const partes = grupo.condicoes
    .map((condicao) =>
      'grupo' in condicao
        ? whereDoGrupo(condicao.grupo, agora, negocios)
        : whereDaCondicao(condicao, agora, negocios),
    )
    .filter((parte): parte is Prisma.ContatoWhereInput => parte !== null);
  if (partes.length === 0) {
    // Grupo vazio: "todas" = sem restrição; "qualquer" = ninguém.
    return grupo.combinacao === 'qualquer' ? { id: { in: [] } } : null;
  }
  return grupo.combinacao === 'qualquer' ? { OR: partes } : { AND: partes };
}

function whereDaCondicao(
  { campo, operador, valor }: CondicaoSimples,
  agora: Date,
  negocios: OpcoesDoNegocio,
): Prisma.ContatoWhereInput {
  if (campo.startsWith('campos.')) {
    return whereDeCampoPersonalizado(
      campo.slice('campos.'.length),
      operador,
      valor,
    );
  }
  if (campo.startsWith('utm.') || campo.startsWith('primeira_utm.')) {
    const [prefixo, parte] = campo.split('.');
    return whereDeJson(
      prefixo === 'utm' ? 'ultimaOrigemUtm' : 'primeiraOrigemUtm',
      [parte],
      operador,
      valor,
    );
  }
  switch (campo) {
    case 'id':
      return operador === 'em'
        ? { id: { in: valor as string[] } }
        : { id: { notIn: valor as string[] } };
    case 'etiquetas': {
      const lista = valor as string[];
      if (operador === 'contem_todas') {
        return { etiquetas: { hasEvery: lista } };
      }
      return operador === 'contem_alguma'
        ? { etiquetas: { hasSome: lista } }
        : { NOT: { etiquetas: { hasSome: lista } } };
    }
    case 'origem':
    case 'primeira_origem': {
      const coluna = campo === 'origem' ? 'ultimaOrigem' : 'primeiraOrigem';
      const lista = valor as OrigemContato[];
      return operador === 'em'
        ? { [coluna]: { in: lista } }
        : { [coluna]: { notIn: lista } };
    }
    case 'responsavel':
    case 'empresa': {
      const coluna = campo === 'responsavel' ? 'responsavelId' : 'empresaId';
      if (operador === 'vazio') {
        return { [coluna]: null };
      }
      if (operador === 'preenchido') {
        return { [coluna]: { not: null } };
      }
      return operador === 'em'
        ? { [coluna]: { in: valor as string[] } }
        : {
            OR: [
              { [coluna]: null },
              { [coluna]: { notIn: valor as string[] } },
            ],
          };
    }
    case 'area_responsavel':
      // Só Líder e Membro têm setor.
      return { responsavel: { area: { in: valor as Area[] } } };
    case 'email':
    case 'telefone':
      return operador === 'vazio'
        ? { [campo]: null }
        : { [campo]: { not: null } };
    case 'negocio': {
      const filtro = whereDoNegocio(valor as FiltroDeNegocio, negocios);
      return operador === 'tem'
        ? { negocios: { some: filtro } }
        : { negocios: { none: filtro } };
    }
    case 'criado_em':
      return { criadoEm: filtroDeData(operador, valor, agora) };
    case 'ultima_origem_em':
      return { ultimaOrigemEm: filtroDeData(operador, valor, agora) };
    case 'ultima_interacao_em':
      return whereDeUltimaInteracao(operador, valor, agora);
    case 'opt_out':
      return { optOutMarketing: valor as boolean };
    default:
      throw new Error(`Campo de segmento sem tradução: ${campo}`);
  }
}

function whereDoNegocio(
  filtro: FiltroDeNegocio,
  negocios: OpcoesDoNegocio,
): Prisma.NegocioWhereInput {
  return {
    excluidoEm: null,
    ...(negocios.negocioId ? { id: negocios.negocioId } : {}),
    ...(filtro.funilId ? { funilId: filtro.funilId } : {}),
    ...(filtro.etapaIds ? { etapaId: { in: filtro.etapaIds } } : {}),
    ...(filtro.status ? { status: { in: filtro.status } } : {}),
    ...(filtro.area ? { funil: { area: filtro.area } } : {}),
    ...(negocios.funisDosNegocios
      ? {
          AND: [{ funilId: { in: [...negocios.funisDosNegocios] } }],
        }
      : {}),
  };
}

function inicioDoValor(valor: unknown): Date {
  return new Date(valor as string);
}

/** Fim inclusivo: uma data sem hora (`AAAA-MM-DD`) vale o dia inteiro (UTC). */
function fimDoValor(valor: unknown): Date {
  const texto = valor as string;
  const data = new Date(texto);
  return /^\d{4}-\d{2}-\d{2}$/.test(texto)
    ? new Date(data.getTime() + DIA_MS - 1)
    : data;
}

function filtroDeData(
  operador: string,
  valor: unknown,
  agora: Date,
): Prisma.DateTimeFilter {
  switch (operador) {
    case 'antes':
      return { lt: inicioDoValor(valor) };
    case 'depois':
      return { gt: fimDoValor(valor) };
    case 'entre': {
      const [inicio, fim] = valor as [string, string];
      return { gte: inicioDoValor(inicio), lte: fimDoValor(fim) };
    }
    case 'ultimos_dias':
      return { gte: new Date(agora.getTime() - (valor as number) * DIA_MS) };
    case 'mais_de_dias':
      return { lt: new Date(agora.getTime() - (valor as number) * DIA_MS) };
    default:
      throw new Error(`Operador de data sem tradução: ${operador}`);
  }
}

/**
 * Última interação = a mensagem mais recente nas conversas do contato
 * (`conversas.ultima_mensagem_em`). "Antes de X"/"há mais de N dias" incluem
 * quem nunca interagiu.
 */
function whereDeUltimaInteracao(
  operador: string,
  valor: unknown,
  agora: Date,
): Prisma.ContatoWhereInput {
  const desde = (limite: Date) => ({
    conversas: { some: { ultimaMensagemEm: { gte: limite } } },
  });
  const nenhumaDesde = (limite: Date) => ({
    conversas: { none: { ultimaMensagemEm: { gte: limite } } },
  });
  switch (operador) {
    case 'antes':
      return nenhumaDesde(inicioDoValor(valor));
    case 'depois':
      return {
        conversas: { some: { ultimaMensagemEm: { gt: fimDoValor(valor) } } },
      };
    case 'entre': {
      const [inicio, fim] = valor as [string, string];
      return {
        AND: [
          {
            conversas: {
              some: {
                ultimaMensagemEm: {
                  gte: inicioDoValor(inicio),
                  lte: fimDoValor(fim),
                },
              },
            },
          },
          {
            conversas: { none: { ultimaMensagemEm: { gt: fimDoValor(fim) } } },
          },
        ],
      };
    }
    case 'ultimos_dias':
      return desde(new Date(agora.getTime() - (valor as number) * DIA_MS));
    case 'mais_de_dias':
      return nenhumaDesde(
        new Date(agora.getTime() - (valor as number) * DIA_MS),
      );
    default:
      throw new Error(`Operador de data sem tradução: ${operador}`);
  }
}

function whereDeCampoPersonalizado(
  chave: string,
  operador: string,
  valor: unknown,
): Prisma.ContatoWhereInput {
  return whereDeJson('camposPersonalizados', [chave], operador, valor);
}

type ColunaJson =
  'camposPersonalizados' | 'ultimaOrigemUtm' | 'primeiraOrigemUtm';

function whereDeJson(
  coluna: ColunaJson,
  caminho: string[],
  operador: string,
  valor: unknown,
): Prisma.ContatoWhereInput {
  const filtro = (f: Omit<Prisma.JsonNullableFilter<'Contato'>, 'path'>) =>
    ({ [coluna]: { path: caminho, ...f } }) as Prisma.ContatoWhereInput;
  const vazio: Prisma.ContatoWhereInput = {
    OR: [
      { [coluna]: { equals: Prisma.AnyNull } },
      filtro({ equals: Prisma.AnyNull }),
      filtro({ equals: '' }),
    ],
  };
  switch (operador) {
    case 'igual':
      return filtro({ equals: valor as Prisma.InputJsonValue });
    case 'diferente':
      return { NOT: filtro({ equals: valor as Prisma.InputJsonValue }) };
    case 'contem':
      return filtro({ string_contains: valor as string });
    case 'maior':
      return filtro({ gt: valor as number });
    case 'menor':
      return filtro({ lt: valor as number });
    case 'vazio':
      return vazio;
    case 'preenchido':
      return { NOT: vazio };
    default:
      throw new Error(`Operador sem tradução: ${operador}`);
  }
}
