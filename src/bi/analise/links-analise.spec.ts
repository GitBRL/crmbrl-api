import type { ClasseDeId } from './entrada-analise';
import { conferirLink, descreverRotas } from './links-analise';

const ETAPA = '11111111-1111-4111-8111-111111111111';
const CANAL = '22222222-2222-4222-8222-222222222222';
const USUARIO = '33333333-3333-4333-8333-333333333333';
const CAMPANHA = '44444444-4444-4444-8444-444444444444';
const DESCONHECIDO = '55555555-5555-4555-8555-555555555555';

const ids = new Map<string, ClasseDeId>([
  [ETAPA, 'etapa'],
  [CANAL, 'canal'],
  [USUARIO, 'usuario'],
  [CAMPANHA, 'campanha'],
]);

describe('links das ações da análise por IA (R21)', () => {
  it('R21 — aceita rota conhecida com parâmetro do tipo certo e id da entrada', () => {
    expect(
      conferirLink(
        `/funis/comercial?etapaId=${ETAPA}`,
        'Ver etapa',
        ids,
        'comercial',
      ),
    ).toEqual({
      caminho: '/funis/comercial',
      parametros: { etapaId: ETAPA },
      rotulo: 'Ver etapa',
      ajustado: false,
    });
    expect(
      conferirLink(`/atendimento?canalId=${CANAL}`, 'x', ids, 'atendimento')
        .parametros,
    ).toEqual({ canalId: CANAL });
    expect(
      conferirLink(
        `/contatos?responsavel=${USUARIO}&marketing=optout&uf=SP`,
        'x',
        ids,
        'cs',
      ).parametros,
    ).toEqual({ responsavel: USUARIO, marketing: 'optout', uf: 'SP' });
    expect(
      conferirLink(`/disparos/${CAMPANHA}`, 'x', ids, 'marketing'),
    ).toMatchObject({
      caminho: `/disparos/${CAMPANHA}`,
      ajustado: false,
    });
    expect(
      conferirLink('/financeiro/regua/ligacoes', 'x', ids, 'financeiro')
        .caminho,
    ).toBe('/financeiro/regua/ligacoes');
  });

  it('R21 — retira id desconhecido, id de outra classe e parâmetro fora da lista', () => {
    const link = conferirLink(
      `/funis/comercial?etapaId=${DESCONHECIDO}&funil=${ETAPA}&ordem=valor`,
      'x',
      ids,
      'comercial',
    );
    expect(link).toEqual({
      caminho: '/funis/comercial',
      parametros: {},
      rotulo: 'x',
      ajustado: true,
    });
    expect(
      conferirLink(`/atendimento?canalId=${ETAPA}`, 'x', ids, 'atendimento')
        .parametros,
    ).toEqual({});
  });

  it('R21 — rota desconhecida, endereço externo ou id desconhecido no caminho viram o painel', () => {
    for (const link of [
      '/administracao/usuarios',
      'https://exemplo.com/funis/comercial',
      '//exemplo.com/bi/cs',
      'javascript:alert(1)',
      '/funis/financeiro',
      `/disparos/${DESCONHECIDO}`,
      '/funis/comercial/%E0%A4%A',
      '',
    ]) {
      expect(conferirLink(link, 'x', ids, 'cs')).toEqual({
        caminho: '/bi/cs',
        parametros: {},
        rotulo: 'Ver o painel',
        ajustado: true,
      });
    }
  });

  it('R21 — a descrição das rotas (prompt de sistema) é fixa', () => {
    expect(descreverRotas()).toBe(descreverRotas());
    expect(descreverRotas()).toContain('/funis/:area');
  });
});
