import {
  dataLocal,
  descreverMomento,
  deslocamentoDoFuso,
  ehFusoHorarioValido,
  formatarHora,
  inicioDoDia,
  limitesDoCalendario,
} from './fuso-horario';

const SAO_PAULO = 'America/Sao_Paulo';

describe('fuso horário das atividades', () => {
  it('lê a data e a hora locais e o deslocamento de São Paulo (−3 h)', () => {
    const instante = new Date('2026-10-20T02:30:00Z');
    expect(dataLocal(instante, SAO_PAULO)).toEqual({
      ano: 2026,
      mes: 10,
      dia: 19,
      hora: 23,
      minuto: 30,
      segundo: 0,
    });
    expect(deslocamentoDoFuso(instante, SAO_PAULO)).toBe(-3 * 3_600_000);
    expect(deslocamentoDoFuso(instante, 'UTC')).toBe(0);
  });

  it('meia-noite local vira o instante UTC certo, inclusive virando mês e ano', () => {
    expect(inicioDoDia(2026, 10, 20, SAO_PAULO).toISOString()).toBe(
      '2026-10-20T03:00:00.000Z',
    );
    expect(inicioDoDia(2026, 10, 32, SAO_PAULO).toISOString()).toBe(
      '2026-11-01T03:00:00.000Z',
    );
    expect(inicioDoDia(2026, 12, 32, SAO_PAULO).toISOString()).toBe(
      '2027-01-01T03:00:00.000Z',
    );
    expect(inicioDoDia(2026, 10, 20, 'UTC').toISOString()).toBe(
      '2026-10-20T00:00:00.000Z',
    );
  });

  it('acerta os dias de troca do horário de verão', () => {
    // Nova York: 8/3/2026 começa o horário de verão (às 2h, −5 → −4).
    expect(inicioDoDia(2026, 3, 8, 'America/New_York').toISOString()).toBe(
      '2026-03-08T05:00:00.000Z',
    );
    expect(inicioDoDia(2026, 3, 9, 'America/New_York').toISOString()).toBe(
      '2026-03-09T04:00:00.000Z',
    );
    // São Paulo em 2018: o horário de verão começava à meia-noite (4/11), e o
    // dia começou à 1h (−2).
    expect(inicioDoDia(2018, 11, 4, SAO_PAULO).toISOString()).toBe(
      '2018-11-04T03:00:00.000Z',
    );
  });

  it('limites do calendário: hoje, amanhã e o fim dos próximos 7 dias', () => {
    // 23h30 de 19/10 em São Paulo: "hoje" ainda é o dia 19.
    const limites = limitesDoCalendario(
      new Date('2026-10-20T02:30:00Z'),
      SAO_PAULO,
    );
    expect(limites.inicioDeHoje.toISOString()).toBe('2026-10-19T03:00:00.000Z');
    expect(limites.inicioDeAmanha.toISOString()).toBe(
      '2026-10-20T03:00:00.000Z',
    );
    expect(limites.fimDosProximos7Dias.toISOString()).toBe(
      '2026-10-27T03:00:00.000Z',
    );
  });

  it('valida nomes de fuso', () => {
    expect(ehFusoHorarioValido(SAO_PAULO)).toBe(true);
    expect(ehFusoHorarioValido('Europe/Lisbon')).toBe(true);
    expect(ehFusoHorarioValido('Lugar/Nenhum')).toBe(false);
  });

  it('descreve o momento para os textos dos lembretes', () => {
    const agora = new Date('2026-10-20T15:00:00Z'); // 12h em São Paulo
    expect(formatarHora(new Date('2026-10-20T18:05:00Z'), SAO_PAULO)).toBe(
      '15:05',
    );
    expect(
      descreverMomento(new Date('2026-10-20T18:00:00Z'), agora, SAO_PAULO),
    ).toBe('às 15:00');
    expect(
      descreverMomento(new Date('2026-10-21T03:30:00Z'), agora, SAO_PAULO),
    ).toBe('em 21/10 às 00:30');
  });
});
