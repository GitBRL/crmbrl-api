import { LembretesAtividadesService } from '../src/atividades/lembretes-atividades.service';
import { NotificacoesService } from '../src/notificacoes/notificacoes.service';
import { TIPOS_NOTIFICACAO } from '../src/notificacoes/tipos-notificacao';
import { FILA_PUSH } from '../src/push/push.constantes';
import { SERVICO_DE_PUSH } from '../src/push/servico-de-push';
import {
  inscricaoDeTeste,
  ServicoDePushFalso,
  variaveisDePush,
} from './push-apoio';
import {
  type AppTeste,
  type ClienteHttp,
  clienteAnonimo,
  criarAppTeste,
  criarAtividade,
  criarUsuario,
  drenarFilas,
  entrarComo,
} from './utils';

const API = '/api/v1/push';

/** JSON com BigInt (a auditoria tem `sequencia`). */
const texto = (valor: unknown) =>
  JSON.stringify(valor, (_chave, v: unknown) =>
    typeof v === 'bigint' ? v.toString() : v,
  );

describe('Notificações push (e2e)', () => {
  let t: AppTeste;
  const falso = new ServicoDePushFalso();
  let ana: ClienteHttp;
  let bia: ClienteHttp;

  beforeAll(async () => {
    t = await criarAppTeste({
      variaveis: variaveisDePush(),
      ajustar: (c) => c.overrideProvider(SERVICO_DE_PUSH).useValue(falso),
    });
  });

  beforeEach(async () => {
    await t.limparBanco();
    falso.limpar();
    ana = await entrarComo(t, await criarUsuario(t, { papel: 'COMERCIAL' }));
    bia = await entrarComo(t, await criarUsuario(t, { papel: 'CS' }));
  });

  afterAll(() => t.fechar());

  /** Cria uma notificação interna pelo serviço de verdade, numa transação. */
  const notificar = (
    usuarioId: string,
    tipo: string,
    extra: { link?: string | null; titulo?: string; texto?: string } = {},
  ) =>
    t.prisma.$transaction((tx) =>
      t.get(NotificacoesService).notificar(tx, usuarioId, {
        tipo,
        titulo: extra.titulo ?? 'Título',
        texto: extra.texto ?? 'Texto',
        link:
          extra.link === undefined ? '/funis/comercial?negocio=1' : extra.link,
      }),
    );

  const inscrever = async (cliente: ClienteHttp, aparelho?: string) => {
    const dados = inscricaoDeTeste(aparelho);
    const resposta = await cliente.post(`${API}/inscricoes`, dados).expect(201);
    return { ...dados, id: (resposta.body as { id: string }).id };
  };

  describe('chave pública e inscrição', () => {
    it('R26.1 — exige sessão e devolve a chave pública VAPID', async () => {
      await clienteAnonimo(t).get(`${API}/chave-publica`).expect(401);
      const resposta = await ana.get(`${API}/chave-publica`).expect(200);
      expect(resposta.body).toEqual({
        chavePublica: t.ambiente.push.chavePublica,
      });
      expect(JSON.stringify(resposta.body)).not.toContain(
        t.ambiente.push.chavePrivada() as string,
      );
    });

    it('R26.1 — inscreve o aparelho, idempotente por endpoint, e lista só os meus', async () => {
      const dados = inscricaoDeTeste('Chrome no Android');
      const primeira = await ana.post(`${API}/inscricoes`, dados).expect(201);
      const id = (primeira.body as { id: string }).id;
      const segunda = await ana
        .post(`${API}/inscricoes`, { ...dados, aparelho: 'Pixel 9' })
        .expect(200);
      expect(segunda.body).toEqual({ id });
      await inscrever(bia);

      const lista = await ana.get(`${API}/inscricoes`).expect(200);
      expect(lista.body).toEqual([
        expect.objectContaining({
          id,
          aparelho: 'Pixel 9',
          servico: '127.0.0.1:9',
          ultimoEnvioEm: null,
        }),
      ]);
      // Nem o endereço completo nem as chaves saem da API.
      const saida = JSON.stringify(lista.body);
      expect(saida).not.toContain(dados.endpoint);
      expect(saida).not.toContain(dados.keys.auth);
      expect(saida).not.toContain(dados.keys.p256dh);
    });

    it('R26.1 — as chaves ficam cifradas no banco', async () => {
      const dados = inscricaoDeTeste();
      await ana.post(`${API}/inscricoes`, dados).expect(201);
      const linha = await t.prisma.pushInscricao.findUniqueOrThrow({
        where: { endpoint: dados.endpoint },
      });
      expect(linha.chavesCifradas).not.toContain(dados.keys.auth);
      expect(linha.chavesCifradas).not.toContain(dados.keys.p256dh);
    });

    it('R26.1 — o mesmo aparelho passa para quem entrou por último', async () => {
      const dados = inscricaoDeTeste();
      const { body } = await ana.post(`${API}/inscricoes`, dados).expect(201);
      await bia.post(`${API}/inscricoes`, dados).expect(200);
      expect((await ana.get(`${API}/inscricoes`)).body).toEqual([]);
      expect((await bia.get(`${API}/inscricoes`)).body).toEqual([
        expect.objectContaining({ id: (body as { id: string }).id }),
      ]);
    });

    it('R26.1 — recusa dados inválidos e endereços de rede interna sem a liberação', async () => {
      const dados = inscricaoDeTeste();
      await ana
        .post(`${API}/inscricoes`, {
          ...dados,
          keys: { p256dh: 'x', auth: 'y' },
        })
        .expect(400);
      await ana
        .post(`${API}/inscricoes`, { endpoint: dados.endpoint })
        .expect(400);
      await ana
        .post(`${API}/inscricoes`, { ...dados, extra: true })
        .expect(400);

      const fechado = await criarAppTeste({
        variaveis: {
          ...variaveisDePush(),
          WEBHOOKS_PERMITIR_REDE_INTERNA: 'false',
        },
        limpar: false,
      });
      try {
        const cliente = await entrarComo(
          fechado,
          await fechado.prisma.usuario.findFirstOrThrow({}),
        );
        const resposta = await cliente
          .post(`${API}/inscricoes`, dados)
          .expect(400);
        expect(JSON.stringify(resposta.body)).toContain('rede interna');
      } finally {
        await fechado.fechar();
      }
    });

    it('R26.1 — remove só o meu aparelho (404 para o de outra pessoa)', async () => {
      const dela = await inscrever(bia);
      const meu = await inscrever(ana);
      await ana.delete(`${API}/inscricoes/${dela.id}`).expect(404);
      await ana.delete(`${API}/inscricoes/${meu.id}`).expect(204);
      await ana.delete(`${API}/inscricoes/${meu.id}`).expect(404);
      expect((await ana.get(`${API}/inscricoes`)).body).toEqual([]);
      expect((await bia.get(`${API}/inscricoes`)).body).toHaveLength(1);
    });

    it('R26.1 — guarda no máximo 20 aparelhos por pessoa (o mais antigo sai)', async () => {
      const primeira = await inscrever(ana, 'Primeiro');
      for (let i = 0; i < 20; i++) {
        await inscrever(ana, `Aparelho ${i}`);
      }
      const lista = (await ana.get(`${API}/inscricoes`)).body as {
        id: string;
      }[];
      expect(lista).toHaveLength(20);
      expect(lista.map(({ id }) => id)).not.toContain(primeira.id);
    });

    it('R26.1 — sem VAPID: chave pública e inscrição dão 503 com motivo nao_configurado', async () => {
      const sem = await criarAppTeste({
        variaveis: { WEBHOOKS_PERMITIR_REDE_INTERNA: 'true' },
      });
      try {
        const cliente = await entrarComo(sem, await criarUsuario(sem));
        for (const resposta of [
          await cliente.get(`${API}/chave-publica`).expect(503),
          await cliente
            .post(`${API}/inscricoes`, inscricaoDeTeste())
            .expect(503),
          await cliente.post(`${API}/teste`).expect(503),
        ]) {
          expect(resposta.body).toMatchObject({
            statusCode: 503,
            detalhes: { motivo: 'nao_configurado' },
          });
        }
        // E nenhuma notificação vira job.
        await sem.prisma.$transaction((tx) =>
          sem.get(NotificacoesService).notificar(tx, cliente.usuario!.id, {
            tipo: TIPOS_NOTIFICACAO.NEGOCIO_ATRIBUIDO,
            titulo: 'x',
          }),
        );
        expect(await drenarFilas(sem, FILA_PUSH)).toBe(0);
      } finally {
        await sem.fechar();
      }
    });
  });

  describe('preferências', () => {
    it('R26.2 — tudo ligado por padrão; PUT muda só os tipos enviados', async () => {
      const padrao = await ana.get(`${API}/preferencias`).expect(200);
      expect(padrao.body).toEqual({
        tipos: {
          conversa_atribuida: true,
          mencao: true,
          atividade_vencendo: true,
          sla_estourado: true,
          negocio_atribuido: true,
          parcela_atrasada: true,
        },
      });
      const alterada = await ana
        .put(`${API}/preferencias`, {
          tipos: { mencao: false, sla_estourado: false },
        })
        .expect(200);
      expect(alterada.body.tipos).toMatchObject({
        mencao: false,
        sla_estourado: false,
        conversa_atribuida: true,
      });
      await ana
        .put(`${API}/preferencias`, { tipos: { mencao: true } })
        .expect(200);
      const lidas = (await ana.get(`${API}/preferencias`)).body.tipos;
      expect(lidas).toMatchObject({ mencao: true, sla_estourado: false });
      // Cada pessoa tem as suas.
      expect(
        (await bia.get(`${API}/preferencias`)).body.tipos.sla_estourado,
      ).toBe(true);
    });

    it('R26.2 — recusa tipo desconhecido, valor que não é booleano e corpo vazio', async () => {
      await ana
        .put(`${API}/preferencias`, { tipos: { inventado: true } })
        .expect(400);
      await ana
        .put(`${API}/preferencias`, { tipos: { mencao: 'sim' } })
        .expect(400);
      await ana.put(`${API}/preferencias`, { tipos: {} }).expect(400);
      await ana.put(`${API}/preferencias`, {}).expect(400);
    });

    it('R26.6 — audita a alteração (e só quando algo muda)', async () => {
      await ana
        .put(`${API}/preferencias`, { tipos: { mencao: true } })
        .expect(200);
      await ana
        .put(`${API}/preferencias`, { tipos: { mencao: false } })
        .expect(200);
      const eventos = await t.prisma.eventoAuditoria.findMany({
        where: { acao: 'push.preferencias_alteradas' },
      });
      expect(eventos).toHaveLength(1);
      expect(eventos[0].dados).toMatchObject({
        alteracoes: [{ tipo: 'mencao', de: true, para: false }],
      });
    });
  });

  describe('envio a partir das notificações internas', () => {
    it('R26.3 — cada tipo mapeado vira push com a url do front; os demais não', async () => {
      const aparelho = await inscrever(ana);
      const casos: [string, string | null][] = [
        ['conversa.atribuida', '/atendimento?conversa=1'],
        ['conversa.transferida', '/atendimento?conversa=2'],
        ['chat.mencao', '/chat?canal=1'],
        ['atividade.vencendo', '/atividades?atividade=1'],
        ['atividade.atrasada', '/atividades?atividade=2'],
        ['conversa.sla_primeira_resposta', '/atendimento?conversa=3'],
        ['conversa.sla_resolucao', '/atendimento?conversa=4'],
        ['negocio.atribuido', '/funis/comercial?negocio=1'],
        ['passagem.recebida', '/funis/cs?negocio=2'],
        ['regua.promessa_nao_cumprida', '/financeiro/parcelas?parcela=1'],
        ['regua.ligacao', '/financeiro/regua/ligacoes?envio=1'],
      ];
      for (const [tipo, link] of casos) {
        await notificar(ana.usuario!.id, tipo, { link });
      }
      for (const naoMapeado of [
        'webhook_saida.falhou',
        'contato.atribuido',
        'conversa.mensagem_recebida',
        'automacao.notificacao',
      ]) {
        await notificar(ana.usuario!.id, naoMapeado);
      }
      expect(await drenarFilas(t, FILA_PUSH)).toBe(casos.length);
      expect(falso.enviados).toHaveLength(casos.length);
      expect(falso.enviados.map((e) => e.carga.url).sort()).toEqual(
        casos.map(([, link]) => link as string).sort(),
      );
      expect(
        falso.enviados.every((e) => e.endpoint === aparelho.endpoint),
      ).toBe(true);
      // As chaves chegam decifradas ao serviço de push.
      expect(falso.enviados[0].keys).toEqual(aparelho.keys);
    });

    it('R26.3 — a carga leva titulo, corpo, url, tag e notificacaoId; sem link abre a lista', async () => {
      await inscrever(ana);
      const comLink = await notificar(ana.usuario!.id, 'negocio.atribuido', {
        titulo: 'Novo lead para você',
        texto: 'Marina chegou pelo webhook.',
        link: '/funis/marketing?negocio=abc',
      });
      const semLink = await notificar(ana.usuario!.id, 'atividade.vencendo', {
        link: null,
      });
      const externo = await notificar(ana.usuario!.id, 'atividade.atrasada', {
        link: 'https://malicioso.example/x',
      });
      await drenarFilas(t, FILA_PUSH);
      const porId = new Map(
        falso.enviados.map((e) => [e.carga.notificacaoId, e.carga]),
      );
      expect(porId.get(comLink.id)).toEqual({
        titulo: 'Novo lead para você',
        corpo: 'Marina chegou pelo webhook.',
        url: '/funis/marketing?negocio=abc',
        tag: 'negocio.atribuido:/funis/marketing?negocio=abc',
        notificacaoId: comLink.id,
      });
      expect(porId.get(semLink.id)?.url).toBe('/notificacoes');
      expect(porId.get(externo.id)?.url).toBe('/notificacoes');
    });

    it('R26.3 — envia a todos os aparelhos da pessoa e a ninguém mais', async () => {
      const a1 = await inscrever(ana, 'Celular');
      const a2 = await inscrever(ana, 'Notebook');
      await inscrever(bia);
      await notificar(
        ana.usuario!.id,
        'mencao'.replace('mencao', 'chat.mencao'),
      );
      await drenarFilas(t, FILA_PUSH);
      expect(falso.enviados.map((e) => e.endpoint).sort()).toEqual(
        [a1.endpoint, a2.endpoint].sort(),
      );
    });

    it('R26.3 — respeita as preferências por tipo', async () => {
      await inscrever(ana);
      await ana
        .put(`${API}/preferencias`, { tipos: { atividade_vencendo: false } })
        .expect(200);
      await notificar(ana.usuario!.id, 'atividade.vencendo');
      await notificar(ana.usuario!.id, 'atividade.atrasada');
      await notificar(ana.usuario!.id, 'negocio.atribuido');
      expect(await drenarFilas(t, FILA_PUSH)).toBe(1);
      expect(falso.enviados.map((e) => e.carga.tag.split(':')[0])).toEqual([
        'negocio.atribuido',
      ]);
    });

    it('R26.3 — desligar o tipo depois da notificação e antes do envio também vale', async () => {
      await inscrever(ana);
      await notificar(ana.usuario!.id, 'negocio.atribuido');
      await ana
        .put(`${API}/preferencias`, { tipos: { negocio_atribuido: false } })
        .expect(200);
      await drenarFilas(t, FILA_PUSH);
      expect(falso.enviados).toHaveLength(0);
    });

    it('R26.3 — o job só existe se a transação da regra de negócio confirmar', async () => {
      await inscrever(ana);
      await expect(
        t.prisma.$transaction(async (tx) => {
          await t.get(NotificacoesService).notificar(tx, ana.usuario!.id, {
            tipo: 'negocio.atribuido',
            titulo: 'x',
          });
          throw new Error('desfaz');
        }),
      ).rejects.toThrow('desfaz');
      expect(await drenarFilas(t, FILA_PUSH)).toBe(0);
      expect(falso.enviados).toHaveLength(0);
    });

    it('R26.3 — notificarVarios e o fluxo real (lembrete de atividade) disparam o push', async () => {
      await inscrever(ana);
      await inscrever(bia);
      await t.prisma.$transaction((tx) =>
        t
          .get(NotificacoesService)
          .notificarVarios(tx, [ana.usuario!.id, bia.usuario!.id], {
            tipo: 'conversa.sla_resolucao',
            titulo: 'SLA estourou',
            link: '/atendimento?conversa=9',
          }),
      );
      await drenarFilas(t, FILA_PUSH);
      expect(falso.enviados).toHaveLength(2);
      falso.limpar();

      await criarAtividade(t, {
        responsavel: ana.usuario!,
        titulo: 'Enviar proposta',
        venceEm: new Date(Date.now() + 40 * 60_000),
      });
      await t.get(LembretesAtividadesService).executar();
      await drenarFilas(t, FILA_PUSH);
      expect(falso.enviados).toHaveLength(1);
      expect(falso.enviados[0].carga).toMatchObject({
        titulo: 'Atividade vencendo',
        url: expect.stringMatching(/^\/atividades\?atividade=/),
      });
    });

    it('R26.4 — 404 e 410 do serviço de push removem a inscrição e auditam; as outras ficam', async () => {
      const morta = await inscrever(ana, 'Morta');
      const gone = await inscrever(ana, 'Gone');
      const viva = await inscrever(ana, 'Viva');
      falso.responder(morta.endpoint, {
        ok: false,
        status: 404,
        mensagem: 'x',
      });
      falso.responder(gone.endpoint, { ok: false, status: 410, mensagem: 'x' });
      await notificar(ana.usuario!.id, 'negocio.atribuido');
      await drenarFilas(t, FILA_PUSH);
      const restantes = (await ana.get(`${API}/inscricoes`)).body as {
        id: string;
        ultimoEnvioEm: string | null;
      }[];
      expect(restantes.map(({ id }) => id)).toEqual([viva.id]);
      expect(restantes[0].ultimoEnvioEm).not.toBeNull();
      const auditoria = await t.prisma.eventoAuditoria.findMany({
        where: { acao: 'push.inscricao_expirada' },
      });
      expect(auditoria).toHaveLength(2);
      expect(texto(auditoria)).not.toContain(morta.endpoint);
      expect(texto(auditoria)).not.toContain(morta.keys.auth);
    });

    it('R26.4 — falha passageira (503) é tentada de novo pela fila; a inscrição fica com o erro', async () => {
      const aparelho = await inscrever(ana);
      falso.responder(
        aparelho.endpoint,
        {
          ok: false,
          status: 503,
          mensagem: 'O serviço de push respondeu 503.',
        },
        { ok: true },
      );
      await notificar(ana.usuario!.id, 'negocio.atribuido');
      await drenarFilas(t, FILA_PUSH);
      expect(falso.enviados).toHaveLength(0);
      const falhou = (await ana.get(`${API}/inscricoes`)).body[0];
      expect(falhou.ultimoErro).toContain('503');
      await drenarFilas(t, FILA_PUSH, { incluirAgendados: true });
      expect(falso.enviados).toHaveLength(1);
      const ok = (await ana.get(`${API}/inscricoes`)).body[0];
      expect(ok.ultimoErro).toBeNull();
      expect(ok.ultimoEnvioEm).not.toBeNull();
    });

    it('R26.4 — recusa definitiva (401) não é repetida e não remove a inscrição', async () => {
      const aparelho = await inscrever(ana);
      falso.responder(aparelho.endpoint, {
        ok: false,
        status: 401,
        mensagem: 'O serviço de push respondeu 401.',
      });
      await notificar(ana.usuario!.id, 'negocio.atribuido');
      await drenarFilas(t, FILA_PUSH);
      await drenarFilas(t, FILA_PUSH, { incluirAgendados: true });
      expect(falso.tentativas).toBe(1);
      expect((await ana.get(`${API}/inscricoes`)).body).toHaveLength(1);
    });
  });

  describe('teste e auditoria', () => {
    it('R26.5 — o push de teste vai para os meus aparelhos e conta o resultado', async () => {
      await inscrever(bia);
      await ana.post(`${API}/teste`).expect(422);
      const a1 = await inscrever(ana);
      const a2 = await inscrever(ana);
      falso.responder(a2.endpoint, { ok: false, status: 410, mensagem: 'x' });
      const resposta = await ana.post(`${API}/teste`).expect(200);
      expect(resposta.body).toEqual({ enviados: 1, falhas: 0, removidas: 1 });
      expect(falso.enviados).toHaveLength(1);
      expect(falso.enviados[0]).toMatchObject({
        endpoint: a1.endpoint,
        carga: { notificacaoId: null, url: '/notificacoes', tag: 'teste' },
      });
    });

    it('R26.6 — audita inscrição, remoção e teste sem endereço nem chaves', async () => {
      const aparelho = await inscrever(ana, 'Chrome no Android');
      await ana.post(`${API}/teste`).expect(200);
      await ana.delete(`${API}/inscricoes/${aparelho.id}`).expect(204);
      const eventos = await t.prisma.eventoAuditoria.findMany({
        where: { acao: { startsWith: 'push.' } },
        orderBy: { criadoEm: 'asc' },
      });
      expect(eventos.map((e) => e.acao)).toEqual([
        'push.inscricao_criada',
        'push.teste_enviado',
        'push.inscricao_removida',
      ]);
      const saida = texto(eventos);
      expect(saida).not.toContain(aparelho.endpoint);
      expect(saida).not.toContain(aparelho.keys.auth);
      expect(saida).not.toContain(aparelho.keys.p256dh);
      expect(eventos[0].dados).toMatchObject({
        aparelho: 'Chrome no Android',
        servico: '127.0.0.1:9',
      });
    });
  });
});
