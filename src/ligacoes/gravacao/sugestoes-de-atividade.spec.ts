import { vencimentoSugerido } from './sugestoes-de-atividade.service';

describe('R30 — vencimento das sugestões de atividade', () => {
  it('R30.23 — às 18h de Brasília, daqui a N dias', () => {
    // 2026-11-02 12:00 em Brasília (15:00 UTC).
    const agora = new Date('2026-11-02T15:00:00Z');
    expect(vencimentoSugerido(0, agora).toISOString()).toBe(
      '2026-11-02T21:00:00.000Z',
    );
    expect(vencimentoSugerido(3, agora).toISOString()).toBe(
      '2026-11-05T21:00:00.000Z',
    );
  });

  it('R30.23 — depois das 18h, "hoje" vira daqui a 1 hora', () => {
    const agora = new Date('2026-11-02T22:30:00Z');
    expect(vencimentoSugerido(0, agora).toISOString()).toBe(
      '2026-11-02T23:30:00.000Z',
    );
  });
});
