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
      expect(ehGestorFinanceiro(papel)).toBe(true);
      expect(podeGerenciarARegua(papel)).toBe(true);
      expect(filtroDeContratosVisiveis({ id: 'u', papel })).toEqual({});
      expect(filtroDeParcelasVisiveis({ id: 'u', papel })).toEqual({});
    }
  });

  it('R22.1 — o membro de CS atua só na própria carteira e não gerencia a régua', () => {
    expect(temAcessoAoFinanceiro('CS')).toBe(true);
    expect(podeAtuarNoFinanceiro('CS')).toBe(true);
    expect(podeGerenciarARegua('CS')).toBe(false);
    const f = filtroDeContratosVisiveis({ id: 'cs-1', papel: 'CS' });
    expect(JSON.stringify(f)).toContain('"responsavelCsId":"cs-1"');
  });

  it('R22.1 — o Comercial só consulta os contratos dos negócios que ganhou', () => {
    expect(temAcessoAoFinanceiro('COMERCIAL')).toBe(true);
    expect(podeAtuarNoFinanceiro('COMERCIAL')).toBe(false);
    expect(
      filtroDeContratosVisiveis({ id: 'c-1', papel: 'COMERCIAL' }),
    ).toEqual({
      negocio: { status: 'GANHO', responsavelId: 'c-1' },
    });
    expect(
      filtroDeContratosVisiveis({ id: 'l-1', papel: 'LIDER_COMERCIAL' }),
    ).toEqual({
      negocio: { status: 'GANHO', funil: { area: 'COMERCIAL' } },
    });
  });

  it('R22.1 — Marketing não acessa', () => {
    expect(temAcessoAoFinanceiro('MARKETING')).toBe(false);
    expect(temAcessoAoFinanceiro('LIDER_MARKETING')).toBe(false);
    expect(filtroDeContratosVisiveis({ id: 'm', papel: 'MARKETING' })).toEqual({
      id: { in: [] },
    });
  });
});
