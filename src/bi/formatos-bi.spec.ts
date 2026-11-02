import type { TabelaBi } from './bi.tipos';
import {
  cartoesComoTabela,
  celulaCsv,
  nomeDeAba,
  tabelaComoCsv,
} from './formatos-bi';

describe('Formatos de exportação do BI', () => {
  it('R20 — célula de CSV protege contra fórmula e escapa separador e aspas', () => {
    expect(celulaCsv('=1+1')).toBe("'=1+1");
    expect(celulaCsv('a;b')).toBe('"a;b"');
    expect(celulaCsv('diz "oi"')).toBe('"diz ""oi"""');
    expect(celulaCsv(12.5)).toBe('12,5');
    expect(celulaCsv(-3)).toBe('-3');
    expect(celulaCsv(null)).toBe('');
  });

  it('R20 — CSV com BOM, ponto e vírgula, unidade no cabeçalho e sem colunas de apoio', () => {
    const tabela: TabelaBi = {
      chave: 't',
      titulo: 'T',
      dica: '',
      colunas: [
        { chave: 'id', rotulo: 'Id', tipo: 'id', visivel: false },
        { chave: 'nome', rotulo: 'Nome', tipo: 'texto', visivel: true },
        { chave: 'valor', rotulo: 'Valor', tipo: 'moeda', visivel: true },
      ],
      linhas: [{ id: 'x', nome: 'Ana', valor: 10.5 }],
    };
    expect(tabelaComoCsv(tabela)).toBe('﻿Nome;Valor (R$)\r\nAna;10,5\r\n');
  });

  it('R20 — os cartões viram uma tabela exportável', () => {
    const tabela = cartoesComoTabela([
      {
        chave: 'x',
        rotulo: 'X',
        valor: 2,
        anterior: 1,
        variacao: 100,
        unidade: 'numero',
        melhorQuando: 'maior',
        dica: '',
      },
    ]);
    expect(tabela.linhas).toEqual([
      {
        indicador: 'X',
        valor: 2,
        anterior: 1,
        variacao: 100,
        unidade: 'numero',
      },
    ]);
  });

  it('R20 — nome de aba sem caracteres proibidos e com no máximo 31 caracteres', () => {
    expect(nomeDeAba('Leads/dia: [x]')).not.toMatch(/[[\]:*?/\\]/);
    expect(nomeDeAba('a'.repeat(50))).toHaveLength(31);
  });
});
