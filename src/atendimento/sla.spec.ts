import { descreverMinutos, prazosDoSla, situacaoDoSla } from './sla';

describe('SLA das filas (R12)', () => {
  const inicio = new Date('2026-10-23T12:00:00Z');

  it('prazos a partir do início; sem fila ou sem SLA, nulos', () => {
    expect(
      prazosDoSla(
        { slaPrimeiraRespostaMinutos: 15, slaResolucaoMinutos: 240 },
        inicio,
      ),
    ).toEqual({
      slaPrimeiraRespostaAte: new Date('2026-10-23T12:15:00Z'),
      slaResolucaoAte: new Date('2026-10-23T16:00:00Z'),
    });
    expect(
      prazosDoSla(
        { slaPrimeiraRespostaMinutos: null, slaResolucaoMinutos: 60 },
        inicio,
      ).slaPrimeiraRespostaAte,
    ).toBeNull();
    expect(prazosDoSla(null, inicio)).toEqual({
      slaPrimeiraRespostaAte: null,
      slaResolucaoAte: null,
    });
  });

  it('estourado: em aberto, prazo passado e (na primeira resposta) sem resposta', () => {
    const conversa = {
      status: 'ABERTA' as const,
      primeiraRespostaEm: null,
      slaPrimeiraRespostaAte: new Date('2026-10-23T12:15:00Z'),
      slaResolucaoAte: new Date('2026-10-23T16:00:00Z'),
    };
    expect(situacaoDoSla(conversa, new Date('2026-10-23T12:10:00Z'))).toEqual({
      primeiraRespostaEstourada: false,
      resolucaoEstourada: false,
    });
    expect(situacaoDoSla(conversa, new Date('2026-10-23T12:15:00Z'))).toEqual({
      primeiraRespostaEstourada: true,
      resolucaoEstourada: false,
    });
    expect(
      situacaoDoSla(
        { ...conversa, primeiraRespostaEm: new Date() },
        new Date('2026-10-23T17:00:00Z'),
      ),
    ).toEqual({ primeiraRespostaEstourada: false, resolucaoEstourada: true });
    expect(
      situacaoDoSla(
        { ...conversa, status: 'RESOLVIDA' },
        new Date('2026-10-23T17:00:00Z'),
      ),
    ).toEqual({ primeiraRespostaEstourada: false, resolucaoEstourada: false });
  });

  it('descreve durações', () => {
    expect(descreverMinutos(12)).toBe('12 min');
    expect(descreverMinutos(60)).toBe('1 h');
    expect(descreverMinutos(125)).toBe('2 h 5 min');
    expect(descreverMinutos(1440)).toBe('1 dia');
    expect(descreverMinutos(3 * 1440 + 120)).toBe('3 dias e 2 h');
  });
});
