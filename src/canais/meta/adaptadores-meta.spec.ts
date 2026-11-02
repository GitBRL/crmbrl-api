import { MOTIVO_JANELA_FECHADA, permissaoNaJanela } from './adaptadores-meta';

describe('janela de 24 h da Meta (R14)', () => {
  const agora = new Date('2026-10-23T12:00:00Z');

  it('dentro da janela, pode responder', () => {
    expect(
      permissaoNaJanela({ janelaAte: new Date('2026-10-23T12:00:01Z') }, agora),
    ).toEqual({
      pode: true,
    });
  });

  it('fora da janela (ou sem mensagem do contato), não pode, com o motivo', () => {
    for (const janelaAte of [new Date('2026-10-23T12:00:00Z'), null]) {
      expect(permissaoNaJanela({ janelaAte }, agora)).toEqual({
        pode: false,
        motivo: MOTIVO_JANELA_FECHADA,
      });
    }
  });
});
