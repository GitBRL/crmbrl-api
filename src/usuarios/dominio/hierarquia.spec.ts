import {
  type PapelDeTeste,
  papelESetor as p,
} from '../../comum/dominio/papeis-antigos.apoio-spec';
import {
  juntarNomes,
  type LiderCandidato,
  lideradosSemLiderValido,
  problemaDeLideranca,
  problemaDeMudancaDePapel,
  temLiderEsperado,
} from './hierarquia';

function lider(
  papel: PapelDeTeste,
  ativo = true,
  id = 'lider',
): LiderCandidato {
  return { id, nome: 'Fulano', ...p(papel), ativo };
}

describe('problemaDeLideranca (R1.2)', () => {
  it.each<[PapelDeTeste, PapelDeTeste]>([
    ['COMERCIAL', 'LIDER_COMERCIAL'],
    ['MARKETING', 'LIDER_MARKETING'],
    ['CS', 'LIDER_CS'],
    ['LIDER_COMERCIAL', 'C_LEVEL'],
    ['LIDER_MARKETING', 'C_LEVEL'],
    ['LIDER_CS', 'C_LEVEL'],
  ])('R1.2 — %s com líder %s ativo é aceito', (papel, papelDoLider) => {
    expect(problemaDeLideranca(p(papel), lider(papelDoLider))).toBeNull();
  });

  it('R1.2 — num setor criado, o membro responde ao líder do mesmo setor', () => {
    const doPosVenda = {
      id: 'lider',
      nome: 'Fulano',
      papel: 'LIDER' as const,
      area: 'POS_VENDA',
      ativo: true,
    };
    expect(
      problemaDeLideranca({ papel: 'MEMBRO', area: 'POS_VENDA' }, doPosVenda),
    ).toBeNull();
    expect(
      problemaDeLideranca({ papel: 'MEMBRO', area: 'CS' }, doPosVenda)?.regra,
    ).toBe('R1.2');
  });

  it.each<PapelDeTeste>(['ADMIN', 'C_LEVEL'])(
    'R1.2 — %s sem líder é aceito; com líder, recusado',
    (papel) => {
      expect(problemaDeLideranca(p(papel), null)).toBeNull();
      expect(problemaDeLideranca(p(papel), lider('C_LEVEL'))).toMatchObject({
        regra: 'R1.2',
        mensagem: expect.stringMatching(/não tem líder/),
      });
    },
  );

  it('R1.2 — membro com líder de outro setor é recusado com mensagem clara', () => {
    expect(
      problemaDeLideranca(p('COMERCIAL'), lider('LIDER_MARKETING')),
    ).toEqual({
      regra: 'R1.2',
      mensagem:
        'O líder de quem é Comercial precisa ser um Líder Comercial ativo, do mesmo setor — Fulano é Líder Marketing, de outro setor.',
      detalhes: {
        papel: 'MEMBRO',
        area: 'COMERCIAL',
        liderId: 'lider',
        papelDoLider: 'LIDER',
        areaDoLider: 'MARKETING',
        liderEsperado: { papel: 'LIDER', area: 'COMERCIAL' },
      },
    });
  });

  it('R1.2 — membro com um C-level (ou outro membro) como líder é recusado', () => {
    expect(problemaDeLideranca(p('CS'), lider('C_LEVEL'))?.mensagem).toBe(
      'O líder de quem é Customer Success precisa ser um Líder Customer Success ativo, do mesmo setor — Fulano é C-level.',
    );
    expect(problemaDeLideranca(p('CS'), lider('CS'))?.regra).toBe('R1.2');
  });

  it('R1.2 — líder sem C-level é recusado', () => {
    expect(problemaDeLideranca(p('LIDER_COMERCIAL'), null)).toMatchObject({
      regra: 'R1.2',
      mensagem:
        'Quem é Líder Comercial precisa de um C-level ativo como líder (o C-level responsável).',
    });
    expect(
      problemaDeLideranca(p('LIDER_COMERCIAL'), lider('LIDER_MARKETING')),
    ).toMatchObject({
      regra: 'R1.2',
      mensagem:
        'O líder de quem é Líder Comercial precisa ser um C-level ativo — Fulano é Líder Marketing.',
    });
  });

  it('R1.2 — membro sem líder é recusado', () => {
    expect(problemaDeLideranca(p('MARKETING'), null)?.mensagem).toBe(
      'Quem é Marketing precisa de um líder: um Líder Marketing ativo do mesmo setor.',
    );
  });

  it('R1.2 — líder desligado não serve', () => {
    expect(
      problemaDeLideranca(p('COMERCIAL'), lider('LIDER_COMERCIAL', false)),
    ).toMatchObject({
      regra: 'R1.2',
      mensagem:
        'O líder escolhido, Fulano, foi desligado: o líder precisa estar ativo.',
    });
  });

  it('R1.2 — ninguém é líder de si mesmo', () => {
    expect(
      problemaDeLideranca(p('LIDER_CS'), lider('C_LEVEL', true, 'eu'), 'eu'),
    ).toMatchObject({
      regra: 'R1.2',
      mensagem: 'Ninguém pode ser líder de si mesmo.',
    });
  });
});

