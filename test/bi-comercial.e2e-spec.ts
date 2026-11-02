import {
  cartao,
  consultarPainel,
  criarNegocioBi,
  definirProbabilidades,
  linhasDa,
  periodoDeTeste,
  quando,
} from './bi-apoio';
import {
  type AppTeste,
  criarAppTeste,
  criarAtividade,
  criarEquipe,
  criarUsuario,
  entrarComo,
  funilBase,
} from './utils';

describe('BI — painel Comercial (e2e)', () => {
  let t: AppTeste;

  beforeAll(async () => {
    t = await criarAppTeste();
  });
  beforeEach(() => t.limparBanco());
  afterAll(() => t.fechar());

  async function montar() {
    const { cLevel, lider, membros } = await criarEquipe(t, 'COMERCIAL', {
      membros: 2,
    });
    const [v1, v2] = membros;
    await definirProbabilidades(t, 'COMERCIAL', {
      qualificacao: 20,
      proposta: 60,
    });
    const negocio = (dados: Parameters<typeof criarNegocioBi>[1]) =>
      criarNegocioBi(t, dados);
    // Abertos.
    await negocio({
      area: 'COMERCIAL',
      etapa: 'qualificacao',
      responsavel: v1,
      valor: '1000.00',
      criadoEm: quando(3),
    });
    await negocio({
      area: 'COMERCIAL',
      etapa: 'proposta',
      responsavel: v1,
      valor: '2000.00',
      criadoEm: quando(15),
    });
    await negocio({
      area: 'COMERCIAL',
      etapa: 'novo',
      responsavel: null,
      valor: '50.00',
      criadoEm: quando(1),
    });
    // Ganhos no período: ciclos de 6 e de 2 dias.
    await negocio({
      area: 'COMERCIAL',
      etapa: 'ganho',
      responsavel: v1,
      valor: '5000.00',
      criadoEm: quando(8),
      fechadoEm: quando(2),
    });
    await negocio({
      area: 'COMERCIAL',
      etapa: 'ganho',
      responsavel: v2,
      valor: '3000.00',
      criadoEm: quando(6),
      fechadoEm: quando(4),
    });
    // Perdidos no período.
    await negocio({
      area: 'COMERCIAL',
      etapa: 'perdido',
      responsavel: v2,
      valor: '700.00',
      motivoPerda: 'Preço',
      criadoEm: quando(9),
      fechadoEm: quando(3),
    });
    await negocio({
      area: 'COMERCIAL',
      etapa: 'perdido',
      responsavel: v1,
      valor: '300.00',
      motivoPerda: 'Preço',
      criadoEm: quando(7),
      fechadoEm: quando(5),
    });
    await negocio({
      area: 'COMERCIAL',
      etapa: 'perdido',
      responsavel: v1,
      valor: '100.00',
      motivoPerda: 'Concorrente',
      criadoEm: quando(7),
      fechadoEm: quando(6),
    });
    // Período anterior: 1 ganho e 1 perdido.
    await negocio({
      area: 'COMERCIAL',
      etapa: 'ganho',
      responsavel: v1,
      valor: '1000.00',
      criadoEm: quando(18),
      fechadoEm: quando(14),
    });
    await negocio({
      area: 'COMERCIAL',
      etapa: 'perdido',
      responsavel: v1,
      valor: '10.00',
      criadoEm: quando(18),
      fechadoEm: quando(14),
    });
    // Ruído: negócio de CS e de Marketing.
    await negocio({
      area: 'CS',
      etapa: 'onboarding',
      valor: '999.00',
      criadoEm: quando(2),
    });
    // Atividades: v1 fez 2 (e uma nota), tem 1 atrasada e 1 futura; v2 fez 1 e tem 1 atrasada.
    const feita = async (
      responsavel: typeof v1,
      dias: number,
      tipo: 'TAREFA' | 'NOTA' = 'TAREFA',
    ) => {
      const a = await criarAtividade(t, {
        responsavel,
        tipo,
        status: 'CONCLUIDA',
      });
      await t.prisma.atividade.update({
        where: { id: a.id },
        data: { concluidaEm: quando(dias) },
      });
    };
    await feita(v1, 3);
    await feita(v1, 4);
    await feita(v1, 4, 'NOTA');
    await feita(v2, 2);
    await feita(v2, 15); // anterior
    await criarAtividade(t, {
      responsavel: v1,
      venceEm: new Date(Date.now() - 86_400_000),
    });
    await criarAtividade(t, {
      responsavel: v1,
      venceEm: new Date(Date.now() + 86_400_000),
    });
    await criarAtividade(t, {
      responsavel: v2,
      venceEm: new Date(Date.now() - 2 * 86_400_000),
    });
    return { cLevel, lider, v1, v2 };
  }

  it('cenário 75 — R20 — ganhos, perdidos, taxa de ganho, ciclo médio e valor ganho, com comparação', async () => {
    const { lider } = await montar();
    const painel = await consultarPainel(
      await entrarComo(t, lider),
      'comercial',
    );
    expect(cartao(painel, 'ganhos')).toMatchObject({
      valor: 2,
      anterior: 1,
      variacao: 100,
    });
    expect(cartao(painel, 'valorGanho')).toMatchObject({
      valor: 8000,
      anterior: 1000,
      variacao: 700,
    });
    expect(cartao(painel, 'perdidos')).toMatchObject({ valor: 3, anterior: 1 });
    expect(cartao(painel, 'taxaGanho')).toMatchObject({
      valor: 40,
      anterior: 50,
      variacao: -20,
    });
    // Ciclos de 6 e 2 dias: média de 4 dias.
    expect(cartao(painel, 'cicloMedio').valor).toBe(4);
    // Consulta direta.
    const { de, ate } = periodoDeTeste();
    const ganhosDireto = await t.prisma.negocio.aggregate({
      where: {
        status: 'GANHO',
        funil: { area: 'COMERCIAL' },
        ganhoEm: { gte: new Date(de), lt: new Date(ate) },
      },
      _count: true,
      _sum: { valor: true },
    });
    expect(ganhosDireto._count).toBe(2);
    expect(Number(ganhosDireto._sum.valor)).toBe(8000);
    expect(cartao(painel, 'novos').valor).toBe(7); // o de 15 dias, os do período anterior e o ruído de CS não entram
  });

  it('R20 — abertos, valor em aberto e valor ponderado (valor × probabilidade da etapa)', async () => {
    const { lider } = await montar();
    const painel = await consultarPainel(
      await entrarComo(t, lider),
      'comercial',
    );
    expect(cartao(painel, 'abertos')).toMatchObject({
      valor: 3,
      anterior: null,
      variacao: null,
    });
    expect(cartao(painel, 'valorAberto').valor).toBe(3050);
    // 1000 × 20% + 2000 × 60% + 50 × 0% (etapa sem probabilidade) = 1400.
    expect(cartao(painel, 'valorPonderado').valor).toBe(1400);
  });

  it('R20 — funil por etapa, motivos de perda e ranking por vendedor', async () => {
    const { lider, v1, v2 } = await montar();
    const painel = await consultarPainel(
      await entrarComo(t, lider),
      'comercial',
    );
    const funil = linhasDa(painel, 'funil');
    const etapa = (nome: string) => funil.find((l) => l.etapa === nome);
    expect(etapa('Qualificação')).toMatchObject({
      quantidade: 1,
      valor: 1000,
      valorPonderado: 200,
    });
    expect(etapa('Proposta')).toMatchObject({
      quantidade: 1,
      valor: 2000,
      valorPonderado: 1200,
    });
    expect(etapa('Novo')).toMatchObject({
      quantidade: 1,
      valor: 50,
      valorPonderado: 0,
    });
    expect(etapa('Ganho')).toMatchObject({
      quantidade: 3,
      valor: 9000,
      valorPonderado: 0,
    });
    expect((painel.meta.funil as { nome: string }).nome).toBe(
      (await funilBase(t, 'COMERCIAL')).nome,
    );

    expect(linhasDa(painel, 'motivosDePerda')).toEqual([
      { motivo: 'Preço', perdidos: 2, valor: 1000 },
      { motivo: 'Concorrente', perdidos: 1, valor: 100 },
    ]);

    const ranking = linhasDa(painel, 'ranking');
    const doV1 = ranking.find((l) => l.usuarioId === v1.id);
    const doV2 = ranking.find((l) => l.usuarioId === v2.id);
    expect(doV1).toMatchObject({
      abertos: 2,
      valorAberto: 3000,
      ganhos: 1,
      valorGanho: 5000,
      perdidos: 2,
      taxaGanho: 33.33,
      atividadesFeitas: 2,
      atividadesAtrasadas: 1,
    });
    expect(doV2).toMatchObject({
      abertos: 0,
      ganhos: 1,
      valorGanho: 3000,
      perdidos: 1,
      taxaGanho: 50,
      atividadesFeitas: 1,
      atividadesAtrasadas: 1,
    });
    // Ordenado pelo valor ganho; o sem responsável vem com o nome padrão.
    expect(ranking.map((l) => l.usuarioId).slice(0, 2)).toEqual([v1.id, v2.id]);
    expect(ranking.find((l) => l.usuarioId === null)).toMatchObject({
      nome: 'Sem responsável',
      abertos: 1,
    });
  });

  it('R20 — atividades feitas (sem notas) e atrasadas', async () => {
    const { lider } = await montar();
    const painel = await consultarPainel(
      await entrarComo(t, lider),
      'comercial',
    );
    expect(cartao(painel, 'atividadesFeitas')).toMatchObject({
      valor: 3,
      anterior: 1,
    });
    expect(cartao(painel, 'atividadesAtrasadas')).toMatchObject({
      valor: 2,
      anterior: null,
    });
  });

  it('cenário 72 — R1, R20 — o vendedor vê só os números dos negócios e atividades dele (e os sem responsável)', async () => {
    const { v1, v2 } = await montar();
    const doV1 = await consultarPainel(await entrarComo(t, v1), 'comercial');
    const doV2 = await consultarPainel(await entrarComo(t, v2), 'comercial');
    // v1: 1 ganho (5000), 2 perdidos; abertos: os 2 dele + o sem responsável.
    expect(cartao(doV1, 'ganhos').valor).toBe(1);
    expect(cartao(doV1, 'valorGanho').valor).toBe(5000);
    expect(cartao(doV1, 'perdidos').valor).toBe(2);
    expect(cartao(doV1, 'abertos').valor).toBe(3);
    expect(cartao(doV1, 'atividadesFeitas').valor).toBe(2);
    expect(cartao(doV1, 'atividadesAtrasadas').valor).toBe(1);
    // v2: 1 ganho (3000), 1 perdido; só o sem responsável aberto.
    expect(cartao(doV2, 'valorGanho').valor).toBe(3000);
    expect(cartao(doV2, 'perdidos').valor).toBe(1);
    expect(cartao(doV2, 'abertos').valor).toBe(1);
    expect(cartao(doV2, 'atividadesFeitas').valor).toBe(1);
    // O ranking do vendedor não mostra o colega.
    expect(linhasDa(doV2, 'ranking').some((l) => l.usuarioId === v1.id)).toBe(
      false,
    );
    // Igual à lista de negócios.
    const lista = await (
      await entrarComo(t, v2)
    )
      .get('/api/v1/negocios')
      .query({ status: 'PERDIDO', porPagina: 100 })
      .expect(200);
    expect(lista.body.total).toBe(1);
  });

  it('R20 — filtros de pessoa e de equipe; funil de outra área é 404', async () => {
    const { lider, v1 } = await montar();
    const cliente = await entrarComo(t, lider);
    const dele = await consultarPainel(cliente, 'comercial', {
      pessoaId: v1.id,
    });
    expect(cartao(dele, 'ganhos').valor).toBe(1);
    expect(cartao(dele, 'valorGanho').valor).toBe(5000);
    const daEquipe = await consultarPainel(cliente, 'comercial', {
      equipeId: lider.id,
    });
    expect(cartao(daEquipe, 'ganhos').valor).toBe(2);
    expect(cartao(daEquipe, 'abertos').valor).toBe(2); // sem responsável fica de fora do filtro de equipe
    const cs = await funilBase(t, 'CS');
    await consultarPainel(cliente, 'comercial', { funilId: cs.id }, 404);
    // Pessoa de outra área: o líder não a enxerga.
    const outra = await criarUsuario(t, { papel: 'C_LEVEL' });
    await consultarPainel(cliente, 'comercial', { pessoaId: outra.id }, 404);
  });
});
