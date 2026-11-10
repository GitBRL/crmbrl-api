import {
  type PapelDeTeste,
  pessoa,
} from '../comum/dominio/papeis-antigos.apoio-spec';
import {
  filtroDeFunisVisiveis,
  filtroDeNegociosVisiveis,
  podeConfigurarFunis,
  podeConfigurarPassagens,
  podeConfigurarRodizio,
  podeReabrirNegocio,
  podeSerResponsavelNaArea,
  podeVerArea,
  podeVerNegocio,
} from './acesso-funis';

const quem = (papel: PapelDeTeste) => pessoa(papel, { id: `id-${papel}` });

describe('acesso aos funis (R5.1, R5.5, R5.9 e matriz da seção 12)', () => {
  it('R5.9 — Admin e C-level veem todos os setores; os demais, só o seu', () => {
    expect(filtroDeFunisVisiveis(quem('ADMIN'))).toEqual({});
    expect(filtroDeFunisVisiveis(quem('C_LEVEL'))).toEqual({});
    expect(filtroDeFunisVisiveis(quem('LIDER_COMERCIAL'))).toEqual({
      area: 'COMERCIAL',
    });
    expect(filtroDeFunisVisiveis(quem('MARKETING'))).toEqual({
      area: 'MARKETING',
    });
    expect(podeVerArea(quem('MARKETING'), 'COMERCIAL')).toBe(false);
    expect(podeVerArea(quem('CS'), 'CS')).toBe(true);
    expect(podeVerArea(quem('C_LEVEL'), 'POS_VENDA')).toBe(true);
    expect(
      podeVerArea({ id: 'x', papel: 'MEMBRO', area: 'POS_VENDA' }, 'POS_VENDA'),
    ).toBe(true);
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
    expect(podeSerResponsavelNaArea(quem('ADMIN'), 'CS')).toBe(true);
    expect(podeSerResponsavelNaArea(quem('C_LEVEL'), 'CS')).toBe(true);
    expect(podeSerResponsavelNaArea(quem('LIDER_CS'), 'CS')).toBe(true);
    expect(podeSerResponsavelNaArea(quem('CS'), 'CS')).toBe(true);
    expect(podeSerResponsavelNaArea(quem('COMERCIAL'), 'CS')).toBe(false);
  });
});
