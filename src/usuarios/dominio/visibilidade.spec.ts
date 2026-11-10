import { papelESetor as comPapel } from '../../comum/dominio/papeis-antigos.apoio-spec';
import { filtroDeVisibilidade, podeVerUsuario } from './visibilidade';

describe('visibilidade de usuários (R1.5)', () => {
  const lider = { id: 'lider', ...comPapel('LIDER_COMERCIAL') };
  const membro = { id: 'membro', ...comPapel('COMERCIAL') };
  const liderado = { id: 'membro', liderId: 'lider' };
  const outro = { id: 'outro', liderId: 'outro-lider' };

  it('R1.5 — Admin e C-level veem todos', () => {
    for (const papel of ['ADMIN', 'C_LEVEL'] as const) {
      expect(podeVerUsuario({ id: 'x', papel }, outro)).toBe(true);
      expect(filtroDeVisibilidade({ id: 'x', papel })).toEqual({});
    }
  });

  it('R1.5 — o líder vê a si mesmo e a própria equipe', () => {
    expect(podeVerUsuario(lider, { id: 'lider', liderId: 'c' })).toBe(true);
    expect(podeVerUsuario(lider, liderado)).toBe(true);
    expect(podeVerUsuario(lider, outro)).toBe(false);
    expect(filtroDeVisibilidade(lider)).toEqual({
      OR: [{ id: 'lider' }, { liderId: 'lider' }],
    });
  });

  it('R1.5 — o membro vê só a si mesmo', () => {
    expect(podeVerUsuario(membro, liderado)).toBe(true);
    expect(podeVerUsuario(membro, { id: 'lider', liderId: 'c' })).toBe(false);
    expect(filtroDeVisibilidade(membro)).toEqual({ id: 'membro' });
  });
});
