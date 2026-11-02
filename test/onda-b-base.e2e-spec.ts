import {
  contextoAtual,
  executarComoAtor,
} from '../src/comum/contexto/contexto-requisicao';
import { DadosInvalidosException } from '../src/comum/erros/excecoes';
import {
  type GatilhoDisparado,
  GatilhosService,
} from '../src/comum/gatilhos/gatilhos.service';
import {
  FILA_AVANCAR_PASSOS,
  PassosService,
} from '../src/comum/passos/passos.service';
import {
  aguardarEntrada,
  encerrar,
  ErroDePassoTemporario,
  irPara,
  irParaRamo,
  seguir,
} from '../src/comum/passos/tipos';
import { SegmentosService } from '../src/comum/segmentos/segmentos.service';
import { validarSegmento } from '../src/comum/segmentos/segmentos';
import {
  type AppTeste,
  avancarPassos,
  criarAppTeste,
  criarAutomacao,
  criarCampanha,
  criarContato,
  criarConversa,
  criarFluxoChatbot,
  criarImportacao,
  criarNegocio,
  criarUsuario,
  definicaoLinear,
  entrarComo,
  historicoDaExecucao,
  passoDeTeste,
  processarEventos,
} from './utils';

describe('Onda B — peças compartilhadas (e2e)', () => {
  let t: AppTeste;
  let passos: PassosService;
  const recebidos: GatilhoDisparado[] = [];
  const agendas: Date[] = [];

  beforeAll(async () => {
    t = await criarAppTeste();
    passos = t.get(PassosService);
    const gatilhos = t.get(GatilhosService);
    gatilhos.registrarDestino({
      nome: 'teste-onda-b',
      eventos: ['contato.criado', 'teste.evento'],
      aoDisparar: (gatilho) => {
        recebidos.push(gatilho);
        return Promise.resolve();
      },
    });
    await gatilhos.registrarAgenda({
      nome: 'teste-onda-b',
      cron: '*/5 * * * *',
      executar: (agora) => {
        agendas.push(agora);
        return Promise.resolve();
      },
    });
  });
  beforeEach(async () => {
    await t.limparBanco();
    recebidos.length = 0;
  });
  afterAll(() => t.fechar());

  describe('executor de passos', () => {
    it('roda em sequência, espera com startAfter do pg-boss e retoma; histórico por passo; ator AUTOMACAO', async () => {
      const atores: Array<{
        tipoAtor: string;
        descricao?: string;
        profundidade?: number;
      }> = [];
      passoDeTeste(t, 'teste.marcar', (ctx) => {
        const contexto = contextoAtual();
        atores.push({
          tipoAtor: contexto.tipoAtor,
          descricao: contexto.atorDescricao,
          profundidade: contexto.cadeia?.profundidade,
        });
        return Promise.resolve(
          seguir({
            saida: { visita: ctx.visita },
            variaveis: { [`marcado_${ctx.passo.id}`]: true },
          }),
        );
      });
      const { execucao, criada } = await passos.iniciar({
        tipo: 'AUTOMACAO',
        nome: 'Cadência de teste',
        definicao: definicaoLinear(
          'teste.marcar',
          { tipo: 'aguardar', config: { quantidade: 2, unidade: 'horas' } },
          'teste.marcar',
        ),
      });
      expect(criada).toBe(true);
      await avancarPassos(t);
      let atual = await t.prisma.execucao.findUniqueOrThrow({
        where: { id: execucao.id },
      });
      expect(atual.status).toBe('AGUARDANDO');
      expect(atual.passoAtualId).toBe('p2');
      expect(atual.aguardandoAte!.getTime() - Date.now()).toBeGreaterThan(
        7_100_000,
      );
      const pendentes = await t.fila.listarTrabalhos<{ execucaoId: string }>(
        FILA_AVANCAR_PASSOS,
      );
      expect(pendentes).toHaveLength(1);
      expect(pendentes[0].executarEm.getTime()).toBe(
        atual.aguardandoAte!.getTime(),
      );

      await avancarPassos(t, { incluirAgendados: true });
      atual = await t.prisma.execucao.findUniqueOrThrow({
        where: { id: execucao.id },
      });
      expect(atual.status).toBe('CONCLUIDA');
      expect(atual.variaveis).toEqual({ marcado_p1: true, marcado_p3: true });
      const historico = await historicoDaExecucao(t, execucao.id);
      expect(historico.map((p) => [p.chave, p.status])).toEqual([
        ['p1:1', 'CONCLUIDO'],
        ['p2:1', 'CONCLUIDO'],
        ['p3:1', 'CONCLUIDO'],
      ]);
      expect(historico[1].tentativas).toBe(2);
      expect(atores).toEqual([
        {
          tipoAtor: 'AUTOMACAO',
          descricao: 'Cadência de teste',
          profundidade: 1,
        },
        {
          tipoAtor: 'AUTOMACAO',
          descricao: 'Cadência de teste',
          profundidade: 1,
        },
      ]);
    });

    it('ramos, fim de ramo volta ao passo seguinte ao dono e desvio revisita passos', async () => {
      passoDeTeste(t, 'teste.contar', (ctx) =>
        Promise.resolve(
          seguir({
            variaveis: {
              contagem: Number(ctx.execucao.variaveis.contagem ?? 0) + 1,
            },
          }),
        ),
      );
      passoDeTeste(t, 'teste.decidir', (ctx) =>
        Promise.resolve(
          Number(ctx.execucao.variaveis.contagem ?? 0) < 3
            ? irParaRamo('de_novo')
            : irParaRamo('chega'),
        ),
      );
      passoDeTeste(t, 'teste.voltar', () => Promise.resolve(irPara('contar')));
      const { execucao } = await passos.iniciar(
        {
          tipo: 'CHATBOT',
          nome: 'Fluxo de teste',
          definicao: {
            passos: [
              { id: 'contar', tipo: 'teste.contar' },
              {
                id: 'decidir',
                tipo: 'teste.decidir',
                ramos: [
                  {
                    id: 'de_novo',
                    passos: [{ id: 'voltar', tipo: 'teste.voltar' }],
                  },
                  { id: 'chega', passos: [] },
                ],
              },
              { id: 'fim', tipo: 'teste.contar' },
            ],
          },
        },
        { executarAgora: true },
      );
      const atual = await t.prisma.execucao.findUniqueOrThrow({
        where: { id: execucao.id },
      });
      expect(atual.status).toBe('CONCLUIDA');
      expect(atual.variaveis).toEqual({ contagem: 4 });
      expect(atual.visitas).toEqual({
        contar: 3,
        decidir: 3,
        voltar: 2,
        fim: 1,
      });
      const historico = await historicoDaExecucao(t, execucao.id);
      expect(historico.map((p) => p.chave)).toEqual([
        'contar:1',
        'decidir:1',
        'voltar:1',
        'contar:2',
        'decidir:2',
        'voltar:2',
        'contar:3',
        'decidir:3',
        'fim:1',
      ]);
    });

    it('espera de entrada: retomarComEntrada continua; o job de tempo vencido depois é ignorado', async () => {
      passoDeTeste(t, 'teste.pergunta', (ctx) => {
        if (ctx.retomada?.motivo === 'entrada') {
          return Promise.resolve(
            irParaRamo(ctx.retomada.entrada === '1' ? 'um' : 'outro', {
              variaveis: { resposta: ctx.retomada.entrada },
            }),
          );
        }
        if (ctx.retomada?.motivo === 'tempo') {
          return Promise.resolve(encerrar('sem_resposta'));
        }
        return Promise.resolve(
          aguardarEntrada({ ate: new Date(ctx.agora.getTime() + 600_000) }),
        );
      });
      passoDeTeste(t, 'teste.nada', () => Promise.resolve(seguir()));
      const { execucao } = await passos.iniciar(
        {
          tipo: 'CHATBOT',
          nome: 'Pergunta',
          definicao: {
            passos: [
              {
                id: 'q',
                tipo: 'teste.pergunta',
                ramos: [
                  { id: 'um', passos: [{ id: 'r1', tipo: 'teste.nada' }] },
                  { id: 'outro', passos: [] },
                ],
              },
            ],
          },
        },
        { executarAgora: true },
      );
      let atual = await t.prisma.execucao.findUniqueOrThrow({
        where: { id: execucao.id },
      });
      expect(atual).toMatchObject({
        status: 'AGUARDANDO',
        aguardandoEntrada: true,
      });
      expect(await passos.retomarComEntrada(execucao.id, '1')).toBe(true);
      atual = await t.prisma.execucao.findUniqueOrThrow({
        where: { id: execucao.id },
      });
      expect(atual.status).toBe('CONCLUIDA');
      expect(atual.variaveis).toEqual({ resposta: '1' });
      await avancarPassos(t, { incluirAgendados: true });
      expect(
        (
          await t.prisma.execucao.findUniqueOrThrow({
            where: { id: execucao.id },
          })
        ).motivoFim,
      ).toBe('concluida');
      expect(await passos.retomarComEntrada(execucao.id, '2')).toBe(false);
    });

    it('tempo esgotado sem resposta: o passo decide (encerrar)', async () => {
      const { execucao } = await passos.iniciar(
        {
          tipo: 'CHATBOT',
          nome: 'Pergunta',
          definicao: definicaoLinear('teste.pergunta'),
        },
        { executarAgora: true },
      );
      await avancarPassos(t, { incluirAgendados: true });
      const atual = await t.prisma.execucao.findUniqueOrThrow({
        where: { id: execucao.id },
      });
      expect(atual).toMatchObject({
        status: 'CONCLUIDA',
        motivoFim: 'sem_resposta',
      });
    });

    it('idempotência do início pela chave única', async () => {
      const nova = {
        tipo: 'AUTOMACAO' as const,
        nome: 'X',
        definicao: definicaoLinear('aguardar'),
        chaveUnica: 'automacao:x:evento:1',
      };
      const a = await passos.iniciar(nova);
      const b = await passos.iniciar(nova);
      expect(b.criada).toBe(false);
      expect(b.execucao.id).toBe(a.execucao.id);
      expect(await t.prisma.execucao.count()).toBe(1);
    });

    it('erro temporário: tenta o passo de novo com a mesma chave de idempotência', async () => {
      const chaves: string[] = [];
      passoDeTeste(t, 'teste.instavel', (ctx) => {
        chaves.push(`${ctx.chaveIdempotencia}#${ctx.tentativa}`);
        if (ctx.tentativa === 1) {
          throw new ErroDePassoTemporario('Gateway fora do ar');
        }
        return Promise.resolve(seguir());
      });
      const { execucao } = await passos.iniciar({
        tipo: 'AUTOMACAO',
        nome: 'X',
        definicao: definicaoLinear('teste.instavel'),
      });
      await avancarPassos(t);
      let historico = await historicoDaExecucao(t, execucao.id);
      expect(historico[0]).toMatchObject({
        status: 'EXECUTANDO',
        erro: 'Gateway fora do ar',
      });
      await avancarPassos(t, { incluirAgendados: true });
      historico = await historicoDaExecucao(t, execucao.id);
      expect(historico[0]).toMatchObject({
        status: 'CONCLUIDO',
        tentativas: 2,
      });
      expect(chaves).toEqual([
        `${execucao.id}:p1:1#1`,
        `${execucao.id}:p1:1#2`,
      ]);
    });

    it('erro definitivo: FALHOU; reexecutar o passo com erro conclui', async () => {
      let quebrar = true;
      passoDeTeste(t, 'teste.quebra', () => {
        if (quebrar) {
          throw new Error('Etapa não existe mais');
        }
        return Promise.resolve(seguir());
      });
      const { execucao } = await passos.iniciar(
        {
          tipo: 'AUTOMACAO',
          nome: 'X',
          definicao: definicaoLinear('teste.quebra'),
        },
        { executarAgora: true },
      );
      let atual = await t.prisma.execucao.findUniqueOrThrow({
        where: { id: execucao.id },
      });
      expect(atual).toMatchObject({
        status: 'FALHOU',
        erro: 'Etapa não existe mais',
        passoAtualId: 'p1',
      });
      expect((await historicoDaExecucao(t, execucao.id))[0].status).toBe(
        'ERRO',
      );
      quebrar = false;
      expect(await passos.reexecutarPasso(execucao.id)).toBe(true);
      await avancarPassos(t);
      atual = await t.prisma.execucao.findUniqueOrThrow({
        where: { id: execucao.id },
      });
      expect(atual.status).toBe('CONCLUIDA');
      expect((await historicoDaExecucao(t, execucao.id))[0]).toMatchObject({
        status: 'CONCLUIDO',
        tentativas: 2,
      });
    });

    it('cancelar ativas (atendente assumiu): o despertar depois não faz nada', async () => {
      const conversa = await criarConversa(t);
      const { execucao } = await passos.iniciar(
        {
          tipo: 'CHATBOT',
          nome: 'Fluxo',
          conversaId: conversa.id,
          contatoId: conversa.contatoId,
          definicao: definicaoLinear(
            { tipo: 'aguardar', config: { quantidade: 5, unidade: 'minutos' } },
            'teste.marcar',
          ),
        },
        { executarAgora: true },
      );
      expect(
        await passos.cancelarAtivas(
          { conversaId: conversa.id },
          'atendente_assumiu',
        ),
      ).toBe(1);
      await avancarPassos(t, { incluirAgendados: true });
      const atual = await t.prisma.execucao.findUniqueOrThrow({
        where: { id: execucao.id },
      });
      expect(atual).toMatchObject({
        status: 'CANCELADA',
        motivoFim: 'atendente_assumiu',
      });
      expect(await historicoDaExecucao(t, execucao.id)).toHaveLength(1);
    });

    it('retomada após reinício: execução parada sem job volta pela varredura; trava impede dois avanços', async () => {
      const { execucao } = await passos.iniciar({
        tipo: 'AUTOMACAO',
        nome: 'X',
        definicao: definicaoLinear('teste.marcar'),
      });
      await t.fila.limparTrabalhos();
      await t.prisma
        .$executeRaw`UPDATE execucoes SET atualizado_em = now() - interval '10 minutes', travada_ate = now() + interval '1 minute' WHERE id = ${execucao.id}::uuid`;
      expect((await passos.avancar(execucao.id)).estado).toBe('ocupada');
      await t.prisma
        .$executeRaw`UPDATE execucoes SET atualizado_em = now() - interval '10 minutes', travada_ate = NULL WHERE id = ${execucao.id}::uuid`;
      expect(await passos.retomarParadas()).toBe(1);
      await avancarPassos(t);
      expect(
        (
          await t.prisma.execucao.findUniqueOrThrow({
            where: { id: execucao.id },
          })
        ).status,
      ).toBe('CONCLUIDA');
    });

    it('modo teste: esperas de tempo simuladas na hora', async () => {
      const { execucao } = await passos.iniciar(
        {
          tipo: 'AUTOMACAO',
          nome: 'X',
          teste: true,
          definicao: definicaoLinear(
            { tipo: 'aguardar', config: { quantidade: 3, unidade: 'dias' } },
            'teste.marcar',
          ),
        },
        { executarAgora: true },
      );
      expect(
        (
          await t.prisma.execucao.findUniqueOrThrow({
            where: { id: execucao.id },
          })
        ).status,
      ).toBe('CONCLUIDA');
      const historico = await historicoDaExecucao(t, execucao.id);
      expect(historico[0].resultado).toMatchObject({
        saida: { simulada: true },
      });
      expect(await t.fila.listarTrabalhos(FILA_AVANCAR_PASSOS)).toHaveLength(0);
    });

    it('valida a definição com os tipos registrados', () => {
      let erro: unknown;
      try {
        passos.validarDefinicao('AUTOMACAO', {
          passos: [{ id: 'a', tipo: 'inexistente' }],
        });
      } catch (e) {
        erro = e;
      }
      expect(erro).toBeInstanceOf(DadosInvalidosException);
      expect((erro as DadosInvalidosException).mensagem).toBe(
        'Tipo de passo desconhecido: "inexistente".',
      );
      expect(passos.tiposDisponiveis('AUTOMACAO')).toEqual(
        expect.arrayContaining(['aguardar', 'encerrar']),
      );
    });
  });

  describe('gatilhos', () => {
    it('entrega eventos da outbox ao destino com a entidade e os ids', async () => {
      const admin = await entrarComo(t, await criarUsuario(t));
      await admin
        .post('/api/v1/contatos', {
          nome: 'Ana Souza',
          email: 'ana@exemplo.com',
        })
        .expect(201);
      const contato = await t.prisma.contato.findFirstOrThrow({
        where: { email: 'ana@exemplo.com' },
      });
      await processarEventos(t);
      expect(recebidos).toHaveLength(1);
      expect(recebidos[0]).toMatchObject({
        tipo: 'contato.criado',
        entidade: { tipo: 'contato', id: contato.id },
        cadeia: null,
      });
    });

    it('R19 — eventos publicados por um passo levam a cadeia; no limite de profundidade não são entregues', async () => {
      const automacao = await criarAutomacao(t);
      const contato = await criarContato(t);
      passoDeTeste(t, 'teste.publicar', async (ctx) => {
        await t.prisma.$transaction((tx) =>
          t.eventos.publicar(tx, 'teste.evento', {
            contatoId: ctx.execucao.contatoId,
          }),
        );
        return seguir();
      });
      const { execucao } = await passos.iniciar(
        {
          tipo: 'AUTOMACAO',
          nome: automacao.nome,
          automacaoId: automacao.id,
          contatoId: contato.id,
          definicao: definicaoLinear('teste.publicar'),
        },
        { executarAgora: true },
      );
      await processarEventos(t);
      expect(recebidos.map((g) => g.cadeia)).toEqual([
        {
          execucaoId: execucao.id,
          profundidade: 1,
          automacoes: [automacao.id],
        },
      ]);
      const gravado = await t.prisma.eventoDominio.findFirstOrThrow({
        where: { tipo: 'teste.evento' },
      });
      expect(gravado).toMatchObject({
        tipoAtor: 'AUTOMACAO',
        cadeia: { execucaoId: execucao.id, profundidade: 1 },
      });

      recebidos.length = 0;
      await executarComoAtor(
        {
          tipoAtor: 'AUTOMACAO',
          cadeia: {
            execucaoId: execucao.id,
            profundidade: 5,
            automacoes: ['a', 'b', 'c', 'd', 'e'],
          },
        },
        () =>
          t.prisma.$transaction((tx) =>
            t.eventos.publicar(tx, 'teste.evento', { contatoId: contato.id }),
          ),
      );
      await processarEventos(t);
      expect(recebidos).toHaveLength(0);
      expect(
        await t.prisma.logTecnico.count({
          where: { contexto: 'Gatilhos', nivel: 'AVISO' },
        }),
      ).toBe(1);
    });

    it('a cadeia de origem cresce a cada execução encadeada', async () => {
      const automacao = await criarAutomacao(t);
      const { execucao } = await passos.iniciar({
        tipo: 'AUTOMACAO',
        nome: 'Encadeada',
        automacaoId: automacao.id,
        definicao: definicaoLinear('aguardar'),
        cadeiaDeOrigem: {
          execucaoId: 'outra',
          profundidade: 2,
          automacoes: ['x', automacao.id],
        },
      });
      expect(execucao.cadeia).toEqual({
        execucaoId: execucao.id,
        profundidade: 3,
        automacoes: ['x', automacao.id, automacao.id],
      });
    });

    it('agenda registrada roda pelo executarAgenda; limite de execução por entidade', async () => {
      const gatilhos = t.get(GatilhosService);
      const agora = new Date('2026-10-30T12:00:00Z');
      await gatilhos.executarAgenda('teste-onda-b', agora);
      expect(agendas.at(-1)).toEqual(agora);

      const automacao = await criarAutomacao(t, {
        limiteExecucao: 'UMA_VEZ_POR_PERIODO',
        limitePeriodoDias: 7,
      });
      const contato = await criarContato(t);
      const limite = {
        automacaoId: automacao.id,
        entidadeId: contato.id,
        limite: 'UMA_VEZ_POR_PERIODO' as const,
        periodoDias: 7,
      };
      expect(await gatilhos.podeExecutarParaEntidade(limite)).toBe(true);
      await passos.iniciar({
        tipo: 'AUTOMACAO',
        nome: 'X',
        automacaoId: automacao.id,
        entidadeId: contato.id,
        definicao: definicaoLinear('aguardar'),
        teste: true,
      });
      expect(await gatilhos.podeExecutarParaEntidade(limite)).toBe(true);
      await passos.iniciar({
        tipo: 'AUTOMACAO',
        nome: 'X',
        automacaoId: automacao.id,
        entidadeId: contato.id,
        definicao: definicaoLinear('aguardar'),
      });
      expect(await gatilhos.podeExecutarParaEntidade(limite)).toBe(false);
      expect(
        await gatilhos.podeExecutarParaEntidade({
          ...limite,
          agora: new Date(Date.now() + 8 * 86_400_000),
        }),
      ).toBe(true);
    });
  });

  describe('segmentos e modelos', () => {
    async function cenario() {
      const ana = await criarContato(t, {
        nome: 'Ana Souza',
        etiquetas: ['vip'],
      });
      await t.prisma.contato.update({
        where: { id: ana.id },
        data: {
          camposPersonalizados: { cidade: 'Campinas', pontos: 10 },
          ultimaOrigemUtm: { source: 'instagram' },
        },
      });
      const bruno = await criarContato(t, {
        nome: 'Bruno Lima',
        etiquetas: ['frio'],
      });
      await t.prisma.contato.update({
        where: { id: bruno.id },
        data: { optOutMarketing: true },
      });
      const carla = await criarContato(t, { nome: 'Carla Dias' });
      await t.prisma.contato.update({
        where: { id: carla.id },
        data: { camposPersonalizados: { cidade: '' } },
      });
      const negocio = await criarNegocio(t, { contato: carla });
      const conversa = await criarConversa(t, { contato: carla });
      await t.prisma.conversa.update({
        where: { id: conversa.id },
        data: { ultimaMensagemEm: new Date() },
      });
      return { ana, bruno, carla, negocio };
    }

    async function ids(
      condicoes: unknown[],
      opcoes: { excluirOptOut?: boolean; negocioId?: string } = {},
    ) {
      const segmentos = t.get(SegmentosService);
      const resultado: string[] = [];
      for await (const lote of segmentos.iterarIds(
        validarSegmento({ condicoes }),
        { ...opcoes, lote: 1 },
      )) {
        resultado.push(...lote);
      }
      return resultado.sort();
    }

    it('filtros de etiquetas, campos personalizados, UTM, negócio, última interação e opt-out (R4.6)', async () => {
      const { ana, bruno, carla, negocio } = await cenario();
      const ordenar = (...lista: string[]) => lista.sort();
      expect(await ids([])).toEqual(ordenar(ana.id, carla.id));
      expect(await ids([], { excluirOptOut: false })).toEqual(
        ordenar(ana.id, bruno.id, carla.id),
      );
      expect(
        await ids(
          [
            {
              campo: 'etiquetas',
              operador: 'contem_alguma',
              valor: ['vip', 'frio'],
            },
          ],
          { excluirOptOut: false },
        ),
      ).toEqual(ordenar(ana.id, bruno.id));
      expect(
        await ids([{ campo: 'campos.cidade', operador: 'preenchido' }]),
      ).toEqual([ana.id]);
      expect(
        await ids([{ campo: 'campos.cidade', operador: 'vazio' }], {
          excluirOptOut: false,
        }),
      ).toEqual(ordenar(bruno.id, carla.id));
      expect(
        await ids([{ campo: 'campos.pontos', operador: 'maior', valor: 5 }]),
      ).toEqual([ana.id]);
      expect(
        await ids([
          { campo: 'campos.cidade', operador: 'igual', valor: 'Campinas' },
        ]),
      ).toEqual([ana.id]);
      expect(
        await ids([
          { campo: 'utm.source', operador: 'igual', valor: 'instagram' },
        ]),
      ).toEqual([ana.id]);
      expect(
        await ids([
          { campo: 'negocio', operador: 'tem', valor: { status: ['ABERTO'] } },
        ]),
      ).toEqual([carla.id]);
      expect(
        await ids([{ campo: 'negocio', operador: 'tem', valor: {} }], {
          negocioId: negocio.id,
        }),
      ).toEqual([carla.id]);
      expect(
        await ids([
          { campo: 'ultima_interacao_em', operador: 'ultimos_dias', valor: 1 },
        ]),
      ).toEqual([carla.id]);
      expect(
        await ids([
          { campo: 'ultima_interacao_em', operador: 'mais_de_dias', valor: 1 },
        ]),
      ).toEqual([ana.id]);
      expect(
        await t.get(SegmentosService).contem(
          validarSegmento({
            condicoes: [{ campo: 'opt_out', operador: 'igual', valor: true }],
          }),
          bruno.id,
          { excluirOptOut: false },
        ),
      ).toBe(true);
    });

    it('POST /segmentos/previa conta e mostra amostra; segmento inválido → 400 com os problemas; GET /segmentos/campos', async () => {
      await cenario();
      const usuario = await entrarComo(
        t,
        await criarUsuario(t, { papel: 'MARKETING' }),
      );
      const previa = await usuario
        .post('/api/v1/segmentos/previa', {
          segmento: {
            condicoes: [
              { campo: 'etiquetas', operador: 'contem_alguma', valor: ['vip'] },
            ],
          },
          amostra: 5,
        })
        .expect(200);
      expect(previa.body).toMatchObject({
        total: 1,
        amostra: [{ nome: 'Ana Souza', etiquetas: ['vip'] }],
      });
      const invalido = await usuario
        .post('/api/v1/segmentos/previa', {
          segmento: { condicoes: [{ campo: 'xpto', operador: 'igual' }] },
        })
        .expect(400);
      expect(invalido.body.detalhes.problemas).toEqual([
        {
          caminho: 'segmento.condicoes[0].campo',
          mensagem: 'Campo desconhecido: "xpto".',
        },
      ]);
      const campos = await usuario.get('/api/v1/segmentos/campos').expect(200);
      expect(campos.body.campos.etiquetas.operadores.contem_alguma.valor).toBe(
        'textos',
      );
      expect(campos.body.camposPersonalizados.chaves).toEqual([
        'cidade',
        'pontos',
      ]);
    });

    it('POST /modelos/previa renderiza para o contato e aponta variáveis desconhecidas; GET /modelos/variaveis', async () => {
      const { ana } = await cenario();
      const usuario = await entrarComo(
        t,
        await criarUsuario(t, { papel: 'COMERCIAL' }),
      );
      const previa = await usuario
        .post('/api/v1/modelos/previa', {
          texto:
            'Oi {{contato.primeiro_nome}} de {{contato.campos.cidade}}{{x.y}}',
          contatoId: ana.id,
        })
        .expect(200);
      expect(previa.body).toMatchObject({
        texto: 'Oi Ana de Campinas',
        variaveis: ['contato.primeiro_nome', 'contato.campos.cidade', 'x.y'],
      });
      expect(previa.body.erros).toEqual([
        {
          mensagem: 'Variável desconhecida: {{x.y}}.',
          inicio: 57,
          fim: 64,
          variavel: 'x.y',
        },
      ]);
      const exemplo = await usuario
        .post('/api/v1/modelos/previa', { texto: '{{contato.nome}}' })
        .expect(200);
      expect(exemplo.body.texto).toBe('Ana Souza');
      await usuario
        .post('/api/v1/modelos/previa', {
          texto: 'x',
          contatoId: '2b1f0c9e-7c1a-4e7b-9a52-0d1c2b3a4f5e',
        })
        .expect(404);
      const variaveis = await usuario
        .get('/api/v1/modelos/variaveis')
        .expect(200);
      expect(variaveis.body.camposPersonalizados.contato).toEqual([
        'cidade',
        'pontos',
      ]);
    });
  });

  it('fábricas da Onda B criam campanha, fluxo publicado e importação', async () => {
    const campanha = await criarCampanha(t);
    expect(
      await t.prisma.campanhaCanal.count({
        where: { campanhaId: campanha.id },
      }),
    ).toBe(1);
    const fluxo = await criarFluxoChatbot(t, {
      definicao: definicaoLinear('aguardar'),
    });
    expect(fluxo.versaoPublicada?.numero).toBe(1);
    const importacao = await criarImportacao(t);
    expect(importacao).toMatchObject({ formato: 'csv', status: 'RASCUNHO' });
  });
});
