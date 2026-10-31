/**
 * Entrada da análise (R21): só os números agregados que o próprio BI devolve
 * para o painel e os filtros — nada de dados pessoais de contatos. Tabelas com
 * uma linha por contato ou negócio viram contagens; colunas de id só ficam
 * quando servem de filtro de uma lista (etapa, canal, fila, campanha,
 * responsável), e cada id vira "conhecido" para conferir os links das ações.
 */
import type {
  CelulaBi,
  PainelBi,
  PainelCalculado,
  TabelaBi,
} from '../bi.tipos';
import { MAX_LINHAS_POR_TABELA } from './analise.constantes';

/** O que cada id conhecido identifica (para conferir o parâmetro do link). */
export type ClasseDeId =
  'etapa' | 'funil' | 'canal' | 'fila' | 'usuario' | 'campanha';

/** Coluna de id `tabela.coluna` → classe. Colunas de id fora daqui são retiradas. */
const IDS_DAS_TABELAS: Readonly<Record<string, ClasseDeId>> = {
  'funil.etapaId': 'etapa',
  'onboardingPorEtapa.etapaId': 'etapa',
  'ranking.usuarioId': 'usuario',
  'carteiraPorResponsavel.usuarioId': 'usuario',
  'porAtendente.id': 'usuario',
  'porCanal.id': 'canal',
  'porFila.id': 'fila',
  'campanhas.id': 'campanha',
};

/** Colunas que nunca saem (dados de contato, título de negócio, texto livre por cliente). */
const COLUNAS_PESSOAIS = new Set([
  'contato',
  'contatoId',
  'negocioId',
  'titulo',
  'email',
  'telefone',
  'empresa',
  'empresaId',
  'motivos',
]);

export interface IndicadorEntrada {
  chave: string;
  rotulo: string;
  unidade: string;
  valor: number | null;
  anterior: number | null;
  variacao: number | null;
  melhorQuando: 'maior' | 'menor' | null;
  explicacao: string;
}

export interface TabelaEntrada {
  chave: string;
  titulo: string;
  explicacao: string;
  /** `chave:tipo` de cada coluna, na ordem das células de `linhas`. */
  colunas: string[];
  linhas: CelulaBi[][];
  /** Linhas que ficaram de fora pelo limite. */
  omitidas?: number;
}

export interface EntradaAnalise {
  painel: PainelBi;
  periodo: { de: string; ate: string };
  periodoAnterior: { de: string; ate: string } | null;
  filtros: Record<string, string | boolean | null>;
  indicadores: IndicadorEntrada[];
  tabelas: TabelaEntrada[];
  contexto: Record<string, unknown>;
}

export interface EntradaMontada {
  entrada: EntradaAnalise;
  /** id → classe, de tudo que pode aparecer num link. */
  idsConhecidos: Map<string, ClasseDeId>;
}

function numero(valor: CelulaBi | undefined): number {
  return typeof valor === 'number' ? valor : 0;
}

/** Uma linha por contato (risco de churn): só a contagem por nível e a pontuação média. */
function agregarRisco(tabela: TabelaBi): TabelaEntrada {
  const grupos = new Map<string, { clientes: number; pontos: number }>();
  for (const linha of tabela.linhas) {
    const nivel = String(linha.nivel ?? 'sem nível');
    const grupo = grupos.get(nivel) ?? { clientes: 0, pontos: 0 };
    grupo.clientes += 1;
    grupo.pontos += numero(linha.pontuacao);
    grupos.set(nivel, grupo);
  }
  return {
    chave: 'riscoDeChurnPorNivel',
    titulo: 'Clientes em risco de churn, por nível',
    explicacao:
      'Contagem de clientes com risco médio ou alto (só agregados; a lista nominal fica na tela do BI).',
    colunas: ['nivel:texto', 'clientes:numero', 'pontuacaoMedia:numero'],
    linhas: [...grupos].map(([nivel, g]) => [
      nivel,
      g.clientes,
      Math.round(g.pontos / g.clientes),
    ]),
  };
}

/** Uma linha por negócio (próximas renovações): contagem e valor por etapa e por responsável. */
function agregarRenovacoes(tabela: TabelaBi): TabelaEntrada {
  const grupos = new Map<string, { quantidade: number; valor: number }>();
  for (const linha of tabela.linhas) {
    const chave = `${String(linha.etapa ?? '—')}\u0000${String(linha.responsavel ?? 'sem responsável')}`;
    const grupo = grupos.get(chave) ?? { quantidade: 0, valor: 0 };
    grupo.quantidade += 1;
    grupo.valor += numero(linha.valorRecorrente);
    grupos.set(chave, grupo);
  }
  return {
    chave: 'proximasRenovacoesPorEtapa',
    titulo: 'Próximas renovações, por etapa e responsável',
    explicacao: tabela.dica,
    colunas: [
      'etapa:texto',
      'responsavel:texto',
      'quantidade:numero',
      'valorRecorrente:moeda',
    ],
    linhas: [...grupos].map(([chave, g]) => {
      const [etapa, responsavel] = chave.split('\u0000');
      return [
        etapa,
        responsavel,
        g.quantidade,
        Math.round(g.valor * 100) / 100,
      ];
    }),
  };
}

/** Tabelas nominais com um agregado próprio. As demais nominais são retiradas. */
const AGREGADOS: Readonly<Record<string, (tabela: TabelaBi) => TabelaEntrada>> =
  {
    riscoDeChurn: agregarRisco,
    proximasRenovacoes: agregarRenovacoes,
  };

