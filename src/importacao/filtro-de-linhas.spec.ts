import {
  celulaPassaNaRegra,
  compilarFiltro,
  lerDataDoFiltro,
  lerNumeroDoFiltro,
  valorEmReais,
} from './filtro-de-linhas';

describe('Filtro da planilha (R16.11)', () => {
  it('R16.11 — texto comparado sem acento, caixa nem espaços extras', () => {
    expect(celulaPassaNaRegra('  SÃO   Paulo ', 'IGUAL', 'sao paulo')).toBe(
      true,
    );
    expect(celulaPassaNaRegra('Rio', 'DIFERENTE', 'sao paulo')).toBe(true);
    expect(celulaPassaNaRegra('Campinas - SP', 'CONTEM', 'sp')).toBe(true);
    expect(celulaPassaNaRegra('Campinas - SP', 'NAO_CONTEM', 'rj')).toBe(true);
    expect(celulaPassaNaRegra('Campinas - SP', 'COMECA_COM', 'CAMPI')).toBe(
      true,
    );
    expect(celulaPassaNaRegra('Campinas - SP', 'TERMINA_COM', 'sp')).toBe(true);
    expect(celulaPassaNaRegra('Campinas - SP', 'COMECA_COM', 'sp')).toBe(false);
  });

  it('R16.11 — UM_DE aceita vírgula ou ponto e vírgula; VAZIO e PREENCHIDO olham a célula aparada', () => {
    expect(celulaPassaNaRegra('Água', 'UM_DE', 'sp; agua , rj')).toBe(true);
    expect(celulaPassaNaRegra('mg', 'UM_DE', 'sp, rj')).toBe(false);
    expect(celulaPassaNaRegra('   ', 'VAZIO', null)).toBe(true);
    expect(celulaPassaNaRegra(' x ', 'VAZIO', null)).toBe(false);
    expect(celulaPassaNaRegra(' x ', 'PREENCHIDO', undefined)).toBe(true);
    expect(celulaPassaNaRegra('', 'PREENCHIDO', undefined)).toBe(false);
  });

  it('R16.11 — MAIOR_QUE e MENOR_QUE comparam datas dd/mm/aaaa (e as do XLSX), senão números', () => {
    expect(celulaPassaNaRegra('15/03/2026', 'MAIOR_QUE', '01/03/2026')).toBe(
      true,
    );
    expect(celulaPassaNaRegra('2026-03-15', 'MAIOR_QUE', '01/03/2026')).toBe(
      true,
    );
    expect(celulaPassaNaRegra('09/12/2025', 'MENOR_QUE', '01/01/2026')).toBe(
      true,
    );
    expect(celulaPassaNaRegra('31/02/2026', 'MENOR_QUE', '01/03/2026')).toBe(
      false,
    );
    expect(celulaPassaNaRegra('R$ 1.234,56', 'MAIOR_QUE', '1000')).toBe(true);
    expect(celulaPassaNaRegra('1234.56', 'MENOR_QUE', '1.500,00')).toBe(true);
    expect(celulaPassaNaRegra('abc', 'MAIOR_QUE', '1')).toBe(false);
    expect(celulaPassaNaRegra('', 'MENOR_QUE', '1')).toBe(false);
  });

  it('R16.11 — leitura de números e datas', () => {
    expect(lerNumeroDoFiltro('1.234,56')).toBe(1234.56);
    expect(lerNumeroDoFiltro('1234.56')).toBe(1234.56);
    expect(lerNumeroDoFiltro('1234,56')).toBe(1234.56);
    expect(lerNumeroDoFiltro('R$ 1.234,56')).toBe(1234.56);
    expect(lerNumeroDoFiltro('1.500')).toBe(1500);
    expect(lerNumeroDoFiltro('x')).toBeNull();
    expect(lerDataDoFiltro('1/2/2026')).not.toBeNull();
    expect(lerDataDoFiltro('2026-02-30')).toBeNull();
    expect(valorEmReais('R$ 1.234,5')).toBe('1234.50');
    expect(valorEmReais('-1')).toBeNull();
    expect(valorEmReais('abc')).toBeNull();
  });

  it('R16.11 — TODAS é E, QUALQUER é OU, e a coluna não precisa estar mapeada', () => {
    const colunas = ['Nome', 'Cidade', 'Status'];
    const regras = [
      { coluna: 'Cidade', operador: 'IGUAL' as const, valor: 'sao paulo' },
      { coluna: 'Status', operador: 'IGUAL' as const, valor: 'quente' },
    ];
    const todas = compilarFiltro({ combinacao: 'TODAS', regras }, colunas);
    const qualquer = compilarFiltro(
      { combinacao: 'QUALQUER', regras },
      colunas,
    );
    expect(todas(['Ana', 'São Paulo', 'Quente'])).toBe(true);
    expect(todas(['Ana', 'São Paulo', 'Frio'])).toBe(false);
    expect(qualquer(['Ana', 'Rio', 'Quente'])).toBe(true);
    expect(qualquer(['Ana', 'Rio', 'Frio'])).toBe(false);
  });

  it('R16.11 — regra de coluna que não existe é falsa; sem filtro, tudo passa', () => {
    const f = compilarFiltro(
      {
        combinacao: 'TODAS',
        regras: [{ coluna: 'Nada', operador: 'VAZIO' }],
      },
      ['A'],
    );
    expect(f(['x'])).toBe(false);
    expect(compilarFiltro(null, ['A'])(['x'])).toBe(true);
  });
});
