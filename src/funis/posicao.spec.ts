import { FOLGA_MINIMA_POSICAO, posicaoEntre } from './posicao';

describe('posição fracionária no kanban (R5.3)', () => {
  it('coluna vazia, topo e fim', () => {
    expect(posicaoEntre(null, null)).toBe(0);
    expect(posicaoEntre(null, 3)).toBe(2);
    expect(posicaoEntre(5, null)).toBe(6);
  });

  it('entre dois cartões, a média', () => {
    expect(posicaoEntre(1, 2)).toBe(1.5);
    expect(posicaoEntre(-3, 1)).toBe(-1);
  });

  it('sem folga entre os vizinhos, pede renumeração (null)', () => {
    expect(posicaoEntre(1, 1)).toBeNull();
    expect(posicaoEntre(2, 1)).toBeNull();
    expect(posicaoEntre(1, 1 + FOLGA_MINIMA_POSICAO / 2)).toBeNull();
  });

  it('aguenta dezenas de inserções seguidas no mesmo vão antes de pedir renumeração', () => {
    let anterior = 1;
    const posterior = 2;
    let insercoes = 0;
    for (;;) {
      const posicao = posicaoEntre(anterior, posterior);
      if (posicao === null) {
        break;
      }
      expect(posicao).toBeGreaterThan(anterior);
      expect(posicao).toBeLessThan(posterior);
      anterior = posicao;
      insercoes++;
    }
    expect(insercoes).toBeGreaterThanOrEqual(25);
  });
});
