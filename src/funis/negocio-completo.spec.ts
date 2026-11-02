import {
  diasNaEtapa,
  estaParado,
  formatarDataSemHora,
  lerDataSemHora,
  statusDaEtapa,
} from './negocio-completo';

describe('derivações do negócio', () => {
  const agora = new Date('2026-10-20T12:00:00.000Z');
  const diasAtras = (dias: number) =>
    new Date(agora.getTime() - dias * 86_400_000);

  it('R5.3 — o status deriva do tipo da etapa', () => {
    expect(statusDaEtapa('ABERTA')).toBe('ABERTO');
    expect(statusDaEtapa('GANHO')).toBe('GANHO');
    expect(statusDaEtapa('PERDIDO')).toBe('PERDIDO');
  });

  it('R5.10 — parado: aberto há mais tempo que o prazo-alvo da etapa', () => {
    const aberto = (dias: number) => ({
      status: 'ABERTO' as const,
      etapaDesde: diasAtras(dias),
    });
    expect(estaParado(aberto(3), 2, agora)).toBe(true);
    expect(estaParado(aberto(1), 2, agora)).toBe(false);
    expect(estaParado(aberto(30), null, agora)).toBe(false);
    expect(
      estaParado({ status: 'GANHO', etapaDesde: diasAtras(30) }, 2, agora),
    ).toBe(false);
  });

  it('dias na etapa e datas sem hora', () => {
    expect(diasNaEtapa(diasAtras(2.5), agora)).toBe(2);
    expect(diasNaEtapa(new Date(agora.getTime() + 1000), agora)).toBe(0);
    expect(formatarDataSemHora(lerDataSemHora('2026-11-30'))).toBe(
      '2026-11-30',
    );
    expect(formatarDataSemHora(null)).toBeNull();
  });
});
