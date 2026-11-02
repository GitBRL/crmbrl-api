import type { Papel } from '../generated/prisma/client';
import {
  areasVisiveis,
  filtroDeNegociosVisiveis,
  podeConfigurarFunis,
  podeConfigurarPassagens,
  podeConfigurarRodizio,
  podeReabrirNegocio,
  podeSerResponsavelNaArea,
  podeVerArea,
  podeVerNegocio,
} from './acesso-funis';

const quem = (papel: Papel) => ({ id: `id-${papel}`, papel });

describe('acesso aos funis (R5.1, R5.5, R5.9 e matriz da seção 12)', () => {
  it('R5.9 — Admin e C-level veem todas as áreas; os demais, só a sua', () => {
    expect(areasVisiveis(quem('ADMIN'))).toEqual([
      'MARKETING',
      'COMERCIAL',
      'CS',
    ]);
    expect(areasVisiveis(quem('C_LEVEL'))).toHaveLength(3);
    expect(areasVisiveis(quem('LIDER_COMERCIAL'))).toEqual(['COMERCIAL']);
    expect(areasVisiveis(quem('MARKETING'))).toEqual(['MARKETING']);
    expect(podeVerArea(quem('MARKETING'), 'COMERCIAL')).toBe(false);
    expect(podeVerArea(quem('CS'), 'CS')).toBe(true);
  });

  it('R5.1 — Admin e C-level configuram todos os funis; o líder, os da sua área; o membro, nenhum', () => {
    expect(podeConfigurarFunis(quem('ADMIN'), 'CS')).toBe(true);
    expect(podeConfigurarFunis(quem('C_LEVEL'), 'MARKETING')).toBe(true);
    expect(podeConfigurarFunis(quem('LIDER_CS'), 'CS')).toBe(true);
    expect(podeConfigurarFunis(quem('LIDER_CS'), 'COMERCIAL')).toBe(false);
    expect(podeConfigurarFunis(quem('COMERCIAL'), 'COMERCIAL')).toBe(false);
  });

  it('R5.5 — reabrir é do líder da área, do C-level e do Admin', () => {
    expect(podeReabrirNegocio(quem('ADMIN'), 'COMERCIAL')).toBe(true);
    expect(podeReabrirNegocio(quem('C_LEVEL'), 'COMERCIAL')).toBe(true);
    expect(podeReabrirNegocio(quem('LIDER_COMERCIAL'), 'COMERCIAL')).toBe(true);
    expect(podeReabrirNegocio(quem('LIDER_MARKETING'), 'COMERCIAL')).toBe(
      false,
    );
    expect(podeReabrirNegocio(quem('COMERCIAL'), 'COMERCIAL')).toBe(false);
  });

  it('matriz — passagens só Admin e C-level; rodízio também o líder da área', () => {
    expect(podeConfigurarPassagens(quem('ADMIN'))).toBe(true);
    expect(podeConfigurarPassagens(quem('C_LEVEL'))).toBe(true);
    expect(podeConfigurarPassagens(quem('LIDER_COMERCIAL'))).toBe(false);
    expect(podeConfigurarRodizio(quem('LIDER_COMERCIAL'), 'COMERCIAL')).toBe(
      true,
    );
    expect(podeConfigurarRodizio(quem('LIDER_COMERCIAL'), 'CS')).toBe(false);
    expect(podeConfigurarRodizio(quem('CS'), 'CS')).toBe(false);
  });

  it('R5.9 — filtro: diretoria sem restrição, líder pela área, membro pelos seus e os sem responsável', () => {
    expect(filtroDeNegociosVisiveis(quem('ADMIN'))).toEqual({});
    expect(filtroDeNegociosVisiveis(quem('C_LEVEL'))).toEqual({});
    expect(filtroDeNegociosVisiveis(quem('LIDER_CS'))).toEqual({
      funil: { area: 'CS' },
    });
    expect(filtroDeNegociosVisiveis(quem('COMERCIAL'))).toEqual({
      funil: { area: 'COMERCIAL' },
      OR: [{ responsavelId: 'id-COMERCIAL' }, { responsavelId: null }],
    });
  });

  it('R5.9 — podeVerNegocio segue a mesma regra do filtro', () => {
    const membro = quem('COMERCIAL');
    const doComercial = (responsavelId: string | null) => ({
      responsavelId,
      funil: { area: 'COMERCIAL' as const },
    });
    expect(podeVerNegocio(membro, doComercial(membro.id))).toBe(true);
    expect(podeVerNegocio(membro, doComercial(null))).toBe(true);
    expect(podeVerNegocio(membro, doComercial('outro'))).toBe(false);
    expect(
      podeVerNegocio(membro, {
        responsavelId: membro.id,
        funil: { area: 'MARKETING' },
      }),
    ).toBe(false);
    expect(podeVerNegocio(quem('LIDER_COMERCIAL'), doComercial('outro'))).toBe(
      true,
    );
    expect(podeVerNegocio(quem('LIDER_CS'), doComercial('outro'))).toBe(false);
    expect(podeVerNegocio(quem('C_LEVEL'), doComercial('outro'))).toBe(true);
  });

  it('responsável de um negócio: diretoria ou alguém da área do funil', () => {
    expect(podeSerResponsavelNaArea('ADMIN', 'CS')).toBe(true);
    expect(podeSerResponsavelNaArea('C_LEVEL', 'CS')).toBe(true);
    expect(podeSerResponsavelNaArea('LIDER_CS', 'CS')).toBe(true);
    expect(podeSerResponsavelNaArea('CS', 'CS')).toBe(true);
    expect(podeSerResponsavelNaArea('COMERCIAL', 'CS')).toBe(false);
  });
});
