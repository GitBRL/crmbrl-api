import { lerAvaliacao, pesquisaValida } from './satisfacao';

describe('pesquisa de satisfação (R12)', () => {
  it.each([
    ['5', 5, null],
    ['  4  ', 4, null],
    ['5!', 5, null],
    ['4/5', 4, null],
    ['nota 3', 3, null],
    ['Minha nota: 2', 2, null],
    ['5 estrelas', 5, null],
    ['2 - demorou bastante', 2, 'demorou bastante'],
    ['3, mas podia ser melhor', 3, 'mas podia ser melhor'],
    ['cinco', 5, null],
    ['Três.', 3, null],
    ['⭐⭐⭐⭐', 4, null],
    ['⭐️ ⭐️ ⭐️', 3, null],
  ])('"%s" é nota %i', (texto, nota, comentario) => {
    expect(lerAvaliacao(texto)).toEqual({ nota, comentario });
  });

  it.each([
    'obrigado!',
    '5 minutos de espera',
    '0',
    '6',
    '10',
    '',
    null,
    'quero falar com alguém',
    '⭐⭐⭐⭐⭐⭐',
  ])('"%s" não é nota', (texto) => {
    expect(lerAvaliacao(texto)).toBeNull();
  });

  it('corta o comentário em 1000 caracteres', () => {
    const avaliacao = lerAvaliacao(`4 - ${'a'.repeat(1010)}`);
    expect(avaliacao?.comentario).toHaveLength(1000);
  });

  it('vale por 24 horas, uma vez', () => {
    const pedida = new Date('2026-10-23T12:00:00Z');
    expect(pesquisaValida(pedida, null, new Date('2026-10-24T11:59:00Z'))).toBe(
      true,
    );
    expect(pesquisaValida(pedida, null, new Date('2026-10-24T12:01:00Z'))).toBe(
      false,
    );
    expect(pesquisaValida(pedida, new Date(), new Date())).toBe(false);
    expect(pesquisaValida(null, null)).toBe(false);
  });
});
