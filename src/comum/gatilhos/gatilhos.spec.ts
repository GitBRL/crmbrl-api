import {
  alvoDaDataRelativa,
  problemaDaDataRelativa,
  problemaDaRecorrencia,
  proximaOcorrencia,
} from './agenda';
import { entidadeDoEvento, idsDoEvento, permiteEncadear } from './catalogo';
import { chaveDeLimite, gatilhoDoEvento } from './gatilhos.service';

// 30/10/2026 é sexta-feira; 12:00 UTC = 09:00 em São Paulo.
const AGORA = new Date('2026-10-30T12:00:00Z');

describe('Gatilhos (Onda B §2.1)', () => {
  describe('recorrência (fuso de São Paulo)', () => {
    it('diária: hoje se ainda não passou a hora, senão amanhã', () => {
      expect(
        proximaOcorrencia({ frequencia: 'diaria', hora: '10:30' }, AGORA),
      ).toEqual(new Date('2026-10-30T13:30:00Z'));
      expect(
        proximaOcorrencia({ frequencia: 'diaria', hora: '09:00' }, AGORA),
      ).toEqual(new Date('2026-10-31T12:00:00Z'));
    });

    it('semanal: o próximo dia da semana escolhido', () => {
      // segunda (1) e quarta (3) → segunda, 02/11
      expect(
        proximaOcorrencia(
          { frequencia: 'semanal', hora: '08:00', diasDaSemana: [1, 3] },
          AGORA,
        ),
      ).toEqual(new Date('2026-11-02T11:00:00Z'));
    });

    it('mensal: dia 31 cai no último dia de meses mais curtos', () => {
      expect(
        proximaOcorrencia(
          { frequencia: 'mensal', hora: '09:00', diaDoMes: 31 },
          new Date('2026-11-01T00:00:00Z'),
        ),
      ).toEqual(new Date('2026-11-30T12:00:00Z'));
    });

    it('valida a recorrência e a data relativa', () => {
      expect(
        problemaDaRecorrencia({ frequencia: 'semanal', hora: '08:00' }),
      ).toBe('Escolha ao menos um dia da semana.');
      expect(problemaDaRecorrencia({ frequencia: 'diaria', hora: '8h' })).toBe(
        'Informe a hora no formato HH:MM.',
      );
      expect(
        problemaDaRecorrencia({
          frequencia: 'mensal',
          hora: '08:00',
          diaDoMes: 10,
        }),
      ).toBeNull();
      expect(
        problemaDaDataRelativa({
          campo: 'negocio.previsaoFechamento',
          dias: -3,
          hora: '09:00',
        }),
      ).toBeNull();
      expect(
        problemaDaDataRelativa({
          campo: 'contato.campos.aniversario',
          dias: 0,
          hora: '09:00',
        }),
      ).toBeNull();
      expect(
        problemaDaDataRelativa({
          campo: 'negocio.titulo',
          dias: 1,
          hora: '09:00',
        }),
      ).toBe('Campo de data inválido.');
    });
  });

  it('data relativa: "3 dias antes da previsão" dispara hoje para previsões daqui a 3 dias', () => {
    const alvo = alvoDaDataRelativa(
      { campo: 'negocio.previsaoFechamento', dias: -3, hora: '08:00' },
      AGORA,
    );
    expect(alvo.diaDoCampo).toBe('2026-11-02');
    expect(alvo.inicio).toEqual(new Date('2026-11-02T03:00:00Z'));
    expect(alvo.fim).toEqual(new Date('2026-11-03T03:00:00Z'));
    expect(alvo.momentoDoDisparo).toEqual(new Date('2026-10-30T11:00:00Z'));
    expect(
      alvoDaDataRelativa(
        { campo: 'contato.criadoEm', dias: 7, hora: '08:00' },
        AGORA,
      ).diaDoCampo,
    ).toBe('2026-10-23');
  });

  it('extrai os ids e a entidade principal do evento', () => {
    expect(
      idsDoEvento({
        negocioId: 'n1',
        negocio: { contato: { id: 'c1' } },
        outro: 1,
      }),
    ).toEqual({
      negocioId: 'n1',
      contatoId: 'c1',
    });
    expect(entidadeDoEvento('negocio.movido')).toBe('negocio');
    expect(entidadeDoEvento('mensagem.recebida')).toBe('conversa');
    expect(entidadeDoEvento('campanha.respondida')).toBe('contato');
    expect(entidadeDoEvento('usuario.desligado')).toBeNull();
    const gatilho = gatilhoDoEvento({
      id: 'e1',
      tipo: 'atividade.criada',
      dados: { atividadeId: 'a1', contatoId: 'c1' },
      ocorridoEm: AGORA,
      tipoAtor: 'USUARIO',
      usuarioId: null,
      requisicaoId: null,
      tentativa: 1,
    });
    expect(gatilho.entidade).toEqual({ tipo: 'atividade', id: 'a1' });
    expect(gatilho.cadeia).toBeNull();
  });

  it('R19 — proteção contra laços: profundidade e repetição da mesma automação', () => {
    expect(permiteEncadear(null, 'a')).toEqual({ permitido: true });
    expect(
      permiteEncadear(
        { execucaoId: 'x', profundidade: 2, automacoes: ['a', 'b'] },
        'a',
      ),
    ).toEqual({ permitido: true });
    expect(
      permiteEncadear(
        { execucaoId: 'x', profundidade: 3, automacoes: ['a', 'a', 'a'] },
        'a',
      ).permitido,
    ).toBe(false);
    expect(
      permiteEncadear({
        execucaoId: 'x',
        profundidade: 5,
        automacoes: ['a', 'b', 'c', 'd', 'e'],
      }).permitido,
    ).toBe(false);
  });

  it('R19 — chave de limite por entidade', () => {
    expect(chaveDeLimite('A', 'E', 'UMA_VEZ', {})).toBe(
      'automacao:A:entidade:E',
    );
    expect(chaveDeLimite('A', 'E', 'SEMPRE', { eventoId: 'ev' })).toBe(
      'automacao:A:entidade:E:evento:ev',
    );
    const janela1 = chaveDeLimite('A', 'E', 'UMA_VEZ_POR_PERIODO', {
      periodoDias: 7,
      agora: AGORA,
    });
    const janela2 = chaveDeLimite('A', 'E', 'UMA_VEZ_POR_PERIODO', {
      periodoDias: 7,
      agora: new Date(AGORA.getTime() + 8 * 86_400_000),
    });
    expect(janela1).not.toBe(janela2);
  });
});