function tabelaAgregada(
  tabela: TabelaBi,
  ids: Map<string, ClasseDeId>,
): TabelaEntrada | null {
  const agregar = AGREGADOS[tabela.chave];
  if (agregar) {
    return agregar(tabela);
  }
  if (tabela.colunas.some((c) => COLUNAS_PESSOAIS.has(c.chave))) {
    return null;
  }
  const colunas = tabela.colunas.filter(
    (c) =>
      c.tipo !== 'id' ||
      IDS_DAS_TABELAS[`${tabela.chave}.${c.chave}`] !== undefined,
  );
  for (const coluna of colunas) {
    const classe = IDS_DAS_TABELAS[`${tabela.chave}.${coluna.chave}`];
    if (coluna.tipo === 'id' && classe) {
      for (const linha of tabela.linhas) {
        const valor = linha[coluna.chave];
        if (typeof valor === 'string') {
          ids.set(valor, classe);
        }
      }
    }
  }
  const linhas = tabela.linhas
    .slice(0, MAX_LINHAS_POR_TABELA)
    .map((linha) => colunas.map((c) => linha[c.chave] ?? null));
  const omitidas = tabela.linhas.length - linhas.length;
  return {
    chave: tabela.chave,
    titulo: tabela.titulo,
    explicacao: tabela.dica,
    colunas: colunas.map((c) => `${c.chave}:${c.tipo}`),
    linhas,
    ...(omitidas > 0 ? { omitidas } : {}),
  };
}

/** Só o que o modelo precisa do `meta` (funil usado, etapas de onboarding, data de referência). */
function contextoDoMeta(
  meta: Record<string, unknown>,
  ids: Map<string, ClasseDeId>,
): Record<string, unknown> {
  const contexto: Record<string, unknown> = {};
  const funil = meta.funil as { id?: unknown; nome?: unknown } | undefined;
  if (funil && typeof funil.id === 'string') {
    ids.set(funil.id, 'funil');
    contexto.funil = { id: funil.id, nome: funil.nome ?? null };
  }
  if (Array.isArray(meta.etapasDeOnboarding)) {
    contexto.etapasDeOnboarding = meta.etapasDeOnboarding;
  }
  if (typeof meta.referencia === 'string') {
    contexto.referencia = meta.referencia;
  }
  return contexto;
}

/** Monta a entrada a partir do painel calculado pelo BI (mesmos filtros, mesma visibilidade). */
export function montarEntrada(painel: PainelCalculado): EntradaMontada {
  const ids = new Map<string, ClasseDeId>();
  const f = painel.filtros;
  const filtros: Record<string, string | boolean | null> = {
    area: f.area,
    equipeId: f.equipeId,
    pessoaId: f.pessoaId,
    funilId: f.funilId,
    canalId: f.canalId,
    filaId: f.filaId,
    comparar: f.comparar,
  };
  const classesDosFiltros: [string | null, ClasseDeId][] = [
    [f.equipeId, 'usuario'],
    [f.pessoaId, 'usuario'],
    [f.funilId, 'funil'],
    [f.canalId, 'canal'],
    [f.filaId, 'fila'],
  ];
  for (const [id, classe] of classesDosFiltros) {
    if (id) {
      ids.set(id, classe);
    }
  }
  const tabelas: TabelaEntrada[] = [];
  for (const tabela of Object.values(painel.tabelas)) {
    const agregada = tabelaAgregada(tabela, ids);
    if (agregada) {
      tabelas.push(agregada);
    }
  }
  return {
    entrada: {
      painel: painel.painel,
      periodo: painel.periodo,
      periodoAnterior: painel.anterior,
      filtros,
      indicadores: painel.cartoes.map((c) => ({
        chave: c.chave,
        rotulo: c.rotulo,
        unidade: c.unidade,
        valor: c.valor,
        anterior: c.anterior,
        variacao: c.variacao,
        melhorQuando: c.melhorQuando,
        explicacao: c.dica,
      })),
      tabelas,
      contexto: contextoDoMeta(painel.meta, ids),
    },
    idsConhecidos: ids,
  };
}

/** Os ids conhecidos de uma entrada já gravada (para as perguntas de acompanhamento). */
export function idsDaEntrada(entrada: EntradaAnalise): Map<string, ClasseDeId> {
  const ids = new Map<string, ClasseDeId>();
  const f = entrada.filtros;
  const pares: [unknown, ClasseDeId][] = [
    [f.equipeId, 'usuario'],
    [f.pessoaId, 'usuario'],
    [f.funilId, 'funil'],
    [f.canalId, 'canal'],
    [f.filaId, 'fila'],
  ];
  for (const [id, classe] of pares) {
    if (typeof id === 'string') {
      ids.set(id, classe);
    }
  }
  const funil = entrada.contexto.funil as { id?: unknown } | undefined;
  if (funil && typeof funil.id === 'string') {
    ids.set(funil.id, 'funil');
  }
  for (const tabela of entrada.tabelas) {
    tabela.colunas.forEach((coluna, indice) => {
      const [chave, tipo] = coluna.split(':');
      const classe = IDS_DAS_TABELAS[`${tabela.chave}.${chave}`];
      if (tipo === 'id' && classe) {
        for (const linha of tabela.linhas) {
          const valor = linha[indice];
          if (typeof valor === 'string') {
            ids.set(valor, classe);
          }
        }
      }
    });
  }
  return ids;
}
