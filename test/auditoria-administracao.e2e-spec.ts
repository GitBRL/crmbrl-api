import { randomUUID } from 'node:crypto';
import { codificarCursor } from '../src/auditoria/consulta/consulta-comum';
import {
  ACAO_DA_RETENCAO,
  DIAS_DE_RETENCAO,
  FILA_RETENCAO,
  RetencaoService,
} from '../src/administracao/retencao.service';
import type {
  LogTecnico,
  NivelLog,
  Prisma,
  StatusRecebimento,
  Usuario,
  WebhookEntrada,
} from '../src/generated/prisma/client';
import { RotasDeTesteModule } from './base-rotas-de-teste';
import {
  type AppTeste,
  clienteAnonimo,
  type ClienteHttp,
  criarAppTeste,
  criarEquipe,
  criarUsuario,
  drenarFilas,
  entrarComo,
  funilBase,
} from './utils';

const DIA_MS = 86_400_000;
const HORA_MS = 3_600_000;

interface Contagem {
  quantidade: number;
}

/** Do mais frequente para o menos; empate em ordem alfabética. */
function esperarOrdenadoPorQuantidade<T extends Contagem>(
  itens: readonly T[],
  nome: (item: T) => string,
): void {
  for (let indice = 1; indice < itens.length; indice++) {
    const anterior = itens[indice - 1];
    const atual = itens[indice];
    expect(
      anterior.quantidade > atual.quantidade ||
        (anterior.quantidade === atual.quantidade &&
          nome(anterior).localeCompare(nome(atual)) < 0),
    ).toBe(true);
  }
}

interface DadosDeLog {
  nivel?: NivelLog;
  contexto?: string;
  mensagem?: string;
  criadoEm?: Date;
  requisicaoId?: string | null;
  usuario?: Usuario | null;
  metodo?: string;
  rota?: string;
  status?: number;
  duracaoMs?: number;
  dados?: Prisma.InputJsonObject;
}

function registrarLog(
  t: AppTeste,
  dados: DadosDeLog = {},
): Promise<LogTecnico> {
  return t.prisma.logTecnico.create({
    data: {
      nivel: dados.nivel ?? 'ERRO',
      contexto: dados.contexto ?? 'HTTP',
      mensagem: dados.mensagem ?? 'Falha de teste',
      criadoEm: dados.criadoEm,
      requisicaoId: dados.requisicaoId ?? null,
      usuarioId: dados.usuario?.id ?? null,
      metodo: dados.metodo,
      rota: dados.rota,
      status: dados.status,
      duracaoMs: dados.duracaoMs,
      dados: dados.dados,
    },
  });
}

async function criarWebhookDeEntrada(t: AppTeste): Promise<WebhookEntrada> {
  const marketing = await funilBase(t, 'MARKETING');
  return t.prisma.webhookEntrada.create({
    data: {
      nome: 'Landing page',
      tokenHash: randomUUID(),
      tokenPrefixo: 'abcd1234',
      funilId: marketing.id,
      etapaId: marketing.etapas[0].id,
    },
  });
}

function registrarRecebimento(
  t: AppTeste,
  webhook: WebhookEntrada,
  recebidoEm: Date,
  status: StatusRecebimento = 'PROCESSADO',
) {
  return t.prisma.webhookRecebimento.create({
    data: {
      webhookId: webhook.id,
      recebidoEm,
      status,
      corpo: { name: 'Maria', email: 'maria@teste.local' },
    },
  });
}

function haDias(dias: number): Date {
  return new Date(Date.now() - dias * DIA_MS);
}

interface ItemDeLog {
  id: string;
  nivel: NivelLog;
  contexto: string;
  mensagem: string;
}

async function listarLogs(
  cliente: ClienteHttp,
  consulta = '',
): Promise<{ itens: ItemDeLog[]; proximoCursor: string | null }> {
  const resposta = await cliente
    .get(`/api/v1/administracao/logs-tecnicos${consulta ? `?${consulta}` : ''}`)
    .expect(200);
  return resposta.body as { itens: ItemDeLog[]; proximoCursor: string | null };
}

const mensagensDe = (pagina: { itens: ItemDeLog[] }) =>
  pagina.itens.map(({ mensagem }) => mensagem);

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

