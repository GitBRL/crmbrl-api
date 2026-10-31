import {
  areaDoNovoFluxo,
  filtroDeFluxosVisiveis,
  podeGerenciarFluxo,
  podeUsarChatbot,
} from './permissoes-chatbot';

describe('R18 — permissões do chatbot', () => {
  it('R18.6 — só Admin, C-level e líderes configuram; membros não', () => {
    expect(podeUsarChatbot({ papel: 'ADMIN' })).toBe(true);
    expect(podeUsarChatbot({ papel: 'C_LEVEL' })).toBe(true);
    expect(podeUsarChatbot({ papel: 'LIDER_COMERCIAL' })).toBe(true);
    expect(podeUsarChatbot({ papel: 'COMERCIAL' })).toBe(false);
    expect(podeUsarChatbot({ papel: 'CS' })).toBe(false);
  });

  it('R18.6 — líder vê os da área e os de todas as áreas, mas só edita os da própria área', () => {
    expect(filtroDeFluxosVisiveis({ papel: 'ADMIN' })).toEqual({});
    expect(filtroDeFluxosVisiveis({ papel: 'LIDER_COMERCIAL' })).toEqual({
      OR: [{ area: 'COMERCIAL' }, { area: null }],
    });
    expect(
      podeGerenciarFluxo({ papel: 'LIDER_COMERCIAL' }, { area: 'COMERCIAL' }),
    ).toBe(true);
    expect(
      podeGerenciarFluxo({ papel: 'LIDER_COMERCIAL' }, { area: null }),
    ).toBe(false);
    expect(
      podeGerenciarFluxo({ papel: 'LIDER_COMERCIAL' }, { area: 'CS' }),
    ).toBe(false);
    expect(podeGerenciarFluxo({ papel: 'C_LEVEL' }, { area: null })).toBe(true);
  });

  it('R18.6 — área do fluxo novo: a do líder; a diretoria escolhe', () => {
    expect(areaDoNovoFluxo({ papel: 'LIDER_CS' }, 'COMERCIAL')).toBe('CS');
    expect(areaDoNovoFluxo({ papel: 'ADMIN' }, 'COMERCIAL')).toBe('COMERCIAL');
    expect(areaDoNovoFluxo({ papel: 'ADMIN' }, undefined)).toBeNull();
  });
});
