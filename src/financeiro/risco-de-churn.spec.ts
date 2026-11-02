import {
  nivelDaPontuacao,
  pontosDeAtraso,
  pontosDeSatisfacao,
  pontosDeSilencio,
} from './risco-de-churn.service';

describe('Financeiro — risco de churn (R23.4)', () => {
  it('R23.4 — pontua o atraso por faixa', () => {
    expect([0, 1, 30, 31, 60, 61, 120].map(pontosDeAtraso)).toEqual([
      0, 20, 20, 35, 35, 50, 50,
    ]);
  });

  it('R23.4 — satisfação baixa pesa, nota boa ou ausente não', () => {
    expect([null, 5, 4, 3, 2, 1].map(pontosDeSatisfacao)).toEqual([
      0, 0, 0, 15, 30, 30,
    ]);
  });

  it('R23.4 — silêncio de mais de 30 e de 60 dias', () => {
    expect([null, 10, 30, 31, 60, 61].map(pontosDeSilencio)).toEqual([
      0, 0, 0, 10, 10, 20,
    ]);
  });

  it('R23.4 — níveis baixo, médio e alto', () => {
    expect([0, 29, 30, 59, 60, 100].map(nivelDaPontuacao)).toEqual([
      'BAIXO',
      'BAIXO',
      'MEDIO',
      'MEDIO',
      'ALTO',
      'ALTO',
    ]);
  });
});
