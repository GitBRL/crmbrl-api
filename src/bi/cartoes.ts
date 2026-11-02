import type {
  CartaoBi,
  ColunaBi,
  TabelaBi,
  TipoColunaBi,
  UnidadeBi,
} from './bi.tipos';
import { variacaoPercentual } from './periodo';

export interface DefinicaoDeCartao {
  chave: string;
  rotulo: string;
  unidade: UnidadeBi;
  melhorQuando: 'maior' | 'menor' | null;
  dica: string;
}

export type Valores = Record<string, number | null>;

/**
 * Monta os cartões: `atual` e `anterior` trazem o valor de cada chave; as
 * chaves em `deAgora` não têm período anterior (retrato do momento).
 */
export function montarCartoes(
  definicoes: readonly DefinicaoDeCartao[],
  atual: Valores,
  anterior: Valores | null,
  deAgora: ReadonlySet<string> = new Set(),
): CartaoBi[] {
  return definicoes.map((definicao) => {
    const valor = atual[definicao.chave] ?? null;
    const anteriorDoCartao =
      anterior && !deAgora.has(definicao.chave)
        ? (anterior[definicao.chave] ?? null)
        : null;
    return {
      ...definicao,
      valor,
      anterior: anteriorDoCartao,
      variacao: variacaoPercentual(valor, anteriorDoCartao),
    };
  });
}

type EspecColuna = readonly [
  chave: string,
  rotulo: string,
  tipo: TipoColunaBi,
  visivel?: boolean,
];

export function tabela(
  chave: string,
  titulo: string,
  dica: string,
  colunas: readonly EspecColuna[],
  linhas: TabelaBi['linhas'],
): TabelaBi {
  return {
    chave,
    titulo,
    dica,
    colunas: colunas.map(([c, rotulo, tipo, visivel]): ColunaBi => ({
      chave: c,
      rotulo,
      tipo,
      visivel: visivel ?? tipo !== 'id',
    })),
    linhas,
  };
}

/** Número vindo do SQL (pode ser `null`) arredondado em `casas`. */
export function numero(
  valor: number | null | undefined,
  casas = 2,
): number | null {
  if (valor === null || valor === undefined) {
    return null;
  }
  const fator = 10 ** casas;
  return Math.round(valor * fator) / fator;
}
