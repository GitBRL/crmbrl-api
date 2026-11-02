/**
 * Formatos de exportação do BI (puros, testáveis): tabela dos cartões, CSV com
 * `;` e BOM (abre direto no Excel em português) e nomes de arquivo.
 */
import type {
  CartaoBi,
  CelulaBi,
  ColunaBi,
  TabelaBi,
  TipoColunaBi,
} from './bi.tipos';

const SUFIXO_DA_UNIDADE: Partial<Record<TipoColunaBi, string>> = {
  moeda: ' (R$)',
  percentual: ' (%)',
  segundos: ' (s)',
  dias: ' (dias)',
};

/** Cabeçalho da coluna com a unidade, para a planilha não depender da tela. */
export function cabecalhoDaColuna(coluna: ColunaBi): string {
  return `${coluna.rotulo}${SUFIXO_DA_UNIDADE[coluna.tipo] ?? ''}`;
}

/** Os indicadores como uma tabela (`cartoes`), exportável como as demais. */
export function cartoesComoTabela(cartoes: readonly CartaoBi[]): TabelaBi {
  return {
    chave: 'cartoes',
    titulo: 'Indicadores',
    dica: 'Valor do período, valor do período anterior e variação.',
    colunas: [
      { chave: 'indicador', rotulo: 'Indicador', tipo: 'texto', visivel: true },
      { chave: 'valor', rotulo: 'Valor', tipo: 'numero', visivel: true },
      {
        chave: 'anterior',
        rotulo: 'Período anterior',
        tipo: 'numero',
        visivel: true,
      },
      {
        chave: 'variacao',
        rotulo: 'Variação (%)',
        tipo: 'numero',
        visivel: true,
      },
      { chave: 'unidade', rotulo: 'Unidade', tipo: 'texto', visivel: true },
    ],
    linhas: cartoes.map((c) => ({
      indicador: c.rotulo,
      valor: c.valor,
      anterior: c.anterior,
      variacao: c.variacao,
      unidade: c.unidade,
    })),
  };
}

/** Uma célula de CSV: protege contra fórmula e escapa `;`, aspas e quebras. */
export function celulaCsv(valor: CelulaBi): string {
  if (valor === null || valor === undefined) {
    return '';
  }
  const texto =
    typeof valor === 'number' ? String(valor).replace('.', ',') : String(valor);
  const seguro =
    typeof valor === 'string' && /^[=+\-@\t\r]/.test(texto)
      ? `'${texto}`
      : texto;
  return /[";\r\n]/.test(seguro) ? `"${seguro.replace(/"/g, '""')}"` : seguro;
}

/** CSV da tabela (colunas visíveis), `;` como separador e BOM no início. */
export function tabelaComoCsv(tabela: TabelaBi): string {
  const colunas = tabela.colunas.filter((c) => c.visivel);
  const linhas = [
    colunas.map((c) => celulaCsv(cabecalhoDaColuna(c))),
    ...tabela.linhas.map((linha) =>
      colunas.map((c) => celulaCsv(linha[c.chave] ?? null)),
    ),
  ];
  return `﻿${linhas.map((l) => l.join(';')).join('\r\n')}\r\n`;
}

/** Nome de aba do Excel: sem `[]:*?/\`, até 31 caracteres. */
export function nomeDeAba(titulo: string): string {
  return (
    titulo
      .replace(/[[\]:*?/\\]/g, ' ')
      .trim()
      .slice(0, 31) || 'Planilha'
  );
}
