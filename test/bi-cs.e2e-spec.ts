import { diaLocal } from '../src/bi/periodo';
import {
  cartao,
  consultarPainel,
  criarCanal,
  criarConversaBi,
  type DadosDeNegocioBi,
  criarNegocioBi,
  DIA,
  linhasDa,
  quando,
} from './bi-apoio';
import {
  type AppTeste,
  criarAppTeste,
  criarEquipe,
  criarFila,
  entrarComo,
} from './utils';

/** Data (AAAA-MM-DD) daqui a `dias` dias, a partir de hoje em Brasília. */
function emDias(dias: number): string {
  const hoje = new Date(`${diaLocal(new Date())}T00:00:00.000Z`);
  return new Date(hoje.getTime() + dias * DIA).toISOString().slice(0, 10);
}

describe('BI — painel CS (e2e)', () => {
  let t: AppTeste;

  beforeAll(async () => {
    t = await criarAppTeste();
  });
  beforeEach(() => t.limparBanco());
  afterAll(() => t.fechar());

  async function montar() {
    const { lider, membros } = await criarEquipe(t, 'CS', { membros: 2 });
    const [c1, c2] = membros;
    const cs = (dados: Omit<DadosDeNegocioBi, 'area'>) =>
      criarNegocioBi(t, { area: 'CS', ...dados });
    // Carteira (abertos): 3 em onboarding, 2 em acompanhamento.
    await cs({
      etapa: 'boas_vindas',
      valorRecorrente: '100.00',
      previsao: emDias(10),
      criadoEm: quando(5),
      responsavel: c1,
      etapaDesde: quando(4),
    });
    await cs({
      etapa: 'onboarding',
      valorRecorrente: '200.00',
      previsao: emDias(40),
      criadoEm: quando(20),
      responsavel: c1,
      etapaDesde: quando(10),
    });
    await cs({
      etapa: 'implantacao',
      valorRecorrente: '300.00',
      previsao: emDias(-5),
      criadoEm: quando(60),
      responsavel: c2,
      etapaDesde: quando(40),
    });
    await cs({
      etapa: 'acompanhamento',
      valorRecorrente: '400.00',
      previsao: emDias(100),
      criadoEm: quando(200),
      responsavel: c2,
    });
    await cs({
      etapa: 'acompanhamento',
      valorRecorrente: '500.00',
      criadoEm: quando(200),
      responsavel: null,
    });
    // Resultado das renovações: 1 renovado e 1 cancelado no período; 1 cancelado no anterior.
    await cs({
      etapa: 'renovado',
      valorRecorrente: '600.00',
      criadoEm: quando(300),
      fechadoEm: quando(3),
      responsavel: c1,
    });
    await cs({
      etapa: 'cancelado',
      valorRecorrente: '700.00',
      criadoEm: quando(300),
      fechadoEm: quando(2),
      responsavel: c2,
    });
    await cs({
      etapa: 'cancelado',
      valorRecorrente: '50.00',
      criadoEm: quando(300),
      fechadoEm: quando(14),
      responsavel: c2,
    });
    // Ruído: negócio do Comercial.
    await criarNegocioBi(t, {
      area: 'COMERCIAL',
      etapa: 'novo',
      criadoEm: quando(1),
    });
    // Satisfação: notas 5, 4, 4 nas filas de CS e 1 numa fila do Comercial.
    const fila = await criarFila(t, { area: 'CS' });
    const filaComercial = await criarFila(t, { area: 'COMERCIAL' });
    const canal = await criarCanal(t, { tipo: 'WEBCHAT' });
    const conversa = (
      filaId: string,
      nota: number,
      dias: number,
      responsavel = c1,
    ) =>
      criarConversaBi(t, {
        canalId: canal.id,
        filaId,
        responsavel,
        criadoEm: quando(dias),
        resolvidaApos: 30,
        nota,
      });
    await conversa(fila.id, 5, 3);
    await conversa(fila.id, 4, 4);
    await conversa(fila.id, 4, 5, c2);
    await conversa(filaComercial.id, 1, 3);
    await conversa(fila.id, 2, 15); // período anterior
    return { lider, c1, c2 };
  }

  it('R20 — carteira, recorrente, onboarding e renovações (de agora, sem comparação)', async () => {
    const { lider } = await montar();
    const painel = await consultarPainel(await entrarComo(t, lider), 'cs');
    expect(cartao(painel, 'carteira')).toMatchObject({
      valor: 5,
      anterior: null,
      variacao: null,
    });
    expect(cartao(painel, 'valorRecorrenteCarteira').valor).toBe(1500);
    expect(cartao(painel, 'emOnboarding').valor).toBe(3);
    expect(cartao(painel, 'renovacoesProximas').valor).toBe(1); // hoje até +30 dias
    expect(cartao(painel, 'renovacoesVencidas').valor).toBe(1);
    const direto = await t.prisma.negocio.count({
      where: { status: 'ABERTO', funil: { area: 'CS' } },
    });
    expect(direto).toBe(5);
  });

  it('R20 — onboarding por etapa e renovações por faixa', async () => {
    const { lider } = await montar();
    const painel = await consultarPainel(await entrarComo(t, lider), 'cs');
    const onboarding = linhasDa(painel, 'onboardingPorEtapa');
    expect(onboarding.map((l) => [l.etapa, l.quantidade])).toEqual([
      ['Boas-vindas', 1],
      ['Onboarding', 1],
      ['Implantação', 1],
    ]);
    // Boas-vindas (prazo 2 dias) está há 4 dias; Onboarding (15) há 10; Implantação (30) há 40.
    expect(onboarding.map((l) => l.parados)).toEqual([1, 0, 1]);
    expect(Math.round(Number(onboarding[0].diasNaEtapa))).toBe(4);
    expect(linhasDa(painel, 'renovacoes')).toEqual([
      { faixa: 'Vencidas', quantidade: 1, valorRecorrente: 300 },
      { faixa: 'Até 30 dias', quantidade: 1, valorRecorrente: 100 },
      { faixa: '31 a 60 dias', quantidade: 1, valorRecorrente: 200 },
      { faixa: '61 a 90 dias', quantidade: 0, valorRecorrente: 0 },
      { faixa: 'Depois de 90 dias', quantidade: 1, valorRecorrente: 400 },
    ]);
    const proximas = linhasDa(painel, 'proximasRenovacoes');
    expect(proximas.map((l) => l.previsao)).toEqual([
      emDias(-5),
      emDias(10),
      emDias(40),
    ]);
    const porResponsavel = linhasDa(painel, 'carteiraPorResponsavel');
    expect(porResponsavel.reduce((s, l) => s + Number(l.clientes), 0)).toBe(5);
    expect(
      porResponsavel.find((l) => l.nome === 'Sem responsável'),
    ).toMatchObject({ clientes: 1, valorRecorrente: 500 });
  });

  it('R20 — renovados, cancelados, taxa de renovação e recorrente cancelado, com comparação', async () => {
    const { lider } = await montar();
    const painel = await consultarPainel(await entrarComo(t, lider), 'cs');
    expect(cartao(painel, 'renovados')).toMatchObject({
      valor: 1,
      anterior: 0,
      variacao: null,
    });
    expect(cartao(painel, 'cancelados')).toMatchObject({
      valor: 1,
      anterior: 1,
      variacao: 0,
    });
    expect(cartao(painel, 'taxaRenovacao')).toMatchObject({
      valor: 50,
      anterior: 0,
      variacao: null,
    });
    expect(cartao(painel, 'valorRecorrenteCancelado')).toMatchObject({
      valor: 700,
      anterior: 50,
      variacao: 1300,
    });
  });

  it('R12, R20 — satisfação só das conversas das filas de CS, com distribuição por nota', async () => {
    const { lider } = await montar();
    const painel = await consultarPainel(await entrarComo(t, lider), 'cs');
    expect(cartao(painel, 'satisfacao')).toMatchObject({
      valor: 4.33,
      anterior: 2,
      variacao: 116.5,
    });
    expect(cartao(painel, 'respostasSatisfacao')).toMatchObject({
      valor: 3,
      anterior: 1,
    });
    expect(
      linhasDa(painel, 'satisfacaoPorNota').map((l) => l.respostas),
    ).toEqual([0, 0, 0, 2, 1]);
  });

  it('R1, R20 — a pessoa de CS vê só a carteira dela e os sem responsável; as conversas como no Atendimento', async () => {
    const { c1, c2 } = await montar();
    const doC1 = await consultarPainel(await entrarComo(t, c1), 'cs');
    const doC2 = await consultarPainel(await entrarComo(t, c2), 'cs');
    // c1: boas-vindas, onboarding e o sem responsável.
    expect(cartao(doC1, 'carteira').valor).toBe(3);
    expect(cartao(doC1, 'valorRecorrenteCarteira').valor).toBe(800);
    expect(cartao(doC1, 'renovados').valor).toBe(1);
    expect(cartao(doC1, 'cancelados').valor).toBe(0);
    // c2: implantação, acompanhamento e o sem responsável.
    expect(cartao(doC2, 'carteira').valor).toBe(3);
    expect(cartao(doC2, 'cancelados').valor).toBe(1);
    // Satisfação: só as conversas que estão com a pessoa (as da fila de CS com responsável de outra não aparecem).
    expect(cartao(doC1, 'respostasSatisfacao').valor).toBe(2);
    expect(cartao(doC2, 'respostasSatisfacao').valor).toBe(1);
  });
});
