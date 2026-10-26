import {
  ehFusoHorarioValido,
  type HorarioDeAtendimento,
  inicioDaContagem,
  instanteLocal,
  jaRespondeuForaDoHorario,
  lerHorario,
  partesLocais,
  situacaoDoHorario,
  validarHorario,
} from './horario';

/** Segunda a sexta, 8h–12h e 13h–18h; sábado, 9h–13h (São Paulo, UTC−3). */
const COMERCIAL: HorarioDeAtendimento = {
  fusoHorario: 'America/Sao_Paulo',
  dias: {
    '1': [
      { inicio: '08:00', fim: '12:00' },
      { inicio: '13:00', fim: '18:00' },
    ],
    '2': [{ inicio: '08:00', fim: '18:00' }],
    '3': [{ inicio: '08:00', fim: '18:00' }],
    '4': [{ inicio: '08:00', fim: '18:00' }],
    '5': [{ inicio: '08:00', fim: '18:00' }],
    '6': [{ inicio: '09:00', fim: '13:00' }],
  },
};

/** Horário de São Paulo (UTC−3, sem horário de verão desde 2019) em UTC. */
const sp = (texto: string) => new Date(`${texto}-03:00`);

describe('horário de atendimento (R12)', () => {
  describe('validarHorario', () => {
    it('aceita, ordena os intervalos e guarda só os dias com horário', () => {
      const lido = validarHorario({
        fusoHorario: 'America/Sao_Paulo',
        dias: {
          '1': [
            { inicio: '13:00', fim: '18:00' },
            { inicio: '08:00', fim: '12:00' },
          ],
          '0': [],
          '5': [{ inicio: '22:00', fim: '24:00' }],
        },
      });
      expect(lido).toEqual({
        horario: {
          fusoHorario: 'America/Sao_Paulo',
          dias: {
            '1': [
              { inicio: '08:00', fim: '12:00' },
              { inicio: '13:00', fim: '18:00' },
            ],
            '5': [{ inicio: '22:00', fim: '24:00' }],
          },
        },
      });
    });

    it('lista os problemas em português', () => {
      const lido = validarHorario({
        fusoHorario: 'Lua/Base',
        dias: {
          '7': [{ inicio: '08:00', fim: '09:00' }],
          '1': [{ inicio: '8h', fim: '12:00' }],
          '2': [{ inicio: '10:00', fim: '09:00' }],
          '3': [
            { inicio: '08:00', fim: '12:00' },
            { inicio: '11:00', fim: '14:00' },
          ],
          '4': 'sempre',
        },
      });
      expect(lido.erros).toEqual([
        expect.stringContaining('Fuso horário inválido'),
        expect.stringContaining('Horário inválido em segunda-feira'),
        expect.stringContaining('Em terça-feira, o fim (09:00)'),
        'Há intervalos sobrepostos em quarta-feira.',
        'Os horários de quinta-feira precisam ser uma lista.',
        expect.stringContaining('Dia "7" inválido'),
      ]);
    });

    it('recusa horário sem nenhum intervalo e formatos que não são objeto', () => {
      expect(
        validarHorario({ fusoHorario: 'America/Sao_Paulo', dias: {} }).erros,
      ).toEqual([expect.stringContaining('pelo menos um intervalo')]);
      expect(validarHorario('8 às 18').erros).toHaveLength(1);
      expect(
        validarHorario({ fusoHorario: 'America/Sao_Paulo' }).erros,
      ).toEqual([expect.stringContaining('dias da semana')]);
    });

    it('lerHorario: nulo ou quebrado = 24 horas', () => {
      expect(lerHorario(null)).toBeNull();
      expect(lerHorario({ fusoHorario: 'X', dias: {} })).toBeNull();
      expect(lerHorario(COMERCIAL)).toEqual(COMERCIAL);
    });

    it('ehFusoHorarioValido', () => {
      expect(ehFusoHorarioValido('America/Manaus')).toBe(true);
      expect(ehFusoHorarioValido('')).toBe(false);
      expect(ehFusoHorarioValido(3)).toBe(false);
    });
  });

  describe('fuso', () => {
    it('partesLocais e instanteLocal vão e voltam', () => {
      const instante = instanteLocal(
        2026,
        10,
        23,
        8 * 60 + 30,
        'America/Sao_Paulo',
      );
      expect(instante.toISOString()).toBe('2026-10-23T11:30:00.000Z');
      expect(partesLocais(instante, 'America/Sao_Paulo')).toMatchObject({
        ano: 2026,
        mes: 10,
        dia: 23,
        hora: 8,
        minuto: 30,
      });
      // Fuso com horário de verão: Nova York em julho (UTC−4) e em dezembro (UTC−5).
      expect(
        instanteLocal(2026, 7, 1, 9 * 60, 'America/New_York').toISOString(),
      ).toBe('2026-07-01T13:00:00.000Z');
      expect(
        instanteLocal(2026, 12, 1, 9 * 60, 'America/New_York').toISOString(),
      ).toBe('2026-12-01T14:00:00.000Z');
    });
  });

  describe('situacaoDoHorario', () => {
    it('sem horário: sempre aberto', () => {
      expect(situacaoDoHorario(null).aberto).toBe(true);
    });

    it('aberto no meio do expediente, com o fechamento', () => {
      // Sexta-feira, 23/10/2026, 10h.
      expect(situacaoDoHorario(COMERCIAL, sp('2026-10-23T10:00:00'))).toEqual({
        aberto: true,
        fechadoDesde: null,
        proximaAbertura: null,
        proximoFechamento: sp('2026-10-23T18:00:00'),
      });
    });

    it('fechado no almoço de segunda: desde o meio-dia, abre às 13h', () => {
      expect(situacaoDoHorario(COMERCIAL, sp('2026-10-26T12:30:00'))).toEqual({
        aberto: false,
        fechadoDesde: sp('2026-10-26T12:00:00'),
        proximaAbertura: sp('2026-10-26T13:00:00'),
        proximoFechamento: null,
      });
    });

    it('fechado no domingo: desde sábado 13h, abre segunda 8h', () => {
      expect(
        situacaoDoHorario(COMERCIAL, sp('2026-10-25T15:00:00')),
      ).toMatchObject({
        aberto: false,
        fechadoDesde: sp('2026-10-24T13:00:00'),
        proximaAbertura: sp('2026-10-26T08:00:00'),
      });
    });

    it('o início é inclusivo e o fim, exclusivo', () => {
      expect(
        situacaoDoHorario(COMERCIAL, sp('2026-10-23T08:00:00')).aberto,
      ).toBe(true);
      expect(
        situacaoDoHorario(COMERCIAL, sp('2026-10-23T18:00:00')).aberto,
      ).toBe(false);
    });

    it('junta o período que atravessa a meia-noite (22h–24h + 0h–2h)', () => {
      const noturno: HorarioDeAtendimento = {
        fusoHorario: 'America/Sao_Paulo',
        dias: {
          '5': [{ inicio: '22:00', fim: '24:00' }],
          '6': [{ inicio: '00:00', fim: '02:00' }],
        },
      };
      expect(
        situacaoDoHorario(noturno, sp('2026-10-23T23:00:00')),
      ).toMatchObject({
        aberto: true,
        proximoFechamento: sp('2026-10-24T02:00:00'),
      });
      expect(situacaoDoHorario(noturno, sp('2026-10-24T01:59:00')).aberto).toBe(
        true,
      );
    });

    it('todos os dias de 0h a 24h: aberto e "não fecha" na janela', () => {
      const sempre: HorarioDeAtendimento = {
        fusoHorario: 'America/Sao_Paulo',
        dias: Object.fromEntries(
          ['0', '1', '2', '3', '4', '5', '6'].map((dia) => [
            dia,
            [{ inicio: '00:00', fim: '24:00' }],
          ]),
        ),
      };
      expect(
        situacaoDoHorario(sempre, sp('2026-10-23T03:00:00')),
      ).toMatchObject({
        aberto: true,
        proximoFechamento: null,
      });
    });
  });

  describe('inicioDaContagem e resposta fora do horário', () => {
    it('SLA conta da chegada no horário e da abertura seguinte fora dele', () => {
      const noHorario = sp('2026-10-23T10:00:00');
      expect(inicioDaContagem(COMERCIAL, noHorario)).toEqual(noHorario);
      expect(inicioDaContagem(COMERCIAL, sp('2026-10-23T20:00:00'))).toEqual(
        sp('2026-10-24T09:00:00'),
      );
      expect(inicioDaContagem(null, noHorario)).toEqual(noHorario);
    });

    it('uma resposta automática por período fechado', () => {
      const situacao = situacaoDoHorario(COMERCIAL, sp('2026-10-23T20:00:00'));
      expect(jaRespondeuForaDoHorario(null, situacao)).toBe(false);
      // Respondida hoje às 19h (mesmo fechamento, que começou às 18h): não repete.
      expect(
        jaRespondeuForaDoHorario(sp('2026-10-23T19:00:00'), situacao),
      ).toBe(true);
      // Respondida ontem à noite (fechamento anterior): responde de novo.
      expect(
        jaRespondeuForaDoHorario(sp('2026-10-22T19:00:00'), situacao),
      ).toBe(false);
    });
  });
});
