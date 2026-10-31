import { DadosInvalidosException } from '../comum/erros/excecoes';
import {
  diasDoIntervalo,
  percentual,
  resolverPeriodo,
  variacaoPercentual,
} from './periodo';

const AGORA = new Date('2026-10-30T15:00:00.000Z');

describe('Período do BI', () => {
  it('R20 — sem datas, usa os últimos 30 dias e compara com os 30 anteriores', () => {
    const { atual, anterior } = resolverPeriodo(
      undefined,
      undefined,
      true,
      AGORA,
    );
    expect(atual.ate).toEqual(AGORA);
    expect(atual.ate.getTime() - atual.de.getTime()).toBe(30 * 86_400_000);
    expect(anterior?.ate).toEqual(atual.de);
    expect(anterior && anterior.ate.getTime() - anterior.de.getTime()).toBe(
      30 * 86_400_000,
    );
  });

  it('R20 — o anterior tem a mesma duração do período pedido, colado no início', () => {
    const { atual, anterior } = resolverPeriodo(
      '2026-10-10T00:00:00.000Z',
      '2026-10-13T00:00:00.000Z',
      true,
      AGORA,
    );
    expect(atual.ate.getTime() - atual.de.getTime()).toBe(3 * 86_400_000);
    expect(anterior?.de.toISOString()).toBe('2026-10-07T00:00:00.000Z');
    expect(anterior?.ate.toISOString()).toBe('2026-10-10T00:00:00.000Z');
  });

  it('R20 — sem comparação, não há período anterior', () => {
    expect(
      resolverPeriodo(undefined, undefined, false, AGORA).anterior,
    ).toBeNull();
  });

  it('R20 — recusa início depois do fim e períodos acima de 1 ano', () => {
    expect(() =>
      resolverPeriodo(
        '2026-10-10T00:00:00Z',
        '2026-10-09T00:00:00Z',
        true,
        AGORA,
      ),
    ).toThrow(DadosInvalidosException);
    expect(() =>
      resolverPeriodo(
        '2025-01-01T00:00:00Z',
        '2026-10-09T00:00:00Z',
        true,
        AGORA,
      ),
    ).toThrow(DadosInvalidosException);
  });

  it('R20 — variação percentual: nula sem anterior ou com anterior zero', () => {
    expect(variacaoPercentual(150, 100)).toBe(50);
    expect(variacaoPercentual(50, 100)).toBe(-50);
    expect(variacaoPercentual(10, 0)).toBeNull();
    expect(variacaoPercentual(10, null)).toBeNull();
    expect(variacaoPercentual(null, 10)).toBeNull();
  });

  it('R20 — percentual: nulo com total zero, 2 casas', () => {
    expect(percentual(1, 3)).toBe(33.33);
    expect(percentual(0, 0)).toBeNull();
  });

  it('R20 — dias do intervalo no fuso de Brasília, sem buracos e sem repetir', () => {
    // 01/10 02:00Z = 30/09 23:00 em Brasília.
    const dias = diasDoIntervalo(
      new Date('2026-10-01T02:00:00Z'),
      new Date('2026-10-04T02:00:00Z'),
    );
    expect(dias).toEqual([
      '2026-09-30',
      '2026-10-01',
      '2026-10-02',
      '2026-10-03',
    ]);
  });
});
