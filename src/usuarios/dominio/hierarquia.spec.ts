import type { Papel } from '../../generated/prisma/client';
import {
  juntarNomes,
  type LiderCandidato,
  lideradosSemLiderValido,
  problemaDeLideranca,
  problemaDeMudancaDePapel,
  temLiderEsperado,
} from './hierarquia';

function lider(papel: Papel, ativo = true, id = 'lider'): LiderCandidato {
  return { id, nome: 'Fulano', papel, ativo };
}

describe('problemaDeLideranca (R1.2)', () => {
  it.each<[Papel, Papel]>([
    ['COMERCIAL', 'LIDER_COMERCIAL'],
    ['MARKETING', 'LIDER_MARKETING'],
    ['CS', 'LIDER_CS'],
    ['LIDER_COMERCIAL', 'C_LEVEL'],
    ['LIDER_MARKETING', 'C_LEVEL'],
    ['LIDER_CS', 'C_LEVEL'],
  ])('R1.2 — %s com líder %s ativo é aceito', (papel, papelDoLider) => {
    expect(problemaDeLideranca(papel, lider(papelDoLider))).toBeNull();
  });

  it.each<Papel>(['ADMIN', 'C_LEVEL'])(
    'R1.2 — %s sem líder é aceito; com líder, recusado',
    (papel) => {
      expect(problemaDeLideranca(papel, null)).toBeNull();
      expect(problemaDeLideranca(papel, lider('C_LEVEL'))).toMatchObject({
        regra: 'R1.2',
        mensagem: expect.stringMatching(/não tem líder/),
      });
    },
  );

  it('R1.2 — membro com líder de outra área é recusado com mensagem clara', () => {
    expect(problemaDeLideranca('COMERCIAL', lider('LIDER_MARKETING'))).toEqual({
      regra: 'R1.2',
      mensagem:
        'O líder de quem é Comercial precisa ser um Líder Comercial ativo, da mesma área — Fulano é Líder Marketing, de outra área.',
      detalhes: {
        papel: 'COMERCIAL',
        liderId: 'lider',
        papelDoLider: 'LIDER_MARKETING',
        liderEsperado: 'LIDER_COMERCIAL',
      },
    });
  });

  it('R1.2 — membro com um C-level (ou outro membro) como líder é recusado', () => {
    expect(problemaDeLideranca('CS', lider('C_LEVEL'))?.mensagem).toBe(
      'O líder de quem é CS precisa ser um Líder CS ativo, da mesma área — Fulano é C-level.',
    );
    expect(problemaDeLideranca('CS', lider('CS'))?.regra).toBe('R1.2');
  });

  it('R1.2 — líder sem C-level é recusado', () => {
    expect(problemaDeLideranca('LIDER_COMERCIAL', null)).toMatchObject({
      regra: 'R1.2',
      mensagem:
        'Quem é Líder Comercial precisa de um C-level ativo como líder (o C-level responsável).',
    });
    expect(
      problemaDeLideranca('LIDER_COMERCIAL', lider('LIDER_MARKETING')),
    ).toMatchObject({
      regra: 'R1.2',
      mensagem:
        'O líder de quem é Líder Comercial precisa ser um C-level ativo — Fulano é Líder Marketing.',
    });
  });

  it('R1.2 — membro sem líder é recusado', () => {
    expect(problemaDeLideranca('MARKETING', null)?.mensagem).toBe(
      'Quem é Marketing precisa de um líder: um Líder Marketing ativo da mesma área.',
    );
  });

  it('R1.2 — líder desligado não serve', () => {
    expect(
      problemaDeLideranca('COMERCIAL', lider('LIDER_COMERCIAL', false)),
    ).toMatchObject({
      regra: 'R1.2',
      mensagem:
        'O líder escolhido, Fulano, foi desligado: o líder precisa estar ativo.',
    });
  });

  it('R1.2 — ninguém é líder de si mesmo', () => {
    expect(
      problemaDeLideranca('LIDER_CS', lider('C_LEVEL', true, 'eu'), 'eu'),
    ).toMatchObject({
      regra: 'R1.2',
      mensagem: 'Ninguém pode ser líder de si mesmo.',
    });
  });
});

