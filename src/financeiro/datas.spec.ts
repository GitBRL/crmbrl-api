import {
  diasEntre,
  faixaDeAtraso,
  fimDoMes,
  hojeLocal,
  limitesDaFaixa,
  mesesEntre,
  mrrEmCentavos,
  somarDias,
  somarMeses,
  vencimentosDoContrato,
} from './datas';

describe('Financeiro — datas e MRR', () => {
  it('R22.2 — o MRR é o valor do período dividido pelos meses (cobrança única não é recorrente)', () => {
    expect(mrrEmCentavos(29_990, 'MENSAL')).toBe(29_990);
    expect(mrrEmCentavos(120_000, 'ANUAL')).toBe(10_000);
    expect(mrrEmCentavos(10_000, 'TRIMESTRAL')).toBe(3_333);
    expect(mrrEmCentavos(50_000, 'UNICO')).toBe(0);
  });

  it('R23.2 — faixas de atraso: 0–30, 31–60, 61–90 e 90+', () => {
    expect(faixaDeAtraso(0)).toBeNull();
    expect(faixaDeAtraso(1)).toBe('0-30');
    expect(faixaDeAtraso(30)).toBe('0-30');
    expect(faixaDeAtraso(31)).toBe('31-60');
    expect(faixaDeAtraso(60)).toBe('31-60');
    expect(faixaDeAtraso(61)).toBe('61-90');
    expect(faixaDeAtraso(90)).toBe('61-90');
    expect(faixaDeAtraso(91)).toBe('90+');
    expect(limitesDaFaixa('90+')).toEqual({ de: 91, ate: null });
  });

  it('calcula dias, meses e fim de mês sem depender do fuso', () => {
    expect(diasEntre('2026-01-01', '2026-01-31')).toBe(30);
    expect(somarDias('2026-03-01', -1)).toBe('2026-02-28');
    expect(somarMeses('2026-01-31', 1)).toBe('2026-02-28');
    expect(somarMeses('2026-11-15', 3)).toBe('2027-02-15');
    expect(fimDoMes('2028-02')).toBe('2028-02-29');
    expect(mesesEntre('2026-11', '2027-02')).toEqual([
      '2026-11',
      '2026-12',
      '2027-01',
      '2027-02',
    ]);
  });

  it('hojeLocal usa o fuso de São Paulo', () => {
    expect(hojeLocal(new Date('2026-10-31T01:30:00.000Z'))).toBe('2026-10-30');
  });

  it('R22.3 — gera um vencimento por período, no dia combinado', () => {
    expect(
      vencimentosDoContrato({
        inicio: '2026-01-10',
        periodicidade: 'MENSAL',
        ate: '2026-04-30',
        limite: 120,
      }),
    ).toEqual(['2026-01-10', '2026-02-10', '2026-03-10', '2026-04-10']);
    expect(
      vencimentosDoContrato({
        inicio: '2026-01-20',
        periodicidade: 'MENSAL',
        diaVencimento: 5,
        quantidade: 2,
        limite: 120,
      }),
    ).toEqual(['2026-02-05', '2026-03-05']);
    expect(
      vencimentosDoContrato({
        inicio: '2026-01-10',
        periodicidade: 'TRIMESTRAL',
        limite: 120,
      }),
    ).toHaveLength(12);
    expect(
      vencimentosDoContrato({
        inicio: '2026-01-10',
        periodicidade: 'UNICO',
        limite: 120,
      }),
    ).toEqual(['2026-01-10']);
    expect(
      vencimentosDoContrato({
        inicio: '2026-01-31',
        periodicidade: 'MENSAL',
        quantidade: 3,
        limite: 120,
      }),
    ).toEqual(['2026-01-31', '2026-02-28', '2026-03-31']);
  });
});
