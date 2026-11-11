import {
  type PapelDeTeste,
  pessoa,
} from '../comum/dominio/papeis-antigos.apoio-spec';
import {
  filtroDeConversasVisiveis,
  podeUsarAtendimento,
  podeVerConversa,
  setorUsaAtendimento,
} from './visibilidade';

const usuario = (papel: PapelDeTeste, id = 'eu') => pessoa(papel, { id });

describe('visibilidade do Atendimento (R12)', () => {
  const daFilaComercial = (responsavelId: string | null = null) => ({
    responsavelId,
    fila: { area: 'COMERCIAL' as const },
  });

  it('Admin e C-level veem todas, inclusive sem fila e sem responsável', () => {
    for (const papel of ['ADMIN', 'C_LEVEL'] as const) {
      expect(
        podeVerConversa(usuario(papel), { responsavelId: null, fila: null }),
      ).toBe(true);
      expect(podeVerConversa(usuario(papel), daFilaComercial('outro'))).toBe(
        true,
      );
      expect(filtroDeConversasVisiveis(usuario(papel))).toEqual({});
    }
  });

  it('Marketing não acessa o Atendimento, nem as conversas que estiverem com ele', () => {
    for (const papel of ['MARKETING', 'LIDER_MARKETING'] as const) {
      expect(podeUsarAtendimento(usuario(papel))).toBe(false);
      expect(podeVerConversa(usuario(papel), daFilaComercial('eu'))).toBe(
        false,
      );
      expect(filtroDeConversasVisiveis(usuario(papel))).toBeNull();
    }
  });

  it('líder vê as filas da sua área (com ou sem responsável) e as que estão com ele', () => {
    const lider = usuario('LIDER_COMERCIAL');
    expect(podeVerConversa(lider, daFilaComercial('outro'))).toBe(true);
    expect(podeVerConversa(lider, daFilaComercial(null))).toBe(true);
    expect(
      podeVerConversa(lider, { responsavelId: 'outro', fila: { area: 'CS' } }),
    ).toBe(false);
    expect(
      podeVerConversa(lider, { responsavelId: 'eu', fila: { area: 'CS' } }),
    ).toBe(true);
    expect(filtroDeConversasVisiveis(lider)).toEqual({
      OR: [{ responsavelId: 'eu' }, { fila: { area: 'COMERCIAL' } }],
    });
  });

  it('membro vê as suas e as sem responsável das filas da sua área', () => {
    const membro = usuario('CS');
    const daFilaCs = (responsavelId: string | null) => ({
      responsavelId,
      fila: { area: 'CS' as const },
    });
    expect(podeVerConversa(membro, daFilaCs(null))).toBe(true);
    expect(podeVerConversa(membro, daFilaCs('eu'))).toBe(true);
    expect(podeVerConversa(membro, daFilaCs('colega'))).toBe(false);
    expect(podeVerConversa(membro, daFilaComercial(null))).toBe(false);
    expect(podeVerConversa(membro, { responsavelId: null, fila: null })).toBe(
      false,
    );
    expect(filtroDeConversasVisiveis(membro)).toEqual({
      OR: [
        { responsavelId: 'eu' },
        { responsavelId: null, fila: { area: 'CS' } },
      ],
    });
  });

  it('setores criados usam o Atendimento como Comercial e CS (só o Marketing fica de fora)', () => {
    expect(setorUsaAtendimento('POS_VENDA')).toBe(true);
    expect(setorUsaAtendimento('MARKETING')).toBe(false);
    const membro = { id: 'eu', papel: 'MEMBRO' as const, area: 'POS_VENDA' };
    expect(podeUsarAtendimento(membro)).toBe(true);
    expect(
      podeVerConversa(membro, {
        responsavelId: null,
        fila: { area: 'POS_VENDA' },
      }),
    ).toBe(true);
    expect(
      podeVerConversa(membro, { responsavelId: null, fila: { area: 'CS' } }),
    ).toBe(false);
  });
});
