import {
  baldesDoIntervalo,
  chaveDoBalde,
  intervaloDoPeriodo,
  meiaNoiteLocal,
  rotuloDoBalde,
} from './periodos';

// 12/11/2026, 15:00 UTC = 12:00 em São Paulo (UTC−3).
const AGORA = new Date('2026-11-12T15:00:00.000Z');

describe('períodos predefinidos (R33.3, fuso de São Paulo)', () => {
  it('meia-noite local de São Paulo é 03:00 UTC', () => {
    expect(meiaNoiteLocal(2026, 11, 12).toISOString()).toBe(
      '2026-11-12T03:00:00.000Z',
    );
    expect(meiaNoiteLocal(2026, 12, 1).toISOString()).toBe(
      '2026-12-01T03:00:00.000Z',
    );
  });

  it('R33.3 — hoje, 7 e 30 dias terminam no fim de hoje', () => {
    expect(intervaloDoPeriodo('HOJE', AGORA)).toEqual({
      de: new Date('2026-11-12T03:00:00.000Z'),
      ate: new Date('2026-11-13T03:00:00.000Z'),
    });
    const sete = intervaloDoPeriodo('ULTIMOS_7_DIAS', AGORA);
    expect(sete.de.toISOString()).toBe('2026-11-06T03:00:00.000Z');
    expect(sete.ate.toISOString()).toBe('2026-11-13T03:00:00.000Z');
    expect(intervaloDoPeriodo('ULTIMOS_30_DIAS', AGORA).de.toISOString()).toBe(
      '2026-10-14T03:00:00.000Z',
    );
  });

  it('R33.3 — mês atual, mês anterior, trimestre e ano', () => {
    expect(intervaloDoPeriodo('MES_ATUAL', AGORA).de.toISOString()).toBe(
      '2026-11-01T03:00:00.000Z',
    );
    const anterior = intervaloDoPeriodo('MES_ANTERIOR', AGORA);
    expect(anterior.de.toISOString()).toBe('2026-10-01T03:00:00.000Z');
    expect(anterior.ate.toISOString()).toBe('2026-11-01T03:00:00.000Z');
    expect(intervaloDoPeriodo('TRIMESTRE', AGORA).de.toISOString()).toBe(
      '2026-10-01T03:00:00.000Z',
    );
    expect(intervaloDoPeriodo('ANO', AGORA).de.toISOString()).toBe(
      '2026-01-01T03:00:00.000Z',
    );
  });

  it('R33.3 — mês anterior em janeiro volta para dezembro do ano anterior', () => {
    const janeiro = new Date('2026-01-10T15:00:00.000Z');
    expect(intervaloDoPeriodo('MES_ANTERIOR', janeiro).de.toISOString()).toBe(
      '2025-12-01T03:00:00.000Z',
    );
  });
});

describe('baldes da série (R33.2)', () => {
  it('semana começa na segunda e mês no dia 1', () => {
    expect(chaveDoBalde('2026-11-12', 'SEMANA')).toBe('2026-11-09');
    expect(chaveDoBalde('2026-11-09', 'SEMANA')).toBe('2026-11-09');
    expect(chaveDoBalde('2026-11-15', 'SEMANA')).toBe('2026-11-09');
    expect(chaveDoBalde('2026-11-12', 'MES')).toBe('2026-11-01');
    expect(chaveDoBalde('2026-11-12', 'DIA')).toBe('2026-11-12');
  });

  it('um balde por dia, sem buracos, no fuso de São Paulo', () => {
    const baldes = baldesDoIntervalo(
      new Date('2026-11-10T03:00:00.000Z'),
      new Date('2026-11-13T03:00:00.000Z'),
      'DIA',
    );
    expect(baldes).toEqual(['2026-11-10', '2026-11-11', '2026-11-12']);
  });

  it('semanas e meses não repetem o balde', () => {
    const de = new Date('2026-10-20T03:00:00.000Z');
    const ate = new Date('2026-11-13T03:00:00.000Z');
    expect(baldesDoIntervalo(de, ate, 'MES')).toEqual([
      '2026-10-01',
      '2026-11-01',
    ]);
    const semanas = baldesDoIntervalo(de, ate, 'SEMANA');
    expect(semanas[0]).toBe('2026-10-19');
    expect(semanas.at(-1)).toBe('2026-11-09');
    expect(new Set(semanas).size).toBe(semanas.length);
  });

  it('rótulos curtos', () => {
    expect(rotuloDoBalde('2026-11-05', 'DIA')).toBe('05/11');
    expect(rotuloDoBalde('2026-11-01', 'MES')).toBe('nov/2026');
  });
});
