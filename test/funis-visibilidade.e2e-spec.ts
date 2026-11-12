/**
 * Quem vê um funil (S2): visibilidade `SETOR`/`RESTRITA`, acessos extras de
 * funil e de setor, níveis (`VER`, `MEMBRO`, `GESTOR`, `CONFIGURAR`),
 * responsável válido e o "não vaza" em cada consulta de negócio
 * (R5.9, R5.11–R5.13).
 */
import { executarComoAtor } from '../src/comum/contexto/contexto-requisicao';
import { PublicoDaCampanha } from '../src/disparos/publico.service';
import { DistribuicaoService } from '../src/funis/distribuicao.service';
import type { Usuario } from '../src/generated/prisma/client';
import { cartao, consultarPainel } from './bi-apoio';
import { mover } from './funis-apoio';
import {
  type AppTeste,
  type ClienteHttp,
  conectarTempoReal,
  criarAppTeste,
  criarArquivo,
  criarCampanha,
  criarCanal,
  criarContato,
  criarEquipe,
  criarFila,
  criarNegocio,
  criarUsuario,
  drenarTudo,
  entrarComo,
  type Equipe,
  fecharSockets,
  funilBase,
  type SocketDeTeste,
} from './utils';
import { receberDoContato } from './atendimento-apoio';
import { marcarReferencia } from '../src/chat-interno/regras-chat';

interface FunilDaApi {
  id: string;
  nome: string;
  area: string;
  nomeSetor: string;
  visibilidade: 'SETOR' | 'RESTRITA';
  nivel: 'VER' | 'MEMBRO' | 'GESTOR' | 'CONFIGURAR';
  veTodos: boolean;
  etapas: { id: string; tipo: string }[];
}

interface NegocioDaApi {
  id: string;
  titulo: string;
  funil: { id: string };
  responsavel: { id: string } | null;
}

interface Cenario {
  admin: Usuario;
  comercial: Equipe;
  cs: Equipe;
  marketing: Equipe;
  /** Membro do Comercial fora da lista do funil restrito. */
  semLista: Usuario;
  /** Membro do Comercial na lista do funil restrito (MEMBRO). */
  naLista: Usuario;
  comoAdmin: ClienteHttp;
  comoLider: ClienteHttp;
  comoSemLista: ClienteHttp;
  comoNaLista: ClienteHttp;
  comoMarketing: ClienteHttp;
  comoLiderCs: ClienteHttp;
  /** Funil restrito do Comercial. */
  vip: FunilDaApi;
  /** Negócio sem responsável no funil restrito. */
  secreto: NegocioDaApi;
  contatoSecreto: { id: string };
}

