import { papelESetor as comPapel } from '../comum/dominio/papeis-antigos.apoio-spec';
import {
  CONFIGURACAO_PADRAO_DISPAROS,
  lerConfiguracaoDisparos,
} from './configuracao-disparos';
import {
  areaDaNovaCampanha,
  dispensaAprovacao,
  filtroDeCampanhasVisiveis,
  podeAprovarCampanha,
  podeVerCampanha,
} from './permissoes-disparos';

describe('R17 — configuração dos disparos', () => {
  it('sem linha, usa os padrões (sem aprovação; SAIR, PARAR, CANCELAR)', () => {
    expect(lerConfiguracaoDisparos(undefined)).toEqual(
      CONFIGURACAO_PADRAO_DISPAROS,
    );
    expect(lerConfiguracaoDisparos(undefined).palavrasDeSaida).toEqual([
      'SAIR',
      'PARAR',
      'CANCELAR',
    ]);
  });

  it('descarta lixo e completa o que falta', () => {
    const c = lerConfiguracaoDisparos({
      aprovacaoDoLider: true,
      palavrasDeSaida: [' pare ', '', 3, 'pare'],
      mensagemDeSaida: '  ',
    });
    expect(c.aprovacaoDoLider).toBe(true);
    expect(c.palavrasDeSaida).toEqual(['pare']);
    expect(c.mensagemDeSaida).toBe(
      CONFIGURACAO_PADRAO_DISPAROS.mensagemDeSaida,
    );
  });
});

describe('R17 — permissões dos disparos', () => {
  const membro = { id: 'm1', ...comPapel('MARKETING') };
  const lider = { id: 'l1', ...comPapel('LIDER_MARKETING') };
  const comercial = { id: 'c1', ...comPapel('COMERCIAL') };
  const admin = { id: 'a1', ...comPapel('ADMIN') };

  it('R17.1 — membro vê só as próprias; líder as da área; Admin todas', () => {
    expect(
      podeVerCampanha(membro, { area: 'MARKETING', criadoPorId: 'm1' }),
    ).toBe(true);
    expect(
      podeVerCampanha(membro, { area: 'MARKETING', criadoPorId: 'm2' }),
    ).toBe(false);
    expect(
      podeVerCampanha(lider, { area: 'MARKETING', criadoPorId: 'm2' }),
    ).toBe(true);
    expect(
      podeVerCampanha(lider, { area: 'COMERCIAL', criadoPorId: 'c1' }),
    ).toBe(false);
    expect(podeVerCampanha(admin, { area: 'CS', criadoPorId: null })).toBe(
      true,
    );
    expect(filtroDeCampanhasVisiveis(admin)).toEqual({});
    expect(filtroDeCampanhasVisiveis(membro)).toEqual({ criadoPorId: 'm1' });
    expect(filtroDeCampanhasVisiveis(lider)).toEqual({
      OR: [{ area: 'MARKETING' }, { criadoPorId: 'l1' }],
    });
  });

  it('R17.10 — quem aprova e quem dispensa a aprovação', () => {
    expect(
      podeAprovarCampanha(lider, { area: 'MARKETING', criadoPorId: 'm1' }),
    ).toBe(true);
    expect(
      podeAprovarCampanha(comercial, { area: 'COMERCIAL', criadoPorId: 'c1' }),
    ).toBe(false);
    expect(podeAprovarCampanha(admin, { area: null, criadoPorId: null })).toBe(
      true,
    );
    expect(dispensaAprovacao(membro)).toBe(false);
    expect(dispensaAprovacao(lider)).toBe(true);
    expect(dispensaAprovacao(admin)).toBe(true);
  });

  it('R17.1 — a área da campanha nova: a do usuário (membro/líder) ou a escolhida (diretoria)', () => {
    expect(areaDaNovaCampanha(membro, 'CS')).toBe('MARKETING');
    expect(areaDaNovaCampanha(admin, 'CS')).toBe('CS');
    expect(areaDaNovaCampanha(admin, undefined)).toBeNull();
  });
});
