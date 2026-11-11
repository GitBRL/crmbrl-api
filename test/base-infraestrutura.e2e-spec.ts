import { randomUUID } from 'node:crypto';
import request from 'supertest';
import {
  AuditoriaService,
  filtroDeLinhaDoTempo,
} from '../src/auditoria/auditoria.service';
import { executarComoAtor } from '../src/comum/contexto/contexto-requisicao';
import {
  type EventoPublicado,
  FILA_EVENTOS_DOMINIO,
} from '../src/eventos/eventos-dominio.service';
import type { Trabalho } from '../src/fila/fila.service';
import { NotificacoesService } from '../src/notificacoes/notificacoes.service';
import { travarChave } from '../src/prisma/travas';
import { SeedsService } from '../src/seeds/seeds.service';
import { FILA_DE_TESTE, RotasDeTesteModule } from './base-rotas-de-teste';
import {
  type AppTeste,
  clienteAnonimo,
  criarAppTeste,
  criarContato,
  criarEquipe,
  criarNegocio,
  criarUsuario,
  drenarFilas,
  entrarComo,
  funilBase,
  ORIGEM_DE_TESTE,
  processarEventos,
} from './utils';

describe('Base — infraestrutura (e2e)', () => {
  let t: AppTeste;
  const recebidosPorTodos: EventoPublicado[] = [];
  const recebidosDeTeste: EventoPublicado[] = [];
  let falhasProgramadas = 0;
  const trabalhos: Trabalho<Record<string, unknown>>[] = [];
  let falhasDoTrabalho = 0;

  beforeAll(async () => {
    t = await criarAppTeste({ importar: [RotasDeTesteModule] });
    t.eventos.registrarManipulador(
      '*',
      async (evento) => {
        recebidosPorTodos.push(evento);
      },
      'teste:todos',
    );
    t.eventos.registrarManipulador(
      'teste.criado',
      async (evento) => {
        if (falhasProgramadas > 0) {
          falhasProgramadas--;
          throw new Error('falha programada do manipulador');
        }
        recebidosDeTeste.push(evento);
      },
      'teste:especifico',
    );
    await t.fila.trabalhar<Record<string, unknown>>(
      FILA_DE_TESTE,
      async (trabalho) => {
        if (falhasDoTrabalho > 0) {
          falhasDoTrabalho--;
          throw new Error('falha programada do job');
        }
        trabalhos.push(trabalho);
      },
    );
  });

  beforeEach(async () => {
    await t.limparBanco();
    recebidosPorTodos.length = 0;
    recebidosDeTeste.length = 0;
    trabalhos.length = 0;
    falhasProgramadas = 0;
    falhasDoTrabalho = 0;
  });

  afterAll(async () => {
    await t.fechar();
  });

  describe('convenções da API', () => {
    it('rotas de negócio em /api/v1; /api/saude sem versão e sem login', async () => {
      await clienteAnonimo(t).get('/api/v1/auth/eu').expect(401);
      await clienteAnonimo(t).get('/api/auth/eu').expect(404);
      const saude = await clienteAnonimo(t).get('/api/saude').expect(200);
      expect(saude.body).toMatchObject({
        status: 'ok',
        banco: { status: 'ok' },
      });
    });

    it('validação: lista branca, mensagens em português e campos aninhados', async () => {
      const resposta = await clienteAnonimo(t)
        .post('/api/v1/teste-base/validar', {
          email: 'nao-e-email',
          nome: 'ab',
          endereco: { cidade: 3 },
          intruso: true,
        })
        .expect(400);
      expect(resposta.body.erro).toBe('dados_invalidos');
      expect(resposta.body.mensagem).toMatch(/^Dados inválidos — /);
      expect(resposta.body.detalhes.campos).toEqual(
        expect.arrayContaining([
          { campo: 'intruso', mensagens: ['não é um campo aceito'] },
          { campo: 'email', mensagens: ['deve ser um e-mail válido'] },
          { campo: 'nome', mensagens: ['deve ter pelo menos 3 caracteres'] },
          { campo: 'endereco.cidade', mensagens: ['deve ser um texto'] },
        ]),
      );
    });

    it('JSON malformado e corpo grande demais saem no formato padrão', async () => {
      const malformado = await request(t.servidor)
        .post('/api/v1/teste-base/validar')
        .set('Origin', ORIGEM_DE_TESTE)
        .set('Content-Type', 'application/json')
        .send('{"email": ')
        .expect(400);
      expect(malformado.body).toMatchObject({
        erro: 'dados_invalidos',
        mensagem: 'O corpo da requisição não é um JSON válido.',
      });
      const grande = await request(t.servidor)
        .post('/api/v1/teste-base/validar')
        .set('Origin', ORIGEM_DE_TESTE)
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({ email: 'a@b.com', nome: 'x'.repeat(1_100_000) }))
        .expect(413);
      expect(grande.body.erro).toBe('muito_grande');
    });

    it('erros da API e do Prisma viram o corpo padrão (422 com a regra, 409, 404, 429 com Retry-After)', async () => {
      const regra = await clienteAnonimo(t)
        .get('/api/v1/teste-base/erro/regra')
        .expect(422);
      expect(regra.body).toEqual({
        statusCode: 422,
        erro: 'regra_violada',
        mensagem: 'O líder precisa ser da mesma área.',
        detalhes: { regra: 'R1.2', liderId: 'x' },
        requisicaoId: regra.headers['x-request-id'],
      });
      await clienteAnonimo(t)
        .get('/api/v1/teste-base/erro/conflito')
        .expect(409);
      const unico = await clienteAnonimo(t)
        .get('/api/v1/teste-base/erro/prisma-unico')
        .expect(409);
      expect(unico.body).toMatchObject({
        erro: 'conflito',
        detalhes: { campos: ['email'], restricao: 'usuarios_email_key' },
      });
      const inexistente = await clienteAnonimo(t)
        .get('/api/v1/teste-base/erro/prisma-inexistente')
        .expect(404);
      expect(inexistente.body.erro).toBe('nao_encontrado');
      const tentativas = await clienteAnonimo(t)
        .get('/api/v1/teste-base/erro/tentativas')
        .expect(429);
      expect(tentativas.headers['retry-after']).toBe('42');
    });

    it('R3.6 — erro 500 não vaza detalhes e fica nos logs técnicos com o id da requisição', async () => {
      const resposta = await clienteAnonimo(t)
        .get('/api/v1/teste-base/erro/interno')
        .set('X-Request-Id', 'req-erro-500')
        .expect(500);
      expect(resposta.body).toEqual({
        statusCode: 500,
        erro: 'erro_interno',
        mensagem:
          'Erro interno. Tente de novo; se persistir, informe o código req-erro-500.',
        requisicaoId: 'req-erro-500',
      });
      expect(resposta.text).not.toContain('detalhe secreto');
      await esperarAte(async () => (await t.prisma.logTecnico.count()) > 0);
      const log = await t.prisma.logTecnico.findFirstOrThrow({
        where: { requisicaoId: 'req-erro-500' },
      });
      expect(log).toMatchObject({
        nivel: 'ERRO',
        contexto: 'HTTP',
        mensagem: 'falha interna com detalhe secreto',
        metodo: 'GET',
        rota: '/api/v1/teste-base/erro/:tipo',
        status: 500,
      });
      expect(JSON.stringify(log.dados)).toContain('pilha');
    });

    it('R3.7 — o contexto da requisição tem id, IP e o usuário autenticado', async () => {
      const usuario = await criarUsuario(t, { papel: 'CS', nome: 'Carla CS' });
      const cliente = await entrarComo(t, usuario);
      const resposta = await cliente
        .get('/api/v1/teste-base/contexto')
        .set('X-Request-Id', 'meu-id-123')
        .set('X-Forwarded-For', '198.51.100.20')
        .set('User-Agent', 'navegador-de-teste')
        .expect(200);
      expect(resposta.headers['x-request-id']).toBe('meu-id-123');
      expect(resposta.body).toMatchObject({
        requisicaoId: 'meu-id-123',
        ip: '198.51.100.20',
        userAgent: 'navegador-de-teste',
        tipoAtor: 'USUARIO',
        atorDescricao: 'Carla CS',
        usuario: { id: usuario.id, papel: 'MEMBRO', nome: 'Carla CS' },
      });
    });
  });

  describe('auditoria', () => {
    it('R3.1 — grava ator, contexto, relacionados e dados sem segredos', async () => {
      const contato = await criarContato(t);
      const resposta = await clienteAnonimo(t)
        .post('/api/v1/teste-base/auditar', { contatoId: contato.id })
        .set('X-Request-Id', 'req-auditoria')
        .set('X-Forwarded-For', '192.0.2.10')
        .expect(201);
      const evento = await t.prisma.eventoAuditoria.findUniqueOrThrow({
        where: { id: BigInt(resposta.body.id as string) },
      });
      expect(evento).toMatchObject({
        tipoAtor: 'USUARIO',
        usuarioId: null,
        acao: 'teste.auditado',
        entidade: 'negocio',
        resumo: 'Evento de teste',
        ip: '192.0.2.10',
        requisicaoId: 'req-auditoria',
        dados: {
          senha: '[omitido]',
          valor: 10,
          quando: '2026-01-02T03:04:05.000Z',
        },
      });
      expect(evento.relacionados).toEqual([
        'negocio:11111111-1111-4111-8111-111111111111',
        `contato:${contato.id}`,
      ]);
      const linhaDoTempo = await t.prisma.eventoAuditoria.findMany({
        where: filtroDeLinhaDoTempo('contato', contato.id),
      });
      expect(linhaDoTempo.map(({ acao }) => acao)).toEqual(['teste.auditado']);
    });

    it('R3.1 — fora de uma requisição, o ator vem de executarComoAtor', async () => {
      const evento = await executarComoAtor(
        { tipoAtor: 'WEBHOOK', descricao: 'Landing page' },
        () =>
          t.prisma.$transaction((tx) =>
            t.get(AuditoriaService).registrar(tx, {
              acao: 'contato.criado',
              entidade: 'contato',
              entidadeId: randomUUID(),
              resumo: 'Contato criado pelo webhook',
            }),
          ),
      );
      expect(evento).toMatchObject({
        tipoAtor: 'WEBHOOK',
        atorDescricao: 'Landing page',
        usuarioId: null,
      });
      expect(evento.requisicaoId).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('cenário 14 — R3.3: UPDATE, DELETE e TRUNCATE em eventos_auditoria falham', async () => {
      await t.prisma.$transaction((tx) =>
        t.get(AuditoriaService).registrar(tx, {
          acao: 'teste.imutavel',
          entidade: 'teste',
          resumo: 'Não pode mudar',
        }),
      );
      await expect(
        t.prisma.$executeRaw`UPDATE eventos_auditoria SET resumo = 'alterado'`,
      ).rejects.toThrow(/somente inclusão \(R3\.3\): UPDATE/);
      await expect(
        t.prisma.$executeRaw`DELETE FROM eventos_auditoria`,
      ).rejects.toThrow(/somente inclusão \(R3\.3\): DELETE/);
      await expect(
        t.prisma.$executeRaw`TRUNCATE eventos_auditoria`,
      ).rejects.toThrow(/somente inclusão \(R3\.3\): TRUNCATE/);
      await expect(
        t.prisma.eventoAuditoria.updateMany({ data: { resumo: 'alterado' } }),
      ).rejects.toThrow();
      const eventos = await t.prisma.eventoAuditoria.findMany({
        where: { acao: 'teste.imutavel' },
      });
      expect(eventos).toHaveLength(1);
      expect(eventos[0].resumo).toBe('Não pode mudar');
    });
  });

  describe('eventos de domínio (outbox)', () => {
    it('R10.1 — evento de transação desfeita não existe; o confirmado chega aos manipuladores fora da transação', async () => {
      await clienteAnonimo(t)
        .post('/api/v1/teste-base/publicar?falhar=1', { valor: 1 })
        .expect(409);
      expect(await t.prisma.eventoDominio.count()).toBe(0);

      const resposta = await clienteAnonimo(t)
        .post('/api/v1/teste-base/publicar', {
          negocioId: 'n-1',
          valor: '1500.00',
        })
        .set('X-Request-Id', 'req-evento')
        .expect(201);
      expect(recebidosDeTeste).toHaveLength(0);

      expect(await processarEventos(t)).toBe(1);
      expect(recebidosDeTeste).toHaveLength(1);
      expect(recebidosDeTeste[0]).toMatchObject({
        id: resposta.body.id,
        tipo: 'teste.criado',
        dados: { negocioId: 'n-1', valor: '1500.00' },
        tipoAtor: 'USUARIO',
        requisicaoId: 'req-evento',
        tentativa: 1,
      });
      expect(recebidosPorTodos.map(({ id }) => id)).toEqual([resposta.body.id]);
      const registro = await t.prisma.eventoDominio.findUniqueOrThrow({
        where: { id: resposta.body.id },
      });
      expect(registro.enfileiradoEm).not.toBeNull();
      expect(registro.processadoEm).not.toBeNull();
      expect(
        registro.manipuladoresConcluidos
          .filter((nome) => !nome.startsWith('gatilhos:'))
          .sort(),
      ).toEqual(['teste:especifico', 'teste:todos']);
      expect(await processarEventos(t)).toBe(0);
    });

    it('R10.1 — manipulador que falha recebe de novo; os que já concluíram não repetem', async () => {
      falhasProgramadas = 1;
      const resposta = await clienteAnonimo(t)
        .post('/api/v1/teste-base/publicar', { n: 2 })
        .expect(201);

      await processarEventos(t);
      expect(recebidosDeTeste).toHaveLength(0);
      expect(recebidosPorTodos).toHaveLength(1);
      const falhou = await t.prisma.eventoDominio.findUniqueOrThrow({
        where: { id: resposta.body.id },
      });
      expect(falhou).toMatchObject({ processadoEm: null, tentativas: 1 });
      expect(falhou.erro).toContain('falha programada do manipulador');
      expect(
        await t.prisma.logTecnico.count({
          where: { contexto: 'Eventos', nivel: 'ERRO' },
        }),
      ).toBe(1);

      await processarEventos(t, { incluirAgendados: true });
      expect(recebidosDeTeste).toHaveLength(1);
      expect(recebidosDeTeste[0].tentativa).toBe(2);
      expect(recebidosPorTodos).toHaveLength(1);
      const entregue = await t.prisma.eventoDominio.findUniqueOrThrow({
        where: { id: resposta.body.id },
      });
      expect(entregue.processadoEm).not.toBeNull();
      expect(entregue.erro).toBeNull();
    });

    it('cada evento vira um job na fila do pg-boss', async () => {
      await clienteAnonimo(t)
        .post('/api/v1/teste-base/publicar', { n: 3 })
        .expect(201);
      expect(await t.eventos.despacharAgora()).toBe(1);
      const jobs = await t.fila.listarTrabalhos<{ eventoId: string }>(
        FILA_EVENTOS_DOMINIO,
      );
      expect(jobs).toHaveLength(1);
      expect(jobs[0].dados.eventoId).toMatch(/^[0-9a-f-]{36}$/);
    });
  });

  describe('fila', () => {
    it('job enviado na transação só existe se ela confirmar; o manipulador recebe os dados e o id da requisição', async () => {
      await clienteAnonimo(t)
        .post('/api/v1/teste-base/enfileirar?falhar=1', { a: 1 })
        .expect(409);
      expect(await drenarFilas(t, FILA_DE_TESTE)).toBe(0);

      const resposta = await clienteAnonimo(t)
        .post('/api/v1/teste-base/enfileirar', { a: 2 })
        .set('X-Request-Id', 'req-fila')
        .expect(201);
      expect(resposta.body.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(await drenarFilas(t, FILA_DE_TESTE)).toBe(1);
      expect(trabalhos).toHaveLength(1);
      expect(trabalhos[0]).toMatchObject({
        fila: FILA_DE_TESTE,
        dados: { a: 2 },
        tentativa: 1,
      });
    });

    it('R3.6 — job que falha vai para os logs técnicos e é tentado de novo', async () => {
      falhasDoTrabalho = 1;
      await t.fila.enviar(
        FILA_DE_TESTE,
        { b: 1 },
        { tentativas: 2, intervaloEntreTentativasSegundos: 60 },
      );
      await drenarFilas(t, FILA_DE_TESTE);
      expect(trabalhos).toHaveLength(0);
      expect(
        await t.prisma.logTecnico.count({
          where: { contexto: `Fila:${FILA_DE_TESTE}` },
        }),
      ).toBe(1);
      const pendentes = await t.fila.listarTrabalhos(FILA_DE_TESTE);
      expect(pendentes).toHaveLength(1);
      expect(pendentes[0].estado).toBe('retry');

      await drenarFilas(t, FILA_DE_TESTE, { incluirAgendados: true });
      expect(trabalhos).toHaveLength(1);
      expect(trabalhos[0].tentativa).toBe(2);
    });

    it('agendamento futuro só roda quando chega a hora (ou drenando os agendados)', async () => {
      await t.fila.enviar(FILA_DE_TESTE, { c: 1 }, { atrasoSegundos: 3600 });
      expect(await drenarFilas(t, FILA_DE_TESTE)).toBe(0);
      const [pendente] = await t.fila.listarTrabalhos(FILA_DE_TESTE);
      expect(pendente.executarEm.getTime()).toBeGreaterThan(
        Date.now() + 3500_000,
      );
      expect(
        await drenarFilas(t, FILA_DE_TESTE, { incluirAgendados: true }),
      ).toBe(1);
    });
  });

  describe('notificações', () => {
    it('R10.2 — listar, contar, marcar uma e todas como lidas, só as do próprio usuário', async () => {
      const ana = await criarUsuario(t, { papel: 'COMERCIAL' });
      const bruno = await criarUsuario(t, { papel: 'COMERCIAL' });
      const ids: string[] = [];
      for (const titulo of ['Primeira', 'Segunda', 'Terceira']) {
        const resposta = await clienteAnonimo(t)
          .post('/api/v1/teste-base/notificar', { usuarioId: ana.id, titulo })
          .expect(201);
        ids.push(resposta.body.id as string);
      }
      const deBruno = await clienteAnonimo(t)
        .post('/api/v1/teste-base/notificar', {
          usuarioId: bruno.id,
          titulo: 'Do Bruno',
        })
        .expect(201);

      const clienteAna = await entrarComo(t, ana);
      const lista = await clienteAna
        .get('/api/v1/notificacoes?porPagina=2')
        .expect(200);
      expect(lista.body).toMatchObject({
        total: 3,
        pagina: 1,
        porPagina: 2,
        naoLidas: 3,
      });
      expect(lista.body.itens).toHaveLength(2);
      expect(lista.body.itens[0]).toMatchObject({
        titulo: 'Terceira',
        tipo: 'negocio.atribuido',
        link: '/funis/comercial',
        lidaEm: null,
      });

      const lida = await clienteAna
        .post(`/api/v1/notificacoes/${ids[0]}/marcar-lida`)
        .expect(200);
      expect(lida.body.lidaEm).not.toBeNull();
      const contagem = await clienteAna
        .get('/api/v1/notificacoes/nao-lidas/contagem')
        .expect(200);
      expect(contagem.body).toEqual({ naoLidas: 2 });
      await clienteAna
        .post(`/api/v1/notificacoes/${deBruno.body.id as string}/marcar-lida`)
        .expect(404);
      await clienteAna
        .post('/api/v1/notificacoes/nao-e-uuid/marcar-lida')
        .expect(400);

      const todas = await clienteAna
        .post('/api/v1/notificacoes/marcar-todas-lidas')
        .expect(200);
      expect(todas.body).toEqual({ marcadas: 2 });
      const naoLidas = await clienteAna
        .get('/api/v1/notificacoes?apenasNaoLidas=true')
        .expect(200);
      expect(naoLidas.body).toMatchObject({ total: 0, naoLidas: 0 });
      expect(
        (
          await (
            await entrarComo(t, bruno)
          )
            .get('/api/v1/notificacoes')
            .expect(200)
        ).body.naoLidas,
      ).toBe(1);
    });

    it('R10.2 — alertas de sistema vão para todos os Admins ativos', async () => {
      await criarUsuario(t, { papel: 'ADMIN' });
      await criarUsuario(t, { papel: 'ADMIN' });
      await criarUsuario(t, { papel: 'ADMIN', ativo: false });
      await criarEquipe(t, 'CS');
      const criadas = await t.prisma.$transaction((tx) =>
        t.get(NotificacoesService).notificarAdmins(tx, {
          tipo: 'equipe.sem_lider',
          titulo: 'Equipe sem líder',
        }),
      );
      expect(criadas).toBe(2);
    });
  });

  describe('configuração inicial', () => {
    it('R5.2 — funis-base com as etapas iniciais, prazos e tipos', async () => {
      const resumo = async (area: 'MARKETING' | 'COMERCIAL' | 'CS') =>
        (await funilBase(t, area)).etapas.map(({ nome, tipo, prazoDias }) => [
          nome,
          tipo,
          prazoDias,
        ]);
      expect(await resumo('MARKETING')).toEqual([
        ['Novo lead', 'ABERTA', 2],
        ['Em contato', 'ABERTA', 5],
        ['Nutrição', 'ABERTA', 15],
        ['Qualificado (MQL)', 'GANHO', null],
        ['Descartado', 'PERDIDO', null],
      ]);
      expect(await resumo('COMERCIAL')).toEqual([
        ['Novo', 'ABERTA', 1],
        ['Qualificação', 'ABERTA', 5],
        ['Apresentação', 'ABERTA', 7],
        ['Proposta', 'ABERTA', 7],
        ['Negociação', 'ABERTA', 10],
        ['Ganho', 'GANHO', null],
        ['Perdido', 'PERDIDO', null],
      ]);
      expect(await resumo('CS')).toEqual([
        ['Boas-vindas', 'ABERTA', 2],
        ['Onboarding', 'ABERTA', 15],
        ['Implantação', 'ABERTA', 30],
        ['Acompanhamento', 'ABERTA', null],
        ['Renovação', 'ABERTA', 30],
        ['Renovado', 'GANHO', null],
        ['Cancelado (churn)', 'PERDIDO', null],
      ]);
      const funis = await t.prisma.funil.findMany({
        orderBy: { ordem: 'asc' },
      });
      expect(funis.map(({ nome, area, base }) => [nome, area, base])).toEqual([
        ['Marketing', 'MARKETING', true],
        ['Comercial', 'COMERCIAL', true],
        ['Customer Success', 'CS', true],
      ]);
    });

    it('R5.7 — passagens Marketing → Comercial (MQL → Novo) e Comercial → CS (Ganho → Boas-vindas), por rodízio', async () => {
      const passagens = await t.prisma.passagem.findMany({
        include: {
          etapaGatilho: true,
          etapaDestino: true,
          funilOrigem: true,
          funilDestino: true,
        },
        orderBy: { chave: 'asc' },
      });
      expect(
        passagens.map((passagem) => ({
          chave: passagem.chave,
          gatilho: `${passagem.funilOrigem.nome}/${passagem.etapaGatilho.nome}`,
          destino: `${passagem.funilDestino.nome}/${passagem.etapaDestino.nome}`,
          estrategia: passagem.estrategia,
          ativa: passagem.ativa,
        })),
      ).toEqual([
        {
          chave: 'comercial_cs',
          gatilho: 'Comercial/Ganho',
          destino: 'Customer Success/Boas-vindas',
          estrategia: 'RODIZIO',
          ativa: true,
        },
        {
          chave: 'marketing_comercial',
          gatilho: 'Marketing/Qualificado (MQL)',
          destino: 'Comercial/Novo',
          estrategia: 'RODIZIO',
          ativa: true,
        },
      ]);
      const regras = await t.prisma.regraDistribuicao.findMany({
        orderBy: { setor: { ordem: 'asc' } },
      });
      expect(
        regras.map(({ area, incluirLideres }) => [area, incluirLideres]),
      ).toEqual([
        ['MARKETING', false],
        ['COMERCIAL', false],
        ['CS', false],
      ]);
    });

    it('é idempotente e não desfaz o que foi configurado depois', async () => {
      const comercial = await funilBase(t, 'COMERCIAL');
      await t.prisma.etapa.update({
        where: { id: comercial.etapas[0].id },
        data: { nome: 'Entrada' },
      });
      const resumo = await t.get(SeedsService).executar();
      expect(resumo).toEqual({
        funisCriados: 0,
        passagensCriadas: 0,
        regrasCriadas: 0,
        adminCriado: false,
      });
      expect(await t.prisma.funil.count()).toBe(3);
      expect(await t.prisma.etapa.count()).toBe(19);
      expect((await funilBase(t, 'COMERCIAL')).etapas[0].nome).toBe('Entrada');
      expect(
        await t.prisma.eventoAuditoria.count({
          where: { acao: 'funil.criado', tipoAtor: 'SISTEMA' },
        }),
      ).toBe(3);
    });
  });

  describe('garantias do banco', () => {
    it('R5.2 — um funil não tem duas etapas de ganho', async () => {
      const marketing = await funilBase(t, 'MARKETING');
      await expect(
        t.prisma.etapa.create({
          data: {
            funilId: marketing.id,
            nome: 'Outro ganho',
            ordem: 99,
            tipo: 'GANHO',
          },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });
    });

    it('R5.1 — só um funil-base por área, e ele não é excluído', async () => {
      await expect(
        t.prisma.funil.create({
          data: { nome: 'Outro', area: 'CS', base: true },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });
      await t.prisma.funil.create({
        data: { nome: 'Extra de CS', area: 'CS', base: false },
      });
      const base = await funilBase(t, 'CS');
      await expect(
        t.prisma.funil.update({
          where: { id: base.id },
          data: { excluidoEm: new Date() },
        }),
      ).rejects.toThrow(/funis_base_nao_excluido_check/);
    });

    it('R4.2 — e-mail e telefone únicos entre os contatos não excluídos', async () => {
      const contato = await criarContato(t, {
        email: 'unico@teste.local',
        telefone: '(11) 98765-4321',
      });
      await expect(
        criarContato(t, { email: 'unico@teste.local' }),
      ).rejects.toMatchObject({ code: 'P2002' });
      await expect(
        criarContato(t, { email: null, telefone: '+55 11 98765-4321' }),
      ).rejects.toMatchObject({ code: 'P2002' });
      await t.prisma.contato.update({
        where: { id: contato.id },
        data: { excluidoEm: new Date() },
      });
      await criarContato(t, {
        email: 'unico@teste.local',
        telefone: '11987654321',
      });
    });

    it('R4.3 — a primeira origem do contato não muda', async () => {
      const contato = await criarContato(t, { origem: 'WEBHOOK' });
      await expect(
        t.prisma.contato.update({
          where: { id: contato.id },
          data: { primeiraOrigem: 'MANUAL' },
        }),
      ).rejects.toThrow(/primeira origem do contato é imutável/);
      // Pela API, o mesmo erro sairia como 422 com a regra (traduzirErroDoPrisma).
      await t.prisma.contato.update({
        where: { id: contato.id },
        data: { ultimaOrigem: 'SITE' },
      });
    });

    it('R5.7 — a passagem roda uma única vez por negócio de origem', async () => {
      const passagem = await t.prisma.passagem.findUniqueOrThrow({
        where: { chave: 'marketing_comercial' },
      });
      const negocio = await criarNegocio(t, { area: 'MARKETING' });
      await t.prisma.passagemExecucao.create({
        data: { passagemId: passagem.id, negocioOrigemId: negocio.id },
      });
      await expect(
        t.prisma.passagemExecucao.create({
          data: { passagemId: passagem.id, negocioOrigemId: negocio.id },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });
    });

    it('R5.3 — valor do negócio não pode ser negativo', async () => {
      await expect(criarNegocio(t, { valor: '-1' })).rejects.toThrow();
    });

    it('travarChave serializa transações com a mesma chave', async () => {
      const ordem: string[] = [];
      let liberar!: () => void;
      const segura = new Promise<void>((resolver) => {
        liberar = resolver;
      });
      const primeira = t.prisma.$transaction(async (tx) => {
        await travarChave(tx, 'teste', 'chave-1');
        ordem.push('primeira:travou');
        await segura;
        ordem.push('primeira:liberou');
      });
      await esperarAte(async () => ordem.includes('primeira:travou'));
      const segunda = t.prisma.$transaction(async (tx) => {
        await travarChave(tx, 'teste', 'chave-1');
        ordem.push('segunda:travou');
      });
      await new Promise((resolver) => setTimeout(resolver, 200));
      expect(ordem).toEqual(['primeira:travou']);
      liberar();
      await Promise.all([primeira, segunda]);
      expect(ordem).toEqual([
        'primeira:travou',
        'primeira:liberou',
        'segunda:travou',
      ]);
    });
  });
});

describe('Base — documentação da API restrita ao Admin (e2e)', () => {
  let t: AppTeste;

  beforeAll(async () => {
    t = await criarAppTeste({ variaveis: { DOCS_PUBLICAS: 'false' } });
  });

  afterAll(async () => {
    await t.fechar();
  });

  it('R11 — /api/docs-json: 401 sem sessão, 403 para quem não é Admin, 200 para o Admin', async () => {
    const anonimo = await clienteAnonimo(t).get('/api/docs-json').expect(401);
    expect(anonimo.body.erro).toBe('nao_autenticado');
    const comercial = await entrarComo(
      t,
      await criarUsuario(t, { papel: 'COMERCIAL' }),
    );
    await comercial.get('/api/docs-json').expect(403);
    await comercial.get('/api/docs').expect(403);
    const admin = await entrarComo(
      t,
      await criarUsuario(t, { papel: 'ADMIN' }),
    );
    const documento = await admin.get('/api/docs-json').expect(200);
    expect(Object.keys(documento.body.paths as object)).toEqual(
      expect.arrayContaining([
        '/api/saude',
        '/api/v1/auth/entrar',
        '/api/v1/auth/eu',
        '/api/v1/notificacoes',
        '/api/v1/notificacoes/{id}/marcar-lida',
      ]),
    );
    await admin.get('/api/docs/').expect(200);
  });
});

async function esperarAte(
  condicao: () => Promise<boolean>,
  prazoMs = 5_000,
): Promise<void> {
  const limite = Date.now() + prazoMs;
  while (!(await condicao())) {
    if (Date.now() > limite) {
      throw new Error('Condição não atingida a tempo.');
    }
    await new Promise((resolver) => setTimeout(resolver, 50));
  }
}

describe('Base — filas e eventos em segundo plano, como em produção (e2e)', () => {
  let t: AppTeste;
  const recebidos: EventoPublicado[] = [];
  const trabalhosRecebidos: Trabalho<Record<string, unknown>>[] = [];

  beforeAll(async () => {
    t = await criarAppTeste({
      variaveis: { PROCESSAR_FILAS: 'true' },
      importar: [RotasDeTesteModule],
    });
    t.eventos.registrarManipulador(
      'teste.criado',
      async (evento) => {
        recebidos.push(evento);
      },
      'teste:segundo-plano',
    );
    await t.fila.trabalhar<Record<string, unknown>>(
      FILA_DE_TESTE,
      async (trabalho) => {
        trabalhosRecebidos.push(trabalho);
      },
      { intervaloDeConsultaSegundos: 0.5 },
    );
    await t.fila.agendar(FILA_DE_TESTE, '0 3 * * *', { tarefa: 'diaria' });
  });

  afterAll(async () => {
    const inicio = Date.now();
    await t.fechar();
    // O desligamento espera os trabalhadores, mas não trava.
    expect(Date.now() - inicio).toBeLessThan(15_000);
  });

  it('R10.1 — o despachante leva o evento à fila e o trabalhador entrega sem ninguém drenar', async () => {
    const resposta = await clienteAnonimo(t)
      .post('/api/v1/teste-base/publicar', { origem: 'segundo-plano' })
      .expect(201);
    await esperarAte(
      async () => recebidos.some(({ id }) => id === resposta.body.id),
      15_000,
    );
    // O trabalhador marca o evento como processado logo depois de o último
    // manipulador terminar: espera essa gravação em vez de ler na hora.
    await esperarAte(async () => {
      const registro = await t.prisma.eventoDominio.findUniqueOrThrow({
        where: { id: resposta.body.id as string },
      });
      return registro.processadoEm !== null;
    }, 15_000);
  });

  it('o trabalhador da fila consome os jobs sozinho', async () => {
    await clienteAnonimo(t)
      .post('/api/v1/teste-base/enfileirar', { origem: 'segundo-plano' })
      .expect(201);
    await esperarAte(async () => trabalhosRecebidos.length > 0, 15_000);
    expect(trabalhosRecebidos[0].dados).toEqual({ origem: 'segundo-plano' });
  });

  it('agendar registra o cron no pg-boss, no fuso de São Paulo', async () => {
    const [agendamento] = await t.prisma.$queryRaw<
      { cron: string; timezone: string }[]
    >`
      SELECT cron, timezone FROM pgboss.schedule WHERE name = ${FILA_DE_TESTE}`;
    expect(agendamento).toEqual({
      cron: '0 3 * * *',
      timezone: 'America/Sao_Paulo',
    });
  });
});
