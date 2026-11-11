import {
  PAPEIS_ANTIGOS,
  pessoa,
} from '../comum/dominio/papeis-antigos.apoio-spec';
import { paineisDoPapel, podeVerPainel } from './escopo-bi';

describe('Escopo do BI', () => {
  it('R20 — Admin e C-level veem todos os painéis', () => {
    for (const papel of ['ADMIN', 'C_LEVEL'] as const) {
      expect(paineisDoPapel(pessoa(papel))).toEqual([
        'marketing',
        'comercial',
        'cs',
        'atendimento',
        'sdr',
        'financeiro',
      ]);
    }
  });

  it('R20 — cada área vê o seu painel e o Atendimento, exceto o Marketing', () => {
    expect(paineisDoPapel(pessoa('MARKETING'))).toEqual(['marketing']);
    expect(paineisDoPapel(pessoa('LIDER_MARKETING'))).toEqual(['marketing']);
    expect(paineisDoPapel(pessoa('COMERCIAL'))).toEqual([
      'comercial',
      'atendimento',
      'sdr',
    ]);
    expect(paineisDoPapel(pessoa('LIDER_COMERCIAL'))).toEqual([
      'comercial',
      'atendimento',
      'sdr',
    ]);
    expect(paineisDoPapel(pessoa('CS'))).toEqual([
      'cs',
      'atendimento',
      'sdr',
      'financeiro',
    ]);
    expect(paineisDoPapel(pessoa('LIDER_CS'))).toEqual([
      'cs',
      'atendimento',
      'sdr',
      'financeiro',
    ]);
  });

  it('R20 — todo papel vê pelo menos um painel', () => {
    for (const papel of PAPEIS_ANTIGOS) {
      expect(
        podeVerPainel(pessoa(papel), 'comercial') ||
          paineisDoPapel(pessoa(papel)).length > 0,
      ).toBe(true);
    }
  });

  it('R20 — um setor criado vê o Atendimento e o SDR (pelo seu setor); os painéis de base, não', () => {
    expect(paineisDoPapel({ papel: 'LIDER', area: 'POS_VENDA' })).toEqual([
      'atendimento',
      'sdr',
    ]);
  });
});
