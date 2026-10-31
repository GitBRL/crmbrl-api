import type { PainelCalculado, TabelaBi } from '../bi.tipos';
import { idsDaEntrada, montarEntrada } from './entrada-analise';

const ETAPA = '11111111-1111-4111-8111-111111111111';
const CONTATO = '99999999-9999-4999-8999-999999999999';
const NEGOCIO = '88888888-8888-4888-8888-888888888888';
const FUNIL = '77777777-7777-4777-8777-777777777777';

function tabela(
  chave: string,
  colunas: [string, string][],
  linhas: TabelaBi['linhas'],
): TabelaBi {
  return {
    chave,
    titulo: chave,
    dica: `dica de ${chave}`,
    colunas: colunas.map(([c, tipo]) => ({
      chave: c,
      rotulo: c,
      tipo: tipo as TabelaBi['colunas'][number]['tipo'],
      visivel: tipo !== 'id',
    })),
    linhas,
  };
}

function painel(): PainelCalculado {
  return {
    painel: 'cs',
    periodo: {
      de: '2026-10-01T00:00:00.000Z',
      ate: '2026-10-31T00:00:00.000Z',
    },
    anterior: {
      de: '2026-09-01T00:00:00.000Z',
      ate: '2026-10-01T00:00:00.000Z',
    },
    geradoEm: '2026-10-31T00:00:00.000Z',
    filtros: {
      area: 'CS',
      equipeId: null,
      pessoaId: null,
      funilId: FUNIL,
      canalId: null,
      filaId: null,
      comparar: true,
    },
    cartoes: [
      {
        chave: 'renovados',
        rotulo: 'Renovados',
        valor: 4,
        anterior: 2,
        variacao: 100,
        unidade: 'numero',
        melhorQuando: 'maior',
        dica: 'Negócios renovados.',
      },
    ],
    tabelas: {
      onboardingPorEtapa: tabela(
        'onboardingPorEtapa',
        [
          ['etapaId', 'id'],
          ['etapa', 'texto'],
          ['quantidade', 'numero'],
        ],
        [{ etapaId: ETAPA, etapa: 'Boas-vindas', quantidade: 3 }],
      ),
      riscoDeChurn: tabela(
        'riscoDeChurn',
        [
          ['contatoId', 'id'],
          ['contato', 'texto'],
          ['pontuacao', 'numero'],
          ['nivel', 'texto'],
          ['motivos', 'texto'],
        ],
        [
          {
            contatoId: CONTATO,
            contato: 'Maria Sigilosa',
            pontuacao: 80,
            nivel: 'Alto',
            motivos: 'Título atrasado',
          },
          {
            contatoId: CONTATO,
            contato: 'João Sigiloso',
            pontuacao: 60,
            nivel: 'Alto',
            motivos: 'Nota 2',
          },
          {
            contatoId: CONTATO,
            contato: 'Ana Sigilosa',
            pontuacao: 40,
            nivel: 'Médio',
            motivos: 'x',
          },
        ],
      ),
      proximasRenovacoes: tabela(
        'proximasRenovacoes',
        [
          ['negocioId', 'id'],
          ['titulo', 'texto'],
          ['contato', 'texto'],
          ['responsavel', 'texto'],
          ['etapa', 'texto'],
          ['valorRecorrente', 'moeda'],
        ],
        [
          {
            negocioId: NEGOCIO,
            titulo: 'Renovação ACME Sigilosa',
            contato: 'Maria Sigilosa',
            responsavel: 'Carla CS',
            etapa: 'Renovação',
            valorRecorrente: 1000,
          },
          {
            negocioId: NEGOCIO,
            titulo: 'Renovação Beta',
            contato: 'João Sigiloso',
            responsavel: 'Carla CS',
            etapa: 'Renovação',
            valorRecorrente: 500.5,
          },
        ],
      ),
      outraNominal: tabela(
        'outraNominal',
        [
          ['contato', 'texto'],
          ['valor', 'moeda'],
        ],
        [{ contato: 'Pedro Sigiloso', valor: 1 }],
      ),
      comIdSolto: tabela(
        'comIdSolto',
        [
          ['coisaId', 'id'],
          ['quantidade', 'numero'],
        ],
        [{ coisaId: 'abc', quantidade: 2 }],
      ),
    },
    meta: {
      funil: { id: FUNIL, nome: 'CS' },
      etapasDeOnboarding: ['boas_vindas'],
    },
  };
}

describe('entrada da análise por IA (R21)', () => {
  it('R21 — nada de dados pessoais de contatos: tabelas nominais viram contagens', () => {
    const { entrada } = montarEntrada(painel());
    const json = JSON.stringify(entrada);
    for (const proibido of [
      'Sigilos',
      CONTATO,
      NEGOCIO,
      'Renovação ACME',
      'Título atrasado',
    ]) {
      expect(json).not.toContain(proibido);
    }
    const chaves = entrada.tabelas.map((t) => t.chave);
    expect(chaves).toEqual([
      'onboardingPorEtapa',
      'riscoDeChurnPorNivel',
      'proximasRenovacoesPorEtapa',
      'comIdSolto',
    ]);
    const risco = entrada.tabelas[1];
    expect(risco.linhas).toEqual([
      ['Alto', 2, 70],
      ['Médio', 1, 40],
    ]);
    expect(entrada.tabelas[2].linhas).toEqual([
      ['Renovação', 'Carla CS', 2, 1500.5],
    ]);
    // Coluna de id sem uso em link sai; a tabela fica com o resto.
    expect(entrada.tabelas[3].colunas).toEqual(['quantidade:numero']);
  });

  it('R21 — indicadores, período, filtros e ids conhecidos para os links', () => {
    const { entrada, idsConhecidos } = montarEntrada(painel());
    expect(entrada.indicadores[0]).toMatchObject({
      chave: 'renovados',
      valor: 4,
      anterior: 2,
      variacao: 100,
    });
    expect(entrada.periodoAnterior).not.toBeNull();
    expect(entrada.contexto).toEqual({
      funil: { id: FUNIL, nome: 'CS' },
      etapasDeOnboarding: ['boas_vindas'],
    });
    expect([...idsConhecidos]).toEqual(
      expect.arrayContaining([
        [ETAPA, 'etapa'],
        [FUNIL, 'funil'],
      ]),
    );
    expect(idsConhecidos.has(CONTATO)).toBe(false);
    // Os mesmos ids saem da entrada gravada (perguntas de acompanhamento).
    expect(idsDaEntrada(JSON.parse(JSON.stringify(entrada)))).toEqual(
      idsConhecidos,
    );
  });
});
