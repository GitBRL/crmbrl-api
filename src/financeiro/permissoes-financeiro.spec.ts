import { papelESetor as comPapel } from '../comum/dominio/papeis-antigos.apoio-spec';
import {
  ehGestorFinanceiro,
  filtroDeContratosVisiveis,
  filtroDeParcelasVisiveis,
  podeAtuarNoFinanceiro,
  podeGerenciarARegua,
  temAcessoAoFinanceiro,
} from './permissoes-financeiro';

describe('Financeiro — permissões (R22.1)', () => {
  it('R22.1 — Admin, C-level e Líder de CS gerenciam tudo', () => {
    for (const papel of ['ADMIN', 'C_LEVEL', 'LIDER_CS'] as const) {
      expect(ehGestorFinanceiro(comPapel(papel))).toBe(true);
      expect(podeGerenciarARegua(comPapel(papel))).toBe(true);
      expect(
        filtroDeContratosVisiveis({ id: 'u', ...comPapel(papel) }),
      ).toEqual({});
      expect(filtroDeParcelasVisiveis({ id: 'u', ...comPapel(papel) })).toEqual(
        {},
      );
    }
  });

  it('R22.1 — o membro de CS atua só na própria carteira e não gerencia a régua', () => {
    expect(temAcessoAoFinanceiro(comPapel('CS'))).toBe(true);
    expect(podeAtuarNoFinanceiro(comPapel('CS'))).toBe(true);
    expect(podeGerenciarARegua(comPapel('CS'))).toBe(false);
    const f = filtroDeContratosVisiveis({ id: 'cs-1', ...comPapel('CS') });
    expect(JSON.stringify(f)).toContain('"responsavelCsId":"cs-1"');
  });

  it('R22.1 — o Comercial só consulta os contratos dos negócios que ganhou', () => {
    expect(temAcessoAoFinanceiro(comPapel('COMERCIAL'))).toBe(true);
    expect(podeAtuarNoFinanceiro(comPapel('COMERCIAL'))).toBe(false);
    expect(
      filtroDeContratosVisiveis({ id: 'c-1', ...comPapel('COMERCIAL') }),
    ).toEqual({
      negocio: { status: 'GANHO', responsavelId: 'c-1' },
    });
    expect(
      filtroDeContratosVisiveis({ id: 'l-1', ...comPapel('LIDER_COMERCIAL') }),
    ).toEqual({
      negocio: { status: 'GANHO', funil: { area: 'COMERCIAL' } },
    });
  });

  it('R22.1 — Marketing não acessa', () => {
    expect(temAcessoAoFinanceiro(comPapel('MARKETING'))).toBe(false);
    expect(temAcessoAoFinanceiro(comPapel('LIDER_MARKETING'))).toBe(false);
    expect(
      filtroDeContratosVisiveis({ id: 'm', ...comPapel('MARKETING') }),
    ).toEqual({
      id: { in: [] },
    });
  });

  it('R22.1 — setor criado não entra no Financeiro (preso a CS e Comercial)', () => {
    expect(temAcessoAoFinanceiro({ papel: 'LIDER', area: 'POS_VENDA' })).toBe(
      false,
    );
  });
});
