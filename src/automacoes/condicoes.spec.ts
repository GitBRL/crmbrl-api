import { conferirCondicoes, situacaoDoHorarioDaAutomacao } from './condicoes';

const horarioComercial = {
  fusoHorario: 'America/Sao_Paulo',
  dias: {
    '1': [{ inicio: '09:00', fim: '18:00' }],
    '2': [{ inicio: '09:00', fim: '18:00' }],
    '3': [{ inicio: '09:00', fim: '18:00' }],
    '4': [{ inicio: '09:00', fim: '18:00' }],
    '5': [{ inicio: '09:00', fim: '18:00' }],
  },
};

describe('Condições das automações (R19.3)', () => {
  it('R19.3 — confere segmento e horário; condição desconhecida é erro', () => {
    expect(conferirCondicoes({}).erros).toEqual([]);
    expect(conferirCondicoes(undefined).erros).toEqual([]);
    expect(conferirCondicoes({ horario: horarioComercial }).erros).toEqual([]);
    expect(
      conferirCondicoes({ horario: { fusoHorario: 'Marte/Olimpo', dias: {} } })
        .erros[0],
    ).toMatch(/Horário/);
    expect(
      conferirCondicoes({
        segmento: { condicoes: [{ campo: 'inexistente', operador: 'igual' }] },
      }).erros[0],
    ).toMatch(/Público/);
    expect(conferirCondicoes({ algo: 1 }).erros[0]).toMatch(/desconhecida/);
  });

  it('R19.3 — fora do horário devolve a próxima abertura; dentro, pode agir', () => {
    const { condicoes } = conferirCondicoes({ horario: horarioComercial });
    // Segunda-feira 2026-11-02 às 12:00 em São Paulo (15:00Z): aberto.
    expect(
      situacaoDoHorarioDaAutomacao(condicoes, new Date('2026-11-02T15:00:00Z')),
    ).toEqual({ pode: true });
    // Sábado 2026-10-31 às 12:00: fechado até segunda 09:00 (12:00Z).
    const fechado = situacaoDoHorarioDaAutomacao(
      condicoes,
      new Date('2026-10-31T15:00:00Z'),
    );
    expect(fechado.pode).toBe(false);
    expect(
      fechado.pode === false && fechado.proximaAbertura?.toISOString(),
    ).toBe('2026-11-02T12:00:00.000Z');
    expect(situacaoDoHorarioDaAutomacao({}, new Date())).toEqual({
      pode: true,
    });
  });
});
