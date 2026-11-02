import { botoesDaMensagem } from './webchat.service';

describe('cenário 70 — botoesDaMensagem (chat do site, R18.10)', () => {
  it('devolve as opções do bot só nas mensagens da equipe', () => {
    const metadados = {
      botoes: [
        { id: 'a', rotulo: 'Comprar' },
        { id: 'b', rotulo: ' Suporte ' },
        { id: 'c' },
      ],
    };
    expect(botoesDaMensagem({ direcao: 'SAIDA', metadados })).toEqual([
      { id: 'a', rotulo: 'Comprar' },
      { id: 'b', rotulo: 'Suporte' },
    ]);
    expect(botoesDaMensagem({ direcao: 'ENTRADA', metadados })).toBeNull();
  });

  it('sem botões válidos devolve nulo', () => {
    expect(botoesDaMensagem({ direcao: 'SAIDA', metadados: null })).toBeNull();
    expect(
      botoesDaMensagem({ direcao: 'SAIDA', metadados: { botoes: [] } }),
    ).toBeNull();
    expect(
      botoesDaMensagem({ direcao: 'SAIDA', metadados: { botoes: 'x' } }),
    ).toBeNull();
  });
});
