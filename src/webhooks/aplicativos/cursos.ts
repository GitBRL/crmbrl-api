/**
 * Peças comuns das plataformas de curso (Hotmart, Kiwify e Eduzz, R32.20): a
 * tabela de eventos (cada evento → ignorar, abrir negócio na etapa X, ganho,
 * perdido com motivo ou só etiqueta), o filtro por produto, os modelos prontos
 * e a leitura/validação de `configuracao.eventos` e `configuracao.produtos`.
 * Funções puras.
 */
import { normalizarEtiquetas } from '../../comum/dominio/etiquetas';
import type {
  AcaoDoEvento,
  DefinicaoDeEvento,
  EventosDoAplicativo,
  GrupoDeEvento,
  ModeloDeEventos,
  ProdutoDoItem,
  RegraDoEvento,
} from './tipos';
import { ehObjeto, textoOuNulo } from './comum';
import { lerCaminho } from '../entrada/mapeamento';

export const ACOES_DO_EVENTO: readonly AcaoDoEvento[] = [
  'IGNORAR',
  'ABRIR',
  'GANHO',
  'PERDIDO',
  'ETIQUETAR',
];

export const ROTULO_DA_ACAO: Readonly<Record<AcaoDoEvento, string>> = {
  IGNORAR: 'Ignorar',
  ABRIR: 'Criar ou atualizar negócio aberto',
  GANHO: 'Marcar como ganho',
  PERDIDO: 'Marcar como perdido',
  ETIQUETAR: 'Só etiquetar o contato',
};

export const LIMITE_DE_EVENTOS = 60;
export const LIMITE_DE_PRODUTOS = 50;
const FORMATO_DO_CODIGO = /^[A-Za-z0-9_.:-]{1,100}$/;
const FORMATO_DE_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TAMANHO_MAXIMO_DO_MOTIVO = 200;

// ---------------------------------------------------------------------------
// Definições
// ---------------------------------------------------------------------------

export function regra(
  acao: AcaoDoEvento,
  etiquetas: readonly string[] = [],
  motivoPerda: string | null = null,
): RegraDoEvento {
  return {
    acao,
    etapaId: null,
    motivoPerda: acao === 'PERDIDO' ? motivoPerda : null,
    etiquetas,
  };
}

export function evento(
  codigo: string,
  nome: string,
  grupo: GrupoDeEvento,
  descricao: string,
  padrao: RegraDoEvento,
): DefinicaoDeEvento {
  return { codigo, nome, descricao, grupo, padrao };
}

/** O modelo `VENDAS` é o padrão de cada evento; `SO_COMPRAS` e `RECUPERACAO` são variações prontas. */
export function modelosDeEventos(
  eventos: readonly DefinicaoDeEvento[],
  opcoes: {
    /** Os eventos de recuperação (carrinho, boleto/Pix gerado, compra recusada) do `RECUPERACAO`. */
    readonly recuperacao: readonly string[];
    /** O evento de compra aprovada (ganho). */
    readonly compraAprovada: string;
  },
): ModeloDeEventos[] {
  const vendas: Record<string, RegraDoEvento> = Object.fromEntries(
    eventos.map(({ codigo, padrao }) => [codigo, padrao]),
  );
  const soCompras: Record<string, RegraDoEvento> = Object.fromEntries(
    eventos.map(({ codigo, padrao }) => [
      codigo,
      codigo === opcoes.compraAprovada ? padrao : regra('IGNORAR'),
    ]),
  );
  const recuperacao: Record<string, RegraDoEvento> = Object.fromEntries(
    eventos.map(({ codigo, padrao }) => [
      codigo,
      codigo === opcoes.compraAprovada || opcoes.recuperacao.includes(codigo)
        ? padrao
        : regra('IGNORAR'),
    ]),
  );
  return [
    {
      codigo: 'VENDAS',
      nome: 'Vendas completas',
      descricao:
        'Compra aprovada vira ganho com valor e produto; carrinho abandonado e boleto ou Pix gerado abrem um negócio na etapa inicial; reembolso e chargeback etiquetam o contato e marcam o negócio como perdido com motivo; eventos de assinatura só etiquetam.',
      regras: vendas,
    },
    {
      codigo: 'SO_COMPRAS',
      nome: 'Só compras aprovadas',
      descricao:
        'Só a compra aprovada age (ganho com valor e produto); todos os outros eventos são ignorados.',
      regras: soCompras,
    },
    {
      codigo: 'RECUPERACAO',
      nome: 'Recuperação de vendas',
      descricao:
        'Compra aprovada vira ganho; carrinho abandonado, boleto ou Pix gerado e compra recusada abrem negócio na etapa inicial para o time recuperar; o resto é ignorado.',
      regras: recuperacao,
    },
  ];
}

export function eventosDoAplicativo(
  eventos: readonly DefinicaoDeEvento[],
  compraAprovada: string,
  recuperacao: readonly string[],
): EventosDoAplicativo {
  return {
    eventos,
    modelos: modelosDeEventos(eventos, { compraAprovada, recuperacao }),
    filtroPorProduto: true,
  };
}

