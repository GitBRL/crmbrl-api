import { MotorDeNegociosService } from '../src/funis/motor-de-negocios.service';
import { INCLUIR_NEGOCIO } from '../src/funis/negocio-completo';
import { TIPOS_NOTIFICACAO } from '../src/notificacoes/tipos-notificacao';
import { mover } from './funis-apoio';
import {
  type AppTeste,
  criarAppTeste,
  criarContato,
  criarEmpresa,
  criarEquipe,
  criarNegocio,
  criarUsuario,
  entrarComo,
  etapaDoFunilBase,
} from './utils';

describe('Passagens entre funis (e2e)', () => {
  let t: AppTeste;

  beforeAll(async () => {
    t = await criarAppTeste();
  });

  beforeEach(() => t.limparBanco());

  afterAll(() => t.fechar());

  it('cenário 9 — R5.7: negócio de Marketing em "Qualificado (MQL)" cria negócio no Comercial, vinculado e distribuído; repetir o movimento não cria outro', async () => {
    const cLevel = await criarUsuario(t, { papel: 'C_LEVEL' });
    const {
      lider: liderMarketing,
      membros: [marina],
    } = await criarEquipe(t, 'MARKETING', { membros: 1, cLevel });
    const {
      membros: [ana, bruno],
    } = await criarEquipe(t, 'COMERCIAL', { cLevel });
    const empresa = await criarEmpresa(t, { nome: 'ACME' });
    const contato = await criarContato(t, { nome: 'Lia', empresa });
    const origem = await criarNegocio(t, {
      area: 'MARKETING',
      contato,
      empresa,
      responsavel: marina,
      titulo: 'Lia — ACME',
      valor: '500.00',
      origem: 'WEBHOOK',
    });
    await t.prisma.negocio.update({
      where: { id: origem.id },
      data: {
        origemDetalhe: 'Landing outubro',
        utm: { source: 'google', campaign: 'outubro' },
      },
    });
    const mql = await etapaDoFunilBase(t, 'MARKETING', 'qualificado_mql');
    const comoMarina = await entrarComo(t, marina);

    const movido = await mover(comoMarina, origem.id, mql.id).expect(200);
    expect(movido.body.negocio).toMatchObject({
      status: 'GANHO',
      etapa: { id: mql.id },
    });
    expect(movido.body.passagens).toEqual([
      expect.objectContaining({
        nome: 'Marketing → Comercial',
        negocioOrigemId: origem.id,
        criado: true,
        reconversao: false,
        responsavel: expect.objectContaining({ id: ana.id }),
      }),
    ]);
    const criado = await t.prisma.negocio.findUniqueOrThrow({
      where: { id: movido.body.passagens[0].negocioDestinoId },
      include: { etapa: true, funil: true },
    });
    expect(criado).toMatchObject({
      negocioOrigemId: origem.id,
      contatoId: contato.id,
      empresaId: empresa.id,
      responsavelId: ana.id,
      titulo: 'Lia — ACME',
      status: 'ABERTO',
      origem: 'WEBHOOK',
      origemDetalhe: 'Landing outubro',
      utm: { source: 'google', campaign: 'outubro' },
    });
    expect(criado.valor.toFixed(2)).toBe('500.00');
    expect(criado.funil.area).toBe('COMERCIAL');
    expect(criado.etapa.chave).toBe('novo');

    // Histórico, auditoria e evento como automação; o responsável é avisado.
    const entrada = await t.prisma.negocioMovimentacao.findFirstOrThrow({
      where: { negocioId: criado.id },
    });
    expect(entrada).toMatchObject({
      deEtapaId: null,
      tipoAtor: 'AUTOMACAO',
      usuarioId: marina.id,
    });
    const execucao = await t.prisma.eventoAuditoria.findFirstOrThrow({
      where: { acao: 'passagem.executada' },
    });
    expect(execucao).toMatchObject({
      tipoAtor: 'AUTOMACAO',
      atorDescricao: 'Passagem Marketing → Comercial',
    });
    expect(execucao.relacionados).toContain(`negocio:${origem.id}`);
    const notificacao = await t.prisma.notificacao.findFirstOrThrow({
      where: { usuarioId: ana.id },
    });
    expect(notificacao).toMatchObject({
      tipo: TIPOS_NOTIFICACAO.PASSAGEM_RECEBIDA,
      link: `/funis/${criado.funilId}?negocio=${criado.id}`,
    });
    expect(
      await t.prisma.eventoDominio.count({
        where: { tipo: { in: ['negocio.ganho', 'negocio.criado'] } },
      }),
    ).toBe(2);

    // Repetir: o líder reabre e o negócio entra de novo no MQL — nada é duplicado.
    const comoLider = await entrarComo(t, liderMarketing);
    await comoLider
      .post(`/api/v1/negocios/${origem.id}/reabrir`, {})
      .expect(200);
    const repetido = await mover(comoLider, origem.id, mql.id).expect(200);
    expect(repetido.body.passagens).toEqual([]);
    expect(
      await t.prisma.negocio.count({ where: { funil: { area: 'COMERCIAL' } } }),
    ).toBe(1);
    expect(await t.prisma.passagemExecucao.count()).toBe(1);
    // O rodízio não andou: o próximo do Comercial continua sendo o Bruno.
    const regra = await t.prisma.regraDistribuicao.findUniqueOrThrow({
      where: { area: 'COMERCIAL' },
    });
    expect(regra.ultimoUsuarioId).toBe(ana.id);
    expect(bruno.id).not.toBe(ana.id);
  });

  it('cenário 10 — R5.7: negócio do Comercial ganho → status ganho, data de ganho e negócio no CS em "Boas-vindas" com o valor recorrente', async () => {
    const cLevel = await criarUsuario(t, { papel: 'C_LEVEL' });
    const {
      membros: [ana],
    } = await criarEquipe(t, 'COMERCIAL', { membros: 1, cLevel });
    const {
      membros: [carla],
    } = await criarEquipe(t, 'CS', { membros: 1, cLevel });
    const negocio = await criarNegocio(t, {
      responsavel: ana,
      etapa: 'negociacao',
      valor: '12000.00',
      valorRecorrente: '990.00',
    });
    const ganho = await etapaDoFunilBase(t, 'COMERCIAL', 'ganho');
    const comoAna = await entrarComo(t, ana);

    const ganhou = await mover(comoAna, negocio.id, ganho.id).expect(200);
    expect(ganhou.body.negocio).toMatchObject({
      status: 'GANHO',
      ganhoEm: expect.any(String),
    });
    expect(ganhou.body.passagens).toHaveLength(1);
    const noCs = await t.prisma.negocio.findUniqueOrThrow({
      where: { id: ganhou.body.passagens[0].negocioDestinoId },
      include: { etapa: true, funil: true },
    });
    expect(noCs.funil.area).toBe('CS');
    expect(noCs.etapa.chave).toBe('boas_vindas');
    expect(noCs).toMatchObject({
      negocioOrigemId: negocio.id,
      responsavelId: carla.id,
      status: 'ABERTO',
    });
    expect(noCs.valor.toFixed(2)).toBe('12000.00');
    expect(noCs.valorRecorrente?.toFixed(2)).toBe('990.00');
    const salvo = await t.prisma.negocio.findUniqueOrThrow({
      where: { id: negocio.id },
    });
    expect(salvo.ganhoEm).toEqual(expect.any(Date));

    const evento = await t.prisma.eventoDominio.findFirstOrThrow({
      where: { tipo: 'negocio.ganho' },
    });
    expect(evento.dados).toMatchObject({
      negocioId: negocio.id,
      negocio: {
        status: 'GANHO',
        valor: '12000.00',
        valorRecorrente: '990.00',
      },
    });
  });

  it('R5.7/R5.9 — o detalhe traz a jornada: origem e gerados com a área, e quem não vê o outro funil só fica sabendo da área', async () => {
    const cLevel = await criarUsuario(t, { papel: 'C_LEVEL' });
    const {
      lider: liderMarketing,
      membros: [marina],
    } = await criarEquipe(t, 'MARKETING', { membros: 1, cLevel });
    const {
      lider: liderComercial,
      membros: [ana],
    } = await criarEquipe(t, 'COMERCIAL', { membros: 1, cLevel });
    const { lider: liderCs } = await criarEquipe(t, 'CS', {
      membros: 1,
      cLevel,
    });
    const lead = await criarNegocio(t, {
      area: 'MARKETING',
      responsavel: marina,
    });
    const mql = await etapaDoFunilBase(t, 'MARKETING', 'qualificado_mql');
    const noComercial = (
      await mover(await entrarComo(t, marina), lead.id, mql.id).expect(200)
    ).body.passagens[0].negocioDestinoId as string;
    await t.prisma.negocio.update({
      where: { id: noComercial },
      data: { responsavelId: ana.id },
    });
    const ganho = await etapaDoFunilBase(t, 'COMERCIAL', 'ganho');
    const noCs = (
      await mover(await entrarComo(t, ana), noComercial, ganho.id).expect(200)
    ).body.passagens[0].negocioDestinoId as string;

    // A Líder Comercial não vê Marketing nem CS: só a área dos dois lados.
    const comoLiderComercial = await entrarComo(t, liderComercial);
    const detalhe = await comoLiderComercial
      .get(`/api/v1/negocios/${noComercial}`)
      .expect(200);
    expect(detalhe.body.jornada).toEqual({
      origem: { id: lead.id, area: 'MARKETING', visivel: false },
      gerados: [{ id: noCs, area: 'CS', visivel: false }],
    });
    // O C-level vê tudo.
    const comoCLevel = await entrarComo(t, cLevel);
    expect(
      (await comoCLevel.get(`/api/v1/negocios/${noComercial}`).expect(200)).body
        .jornada,
    ).toEqual({
      origem: { id: lead.id, area: 'MARKETING', visivel: true },
      gerados: [{ id: noCs, area: 'CS', visivel: true }],
    });
    // Nas pontas: o lead gerou o do Comercial; o do CS veio dele.
    const comoLiderMarketing = await entrarComo(t, liderMarketing);
    expect(
      (await comoLiderMarketing.get(`/api/v1/negocios/${lead.id}`).expect(200))
        .body.jornada,
    ).toEqual({
      origem: null,
      gerados: [{ id: noComercial, area: 'COMERCIAL', visivel: false }],
    });
    const comoLiderCs = await entrarComo(t, liderCs);
    expect(
      (await comoLiderCs.get(`/api/v1/negocios/${noCs}`).expect(200)).body
        .jornada,
    ).toEqual({
      origem: { id: noComercial, area: 'COMERCIAL', visivel: false },
      gerados: [],
    });
    // Quem não vê o negócio de origem continua recebendo 404 nele.
    await comoLiderComercial.get(`/api/v1/negocios/${noCs}`).expect(404);
  });

  it('R5.7 — roda uma única vez por negócio de origem: reabrir e ganhar de novo não duplica', async () => {
    const cLevel = await criarUsuario(t, { papel: 'C_LEVEL' });
    const { lider } = await criarEquipe(t, 'COMERCIAL', { membros: 0, cLevel });
    await criarEquipe(t, 'CS', { membros: 2, cLevel });
    const negocio = await criarNegocio(t, { responsavel: lider });
    const ganho = await etapaDoFunilBase(t, 'COMERCIAL', 'ganho');
    const comoLider = await entrarComo(t, lider);
    for (let rodada = 0; rodada < 3; rodada++) {
      const resposta = await mover(comoLider, negocio.id, ganho.id).expect(200);
      expect(resposta.body.passagens).toHaveLength(rodada === 0 ? 1 : 0);
      await comoLider
        .post(`/api/v1/negocios/${negocio.id}/reabrir`, {})
        .expect(200);
    }
    expect(
      await t.prisma.negocio.count({ where: { funil: { area: 'CS' } } }),
    ).toBe(1);
    expect(
      await t.prisma.passagemExecucao.count({
        where: { negocioOrigemId: negocio.id },
      }),
    ).toBe(1);
  });

  it('R5.6 — outro negócio do mesmo contato que passa encontra o aberto no destino: registra a reconversão, não cria outro', async () => {
    const cLevel = await criarUsuario(t, { papel: 'C_LEVEL' });
    const {
      membros: [marina],
    } = await criarEquipe(t, 'MARKETING', { membros: 1, cLevel });
    const {
      membros: [ana],
    } = await criarEquipe(t, 'COMERCIAL', { cLevel });
    const contato = await criarContato(t);
    const primeiro = await criarNegocio(t, {
      area: 'MARKETING',
      contato,
      responsavel: marina,
    });
    const segundo = await criarNegocio(t, {
      area: 'MARKETING',
      contato,
      responsavel: marina,
    });
    const mql = await etapaDoFunilBase(t, 'MARKETING', 'qualificado_mql');
    const comoMarina = await entrarComo(t, marina);

    const um = await mover(comoMarina, primeiro.id, mql.id).expect(200);
    const dois = await mover(comoMarina, segundo.id, mql.id).expect(200);
    expect(dois.body.passagens).toEqual([
      expect.objectContaining({
        criado: false,
        reconversao: true,
        negocioDestinoId: um.body.passagens[0].negocioDestinoId,
      }),
    ]);
    const noComercial = await t.prisma.negocio.findMany({
      where: { funil: { area: 'COMERCIAL' } },
    });
    expect(noComercial).toHaveLength(1);
    expect(noComercial[0]).toMatchObject({
      responsavelId: ana.id,
      reconversoes: 1,
    });
    expect(
      await t.prisma.passagemExecucao.findFirstOrThrow({
        where: { negocioOrigemId: segundo.id },
      }),
    ).toMatchObject({ reconversao: true, negocioDestinoId: noComercial[0].id });
    expect(
      await t.prisma.notificacao.count({
        where: { usuarioId: ana.id, tipo: TIPOS_NOTIFICACAO.PASSAGEM_RECEBIDA },
      }),
    ).toBe(2);
  });

  it('R5.7 — a passagem roda na transação da movimentação: se ela desfaz, nada fica', async () => {
    await criarEquipe(t, 'COMERCIAL', { membros: 1 });
    const origem = await criarNegocio(t, { area: 'MARKETING' });
    const mql = await etapaDoFunilBase(t, 'MARKETING', 'qualificado_mql');
    const motor = t.get(MotorDeNegociosService);
    await expect(
      t.prisma.$transaction(async (tx) => {
        const atual = await tx.negocio.findUniqueOrThrow({
          where: { id: origem.id },
          include: INCLUIR_NEGOCIO,
        });
        const movido = await motor.entrarNaEtapa(tx, atual, mql, {
          posicao: 0,
        });
        const passagens = await motor.executarPassagens(tx, movido);
        expect(passagens).toHaveLength(1);
        throw new Error('desfaz a movimentação');
      }),
    ).rejects.toThrow('desfaz a movimentação');
    expect(
      await t.prisma.negocio.count({ where: { funil: { area: 'COMERCIAL' } } }),
    ).toBe(0);
    expect(await t.prisma.passagemExecucao.count()).toBe(0);
    expect(
      (await t.prisma.negocio.findUniqueOrThrow({ where: { id: origem.id } }))
        .status,
    ).toBe('ABERTO');
    expect(
      (
        await t.prisma.regraDistribuicao.findUniqueOrThrow({
          where: { area: 'COMERCIAL' },
        })
      ).ultimoUsuarioId,
    ).toBeNull();
  });

  it('R5.7 — configuração: Admin e C-level; funis diferentes, destino aberto, responsável fixo da área, sem repetir', async () => {
    const cLevel = await criarUsuario(t, { papel: 'C_LEVEL' });
    const {
      lider,
      membros: [ana, bruno],
    } = await criarEquipe(t, 'COMERCIAL', { cLevel });
    const {
      membros: [marina],
    } = await criarEquipe(t, 'MARKETING', { membros: 1, cLevel });
    await (await entrarComo(t, lider)).get('/api/v1/passagens').expect(403);
    const comoCLevel = await entrarComo(t, cLevel);
    const lista = await comoCLevel.get('/api/v1/passagens').expect(200);
    expect(
      (lista.body as { chave: string }[]).map((passagem) => passagem.chave),
    ).toEqual(['marketing_comercial', 'comercial_cs']);

    const parcerias = (
      await comoCLevel
        .post('/api/v1/funis', { nome: 'Parcerias', area: 'COMERCIAL' })
        .expect(201)
    ).body as { id: string; etapas: { id: string; tipo: string }[] };
    const [entradaParcerias] = parcerias.etapas;
    const ganhoParcerias = parcerias.etapas.find((e) => e.tipo === 'GANHO');
    const proposta = await etapaDoFunilBase(t, 'COMERCIAL', 'proposta');
    const negociacao = await etapaDoFunilBase(t, 'COMERCIAL', 'negociacao');
    const base = {
      nome: 'Proposta → Parcerias',
      etapaGatilhoId: proposta.id,
      etapaDestinoId: entradaParcerias.id,
    };

    const mesmoFunil = await comoCLevel
      .post('/api/v1/passagens', { ...base, etapaDestinoId: negociacao.id })
      .expect(422);
    expect(mesmoFunil.body.detalhes.regra).toBe('R5.7');
    await comoCLevel
      .post('/api/v1/passagens', {
        ...base,
        etapaDestinoId: ganhoParcerias?.id,
      })
      .expect(422);
    const semFixo = await comoCLevel
      .post('/api/v1/passagens', { ...base, estrategia: 'RESPONSAVEL_FIXO' })
      .expect(422);
    expect(semFixo.body.detalhes.regra).toBe('R5.8');
    await comoCLevel
      .post('/api/v1/passagens', {
        ...base,
        estrategia: 'RESPONSAVEL_FIXO',
        responsavelFixoId: marina.id,
      })
      .expect(422);

    const criada = await comoCLevel
      .post('/api/v1/passagens', {
        ...base,
        estrategia: 'RESPONSAVEL_FIXO',
        responsavelFixoId: bruno.id,
      })
      .expect(201);
    expect(criada.body).toMatchObject({
      nome: 'Proposta → Parcerias',
      funilOrigem: { area: 'COMERCIAL' },
      funilDestino: { id: parcerias.id },
      estrategia: 'RESPONSAVEL_FIXO',
      responsavelFixo: { id: bruno.id },
      ativa: true,
      execucoes: 0,
    });
    await comoCLevel.post('/api/v1/passagens', base).expect(409);

    // Funciona com a estratégia da passagem.
    const negocio = await criarNegocio(t, { responsavel: ana });
    const movido = await mover(
      await entrarComo(t, ana),
      negocio.id,
      proposta.id,
    ).expect(200);
    expect(movido.body.passagens).toEqual([
      expect.objectContaining({
        nome: 'Proposta → Parcerias',
        funilDestinoId: parcerias.id,
        responsavel: expect.objectContaining({ id: bruno.id }),
      }),
    ]);

    // Já rodou: não se exclui, desativa-se; desativada não roda.
    const excluir = await comoCLevel
      .delete(`/api/v1/passagens/${criada.body.id}`)
      .expect(422);
    expect(excluir.body.detalhes).toMatchObject({
      regra: 'R5.7',
      execucoes: 1,
    });
    await comoCLevel
      .patch(`/api/v1/passagens/${criada.body.id}`, { ativa: false })
      .expect(200);
    const outro = await criarNegocio(t, { responsavel: ana });
    const semPassagem = await mover(
      await entrarComo(t, ana),
      outro.id,
      proposta.id,
    ).expect(200);
    expect(semPassagem.body.passagens).toEqual([]);
    expect(
      await t.prisma.eventoAuditoria.count({
        where: {
          acao: { in: ['passagem.criada', 'passagem.atualizada'] },
          entidadeId: criada.body.id,
        },
      }),
    ).toBe(2);

    // Passagem que nunca rodou pode ser excluída.
    const nova = await comoCLevel
      .post('/api/v1/passagens', {
        nome: 'Negociação → Parcerias',
        etapaGatilhoId: negociacao.id,
        etapaDestinoId: entradaParcerias.id,
      })
      .expect(201);
    await comoCLevel.delete(`/api/v1/passagens/${nova.body.id}`).expect(204);
  });

  it('R5.7 — passagens encadeadas não entram em laço: o ciclo termina numa reconversão', async () => {
    const admin = await criarUsuario(t);
    const comoAdmin = await entrarComo(t, admin);
    await criarEquipe(t, 'MARKETING', { membros: 1 });
    await criarEquipe(t, 'COMERCIAL', { membros: 1 });
    const funilA = (
      await comoAdmin
        .post('/api/v1/funis', { nome: 'Ciclo A', area: 'MARKETING' })
        .expect(201)
    ).body as { id: string; etapas: { id: string }[] };
    const funilB = (
      await comoAdmin
        .post('/api/v1/funis', { nome: 'Ciclo B', area: 'COMERCIAL' })
        .expect(201)
    ).body as { id: string; etapas: { id: string }[] };
    const [a1, a2] = funilA.etapas;
    const [b1] = funilB.etapas;
    await comoAdmin
      .post('/api/v1/passagens', {
        nome: 'A → B',
        etapaGatilhoId: a2.id,
        etapaDestinoId: b1.id,
      })
      .expect(201);
    await comoAdmin
      .post('/api/v1/passagens', {
        nome: 'B → A',
        etapaGatilhoId: b1.id,
        etapaDestinoId: a2.id,
      })
      .expect(201);
    const contato = await criarContato(t);
    const criado = await comoAdmin
      .post('/api/v1/negocios', {
        contatoId: contato.id,
        funilId: funilA.id,
        etapaId: a1.id,
      })
      .expect(201);

    const movido = await mover(comoAdmin, criado.body.id, a2.id).expect(200);
    expect(
      (movido.body.passagens as { nome: string; criado: boolean }[]).map(
        (passagem) => [passagem.nome, passagem.criado],
      ),
    ).toEqual([
      ['A → B', true],
      ['B → A', false],
    ]);
    expect(
      await t.prisma.negocio.count({ where: { contatoId: contato.id } }),
    ).toBe(2);
  });
});
