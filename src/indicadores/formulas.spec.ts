import {
  mediana,
  progressoDaMeta,
  taxa,
  taxaDeComparecimento,
  taxaDeConversao,
  taxaDeNoShow,
  ticketMedio,
} from './formulas';

describe('fórmulas dos indicadores (R33.1)', () => {
  it('R33.1 — comparecimento e no-show usam compareceu + não compareceu como base (remarcada e sem resultado ficam de fora)', () => {
    expect(taxaDeComparecimento(3, 1)).toBe(75);
    expect(taxaDeNoShow(3, 1)).toBe(25);
    expect((taxaDeComparecimento(2, 2) ?? 0) + (taxaDeNoShow(2, 2) ?? 0)).toBe(
      100,
    );
  });

  it('R33.1 — sem base não há taxa (nulo, nunca 0 nem NaN)', () => {
    expect(taxaDeComparecimento(0, 0)).toBeNull();
    expect(taxaDeNoShow(0, 0)).toBeNull();
    expect(taxaDeConversao(0, 0)).toBeNull();
    expect(taxa(5, 0)).toBeNull();
  });

  it('R33.1 — conversão = ganhos ÷ (ganhos + perdidos), com 2 casas', () => {
    expect(taxaDeConversao(1, 2)).toBe(33.33);
    expect(taxaDeConversao(4, 0)).toBe(100);
  });

  it('R33.1 — ticket médio é o valor ganho dividido pelos ganhos; sem ganhos, nulo', () => {
    expect(ticketMedio(1000, 4)).toBe(250);
    expect(ticketMedio(0, 0)).toBeNull();
  });

  it('R33.1 — mediana de quantidade par e ímpar; lista vazia é nula', () => {
    expect(mediana([5, 1, 3])).toBe(3);
    expect(mediana([4, 1, 3, 2])).toBe(2.5);
    expect(mediana([])).toBeNull();
  });
});

describe('metas (R33.5)', () => {
  it('R33.5 — progresso em % do alvo e meta atingida quando mais é melhor', () => {
    expect(progressoDaMeta(30, 40, 'maior')).toEqual({
      alvo: 40,
      progresso: 75,
      atingida: false,
    });
    expect(progressoDaMeta(50, 40, 'maior')).toEqual({
      alvo: 40,
      progresso: 125,
      atingida: true,
    });
  });

  it('R33.5 — quando menos é melhor a meta é um teto', () => {
    expect(progressoDaMeta(3600, 7200, 'menor')?.atingida).toBe(true);
    expect(progressoDaMeta(9000, 7200, 'menor')?.atingida).toBe(false);
  });

  it('R33.5 — sem meta não há progresso; sem valor a meta não é atingida; alvo zero não divide', () => {
    expect(progressoDaMeta(10, null, 'maior')).toBeNull();
    expect(progressoDaMeta(10, undefined, 'maior')).toBeNull();
    expect(progressoDaMeta(null, 10, 'maior')).toEqual({
      alvo: 10,
      progresso: null,
      atingida: false,
    });
    expect(progressoDaMeta(5, 0, 'maior')?.progresso).toBeNull();
  });
});
