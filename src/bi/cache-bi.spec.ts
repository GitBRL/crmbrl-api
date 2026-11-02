import { CacheBi } from './cache-bi';

describe('Cache do BI', () => {
  it('R20 — guarda por chave e vence só por tempo', () => {
    let agora = 1_000;
    const cache = new CacheBi<string>(30_000, 10, () => agora);
    cache.guardar('a', 'um');
    expect(cache.obter('a')).toBe('um');
    agora += 29_999;
    expect(cache.obter('a')).toBe('um');
    agora += 2;
    expect(cache.obter('a')).toBeUndefined();
    expect(cache.tamanho).toBe(0);
  });

  it('R20 — respeita o máximo, descartando as mais antigas', () => {
    const cache = new CacheBi<number>(60_000, 2);
    cache.guardar('a', 1);
    cache.guardar('b', 2);
    cache.guardar('c', 3);
    expect(cache.obter('a')).toBeUndefined();
    expect(cache.obter('b')).toBe(2);
    expect(cache.obter('c')).toBe(3);
  });
});