// ---------------------------------------------------------------------------
// Configuração (`configuracao.eventos` e `configuracao.produtos`)
// ---------------------------------------------------------------------------

/** A regra gravada, lida com tolerância (o que vier malformado é descartado). */
export function lerRegra(valor: unknown): RegraDoEvento | null {
  if (!ehObjeto(valor)) {
    return null;
  }
  const acao = valor.acao;
  if (
    typeof acao !== 'string' ||
    !(ACOES_DO_EVENTO as readonly string[]).includes(acao)
  ) {
    return null;
  }
  return {
    acao: acao as AcaoDoEvento,
    etapaId: textoOuNulo(valor.etapaId),
    motivoPerda: textoOuNulo(valor.motivoPerda),
    etiquetas: normalizarEtiquetas(
      Array.isArray(valor.etiquetas) ? valor.etiquetas : [],
    ),
  };
}

/** A tabela efetiva: o que o Admin gravou vale; o que faltar usa o padrão do evento. */
export function regraDoEvento(
  definicoes: readonly DefinicaoDeEvento[],
  configuracao: Readonly<Record<string, unknown>>,
  codigo: string,
): { regra: RegraDoEvento; definicao: DefinicaoDeEvento | null } | null {
  const definicao = definicoes.find((d) => d.codigo === codigo) ?? null;
  const gravada = ehObjeto(configuracao.eventos)
    ? lerRegra(configuracao.eventos[codigo])
    : null;
  const efetiva = gravada ?? definicao?.padrao ?? null;
  return efetiva ? { regra: efetiva, definicao } : null;
}

/** Os produtos do filtro (ids ou nomes), ou lista vazia (todos). */
export function produtosDoFiltro(
  configuracao: Readonly<Record<string, unknown>>,
): string[] {
  const valor = configuracao.produtos;
  return Array.isArray(valor)
    ? valor.flatMap((p) => {
        const texto = textoOuNulo(p);
        return texto ? [texto] : [];
      })
    : [];
}

