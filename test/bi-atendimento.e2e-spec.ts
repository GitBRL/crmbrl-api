import {
  cartao,
  consultarPainel,
  criarCanal,
  criarConversaBi,
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

describe('BI — painel Atendimento (e2e)', () => {
  let t: AppTeste;

  beforeAll(async () => {
    t = await criarAppTeste();
  });
  beforeEach(() => t.limparBanco());
  afterAll(() => t.fechar());

  async function montar() {
    const comercial = await criarEquipe(t, 'COMERCIAL', { membros: 2 });
    const cs = await criarEquipe(t, 'CS', {
      membros: 1,
      cLevel: comercial.cLevel,
    });
    const [v1, v2] = comercial.membros;
    const [c1] = cs.membros;
    const filaCom = await criarFila(t, {
      area: 'COMERCIAL',
      nome: 'Vendas',
      slaPrimeiraRespostaMinutos: 10,
      slaResolucaoMinutos: 60,
    });
    const filaCs = await criarFila(t, { area: 'CS', nome: 'Suporte' });
    const webchat = await criarCanal(t, { tipo: 'WEBCHAT', nome: 'Site' });
    const email = await criarCanal(t, { tipo: 'EMAIL', nome: 'E-mail' });
    // Horas em UTC; em Brasília (UTC−3): 13h → 10h, 14h → 11h, 15h → 12h, 16h → 13h.
    await criarConversaBi(t, {
      canalId: webchat.id,
      filaId: filaCom.id,
      responsavel: v1,
      criadoEm: quando(3, 13),
      primeiraRespostaApos: 5,
      resolvidaApos: 50,
      slaPrimeiraRespostaApos: 10,
      slaResolucaoApos: 60,
      nota: 5,
    });
    await criarConversaBi(t, {
      canalId: webchat.id,
      filaId: filaCom.id,
      responsavel: v1,
      criadoEm: quando(3, 14),
      primeiraRespostaApos: 20,
      resolvidaApos: 120,
      slaPrimeiraRespostaApos: 10,
      slaResolucaoApos: 60,
      nota: 3,
    });
    await criarConversaBi(t, {
      canalId: email.id,
      filaId: filaCom.id,
      responsavel: v2,
      criadoEm: quando(3, 13, 30),
      primeiraRespostaApos: 10,
      slaPrimeiraRespostaApos: 10,
      slaResolucaoApos: 60,
    });
    await criarConversaBi(t, {
      canalId: email.id,
      filaId: filaCs.id,
      responsavel: c1,
      criadoEm: quando(3, 15),
      primeiraRespostaApos: 60,
      resolvidaApos: 180,
      nota: 4,
    });
    // Sem responsável, sem resposta e com o prazo já vencido.
    await criarConversaBi(t, {
      canalId: webchat.id,
      filaId: filaCom.id,
      criadoEm: quando(2, 16),
      slaPrimeiraRespostaApos: 10,
    });
    // Período anterior.
    await criarConversaBi(t, {
      canalId: webchat.id,
      filaId: filaCom.id,
      responsavel: v1,
      criadoEm: quando(15, 13),
      primeiraRespostaApos: 30,
      resolvidaApos: 90,
      nota: 2,
    });
    return { ...comercial, cs, v1, v2, c1, filaCom, filaCs, webchat, email };
  }

  it('R20 — volume, primeira resposta, tempo de atendimento, SLA e CSAT batem com a conta direta', async () => {
    const { lider } = await montar();
    const painel = await consultarPainel(
      await entrarComo(t, lider),
      'atendimento',
    );
    expect(cartao(painel, 'conversas')).toMatchObject({
      valor: 4,
      anterior: 1,
    });
    // O líder do Comercial vê as conversas das filas do Comercial: c1 (5 min), c2 (20), c3 (10) e c5 (sem resposta).
    expect(cartao(painel, 'primeiraResposta').valor).toBe(
      Math.round((300 + 1200 + 600) / 3),
    );
    expect(cartao(painel, 'primeiraRespostaMediana').valor).toBe(600);
    expect(cartao(painel, 'resolvidas').valor).toBe(2);
    expect(cartao(painel, 'tempoAtendimento').valor).toBe((3000 + 7200) / 2);
    // SLA da 1ª resposta: c1 e c3 cumpriram (≤ 10 min), c2 e c5 estouraram.
    expect(cartao(painel, 'slaPrimeiraResposta')).toMatchObject({
      valor: 50,
      anterior: null,
    });
    // SLA de resolução: c1 cumpriu, c2 estourou.
    expect(cartao(painel, 'slaResolucao').valor).toBe(50);
    expect(cartao(painel, 'csat')).toMatchObject({
      valor: 4,
      anterior: 2,
      variacao: 100,
    });
    expect(cartao(painel, 'respostasCsat').valor).toBe(2);
    expect(cartao(painel, 'emAberto').valor).toBe(2);
    expect(cartao(painel, 'semResponsavel').valor).toBe(1);
  });

  it('R20 — Admin vê tudo: 5 conversas, incluindo as de CS; volume por canal e por hora', async () => {
    const { cLevel } = await montar();
    const painel = await consultarPainel(
      await entrarComo(t, cLevel),
      'atendimento',
    );
    expect(cartao(painel, 'conversas').valor).toBe(5);
    const { de, ate } = painel.periodo;
    const direto = await t.prisma.conversa.count({
      where: { criadoEm: { gte: new Date(de), lt: new Date(ate) } },
    });
    expect(direto).toBe(5);
    const canais = linhasDa(painel, 'porCanal');
    expect(canais.find((l) => l.nome === 'Site')).toMatchObject({
      tipo: 'WEBCHAT',
      conversas: 3,
      resolvidas: 2,
    });
    expect(canais.find((l) => l.nome === 'E-mail')).toMatchObject({
      tipo: 'EMAIL',
      conversas: 2,
      resolvidas: 1,
    });
    const porHora = linhasDa(painel, 'porHora');
    expect(porHora).toHaveLength(24);
    expect(
      porHora
        .filter((l) => Number(l.conversas) > 0)
        .map((l) => [l.hora, l.conversas]),
    ).toEqual([
      [10, 2],
      [11, 1],
      [12, 1],
      [13, 1],
    ]);
    const porDia = linhasDa(painel, 'porDia');
    expect(porDia.reduce((s, l) => s + Number(l.conversas), 0)).toBe(5);
    expect(porDia.reduce((s, l) => s + Number(l.resolvidas), 0)).toBe(3);
  });

  it('R20 — por atendente e por fila', async () => {
    const { cLevel, v1, filaCom } = await montar();
    const painel = await consultarPainel(
      await entrarComo(t, cLevel),
      'atendimento',
    );
    const atendentes = linhasDa(painel, 'porAtendente');
    expect(atendentes.find((l) => l.id === v1.id)).toMatchObject({
      conversas: 2,
      resolvidas: 2,
      primeiraResposta: 750,
      tempoAtendimento: 5100,
      slaPrimeiraResposta: 50,
      slaResolucao: 50,
      csat: 4,
      respostasCsat: 2,
    });
    expect(atendentes.find((l) => l.id === null)).toMatchObject({
      nome: 'Sem responsável',
      conversas: 1,
    });
    const filas = linhasDa(painel, 'porFila');
    expect(filas.find((l) => l.id === filaCom.id)).toMatchObject({
      nome: 'Vendas',
      conversas: 4,
      resolvidas: 2,
    });
    expect(filas.find((l) => l.nome === 'Suporte')).toMatchObject({
      conversas: 1,
      resolvidas: 1,
      csat: 4,
    });
  });

  it('R1, R12, R20 — a visibilidade do BI é a da lista de conversas', async () => {
    const { lider, v1, v2, c1, cs } = await montar();
    const casos = [
      { quem: v1, esperado: 3 }, // as dele (2) + a sem responsável da fila do Comercial
      { quem: v2, esperado: 2 }, // a dele + a sem responsável
      { quem: lider, esperado: 4 }, // as das filas do Comercial
      { quem: c1, esperado: 1 }, // a dela (fila de CS)
      { quem: cs.lider, esperado: 1 },
    ];
    for (const { quem, esperado } of casos) {
      const cliente = await entrarComo(t, quem);
      const painel = await consultarPainel(cliente, 'atendimento');
      const lista = await cliente
        .get('/api/v1/atendimento/conversas')
        .query({ status: ['ABERTA', 'PENDENTE', 'RESOLVIDA'], porPagina: 100 })
        .expect(200);
      const doPeriodo = (lista.body.itens as { criadoEm: string }[]).filter(
        (c) =>
          c.criadoEm >= painel.periodo.de && c.criadoEm < painel.periodo.ate,
      );
      expect(doPeriodo).toHaveLength(esperado);
      expect(cartao(painel, 'conversas').valor).toBe(esperado);
    }
  });

  it('R20 — filtros de canal, fila, pessoa e área', async () => {
    const { cLevel, v1, filaCom, filaCs, email } = await montar();
    const cliente = await entrarComo(t, cLevel);
    expect(
      cartao(
        await consultarPainel(cliente, 'atendimento', { canalId: email.id }),
        'conversas',
      ).valor,
    ).toBe(2);
    expect(
      cartao(
        await consultarPainel(cliente, 'atendimento', { filaId: filaCom.id }),
        'conversas',
      ).valor,
    ).toBe(4);
    expect(
      cartao(
        await consultarPainel(cliente, 'atendimento', { filaId: filaCs.id }),
        'conversas',
      ).valor,
    ).toBe(1);
    expect(
      cartao(
        await consultarPainel(cliente, 'atendimento', { pessoaId: v1.id }),
        'conversas',
      ).valor,
    ).toBe(2);
    expect(
      cartao(
        await consultarPainel(cliente, 'atendimento', { area: 'CS' }),
        'conversas',
      ).valor,
    ).toBe(1);
  });
});