describe('Quem vê um funil (e2e, R5.9, R5.11–R5.13)', () => {
  let t: AppTeste;
  let c: Cenario;

  beforeAll(async () => {
    t = await criarAppTeste();
  });

  afterAll(() => t.fechar());

  async function montarCenario(): Promise<Cenario> {
    const admin = await criarUsuario(t, { papel: 'ADMIN', nome: 'Admin' });
    const comercial = await criarEquipe(t, 'COMERCIAL', { membros: 2 });
    const cs = await criarEquipe(t, 'CS', {
      membros: 1,
      cLevel: comercial.cLevel,
    });
    const marketing = await criarEquipe(t, 'MARKETING', {
      membros: 1,
      cLevel: comercial.cLevel,
    });
    const [semLista, naLista] = comercial.membros;
    const comoLider = await entrarComo(t, comercial.lider);
    const vip = (
      await comoLider
        .post('/api/v1/funis', {
          nome: 'Contas VIP',
          area: 'COMERCIAL',
          visibilidade: 'RESTRITA',
        })
        .expect(201)
    ).body as FunilDaApi;
    await comoLider
      .put(`/api/v1/funis/${vip.id}/acessos`, {
        acessos: [{ usuarioId: naLista.id, nivel: 'MEMBRO' }],
      })
      .expect(200);
    const contatoSecreto = await criarContato(t, { nome: 'Cliente Secreto' });
    const secreto = (
      await comoLider
        .post('/api/v1/negocios', {
          funilId: vip.id,
          contatoId: contatoSecreto.id,
          titulo: 'Contrato sigiloso',
          responsavelId: null,
        })
        .expect(201)
    ).body as NegocioDaApi;
    return {
      admin,
      comercial,
      cs,
      marketing,
      semLista,
      naLista,
      comoAdmin: await entrarComo(t, admin),
      comoLider,
      comoSemLista: await entrarComo(t, semLista),
      comoNaLista: await entrarComo(t, naLista),
      comoMarketing: await entrarComo(t, marketing.membros[0]),
      comoLiderCs: await entrarComo(t, cs.lider),
      vip,
      secreto,
      contatoSecreto,
    };
  }

  beforeEach(async () => {
    await t.limparBanco();
    c = await montarCenario();
  });

  /** As duas pessoas que não podem ver o negócio secreto por nenhum caminho. */
  const quemNaoVe = () => [
    { nome: 'membro do setor dono fora da lista', cliente: c.comoSemLista },
    { nome: 'pessoa de outro setor sem acesso', cliente: c.comoMarketing },
  ];

  async function idsDaLista(
    cliente: ClienteHttp,
    consulta = '',
  ): Promise<string[]> {
    const resposta = await cliente
      .get(`/api/v1/negocios?porPagina=100${consulta}`)
      .expect(200);
    return (resposta.body.itens as { id: string }[]).map(({ id }) => id);
  }

  async function funisDe(cliente: ClienteHttp): Promise<FunilDaApi[]> {
    return (await cliente.get('/api/v1/funis').expect(200))
      .body as FunilDaApi[];
  }

  describe('não vaza (R5.9)', () => {
    it('R5.9 — funis, quadro, métricas, lista, busca, negócios do contato, detalhe, movimentações e linha do tempo do negócio', async () => {
      for (const { cliente } of quemNaoVe()) {
        expect((await funisDe(cliente)).map(({ id }) => id)).not.toContain(
          c.vip.id,
        );
        await cliente.get(`/api/v1/funis/${c.vip.id}`).expect(404);
        await cliente.get(`/api/v1/funis/${c.vip.id}/quadro`).expect(404);
        await cliente.get(`/api/v1/funis/${c.vip.id}/metricas`).expect(404);
        expect(await idsDaLista(cliente)).not.toContain(c.secreto.id);
        expect(await idsDaLista(cliente, `&funilId=${c.vip.id}`)).toEqual([]);
        expect(await idsDaLista(cliente, '&busca=sigiloso')).toEqual([]);
        expect(
          await idsDaLista(cliente, `&contatoId=${c.contatoSecreto.id}`),
        ).toEqual([]);
        await cliente.get(`/api/v1/negocios/${c.secreto.id}`).expect(404);
        await cliente
          .get(`/api/v1/negocios/${c.secreto.id}/movimentacoes`)
          .expect(404);
        await cliente
          .get(`/api/v1/negocios/${c.secreto.id}/linha-do-tempo`)
          .expect(404);
        // Nem agir por id.
        await mover(cliente, c.secreto.id, c.vip.etapas[1].id).expect(404);
        await cliente
          .post(`/api/v1/negocios/${c.secreto.id}/assumir`)
          .expect(404);
        await cliente
          .post('/api/v1/negocios', {
            funilId: c.vip.id,
            contatoId: c.contatoSecreto.id,
          })
          .expect(404);
      }
      // Controle: quem está na lista como membro e o líder veem.
      expect(await idsDaLista(c.comoNaLista)).toContain(c.secreto.id);
      expect(await idsDaLista(c.comoLider)).toContain(c.secreto.id);
      await c.comoNaLista.get(`/api/v1/funis/${c.vip.id}/quadro`).expect(200);
    });

    it('R5.9 — a jornada de um negócio visível não revela o negócio ligado do funil restrito', async () => {
      const comercial = await funilBase(t, 'COMERCIAL');
      const visivel = await criarNegocio(t, {
        area: 'COMERCIAL',
        contato: c.contatoSecreto.id,
        responsavel: null,
        negocioOrigem: c.secreto.id,
      });
      expect(visivel.funilId).toBe(comercial.id);
      const detalhe = await c.comoSemLista
        .get(`/api/v1/negocios/${visivel.id}`)
        .expect(200);
      expect(detalhe.body.jornada.origem).toEqual({
        id: c.secreto.id,
        area: 'COMERCIAL',
        visivel: false,
      });
      expect(JSON.stringify(detalhe.body)).not.toContain('sigiloso');
      const doLider = await c.comoLider
        .get(`/api/v1/negocios/${visivel.id}`)
        .expect(200);
      expect(doLider.body.jornada.origem.visivel).toBe(true);
    });

    it('R5.9 — linha do tempo do contato: sem os eventos do negócio restrito nem os ligados a ele', async () => {
      const filaCs = await criarFila(t, { nome: 'CS', area: 'CS' });
      const canal = await criarCanal(t, {
        tipo: 'WEBCHAT',
        nome: 'Chat',
        filaPadrao: filaCs,
      });
      await receberDoContato(t, canal, { de: 'visitante-vip', nome: 'Lia' });
      const conversa = await t.prisma.conversa.findFirstOrThrow({
        where: { canalId: canal.id },
      });
      // O Admin cria, a partir da conversa, um negócio no funil restrito: o
      // evento da conversa fica ligado a ele.
      const criado = await c.comoAdmin
        .post(`/api/v1/atendimento/conversas/${conversa.id}/negocio`, {
          funilId: c.vip.id,
          titulo: 'Proposta reservada',
        })
        .expect(201);
      const contatoId = conversa.contatoId;
      const textos = async (cliente: ClienteHttp) =>
        JSON.stringify(
          (
            await cliente
              .get(`/api/v1/contatos/${contatoId}/linha-do-tempo?porPagina=100`)
              .expect(200)
          ).body,
        );
      for (const cliente of [c.comoLiderCs, c.comoMarketing, c.comoSemLista]) {
        const corpo = await textos(cliente);
        expect(corpo).not.toContain('Proposta reservada');
        expect(corpo).not.toContain(criado.body.id);
      }
      expect(await textos(c.comoLider)).toContain('Proposta reservada');

      // R5.9: o detalhe e a lista de conversas (o CS vê a conversa) não mostram
      // o negócio ligado — nem pelo id.
      const doCs = await c.comoLiderCs
        .get(`/api/v1/atendimento/conversas/${conversa.id}`)
        .expect(200);
      expect(doCs.body.negocio).toBeNull();
      expect(doCs.body.negocioId).toBeNull();
      const listaDoCs = await c.comoLiderCs
        .get('/api/v1/atendimento/conversas')
        .expect(200);
      const naListaDoCs = (
        listaDoCs.body.itens as { id: string; negocioId: string | null }[]
      ).find(({ id }) => id === conversa.id);
      expect(naListaDoCs).toMatchObject({ negocioId: null });
      expect(JSON.stringify(listaDoCs.body)).not.toContain(criado.body.id);
      const doAdmin = await c.comoAdmin
        .get(`/api/v1/atendimento/conversas/${conversa.id}`)
        .expect(200);
      expect(doAdmin.body.negocio).toMatchObject({ id: criado.body.id });
      expect(doAdmin.body.negocioId).toBe(criado.body.id);
      const listaDoAdmin = await c.comoAdmin
        .get('/api/v1/atendimento/conversas')
        .expect(200);
      expect(
        (
          listaDoAdmin.body.itens as { id: string; negocioId: string | null }[]
        ).find(({ id }) => id === conversa.id),
      ).toMatchObject({ negocioId: criado.body.id });
    });

    it('R5.9 — atividades: o vínculo com o negócio restrito some da resposta e não serve de filtro nem de vínculo novo', async () => {
      const atividade = await c.comoLider
        .post('/api/v1/atividades', {
          tipo: 'TAREFA',
          titulo: 'Ligar para o cliente',
          negocioId: c.secreto.id,
          responsavelId: c.semLista.id,
        })
        .expect(201);
      expect(atividade.body.negocio).toMatchObject({ id: c.secreto.id });
      const detalhe = await c.comoSemLista
        .get(`/api/v1/atividades/${atividade.body.id}`)
        .expect(200);
      expect(detalhe.body.negocio).toBeNull();
      expect(JSON.stringify(detalhe.body)).not.toContain('sigiloso');
      const lista = await c.comoSemLista.get('/api/v1/atividades').expect(200);
      expect(lista.body.itens).toHaveLength(1);
      expect(lista.body.itens[0].negocio).toBeNull();
      const agrupadas = await c.comoSemLista
        .get('/api/v1/atividades/agrupadas')
        .expect(200);
      expect(JSON.stringify(agrupadas.body)).not.toContain(c.secreto.id);
      const filtrada = await c.comoSemLista
        .get(`/api/v1/atividades?negocioId=${c.secreto.id}`)
        .expect(200);
      expect(filtrada.body.itens).toEqual([]);
      const vinculo = await c.comoSemLista
        .post('/api/v1/atividades', {
          tipo: 'TAREFA',
          titulo: 'Espiar',
          negocioId: c.secreto.id,
        })
        .expect(400);
      expect(JSON.stringify(vinculo.body)).toContain('negocioId');
      // Quem vê o negócio continua vendo o vínculo.
      const doLider = await c.comoLider
        .get(`/api/v1/atividades/${atividade.body.id}`)
        .expect(200);
      expect(doLider.body.negocio).toMatchObject({ id: c.secreto.id });
    });

    it('R5.9/R5.14 — prévia de modelo, citação no chat (R15.6) e públicos (segmento, automação) não usam o funil restrito', async () => {
      for (const { cliente } of quemNaoVe()) {
        await cliente
          .post('/api/v1/modelos/previa', {
            texto: 'Negócio: {{negocio.titulo}}',
            negocioId: c.secreto.id,
          })
          .expect(404);
        const segmento = await cliente
          .post('/api/v1/segmentos/previa', {
            segmento: {
              condicoes: [
                {
                  campo: 'negocio',
                  operador: 'tem',
                  valor: { funilId: c.vip.id },
                },
              ],
            },
          })
          .expect(400);
        expect(segmento.body.detalhes.regra).toBe('R5.9');
      }
      const previa = await c.comoLider
        .post('/api/v1/modelos/previa', {
          texto: 'Negócio: {{negocio.titulo}}',
          negocioId: c.secreto.id,
        })
        .expect(200);
      expect(previa.body.texto).toBe('Negócio: Contrato sigiloso');

      // Chat interno (R15.6): só cita o negócio quem o vê.
      const grupo = await c.comoSemLista
        .post('/api/v1/chat/grupos', {
          nome: 'Conversa',
          membrosIds: [c.comercial.lider.id],
        })
        .expect(201);
      const citacao = await c.comoSemLista
        .post(`/api/v1/chat/canais/${grupo.body.id}/mensagens`, {
          texto: `olha ${marcarReferencia('negocio', c.secreto.id)}`,
        })
        .expect(422);
      expect(citacao.body.detalhes.regra).toBe('R15.6');

      // Automação: o líder de outro setor não usa a etapa do funil restrito.
      const comoLiderMkt = await entrarComo(t, c.marketing.lider);
      const automacao = {
        nome: 'Mover os VIP',
        tipoGatilho: 'EVENTO',
        evento: 'negocio.criado',
        definicao: {
          passos: [
            {
              id: 'm',
              tipo: 'acao.mover_etapa',
              config: { etapaId: c.vip.etapas[1].id },
            },
          ],
        },
      };
      const recusada = await comoLiderMkt
        .post('/api/v1/automacoes', automacao)
        .expect(422);
      expect(recusada.body.detalhes.regra).toBe('R5.9');
      await c.comoLider.post('/api/v1/automacoes', automacao).expect(201);
    });

    it('R5.14 — campanha: revisão e envio contam só os funis que quem a criou vê agora; desligado, nenhum funil restrito conta', async () => {
      // Sem responsável: quem é só MEMBRO do funil conta os seus e os sem responsável (R5.12).
      const visivel = await criarNegocio(t, {
        area: 'COMERCIAL',
        responsavel: null,
      });
      const segmento = {
        combinacao: 'todas',
        condicoes: [
          { campo: 'negocio', operador: 'tem', valor: { status: ['ABERTO'] } },
        ],
      };
      const publicoNaRevisao = async (campanhaId: string) =>
        (
          await c.comoAdmin
            .get(`/api/v1/disparos/campanhas/${campanhaId}/revisao`)
            .expect(200)
        ).body.publico.total as number;

      // Criada por quem não vê o funil restrito: nem pelo Admin na revisão.
      const doSemLista = await criarCampanha(t, {
        criadoPor: c.semLista,
        segmento,
        canais: [],
      });
      expect(await publicoNaRevisao(doSemLista.id)).toBe(1);
      await t.get(PublicoDaCampanha).montar(doSemLista);
      const destinatarios = await t.prisma.campanhaDestinatario.findMany({
        where: { campanhaId: doSemLista.id },
        select: { contatoId: true },
      });
      expect(destinatarios.map(({ contatoId }) => contatoId)).toEqual([
        visivel.contatoId,
      ]);

      // Criada por quem está na lista do funil restrito: conta; desligado, não.
      const doNaLista = await criarCampanha(t, {
        criadoPor: c.naLista,
        segmento,
        canais: [],
      });
      expect(await publicoNaRevisao(doNaLista.id)).toBe(2);
      await t.prisma.usuario.update({
        where: { id: c.naLista.id },
        data: { ativo: false, desligadoEm: new Date() },
      });
      expect(await publicoNaRevisao(doNaLista.id)).toBe(1);
      await t.get(PublicoDaCampanha).montar(doNaLista);
      expect(
        await t.prisma.campanhaDestinatario.count({
          where: { campanhaId: doNaLista.id, contatoId: c.contatoSecreto.id },
        }),
      ).toBe(0);

      const doAdmin = await criarCampanha(t, {
        criadoPor: c.admin,
        segmento,
        canais: [],
      });
      expect(await publicoNaRevisao(doAdmin.id)).toBe(2);
    });

    it('R5.9/R20.2 — BI: o membro não conta o funil restrito (nem com acesso: acessos não ampliam o BI) nem filtra por ele (404); o líder conta', async () => {
      await criarNegocio(t, { area: 'COMERCIAL', responsavel: null });
      const abertos = async (cliente: ClienteHttp) =>
        cartao(await consultarPainel(cliente, 'comercial'), 'abertos').valor;
      expect(await abertos(c.comoSemLista)).toBe(1);
      expect(await abertos(c.comoNaLista)).toBe(1);
      expect(await abertos(c.comoLider)).toBe(2);
      // O filtro por um funil que a pessoa não vê: 404, sem nome nem etapas.
      const negado = (await consultarPainel(
        c.comoSemLista,
        'comercial',
        { funilId: c.vip.id },
        404,
      )) as unknown as { mensagem: string };
      expect(negado.mensagem).toBe('Funil não encontrado.');
      expect(JSON.stringify(negado)).not.toContain('Contas VIP');
      await consultarPainel(c.comoLider, 'comercial', { funilId: c.vip.id });
    });

    it('R5.9/R5.12/R16.12 — importação: funil que não vê é inexistente (404 no cartão, NAO_ENCONTRADO sem dados); só VER → 403 e SEM_PERMISSAO', async () => {
      const comoLiderMkt = await entrarComo(t, c.marketing.lider);
      const comoLiderCs = c.comoLiderCs;
      // O CS ganha "só ver" no funil restrito: ver não cria (R5.12).
      await c.comoLider
        .put(`/api/v1/funis/${c.vip.id}/acessos`, {
          acessos: [
            { usuarioId: c.naLista.id, nivel: 'MEMBRO' },
            { area: 'CS', nivel: 'VER' },
          ],
        })
        .expect(200);
      for (const cliente of [comoLiderMkt, comoLiderCs]) {
        const arquivo = await criarArquivo(t, {
          contexto: 'IMPORTACAO',
          nome: 'vip.csv',
          mime: 'text/csv',
          conteudo: 'Nome,E-mail,Funil\nAna,ana@vip.com,Contas VIP\n',
          criadoPor: cliente.usuario!,
        });
        const criada = (
          await cliente
            .post('/api/v1/importacoes', {
              tipo: 'CONTATOS',
              arquivoId: arquivo.id,
            })
            .expect(201)
        ).body as { id: string };
        await cliente
          .patch(`/api/v1/importacoes/${criada.id}`, {
            mapeamento: {
              Nome: 'nome',
              'E-mail': 'email',
              Funil: 'negocio.funil',
            },
          })
          .expect(200);
        const ve = cliente === comoLiderCs;
        const negado = await cliente
          .patch(`/api/v1/importacoes/${criada.id}`, {
            negocio: { funilId: c.vip.id, etapaId: c.vip.etapas[0].id },
          })
          .expect(ve ? 403 : 404);
        if (ve) {
          expect(negado.body.detalhes.regra).toBe('R5.12');
        } else {
          expect(JSON.stringify(negado.body)).not.toContain('Contas VIP');
        }
        // A tradução por id segue a mesma regra.
        await cliente
          .patch(`/api/v1/importacoes/${criada.id}`, {
            traducaoFunis: { 'contas vip': c.vip.id },
          })
          .expect(ve ? 403 : 404);
        const conferencia = await cliente
          .get(`/api/v1/importacoes/${criada.id}/funis-da-planilha`)
          .expect(200);
        if (ve) {
          expect(conferencia.body.funis[0]).toMatchObject({
            valor: 'Contas VIP',
            funil: { id: c.vip.id },
            problema: 'SEM_PERMISSAO',
          });
        } else {
          expect(conferencia.body.funis[0]).toMatchObject({
            valor: 'Contas VIP',
            funil: null,
            problema: 'NAO_ENCONTRADO',
          });
          expect(JSON.stringify(conferencia.body)).not.toContain(c.vip.id);
        }
      }
      // Com acesso como membro, o CS passa a criar no funil.
      await c.comoLider
        .put(`/api/v1/funis/${c.vip.id}/acessos`, {
          acessos: [{ area: 'CS', nivel: 'MEMBRO' }],
        })
        .expect(200);
      const arquivo = await criarArquivo(t, {
        contexto: 'IMPORTACAO',
        nome: 'vip.csv',
        mime: 'text/csv',
        conteudo: 'Nome,E-mail\nAna,ana@vip.com\n',
        criadoPor: comoLiderCs.usuario!,
      });
      const criada = (
        await comoLiderCs
          .post('/api/v1/importacoes', {
            tipo: 'CONTATOS',
            arquivoId: arquivo.id,
          })
          .expect(201)
      ).body as { id: string };
      await comoLiderCs
        .patch(`/api/v1/importacoes/${criada.id}`, {
          negocio: { funilId: c.vip.id, etapaId: c.vip.etapas[0].id },
        })
        .expect(200);
    });

    it('R5.9/§19 — tempo real: nada do negócio restrito chega a quem não o vê', async () => {
      const recebidos: { nome: string; evento: string; dados: string }[] = [];
      const sockets: SocketDeTeste[] = [];
      for (const { nome, cliente } of quemNaoVe()) {
        const socket = await conectarTempoReal(t, cliente);
        socket.onAny((evento: string, dados: unknown) =>
          recebidos.push({ nome, evento, dados: JSON.stringify(dados) }),
        );
        sockets.push(socket);
      }
      const doNaLista = await conectarTempoReal(t, c.comoNaLista);
      const avisos: string[] = [];
      doNaLista.onAny((_evento: string, dados: unknown) =>
        avisos.push(JSON.stringify(dados)),
      );
      try {
        const novo = (
          await c.comoLider
            .post('/api/v1/negocios', {
              funilId: c.vip.id,
              contatoId: c.contatoSecreto.id,
              titulo: 'Outro sigiloso',
              responsavelId: null,
            })
            .expect(201)
        ).body as NegocioDaApi;
        await mover(c.comoLider, novo.id, c.vip.etapas[1].id).expect(200);
        await c.comoLider
          .patch(`/api/v1/negocios/${novo.id}`, {
            responsavelId: c.naLista.id,
          })
          .expect(200);
        await c.comoLider
          .post('/api/v1/atividades', {
            tipo: 'TAREFA',
            titulo: 'Revisar proposta',
            negocioId: novo.id,
            responsavelId: c.naLista.id,
          })
          .expect(201);
        await drenarTudo(t);
        await new Promise((resolver) => setTimeout(resolver, 400));
        const vazados = recebidos.filter(
          ({ dados }) =>
            dados.includes(novo.id) ||
            dados.includes(c.secreto.id) ||
            dados.includes('sigiloso'),
        );
        expect(vazados).toEqual([]);
        // Controle: quem recebeu o negócio é avisado.
        expect(avisos.some((dados) => dados.includes(novo.id))).toBe(true);
      } finally {
        fecharSockets(...sockets, doNaLista);
      }
    });
  });

  describe('níveis (R5.12)', () => {
    it('R5.12 — VER vê todos os negócios do funil e não cria, edita, move, assume, ganha nem perde', async () => {
      await c.comoLider
        .put(`/api/v1/funis/${c.vip.id}/acessos`, {
          acessos: [{ area: 'CS', nivel: 'VER' }],
        })
        .expect(200);
      const funis = await funisDe(c.comoLiderCs);
      expect(funis.find(({ id }) => id === c.vip.id)).toMatchObject({
        nivel: 'VER',
        area: 'COMERCIAL',
        nomeSetor: 'Comercial',
        visibilidade: 'RESTRITA',
      });
      expect(await idsDaLista(c.comoLiderCs)).toContain(c.secreto.id);
      await c.comoLiderCs.get(`/api/v1/negocios/${c.secreto.id}`).expect(200);
      const ganho = c.vip.etapas.find(({ tipo }) => tipo === 'GANHO')!;
      for (const pedido of [
        mover(c.comoLiderCs, c.secreto.id, c.vip.etapas[1].id),
        mover(c.comoLiderCs, c.secreto.id, ganho.id),
        c.comoLiderCs.patch(`/api/v1/negocios/${c.secreto.id}`, {
          titulo: 'Mudado',
        }),
        c.comoLiderCs.post(`/api/v1/negocios/${c.secreto.id}/assumir`),
        c.comoLiderCs.post('/api/v1/negocios', {
          funilId: c.vip.id,
          contatoId: c.contatoSecreto.id,
        }),
      ]) {
        const resposta = await pedido.expect(403);
        expect(resposta.body.detalhes.regra).toBe('R5.12');
      }
    });

    it('R5.12 — MEMBRO vê os seus e os sem responsável, assume, cria e move os que vê; não reabre nem configura', async () => {
      const doLider = (
        await c.comoLider
          .post('/api/v1/negocios', {
            funilId: c.vip.id,
            contatoId: c.contatoSecreto.id,
            titulo: 'Do líder',
          })
          .expect(201)
      ).body as NegocioDaApi;
      const vistos = await idsDaLista(c.comoNaLista, `&funilId=${c.vip.id}`);
      expect(vistos).toContain(c.secreto.id);
      expect(vistos).not.toContain(doLider.id);
      await c.comoNaLista.get(`/api/v1/negocios/${doLider.id}`).expect(404);
      const assumido = await c.comoNaLista
        .post(`/api/v1/negocios/${c.secreto.id}/assumir`)
        .expect(200);
      expect(assumido.body.responsavel.id).toBe(c.naLista.id);
      const ganho = c.vip.etapas.find(({ tipo }) => tipo === 'GANHO')!;
      await mover(c.comoNaLista, c.secreto.id, ganho.id).expect(200);
      const reabrir = await c.comoNaLista
        .post(`/api/v1/negocios/${c.secreto.id}/reabrir`, {})
        .expect(403);
      expect(reabrir.body.detalhes.regra).toBe('R5.5');
      const criado = await c.comoNaLista
        .post('/api/v1/negocios', {
          funilId: c.vip.id,
          contatoId: c.contatoSecreto.id,
        })
        .expect(201);
      expect(criado.body.responsavel.id).toBe(c.naLista.id);
      const funil = (await funisDe(c.comoNaLista)).find(
        ({ id }) => id === c.vip.id,
      );
      expect(funil?.nivel).toBe('MEMBRO');
      await c.comoNaLista
        .patch(`/api/v1/funis/${c.vip.id}`, { nome: 'Outro' })
        .expect(403);
      await c.comoNaLista.get(`/api/v1/funis/${c.vip.id}/acessos`).expect(403);
      await c.comoNaLista
        .delete(`/api/v1/negocios/${c.secreto.id}`)
        .expect(403);
    });

    it('R5.12 — ver separado de agir: membro do Comercial com VER no funil-base vê o negócio do colega e não o move; continua movendo os seus', async () => {
      const comercial = await funilBase(t, 'COMERCIAL');
      const doColega = await criarNegocio(t, {
        area: 'COMERCIAL',
        responsavel: c.naLista,
        titulo: 'Do colega',
      });
      const meu = await criarNegocio(t, {
        area: 'COMERCIAL',
        responsavel: c.semLista,
        titulo: 'Meu',
      });
      const antes = (await funisDe(c.comoSemLista)).find(
        ({ id }) => id === comercial.id,
      );
      expect(antes).toMatchObject({ nivel: 'MEMBRO', veTodos: false });
      await c.comoSemLista.get(`/api/v1/negocios/${doColega.id}`).expect(404);

      await c.comoLider
        .put(`/api/v1/funis/${comercial.id}/acessos`, {
          acessos: [{ usuarioId: c.semLista.id, nivel: 'VER' }],
        })
        .expect(200);
      const depois = (await funisDe(c.comoSemLista)).find(
        ({ id }) => id === comercial.id,
      );
      expect(depois).toMatchObject({ nivel: 'MEMBRO', veTodos: true });
      const detalhe = await c.comoSemLista
        .get(`/api/v1/funis/${comercial.id}`)
        .expect(200);
      expect(detalhe.body).toMatchObject({ nivel: 'MEMBRO', veTodos: true });
      await c.comoSemLista.get(`/api/v1/negocios/${doColega.id}`).expect(200);
      expect(
        await idsDaLista(c.comoSemLista, `&funilId=${comercial.id}`),
      ).toEqual(expect.arrayContaining([doColega.id, meu.id]));
      const quadro = await c.comoSemLista
        .get(`/api/v1/funis/${comercial.id}/quadro`)
        .expect(200);
      expect(JSON.stringify(quadro.body)).toContain(doColega.id);

      const proxima = comercial.etapas.find(
        ({ tipo, ordem }) =>
          tipo === 'ABERTA' && ordem > comercial.etapas[0].ordem,
      )!;
      const recusado = await mover(
        c.comoSemLista,
        doColega.id,
        proxima.id,
      ).expect(403);
      expect(recusado.body.detalhes.regra).toBe('R5.12');
      await c.comoSemLista
        .patch(`/api/v1/negocios/${doColega.id}`, { titulo: 'Mudado' })
        .expect(403);
      await mover(c.comoSemLista, meu.id, proxima.id).expect(200);
      // As ações seguem o maior nível: continua criando no funil.
      const criado = await c.comoSemLista
        .post('/api/v1/negocios', {
          funilId: comercial.id,
          contatoId: c.contatoSecreto.id,
        })
        .expect(201);
      expect(criado.body.responsavel.id).toBe(c.semLista.id);
      // Quem só tem VER também vem com veTodos (e nível VER).
      await c.comoLider
        .put(`/api/v1/funis/${c.vip.id}/acessos`, {
          acessos: [{ area: 'CS', nivel: 'VER' }],
        })
        .expect(200);
      expect(
        (await funisDe(c.comoLiderCs)).find(({ id }) => id === c.vip.id),
      ).toMatchObject({ nivel: 'VER', veTodos: true });
    });

    it('R5.12 — GESTOR vê e move todos e troca o responsável; não reabre, não exclui e não configura', async () => {
      // Acesso de setor (pela pessoa): vale nos funis SETOR do Comercial.
      const comoAdmin = c.comoAdmin;
      await comoAdmin
        .put('/api/v1/setores/COMERCIAL/acessos', {
          acessos: [{ usuarioId: c.marketing.membros[0].id, nivel: 'GESTOR' }],
        })
        .expect(200);
      const comercial = await funilBase(t, 'COMERCIAL');
      const doMembro = await criarNegocio(t, {
        area: 'COMERCIAL',
        responsavel: c.semLista,
      });
      const funis = await funisDe(c.comoMarketing);
      expect(funis.find(({ id }) => id === comercial.id)?.nivel).toBe('GESTOR');
      // O acesso do setor não abre o funil restrito.
      expect(funis.map(({ id }) => id)).not.toContain(c.vip.id);
      expect(await idsDaLista(c.comoMarketing)).toContain(doMembro.id);
      const trocado = await c.comoMarketing
        .patch(`/api/v1/negocios/${doMembro.id}`, {
          responsavelId: c.naLista.id,
        })
        .expect(200);
      expect(trocado.body.responsavel.id).toBe(c.naLista.id);
      const perdido = comercial.etapas.find(({ tipo }) => tipo === 'PERDIDO')!;
      await mover(c.comoMarketing, doMembro.id, perdido.id, {
        motivoPerda: 'Preço',
      }).expect(200);
      await c.comoMarketing
        .post(`/api/v1/negocios/${doMembro.id}/reabrir`, {})
        .expect(403);
      const excluir = await c.comoMarketing
        .delete(`/api/v1/negocios/${doMembro.id}`)
        .expect(403);
      expect(excluir.body.detalhes.regra).toBe('R5.12');
      await c.comoMarketing
        .patch(`/api/v1/funis/${comercial.id}`, { nome: 'Outro' })
        .expect(403);
    });

    it('R5.1 — só o líder do setor dono, o C-level e o Admin configuram o funil (visibilidade, acessos, etapas, arquivar)', async () => {
      await c.comoLider
        .put(`/api/v1/funis/${c.vip.id}/acessos`, {
          acessos: [{ area: 'CS', nivel: 'GESTOR' }],
        })
        .expect(200);
      const negado = await c.comoLiderCs
        .patch(`/api/v1/funis/${c.vip.id}`, { visibilidade: 'SETOR' })
        .expect(403);
      expect(negado.body.detalhes.regra).toBe('R5.1');
      await c.comoLiderCs
        .put(`/api/v1/funis/${c.vip.id}/acessos`, { acessos: [] })
        .expect(403);
      await c.comoLiderCs
        .post(`/api/v1/funis/${c.vip.id}/etapas`, { nome: 'Nova' })
        .expect(403);
      const cLevel = await entrarComo(t, c.comercial.cLevel);
      const funil = await cLevel.get(`/api/v1/funis/${c.vip.id}`).expect(200);
      expect(funil.body.nivel).toBe('CONFIGURAR');
      await cLevel
        .put(`/api/v1/funis/${c.vip.id}/acessos`, { acessos: [] })
        .expect(200);
      const lider = await c.comoLider
        .patch(`/api/v1/funis/${c.vip.id}`, { visibilidade: 'SETOR' })
        .expect(200);
      expect(lider.body).toMatchObject({
        visibilidade: 'SETOR',
        nivel: 'CONFIGURAR',
      });
    });
  });

  describe('visibilidade e acessos (R5.9, R5.11)', () => {
    it('R5.9 — mudar a visibilidade vale na hora e é auditado', async () => {
      const comercial = await funilBase(t, 'COMERCIAL');
      const doSetor = await criarNegocio(t, {
        area: 'COMERCIAL',
        responsavel: null,
      });
      expect(await idsDaLista(c.comoSemLista)).toContain(doSetor.id);
      await c.comoLider
        .patch(`/api/v1/funis/${comercial.id}`, { visibilidade: 'RESTRITA' })
        .expect(200);
      expect(await idsDaLista(c.comoSemLista)).not.toContain(doSetor.id);
      expect((await funisDe(c.comoSemLista)).map(({ id }) => id)).toEqual([]);
      const evento = await t.prisma.eventoAuditoria.findFirstOrThrow({
        where: { acao: 'funil.atualizado', entidadeId: comercial.id },
      });
      expect(evento.dados).toMatchObject({
        alteracoes: { visibilidade: { antes: 'SETOR', depois: 'RESTRITA' } },
        visibilidade: 'RESTRITA',
      });
    });

    it('R5.11 — acessos do funil: lista completa substitui, validação dos alvos e auditoria', async () => {
      const desligado = await criarUsuario(t, {
        papel: 'MEMBRO',
        area: 'CS',
        lider: c.cs.lider,
        ativo: false,
      });
      const url = `/api/v1/funis/${c.vip.id}/acessos`;
      const erro = async (corpo: object, status: number) =>
        (await c.comoLider.put(url, corpo).expect(status)).body;
      expect(
        await erro({ acessos: [{ area: 'COMERCIAL', nivel: 'VER' }] }, 422),
      ).toMatchObject({ detalhes: { regra: 'R5.11' } });
      expect(
        await erro({ acessos: [{ area: 'NAO_EXISTE', nivel: 'VER' }] }, 422),
      ).toMatchObject({ detalhes: { regra: 'R5.11' } });
      expect(
        await erro(
          { acessos: [{ usuarioId: desligado.id, nivel: 'VER' }] },
          422,
        ),
      ).toMatchObject({ detalhes: { regra: 'R5.11' } });
      await erro({ acessos: [{ nivel: 'VER' }] }, 400);
      await erro(
        { acessos: [{ area: 'CS', usuarioId: c.naLista.id, nivel: 'VER' }] },
        400,
      );
      await erro(
        {
          acessos: [
            { area: 'CS', nivel: 'VER' },
            { area: 'CS', nivel: 'GESTOR' },
          ],
        },
        400,
      );
      await erro({ acessos: [{ area: 'CS', nivel: 'DONO' }] }, 400);

      const trocada = await c.comoLider
        .put(url, {
          acessos: [
            { area: 'CS', nivel: 'VER' },
            { usuarioId: c.marketing.membros[0].id, nivel: 'GESTOR' },
          ],
        })
        .expect(200);
      expect(trocada.body).toMatchObject({
        funilId: c.vip.id,
        area: 'COMERCIAL',
        nomeSetor: 'Comercial',
        visibilidade: 'RESTRITA',
      });
      expect(
        (
          trocada.body.acessos as {
            alvo: string;
            area: string | null;
            usuario: { id: string } | null;
            nivel: string;
          }[]
        ).map((a) => [a.alvo, a.area ?? a.usuario?.id, a.nivel]),
      ).toEqual([
        ['SETOR', 'CS', 'VER'],
        ['PESSOA', c.marketing.membros[0].id, 'GESTOR'],
      ]);
      // O membro que estava na lista saiu: deixou de ver.
      expect(await idsDaLista(c.comoNaLista)).not.toContain(c.secreto.id);
      expect(await idsDaLista(c.comoMarketing)).toContain(c.secreto.id);
      const lida = await c.comoLider.get(url).expect(200);
      expect(lida.body.acessos).toHaveLength(2);
      const evento = await t.prisma.eventoAuditoria.findFirstOrThrow({
        where: { acao: 'funil.acessos_alterados', entidadeId: c.vip.id },
        orderBy: { id: 'desc' },
      });
      expect(evento.dados).toMatchObject({
        alteracoes: {
          acessos: {
            antes: [{ alvo: `pessoa:${c.naLista.id}`, nivel: 'MEMBRO' }],
          },
        },
        removidos: [`pessoa:${c.naLista.id}`],
      });
      // Quem não vê o funil recebe 404; quem só vê, 403.
      await c.comoSemLista.get(url).expect(404);
      await c.comoLiderCs.get(url).expect(403);
    });

    it('R5.11 — acessos do setor: Admin, C-level e líderes do setor; não valem nos funis restritos', async () => {
      const url = '/api/v1/setores/COMERCIAL/acessos';
      await c.comoLiderCs.get(url).expect(403);
      await c.comoSemLista.put(url, { acessos: [] }).expect(403);
      const proprio = await c.comoLider
        .put(url, { acessos: [{ area: 'COMERCIAL', nivel: 'VER' }] })
        .expect(422);
      expect(proprio.body.detalhes.regra).toBe('R5.11');
      const salvo = await c.comoLider
        .put(url, { acessos: [{ area: 'CS', nivel: 'VER' }] })
        .expect(200);
      expect(salvo.body).toMatchObject({
        area: 'COMERCIAL',
        nomeSetor: 'Comercial',
        acessos: [
          {
            alvo: 'SETOR',
            area: 'CS',
            nomeSetor: 'Customer Success',
            setorAtivo: true,
            nivel: 'VER',
          },
        ],
      });
      const comercial = await funilBase(t, 'COMERCIAL');
      const ids = (await funisDe(c.comoLiderCs)).map(({ id }) => id);
      expect(ids).toContain(comercial.id);
      expect(ids).not.toContain(c.vip.id);
      await (await entrarComo(t, c.comercial.cLevel)).get(url).expect(200);
      expect(
        await t.prisma.eventoAuditoria.count({
          where: { acao: 'setor.acessos_alterados', entidadeId: 'COMERCIAL' },
        }),
      ).toBe(1);
    });

    it('R5.11 — acesso dado a um setor desativado não conta (o dado à pessoa continua)', async () => {
      await t.prisma.setor.create({
        data: { chave: 'POS_VENDA', nome: 'Pós-venda', ordem: 4 },
      });
      const liderPos = await criarUsuario(t, {
        papel: 'LIDER',
        area: 'POS_VENDA',
        lider: c.comercial.cLevel,
      });
      const comoLiderPos = await entrarComo(t, liderPos);
      await c.comoLider
        .put(`/api/v1/funis/${c.vip.id}/acessos`, {
          acessos: [
            { area: 'POS_VENDA', nivel: 'VER' },
            { area: 'CS', nivel: 'VER' },
          ],
        })
        .expect(200);
      expect(await idsDaLista(comoLiderPos)).toContain(c.secreto.id);
      // Desativado à mão (a API só desativa setor vazio, R1.10).
      await t.prisma.setor.update({
        where: { chave: 'POS_VENDA' },
        data: { ativo: false },
      });
      expect(await idsDaLista(comoLiderPos)).not.toContain(c.secreto.id);
      expect(await idsDaLista(c.comoLiderCs)).toContain(c.secreto.id);
      // O acesso que já estava na lista pode continuar nela (só não conta).
      const lida = await c.comoLider
        .put(`/api/v1/funis/${c.vip.id}/acessos`, {
          acessos: [{ area: 'POS_VENDA', nivel: 'VER' }],
        })
        .expect(200);
      expect(lida.body.acessos[0]).toMatchObject({
        area: 'POS_VENDA',
        setorAtivo: false,
      });
    });
  });

  describe('responsável (R5.13)', () => {
    it('R5.13 — responsável: do setor dono (no restrito, líder ou da lista) ou com acesso MEMBRO/GESTOR; VER não', async () => {
      const url = `/api/v1/negocios/${c.secreto.id}`;
      const fora = await c.comoLider
        .patch(url, { responsavelId: c.semLista.id })
        .expect(422);
      expect(fora.body.detalhes.regra).toBe('R5.13');
      await c.comoLider.patch(url, { responsavelId: c.naLista.id }).expect(200);
      await c.comoLider
        .put(`/api/v1/funis/${c.vip.id}/acessos`, {
          acessos: [
            { area: 'CS', nivel: 'VER' },
            { usuarioId: c.marketing.membros[0].id, nivel: 'GESTOR' },
          ],
        })
        .expect(200);
      const soVe = await c.comoLider
        .patch(url, { responsavelId: c.cs.membros[0].id })
        .expect(422);
      expect(soVe.body.detalhes.regra).toBe('R5.13');
      const gestor = await c.comoLider
        .patch(url, { responsavelId: c.marketing.membros[0].id })
        .expect(200);
      expect(gestor.body.responsavel.id).toBe(c.marketing.membros[0].id);
      // Num funil do setor, um membro de outro setor com acesso MEMBRO pelo setor dele.
      await c.comoAdmin
        .put('/api/v1/setores/COMERCIAL/acessos', {
          acessos: [{ area: 'CS', nivel: 'MEMBRO' }],
        })
        .expect(200);
      const comercial = await funilBase(t, 'COMERCIAL');
      const criado = await c.comoLider
        .post('/api/v1/negocios', {
          funilId: comercial.id,
          contatoId: c.contatoSecreto.id,
          responsavelId: c.cs.membros[0].id,
        })
        .expect(201);
      expect(criado.body.responsavel.id).toBe(c.cs.membros[0].id);
    });

    it('R5.13 — o rodízio continua com as pessoas do setor dono; no funil restrito, só quem atua nele', async () => {
      // Os dois membros já ativaram o acesso (R5.8).
      await t.prisma.usuario.updateMany({
        where: { id: { in: [c.semLista.id, c.naLista.id] } },
        data: { acessoAtivadoEm: new Date() },
      });
      const funilVip = await t.prisma.funil.findUniqueOrThrow({
        where: { id: c.vip.id },
      });
      const comercial = await funilBase(t, 'COMERCIAL');
      const distribuicao = t.get(DistribuicaoService);
      const escolher = (funil: typeof funilVip) =>
        executarComoAtor({ tipoAtor: 'SISTEMA' }, () =>
          t.prisma.$transaction((tx) =>
            distribuicao.escolherResponsavel(tx, funil, 'RODIZIO'),
          ),
        );
      const noVip = new Set<string | null>();
      const noSetor = new Set<string | null>();
      for (let i = 0; i < 4; i++) {
        noVip.add(await escolher(funilVip));
      }
      for (let i = 0; i < 4; i++) {
        noSetor.add(await escolher(comercial));
      }
      expect([...noVip]).toEqual([c.naLista.id]);
      expect(noSetor).toEqual(new Set([c.semLista.id, c.naLista.id]));
      // Responsável fixo sem acesso ao funil restrito: vai para o líder.
      const fixo = await executarComoAtor({ tipoAtor: 'SISTEMA' }, () =>
        t.prisma.$transaction((tx) =>
          distribuicao.escolherResponsavel(
            tx,
            funilVip,
            'RESPONSAVEL_FIXO',
            c.semLista.id,
          ),
        ),
      );
      expect(fixo).toBe(c.comercial.lider.id);
    });
  });
});
