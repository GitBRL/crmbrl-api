import { TODOS_OS_PAPEIS } from '../comum/dominio/papeis';
import { paineisDoPapel, podeVerPainel } from './escopo-bi';

describe('Escopo do BI', () => {
  it('R20 — Admin e C-level veem todos os painéis', () => {
    for (const papel of ['ADMIN', 'C_LEVEL'] as const) {
      expect(paineisDoPapel(papel)).toEqual([
        'marketing',
        'comercial',
        'cs',
        'atendimento',
        'financeiro',
      ]);
    }
  });

  it('R20 — cada área vê o seu painel e o Atendimento, exceto o Marketing', () => {
    expect(paineisDoPapel('MARKETING')).toEqual(['marketing']);
    expect(paineisDoPapel('LIDER_MARKETING')).toEqual(['marketing']);
    expect(paineisDoPapel('COMERCIAL')).toEqual(['comercial', 'atendimento']);
    expect(paineisDoPapel('LIDER_COMERCIAL')).toEqual([
      'comercial',
      'atendimento',
    ]);
    expect(paineisDoPapel('CS')).toEqual(['cs', 'atendimento', 'financeiro']);
    expect(paineisDoPapel('LIDER_CS')).toEqual([
      'cs',
      'atendimento',
      'financeiro',
    ]);
  });

  it('R20 — todo papel vê pelo menos um painel', () => {
    for (const papel of TODOS_OS_PAPEIS) {
      expect(
        podeVerPainel(papel, 'comercial') || paineisDoPapel(papel).length > 0,
      ).toBe(true);
    }
  });
});