function igual(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** O item passa no filtro? Sem filtro, sempre; com filtro, algum produto do item (id ou nome) precisa constar. */
export function produtoPassaNoFiltro(
  filtro: readonly string[],
  produtos: readonly ProdutoDoItem[],
): boolean {
  if (filtro.length === 0) {
    return true;
  }
  return produtos.some((produto) =>
    filtro.some(
      (permitido) =>
        (produto.id !== null && igual(permitido, produto.id)) ||
        (produto.nome !== null && igual(permitido, produto.nome)),
    ),
  );
}

export function descreverProdutos(produtos: readonly ProdutoDoItem[]): string {
  const nomes = produtos.flatMap((p) => {
    const nome = p.nome ?? p.id;
    return nome ? [nome] : [];
  });
  return nomes.length > 0 ? nomes.join(', ') : 'sem produto informado';
}

export type ResultadoDaValidacaoDeConfiguracao =
  { readonly valor: unknown } | { readonly problema: string };

/** `configuracao.eventos`: `{ <codigo>: { acao, etapaId?, motivoPerda?, etiquetas? } }`. */
export function validarTabelaDeEventos(
  valor: unknown,
): ResultadoDaValidacaoDeConfiguracao {
  if (!ehObjeto(valor)) {
    return {
      problema:
        'deve ser um objeto { <código do evento>: { acao, etapaId?, motivoPerda?, etiquetas? } }',
    };
  }
  const entradas = Object.entries(valor);
  if (entradas.length > LIMITE_DE_EVENTOS) {
    return { problema: `aceita no máximo ${LIMITE_DE_EVENTOS} eventos` };
  }
  const tabela: Record<string, RegraDoEvento> = {};
  for (const [codigo, bruta] of entradas) {
    if (!FORMATO_DO_CODIGO.test(codigo)) {
      return {
        problema: `o código "${codigo.slice(0, 40)}" é inválido (letras, números e . _ : -, até 100)`,
      };
    }
    if (!ehObjeto(bruta)) {
      return { problema: `${codigo}: deve ser um objeto` };
    }
    const acao = bruta.acao;
    if (
      typeof acao !== 'string' ||
      !(ACOES_DO_EVENTO as readonly string[]).includes(acao)
    ) {
      return {
        problema: `${codigo}: acao deve ser ${ACOES_DO_EVENTO.join(', ')}`,
      };
    }
    const etapaId = bruta.etapaId ?? null;
    if (etapaId !== null) {
      if (acao !== 'ABRIR') {
        return { problema: `${codigo}: etapaId só vale na ação ABRIR` };
      }
      if (typeof etapaId !== 'string' || !FORMATO_DE_UUID.test(etapaId)) {
        return { problema: `${codigo}: etapaId deve ser o id de uma etapa` };
      }
    }
    const motivo = bruta.motivoPerda ?? null;
    if (motivo !== null) {
      if (acao !== 'PERDIDO') {
        return { problema: `${codigo}: motivoPerda só vale na ação PERDIDO` };
      }
      if (
        typeof motivo !== 'string' ||
        motivo.trim().length === 0 ||
        motivo.trim().length > TAMANHO_MAXIMO_DO_MOTIVO
      ) {
        return {
          problema: `${codigo}: motivoPerda deve ter de 1 a ${TAMANHO_MAXIMO_DO_MOTIVO} caracteres`,
        };
      }
    }
    const etiquetas = bruta.etiquetas ?? [];
    if (
      !Array.isArray(etiquetas) ||
      etiquetas.some((e) => typeof e !== 'string')
    ) {
      return { problema: `${codigo}: etiquetas deve ser uma lista de textos` };
    }
    if (acao === 'IGNORAR' && etiquetas.length > 0) {
      return { problema: `${codigo}: ignorar não leva etiquetas` };
    }
    tabela[codigo] = {
      acao: acao as AcaoDoEvento,
      etapaId: typeof etapaId === 'string' ? etapaId.toLowerCase() : null,
      motivoPerda: typeof motivo === 'string' ? motivo.trim() : null,
      etiquetas: normalizarEtiquetas(etiquetas),
    };
  }
  return { valor: tabela };
}

/** `configuracao.produtos`: lista de ids ou nomes de produto (vazia = todos). */
export function validarProdutos(
  valor: unknown,
): ResultadoDaValidacaoDeConfiguracao {
  if (!Array.isArray(valor)) {
    return { problema: 'deve ser uma lista de ids ou nomes de produto' };
  }
  if (valor.length > LIMITE_DE_PRODUTOS) {
    return { problema: `aceita no máximo ${LIMITE_DE_PRODUTOS} produtos` };
  }
  const produtos: string[] = [];
  for (const item of valor) {
    const texto = typeof item === 'number' ? String(item) : item;
    if (typeof texto !== 'string' || texto.trim().length === 0) {
      return { problema: 'cada produto deve ser um texto não vazio' };
    }
    if (texto.trim().length > 200) {
      return { problema: 'cada produto deve ter no máximo 200 caracteres' };
    }
    if (!produtos.some((p) => igual(p, texto))) {
      produtos.push(texto.trim());
    }
  }
  return { valor: produtos };
}

/** O tabela de eventos com os padrões do aplicativo, para gravar na criação. */
export function tabelaPadrao(
  definicoes: readonly DefinicaoDeEvento[],
): Record<string, RegraDoEvento> {
  return Object.fromEntries(
    definicoes.map(({ codigo, padrao }) => [codigo, padrao]),
  );
}

// ---------------------------------------------------------------------------
// Leitura do corpo
// ---------------------------------------------------------------------------

/** O primeiro texto (ou número) que existir num dos caminhos. */
export function primeiroTexto(
  corpo: unknown,
  ...caminhos: readonly string[]
): string | null {
  for (const caminho of caminhos) {
    const texto = textoOuNulo(lerCaminho(corpo, caminho));
    if (texto) {
      return texto;
    }
  }
  return null;
}

export function produtoDe(
  id: string | null,
  nome: string | null,
): ProdutoDoItem[] {
  return id || nome ? [{ id, nome }] : [];
}

/** Aceita número ou texto (`"497,00"`, `497`) e devolve o número, ou `null`. */
export function numeroDe(valor: unknown): number | null {
  if (typeof valor === 'number' && Number.isFinite(valor)) {
    return valor;
  }
  if (typeof valor === 'string') {
    const limpo = valor.trim();
    if (/^\d+(\.\d+)?$/.test(limpo)) {
      return Number(limpo);
    }
  }
  return null;
}

/** Reais com duas casas a partir de centavos. */
export function reaisDeCentavos(centavos: number): string {
  return (centavos / 100).toFixed(2);
}

/** Na criação, grava a tabela de eventos do modelo `VENDAS` quando o Admin não mandou uma (a tela mostra e edita o que está gravado). */
export function completarConfiguracaoDeCurso(
  definicao: { readonly eventos?: EventosDoAplicativo },
  configuracao: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  if (!definicao.eventos || configuracao.eventos !== undefined) {
    return { ...configuracao };
  }
  return {
    ...configuracao,
    eventos: tabelaPadrao(definicao.eventos.eventos),
  };
}

/** A tabela sem as etapas escolhidas (o funil da integração mudou: elas não valem mais). */
export function semEtapasDosEventos(
  configuracao: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  if (!ehObjeto(configuracao.eventos)) {
    return { ...configuracao };
  }
  const tabela = Object.fromEntries(
    Object.entries(configuracao.eventos).map(([codigo, bruta]) => [
      codigo,
      ehObjeto(bruta) ? { ...bruta, etapaId: null } : bruta,
    ]),
  );
  return { ...configuracao, eventos: tabela };
}

/** Os ids das etapas escolhidas na tabela de eventos. */
export function etapasDosEventos(
  configuracao: Readonly<Record<string, unknown>>,
): string[] {
  if (!ehObjeto(configuracao.eventos)) {
    return [];
  }
  return [
    ...new Set(
      Object.values(configuracao.eventos).flatMap((bruta) => {
        const etapaId = ehObjeto(bruta) ? textoOuNulo(bruta.etapaId) : null;
        return etapaId ? [etapaId] : [];
      }),
    ),
  ];
}
