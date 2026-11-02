import {
  alertaDeEquipeSemLider,
  type ContagensDeEncaminhamento,
  descreverItens,
  notificacaoDeItensRecebidos,
  quantidade,
} from './encaminhamento';

const NADA: ContagensDeEncaminhamento = {
  atividades: 0,
  negocios: 0,
  contatos: 0,
  empresas: 0,
  liderados: 0,
  responsavelFixo: 0,
};

describe('textos do encaminhamento (R7.4)', () => {
  it('quantidade escolhe singular ou plural', () => {
    expect(quantidade(1, 'atividade', 'atividades')).toBe('1 atividade');
    expect(quantidade(0, 'atividade', 'atividades')).toBe('0 atividades');
    expect(quantidade(12, 'atividade', 'atividades')).toBe('12 atividades');
  });

  it('descreve só o que não é zero', () => {
    expect(descreverItens(NADA)).toBe('');
    expect(descreverItens({ ...NADA, atividades: 12, negocios: 3 })).toBe(
      '12 atividades e 3 negócios',
    );
    expect(
      descreverItens({
        ...NADA,
        atividades: 1,
        negocios: 1,
        contatos: 40,
        empresas: 2,
      }),
    ).toBe('1 atividade, 1 negócio, 40 contatos e 2 empresas');
    expect(descreverItens({ ...NADA, empresas: 1 })).toBe('1 empresa');
  });

  it('R7.4 — "Você recebeu 12 atividades e 3 negócios de Pedro"', () => {
    expect(
      notificacaoDeItensRecebidos('Pedro', {
        ...NADA,
        atividades: 12,
        negocios: 3,
      }),
    ).toEqual({
      titulo: 'Itens recebidos de Pedro',
      texto: 'Você recebeu 12 atividades e 3 negócios de Pedro.',
    });
  });

  it('R7.3 — avisa quem passou a responder ao destinatário e as distribuições fixas', () => {
    expect(
      notificacaoDeItensRecebidos(
        'Pedro',
        { ...NADA, contatos: 1, liderados: 2, responsavelFixo: 1 },
        ['Ana', 'Bia'],
      )?.texto,
    ).toBe(
      'Você recebeu 1 contato de Pedro. Você também assumiu, no lugar de Pedro, 1 distribuição automática ' +
        '(webhook de entrada ou passagem) com responsável fixo. Ana e Bia passaram a responder a você até a definição de um novo líder.',
    );
    expect(
      notificacaoDeItensRecebidos('Pedro', { ...NADA, liderados: 1 })?.texto,
    ).toBe(
      '1 liderado passou a responder a você até a definição de um novo líder.',
    );
  });

  it('sem nada recebido, não há notificação', () => {
    expect(notificacaoDeItensRecebidos('Pedro', NADA)).toBeNull();
  });

  it('R7.3 — alerta "equipe sem líder" para o Admin', () => {
    expect(
      alertaDeEquipeSemLider(
        { nome: 'Pedro', papel: 'LIDER_COMERCIAL', area: 'COMERCIAL' },
        'Carla',
        3,
      ),
    ).toEqual({
      titulo: 'Equipe sem líder: Comercial',
      texto:
        'Com o desligamento de Pedro (Líder Comercial), a equipe de Comercial ficou sem líder: 3 liderados passaram a responder a Carla até você definir um novo líder.',
    });
    expect(
      alertaDeEquipeSemLider(
        { nome: 'Léo', papel: 'LIDER_CS', area: 'CS' },
        'Carla',
        0,
      ).texto,
    ).toBe(
      'Com o desligamento de Léo (Líder CS), a equipe de Customer Success ficou sem líder. Defina um novo líder.',
    );
  });
});
