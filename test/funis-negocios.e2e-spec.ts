import { executarComoAtor } from '../src/comum/contexto/contexto-requisicao';
import { NegociosService } from '../src/funis/negocios.service';
import { TIPOS_NOTIFICACAO } from '../src/notificacoes/tipos-notificacao';
import { cartoesDaColuna, esperarAte, mover } from './funis-apoio';
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
  funilBase,
} from './utils';

interface NegocioResposta {
  id: string;
  titulo: string;
  status: string;
  posicao: number;
  responsavel: { id: string } | null;
}

describe('Negócios (e2e)', () => {
  let t: AppTeste;

  beforeAll(async () => {
    t = await criarAppTeste();
  });

  beforeEach(() => t.limparBanco());

  afterAll(() => t.fechar());

  describe('criação e edição (R5.3)', () => {
    it('R5.3 — cria com os padrões: primeira etapa aberta, título e empresa do contato, quem cria como responsável, status aberto', async () => {
      const {
        membros: [ana],
      } = await criarEquipe(t, 'COMERCIAL', { membros: 1 });
      const empresa = await criarEmpresa(t, { nome: 'ACME' });
      const contato = await criarContato(t, { nome: 'Maria Lima', empresa });
      const comercial = await funilBase(t, 'COMERCIAL');
      const comoAna = await entrarComo(t, ana);

      const criado = await comoAna
        .post('/api/v1/negocios', {
          contatoId: contato.id,
          funilId: comercial.id,
          valor: '1500',
          valorRecorrente: '99.9',
          previsaoFechamento: '2026-12-15',
          utm: { source: 'google', medium: 'cpc' },
        })
        .expect(201);
      expect(criado.body).toMatchObject({
        titulo: 'Maria Lima',
        status: 'ABERTO',
        valor: '1500.00',
        valorRecorrente: '99.90',
        previsaoFechamento: '2026-12-15',
        etapa: { nome: 'Novo', tipo: 'ABERTA' },
        funil: { id: comercial.id, area: 'COMERCIAL' },
        contato: { id: contato.id, nome: 'Maria Lima' },
        empresa: { id: empresa.id, nome: 'ACME' },
        responsavel: { id: ana.id },
        origem: 'MANUAL',
        utm: { source: 'google', medium: 'cpc' },
        parado: false,
        diasNaEtapa: 0,
        negocioOrigemId: null,
      });

      const historico = await comoAna
        .get(`/api/v1/negocios/${criado.body.id}/movimentacoes`)
        .expect(200);
      expect(historico.body).toEqual([
        expect.objectContaining({
          deEtapa: null,
          paraEtapa: expect.objectContaining({ nome: 'Novo' }),
          usuario: expect.objectContaining({ id: ana.id }),
          tipoAtor: 'USUARIO',
          segundosNaEtapaAnterior: null,
        }),
      ]);
      const auditoria = await t.prisma.eventoAuditoria.findFirstOrThrow({
        where: { acao: 'negocio.criado', entidadeId: criado.body.id },
      });
      expect(auditoria.relacionados).toEqual(
        expect.arrayContaining([
          `contato:${contato.id}`,
          `empresa:${empresa.id}`,
          `funil:${comercial.id}`,
        ]),
      );
      const evento = await t.prisma.eventoDominio.findFirstOrThrow({
        where: { tipo: 'negocio.criado' },
      });
      expect(evento.dados).toMatchObject({
        negocioId: criado.body.id,
        negocio: { valor: '1500.00', contato: { id: contato.id } },
      });
      // Quem cria para si não é notificado.
      expect(await t.prisma.notificacao.count()).toBe(0);
    });

    it('R5.3 — valida valor, contato, etapa do funil e responsável', async () => {
      const {
        lider,
        membros: [ana],
      } = await criarEquipe(t, 'COMERCIAL', { membros: 1 });
      const {
        membros: [marketing],
      } = await criarEquipe(t, 'MARKETING', { membros: 1 });
      const contato = await criarContato(t);
      const comercial = await funilBase(t, 'COMERCIAL');
      const novoLead = await etapaDoFunilBase(t, 'MARKETING', 'novo_lead');
      const comoLider = await entrarComo(t, lider);
      const base = { contatoId: contato.id, funilId: comercial.id };

      const negativo = await comoLider
        .post('/api/v1/negocios', { ...base, valor: '-10' })
        .expect(400);
      expect(negativo.body.detalhes.campos[0].campo).toBe('valor');
      await comoLider
        .post('/api/v1/negocios', { ...base, valor: '10.123' })
        .expect(400);
      await comoLider
        .post('/api/v1/negocios', { ...base, previsaoFechamento: '2026-02-30' })
        .expect(400);
      await comoLider
        .post('/api/v1/negocios', { ...base, intruso: true })
        .expect(400);

      const outroFunil = await comoLider
        .post('/api/v1/negocios', { ...base, etapaId: novoLead.id })
        .expect(422);
      expect(outroFunil.body.detalhes.regra).toBe('R5.4');
      const semContato = await comoLider
        .post('/api/v1/negocios', {
          ...base,
          contatoId: '00000000-0000-4000-8000-000000000000',
        })
        .expect(422);
      expect(semContato.body.detalhes.regra).toBe('R5.3');
      const deOutraArea = await comoLider
        .post('/api/v1/negocios', { ...base, responsavelId: marketing.id })
        .expect(422);
      expect(deOutraArea.body.detalhes.regra).toBe('R5.13');

      const paraAna = await comoLider
        .post('/api/v1/negocios', {
          ...base,
          titulo: 'Plano anual',
          responsavelId: ana.id,
        })
        .expect(201);
      expect(paraAna.body.responsavel.id).toBe(ana.id);
      const notificacao = await t.prisma.notificacao.findFirstOrThrow({
        where: { usuarioId: ana.id },
      });
      expect(notificacao).toMatchObject({
        tipo: TIPOS_NOTIFICACAO.NEGOCIO_ATRIBUIDO,
        link: `/funis/${comercial.id}?negocio=${paraAna.body.id}`,
      });

      // Sem responsável (para alguém da área assumir).
      const semDono = await comoLider
        .post('/api/v1/negocios', { ...base, responsavelId: null })
        .expect(201);
      expect(semDono.body.responsavel).toBeNull();
    });

    it('R3.1 — edição audita campo a campo e avisa o novo responsável', async () => {
      const {
        lider,
        membros: [ana, bruno],
      } = await criarEquipe(t, 'COMERCIAL');
      const negocio = await criarNegocio(t, { responsavel: ana, valor: '100' });
      const comoLider = await entrarComo(t, lider);

      const editado = await comoLider
        .patch(`/api/v1/negocios/${negocio.id}`, {
          titulo: 'Contrato 2027',
          valor: '250.50',
          responsavelId: bruno.id,
          previsaoFechamento: '2027-01-31',
        })
        .expect(200);
      expect(editado.body).toMatchObject({
        titulo: 'Contrato 2027',
        valor: '250.50',
        responsavel: { id: bruno.id },
        previsaoFechamento: '2027-01-31',
      });
      const auditoria = await t.prisma.eventoAuditoria.findFirstOrThrow({
        where: { acao: 'negocio.atualizado', entidadeId: negocio.id },
      });
      expect(auditoria.dados).toMatchObject({
        alteracoes: {
          titulo: { depois: 'Contrato 2027' },
          valor: { antes: '100.00', depois: '250.50' },
          responsavelId: { antes: ana.id, depois: bruno.id },
          previsaoFechamento: { antes: null },
        },
      });
      expect(
        await t.prisma.notificacao.count({
          where: {
            usuarioId: bruno.id,
            tipo: TIPOS_NOTIFICACAO.NEGOCIO_ATRIBUIDO,
          },
        }),
      ).toBe(1);

      const motivo = await comoLider
        .patch(`/api/v1/negocios/${negocio.id}`, { motivoPerda: 'Preço' })
        .expect(422);
      expect(motivo.body.detalhes.regra).toBe('R5.5');
      await comoLider
        .patch(`/api/v1/negocios/${negocio.id}`, { etapaId: negocio.etapaId })
        .expect(400);
    });
  });

  describe('movimentação (R5.4, R5.5)', () => {
    it('R5.4 — grava de onde, para onde, quem, quando e o tempo na etapa anterior; audita e publica o evento', async () => {
      const {
        membros: [ana],
      } = await criarEquipe(t, 'COMERCIAL', { membros: 1 });
      const negocio = await criarNegocio(t, { responsavel: ana });
      await t.prisma.negocio.update({
        where: { id: negocio.id },
        data: { etapaDesde: new Date(Date.now() - 2 * 3_600_000) },
      });
      const novo = await etapaDoFunilBase(t, 'COMERCIAL', 'novo');
      const qualificacao = await etapaDoFunilBase(
        t,
        'COMERCIAL',
        'qualificacao',
      );
      const comoAna = await entrarComo(t, ana);

      const movido = await mover(comoAna, negocio.id, qualificacao.id).expect(
        200,
      );
      expect(movido.body.negocio).toMatchObject({
        status: 'ABERTO',
        etapa: { id: qualificacao.id },
        diasNaEtapa: 0,
      });
      expect(movido.body.passagens).toEqual([]);

      const movimentacoes = await t.prisma.negocioMovimentacao.findMany({
        where: { negocioId: negocio.id },
        orderBy: { criadoEm: 'asc' },
      });
      expect(movimentacoes).toHaveLength(2);
      expect(movimentacoes[1]).toMatchObject({
        deEtapaId: novo.id,
        paraEtapaId: qualificacao.id,
        usuarioId: ana.id,
        tipoAtor: 'USUARIO',
      });
      expect(movimentacoes[1].segundosNaEtapaAnterior).toBeGreaterThanOrEqual(
        7_190,
      );
      expect(movimentacoes[1].segundosNaEtapaAnterior).toBeLessThan(7_400);

      const auditoria = await t.prisma.eventoAuditoria.findFirstOrThrow({
        where: { acao: 'negocio.movido', entidadeId: negocio.id },
      });
      expect(auditoria).toMatchObject({
        tipoAtor: 'USUARIO',
        usuarioId: ana.id,
        dados: {
          deEtapa: { nome: 'Novo' },
          paraEtapa: { nome: 'Qualificação' },
        },
      });
      const evento = await t.prisma.eventoDominio.findFirstOrThrow({
        where: { tipo: 'negocio.movido' },
      });
      expect(evento.dados).toMatchObject({
        negocioId: negocio.id,
        deEtapa: { id: novo.id },
        paraEtapa: { id: qualificacao.id },
      });

      // A mesma etapa sem posição não muda nada.
      await mover(comoAna, negocio.id, qualificacao.id).expect(200);
      expect(
        await t.prisma.negocioMovimentacao.count({
          where: { negocioId: negocio.id },
        }),
      ).toBe(2);
    });

    it('R5.4 — não se move para a etapa de outro funil (é papel das passagens)', async () => {
      const admin = await entrarComo(t, await criarUsuario(t));
      const negocio = await criarNegocio(t);
      const boasVindas = await etapaDoFunilBase(t, 'CS', 'boas_vindas');
      const resposta = await mover(admin, negocio.id, boasVindas.id).expect(
        422,
      );
      expect(resposta.body.detalhes.regra).toBe('R5.4');
      await mover(
        admin,
        negocio.id,
        '00000000-0000-4000-8000-000000000000',
      ).expect(404);
    });

    it('cenário 11 — R5.5: mover para perda sem motivo → 400; com motivo grava a data de perda', async () => {
      const {
        membros: [ana],
      } = await criarEquipe(t, 'COMERCIAL', { membros: 1 });
      const negocio = await criarNegocio(t, { responsavel: ana });
      const perdido = await etapaDoFunilBase(t, 'COMERCIAL', 'perdido');
      const comoAna = await entrarComo(t, ana);

      const semMotivo = await mover(comoAna, negocio.id, perdido.id).expect(
        400,
      );
      expect(semMotivo.body).toMatchObject({
        erro: 'dados_invalidos',
        detalhes: {
          regra: 'R5.5',
          campos: [
            {
              campo: 'motivoPerda',
              mensagens: ['é obrigatório ao entrar numa etapa de perda'],
            },
          ],
        },
      });
      await mover(comoAna, negocio.id, perdido.id, {
        motivoPerda: '   ',
      }).expect(400);
      expect(
        (
          await t.prisma.negocio.findUniqueOrThrow({
            where: { id: negocio.id },
          })
        ).status,
      ).toBe('ABERTO');

      const perdeu = await mover(comoAna, negocio.id, perdido.id, {
        motivoPerda: 'Sem orçamento',
      }).expect(200);
      expect(perdeu.body.negocio).toMatchObject({
        status: 'PERDIDO',
        motivoPerda: 'Sem orçamento',
        ganhoEm: null,
      });
      expect(perdeu.body.negocio.perdidoEm).toEqual(expect.any(String));
      expect(
        await t.prisma.eventoDominio.count({
          where: { tipo: 'negocio.perdido' },
        }),
      ).toBe(1);
      expect(
        await t.prisma.eventoAuditoria.count({
          where: { acao: 'negocio.perdido', entidadeId: negocio.id },
        }),
      ).toBe(1);
    });

    it('R5.5 — ganhar registra a data; reabrir é só do líder da área, do C-level e do Admin', async () => {
      const {
        lider,
        membros: [ana],
      } = await criarEquipe(t, 'COMERCIAL', { membros: 1 });
      const { lider: liderMarketing } = await criarEquipe(t, 'MARKETING', {
        membros: 0,
      });
      const negocio = await criarNegocio(t, {
        responsavel: ana,
        etapa: 'negociacao',
      });
      const negociacao = await etapaDoFunilBase(t, 'COMERCIAL', 'negociacao');
      const ganho = await etapaDoFunilBase(t, 'COMERCIAL', 'ganho');
      const comoAna = await entrarComo(t, ana);

      const ganhou = await mover(comoAna, negocio.id, ganho.id).expect(200);
      expect(ganhou.body.negocio.status).toBe('GANHO');
      expect(ganhou.body.negocio.ganhoEm).toEqual(expect.any(String));

      const membroReabre = await comoAna
        .post(`/api/v1/negocios/${negocio.id}/reabrir`, {})
        .expect(403);
      expect(membroReabre.body.detalhes.regra).toBe('R5.5');
      await mover(comoAna, negocio.id, negociacao.id).expect(403);
      await (
        await entrarComo(t, liderMarketing)
      )
        .post(`/api/v1/negocios/${negocio.id}/reabrir`, {})
        .expect(404);

      const reaberto = await (
        await entrarComo(t, lider)
      )
        .post(`/api/v1/negocios/${negocio.id}/reabrir`, {})
        .expect(200);
      expect(reaberto.body.negocio).toMatchObject({
        status: 'ABERTO',
        ganhoEm: null,
        etapa: { id: negociacao.id },
      });
      expect(
        await t.prisma.eventoAuditoria.count({
          where: { acao: 'negocio.reaberto', entidadeId: negocio.id },
        }),
      ).toBe(1);
      expect(
        await t.prisma.eventoDominio.count({
          where: { tipo: { in: ['negocio.ganho', 'negocio.reaberto'] } },
        }),
      ).toBe(2);
      await (
        await entrarComo(t, lider)
      )
        .post(`/api/v1/negocios/${negocio.id}/reabrir`, {})
        .expect(409);
    });
  });

  describe('visibilidade (R5.9)', () => {
    it('cenário 13 — um comercial não vê o negócio do outro; o líder vê os dois; o marketing não vê o funil comercial', async () => {
      const {
        lider,
        membros: [ana, bruno],
      } = await criarEquipe(t, 'COMERCIAL');
      const {
        membros: [marcia],
      } = await criarEquipe(t, 'MARKETING', { membros: 1 });
      const daAna = await criarNegocio(t, {
        responsavel: ana,
        titulo: 'Da Ana',
      });
      const doBruno = await criarNegocio(t, {
        responsavel: bruno,
        titulo: 'Do Bruno',
      });
      const semDono = await criarNegocio(t, { titulo: 'Sem dono' });
      const comercial = await funilBase(t, 'COMERCIAL');
      const qualificacao = await etapaDoFunilBase(
        t,
        'COMERCIAL',
        'qualificacao',
      );
      const titulos = (itens: NegocioResposta[]) =>
        itens.map((item) => item.titulo).sort();

      const comoAna = await entrarComo(t, ana);
      await comoAna.get(`/api/v1/negocios/${doBruno.id}`).expect(404);
      await mover(comoAna, doBruno.id, qualificacao.id).expect(404);
      await comoAna
        .patch(`/api/v1/negocios/${doBruno.id}`, { titulo: 'Meu' })
        .expect(404);
      const listaDaAna = await comoAna.get('/api/v1/negocios').expect(200);
      expect(titulos(listaDaAna.body.itens)).toEqual(['Da Ana', 'Sem dono']);
      const quadroDaAna = await comoAna
        .get(`/api/v1/funis/${comercial.id}/quadro`)
        .expect(200);
      expect(quadroDaAna.body.total).toBe(2);

      const comoLider = await entrarComo(t, lider);
      const listaDoLider = await comoLider.get('/api/v1/negocios').expect(200);
      expect(titulos(listaDoLider.body.itens)).toEqual([
        'Da Ana',
        'Do Bruno',
        'Sem dono',
      ]);
      await comoLider.get(`/api/v1/negocios/${doBruno.id}`).expect(200);

      const comoMarcia = await entrarComo(t, marcia);
      const funisDaMarcia = await comoMarcia.get('/api/v1/funis').expect(200);
      expect(
        (funisDaMarcia.body as { area: string }[]).map((funil) => funil.area),
      ).toEqual(['MARKETING']);
      await comoMarcia.get(`/api/v1/funis/${comercial.id}/quadro`).expect(404);
      await comoMarcia
        .get(`/api/v1/funis/${comercial.id}/metricas`)
        .expect(404);
      await comoMarcia.get(`/api/v1/negocios/${daAna.id}`).expect(404);
      expect(
        (await comoMarcia.get('/api/v1/negocios').expect(200)).body.total,
      ).toBe(0);

      // R5.9: o sem responsável pode ser assumido; depois some para o outro membro.
      const assumido = await comoAna
        .post(`/api/v1/negocios/${semDono.id}/assumir`)
        .expect(200);
      expect(assumido.body.responsavel.id).toBe(ana.id);
      const comoBruno = await entrarComo(t, bruno);
      await comoBruno.get(`/api/v1/negocios/${semDono.id}`).expect(404);
      await comoLider.post(`/api/v1/negocios/${daAna.id}/assumir`).expect(409);
      expect(
        await t.prisma.eventoAuditoria.count({
          where: { acao: 'negocio.assumido', entidadeId: semDono.id },
        }),
      ).toBe(1);
    });

    it('excluir — só líder da área, C-level e Admin; o excluído some das listas', async () => {
      const {
        lider,
        membros: [ana],
      } = await criarEquipe(t, 'COMERCIAL', { membros: 1 });
      const negocio = await criarNegocio(t, { responsavel: ana });
      await (
        await entrarComo(t, ana)
      )
        .delete(`/api/v1/negocios/${negocio.id}`)
        .expect(403);
      const comoLider = await entrarComo(t, lider);
      await comoLider.delete(`/api/v1/negocios/${negocio.id}`).expect(204);
      await comoLider.get(`/api/v1/negocios/${negocio.id}`).expect(404);
      expect((await comoLider.get('/api/v1/negocios')).body.total).toBe(0);
      expect(
        await t.prisma.eventoAuditoria.count({
          where: { acao: 'negocio.excluido', entidadeId: negocio.id },
        }),
      ).toBe(1);
    });
  });

  describe('quadro kanban', () => {
    it('posição fracionária: novos no topo, cartão entre dois outros e renumeração quando falta folga', async () => {
      const admin = await criarUsuario(t);
      const comoAdmin = await entrarComo(t, admin);
      const comercial = await funilBase(t, 'COMERCIAL');
      const novo = await etapaDoFunilBase(t, 'COMERCIAL', 'novo');
      const proposta = await etapaDoFunilBase(t, 'COMERCIAL', 'proposta');
      const criar = async (titulo: string) =>
        (
          await comoAdmin
            .post('/api/v1/negocios', {
              contatoId: (await criarContato(t)).id,
              funilId: comercial.id,
              titulo,
            })
            .expect(201)
        ).body as NegocioResposta;
      const a = await criar('A');
      const b = await criar('B');
      const c = await criar('C');
      const quadro = async () =>
        (
          await comoAdmin
            .get(`/api/v1/funis/${comercial.id}/quadro`)
            .expect(200)
        ).body;

      expect(cartoesDaColuna(await quadro(), novo.id)).toEqual([
        c.id,
        b.id,
        a.id,
      ]);

      // A entre C e B (reposicionar na mesma etapa não grava movimentação).
      await mover(comoAdmin, a.id, novo.id, {
        depoisDeId: c.id,
        antesDeId: b.id,
      }).expect(200);
      expect(cartoesDaColuna(await quadro(), novo.id)).toEqual([
        c.id,
        a.id,
        b.id,
      ]);
      expect(
        await t.prisma.negocioMovimentacao.count({
          where: { negocioId: a.id },
        }),
      ).toBe(1);
      expect(
        await t.prisma.eventoAuditoria.count({
          where: { acao: 'negocio.reposicionado', entidadeId: a.id },
        }),
      ).toBe(1);

      // Só com o de cima: logo abaixo dele.
      await mover(comoAdmin, c.id, novo.id, { depoisDeId: b.id }).expect(200);
      expect(cartoesDaColuna(await quadro(), novo.id)).toEqual([
        a.id,
        b.id,
        c.id,
      ]);

      // Sem folga entre os vizinhos (empatados, o quadro os mostra pelo id): a
      // etapa é renumerada e a ordem pedida vale.
      await t.prisma.negocio.updateMany({
        where: { id: { in: [a.id, b.id] } },
        data: { posicao: 7 },
      });
      const [deCima, deBaixo] = [a.id, b.id].sort();
      await mover(comoAdmin, c.id, novo.id, {
        depoisDeId: deCima,
        antesDeId: deBaixo,
      }).expect(200);
      const posicoes = await t.prisma.negocio.findMany({
        where: { etapaId: novo.id },
        orderBy: [{ posicao: 'asc' }, { id: 'asc' }],
        select: { id: true, posicao: true },
      });
      expect(posicoes.map(({ id }) => id)).toEqual([deCima, c.id, deBaixo]);
      expect(new Set(posicoes.map(({ posicao }) => posicao)).size).toBe(3);

      // Mudar de etapa: topo por padrão; referência de outra etapa → 400.
      await mover(comoAdmin, a.id, proposta.id).expect(200);
      await mover(comoAdmin, b.id, proposta.id, { depoisDeId: a.id }).expect(
        200,
      );
      expect(cartoesDaColuna(await quadro(), proposta.id)).toEqual([
        a.id,
        b.id,
      ]);
      const fora = await mover(comoAdmin, c.id, proposta.id, {
        depoisDeId: c.id,
      }).expect(400);
      expect(fora.body.detalhes.campos[0].campo).toBe('depoisDeId');
    });

    it('filtros: meus, equipe, todos, sem responsável, busca e etiqueta; totais por etapa', async () => {
      const cLevel = await criarUsuario(t, { papel: 'C_LEVEL' });
      const {
        lider,
        membros: [ana, bruno],
      } = await criarEquipe(t, 'COMERCIAL', { cLevel });
      const acme = await criarEmpresa(t, { nome: 'ACME Indústria' });
      const vip = await criarContato(t, {
        nome: 'Vera',
        empresa: acme,
        etiquetas: ['VIP'],
      });
      const joao = await criarContato(t, {
        nome: 'João',
        telefone: '11987654321',
      });
      const daAna = await criarNegocio(t, {
        responsavel: ana,
        contato: vip,
        empresa: acme,
        titulo: 'Plano anual',
        valor: '1000.00',
      });
      const doBruno = await criarNegocio(t, {
        responsavel: bruno,
        contato: joao,
        titulo: 'Implantação',
        valor: '500.50',
        etapa: 'proposta',
      });
      const doLider = await criarNegocio(t, {
        responsavel: lider,
        titulo: 'Conta estratégica',
      });
      const semDono = await criarNegocio(t, { titulo: 'Lead solto' });
      const comercial = await funilBase(t, 'COMERCIAL');
      const comoLider = await entrarComo(t, lider);
      const ids = async (consulta: string, cliente = comoLider) => {
        const resposta = await cliente
          .get(`/api/v1/funis/${comercial.id}/quadro${consulta}`)
          .expect(200);
        return (resposta.body.colunas as { negocios: { id: string }[] }[])
          .flatMap((coluna) => coluna.negocios.map(({ id }) => id))
          .sort();
      };

      expect(await ids('')).toEqual(
        [daAna.id, doBruno.id, doLider.id, semDono.id].sort(),
      );
      expect(await ids('?visao=MEUS')).toEqual([doLider.id]);
      expect(await ids('?visao=EQUIPE')).toEqual(
        [daAna.id, doBruno.id, doLider.id].sort(),
      );
      expect(await ids('?semResponsavel=true')).toEqual([semDono.id]);
      expect(await ids(`?responsavelId=${bruno.id}`)).toEqual([doBruno.id]);
      expect(await ids('?busca=acme')).toEqual([daAna.id]);
      expect(await ids('?busca=98765')).toEqual([doBruno.id]);
      expect(await ids(`?busca=${encodeURIComponent('estratég')}`)).toEqual([
        doLider.id,
      ]);
      expect(await ids('?etiqueta=vip')).toEqual([daAna.id]);
      expect(await ids('?etiqueta=inexistente')).toEqual([]);
      const comoCLevel = await entrarComo(t, cLevel);
      expect(await ids('?visao=EQUIPE', comoCLevel)).toEqual(
        [daAna.id, doBruno.id, doLider.id].sort(),
      );
      await comoLider
        .get(`/api/v1/funis/${comercial.id}/quadro?visao=OUTRA`)
        .expect(400);

      const quadro = await comoLider
        .get(`/api/v1/funis/${comercial.id}/quadro?limitePorEtapa=1`)
        .expect(200);
      expect(quadro.body).toMatchObject({
        funil: { id: comercial.id },
        total: 4,
        valorTotal: '1500.50',
      });
      const colunaNovo = quadro.body.colunas[0];
      expect(colunaNovo).toMatchObject({
        etapa: { chave: 'novo' },
        total: 3,
        valorTotal: '1000.00',
        temMais: true,
      });
      expect(colunaNovo.negocios).toHaveLength(1);
      expect(quadro.body.colunas[3]).toMatchObject({
        etapa: { chave: 'proposta' },
        total: 1,
        valorTotal: '500.50',
        temMais: false,
      });

      // A lista paginada carrega o resto de uma coluna, na ordem do quadro.
      const novo = await etapaDoFunilBase(t, 'COMERCIAL', 'novo');
      const resto = await comoLider
        .get(
          `/api/v1/negocios?etapaId=${novo.id}&ordenarPor=posicao&direcao=asc&pagina=2&porPagina=1`,
        )
        .expect(200);
      expect(resto.body).toMatchObject({ total: 3, pagina: 2, porPagina: 1 });
      expect(resto.body.itens).toHaveLength(1);
    });

    it('R5.10 — cartão parado: aberto há mais tempo que o prazo-alvo da etapa', async () => {
      const admin = await entrarComo(t, await criarUsuario(t));
      const parado = await criarNegocio(t, { titulo: 'Parado' });
      await t.prisma.negocio.update({
        where: { id: parado.id },
        data: { etapaDesde: new Date(Date.now() - 2 * 86_400_000) },
      });
      await criarNegocio(t, { titulo: 'Em dia' });
      const comercial = await funilBase(t, 'COMERCIAL');
      const quadro = await admin
        .get(`/api/v1/funis/${comercial.id}/quadro`)
        .expect(200);
      expect(quadro.body.colunas[0].parados).toBe(1);
      const cartoes = quadro.body.colunas[0].negocios as {
        titulo: string;
        parado: boolean;
        diasNaEtapa: number;
      }[];
      expect(cartoes.find((c) => c.titulo === 'Parado')).toMatchObject({
        parado: true,
        diasNaEtapa: 2,
      });
      expect(cartoes.find((c) => c.titulo === 'Em dia')?.parado).toBe(false);
      const lista = await admin
        .get('/api/v1/negocios?parados=true')
        .expect(200);
      expect(lista.body.itens.map((n: NegocioResposta) => n.id)).toEqual([
        parado.id,
      ]);
    });
  });

  describe('criação automática (R5.6) — contrato com os webhooks', () => {
    it('R5.6 — com negócio aberto do contato no funil registra a reconversão; sem, cria e distribui pelo rodízio', async () => {
      const {
        membros: [ana, bruno],
      } = await criarEquipe(t, 'MARKETING');
      const contato = await criarContato(t, { nome: 'Lia' });
      const marketing = await funilBase(t, 'MARKETING');
      const novoLead = await etapaDoFunilBase(t, 'MARKETING', 'novo_lead');
      const negocios = t.get(NegociosService);
      const criarPeloWebhook = () =>
        executarComoAtor({ tipoAtor: 'WEBHOOK', descricao: 'Landing' }, () =>
          t.prisma.$transaction((tx) =>
            negocios.criarAutomatico(tx, {
              contatoId: contato.id,
              funilId: marketing.id,
              etapaId: novoLead.id,
              valor: '10.5',
              origem: 'WEBHOOK',
              origemDetalhe: 'Landing',
              utm: { source: 'google', campaign: 'outubro' },
              estrategia: 'RODIZIO',
            }),
          ),
        );

      const primeiro = await criarPeloWebhook();
      expect(primeiro).toMatchObject({ criado: true, reconversao: false });
      expect(primeiro.negocio).toMatchObject({
        titulo: 'Lia',
        responsavelId: ana.id,
        status: 'ABERTO',
        origem: 'WEBHOOK',
        origemDetalhe: 'Landing',
        utm: { source: 'google', campaign: 'outubro' },
      });
      expect(primeiro.negocio.valor.toFixed(2)).toBe('10.50');
      const entrada = await t.prisma.negocioMovimentacao.findFirstOrThrow({
        where: { negocioId: primeiro.negocio.id },
      });
      expect(entrada).toMatchObject({ tipoAtor: 'WEBHOOK', usuarioId: null });
      expect(
        await t.prisma.eventoAuditoria.findFirstOrThrow({
          where: { acao: 'negocio.criado', entidadeId: primeiro.negocio.id },
        }),
      ).toMatchObject({ tipoAtor: 'WEBHOOK', atorDescricao: 'Landing' });

      const segundo = await criarPeloWebhook();
      expect(segundo).toMatchObject({ criado: false, reconversao: true });
      expect(segundo.negocio.id).toBe(primeiro.negocio.id);
      expect(
        await t.prisma.negocio.count({ where: { contatoId: contato.id } }),
      ).toBe(1);
      const atual = await t.prisma.negocio.findUniqueOrThrow({
        where: { id: primeiro.negocio.id },
      });
      expect(atual.reconversoes).toBe(1);
      expect(atual.ultimaReconversaoEm).toEqual(expect.any(Date));
      expect(
        await t.prisma.eventoAuditoria.findFirstOrThrow({
          where: {
            acao: 'negocio.reconvertido',
            entidadeId: primeiro.negocio.id,
          },
        }),
      ).toMatchObject({ tipoAtor: 'WEBHOOK' });
      expect(
        await t.prisma.notificacao.count({
          where: {
            usuarioId: ana.id,
            tipo: TIPOS_NOTIFICACAO.NEGOCIO_ATRIBUIDO,
          },
        }),
      ).toBe(2);
      // O rodízio não andou com a reconversão: o próximo lead é do Bruno.
      const outro = await executarComoAtor({ tipoAtor: 'WEBHOOK' }, () =>
        t.prisma.$transaction(async (tx) =>
          negocios.criarAutomatico(tx, {
            contatoId: (await criarContato(t)).id,
            funilId: marketing.id,
            etapaId: novoLead.id,
            origem: 'WEBHOOK',
            estrategia: 'RODIZIO',
          }),
        ),
      );
      expect(outro.negocio.responsavelId).toBe(bruno.id);

      // Fechado o negócio, a automação cria outro; a criação manual é sempre livre.
      await t.prisma.negocio.update({
        where: { id: primeiro.negocio.id },
        data: {
          status: 'PERDIDO',
          etapaId: (await etapaDoFunilBase(t, 'MARKETING', 'descartado')).id,
          motivoPerda: 'Sem interesse',
        },
      });
      expect((await criarPeloWebhook()).criado).toBe(true);
      const admin = await entrarComo(t, await criarUsuario(t));
      await admin
        .post('/api/v1/negocios', {
          contatoId: contato.id,
          funilId: marketing.id,
        })
        .expect(201);
      expect(
        await t.prisma.negocio.count({
          where: { contatoId: contato.id, status: 'ABERTO' },
        }),
      ).toBe(2);
    });

    it('R5.6 — automações simultâneas do mesmo contato no mesmo funil criam um só negócio', async () => {
      await criarEquipe(t, 'MARKETING', { membros: 2 });
      const contato = await criarContato(t);
      const marketing = await funilBase(t, 'MARKETING');
      const novoLead = await etapaDoFunilBase(t, 'MARKETING', 'novo_lead');
      const negocios = t.get(NegociosService);
      const resultados = await Promise.all(
        Array.from({ length: 4 }, () =>
          executarComoAtor({ tipoAtor: 'WEBHOOK' }, () =>
            t.prisma.$transaction((tx) =>
              negocios.criarAutomatico(tx, {
                contatoId: contato.id,
                funilId: marketing.id,
                etapaId: novoLead.id,
                origem: 'WEBHOOK',
                estrategia: 'RODIZIO',
              }),
            ),
          ),
        ),
      );
      expect(resultados.filter((r) => r.criado)).toHaveLength(1);
      expect(resultados.filter((r) => r.reconversao)).toHaveLength(3);
      expect(
        await t.prisma.negocio.count({ where: { contatoId: contato.id } }),
      ).toBe(1);
    });

    it('R5.6 — se uma movimentação simultânea fecha o negócio aberto, a automação cria outro em vez de reconverter um fechado', async () => {
      await criarEquipe(t, 'MARKETING', { membros: 1 });
      const contato = await criarContato(t);
      const marketing = await funilBase(t, 'MARKETING');
      const novoLead = await etapaDoFunilBase(t, 'MARKETING', 'novo_lead');
      const descartado = await etapaDoFunilBase(t, 'MARKETING', 'descartado');
      const aberto = await criarNegocio(t, { area: 'MARKETING', contato });
      let liberar!: () => void;
      const segura = new Promise<void>((resolver) => {
        liberar = resolver;
      });
      let fechou = false;
      const fechamento = t.prisma.$transaction(async (tx) => {
        await tx.negocio.update({
          where: { id: aberto.id },
          data: {
            status: 'PERDIDO',
            etapaId: descartado.id,
            motivoPerda: 'Fechado ao mesmo tempo',
          },
        });
        fechou = true;
        await segura;
      });
      await esperarAte(() => fechou);
      const automacao = t.prisma.$transaction((tx) =>
        t.get(NegociosService).criarAutomatico(tx, {
          contatoId: contato.id,
          funilId: marketing.id,
          etapaId: novoLead.id,
          origem: 'WEBHOOK',
          estrategia: 'RODIZIO',
        }),
      );
      await new Promise((resolver) => setTimeout(resolver, 200));
      liberar();
      await fechamento;
      const resultado = await automacao;
      expect(resultado).toMatchObject({ criado: true, reconversao: false });
      expect(
        (await t.prisma.negocio.findUniqueOrThrow({ where: { id: aberto.id } }))
          .reconversoes,
      ).toBe(0);
    });

    it('recusa funil arquivado, etapa de outro funil, etapa de perda, contato excluído e valor inválido', async () => {
      const contato = await criarContato(t);
      const marketing = await funilBase(t, 'MARKETING');
      const novoLead = await etapaDoFunilBase(t, 'MARKETING', 'novo_lead');
      const descartado = await etapaDoFunilBase(t, 'MARKETING', 'descartado');
      const novo = await etapaDoFunilBase(t, 'COMERCIAL', 'novo');
      const negocios = t.get(NegociosService);
      const tentar = (alteracoes: Record<string, unknown>) =>
        t.prisma.$transaction((tx) =>
          negocios.criarAutomatico(tx, {
            contatoId: contato.id,
            funilId: marketing.id,
            etapaId: novoLead.id,
            origem: 'WEBHOOK',
            estrategia: 'RODIZIO',
            ...alteracoes,
          }),
        );
      await expect(tentar({ etapaId: novo.id })).rejects.toMatchObject({
        regra: 'R5.4',
      });
      await expect(tentar({ etapaId: descartado.id })).rejects.toMatchObject({
        regra: 'R5.5',
      });
      await expect(tentar({ valor: '12,50' })).rejects.toMatchObject({
        codigo: 'dados_invalidos',
      });
      await expect(
        tentar({ contatoId: '00000000-0000-4000-8000-000000000000' }),
      ).rejects.toMatchObject({ regra: 'R5.3' });
      await t.prisma.funil.update({
        where: { id: marketing.id },
        data: { ativo: false },
      });
      await expect(tentar({})).rejects.toMatchObject({ regra: 'R5.1' });
      expect(await t.prisma.negocio.count()).toBe(0);
    });
  });
});
