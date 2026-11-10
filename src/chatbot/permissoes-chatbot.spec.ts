import { papelESetor as comPapel } from '../comum/dominio/papeis-antigos.apoio-spec';
import {
  areaDoNovoFluxo,
  filtroDeFluxosVisiveis,
  podeGerenciarFluxo,
  podeUsarChatbot,
} from './permissoes-chatbot';

describe('R18 — permissões do chatbot', () => {
  it('R18.6 — só Admin, C-level e líderes configuram; membros não', () => {
    expect(podeUsarChatbot({ ...comPapel('ADMIN') })).toBe(true);
    expect(podeUsarChatbot({ ...comPapel('C_LEVEL') })).toBe(true);
    expect(podeUsarChatbot({ ...comPapel('LIDER_COMERCIAL') })).toBe(true);
    expect(podeUsarChatbot({ ...comPapel('COMERCIAL') })).toBe(false);
    expect(podeUsarChatbot({ ...comPapel('CS') })).toBe(false);
  });

  it('R18.6 — líder vê os da área e os de todas as áreas, mas só edita os da própria área', () => {
    expect(filtroDeFluxosVisiveis({ ...comPapel('ADMIN') })).toEqual({});
    expect(filtroDeFluxosVisiveis({ ...comPapel('LIDER_COMERCIAL') })).toEqual(
      {},
    );
    expect(
      podeGerenciarFluxo(
        { ...comPapel('LIDER_COMERCIAL') },
        { area: 'COMERCIAL' },
      ),
    ).toBe(true);
    expect(
      podeGerenciarFluxo({ ...comPapel('LIDER_COMERCIAL') }, { area: null }),
    ).toBe(false);
    expect(
      podeGerenciarFluxo({ ...comPapel('LIDER_COMERCIAL') }, { area: 'CS' }),
    ).toBe(false);
    expect(podeGerenciarFluxo({ ...comPapel('C_LEVEL') }, { area: null })).toBe(
      true,
    );
  });

  it('R18.6 — área do fluxo novo: a do líder; a diretoria escolhe', () => {
    expect(areaDoNovoFluxo({ ...comPapel('LIDER_CS') }, 'COMERCIAL')).toBe(
      'CS',
    );
    expect(areaDoNovoFluxo({ ...comPapel('ADMIN') }, 'COMERCIAL')).toBe(
      'COMERCIAL',
    );
    expect(areaDoNovoFluxo({ ...comPapel('ADMIN') }, undefined)).toBeNull();
  });
});
