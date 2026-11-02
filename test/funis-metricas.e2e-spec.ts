import { criarNegocioComHistorico } from './funis-apoio';
import {
  type AppTeste,
  criarAppTeste,
  criarEquipe,
  criarUsuario,
  entrarComo,
  funilBase,
} from './utils';

interface MetricaEtapa {
  etapa: { nome: string; prazoDias: number | null };
  negociosAtuais: number;
  valorAtual: string;
  parados: number | null;
  entradasNoPeriodo: number;
  saidasNoPeriodo: number;
  tempoMedioSegundos: number | null;
  tempoMedioDias: number | null;
}

interface Conversao {
  deEtapa: { nome: string };
  paraEtapa: { nome: string };
  alcancaramOrigem: number;
  alcancaramDestino: number;
  taxa: number | null;
}

const DIA = 86_400;

describe('Métricas base dos funis (e2e)', () => {
  let t: AppTeste;

  beforeAll(async () => {
    t = await criarAppTeste();
  });

  beforeEach(() => t.limparBanco());

  afterAll(() => t.fechar());

  it('R5.10 — contagem por etapa, conversão entre etapas, tempo médio por etapa, ciclo médio e parados', async () => {
    const { lider } = await criarEquipe(t, 'COMERCIAL', { membros: 0 });
    // Ganho: Novo (2 dias) → Qualificação (5 dias) → Ganho, criado há 10 dias.
    await criarNegocioComHistorico(
      t,
      'COMERCIAL',
      [
        { etapa: 'novo', diasAtras: 10 },
        { etapa: 'qualificacao', diasAtras: 8 },
        { etapa: 'ganho', diasAtras: 3 },
      ],
      { valor: '1000.00' },
    );
    // Parado em Qualificação (prazo de 5 dias) há 6 dias.
    await criarNegocioComHistorico(
      t,
      'COMERCIAL',
      [
        { etapa: 'novo', diasAtras: 9 },
        { etapa: 'qualificacao', diasAtras: 6 },
      ],
      { valor: '300.00' },
    );
    // Parado em Novo (prazo de 1 dia) há 2 dias.
    await criarNegocioComHistorico(t, 'COMERCIAL', [
      { etapa: 'novo', diasAtras: 2 },
    ]);
    // Perdido depois de 1 dia em Novo.
    await criarNegocioComHistorico(t, 'COMERCIAL', [
      { etapa: 'novo', diasAtras: 5 },
      { etapa: 'perdido', diasAtras: 4 },
    ]);
    // Criado fora do período (40 dias): conta no retrato de agora, não na coorte.
    await criarNegocioComHistorico(
      t,
      'COMERCIAL',
      [{ etapa: 'novo', diasAtras: 40 }],
      { valor: '50.00' },
    );
    const comercial = await funilBase(t, 'COMERCIAL');

    const resposta = await (
      await entrarComo(t, lider)
    )
      .get(`/api/v1/funis/${comercial.id}/metricas`)
      .expect(200);
    const metricas = resposta.body as {
      etapas: MetricaEtapa[];
      conversoes: Conversao[];
      coorte: Record<string, number | null>;
      cicloMedio: Record<string, number | null>;
      parados: number;
      periodo: { de: string; ate: string };
    };
    const etapa = (nome: string) =>
      metricas.etapas.find((linha) => linha.etapa.nome === nome);

    expect(
      new Date(metricas.periodo.ate).getTime() -
        new Date(metricas.periodo.de).getTime(),
    ).toBe(30 * DIA * 1000);
    expect(etapa('Novo')).toMatchObject({
      negociosAtuais: 2,
      valorAtual: '50.00',
      parados: 2,
      entradasNoPeriodo: 4,
      saidasNoPeriodo: 3,
      tempoMedioSegundos: 2 * DIA,
      tempoMedioDias: 2,
    });
    expect(etapa('Qualificação')).toMatchObject({
      negociosAtuais: 1,
      valorAtual: '300.00',
      parados: 1,
      entradasNoPeriodo: 2,
      saidasNoPeriodo: 1,
      tempoMedioSegundos: 5 * DIA,
    });
    expect(etapa('Ganho')).toMatchObject({
      negociosAtuais: 1,
      valorAtual: '1000.00',
      parados: null,
      entradasNoPeriodo: 1,
      tempoMedioSegundos: null,
    });
    expect(etapa('Perdido')).toMatchObject({
      negociosAtuais: 1,
      entradasNoPeriodo: 1,
    });

    expect(
      metricas.conversoes.map((linha) => [
        linha.deEtapa.nome,
        linha.paraEtapa.nome,
        linha.alcancaramOrigem,
        linha.alcancaramDestino,
        linha.taxa,
      ]),
    ).toEqual([
      ['Novo', 'Qualificação', 4, 2, 0.5],
      ['Qualificação', 'Apresentação', 2, 1, 0.5],
      ['Apresentação', 'Proposta', 1, 1, 1],
      ['Proposta', 'Negociação', 1, 1, 1],
      ['Negociação', 'Ganho', 1, 1, 1],
    ]);
    expect(metricas.coorte).toEqual({
      criados: 4,
      abertos: 2,
      ganhos: 1,
      perdidos: 1,
      taxaDeGanho: 0.25,
    });
    expect(metricas.cicloMedio).toEqual({
      negociosGanhos: 1,
      segundos: 7 * DIA,
      dias: 7,
    });
    expect(metricas.parados).toBe(3);
  });

  it('R5.10 — período escolhido, filtro por responsável e visibilidade do membro (R5.9)', async () => {
    const {
      lider,
      membros: [ana, bruno],
    } = await criarEquipe(t, 'COMERCIAL');
    await criarNegocioComHistorico(
      t,
      'COMERCIAL',
      [
        { etapa: 'novo', diasAtras: 3 },
        { etapa: 'ganho', diasAtras: 1 },
      ],
      { responsavel: ana },
    );
    await criarNegocioComHistorico(
      t,
      'COMERCIAL',
      [{ etapa: 'novo', diasAtras: 2 }],
      {
        responsavel: bruno,
      },
    );
    await criarNegocioComHistorico(
      t,
      'COMERCIAL',
      [{ etapa: 'novo', diasAtras: 20 }],
      {
        responsavel: ana,
      },
    );
    const comercial = await funilBase(t, 'COMERCIAL');
    const url = `/api/v1/funis/${comercial.id}/metricas`;

    const daAna = await (await entrarComo(t, ana)).get(url).expect(200);
    expect(daAna.body.coorte.criados).toBe(2);
    expect(daAna.body.cicloMedio).toMatchObject({
      negociosGanhos: 1,
      segundos: 2 * DIA,
    });

    const comoLider = await entrarComo(t, lider);
    expect((await comoLider.get(url).expect(200)).body.coorte.criados).toBe(3);
    expect(
      (await comoLider.get(`${url}?responsavelId=${bruno.id}`).expect(200)).body
        .coorte.criados,
    ).toBe(1);
    const ultimaSemana = new Date(Date.now() - 7 * DIA * 1000).toISOString();
    const recentes = await comoLider
      .get(`${url}?de=${encodeURIComponent(ultimaSemana)}`)
      .expect(200);
    expect(recentes.body.coorte.criados).toBe(2);

    const invertido = await comoLider
      .get(`${url}?de=2026-10-10T00:00:00Z&ate=2026-10-01T00:00:00Z`)
      .expect(400);
    expect(invertido.body.detalhes.campos[0].campo).toBe('de');
    await comoLider.get(`${url}?de=ontem`).expect(400);

    const admin = await entrarComo(t, await criarUsuario(t));
    const cs = await funilBase(t, 'CS');
    const vazio = await admin
      .get(`/api/v1/funis/${cs.id}/metricas`)
      .expect(200);
    expect(vazio.body.coorte).toMatchObject({ criados: 0, taxaDeGanho: null });
    expect(vazio.body.conversoes[0]).toMatchObject({
      alcancaramOrigem: 0,
      taxa: null,
    });
  });
});
