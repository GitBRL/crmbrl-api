/**
 * Validação dos widgets e dos filtros de um painel (R33.6): puras, sem banco. A
 * validação "de alcance" (funil que a pessoa não vê, pessoa de outro setor) é do
 * `FiltrosIndicadoresService`; aqui só o que o catálogo decide.
 */
import { randomUUID } from 'node:crypto';
import { DadosInvalidosException } from '../comum/erros/excecoes';
import { indicadorDoCatalogo } from './catalogo';
import {
  META_MAXIMA,
  MAXIMO_DE_WIDGETS,
  TAMANHO_TITULO_WIDGET,
} from './indicadores.constantes';
import {
  type FiltrosDoIndicador,
  PERIODOS,
  type MetaDoWidget,
  type Parametros,
  VISUALIZACOES,
  type Visualizacao,
  type Widget,
} from './indicadores.tipos';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function invalido(campo: string, mensagem: string): never {
  throw new DadosInvalidosException(mensagem, {
    campos: [{ campo, mensagens: [mensagem] }],
  });
}

function ehObjeto(valor: unknown): valor is Record<string, unknown> {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor);
}

/** Parâmetros do widget conferidos contra o catálogo; devolve só os que valem. */
export function validarParametros(
  chaveDoIndicador: string,
  visualizacao: Visualizacao,
  bruto: unknown,
  campo = 'parametros',
): Record<string, string> {
  const indicador = indicadorDoCatalogo(chaveDoIndicador);
  if (!indicador) {
    invalido(campo, `Indicador desconhecido: ${chaveDoIndicador}.`);
  }
  const recebidos = bruto === undefined || bruto === null ? {} : bruto;
  if (!ehObjeto(recebidos)) {
    return invalido(campo, 'Os parâmetros devem ser um objeto.');
  }
  const resultado: Record<string, string> = {};
  for (const [chave, valor] of Object.entries(recebidos)) {
    const definicao = indicador.parametros.find((p) => p.chave === chave);
    if (!definicao) {
      invalido(
        `${campo}.${chave}`,
        `Parâmetro desconhecido neste indicador: ${chave}.`,
      );
    }
    if (valor === undefined || valor === null || valor === '') {
      continue;
    }
    if (typeof valor !== 'string') {
      invalido(`${campo}.${chave}`, `O parâmetro ${chave} deve ser um texto.`);
    }
    if (definicao.vale && !definicao.vale.includes(visualizacao)) {
      continue;
    }
    if (definicao.opcoes) {
      if (!definicao.opcoes.some((o) => o.valor === valor)) {
        invalido(
          `${campo}.${chave}`,
          `Valor inválido para ${definicao.rotulo}: use ${definicao.opcoes.map((o) => o.valor).join(', ')}.`,
        );
      }
    } else if (
      (definicao.tipo === 'ETAPA' || definicao.tipo === 'FUNIL') &&
      !UUID.test(valor)
    ) {
      invalido(`${campo}.${chave}`, `${definicao.rotulo} inválido(a).`);
    }
    resultado[chave] = valor;
  }
  for (const definicao of indicador.parametros) {
    if (
      definicao.obrigatorioEm?.includes(visualizacao) &&
      !resultado[definicao.chave]
    ) {
      invalido(`${campo}.${definicao.chave}`, `Escolha: ${definicao.rotulo}.`);
    }
  }
  return resultado;
}

export function validarMeta(
  bruta: unknown,
  visualizacao: Visualizacao,
  campo = 'meta',
): MetaDoWidget | undefined {
  if (bruta === undefined || bruta === null) {
    return undefined;
  }
  if (!ehObjeto(bruta)) {
    return invalido(campo, 'A meta deve ser um objeto.');
  }
  if (visualizacao !== 'NUMERO' && visualizacao !== 'RANKING') {
    return invalido(campo, 'Só os indicadores em número ou ranking têm meta.');
  }
  const meta: MetaDoWidget = {};
  for (const chave of ['geral', 'porPessoa'] as const) {
    const valor = bruta[chave];
    if (valor === undefined || valor === null) {
      continue;
    }
    if (
      typeof valor !== 'number' ||
      !Number.isFinite(valor) ||
      valor < 0 ||
      valor > META_MAXIMA
    ) {
      invalido(
        `${campo}.${chave}`,
        'A meta deve ser um número maior ou igual a zero.',
      );
    }
    meta[chave] = valor;
  }
  if (visualizacao === 'NUMERO' && meta.porPessoa !== undefined) {
    delete meta.porPessoa;
  }
  return meta.geral === undefined && meta.porPessoa === undefined
    ? undefined
    : meta;
}