describe('mudança de papel com liderados (R1.3)', () => {
  const liderados = [
    { id: 'a', nome: 'Ana', papel: 'COMERCIAL' as Papel },
    { id: 'b', nome: 'Bia', papel: 'COMERCIAL' as Papel },
  ];

  it('R1.3 — líder com liderados não deixa de ser líder: o erro lista quem precisa de novo líder', () => {
    expect(
      problemaDeMudancaDePapel(
        { nome: 'Pedro', papel: 'LIDER_COMERCIAL' },
        'COMERCIAL',
        liderados,
      ),
    ).toEqual({
      regra: 'R1.3',
      mensagem:
        'Pedro tem 2 liderados que precisam de um novo líder antes de mudar para Comercial: Ana e Bia.',
      detalhes: {
        papelAtual: 'LIDER_COMERCIAL',
        novoPapel: 'COMERCIAL',
        liderados: [
          { id: 'a', nome: 'Ana', papel: 'COMERCIAL' },
          { id: 'b', nome: 'Bia', papel: 'COMERCIAL' },
        ],
      },
    });
  });

  it('R1.3 — líder com liderados não muda de área', () => {
    expect(
      problemaDeMudancaDePapel(
        { nome: 'Pedro', papel: 'LIDER_COMERCIAL' },
        'LIDER_MARKETING',
        liderados.slice(0, 1),
      )?.mensagem,
    ).toBe(
      'Pedro tem 1 liderado que precisa de um novo líder antes de mudar para Líder Marketing: Ana.',
    );
  });

  it('R1.3 — C-level com líderes abaixo também não muda de papel', () => {
    expect(
      problemaDeMudancaDePapel({ nome: 'Carla', papel: 'C_LEVEL' }, 'ADMIN', [
        { id: 'l', nome: 'Léo', papel: 'LIDER_CS' },
      ])?.regra,
    ).toBe('R1.3');
  });

  it('R1.3 — sem liderados, ou sem mudar de papel, não há problema', () => {
    expect(
      problemaDeMudancaDePapel(
        { nome: 'Pedro', papel: 'LIDER_COMERCIAL' },
        'COMERCIAL',
        [],
      ),
    ).toBeNull();
    expect(
      problemaDeMudancaDePapel(
        { nome: 'Pedro', papel: 'LIDER_COMERCIAL' },
        'LIDER_COMERCIAL',
        liderados,
      ),
    ).toBeNull();
  });

  it('lideradosSemLiderValido devolve só quem o novo papel não lidera', () => {
    expect(
      lideradosSemLiderValido('LIDER_COMERCIAL', [
        { id: 'a', nome: 'Ana', papel: 'COMERCIAL' },
        { id: 'l', nome: 'Léo', papel: 'LIDER_CS' },
      ]).map(({ id }) => id),
    ).toEqual(['l']);
  });
});

describe('temLiderEsperado (estado provisório do R7.3)', () => {
  it('membro respondendo a um C-level aguarda novo líder; com o líder da área, não', () => {
    expect(
      temLiderEsperado('COMERCIAL', { papel: 'C_LEVEL', ativo: true }),
    ).toBe(false);
    expect(
      temLiderEsperado('COMERCIAL', { papel: 'LIDER_COMERCIAL', ativo: true }),
    ).toBe(true);
    expect(
      temLiderEsperado('COMERCIAL', { papel: 'LIDER_COMERCIAL', ativo: false }),
    ).toBe(false);
    expect(temLiderEsperado('C_LEVEL', null)).toBe(true);
    expect(temLiderEsperado('LIDER_CS', null)).toBe(false);
  });
});

describe('juntarNomes', () => {
  it('junta com vírgulas e "e"', () => {
    expect(juntarNomes([])).toBe('');
    expect(juntarNomes(['Ana'])).toBe('Ana');
    expect(juntarNomes(['Ana', 'Bia'])).toBe('Ana e Bia');
    expect(juntarNomes(['Ana', 'Bia', 'Caio'])).toBe('Ana, Bia e Caio');
  });
});
