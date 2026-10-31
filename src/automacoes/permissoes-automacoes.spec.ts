import type { Papel } from '../generated/prisma/client';
import {
  areaDaNovaAutomacao,
  filtroDeAutomacoesVisiveis,
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
});