describe('Administração — logs técnicos, retenção e resumo (e2e)', () => {
  let t: AppTeste;
  /** Eventos de auditoria que a configuração inicial gravou agora, no `limparBanco`. */
  let iniciais: number;

  beforeAll(async () => {
    t = await criarAppTeste({ importar: [RotasDeTesteModule] });
  });

  beforeEach(async () => {
    await t.limparBanco();
    iniciais = await t.prisma.eventoAuditoria.count();
  });

  afterAll(async () => {
    await t.fechar();
  });

  async function adminLogado(): Promise<ClienteHttp> {
    return entrarComo(t, await criarUsuario(t, { papel: 'ADMIN' }));
  }

  describe('acesso', () => {
    it('R3.6 — logs técnicos e resumo só para o Admin: C-level, líder e membro recebem 403; sem sessão, 401', async () => {
      const equipe = await criarEquipe(t, 'CS', { membros: 1 });
      const negados = [
        await entrarComo(t, equipe.cLevel),
        await entrarComo(t, equipe.lider),
        await entrarComo(t, equipe.membros[0]),
      ];
      const log = await registrarLog(t);
      const rotas = [
        '/api/v1/administracao/resumo',
        '/api/v1/administracao/logs-tecnicos',
        `/api/v1/administracao/logs-tecnicos/${log.id.toString()}`,
      ];
      const admin = await adminLogado();
      for (const rota of rotas) {
        await clienteAnonimo(t).get(rota).expect(401);
        for (const cliente of negados) {
          const resposta = await cliente.get(rota).expect(403);
          expect(resposta.body.erro).toBe('sem_permissao');
        }
        await admin.get(rota).expect(200);
      }
    });
  });

  describe('logs técnicos', () => {
    async function cenario() {
      const ana = await criarUsuario(t, { papel: 'COMERCIAL', nome: 'Ana' });
      const dia = (d: string) => new Date(`2026-01-${d}T10:00:00.000Z`);
      await registrarLog(t, {
        nivel: 'ERRO',
        contexto: 'HTTP',
        mensagem: 'Falha ao gravar o negócio',
        metodo: 'POST',
        rota: '/api/v1/negocios/:id/mover',
        status: 500,
        duracaoMs: 35,
        requisicaoId: 'req-a',
        usuario: ana,
        criadoEm: dia('10'),
      });
      await registrarLog(t, {
        nivel: 'AVISO',
        contexto: 'Fila:webhooks-saida.entregar',
        mensagem: 'Destino desativado após 20 falhas',
        criadoEm: dia('11'),
      });
      await registrarLog(t, {
        nivel: 'ERRO',
        contexto: 'Fila:atividades.lembretes',
        mensagem: 'Falha no job 123: conexão recusada',
        requisicaoId: 'req-b',
        criadoEm: dia('12'),
      });
      await registrarLog(t, {
        nivel: 'INFO',
        contexto: 'Eventos',
        mensagem: 'Manipulador concluído',
        criadoEm: dia('13'),
      });
      await registrarLog(t, {
        nivel: 'DEBUG',
        contexto: 'Email',
        mensagem: 'Envio simulado de e-mail',
        criadoEm: dia('14'),
      });
      return { ana };
    }

    it('R3.6 — lista do mais novo para o mais antigo e filtra por nível, período, origem, usuário, requisição e texto', async () => {
      const admin = await adminLogado();
      const { ana } = await cenario();

      const todos = await listarLogs(admin);
      expect(mensagensDe(todos)).toEqual([
        'Envio simulado de e-mail',
        'Manipulador concluído',
        'Falha no job 123: conexão recusada',
        'Destino desativado após 20 falhas',
        'Falha ao gravar o negócio',
      ]);
      expect(todos.proximoCursor).toBeNull();
      expect(todos.itens[4]).toEqual({
        id: expect.any(String),
        criadoEm: '2026-01-10T10:00:00.000Z',
        nivel: 'ERRO',
        contexto: 'HTTP',
        mensagem: 'Falha ao gravar o negócio',
        requisicaoId: 'req-a',
        usuarioId: ana.id,
        metodo: 'POST',
        rota: '/api/v1/negocios/:id/mover',
        status: 500,
        duracaoMs: 35,
      });
      // A listagem não traz `dados` (a pilha fica no detalhe).
      expect(todos.itens[4]).not.toHaveProperty('dados');

      expect(mensagensDe(await listarLogs(admin, 'nivel=ERRO'))).toEqual([
        'Falha no job 123: conexão recusada',
        'Falha ao gravar o negócio',
      ]);
      expect(
        (await listarLogs(admin, 'nivel=ERRO,AVISO')).itens.map(
          ({ nivel }) => nivel,
        ),
      ).toEqual(['ERRO', 'AVISO', 'ERRO']);
      expect(
        mensagensDe(await listarLogs(admin, 'nivel=INFO&nivel=DEBUG')),
      ).toEqual(['Envio simulado de e-mail', 'Manipulador concluído']);
      expect(
        mensagensDe(
          await listarLogs(
            admin,
            'de=2026-01-11T10:00:00Z&ate=2026-01-12T10:00:00Z',
          ),
        ),
      ).toEqual(['Destino desativado após 20 falhas']);
      expect(
        (await listarLogs(admin, 'contexto=Fila')).itens.map(
          ({ contexto }) => contexto,
        ),
      ).toEqual(['Fila:atividades.lembretes', 'Fila:webhooks-saida.entregar']);
      expect(
        mensagensDe(await listarLogs(admin, 'contexto=fila:atividades')),
      ).toEqual(['Falha no job 123: conexão recusada']);
      expect(mensagensDe(await listarLogs(admin, 'contexto=HTTP'))).toEqual([
        'Falha ao gravar o negócio',
      ]);
      expect(mensagensDe(await listarLogs(admin, 'contexto=%25'))).toEqual([]);
      expect(
        mensagensDe(await listarLogs(admin, 'requisicaoId=req-b')),
      ).toEqual(['Falha no job 123: conexão recusada']);
      expect(
        mensagensDe(await listarLogs(admin, `usuarioId=${ana.id}`)),
      ).toEqual(['Falha ao gravar o negócio']);
      // Texto: mensagem (sem acentos), rota e origem.
      expect(mensagensDe(await listarLogs(admin, 'texto=NEGOCIO'))).toEqual([
        'Falha ao gravar o negócio',
      ]);
      expect(
        mensagensDe(await listarLogs(admin, 'texto=conexao%20recusada')),
      ).toEqual(['Falha no job 123: conexão recusada']);
      expect(mensagensDe(await listarLogs(admin, 'texto=mover'))).toEqual([
        'Falha ao gravar o negócio',
      ]);
      expect(
        mensagensDe(await listarLogs(admin, 'texto=webhooks-saida')),
      ).toEqual(['Destino desativado após 20 falhas']);
    });

    it('R3.6 — filtros combinados e cursor estável', async () => {
      const admin = await adminLogado();
      await cenario();
      expect(
        mensagensDe(
          await listarLogs(
            admin,
            'nivel=ERRO&contexto=Fila&texto=conexao&de=2026-01-12&ate=2026-01-13&requisicaoId=req-b',
          ),
        ),
      ).toEqual(['Falha no job 123: conexão recusada']);
      expect(
        (await listarLogs(admin, 'nivel=AVISO&contexto=HTTP')).itens,
      ).toEqual([]);

      for (let indice = 1; indice <= 2; indice++) {
        await registrarLog(t, { mensagem: `Extra ${indice}` });
      }
      // 7 logs, de 3 em 3.
      const primeira = await listarLogs(admin, 'limite=3');
      expect(primeira.itens).toHaveLength(3);
      const segundaAntes = await listarLogs(
        admin,
        `limite=3&cursor=${primeira.proximoCursor}`,
      );
      await registrarLog(t, { mensagem: 'Chegou durante a navegação' });
      const segunda = await listarLogs(
        admin,
        `limite=3&cursor=${primeira.proximoCursor}`,
      );
      expect(segunda).toEqual(segundaAntes);
      const terceira = await listarLogs(
        admin,
        `limite=3&cursor=${segunda.proximoCursor}`,
      );
      expect(terceira.itens).toHaveLength(1);
      expect(terceira.proximoCursor).toBeNull();
      const vistos = [primeira, segunda, terceira].flatMap(({ itens }) =>
        itens.map(({ id }) => id),
      );
      expect(new Set(vistos).size).toBe(7);
      expect(mensagensDe(await listarLogs(admin, 'limite=1'))).toEqual([
        'Chegou durante a navegação',
      ]);
    });

    it('R3.6 — entradas inválidas → 400 com o campo', async () => {
      const admin = await adminLogado();
      const campos = async (consulta: string) => {
        const resposta = await admin
          .get(`/api/v1/administracao/logs-tecnicos?${consulta}`)
          .expect(400);
        return (resposta.body.detalhes.campos as { campo: string }[]).map(
          ({ campo }) => campo,
        );
      };
      expect(await campos('nivel=FATAL')).toEqual(['nivel']);
      expect(
        await campos(`cursor=${codificarCursor('auditoria', 3n)}`),
      ).toEqual(['cursor']);
      expect(await campos('de=2026-01-02&ate=2026-01-01')).toEqual(['ate']);
      expect(await campos('acao=usuario.login')).toEqual(['acao']);
    });

    it('R3.6 — detalhe com os dados do erro; inexistente → 404; id inválido → 400', async () => {
      const admin = await adminLogado();
      const log = await registrarLog(t, {
        mensagem: 'Falha no job',
        contexto: 'Fila:webhooks-saida.entregar',
        dados: {
          jobId: 'j-1',
          erro: { nome: 'Error', mensagem: 'ECONNREFUSED', pilha: 'Error: …' },
        },
      });
      const resposta = await admin
        .get(`/api/v1/administracao/logs-tecnicos/${log.id.toString()}`)
        .expect(200);
      expect(resposta.body).toMatchObject({
        id: log.id.toString(),
        nivel: 'ERRO',
        contexto: 'Fila:webhooks-saida.entregar',
        mensagem: 'Falha no job',
        dados: {
          jobId: 'j-1',
          erro: { nome: 'Error', mensagem: 'ECONNREFUSED', pilha: 'Error: …' },
        },
      });
      const semDados = await registrarLog(t, { mensagem: 'Sem dados' });
      expect(
        (
          await admin
            .get(
              `/api/v1/administracao/logs-tecnicos/${semDados.id.toString()}`,
            )
            .expect(200)
        ).body.dados,
      ).toBeNull();
      const inexistente = await admin
        .get('/api/v1/administracao/logs-tecnicos/987654')
        .expect(404);
      expect(inexistente.body.mensagem).toBe('Log técnico não encontrado.');
      await admin.get('/api/v1/administracao/logs-tecnicos/abc').expect(400);
    });

    it('R3.6/R3.7 — um erro 500 de verdade aparece na consulta pelo id da requisição', async () => {
      const admin = await adminLogado();
      await clienteAnonimo(t)
        .get('/api/v1/teste-base/erro/interno')
        .set('X-Request-Id', 'req-500-consulta')
        .expect(500);
      await esperarAte(
        async () =>
          (await t.prisma.logTecnico.count({
            where: { requisicaoId: 'req-500-consulta' },
          })) > 0,
      );
      const pagina = await listarLogs(admin, 'requisicaoId=req-500-consulta');
      expect(pagina.itens).toHaveLength(1);
      expect(pagina.itens[0]).toMatchObject({
        nivel: 'ERRO',
        contexto: 'HTTP',
        mensagem: 'falha interna com detalhe secreto',
        metodo: 'GET',
        rota: '/api/v1/teste-base/erro/:tipo',
        status: 500,
      });
      const detalhe = await admin
        .get(`/api/v1/administracao/logs-tecnicos/${pagina.itens[0].id}`)
        .expect(200);
      expect(detalhe.body.dados.erro).toMatchObject({
        nome: 'Error',
        mensagem: 'falha interna com detalhe secreto',
      });
      expect(detalhe.body.dados.erro.pilha).toContain('Error');
    });
  });

  describe('retenção (job diário)', () => {
    it('R3.6/R8.6 — apaga logs técnicos e recebimentos de webhook com mais de 90 dias, pela fila, e audita como SISTEMA', async () => {
      const webhook = await criarWebhookDeEntrada(t);
      for (const dias of [91, 120, 400]) {
        await registrarLog(t, {
          mensagem: `Antigo ${dias}`,
          criadoEm: haDias(dias),
        });
      }
      for (const dias of [89, 0]) {
        await registrarLog(t, {
          mensagem: `Recente ${dias}`,
          criadoEm: haDias(dias),
        });
      }
      await registrarRecebimento(t, webhook, haDias(91));
      await registrarRecebimento(t, webhook, haDias(200), 'ERRO');
      const recente = await registrarRecebimento(t, webhook, haDias(10));
      // A auditoria nunca é apagada (R3.3), por mais antiga que seja.
      await t.prisma.eventoAuditoria.create({
        data: {
          tipoAtor: 'SISTEMA',
          acao: 'teste.antigo',
          entidade: 'teste',
          resumo: 'Evento antigo',
          criadoEm: haDias(400),
        },
      });

      await t.fila.enviar(FILA_RETENCAO, {});
      expect(await drenarFilas(t, FILA_RETENCAO)).toBe(1);

      const logs = await t.prisma.logTecnico.findMany({
        orderBy: { id: 'asc' },
      });
      expect(logs.map(({ mensagem }) => mensagem)).toEqual([
        'Recente 89',
        'Recente 0',
      ]);
      const recebimentos = await t.prisma.webhookRecebimento.findMany();
      expect(recebimentos.map(({ id }) => id)).toEqual([recente.id]);
      expect(
        await t.prisma.eventoAuditoria.count({
          where: { acao: 'teste.antigo' },
        }),
      ).toBe(1);

      const auditoria = await t.prisma.eventoAuditoria.findMany({
        where: { acao: ACAO_DA_RETENCAO },
      });
      expect(auditoria).toHaveLength(1);
      expect(auditoria[0]).toMatchObject({
        tipoAtor: 'SISTEMA',
        usuarioId: null,
        atorDescricao: 'Retenção de dados',
        entidade: 'retencao',
        dados: {
          dias: DIAS_DE_RETENCAO,
          logsTecnicosApagados: 3,
          recebimentosWebhookApagados: 2,
        },
      });
      expect(auditoria[0].resumo).toMatch(
        /^Retenção de 90 dias: 3 logs técnicos e 2 recebimentos de webhook apagados \(anteriores a \d{2}\/\d{2}\/\d{4}\)$/,
      );
      const limite = new Date(
        (auditoria[0].dados as { limite: string }).limite,
      );
      expect(Math.abs(limite.getTime() - haDias(90).getTime())).toBeLessThan(
        60_000,
      );

      // De novo: nada vencido, nada apagado, nenhum evento novo.
      const segunda = await t.get(RetencaoService).executar();
      expect(segunda).toMatchObject({
        logsTecnicosApagados: 0,
        recebimentosWebhookApagados: 0,
      });
      expect(
        await t.prisma.eventoAuditoria.count({
          where: { acao: ACAO_DA_RETENCAO },
        }),
      ).toBe(1);
    });

    it('R3.6 — apaga em lotes (5.000 por tabela em produção), cada lote com o seu evento de auditoria', async () => {
      const webhook = await criarWebhookDeEntrada(t);
      for (let indice = 1; indice <= 5; indice++) {
        await registrarLog(t, {
          mensagem: `Antigo ${indice}`,
          criadoEm: haDias(100),
        });
      }
      for (let indice = 1; indice <= 3; indice++) {
        await registrarRecebimento(t, webhook, haDias(100));
      }
      await registrarLog(t, { mensagem: 'Fica' });

      // Lotes de 2: (2 logs + 2 recebimentos), (2 + 1), (1 + 0).
      const resultado = await t
        .get(RetencaoService)
        .executar({ tamanhoDoLote: 2 });
      expect(resultado).toMatchObject({
        logsTecnicosApagados: 5,
        recebimentosWebhookApagados: 3,
      });
      expect(await t.prisma.logTecnico.count()).toBe(1);
      expect(await t.prisma.webhookRecebimento.count()).toBe(0);
      const lotes = await t.prisma.eventoAuditoria.findMany({
        where: { acao: ACAO_DA_RETENCAO },
        orderBy: { id: 'asc' },
      });
      expect(
        lotes.map(({ dados }) => {
          const contagens = dados as {
            logsTecnicosApagados: number;
            recebimentosWebhookApagados: number;
          };
          return [
            contagens.logsTecnicosApagados,
            contagens.recebimentosWebhookApagados,
          ];
        }),
      ).toEqual([
        [2, 2],
        [2, 1],
        [1, 0],
      ]);
      expect(lotes.map(({ resumo }) => resumo.split(' (')[0])).toEqual([
        'Retenção de 90 dias: 2 logs técnicos e 2 recebimentos de webhook apagados',
        'Retenção de 90 dias: 2 logs técnicos e 1 recebimento de webhook apagados',
        'Retenção de 90 dias: 1 log técnico apagado',
      ]);

      // Múltiplo exato do lote: o último lote não acha nada e não gera evento.
      for (let indice = 1; indice <= 4; indice++) {
        await registrarLog(t, { criadoEm: haDias(100) });
      }
      await t.get(RetencaoService).executar({ tamanhoDoLote: 2 });
      expect(
        await t.prisma.eventoAuditoria.count({
          where: { acao: ACAO_DA_RETENCAO },
        }),
      ).toBe(5);
    });
  });

  describe('resumo', () => {
    it('Resumo — contagens por ação e por ator nas últimas 24h, logs por nível e os erros recentes', async () => {
      const admin = await adminLogado();
      const iniciaisDeSistema = await t.prisma.eventoAuditoria.count({
        where: { tipoAtor: 'SISTEMA' },
      });
      const ana = await criarUsuario(t, { papel: 'COMERCIAL', nome: 'Ana' });
      const evento = (
        acao: string,
        criadoEm?: Date,
        tipoAtor: 'USUARIO' | 'WEBHOOK' = 'USUARIO',
      ) =>
        t.prisma.eventoAuditoria.create({
          data: {
            acao,
            entidade: acao.split('.')[0],
            resumo: acao,
            tipoAtor,
            usuarioId: tipoAtor === 'USUARIO' ? ana.id : null,
            criadoEm,
          },
        });
      for (const acao of [
        'usuario.login',
        'usuario.login',
        'usuario.login',
        'negocio.movido',
        'negocio.movido',
      ]) {
        await evento(acao);
      }
      await evento('contato.criado', undefined, 'WEBHOOK');
      await evento('usuario.logout', new Date(Date.now() - 25 * HORA_MS));

      for (let indice = 1; indice <= 12; indice++) {
        await registrarLog(t, {
          nivel: 'ERRO',
          mensagem: `Erro ${indice}`,
          criadoEm: new Date(Date.now() - (13 - indice) * 60_000),
        });
      }
      for (let indice = 1; indice <= 3; indice++) {
        await registrarLog(t, { nivel: 'AVISO', mensagem: `Aviso ${indice}` });
      }
      await registrarLog(t, {
        nivel: 'ERRO',
        mensagem: 'Erro de ontem',
        criadoEm: new Date(Date.now() - 30 * HORA_MS),
      });

      const resposta = await admin
        .get('/api/v1/administracao/resumo')
        .expect(200);
      const resumo = resposta.body;
      expect(resumo.periodo.horas).toBe(24);
      expect(
        new Date(resumo.periodo.ate).getTime() -
          new Date(resumo.periodo.de).getTime(),
      ).toBe(24 * HORA_MS);
      const { auditoria } = resumo as {
        auditoria: {
          total: number;
          porAcao: (Contagem & { acao: string })[];
          porTipoAtor: (Contagem & { tipoAtor: string })[];
        };
      };
      // Os 6 de agora, mais o que a configuração inicial gravou no limparBanco.
      expect(auditoria.total).toBe(iniciais + 6);
      expect(auditoria.porAcao).toEqual(
        expect.arrayContaining([
          { acao: 'usuario.login', quantidade: 3 },
          { acao: 'negocio.movido', quantidade: 2 },
          { acao: 'contato.criado', quantidade: 1 },
        ]),
      );
      expect(auditoria.porAcao.map(({ acao }) => acao)).not.toContain(
        'usuario.logout',
      );
      expect(
        auditoria.porAcao.reduce(
          (soma, { quantidade }) => soma + quantidade,
          0,
        ),
      ).toBe(auditoria.total);
      esperarOrdenadoPorQuantidade(auditoria.porAcao, ({ acao }) => acao);
      expect(auditoria.porTipoAtor).toEqual(
        expect.arrayContaining([
          { tipoAtor: 'USUARIO', quantidade: 5 },
          { tipoAtor: 'WEBHOOK', quantidade: 1 },
        ]),
      );
      expect(auditoria.porTipoAtor).toHaveLength(iniciaisDeSistema > 0 ? 3 : 2);
      if (iniciaisDeSistema > 0) {
        expect(auditoria.porTipoAtor).toContainEqual({
          tipoAtor: 'SISTEMA',
          quantidade: iniciaisDeSistema,
        });
      }
      esperarOrdenadoPorQuantidade(
        auditoria.porTipoAtor,
        ({ tipoAtor }) => tipoAtor,
      );
      expect(resumo.logsTecnicos.total).toBe(15);
      expect(resumo.logsTecnicos.porNivel).toEqual({
        DEBUG: 0,
        INFO: 0,
        AVISO: 3,
        ERRO: 12,
      });
      expect(
        resumo.logsTecnicos.errosRecentes.map(
          ({ mensagem }: { mensagem: string }) => mensagem,
        ),
      ).toEqual([
        'Erro 12',
        'Erro 11',
        'Erro 10',
        'Erro 9',
        'Erro 8',
        'Erro 7',
        'Erro 6',
        'Erro 5',
        'Erro 4',
        'Erro 3',
      ]);

      // Janela de 48 horas: entram o logout e o erro de ontem.
      const dois = (
        await admin.get('/api/v1/administracao/resumo?horas=48').expect(200)
      ).body;
      expect(dois.auditoria.total).toBe(iniciais + 7);
      expect(dois.auditoria.porAcao).toContainEqual({
        acao: 'usuario.logout',
        quantidade: 1,
      });
      expect(dois.logsTecnicos.porNivel.ERRO).toBe(13);
    });

    it('Resumo — saúde da outbox, dos webhooks e da retenção', async () => {
      const admin = await adminLogado();
      const vazio = (
        await admin.get('/api/v1/administracao/resumo').expect(200)
      ).body;
      expect(vazio.eventosDominio).toEqual({
        pendentes: 0,
        comFalha: 0,
        maisAntigoPendenteEm: null,
      });
      expect(vazio.webhooks).toEqual({
        recebimentos: { RECEBIDO: 0, PROCESSADO: 0, IGNORADO: 0, ERRO: 0 },
        entregasPendentes: 0,
        entregasFalhas: 0,
      });
      expect(vazio.retencao).toMatchObject({
        dias: 90,
        logsTecnicosVencidos: 0,
        recebimentosWebhookVencidos: 0,
        ultimaLimpezaEm: null,
      });
      expect(
        Math.abs(
          new Date(vazio.retencao.limite).getTime() - haDias(90).getTime(),
        ),
      ).toBeLessThan(60_000);

      const maisAntigo = await t.prisma.eventoDominio.create({
        data: {
          tipo: 'negocio.ganho',
          dados: {},
          criadoEm: new Date(Date.now() - 10 * 60_000),
          erro: 'Manipulador webhooks-saida falhou',
          tentativas: 2,
        },
      });
      await t.prisma.eventoDominio.create({
        data: { tipo: 'contato.criado', dados: {} },
      });
      await t.prisma.eventoDominio.create({
        data: { tipo: 'contato.criado', dados: {}, processadoEm: new Date() },
      });

      const webhook = await criarWebhookDeEntrada(t);
      await registrarRecebimento(t, webhook, new Date(), 'PROCESSADO');
      await registrarRecebimento(t, webhook, new Date(), 'PROCESSADO');
      await registrarRecebimento(t, webhook, new Date(), 'ERRO');
      await registrarRecebimento(
        t,
        webhook,
        new Date(Date.now() - 30 * HORA_MS),
        'IGNORADO',
      );
      await registrarRecebimento(t, webhook, haDias(95), 'PROCESSADO');
      const saida = await t.prisma.webhookSaida.create({
        data: {
          nome: 'TicketHub',
          url: 'https://tickethub.teste.local/webhook',
          eventos: ['negocio.ganho'],
          segredoCifrado: 'v1.teste.teste.teste',
        },
      });
      for (const status of [
        'PENDENTE',
        'PENDENTE',
        'FALHOU',
        'ENTREGUE',
      ] as const) {
        await t.prisma.webhookEntrega.create({
          data: {
            webhookId: saida.id,
            eventoId: randomUUID(),
            tipoEvento: 'negocio.ganho',
            payload: {},
            status,
          },
        });
      }
      await registrarLog(t, { mensagem: 'Vencido', criadoEm: haDias(91) });

      const resumo = (
        await admin.get('/api/v1/administracao/resumo').expect(200)
      ).body;
      expect(resumo.eventosDominio).toEqual({
        pendentes: 2,
        comFalha: 1,
        maisAntigoPendenteEm: maisAntigo.criadoEm.toISOString(),
      });
      expect(resumo.webhooks).toEqual({
        recebimentos: { RECEBIDO: 0, PROCESSADO: 2, IGNORADO: 0, ERRO: 1 },
        entregasPendentes: 2,
        entregasFalhas: 1,
      });
      expect(resumo.retencao).toMatchObject({
        logsTecnicosVencidos: 1,
        recebimentosWebhookVencidos: 1,
        ultimaLimpezaEm: null,
      });

      // Depois do job, nada vencido e a última limpeza registrada.
      await t.get(RetencaoService).executar();
      const depois = (
        await admin.get('/api/v1/administracao/resumo').expect(200)
      ).body;
      const limpeza = await t.prisma.eventoAuditoria.findFirstOrThrow({
        where: { acao: ACAO_DA_RETENCAO },
      });
      expect(depois.retencao).toMatchObject({
        logsTecnicosVencidos: 0,
        recebimentosWebhookVencidos: 0,
        ultimaLimpezaEm: limpeza.criadoEm.toISOString(),
      });
      expect(depois.auditoria.porAcao).toContainEqual({
        acao: ACAO_DA_RETENCAO,
        quantidade: 1,
      });
    });

    it('Resumo — janela de 1 a 168 horas', async () => {
      const admin = await adminLogado();
      for (const horas of ['0', '169', 'abc', '1.5']) {
        const resposta = await admin
          .get(`/api/v1/administracao/resumo?horas=${horas}`)
          .expect(400);
        expect(resposta.body.detalhes.campos[0].campo).toBe('horas');
      }
      const umaHora = (
        await admin.get('/api/v1/administracao/resumo?horas=1').expect(200)
      ).body;
      expect(umaHora.periodo.horas).toBe(1);
    });
  });

  it('documentação: as rotas da administração estão no Swagger', async () => {
    const documento = await clienteAnonimo(t).get('/api/docs-json').expect(200);
    const caminhos = documento.body.paths as Record<
      string,
      Record<string, { tags?: string[] }>
    >;
    expect(Object.keys(caminhos)).toEqual(
      expect.arrayContaining([
        '/api/v1/administracao/resumo',
        '/api/v1/administracao/logs-tecnicos',
        '/api/v1/administracao/logs-tecnicos/{id}',
      ]),
    );
    expect(caminhos['/api/v1/administracao/resumo'].get.tags).toEqual([
      'Administração',
    ]);
  });
});

describe('Administração — retenção agendada, com as filas ligadas (e2e)', () => {
  let t: AppTeste;

  beforeAll(async () => {
    t = await criarAppTeste({ variaveis: { PROCESSAR_FILAS: 'true' } });
  });

  afterAll(async () => {
    await t.fechar();
  });

  it('R3.6/R8.6 — o job de retenção roda todo dia às 3h30, no fuso de São Paulo', async () => {
    const agendamentos = await t.prisma.$queryRaw<
      { cron: string; timezone: string }[]
    >`SELECT cron, timezone FROM pgboss.schedule WHERE name = ${FILA_RETENCAO}`;
    expect(agendamentos).toEqual([
      { cron: '30 3 * * *', timezone: 'America/Sao_Paulo' },
    ]);
  });
});