const ORIGENS = [
  'MANUAL',
  'WEBHOOK',
  'WHATSAPP',
  'SITE',
  'INDICACAO',
  'IMPORTACAO',
  'PASSAGEM',
  'OUTRO',
  'EMAIL',
  'INSTAGRAM',
  'MESSENGER',
];

function listaDeUuids(valor: unknown, campo: string): string[] | undefined {
  if (valor === undefined || valor === null) {
    return undefined;
  }
  if (
    !Array.isArray(valor) ||
    valor.length > 50 ||
    valor.some((v) => typeof v !== 'string' || !UUID.test(v))
  ) {
    return invalido(
      campo,
      'Informe uma lista de até 50 identificadores válidos.',
    );
  }
  return valor as string[];
}

function listaDeTextos(
  valor: unknown,
  campo: string,
  permitidos?: readonly string[],
): string[] | undefined {
  if (valor === undefined || valor === null) {
    return undefined;
  }
  if (
    !Array.isArray(valor) ||
    valor.length > 50 ||
    valor.some(
      (v) =>
        typeof v !== 'string' ||
        v.length === 0 ||
        v.length > 100 ||
        (permitidos && !permitidos.includes(v)),
    )
  ) {
    return invalido(
      campo,
      permitidos
        ? `Use valores de: ${permitidos.join(', ')}.`
        : 'Informe uma lista de até 50 textos.',
    );
  }
  return valor as string[];
}

/** Filtros de painel ou de widget (R33.3): estrutura e tipos; o alcance é do serviço de filtros. */
export function validarFiltros(
  bruto: unknown,
  campo = 'filtros',
): FiltrosDoIndicador {
  if (bruto === undefined || bruto === null) {
    return {};
  }
  if (!ehObjeto(bruto)) {
    return invalido(campo, 'Os filtros devem ser um objeto.');
  }
  const conhecidos = [
    'periodo',
    'comparar',
    'funilIds',
    'etapaIds',
    'setor',
    'equipeId',
    'pessoaIds',
    'origens',
    'utmSource',
    'utmCampaign',
    'etiquetas',
  ];
  for (const chave of Object.keys(bruto)) {
    if (!conhecidos.includes(chave)) {
      invalido(`${campo}.${chave}`, `Filtro desconhecido: ${chave}.`);
    }
  }
  const filtros: FiltrosDoIndicador = {};
  const periodo = bruto['periodo'];
  if (periodo !== undefined && periodo !== null) {
    if (
      !ehObjeto(periodo) ||
      typeof periodo['tipo'] !== 'string' ||
      !(PERIODOS as readonly string[]).includes(periodo['tipo'])
    ) {
      invalido(
        `${campo}.periodo`,
        `O período deve ser um de: ${PERIODOS.join(', ')}.`,
      );
    }
    const tipo = (periodo as { tipo: (typeof PERIODOS)[number] }).tipo;
    const dataValida = (v: unknown) =>
      typeof v === 'string' && !Number.isNaN(Date.parse(v));
    if (tipo === 'PERSONALIZADO') {
      if (!dataValida(periodo['de']) || !dataValida(periodo['ate'])) {
        invalido(
          `${campo}.periodo`,
          'Informe "de" e "ate" como datas válidas.',
        );
      }
      filtros.periodo = {
        tipo,
        de: periodo['de'] as string,
        ate: periodo['ate'] as string,
      };
    } else {
      filtros.periodo = { tipo };
    }
  }
  if (bruto['comparar'] !== undefined && bruto['comparar'] !== null) {
    if (typeof bruto['comparar'] !== 'boolean') {
      invalido(`${campo}.comparar`, 'Deve ser verdadeiro ou falso.');
    }
    filtros.comparar = bruto['comparar'] as boolean;
  }
  const funilIds = listaDeUuids(bruto['funilIds'], `${campo}.funilIds`);
  if (funilIds) {
    filtros.funilIds = funilIds;
  }
  const etapaIds = listaDeUuids(bruto['etapaIds'], `${campo}.etapaIds`);
  if (etapaIds) {
    filtros.etapaIds = etapaIds;
  }
  const pessoaIds = listaDeUuids(bruto['pessoaIds'], `${campo}.pessoaIds`);
  if (pessoaIds) {
    filtros.pessoaIds = pessoaIds;
  }
  for (const chave of ['equipeId'] as const) {
    const valor = bruto[chave];
    if (valor !== undefined && valor !== null) {
      if (typeof valor !== 'string' || !UUID.test(valor)) {
        invalido(`${campo}.${chave}`, 'Identificador inválido.');
      }
      filtros[chave] = valor;
    }
  }
  const setor = bruto['setor'];
  if (setor !== undefined && setor !== null) {
    if (typeof setor !== 'string' || setor.length === 0 || setor.length > 40) {
      invalido(`${campo}.setor`, 'Setor inválido.');
    }
    filtros.setor = setor;
  }
  const origens = listaDeTextos(bruto['origens'], `${campo}.origens`, ORIGENS);
  if (origens) {
    filtros.origens = origens;
  }
  for (const chave of ['utmSource', 'utmCampaign', 'etiquetas'] as const) {
    const valor = listaDeTextos(bruto[chave], `${campo}.${chave}`);
    if (valor) {
      filtros[chave] = valor;
    }
  }
  return filtros;
}