describe('mudança de papel ou de setor com liderados (R1.3)', () => {
  const liderados = [
    { id: 'a', nome: 'Ana', ...p('COMERCIAL') },
    { id: 'b', nome: 'Bia', ...p('COMERCIAL') },
  ];

  it('R1.3 — líder com liderados não deixa de ser líder: o erro lista quem precisa de novo líder', () => {
    expect(
      problemaDeMudancaDePapel(
        { nome: 'Pedro', ...p('LIDER_COMERCIAL') },
        p('COMERCIAL'),
        liderados,
      ),
    ).toEqual({
      regra: 'R1.3',
      mensagem:
        'Pedro tem 2 liderados que precisam de um novo líder antes de mudar para Comercial: Ana e Bia.',
      detalhes: {
        papelAtual: 'LIDER',
        areaAtual: 'COMERCIAL',
        novoPapel: 'MEMBRO',
        novaArea: 'COMERCIAL',
        liderados: [
          { id: 'a', nome: 'Ana', papel: 'MEMBRO', area: 'COMERCIAL' },
          { id: 'b', nome: 'Bia', papel: 'MEMBRO', area: 'COMERCIAL' },
        ],
      },
    });
  });

  it('R1.3 — líder com liderados não muda de setor', () => {
    expect(
      problemaDeMudancaDePapel(
        { nome: 'Pedro', ...p('LIDER_COMERCIAL') },
        p('LIDER_MARKETING'),
        liderados.slice(0, 1),
      )?.mensagem,
    ).toBe(
      'Pedro tem 1 liderado que precisa de um novo líder antes de mudar para Líder Marketing: Ana.',
    );
  });

  it('R1.3 — C-level com líderes abaixo também não muda de papel', () => {
    expect(
      problemaDeMudancaDePapel({ nome: 'Carla', ...p('C_LEVEL') }, p('ADMIN'), [
        { id: 'l', nome: 'Léo', ...p('LIDER_CS') },
      ])?.regra,
    ).toBe('R1.3');
  });

  it('R1.3 — sem liderados, ou sem mudar de papel nem de setor, não há problema', () => {
    expect(
      problemaDeMudancaDePapel(
        { nome: 'Pedro', ...p('LIDER_COMERCIAL') },
        p('COMERCIAL'),
        [],
      ),
    ).toBeNull();
    expect(
      problemaDeMudancaDePapel(
        { nome: 'Pedro', ...p('LIDER_COMERCIAL') },
        p('LIDER_COMERCIAL'),
        liderados,
      ),
    ).toBeNull();
  });

  it('lideradosSemLiderValido devolve só quem o novo papel não lidera', () => {
    expect(
      lideradosSemLiderValido(p('LIDER_COMERCIAL'), [
        { id: 'a', nome: 'Ana', ...p('COMERCIAL') },
        { id: 'l', nome: 'Léo', ...p('LIDER_CS') },
      ]).map(({ id }) => id),
    ).toEqual(['l']);
  });
});

describe('temLiderEsperado (estado provisório do R7.3)', () => {
  it('membro respondendo a um C-level aguarda novo líder; com o líder do setor, não', () => {
    expect(
      temLiderEsperado(p('COMERCIAL'), { ...p('C_LEVEL'), ativo: true }),
    ).toBe(false);
    expect(
      temLiderEsperado(p('COMERCIAL'), {
        ...p('LIDER_COMERCIAL'),
        ativo: true,
      }),
    ).toBe(true);
    expect(
      temLiderEsperado(p('COMERCIAL'), {
        ...p('LIDER_COMERCIAL'),
        ativo: false,
      }),
    ).toBe(false);
    expect(
      temLiderEsperado(p('COMERCIAL'), { ...p('LIDER_CS'), ativo: true }),
    ).toBe(false);
    expect(temLiderEsperado(p('C_LEVEL'), null)).toBe(true);
    expect(temLiderEsperado(p('LIDER_CS'), null)).toBe(false);
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
