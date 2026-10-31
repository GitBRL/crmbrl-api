import type { Papel } from '../generated/prisma/client';
import {
  areaDaNovaAutomacao,
  filtroDeAutomacoesVisiveis,
  marketingDaNovaAutomacao,
  podeGerenciarAutomacao,
  podeUsarAutomacoes,
} from './permissoes-automacoes';

const usuario = (papel: Papel) => ({ id: 'u1', papel });

describe('Permissões das automações (R19.1)', () => {
  it('R19.1 — Admin, C-level e líderes usam; membros não', () => {
    for (const papel of [
      'ADMIN',
      'C_LEVEL',
      'LIDER_COMERCIAL',
      'LIDER_MARKETING',
      'LIDER_CS',
    ] as Papel[]) {
      expect(podeUsarAutomacoes(usuario(papel))).toBe(true);
    }
    for (const papel of ['COMERCIAL', 'MARKETING', 'CS'] as Papel[]) {
      expect(podeUsarAutomacoes(usuario(papel))).toBe(false);
    }
  });

  it('R19.1 — diretoria gerencia todas; líder só as da própria área (não as sem área)', () => {
    expect(podeGerenciarAutomacao(usuario('C_LEVEL'), { area: null })).toBe(
      true,
    );
    expect(podeGerenciarAutomacao(usuario('LIDER_CS'), { area: 'CS' })).toBe(
      true,
    );
    expect(
      podeGerenciarAutomacao(usuario('LIDER_CS'), { area: 'COMERCIAL' }),
    ).toBe(false);
    expect(podeGerenciarAutomacao(usuario('LIDER_CS'), { area: null })).toBe(
      false,
    );
    expect(podeGerenciarAutomacao(usuario('CS'), { area: 'CS' })).toBe(false);
  });

  it('R19.1 — recorte da listagem e área da nova automação', () => {
    expect(filtroDeAutomacoesVisiveis(usuario('ADMIN'))).toEqual({});
    expect(filtroDeAutomacoesVisiveis(usuario('LIDER_MARKETING'))).toEqual({
      area: 'MARKETING',
    });
    expect(areaDaNovaAutomacao(usuario('LIDER_MARKETING'), 'CS')).toBe(
      'MARKETING',
    );
    expect(areaDaNovaAutomacao(usuario('C_LEVEL'), 'CS')).toBe('CS');
    expect(areaDaNovaAutomacao(usuario('C_LEVEL'), undefined)).toBeNull();
  });

  it('R4.6 — sem o campo marketing, a automação de uma área MARKETING nasce com marketing=true', () => {
    expect(marketingDaNovaAutomacao('MARKETING', undefined)).toBe(true);
    expect(marketingDaNovaAutomacao('MARKETING', null)).toBe(true);
    expect(marketingDaNovaAutomacao('COMERCIAL', undefined)).toBe(false);
    expect(marketingDaNovaAutomacao(null, undefined)).toBe(false);
    // O que veio no pedido vale sempre.
    expect(marketingDaNovaAutomacao('MARKETING', false)).toBe(false);
    expect(marketingDaNovaAutomacao('CS', true)).toBe(true);
  });
});