/** Valida e normaliza a lista de widgets (ids, ordem, largura). */
export function validarWidgets(bruto: unknown): Widget[] {
  if (!Array.isArray(bruto)) {
    return invalido('widgets', 'Os indicadores devem ser uma lista.');
  }
  if (bruto.length > MAXIMO_DE_WIDGETS) {
    invalido(
      'widgets',
      `Um painel aceita no máximo ${MAXIMO_DE_WIDGETS} indicadores.`,
    );
  }
  const ids = new Set<string>();
  const widgets = bruto.map((item, indice): Widget => {
    const campo = `widgets.${indice}`;
    if (!ehObjeto(item)) {
      return invalido(campo, 'Indicador inválido.');
    }
    const chave = item['indicador'];
    if (typeof chave !== 'string' || !indicadorDoCatalogo(chave)) {
      return invalido(`${campo}.indicador`, 'Indicador desconhecido.');
    }
    const indicador = indicadorDoCatalogo(chave)!;
    const visualizacao = item['visualizacao'];
    if (
      typeof visualizacao !== 'string' ||
      !(VISUALIZACOES as readonly string[]).includes(visualizacao) ||
      !indicador.visualizacoes.includes(visualizacao as Visualizacao)
    ) {
      return invalido(
        `${campo}.visualizacao`,
        `Este indicador aceita: ${indicador.visualizacoes.join(', ')}.`,
      );
    }
    const viz = visualizacao as Visualizacao;
    let id = item['id'];
    if (id === undefined || id === null || id === '') {
      id = randomUUID();
    }
    if (typeof id !== 'string' || id.length > 64 || ids.has(id)) {
      return invalido(
        `${campo}.id`,
        'Identificador do indicador inválido ou repetido.',
      );
    }
    ids.add(id);
    const titulo = item['titulo'];
    if (titulo !== undefined && titulo !== null && typeof titulo !== 'string') {
      return invalido(`${campo}.titulo`, 'O título deve ser um texto.');
    }
    const tituloLimpo = typeof titulo === 'string' ? titulo.trim() : '';
    if (tituloLimpo.length > TAMANHO_TITULO_WIDGET) {
      invalido(
        `${campo}.titulo`,
        `O título pode ter no máximo ${TAMANHO_TITULO_WIDGET} caracteres.`,
      );
    }
    const largura = item['largura'] ?? 1;
    if (largura !== 1 && largura !== 2 && largura !== 3) {
      return invalido(`${campo}.largura`, 'A largura vai de 1 a 3.');
    }
    const ordem = item['ordem'];
    if (
      ordem !== undefined &&
      ordem !== null &&
      (typeof ordem !== 'number' || !Number.isInteger(ordem))
    ) {
      return invalido(`${campo}.ordem`, 'A ordem deve ser um número inteiro.');
    }
    const widget: Widget = {
      id,
      indicador: chave,
      parametros: validarParametros(
        chave,
        viz,
        item['parametros'],
        `${campo}.parametros`,
      ),
      visualizacao: viz,
      largura,
      ordem: typeof ordem === 'number' ? ordem : indice,
    };
    if (tituloLimpo) {
      widget.titulo = tituloLimpo;
    }
    const meta = validarMeta(item['meta'], viz, `${campo}.meta`);
    if (meta) {
      widget.meta = meta;
    }
    if (item['filtros'] !== undefined && item['filtros'] !== null) {
      if (!ehObjeto(item['filtros'])) {
        invalido(`${campo}.filtros`, 'Os filtros devem ser um objeto.');
      }
      widget.filtros = validarFiltros(item['filtros'], `${campo}.filtros`);
    }
    return widget;
  });
  return widgets
    .sort((a, b) => a.ordem - b.ordem)
    .map((w, i) => ({ ...w, ordem: i }));
}

export type { Parametros };
