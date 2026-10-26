import type { Conversa } from '../src/generated/prisma/client';
import {
  type CenarioDoAtendimento,
  montarCenario,
  usarAdaptadorFalso,
} from './atendimento-apoio';
import {
  type AppTeste,
  criarAppTeste,
  criarCanal,
  criarContato,
  criarConversa,
  criarMensagem,
  criarNegocio,
  entrarComo,
  processarEventos,
} from './utils';

const BASE = '/api/v1/atendimento';

/**
 * Conversas do Atendimento (R12): visibilidade por papel, filtros e
 * contadores, assumir, transferir com nota, resolver/reabrir, etiquetas,
 * marcar como lida, criar negócio, histórico e desligamento (R7).
 */
describe('Atendimento — conversas (e2e)', () => {
  let t: AppTeste;
  let cenario: CenarioDoAtendimento;
  let desfazer: (() => void) | undefined;

  beforeAll(async () => {
    t = await criarAppTeste();
  });
  beforeEach(async () => {
    await t.limparBanco();
    cenario = await montarCenario(t);
    ({ desfazer } = usarAdaptadorFalso(t, 'WEBCHAT'));
  });
  afterEach(() => {
    desfazer?.();
    desfazer = undefined;
  });
  afterAll(() => t.fechar());

  /** A, B (com Ana e Bia), C (sem responsável) na fila comercial; D na fila de CS; E sem fila. */
  async function cincoConversas(): Promise<Record<string, Conversa>> {
    const [ana, bia] = cenario.comercial.membros;
    const nova = async (
      nome: string,
      dados: Parameters<typeof criarConversa>[1],
    ) => {
      const contato = await criarContato(t, { nome });
      const conversa = await criarConversa(t, {
        canal: cenario.canal,
        contato,
        ...dados,
      });
      await criarMensagem(t, { conversa, texto: `Oi, sou ${nome}` });
      return conversa;
    };
    return {
      A: await nova('Alice', { fila: cenario.fila, responsavel: ana }),
      B: await nova('Bruno', { fila: cenario.fila, responsavel: bia }),
      C: await nova('Carla', { fila: cenario.fila }),
      D: await nova('Davi', { fila: cenario.filaCs }),
      E: await nova('Eva', { fila: null }),
    };
  }

  async function idsVistos(
    usuario: Parameters<typeof entrarComo>[1],
    query = '',
  ) {
    const resposta = await (
      await entrarComo(t, usuario)
    )
      .get(`${BASE}/conversas${query}`)
      .expect(200);
    return {
      corpo: resposta.body as {
        itens: Array<{ id: string }>;
        total: number;
        contadores: Record<string, number>;
      },
      ids: (resposta.body.itens as Array<{ id: string }>).map(
        (item) => item.id,
      ),
    };
  }

  describe('visibilidade (R12)', () => {
    it('cenário 20 — Admin e C-level tudo; líder as filas da área; membro as suas e as sem responsável da área; Marketing nada', async () => {
      const c = await cincoConversas();
      const [ana, bia] = cenario.comercial.membros;
      const todas = [c.A, c.B, c.C, c.D, c.E].map((x) => x.id).sort();
      expect((await idsVistos(cenario.admin)).ids.sort()).toEqual(todas);
      expect((await idsVistos(cenario.comercial.cLevel)).ids.sort()).toEqual(
        todas,
      );
      expect((await idsVistos(cenario.comercial.lider)).ids.sort()).toEqual(
        [c.A.id, c.B.id, c.C.id].sort(),
      );
      expect((await idsVistos(ana)).ids.sort()).toEqual(
        [c.A.id, c.C.id].sort(),
      );
      expect((await idsVistos(bia)).ids.sort()).toEqual(
        [c.B.id, c.C.id].sort(),
      );
      expect((await idsVistos(cenario.cs.membros[0])).ids).toEqual([c.D.id]);

      const marketing = await entrarComo(t, cenario.marketing);
      const recusa = await marketing.get(`${BASE}/conversas`).expect(403);
      expect(recusa.body).toMatchObject({
        erro: 'sem_permissao',
        detalhes: { regra: 'R12' },
      });
      expect(recusa.body.mensagem).not.toContain('R12');
      await marketing.get(`${BASE}/conversas/${c.A.id}`).expect(403);

      const cliente = await entrarComo(t, ana);
      await cliente.get(`${BASE}/conversas/${c.B.id}`).expect(404);
      const detalhe = await cliente
        .get(`${BASE}/conversas/${c.A.id}`)
        .expect(200);
      expect(detalhe.body).toMatchObject({
        id: c.A.id,
        contato: { nome: 'Alice' },
        responsavel: { id: ana.id },
        fila: { id: cenario.fila.id, area: 'COMERCIAL' },
        naoLidas: 1,
        podeResponder: { pode: true },
        acoes: {
          assumir: false,
          transferir: true,
          resolver: true,
          reabrir: false,
          responder: true,
        },
      });
    });

    it('escopos, filtros e contadores', async () => {
      const c = await cincoConversas();
      const [ana] = cenario.comercial.membros;
      await t.prisma.conversa.update({
        where: { id: c.A.id },
        data: { etiquetas: ['VIP'], prioridade: 'ALTA' },
      });
      const minhas = await idsVistos(ana, '?escopo=minhas');
      expect(minhas.ids).toEqual([c.A.id]);
      expect(minhas.corpo.contadores).toEqual({
        minhas: 1,
        semResponsavel: 1,
        todas: 2,
        naoLidas: 2,
      });
      expect((await idsVistos(ana, '?escopo=SEM_RESPONSAVEL')).ids).toEqual([
        c.C.id,
      ]);
      expect((await idsVistos(cenario.admin, '?etiqueta=VIP')).ids).toEqual([
        c.A.id,
      ]);
      expect(
        (await idsVistos(cenario.admin, '?prioridade=ALTA,URGENTE')).ids,
      ).toEqual([c.A.id]);
      expect((await idsVistos(cenario.admin, '?busca=carl')).ids).toEqual([
        c.C.id,
      ]);
      expect(
        (await idsVistos(cenario.admin, `?filaId=${cenario.filaCs.id}`)).ids,
      ).toEqual([c.D.id]);
      expect((await idsVistos(cenario.admin, '?tipoCanal=EMAIL')).ids).toEqual(
        [],
      );
      await t.prisma.conversa.update({
        where: { id: c.E.id },
        data: { status: 'RESOLVIDA', resolvidaEm: new Date() },
      });
      expect((await idsVistos(cenario.admin, '?status=RESOLVIDA')).ids).toEqual(
        [c.E.id],
      );
      expect(
        (
          await idsVistos(
            cenario.admin,
            `?contatoId=${c.E.contatoId}&status=ABERTA,RESOLVIDA`,
          )
        ).ids,
      ).toEqual([c.E.id]);
      await (
        await entrarComo(t, ana)
      )
        .get(`${BASE}/conversas?status=FECHADA`)
        .expect(400);
      const contagem = await (
        await entrarComo(t, ana)
      )
        .get(`${BASE}/nao-lidas`)
        .expect(200);
      expect(contagem.body).toEqual({ atendimento: 2 });
    });
  });

  describe('assumir e transferir', () => {
    it('R12 — assume a sem responsável; 409 se alguém já assumiu', async () => {
      const c = await cincoConversas();
      const [, bia] = cenario.comercial.membros;
      const resposta = await (
        await entrarComo(t, bia)
      )
        .post(`${BASE}/conversas/${c.C.id}/assumir`)
        .expect(200);
      expect(resposta.body).toMatchObject({
        responsavel: { id: bia.id },
        acoes: { assumir: false },
      });
      const lider = await entrarComo(t, cenario.comercial.lider);
      const conflito = await lider
        .post(`${BASE}/conversas/${c.C.id}/assumir`)
        .expect(409);
      expect(conflito.body.mensagem).toContain(bia.nome);
      expect(
        await t.prisma.mensagem.findFirst({
          where: { conversaId: c.C.id, direcao: 'SISTEMA' },
        }),
      ).toMatchObject({ texto: `${bia.nome} assumiu a conversa.` });
      expect(
        await t.prisma.eventoAuditoria.count({
          where: { acao: 'conversa.assumida', entidadeId: c.C.id },
        }),
      ).toBe(1);
      // Agora é da Bia: a Ana não vê mais.
      await (
        await entrarComo(t, cenario.comercial.membros[0])
      )
        .get(`${BASE}/conversas/${c.C.id}`)
        .expect(404);
    });

    it('cenário 21 — R12: transfere para pessoa com nota (histórico, aviso, notificação, auditoria)', async () => {
      const c = await cincoConversas();
      const [ana, bia] = cenario.comercial.membros;
      const cliente = await entrarComo(t, ana);
      const resposta = await cliente
        .post(`${BASE}/conversas/${c.A.id}/transferir`, {
          usuarioId: bia.id,
          nota: 'Cliente pediu proposta; segue com você.',
        })
        .expect(200);
      expect(resposta.body).toMatchObject({
        responsavel: { id: bia.id },
        acoes: { transferir: false, responder: false },
      });
      const historico = await t.prisma.conversaAtribuicao.findFirstOrThrow({
        where: { conversaId: c.A.id },
      });
      expect(historico).toMatchObject({
        motivo: 'TRANSFERENCIA',
        deUsuarioId: ana.id,
        paraUsuarioId: bia.id,
        nota: 'Cliente pediu proposta; segue com você.',
        porUsuarioId: ana.id,
        tipoAtor: 'USUARIO',
      });
      expect(
        await t.prisma.notificacao.findFirstOrThrow({
          where: { usuarioId: bia.id, tipo: 'conversa.transferida' },
        }),
      ).toMatchObject({
        titulo: `${ana.nome} transferiu uma conversa para você`,
        link: `/atendimento/${c.A.id}`,
      });
      const aviso = await t.prisma.mensagem.findFirstOrThrow({
        where: { conversaId: c.A.id, direcao: 'SISTEMA' },
      });
      expect(aviso.texto).toContain(`transferiu a conversa para ${bia.nome}`);
      expect(aviso.texto).toContain('Nota: Cliente pediu proposta');
      expect(
        await t.prisma.eventoAuditoria.findFirstOrThrow({
          where: { acao: 'conversa.transferida', entidadeId: c.A.id },
        }),
      ).toMatchObject({ usuarioId: ana.id });
      await cliente.get(`${BASE}/conversas/${c.A.id}`).expect(404);

      const lista = await (
        await entrarComo(t, bia)
      )
        .get(`${BASE}/conversas/${c.A.id}/atribuicoes`)
        .expect(200);
      expect(lista.body).toEqual([
        expect.objectContaining({
          motivo: 'TRANSFERENCIA',
          de: expect.objectContaining({ id: ana.id }),
          para: expect.objectContaining({ id: bia.id }),
          por: expect.objectContaining({ id: ana.id }),
        }),
      ]);
    });

    it('transfere para outra fila (a fila distribui); outra área exige a fila; erros claros', async () => {
      const c = await cincoConversas();
      const [ana, bia] = cenario.comercial.membros;
      const cs = cenario.cs.membros[0];
      const cliente = await entrarComo(t, ana);

      await cliente
        .post(`${BASE}/conversas/${c.A.id}/transferir`, {})
        .expect(400);
      const outraArea = await cliente
        .post(`${BASE}/conversas/${c.A.id}/transferir`, { usuarioId: cs.id })
        .expect(422);
      expect(outraArea.body.mensagem).toContain('escolha também uma fila');
      await cliente
        .post(`${BASE}/conversas/${c.A.id}/transferir`, {
          usuarioId: cenario.marketing.id,
        })
        .expect(422);
      await cliente
        .post(`${BASE}/conversas/${c.A.id}/transferir`, { usuarioId: ana.id })
        .expect(409);
      await cliente
        .post(`${BASE}/conversas/${c.A.id}/transferir`, {
          usuarioId: bia.id,
          filaId: cenario.filaCs.id,
        })
        .expect(422);

      await t.prisma.filaAtendimento.update({
        where: { id: cenario.filaCs.id },
        data: { slaPrimeiraRespostaMinutos: 30 },
      });
      await cliente
        .post(`${BASE}/conversas/${c.A.id}/transferir`, {
          filaId: cenario.filaCs.id,
          nota: 'É sobre o contrato',
        })
        .expect(200);
      const depois = await t.prisma.conversa.findUniqueOrThrow({
        where: { id: c.A.id },
      });
      expect(depois).toMatchObject({
        filaId: cenario.filaCs.id,
        responsavelId: cs.id,
      });
      expect(depois.slaPrimeiraRespostaAte?.getTime()).toBe(
        c.A.criadoEm.getTime() + 30 * 60_000,
      );
      const motivos = await t.prisma.conversaAtribuicao.findMany({
        where: { conversaId: c.A.id },
        orderBy: { criadoEm: 'asc' },
      });
      expect(
        motivos.map((m) => [m.motivo, m.paraUsuarioId, m.paraFilaId]),
      ).toEqual([
        ['TRANSFERENCIA', null, cenario.filaCs.id],
        ['DISTRIBUICAO', cs.id, cenario.filaCs.id],
      ]);
    });
  });

  describe('resolver, reabrir e demais ações', () => {
    it('R12 — resolve (409 se já resolvida) e reabre (409 com outra em aberto)', async () => {
      const c = await cincoConversas();
      const [ana] = cenario.comercial.membros;
      const cliente = await entrarComo(t, ana);
      const resolvida = await cliente
        .post(`${BASE}/conversas/${c.A.id}/resolver`, {})
        .expect(200);
      expect(resolvida.body).toMatchObject({
        status: 'RESOLVIDA',
        naoLidas: 0,
        resolvidaPor: { id: ana.id },
        aguardandoDesde: null,
        acoes: { reabrir: true, resolver: false, responder: false },
        satisfacao: { solicitadaEm: null, aguardando: false },
      });
      await cliente
        .post(`${BASE}/conversas/${c.A.id}/resolver`, {})
        .expect(409);
      await cliente
        .patch(`${BASE}/conversas/${c.A.id}`, { status: 'PENDENTE' })
        .expect(422);

      const reaberta = await cliente
        .post(`${BASE}/conversas/${c.A.id}/reabrir`)
        .expect(200);
      expect(reaberta.body).toMatchObject({
        status: 'ABERTA',
        reaberturas: 1,
        resolvidaEm: null,
        responsavel: { id: ana.id },
      });
      await cliente.post(`${BASE}/conversas/${c.A.id}/reabrir`).expect(409);

      await cliente
        .post(`${BASE}/conversas/${c.A.id}/resolver`, {})
        .expect(200);
      const outra = await criarConversa(t, {
        canal: cenario.canal,
        contato: c.A.contatoId,
        fila: cenario.fila,
        responsavel: ana,
      });
      const conflito = await cliente
        .post(`${BASE}/conversas/${c.A.id}/reabrir`)
        .expect(409);
      expect(conflito.body.detalhes).toEqual({ conversaId: outra.id });
      const acoes = await t.prisma.eventoAuditoria.findMany({
        where: { entidadeId: c.A.id },
        select: { acao: true },
        orderBy: { id: 'asc' },
      });
      expect(acoes.map((a) => a.acao)).toEqual([
        'conversa.resolvida',
        'conversa.reaberta',
        'conversa.resolvida',
      ]);
    });

    it('reabrir sem responsável ativo: fica com quem reabriu', async () => {
      const c = await cincoConversas();
      await t.prisma.conversa.update({
        where: { id: c.C.id },
        data: { status: 'RESOLVIDA', resolvidaEm: new Date() },
      });
      const lider = cenario.comercial.lider;
      const resposta = await (
        await entrarComo(t, lider)
      )
        .post(`${BASE}/conversas/${c.C.id}/reabrir`)
        .expect(200);
      expect(resposta.body.responsavel).toMatchObject({ id: lider.id });
    });

    it('PATCH: etiquetas, prioridade, pendente e negócio ligado (só do mesmo contato)', async () => {
      const c = await cincoConversas();
      const [ana] = cenario.comercial.membros;
      const cliente = await entrarComo(t, ana);
      const resposta = await cliente
        .patch(`${BASE}/conversas/${c.A.id}`, {
          etiquetas: [' VIP ', 'vip', 'Orçamento'],
          prioridade: 'urgente',
          status: 'PENDENTE',
          assunto: '  Proposta  ',
        })
        .expect(200);
      expect(resposta.body).toMatchObject({
        etiquetas: ['VIP', 'Orçamento'],
        prioridade: 'URGENTE',
        status: 'PENDENTE',
        assunto: 'Proposta',
      });
      expect((await cliente.get(`${BASE}/etiquetas`).expect(200)).body).toEqual(
        ['Orçamento', 'VIP'],
      );
      const doContato = await criarNegocio(t, {
        contato: c.A.contatoId,
        responsavel: ana,
      });
      const deOutro = await criarNegocio(t, { responsavel: ana });
      await cliente
        .patch(`${BASE}/conversas/${c.A.id}`, { negocioId: deOutro.id })
        .expect(422);
      const ligada = await cliente
        .patch(`${BASE}/conversas/${c.A.id}`, { negocioId: doContato.id })
        .expect(200);
      expect(ligada.body.negocio).toMatchObject({ id: doContato.id });
      expect(
        await t.prisma.eventoAuditoria.count({
          where: { acao: 'conversa.atualizada', entidadeId: c.A.id },
        }),
      ).toBe(2);
    });

    it('marcar como lida: o responsável zera; o líder que só olha não', async () => {
      const c = await cincoConversas();
      const [ana] = cenario.comercial.membros;
      await (
        await entrarComo(t, cenario.comercial.lider)
      )
        .post(`${BASE}/conversas/${c.A.id}/lida`)
        .expect(200);
      expect(
        (await t.prisma.conversa.findUniqueOrThrow({ where: { id: c.A.id } }))
          .naoLidas,
      ).toBe(1);
      const resposta = await (
        await entrarComo(t, ana)
      )
        .post(`${BASE}/conversas/${c.A.id}/lida`)
        .expect(200);
      expect(resposta.body.naoLidas).toBe(0);
      expect(
        await t.prisma.mensagem.count({
          where: { conversaId: c.A.id, direcao: 'ENTRADA', lidaEm: null },
        }),
      ).toBe(0);
    });

    it('cria negócio a partir da conversa (funil-base da área da fila, origem = canal)', async () => {
      const c = await cincoConversas();
      const [ana] = cenario.comercial.membros;
      const cliente = await entrarComo(t, ana);
      const criado = await cliente
        .post(`${BASE}/conversas/${c.A.id}/negocio`, { valor: '1500.00' })
        .expect(201);
      expect(criado.body).toMatchObject({
        titulo: 'Alice',
        valor: '1500.00',
        origem: 'SITE',
        origemDetalhe: cenario.canal.nome,
        funil: { area: 'COMERCIAL' },
        contato: { id: c.A.contatoId },
        responsavel: { id: ana.id },
      });
      const detalhe = await cliente
        .get(`${BASE}/conversas/${c.A.id}`)
        .expect(200);
      expect(detalhe.body.negocio).toMatchObject({
        id: criado.body.id,
        status: 'ABERTO',
      });
      expect(
        await t.prisma.mensagem.findFirst({
          where: { conversaId: c.A.id, direcao: 'SISTEMA' },
        }),
      ).toMatchObject({
        texto: expect.stringContaining('criou o negócio "Alice"'),
      });
    });

    it('atendentes: quem pode receber, com a carga atual', async () => {
      await cincoConversas();
      const [ana, bia] = cenario.comercial.membros;
      const cliente = await entrarComo(t, ana);
      const resposta = await cliente
        .get(`${BASE}/atendentes?area=comercial`)
        .expect(200);
      // O Marketing não atende: a área dele é recusada no filtro.
      await cliente.get(`${BASE}/atendentes?area=MARKETING`).expect(400);
      const porId = new Map(
        (
          resposta.body as Array<{
            id: string;
            emAberto: number;
            conectado: boolean;
          }>
        ).map((item) => [item.id, item]),
      );
      expect(porId.size).toBe(3);
      expect(porId.get(ana.id)).toMatchObject({
        emAberto: 1,
        conectado: false,
      });
      expect(porId.get(bia.id)).toMatchObject({ emAberto: 1 });
      expect(porId.has(cenario.marketing.id)).toBe(false);
    });
  });

  describe('desligamento (R7)', () => {
    it('as conversas em aberto de quem saiu vão para o destinatário', async () => {
      const c = await cincoConversas();
      const [ana] = cenario.comercial.membros;
      const resolvida = await criarConversa(t, {
        canal: await criarCanal(t),
        responsavel: ana,
        status: 'RESOLVIDA',
      });
      await (
        await entrarComo(t, cenario.admin)
      )
        .post(`/api/v1/usuarios/${ana.id}/desligar`, {})
        .expect(200);
      await processarEventos(t);
      const lider = cenario.comercial.lider;
      expect(
        await t.prisma.conversa.findUniqueOrThrow({ where: { id: c.A.id } }),
      ).toMatchObject({ responsavelId: lider.id });
      expect(
        (
          await t.prisma.conversa.findUniqueOrThrow({
            where: { id: resolvida.id },
          })
        ).responsavelId,
      ).toBe(ana.id);
      expect(
        await t.prisma.conversaAtribuicao.findFirstOrThrow({
          where: { conversaId: c.A.id },
        }),
      ).toMatchObject({ motivo: 'DESLIGAMENTO', paraUsuarioId: lider.id });
      expect(
        await t.prisma.notificacao.findFirstOrThrow({
          where: { usuarioId: lider.id, tipo: 'conversa.encaminhadas' },
        }),
      ).toMatchObject({ titulo: `Você recebeu 1 conversa de ${ana.nome}` });
      // Reentrega da outbox não faz nada de novo.
      await processarEventos(t, { incluirAgendados: true });
      expect(
        await t.prisma.conversaAtribuicao.count({
          where: { conversaId: c.A.id },
        }),
      ).toBe(1);
    });
  });
});
