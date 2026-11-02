import {
  cartao,
  consultarPainel,
  criarNegocioBi,
  linhasDa,
  periodoDeTeste,
  quando,
} from './bi-apoio';
import {
  type AppTeste,
  criarAppTeste,
  criarCampanha,
  criarContato,
  criarEquipe,
  entrarComo,
  funilBase,
} from './utils';

describe('BI — painel Marketing (e2e)', () => {
  let t: AppTeste;

  beforeAll(async () => {
    t = await criarAppTeste();
  });
  beforeEach(() => t.limparBanco());
  afterAll(() => t.fechar());

  /** Cenário conhecido: 4 leads no período (2 passaram), 2 no anterior (1 passou) e 1 negócio do Comercial. */
  async function montar() {
    const { cLevel, lider, membros } = await criarEquipe(t, 'MARKETING', {
      membros: 2,
    });
    const [m1, m2] = membros;
    const passagem = await t.prisma.passagem.findFirstOrThrow({
      where: { chave: 'marketing_comercial' },
    });
    const lead = (
      dias: number,
      extra: Parameters<typeof criarNegocioBi>[1] extends infer D
        ? Partial<D>
        : never,
    ) =>
      criarNegocioBi(t, {
        area: 'MARKETING',
        etapa: 'novo_lead',
        criadoEm: quando(dias, 12),
        ...extra,
      });
    const passou = (negocioId: string, dias: number) =>
      t.prisma.passagemExecucao.create({
        data: {
          passagemId: passagem.id,
          negocioOrigemId: negocioId,
          criadoEm: quando(dias, 12),
        },
      });
    const utm = { source: 'google', medium: 'cpc', campaign: 'black' };
    const l1 = await lead(2, { origem: 'SITE', utm, responsavel: m1 });
    const l2 = await lead(3, { origem: 'SITE', utm, responsavel: m1 });
    const l3 = await lead(5, { origem: 'WEBHOOK' });
    const l4 = await lead(9, { origem: 'MANUAL', responsavel: m2 });
    await passou(l2.id, 2); // 1 dia depois
    await passou(l3.id, 3); // 2 dias depois
    // Período anterior (10 a 20 dias antes do fim): 2 leads, 1 passou.
    await lead(12, { origem: 'SITE' });
    const p2 = await lead(15, { origem: 'SITE' });
    await passou(p2.id, 14);
    // Ruído: negócio do Comercial no período.
    await criarNegocioBi(t, {
      area: 'COMERCIAL',
      etapa: 'novo',
      criadoEm: quando(1),
    });
    return { cLevel, lider, m1, m2, l1, l2, l3, l4 };
  }

  it('R20 — leads, passagens, taxa e tempo até a passagem batem com a consulta direta, com comparação', async () => {
    const { lider } = await montar();
    const painel = await consultarPainel(
      await entrarComo(t, lider),
      'marketing',
    );
    const { de, ate } = periodoDeTeste();
    const funil = await funilBase(t, 'MARKETING');
    const direto = await t.prisma.negocio.count({
      where: {
        funilId: funil.id,
        criadoEm: { gte: new Date(de), lt: new Date(ate) },
      },
    });
    expect(direto).toBe(4);
    expect(cartao(painel, 'leads')).toMatchObject({
      valor: 4,
      anterior: 2,
      variacao: 100,
    });
    expect(cartao(painel, 'passagens')).toMatchObject({
      valor: 2,
      anterior: 1,
      variacao: 100,
    });
    expect(cartao(painel, 'taxaPassagem')).toMatchObject({
      valor: 50,
      anterior: 50,
      variacao: 0,
    });
    // (1 dia + 2 dias) / 2 = 1,5 dia.
    expect(cartao(painel, 'tempoAtePassagem').valor).toBe(129_600);
    expect(painel.anterior).not.toBeNull();
  });

  it('R20 — leads por origem, por UTM e por dia', async () => {
    const { lider } = await montar();
    const painel = await consultarPainel(
      await entrarComo(t, lider),
      'marketing',
    );
    expect(linhasDa(painel, 'leadsPorOrigem')).toEqual([
      { origem: 'SITE', leads: 2, comPassagem: 1, taxaPassagem: 50 },
      { origem: 'MANUAL', leads: 1, comPassagem: 0, taxaPassagem: 0 },
      { origem: 'WEBHOOK', leads: 1, comPassagem: 1, taxaPassagem: 100 },
    ]);
    // Empate de leads (2 e 2): desempata pelo nome, "(sem UTM)" primeiro.
    expect(linhasDa(painel, 'leadsPorUtm')).toEqual([
      {
        fonte: '(sem UTM)',
        meio: '(sem UTM)',
        campanha: '(sem UTM)',
        leads: 2,
      },
      { fonte: 'google', meio: 'cpc', campanha: 'black', leads: 2 },
    ]);
    const dias = linhasDa(painel, 'leadsPorDia');
    // O período começa à meia-noite UTC (21h em Brasília): toca 11 dias locais.
    expect(dias).toHaveLength(11);
    expect(dias.reduce((s, d) => s + Number(d.leads), 0)).toBe(4);
    expect(dias.reduce((s, d) => s + Number(d.passagens), 0)).toBe(2);
    // O lead de 5 dias atrás (12h UTC = 9h em Brasília) cai no dia certo.
    const diaDoLead = quando(5, 12).toISOString().slice(0, 10);
    expect(dias.find((d) => d.dia === diaDoLead)).toMatchObject({ leads: 1 });
  });

  it('R1, R20 — o membro vê só os leads dele e os sem responsável, igual ao kanban', async () => {
    const { lider, m1, m2 } = await montar();
    const doM1 = await consultarPainel(await entrarComo(t, m1), 'marketing');
    const doM2 = await consultarPainel(await entrarComo(t, m2), 'marketing');
    const doLider = await consultarPainel(
      await entrarComo(t, lider),
      'marketing',
    );
    expect(cartao(doLider, 'leads').valor).toBe(4);
    expect(cartao(doM1, 'leads').valor).toBe(3); // l1, l2 e o sem responsável l3
    expect(cartao(doM2, 'leads').valor).toBe(2); // l4 e l3
    // Na lista de negócios (período inteiro, funil de Marketing) o membro vê o mesmo conjunto.
    const funil = await funilBase(t, 'MARKETING');
    const { de, ate } = periodoDeTeste();
    for (const [usuario, esperado] of [
      [m1, 3],
      [m2, 2],
    ] as const) {
      const lista = await (
        await entrarComo(t, usuario)
      )
        .get('/api/v1/negocios')
        .query({ funilId: funil.id, porPagina: 100 })
        .expect(200);
      const noPeriodo = (lista.body.itens as { criadoEm: string }[]).filter(
        (n) => n.criadoEm >= de && n.criadoEm < ate,
      );
      expect(noPeriodo).toHaveLength(esperado);
    }
  });

  it('R20 — campanhas: enviados, entregues, lidos, respondidos e opt-outs pela data de cada evento', async () => {
    const { lider, m1, m2 } = await montar();
    const dela = await criarCampanha(t, {
      area: 'MARKETING',
      criadoPor: m1,
      nome: 'Black Friday',
    });
    const deOutro = await criarCampanha(t, {
      area: 'MARKETING',
      criadoPor: m2,
      nome: 'Outra',
    });
    const destinatario = async (
      campanhaId: string,
      dados: Record<string, Date | null>,
    ) => {
      const contato = await criarContato(t);
      await t.prisma.campanhaDestinatario.create({
        data: {
          campanhaId,
          contatoId: contato.id,
          destino: '5511900000000',
          ordem: 0,
          ...dados,
        },
      });
    };
    const e = quando(4, 10);
    await destinatario(dela.id, {
      enviadoEm: e,
      entregueEm: quando(4, 11),
      lidoEm: quando(4, 12),
      respondeuEm: quando(3, 9),
    });
    await destinatario(dela.id, {
      enviadoEm: e,
      entregueEm: quando(4, 11),
      lidoEm: quando(4, 13),
    });
    await destinatario(dela.id, {
      enviadoEm: e,
      entregueEm: quando(4, 11),
      optOutEm: quando(3, 10),
    });
    await destinatario(dela.id, { enviadoEm: e });
    // Fora do período (enviado há 30 dias): não conta.
    await destinatario(dela.id, {
      enviadoEm: quando(30),
      entregueEm: quando(30),
    });
    await destinatario(deOutro.id, { enviadoEm: e, entregueEm: quando(4, 11) });
    const painel = await consultarPainel(
      await entrarComo(t, lider),
      'marketing',
    );
    expect(cartao(painel, 'enviados').valor).toBe(5);
    expect(cartao(painel, 'entregues').valor).toBe(4);
    expect(cartao(painel, 'lidos').valor).toBe(2);
    expect(cartao(painel, 'respondidos').valor).toBe(1);
    expect(cartao(painel, 'optOuts').valor).toBe(1);
    const linhas = linhasDa(painel, 'campanhas');
    expect(linhas[0]).toMatchObject({
      nome: 'Black Friday',
      enviados: 4,
      entregues: 3,
      lidos: 2,
      respondidos: 1,
      optOuts: 1,
      taxaEntrega: 75,
      taxaLeitura: 50,
      taxaResposta: 25,
    });
    expect(linhas[1]).toMatchObject({ nome: 'Outra', enviados: 1 });
    // R17 — o membro vê só as campanhas que criou.
    const doM1 = await consultarPainel(await entrarComo(t, m1), 'marketing');
    expect(cartao(doM1, 'enviados').valor).toBe(4);
    expect(linhasDa(doM1, 'campanhas')).toHaveLength(1);
  });

  it('R20 — filtros de pessoa, equipe e funil limitam os números', async () => {
    const { lider, m1 } = await montar();
    const cliente = await entrarComo(t, lider);
    expect(
      cartao(
        await consultarPainel(cliente, 'marketing', { pessoaId: m1.id }),
        'leads',
      ).valor,
    ).toBe(2);
    expect(
      cartao(
        await consultarPainel(cliente, 'marketing', { equipeId: lider.id }),
        'leads',
      ).valor,
    ).toBe(3); // m1 (2) + m2 (1)
    const funil = await funilBase(t, 'MARKETING');
    expect(
      cartao(
        await consultarPainel(cliente, 'marketing', { funilId: funil.id }),
        'leads',
      ).valor,
    ).toBe(4);
    const comercial = await funilBase(t, 'COMERCIAL');
    await consultarPainel(cliente, 'marketing', { funilId: comercial.id }, 404);
  });
});
