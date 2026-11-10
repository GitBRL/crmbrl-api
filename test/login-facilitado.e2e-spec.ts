/**
 * Login facilitado (H4): apps de login (R32.22), login em outra janela (R32.23), Facebook com o app das
 * Configurações (R32.24), Typeform por login (R32.25) e RD Station por login (R32.26). A Graph, o
 * Typeform e o RD Station são servidores falsos em processo (`test/utils/servicos-de-login.ts`).
 */
import request from 'supertest';
import { CriptografiaService } from '../src/comum/criptografia/criptografia.service';
import type { Usuario } from '../src/generated/prisma/client';
import { AplicativosService } from '../src/webhooks/entrada/aplicativos.service';
import { assinarState } from '../src/webhooks/login/estado-do-login';
import {
  APP_META,
  APP_META_2,
  APP_RD,
  APP_TYPEFORM,
  type AppTeste,
  type ClienteHttp,
  clienteAnonimo,
  criarAppTeste,
  criarUsuario,
  drenarFilas,
  entrarComo,
  funilBase,
  GraphFalsa,
  PAPEIS_ANTIGOS,
  RdStationFalso,
  TypeformFalso,
} from './utils';
import { enviarLead, FILA_PROCESSAR, tokenDaUrl } from './webhooks-apoio';

const API = '/api/v1';
const APPS = `${API}/configuracoes/apps-de-login`;
const CONEXOES = `${API}/conexoes-aplicativo`;
const RETORNO_CONEXOES = `${API}/publico/conexoes/oauth/retorno`;
const RETORNO_FACEBOOK = `${API}/publico/facebook/oauth/retorno`;
const ORIGEM = 'http://localhost:4200';

interface AppDto {
  aplicativo: string;
  configurado: boolean;
  clientId: string | null;
  segredoMascarado: string | null;
  enderecoDeRetorno: string;
  emUso: { conexoes: number; canais: number; integracoes: number };
  escopos: string[];
  webhook: { url: string; tokenVerificacao: string; campos: string[] } | null;
  atualizadoEm: string | null;
  atualizadoPor: { id: string; nome: string } | null;
}

describe('Login facilitado (e2e, R32.22 a R32.26)', () => {
  let t: AppTeste;
  let adminUsuario: Usuario;
  let admin: ClienteHttp;
  const graph = new GraphFalsa();
  const typeform = new TypeformFalso();
  const rd = new RdStationFalso();

  beforeAll(async () => {
    await Promise.all([graph.iniciar(), typeform.iniciar(), rd.iniciar()]);
    t = await criarAppTeste({
      variaveis: {
        META_GRAPH_URL: graph.url,
        META_DIALOGO_URL: 'http://dialogo.meta.teste',
        TYPEFORM_API_URL: typeform.url,
        TYPEFORM_DIALOGO_URL: 'http://dialogo.typeform.teste',
        RD_STATION_API_URL: rd.url,
        RD_STATION_DIALOGO_URL: 'http://dialogo.rd.teste',
      },
    });
  });

  beforeEach(async () => {
    await t.limparBanco();
    graph.limpar();
    typeform.limpar();
    rd.limpar();
    adminUsuario = await criarUsuario(t, { papel: 'ADMIN', nome: 'Admin' });
    admin = await entrarComo(t, adminUsuario);
  });

  afterAll(async () => {
    await t.fechar();
    await Promise.all([graph.parar(), typeform.parar(), rd.parar()]);
  });

  // -------------------------------------------------------------------------
  // Apoio
  // -------------------------------------------------------------------------

  const cadastrar = async (
    aplicativo: 'META' | 'TYPEFORM' | 'RD_STATION',
    app: { id: string; segredo: string },
  ) =>
    (
      await admin
        .put(`${APPS}/${aplicativo}`, {
          clientId: app.id,
          segredo: app.segredo,
        })
        .expect(200)
    ).body as AppDto;

  const destino = (location: string) => {
    const url = new URL(location);
    return {
      caminho: url.pathname,
      consulta: url.searchParams,
      base: url.origin,
    };
  };

  /** "Entrar com o Typeform / RD Station": iniciar, diálogo (o `code` falso) e retorno. */
  const conectar = async (
    aplicativo: 'TYPEFORM' | 'RD_STATION',
    opcoes: { modo?: string; conexaoId?: string; nome?: string } = {},
  ) => {
    const { body } = await admin
      .post(`${CONEXOES}/oauth/iniciar`, {
        aplicativo,
        modo: opcoes.modo ?? 'janela',
        ...(opcoes.conexaoId ? { conexaoId: opcoes.conexaoId } : {}),
        ...(opcoes.nome ? { nome: opcoes.nome } : {}),
      })
      .expect(201);
    const inicio = body as {
      conexaoId: string;
      urlDialogo: string;
      expiraEm: string;
      enderecoDeRetorno: string;
    };
    const dialogo = new URL(inicio.urlDialogo);
    const state = dialogo.searchParams.get('state') ?? '';
    const code =
      aplicativo === 'TYPEFORM'
        ? typeform.novoCodigo(dialogo.searchParams.get('redirect_uri') ?? '')
        : rd.novoCodigo();
    const retorno = await request(t.servidor)
      .get(RETORNO_CONEXOES)
      .query({ code, state })
      .expect(302);
    return {
      ...inicio,
      dialogo,
      state,
      code,
      location: retorno.headers.location as string,
    };
  };

  const conexaoDe = (id: string) =>
    t.prisma.conexaoAplicativo.findUniqueOrThrow({ where: { id } });

  const criarIntegracao = async (
    aplicativo: 'TYPEFORM' | 'RD_STATION',
    configuracao: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ) => {
    const comercial = await funilBase(t, 'COMERCIAL');
    const resposta = await admin.post(`${API}/webhooks/entradas`, {
      nome: `${aplicativo} ${Math.random().toString(36).slice(2, 8)}`,
      aplicativo,
      funilId: comercial.id,
      etapaId: comercial.etapas[0].id,
      configuracao,
      ...extra,
    });
    return Object.assign(resposta, {
      /** Confere o status (a requisição já foi feita) e devolve a resposta. */
      expect(status: number) {
        expect(resposta.status).toBe(status);
        return resposta;
      },
    });
  };

  const criarOk = async (
    aplicativo: 'TYPEFORM' | 'RD_STATION',
    configuracao: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ) => {
    const resposta = (
      await criarIntegracao(aplicativo, configuracao, extra)
    ).expect(201);
    return resposta.body as {
      webhook: { id: string } & Record<string, unknown>;
      url: string;
    };
  };

  const configuracaoDe = async (id: string) =>
    (await t.prisma.webhookEntrada.findUniqueOrThrow({ where: { id } }))
      .configuracao as Record<string, unknown>;

  const avisosDeAtencao = () =>
    t.prisma.notificacao.findMany({
      where: { tipo: 'integracao.precisa_atencao' },
    });

  const auditoria = (acao: string) =>
    t.prisma.eventoAuditoria.findMany({ where: { acao } });

  /** `JSON.stringify` que aceita o `bigint` das linhas da auditoria. */
  const json = (valor: unknown) =>
    JSON.stringify(valor, (_chave, v: unknown) =>
      typeof v === 'bigint' ? v.toString() : v,
    );

  /** "Entrar com o Facebook" completo com o app das Configurações. */
  const conectarFacebook = async (modo: string = 'janela') => {
    const { body } = await admin
      .post(`${API}/webhooks/facebook/oauth/iniciar`, { modo })
      .expect(201);
    const inicio = body as { conexaoId: string; urlDialogo: string };
    const dialogo = new URL(inicio.urlDialogo);
    const state = dialogo.searchParams.get('state') ?? '';
    const code = graph.novoCodigo(
      dialogo.searchParams.get('redirect_uri') ?? '',
    );
    const retorno = await request(t.servidor)
      .get(RETORNO_FACEBOOK)
      .query({ code, state })
      .expect(302);
    return {
      conexaoId: inicio.conexaoId,
      dialogo,
      state,
      location: retorno.headers.location as string,
    };
  };

  // -------------------------------------------------------------------------
  // R32.22 — apps de login
  // -------------------------------------------------------------------------

  it('cenário 383 (R32.22, R10.3) — Configurações traz os 3 apps sempre; o Admin cadastra com o par conferido na Graph; o segredo nunca volta e a auditoria não leva valores', async () => {
    const vazio = (await admin.get(APPS).expect(200)).body as AppDto[];
    expect(vazio.map(({ aplicativo }) => aplicativo)).toEqual([
      'META',
      'TYPEFORM',
      'RD_STATION',
    ]);
    expect(vazio.every(({ configurado }) => !configurado)).toBe(true);
    expect(vazio[0].enderecoDeRetorno).toBe(
      `${ORIGEM}/api/v1/publico/facebook/oauth/retorno`,
    );
    expect(vazio[1].enderecoDeRetorno).toBe(
      `${ORIGEM}/api/v1/publico/conexoes/oauth/retorno`,
    );
    expect(vazio[1].escopos).toEqual([
      'accounts:read',
      'forms:read',
      'webhooks:read',
      'webhooks:write',
      'offline',
    ]);
    expect(vazio[0].escopos).toContain('leads_retrieval');

    // O segredo é obrigatório na primeira gravação; o ID, numérico na Meta.
    await admin.put(`${APPS}/META`, { clientId: APP_META.id }).expect(400);
    await admin
      .put(`${APPS}/META`, { clientId: 'abc', segredo: 'x' })
      .expect(400);
    await admin
      .put(`${APPS}/OUTRO`, { clientId: '1', segredo: 'x' })
      .expect(400);
    // A Meta recusa o par: 422 com mensagem clara, nada gravado.
    const recusado = await admin
      .put(`${APPS}/META`, { clientId: APP_META.id, segredo: 'errado' })
      .expect(422);
    expect((recusado.body as { mensagem: string }).mensagem).toMatch(
      /Meta não reconheceu este par/,
    );
    expect(await t.prisma.appDeLogin.count()).toBe(0);

    const meta = await cadastrar('META', APP_META);
    expect(meta).toMatchObject({
      aplicativo: 'META',
      configurado: true,
      clientId: APP_META.id,
      emUso: { conexoes: 0, canais: 0, integracoes: 0 },
      atualizadoPor: { nome: 'Admin' },
    });
    expect(meta.segredoMascarado).toMatch(/^••••/);
    expect(meta.segredoMascarado).not.toContain(APP_META.segredo);
    expect(meta.webhook).toMatchObject({
      url: `${ORIGEM}/api/v1/publico/meta/webhook`,
      campos: ['leadgen'],
    });
    expect(meta.webhook?.tokenVerificacao.length).toBeGreaterThan(20);
    // A Graph recebeu o formato documentado (`id|segredo`).
    expect(
      graph.pedidos.some((p) =>
        p.caminho.includes(
          `access_token=${encodeURIComponent(`${APP_META.id}|${APP_META.segredo}`)}`,
        ),
      ),
    ).toBe(true);

    const tf = await cadastrar('TYPEFORM', APP_TYPEFORM);
    expect(tf.webhook).toBeNull();
    // O segredo está cifrado no banco e fora de qualquer resposta.
    const linha = await t.prisma.appDeLogin.findUniqueOrThrow({
      where: { aplicativo: 'META' },
    });
    expect(linha.segredoCifrado).not.toContain(APP_META.segredo);
    expect(JSON.stringify(await admin.get(APPS))).not.toContain(
      APP_META.segredo,
    );

    // Auditoria: ação, campos e contagens; nunca o ID, o segredo nem o token.
    const eventos = [
      ...(await auditoria('app_de_login.configurado')),
      ...(await auditoria('app_de_login.atualizado')),
    ];
    expect(eventos.length).toBe(2);
    const texto = json(eventos);
    for (const segredo of [
      APP_META.segredo,
      APP_META.id,
      APP_TYPEFORM.segredo,
      meta.webhook?.tokenVerificacao ?? '',
    ]) {
      expect(texto).not.toContain(segredo);
    }
    // Sem mudança, nada é regravado.
    await admin.put(`${APPS}/META`, { clientId: APP_META.id }).expect(200);
    expect((await auditoria('app_de_login.atualizado')).length).toBe(0);
  });

  it('cenário 384 (R32.22, R32.24) — trocar só o segredo leva o novo às conexões e aos canais marcados, na mesma gravação; o que tem app próprio fica como está', async () => {
    await cadastrar('META', APP_META);
    const { conexaoId } = await conectarFacebook();
    const canal = (
      await admin
        .post(`${API}/meta/canais`, {
          tipo: 'MESSENGER',
          nome: 'Página',
          pageId: '109876543210987',
          tokenPagina: 'token-da-pagina',
        })
        .expect(201)
    ).body as { id: string };
    // Um canal com app próprio não acompanha o das Configurações.
    const proprio = (
      await admin
        .post(`${API}/meta/canais`, {
          tipo: 'MESSENGER',
          nome: 'Outra página',
          pageId: '209876543210987',
          tokenPagina: 'token-da-outra',
          appId: '5555555555555',
          appSecret: 'segredo-do-app-proprio',
        })
        .expect(201)
    ).body as { id: string };
    expect((await admin.get(APPS).expect(200)).body[0].emUso).toEqual({
      conexoes: 1,
      canais: 1,
      integracoes: 0,
    });

    // O mesmo ID com outro segredo (o da Meta), conferido na Graph.
    graph.apps = [
      { ...APP_META, segredo: 'meta-segredo-novo-0123456' },
      APP_META_2,
    ];
    await admin
      .put(`${APPS}/META`, {
        clientId: APP_META.id,
        segredo: 'meta-segredo-novo-0123456',
      })
      .expect(200);
    const cripto = t.get(CriptografiaService);
    const conexao = await t.prisma.conexaoFacebook.findUniqueOrThrow({
      where: { id: conexaoId },
    });
    expect(cripto.decifrar(conexao.appSecretCifrado)).toBe(
      'meta-segredo-novo-0123456',
    );
    expect(conexao.precisaAtencao).toBe(false);
    const canalMarcado = await t.prisma.canal.findUniqueOrThrow({
      where: { id: canal.id },
    });
    expect(
      JSON.parse(cripto.decifrar(canalMarcado.segredosCifrados ?? '')),
    ).toMatchObject({
      appSecret: 'meta-segredo-novo-0123456',
      tokenPagina: 'token-da-pagina',
    });
    const canalProprio = await t.prisma.canal.findUniqueOrThrow({
      where: { id: proprio.id },
    });
    expect(
      JSON.parse(cripto.decifrar(canalProprio.segredosCifrados ?? '')),
    ).toMatchObject({ appSecret: 'segredo-do-app-proprio' });
    const eventos = await auditoria('app_de_login.atualizado');
    expect(eventos.length).toBe(1);
    expect(json(eventos)).not.toContain('meta-segredo-novo');
  });

  it('cenário 385 (R32.22) — trocar o ID de um app em uso: 409 com o que está em uso; com confirmarTroca, conexões, canais e integrações ficam "precisa de atenção"', async () => {
    await cadastrarTodosSemRd();
    // Typeform: uma conexão e uma integração.
    const tf = await conectar('TYPEFORM');
    const integracao = await criarOk('TYPEFORM', {
      conexaoId: tf.conexaoId,
      formularioId: 'abc123',
    });
    // Meta: uma conexão do Facebook e um canal.
    const fb = await conectarFacebook();
    await admin
      .post(`${API}/meta/canais`, {
        tipo: 'INSTAGRAM',
        nome: 'Instagram',
        pageId: '109876543210987',
        instagramId: '17841400000000000',
        tokenPagina: 'token',
      })
      .expect(201);

    const conflito = await admin
      .put(`${APPS}/TYPEFORM`, {
        clientId: 'outro-client',
        segredo: 'novo-segredo',
      })
      .expect(409);
    expect(
      (conflito.body as { detalhes: { emUso: unknown } }).detalhes.emUso,
    ).toEqual({ conexoes: 1, canais: 0, integracoes: 1 });
    // Trocar o ID exige o segredo do app novo.
    await admin
      .put(`${APPS}/TYPEFORM`, {
        clientId: 'outro-client',
        confirmarTroca: true,
      })
      .expect(400);
    expect((await conexaoDe(tf.conexaoId)).precisaAtencao).toBe(false);

    await admin
      .put(`${APPS}/TYPEFORM`, {
        clientId: 'outro-client',
        segredo: 'novo-segredo',
        confirmarTroca: true,
      })
      .expect(200);
    const conexao = await conexaoDe(tf.conexaoId);
    expect(conexao).toMatchObject({
      precisaAtencao: true,
      tokensCifrados: null,
    });
    expect(conexao.atencaoMotivo).toMatch(/app de login mudou/);
    expect(
      (
        await t.prisma.webhookEntrada.findUniqueOrThrow({
          where: { id: integracao.webhook.id },
        })
      ).precisaAtencao,
    ).toBe(true);
    expect((await avisosDeAtencao()).length).toBe(1);

    // Meta: o novo par é conferido na Graph (APP_META_2) e as cópias ficam com o app novo.
    await admin
      .put(`${APPS}/META`, {
        clientId: APP_META_2.id,
        segredo: APP_META_2.segredo,
      })
      .expect(409);
    await admin
      .put(`${APPS}/META`, {
        clientId: APP_META_2.id,
        segredo: 'errado',
        confirmarTroca: true,
      })
      .expect(422);
    await admin
      .put(`${APPS}/META`, {
        clientId: APP_META_2.id,
        segredo: APP_META_2.segredo,
        confirmarTroca: true,
      })
      .expect(200);
    const conexaoFb = await t.prisma.conexaoFacebook.findUniqueOrThrow({
      where: { id: fb.conexaoId },
    });
    expect(conexaoFb).toMatchObject({
      appId: APP_META_2.id,
      precisaAtencao: true,
    });
    const canais = await t.prisma.canal.findMany({});
    expect(canais.map((c) => c.ultimoErro)).toEqual([
      expect.stringMatching(/conecte de novo/),
    ]);
    expect((canais[0].configuracao as { appId: string }).appId).toBe(
      APP_META_2.id,
    );
    const texto = json(await auditoria('app_de_login.atualizado'));
    expect(texto).not.toContain('novo-segredo');
    expect(texto).not.toContain(APP_META_2.segredo);
  });

  const cadastrarTodosSemRd = async () => {
    await cadastrar('META', APP_META);
    await cadastrar('TYPEFORM', APP_TYPEFORM);
  };

  it('cenário 386 (R32.22) — remover o app: 409 enquanto há conexão ou canal usando; sem uso, 204 e some; remover de novo é 404', async () => {
    await cadastrar('TYPEFORM', APP_TYPEFORM);
    await admin.delete(`${APPS}/RD_STATION`).expect(404);
    const { conexaoId } = await conectar('TYPEFORM');
    const conflito = await admin.delete(`${APPS}/TYPEFORM`).expect(409);
    expect(
      (conflito.body as { detalhes: { emUso: { conexoes: number } } }).detalhes
        .emUso.conexoes,
    ).toBe(1);
    await admin.delete(`${CONEXOES}/${conexaoId}`).expect(204);
    await admin.delete(`${APPS}/TYPEFORM`).expect(204);
    expect(await t.prisma.appDeLogin.count()).toBe(0);
    expect((await auditoria('app_de_login.removido')).length).toBe(1);
    await admin.delete(`${APPS}/TYPEFORM`).expect(404);

    // Meta: um canal com o app das Configurações também segura a remoção.
    await cadastrar('META', APP_META);
    const canal = (
      await admin
        .post(`${API}/meta/canais`, {
          tipo: 'MESSENGER',
          nome: 'Página',
          pageId: '109876543210987',
          tokenPagina: 'token',
        })
        .expect(201)
    ).body as { id: string };
    await admin.delete(`${APPS}/META`).expect(409);
    await admin.delete(`${API}/meta/canais/${canal.id}`).expect(204);
    await admin.delete(`${APPS}/META`).expect(204);
  });

  it('cenário 387 (R32.22, R14) — o desafio GET do webhook de páginas passa com o token de verificação do app da Meta e dá 403 com outro', async () => {
    const meta = await cadastrar('META', APP_META);
    const token = meta.webhook?.tokenVerificacao ?? '';
    const desafio = (verify: string) =>
      request(t.servidor).get(`${API}/publico/meta/webhook`).query({
        'hub.mode': 'subscribe',
        'hub.verify_token': verify,
        'hub.challenge': 'desafio-123',
      });
    await desafio('').expect(403);
    await desafio(`${token}x`).expect(403);
    const resposta = await desafio(token).expect(200);
    expect(resposta.text).toBe('desafio-123');
    // O token do app é estável entre gravações (o painel da Meta não precisa ser refeito).
    await admin
      .put(`${APPS}/META`, { clientId: APP_META.id, segredo: APP_META.segredo })
      .expect(200);
    await desafio(token).expect(200);
    // Removido o app, o token deixa de valer.
    await admin.delete(`${APPS}/META`).expect(204);
    await desafio(token).expect(403);
  });

  // -------------------------------------------------------------------------
  // R32.24 — Facebook e canais com o app das Configurações
  // -------------------------------------------------------------------------

  it('cenário 388 (R32.24) — o login do Facebook e o token de página sem appId usam o app das Configurações (cópia + marca); sem app cadastrado, 422 claro; os campos antigos seguem aceitos', async () => {
    const semApp = await admin
      .post(`${API}/webhooks/facebook/oauth/iniciar`, {})
      .expect(422);
    expect((semApp.body as { mensagem: string }).mensagem).toBe(
      'O app da Meta ainda não foi cadastrado. Cadastre-o em Configurações > Apps de login.',
    );
    await admin
      .post(`${API}/webhooks/facebook/conexoes/token-de-pagina`, {
        tokenPagina: 'pg-300000000000001',
        paginaId: '300000000000001',
      })
      .expect(422);
    expect(
      (await admin.get(`${API}/webhooks/facebook/configuracao`).expect(200))
        .body.appCadastrado,
    ).toBe(false);

    await cadastrar('META', APP_META);
    expect(
      (await admin.get(`${API}/webhooks/facebook/configuracao`).expect(200))
        .body.appCadastrado,
    ).toBe(true);
    const { conexaoId, dialogo, location } = await conectarFacebook('pagina');
    expect(dialogo.searchParams.get('client_id')).toBe(APP_META.id);
    expect(dialogo.searchParams.has('display')).toBe(false);
    expect(destino(location).consulta.get('facebook')).toBe('conectado');
    const conexao = (
      await admin
        .get(`${API}/webhooks/facebook/conexoes/${conexaoId}`)
        .expect(200)
    ).body as {
      appId: string;
      appDasConfiguracoes: boolean;
      conectada: boolean;
    };
    expect(conexao).toMatchObject({
      appId: APP_META.id,
      appDasConfiguracoes: true,
      conectada: true,
    });
    const cripto = t.get(CriptografiaService);
    expect(
      cripto.decifrar(
        (
          await t.prisma.conexaoFacebook.findUniqueOrThrow({
            where: { id: conexaoId },
          })
        ).appSecretCifrado,
      ),
    ).toBe(APP_META.segredo);

    // Token de página sem appId: também usa o app das Configurações.
    const porToken = await admin
      .post(`${API}/webhooks/facebook/conexoes/token-de-pagina`, {
        tokenPagina: 'pg-300000000000001',
        paginaId: '300000000000001',
      })
      .expect(201);
    expect(porToken.body).toMatchObject({
      appId: APP_META.id,
      appDasConfiguracoes: true,
    });

    // Compatibilidade: appId + appSecret próprios seguem valendo e não ganham a marca.
    const proprio = await admin
      .post(`${API}/webhooks/facebook/oauth/iniciar`, {
        appId: APP_META_2.id,
        appSecret: APP_META_2.segredo,
      })
      .expect(201);
    expect(
      (
        await admin
          .get(
            `${API}/webhooks/facebook/conexoes/${(proprio.body as { conexaoId: string }).conexaoId}`,
          )
          .expect(200)
      ).body.appDasConfiguracoes,
    ).toBe(false);
    // Só o ID, sem o segredo, continua sendo erro.
    await admin
      .post(`${API}/webhooks/facebook/oauth/iniciar`, { appId: APP_META_2.id })
      .expect(400);
    expect((await admin.get(APPS).expect(200)).body[0].emUso).toMatchObject({
      conexoes: 2,
    });
  });

  it('cenário 389 (R32.24) — os canais Messenger e Instagram são criados sem appId e appSecret quando o app está cadastrado (cópia + marca); "outro app" exige o par; sem app, 422', async () => {
    const corpo = {
      tipo: 'MESSENGER',
      nome: 'Página',
      pageId: '109876543210987',
      tokenPagina: 'token-da-pagina',
    };
    await admin.post(`${API}/meta/canais`, corpo).expect(422);
    await cadastrar('META', APP_META);
    const criado = (await admin.post(`${API}/meta/canais`, corpo).expect(201))
      .body as {
      id: string;
      appId: string;
      appDasConfiguracoes: boolean;
      appSecret: string;
    };
    expect(criado).toMatchObject({
      appId: APP_META.id,
      appDasConfiguracoes: true,
    });
    expect(criado.appSecret).toMatch(/^••••/);
    const canal = await t.prisma.canal.findUniqueOrThrow({
      where: { id: criado.id },
    });
    expect(
      JSON.parse(
        t.get(CriptografiaService).decifrar(canal.segredosCifrados ?? ''),
      ),
    ).toMatchObject({ appSecret: APP_META.segredo });
    // O segredo copiado confere a assinatura do webhook (o roteador lê a cópia do canal).
    const instagram = (
      await admin
        .post(`${API}/meta/canais`, {
          ...corpo,
          tipo: 'INSTAGRAM',
          nome: 'Instagram',
          pageId: '309876543210987',
          instagramId: '17841400000000001',
        })
        .expect(201)
    ).body as { appDasConfiguracoes: boolean };
    expect(instagram.appDasConfiguracoes).toBe(true);

    // Metade do par é erro; o par inteiro é "outro app" (sem marca).
    await admin
      .post(`${API}/meta/canais`, {
        ...corpo,
        nome: 'Outra',
        pageId: '409876543210987',
        appId: '5555555555555',
      })
      .expect(400);
    const outro = (
      await admin
        .post(`${API}/meta/canais`, {
          ...corpo,
          nome: 'Outra',
          pageId: '409876543210987',
          appId: '5555555555555',
          appSecret: 'segredo-proprio',
        })
        .expect(201)
    ).body as { id: string; appDasConfiguracoes: boolean };
    expect(outro.appDasConfiguracoes).toBe(false);
    // Editar o canal marcado sem tocar no app mantém a marca; informar outro app a tira.
    const mantido = await admin
      .patch(`${API}/meta/canais/${criado.id}`, { nome: 'Página 2' })
      .expect(200);
    expect(mantido.body.appDasConfiguracoes).toBe(true);
    const trocado = await admin
      .patch(`${API}/meta/canais/${criado.id}`, {
        appId: '5555555555555',
        appSecret: 'segredo-proprio',
      })
      .expect(200);
    expect(trocado.body.appDasConfiguracoes).toBe(false);
  });

  // -------------------------------------------------------------------------
  // R32.23 — login em outra janela
  // -------------------------------------------------------------------------

  it('cenário 390 (R32.23, R32.14) — Facebook em janela: display=popup no diálogo e retorno em /retorno-login; em página, como antes; cancelamento, state inválido e state usado voltam pelo mesmo caminho', async () => {
    await cadastrar('META', APP_META);
    const janela = await conectarFacebook('janela');
    expect(janela.dialogo.searchParams.get('display')).toBe('popup');
    expect(janela.dialogo.origin).toBe('http://dialogo.meta.teste');
    const destinoJanela = destino(janela.location);
    expect(destinoJanela.base).toBe(ORIGEM);
    expect(destinoJanela.caminho).toBe('/retorno-login');
    expect(Object.fromEntries(destinoJanela.consulta)).toEqual({
      app: 'facebook',
      resultado: 'conectado',
      conexao: janela.conexaoId,
    });
    const pagina = await conectarFacebook('pagina');
    expect(destino(pagina.location).caminho).toBe('/integracoes');
    expect(Object.fromEntries(destino(pagina.location).consulta)).toEqual({
      facebook: 'conectado',
      conexao: pagina.conexaoId,
    });
    // Sem `modo`, o padrão é a página.
    const padrao = (
      await admin.post(`${API}/webhooks/facebook/oauth/iniciar`, {}).expect(201)
    ).body as { urlDialogo: string };
    expect(new URL(padrao.urlDialogo).searchParams.has('display')).toBe(false);
    await admin
      .post(`${API}/webhooks/facebook/oauth/iniciar`, { modo: 'popup' })
      .expect(400);

    // O mesmo state de novo: usado, em janela.
    const usado = await request(t.servidor)
      .get(RETORNO_FACEBOOK)
      .query({ code: 'qualquer', state: janela.state })
      .expect(302);
    expect(
      Object.fromEntries(destino(usado.headers.location).consulta),
    ).toMatchObject({
      app: 'facebook',
      resultado: 'erro',
      motivo: 'state_usado',
    });
    // Cancelamento na janela da Meta: access_denied volta como cancelado.
    const inicio = (
      await admin
        .post(`${API}/webhooks/facebook/oauth/iniciar`, { modo: 'janela' })
        .expect(201)
    ).body as { urlDialogo: string; conexaoId: string };
    const cancelado = await request(t.servidor)
      .get(RETORNO_FACEBOOK)
      .query({
        error: 'access_denied',
        error_reason: 'user_denied',
        state: new URL(inicio.urlDialogo).searchParams.get('state'),
      })
      .expect(302);
    expect(
      Object.fromEntries(destino(cancelado.headers.location).consulta),
    ).toEqual({
      app: 'facebook',
      resultado: 'cancelado',
      conexao: inicio.conexaoId,
      motivo: 'access_denied',
    });
    // State adulterado: erro e o destino é sempre o do próprio CRM (sem redirecionamento aberto).
    const adulterado = await request(t.servidor)
      .get(RETORNO_FACEBOOK)
      .query({
        code: 'x',
        state: `${janela.state.slice(0, -2)}xx`,
        redirect: 'https://mal.com',
        next: 'https://mal.com',
      })
      .expect(302);
    expect(
      adulterado.headers.location.startsWith(`${ORIGEM}/retorno-login?`),
    ).toBe(true);
    expect(destino(adulterado.headers.location).consulta.get('motivo')).toBe(
      'state_invalido',
    );
    expect(adulterado.headers.location).not.toContain('mal.com');
    const semState = await request(t.servidor)
      .get(RETORNO_FACEBOOK)
      .expect(302);
    expect(semState.headers.location.startsWith(`${ORIGEM}/integracoes?`)).toBe(
      true,
    );
  });

  // -------------------------------------------------------------------------
  // R32.25 — Typeform por login
  // -------------------------------------------------------------------------

  it('cenário 391 (R32.25, R32.23) — "Entrar com o Typeform": sem app cadastrado 422; com ele, diálogo com escopos e state, retorno em janela com a conta; em página, /integracoes?typeform=…; tokens cifrados', async () => {
    const corpo = { aplicativo: 'TYPEFORM', modo: 'janela' };
    await admin.post(`${CONEXOES}/oauth/iniciar`, corpo).expect(422);
    await admin
      .post(`${CONEXOES}/oauth/iniciar`, { aplicativo: 'META' })
      .expect(400);
    await cadastrar('TYPEFORM', APP_TYPEFORM);

    const janela = await conectar('TYPEFORM', {
      modo: 'janela',
      nome: 'Typeform da escola',
    });
    expect(janela.dialogo.origin).toBe('http://dialogo.typeform.teste');
    expect(janela.dialogo.pathname).toBe('/oauth/authorize');
    expect(janela.dialogo.searchParams.get('client_id')).toBe(APP_TYPEFORM.id);
    expect(janela.dialogo.searchParams.get('scope')).toBe(
      'accounts:read forms:read webhooks:read webhooks:write offline',
    );
    expect(janela.dialogo.searchParams.get('redirect_uri')).toBe(
      `${ORIGEM}/api/v1/publico/conexoes/oauth/retorno`,
    );
    expect(janela.enderecoDeRetorno).toBe(
      janela.dialogo.searchParams.get('redirect_uri'),
    );
    expect(Object.fromEntries(destino(janela.location).consulta)).toEqual({
      app: 'typeform',
      resultado: 'conectado',
      conexao: janela.conexaoId,
    });
    expect(destino(janela.location).caminho).toBe('/retorno-login');
    // A troca do code: POST form-urlencoded com o app das Configurações.
    const troca = typeform.quais('POST', '/oauth/token')[0].corpo;
    expect(troca).toMatchObject({
      grant_type: 'authorization_code',
      client_id: APP_TYPEFORM.id,
      redirect_uri: janela.enderecoDeRetorno,
    });

    const detalhe = (
      await admin.get(`${CONEXOES}/${janela.conexaoId}`).expect(200)
    ).body as Record<string, unknown>;
    expect(detalhe).toMatchObject({
      aplicativo: 'TYPEFORM',
      nome: 'Typeform da escola',
      conta: 'maria@escola.com.br',
      conectada: true,
      precisaAtencao: false,
      integracoes: 0,
    });
    const texto = JSON.stringify(detalhe);
    expect(texto).not.toMatch(/tf-acesso|tf-refresh|tokens/);
    const linha = await conexaoDe(janela.conexaoId);
    expect(linha.tokensCifrados).not.toMatch(/tf-acesso/);
    expect(linha.expiraEm?.getTime()).toBeGreaterThan(
      Date.now() + 6 * 86400_000,
    );
    expect(json(await auditoria('conexao_aplicativo.conectada'))).not.toMatch(
      /tf-acesso|tf-refresh/,
    );

    const pagina = await conectar('TYPEFORM', { modo: 'pagina' });
    expect(destino(pagina.location).caminho).toBe('/integracoes');
    expect(Object.fromEntries(destino(pagina.location).consulta)).toEqual({
      typeform: 'conectado',
      conexao: pagina.conexaoId,
    });
    // O nome automático ganha a conta; a lista traz as duas conexões do Typeform.
    const lista = (
      await admin.get(`${CONEXOES}?aplicativo=TYPEFORM`).expect(200)
    ).body as { nome: string }[];
    expect(lista.map(({ nome }) => nome)).toEqual([
      'Typeform da escola',
      'Typeform de maria@escola.com.br',
    ]);
    expect(
      (await admin.get(`${CONEXOES}?aplicativo=RD_STATION`).expect(200)).body,
    ).toEqual([]);
    await admin.get(`${CONEXOES}?aplicativo=META`).expect(400);
  });

  it('cenário 392 (R32.25, R32.23) — o state é de uso único, vence em 10 minutos, vale só para o Admin que iniciou e não passa adulterado nem de outro domínio; cancelar volta como cancelado', async () => {
    await cadastrar('TYPEFORM', APP_TYPEFORM);
    const primeiro = await conectar('TYPEFORM', { modo: 'janela' });
    // Usado: o mesmo state de novo.
    const usado = await request(t.servidor)
      .get(RETORNO_CONEXOES)
      .query({
        code: typeform.novoCodigo(primeiro.enderecoDeRetorno),
        state: primeiro.state,
      })
      .expect(302);
    expect(
      Object.fromEntries(destino(usado.headers.location).consulta),
    ).toMatchObject({
      app: 'typeform',
      resultado: 'erro',
      motivo: 'state_usado',
      conexao: primeiro.conexaoId,
    });
    // Reconectar por outro Admin invalida o state do primeiro (um login em andamento por conexão).
    const outroAdmin = await entrarComo(
      t,
      await criarUsuario(t, { papel: 'ADMIN', nome: 'Outro' }),
    );
    const inicioA = (
      await admin
        .post(`${CONEXOES}/oauth/iniciar`, {
          aplicativo: 'TYPEFORM',
          conexaoId: primeiro.conexaoId,
          modo: 'janela',
        })
        .expect(201)
    ).body as { urlDialogo: string };
    await outroAdmin
      .post(`${CONEXOES}/oauth/iniciar`, {
        aplicativo: 'TYPEFORM',
        conexaoId: primeiro.conexaoId,
        modo: 'janela',
      })
      .expect(201);
    const antigo = await request(t.servidor)
      .get(RETORNO_CONEXOES)
      .query({
        code: 'x',
        state: new URL(inicioA.urlDialogo).searchParams.get('state'),
      })
      .expect(302);
    expect(destino(antigo.headers.location).consulta.get('motivo')).toBe(
      'state_usado',
    );

    // Vencido: state assinado com a validade no passado.
    const chave = t.ambiente.chaveCriptografia;
    const nonce = `aleatorio~${adminUsuario.id}~j~typeform`;
    const vencido = assinarState(
      chave,
      'conexao-aplicativo-oauth-state',
      primeiro.conexaoId,
      nonce,
      Math.floor(Date.now() / 1000) - 60,
    );
    const respostaVencido = await request(t.servidor)
      .get(RETORNO_CONEXOES)
      .query({ code: 'x', state: vencido })
      .expect(302);
    expect(
      Object.fromEntries(destino(respostaVencido.headers.location).consulta),
    ).toEqual({
      app: 'typeform',
      resultado: 'erro',
      motivo: 'state_vencido',
    });
    // Do domínio do Facebook ou adulterado: inválido.
    const doFacebook = assinarState(
      chave,
      'facebook-oauth-state',
      primeiro.conexaoId,
      nonce,
      Math.floor(Date.now() / 1000) + 600,
    );
    for (const state of [
      doFacebook,
      `${vencido.slice(0, -3)}abc`,
      'lixo',
      '',
    ]) {
      const r = await request(t.servidor)
        .get(RETORNO_CONEXOES)
        .query({ code: 'x', state })
        .expect(302);
      expect(destino(r.headers.location).consulta.get('motivo')).toMatch(
        /^state_(invalido|vencido)$/,
      );
      expect(r.headers.location.startsWith(`${ORIGEM}/`)).toBe(true);
    }

    // O Admin que iniciou deixou de ser Admin antes do retorno: o state não vale mais.
    const iniciado = (
      await admin
        .post(`${CONEXOES}/oauth/iniciar`, {
          aplicativo: 'TYPEFORM',
          modo: 'janela',
        })
        .expect(201)
    ).body as { urlDialogo: string; conexaoId: string };
    await t.prisma.usuario.update({
      where: { id: adminUsuario.id },
      data: { papel: 'MEMBRO', area: 'COMERCIAL' },
    });
    const semAdmin = await request(t.servidor)
      .get(RETORNO_CONEXOES)
      .query({
        code: typeform.novoCodigo(
          `${ORIGEM}/api/v1/publico/conexoes/oauth/retorno`,
        ),
        state: new URL(iniciado.urlDialogo).searchParams.get('state'),
      })
      .expect(302);
    expect(destino(semAdmin.headers.location).consulta.get('motivo')).toBe(
      'state_invalido',
    );
    expect((await conexaoDe(iniciado.conexaoId)).tokensCifrados).toBeNull();
    await t.prisma.usuario.update({
      where: { id: adminUsuario.id },
      data: { papel: 'ADMIN', area: null },
    });

    // Cancelamento no diálogo do Typeform: cancelado, sem token; em página, /integracoes.
    for (const modo of ['janela', 'pagina']) {
      const inicio = (
        await admin
          .post(`${CONEXOES}/oauth/iniciar`, { aplicativo: 'TYPEFORM', modo })
          .expect(201)
      ).body as { urlDialogo: string; conexaoId: string };
      const r = await request(t.servidor)
        .get(RETORNO_CONEXOES)
        .query({
          error: 'access_denied',
          state: new URL(inicio.urlDialogo).searchParams.get('state'),
        })
        .expect(302);
      const d = destino(r.headers.location);
      expect(d.caminho).toBe(
        modo === 'janela' ? '/retorno-login' : '/integracoes',
      );
      expect(d.consulta.get(modo === 'janela' ? 'resultado' : 'typeform')).toBe(
        'cancelado',
      );
      expect(d.consulta.get('motivo')).toBe('access_denied');
      expect((await conexaoDe(inicio.conexaoId)).tokensCifrados).toBeNull();
    }
    // O `code` recusado pelo Typeform volta com a mensagem, sem vazar nada.
    const inicioRecusado = (
      await admin
        .post(`${CONEXOES}/oauth/iniciar`, {
          aplicativo: 'TYPEFORM',
          modo: 'janela',
        })
        .expect(201)
    ).body as { urlDialogo: string };
    const recusado = await request(t.servidor)
      .get(RETORNO_CONEXOES)
      .query({
        code: 'codigo-que-o-typeform-nao-conhece',
        state: new URL(inicioRecusado.urlDialogo).searchParams.get('state'),
      })
      .expect(302);
    expect(
      Object.fromEntries(destino(recusado.headers.location).consulta),
    ).toMatchObject({
      resultado: 'erro',
      motivo: 'servico_recusou',
    });
    // Reconexão com a conexão de outro aplicativo: erro de campo.
    await cadastrar('RD_STATION', APP_RD);
    const rdConexao = await conectar('RD_STATION');
    await admin
      .post(`${CONEXOES}/oauth/iniciar`, {
        aplicativo: 'TYPEFORM',
        conexaoId: rdConexao.conexaoId,
      })
      .expect(400);
  });

  it('cenário 393 (R32.25) — o token vencido é renovado antes do uso (o novo refresh substitui o antigo); um 401 renova e tenta uma vez; renovação recusada deixa a conexão e a integração "precisa de atenção" e reconectar resolve', async () => {
    await cadastrar('TYPEFORM', APP_TYPEFORM);
    const { conexaoId } = await conectar('TYPEFORM');
    const integracao = await criarOk('TYPEFORM', {
      conexaoId,
      formularioId: 'abc123',
    });
    const formularios = () =>
      admin.get(
        `${API}/webhooks/entradas/${integracao.webhook.id}/formularios`,
      );
    typeform.pedidos = [];

    // Vencido pelo relógio: renova antes de usar.
    await t.prisma.conexaoAplicativo.update({
      where: { id: conexaoId },
      data: { expiraEm: new Date(Date.now() - 1000) },
    });
    const lista = (await formularios().expect(200)).body as { id: string }[];
    expect(lista[0].id).toBe('abc123');
    const renovacoes = typeform.quais('POST', '/oauth/token');
    expect(renovacoes.length).toBe(1);
    expect(renovacoes[0].corpo).toMatchObject({
      grant_type: 'refresh_token',
      client_id: APP_TYPEFORM.id,
    });
    expect(typeform.refreshes.size).toBe(1);
    expect((await conexaoDe(conexaoId)).expiraEm!.getTime()).toBeGreaterThan(
      Date.now(),
    );
    // O refresh novo foi guardado (a rotação invalidou o anterior): outra renovação funciona.
    await t.prisma.conexaoAplicativo.update({
      where: { id: conexaoId },
      data: { expiraEm: new Date(Date.now() - 1000) },
    });
    await formularios().expect(200);
    expect(typeform.quais('POST', '/oauth/token').length).toBe(2);

    // 401 com o token que o relógio dá como válido: renova e repete uma vez.
    typeform.pedidos = [];
    typeform.invalidarAcessos();
    await formularios().expect(200);
    expect(typeform.quais('GET', '/forms?').length).toBe(2);
    expect(typeform.quais('POST', '/oauth/token').length).toBe(1);

    // Renovação recusada (refresh revogado): 422, conexão e integração "precisa de atenção", um aviso ao Admin.
    typeform.recusarRenovacao = true;
    typeform.invalidarAcessos();
    const falha = await formularios().expect(422);
    expect((falha.body as { mensagem: string }).mensagem).toMatch(
      /conecte o Typeform de novo/,
    );
    expect(await conexaoDe(conexaoId)).toMatchObject({ precisaAtencao: true });
    expect(
      (
        await t.prisma.webhookEntrada.findUniqueOrThrow({
          where: { id: integracao.webhook.id },
        })
      ).precisaAtencao,
    ).toBe(true);
    expect((await avisosDeAtencao()).length).toBe(1);
    await formularios().expect(422);
    expect((await avisosDeAtencao()).length).toBe(1);
    const lista2 = (await admin.get(CONEXOES).expect(200)).body as {
      precisaAtencao: boolean;
      atencaoMotivo: string;
    }[];
    expect(lista2[0]).toMatchObject({ precisaAtencao: true });
    expect(lista2[0].atencaoMotivo).toMatch(/conecte o Typeform de novo/);

    // Entrar de novo na mesma conexão resolve: atenção limpa e o webhook volta a ser registrado.
    typeform.recusarRenovacao = false;
    typeform.webhooks.clear();
    await conectar('TYPEFORM', { conexaoId });
    expect(await conexaoDe(conexaoId)).toMatchObject({ precisaAtencao: false });
    expect(
      (
        await t.prisma.webhookEntrada.findUniqueOrThrow({
          where: { id: integracao.webhook.id },
        })
      ).precisaAtencao,
    ).toBe(false);
    expect(typeform.webhooks.size).toBe(1);
    await formularios().expect(200);
    // Nenhum token em respostas ou auditoria.
    expect(json(await t.prisma.eventoAuditoria.findMany())).not.toMatch(
      /tf-acesso|tf-refresh/,
    );
  });

  it('cenário 394 (R32.25) — integração Typeform com conexão: sem token pessoal, lista formulários e campos e registra e remove o webhook com o token da conexão; token e conexão juntos são erro; excluir a conexão usada é 409', async () => {
    await cadastrar('TYPEFORM', APP_TYPEFORM);
    const { conexaoId } = await conectar('TYPEFORM');
    // As duas credenciais juntas, ou nenhuma, não passam.
    (
      await criarIntegracao(
        'TYPEFORM',
        { conexaoId, formularioId: 'abc123' },
        { credencial: { token: 'tfp_pessoal' } },
      )
    ).expect(400);
    (await criarIntegracao('TYPEFORM', { formularioId: 'abc123' })).expect(400);
    // Conexão inexistente, de outro aplicativo ou sem login terminado.
    (
      await criarIntegracao('TYPEFORM', {
        conexaoId: '00000000-0000-4000-8000-000000000000',
        formularioId: 'abc123',
      })
    ).expect(404);
    const pendente = (
      await admin
        .post(`${CONEXOES}/oauth/iniciar`, { aplicativo: 'TYPEFORM' })
        .expect(201)
    ).body as { conexaoId: string };
    (
      await criarIntegracao('TYPEFORM', {
        conexaoId: pendente.conexaoId,
        formularioId: 'abc123',
      })
    ).expect(422);

    const integracao = await criarOk('TYPEFORM', {
      conexaoId,
      formularioId: 'abc123',
    });
    const detalhe = (
      await admin
        .get(`${API}/webhooks/entradas/${integracao.webhook.id}`)
        .expect(200)
    ).body as {
      credencial: { configurada: boolean };
      configuracao: Record<string, unknown>;
    };
    expect(detalhe.credencial.configurada).toBe(false);
    expect(detalhe.configuracao.conexaoId).toBe(conexaoId);
    expect(detalhe.configuracao.webhookRegistrado).toMatchObject({
      formularioId: 'abc123',
    });
    expect(typeform.webhooks.size).toBe(1);
    const registro = typeform.quais('PUT', '/forms/abc123/webhooks/')[0];
    expect(registro.autorizacao).toMatch(/^Bearer tf-acesso-/);
    expect(registro.corpo).toMatchObject({
      url: integracao.url,
      enabled: true,
    });

    const campos = (
      await admin
        .post(`${API}/webhooks/entradas/${integracao.webhook.id}/buscar-campos`)
        .expect(200)
    ).body as { campos: { caminho: string }[] };
    expect(campos.campos.map(({ caminho }) => caminho)).toEqual(
      expect.arrayContaining(['nome_completo', 'email_contato']),
    );
    const teste = (
      await admin
        .post(
          `${API}/webhooks/entradas/${integracao.webhook.id}/testar-credencial`,
        )
        .expect(200)
    ).body as { valida: boolean };
    expect(teste.valida).toBe(true);

    // Excluir a conexão usada: 409; a integração segue ao desativar (a conexão ainda é dela).
    const conflito = await admin.delete(`${CONEXOES}/${conexaoId}`).expect(409);
    expect(
      (conflito.body as { detalhes: { integracoes: number } }).detalhes
        .integracoes,
    ).toBe(1);
    // Voltar ao token pessoal exige informá-lo; informado, a conexão sai da integração.
    await admin
      .patch(`${API}/webhooks/entradas/${integracao.webhook.id}`, {
        configuracao: { conexaoId: null },
      })
      .expect(400);
    await admin
      .patch(`${API}/webhooks/entradas/${integracao.webhook.id}`, {
        credencial: { token: 'tfp_pessoal' },
        configuracao: { conexaoId },
      })
      .expect(400);
    // Excluir a integração remove o webhook do formulário com o token da conexão e libera a conexão.
    await admin
      .delete(`${API}/webhooks/entradas/${integracao.webhook.id}`)
      .expect(204);
    expect(typeform.webhooks.size).toBe(0);
    expect(
      typeform.quais('DELETE', '/forms/abc123/webhooks/')[0].autorizacao,
    ).toMatch(/^Bearer tf-acesso-/);
    await admin.delete(`${CONEXOES}/${conexaoId}`).expect(204);
    await admin.get(`${CONEXOES}/${conexaoId}`).expect(404);
    expect((await auditoria('conexao_aplicativo.excluida')).length).toBe(1);
    // O token pessoal de hoje continua funcionando.
    typeform.acessos.add('tfp_pessoal');
    const comToken = await criarOk(
      'TYPEFORM',
      { formularioId: 'abc123' },
      { credencial: { token: 'tfp_pessoal' } },
    );
    expect(comToken.webhook.id).toBeDefined();
    expect(typeform.webhooks.size).toBe(1);
  });

  // -------------------------------------------------------------------------
  // R32.26 — RD Station por login
  // -------------------------------------------------------------------------

  it('cenário 395 (R32.26, R32.23) — "Entrar com o RD Station": diálogo em /auth/dialog, troca do code em JSON, conta devolvida, retorno em janela e em página; excluir revoga no RD', async () => {
    await admin
      .post(`${CONEXOES}/oauth/iniciar`, { aplicativo: 'RD_STATION' })
      .expect(422);
    await cadastrar('RD_STATION', APP_RD);
    const janela = await conectar('RD_STATION', { modo: 'janela' });
    expect(janela.dialogo.origin).toBe('http://dialogo.rd.teste');
    expect(janela.dialogo.pathname).toBe('/auth/dialog');
    expect(janela.dialogo.searchParams.get('client_id')).toBe(APP_RD.id);
    expect(janela.dialogo.searchParams.has('scope')).toBe(false);
    expect(Object.fromEntries(destino(janela.location).consulta)).toEqual({
      app: 'rd-station',
      resultado: 'conectado',
      conexao: janela.conexaoId,
    });
    const troca = rd.quais('POST', '/auth/token?token_by=code')[0];
    expect(troca.corpo).toMatchObject({
      client_id: APP_RD.id,
      code: janela.code,
    });
    expect(rd.quais('GET', '/marketing/account_info').length).toBe(1);
    const detalhe = (
      await admin.get(`${CONEXOES}/${janela.conexaoId}`).expect(200)
    ).body;
    expect(detalhe).toMatchObject({
      aplicativo: 'RD_STATION',
      conta: 'Escola Demo RD',
      nome: 'RD Station de Escola Demo RD',
      conectada: true,
    });
    const pagina = await conectar('RD_STATION', { modo: 'pagina' });
    expect(Object.fromEntries(destino(pagina.location).consulta)).toEqual({
      'rd-station': 'conectado',
      conexao: pagina.conexaoId,
    });
    // Cancelamento no diálogo do RD.
    const inicio = (
      await admin
        .post(`${CONEXOES}/oauth/iniciar`, {
          aplicativo: 'RD_STATION',
          modo: 'janela',
        })
        .expect(201)
    ).body as { urlDialogo: string };
    const cancelado = await request(t.servidor)
      .get(RETORNO_CONEXOES)
      .query({
        error: 'access_denied',
        state: new URL(inicio.urlDialogo).searchParams.get('state'),
      })
      .expect(302);
    expect(
      Object.fromEntries(destino(cancelado.headers.location).consulta),
    ).toMatchObject({
      app: 'rd-station',
      resultado: 'cancelado',
    });
    // Excluir: tokens apagados e revogação pedida ao RD.
    await admin.delete(`${CONEXOES}/${janela.conexaoId}`).expect(204);
    expect(rd.revogados).toEqual(['refresh_token']);
    expect(rd.quais('POST', '/auth/revoke')[0].autorizacao).toMatch(
      /^Bearer rd-acesso-/,
    );
  });

  it('cenário 396 (R32.26) — integração do RD com conexão: cria o webhook no RD ao ativar, guarda só o id, recria ao mudar gatilho, chave ou endereço, remove ao desativar e ao excluir (404 vale)', async () => {
    await cadastrar('RD_STATION', APP_RD);
    const { conexaoId } = await conectar('RD_STATION');
    (
      await criarIntegracao('RD_STATION', { conexaoId, gatilho: 'OUTRO' })
    ).expect(400);
    (
      await criarIntegracao('RD_STATION', { conexaoId, conversoes: [1] })
    ).expect(400);
    // Inativa: nada é criado no RD.
    const inativa = await criarOk(
      'RD_STATION',
      { conexaoId },
      { ativo: false },
    );
    expect(rd.webhooks.size).toBe(0);
    await admin
      .delete(`${API}/webhooks/entradas/${inativa.webhook.id}`)
      .expect(204);

    const integracao = await criarOk('RD_STATION', {
      conexaoId,
      conversoes: ['newsletter', 'ebook', 'newsletter'],
    });
    const id = integracao.webhook.id;
    expect(rd.webhooks.size).toBe(1);
    const criado = rd.quais('POST', '/integrations/webhooks')[0];
    expect(criado.autorizacao).toMatch(/^Bearer rd-acesso-/);
    expect(criado.corpo).toEqual({
      event_type: 'WEBHOOK.CONVERTED',
      entity_type: 'CONTACT',
      event_identifiers: ['newsletter', 'ebook'],
      url: integracao.url,
      http_method: 'POST',
      include_relations: ['COMPANY', 'CONTACT_FUNNEL'],
    });
    let configuracao = await configuracaoDe(id);
    expect(configuracao.webhookRegistrado).toMatchObject({
      uuid: [...rd.webhooks.keys()][0],
      conexaoId,
      gatilho: 'CONVERSAO',
    });
    // O que fica guardado: o id do RD e uma assinatura; nunca o endereço nem a chave.
    expect(JSON.stringify(configuracao)).not.toContain(
      tokenDaUrl(integracao.url),
    );

    // Desativar remove; ativar cria de novo.
    await admin
      .patch(`${API}/webhooks/entradas/${id}`, { ativo: false })
      .expect(200);
    expect(rd.webhooks.size).toBe(0);
    expect(rd.quais('DELETE', '/integrations/webhooks/').length).toBe(1);
    expect((await configuracaoDe(id)).webhookRegistrado).toBeUndefined();
    await admin
      .patch(`${API}/webhooks/entradas/${id}`, { ativo: true })
      .expect(200);
    expect(rd.webhooks.size).toBe(1);

    // Gatilho Oportunidade: recria, sem conversões.
    await admin
      .patch(`${API}/webhooks/entradas/${id}`, {
        configuracao: { gatilho: 'OPORTUNIDADE' },
      })
      .expect(200);
    expect(rd.webhooks.size).toBe(1);
    expect([...rd.webhooks.values()][0]).toMatchObject({
      event_type: 'WEBHOOK.MARKED_OPPORTUNITY',
    });
    expect([...rd.webhooks.values()][0]).not.toHaveProperty(
      'event_identifiers',
    );

    // Chave de autenticação: vira o cabeçalho do webhook no RD.
    const { segredo } = (
      await admin.post(`${API}/webhooks/entradas/${id}/segredo`, {}).expect(200)
    ).body as { segredo: string };
    expect([...rd.webhooks.values()][0]).toMatchObject({
      auth_header: 'X-RD-Chave',
      auth_key: segredo,
    });
    expect(rd.webhooks.size).toBe(1);
    expect(JSON.stringify(await configuracaoDe(id))).not.toContain(segredo);
    await admin.delete(`${API}/webhooks/entradas/${id}/segredo`).expect(200);
    expect([...rd.webhooks.values()][0]).not.toHaveProperty('auth_key');

    // Endereço novo: o webhook do RD é recriado com ele.
    const novo = (
      await admin
        .post(`${API}/webhooks/entradas/${id}/regenerar-token`)
        .expect(200)
    ).body as { url: string };
    expect(rd.webhooks.size).toBe(1);
    expect([...rd.webhooks.values()][0].url).toBe(novo.url);
    // Mudar algo que não vai ao RD não recria.
    const antes = rd.quais('POST', '/integrations/webhooks').length;
    await admin
      .patch(`${API}/webhooks/entradas/${id}`, { nome: 'Outro nome' })
      .expect(200);
    expect(rd.quais('POST', '/integrations/webhooks').length).toBe(antes);

    // Excluir: remove no RD. Um webhook que já não existe lá (404) vale como removido.
    rd.webhooks.clear();
    await admin.delete(`${API}/webhooks/entradas/${id}`).expect(204);
    const ultimo = rd.quais('DELETE', '/integrations/webhooks/').pop();
    expect(ultimo).toBeDefined();
    const excluida = await t.prisma.webhookEntrada.findUniqueOrThrow({
      where: { id },
    });
    expect(excluida.excluidoEm).not.toBeNull();
    // Sem a integração, a conexão pode ser excluída.
    await admin.delete(`${CONEXOES}/${conexaoId}`).expect(204);
  });

  it('cenário 397 (R32.26) — "buscar campos" lê os campos de contato pelo RD; o corpo que o webhook criado pela API envia (contact, cf_*, company) vira contato e negócio', async () => {
    await cadastrar('RD_STATION', APP_RD);
    const { conexaoId } = await conectar('RD_STATION');
    const integracao = await criarOk('RD_STATION', { conexaoId });
    const id = integracao.webhook.id;
    const { campos } = (
      await admin
        .post(`${API}/webhooks/entradas/${id}/buscar-campos`)
        .expect(200)
    ).body as {
      campos: { caminho: string; rotulo: string; tipo: string | null }[];
    };
    expect(campos).toEqual([
      { caminho: 'name', rotulo: 'Nome', tipo: 'text_input' },
      { caminho: 'company', rotulo: 'Company', tipo: 'text_input' },
      {
        caminho: 'cf_serie_de_interesse',
        rotulo: 'Série de interesse',
        tipo: 'combo_box',
      },
    ]);
    expect(rd.quais('GET', '/platform/contacts/fields')[0].autorizacao).toMatch(
      /^Bearer rd-/,
    );
    // Uma integração manual (sem conexão) não busca campos pela API: 422 claro.
    const manual = (await criarIntegracao('RD_STATION', {})).expect(201);
    await admin
      .post(
        `${API}/webhooks/entradas/${(manual.body as { webhook: { id: string } }).webhook.id}/buscar-campos`,
      )
      .expect(422);
    expect(rd.webhooks.size).toBe(1);

    // O RD envia o formato 2.0 (objeto único com `contact`).
    const corpo = {
      event_type: 'WEBHOOK.CONVERTED',
      entity_type: 'CONTACT',
      event_identifier: 'newsletter',
      timestamp: '2026-11-05T14:09:02.724-03:00',
      event_timestamp: '2026-11-05T14:07:04.254-03:00',
      contact: {
        uuid: 'c2f3d2b3-0000-4000-8000-000000000001',
        email: 'ana.souza@escola.com.br',
        name: 'Ana Souza',
        job_title: 'Diretora',
        personal_phone: '11 98888-7777',
        tags: ['ebook'],
        cf_serie_de_interesse: '8º ano',
        company: { name: 'Colégio Central' },
        funnel: {
          name: 'default',
          lifecycle_stage: 'Lead',
          origin: 'Busca Paga | Google',
        },
      },
    };
    const resposta = await enviarLead(
      t,
      tokenDaUrl(integracao.url),
      corpo,
    ).expect(202);
    expect(resposta.status).toBe(202);
    await drenarFilas(t, FILA_PROCESSAR, { incluirAgendados: true });
    const recebimento = await t.prisma.webhookRecebimento.findFirstOrThrow({
      where: { webhookId: id },
    });
    expect(recebimento.status).toBe('PROCESSADO');
    const contato = await t.prisma.contato.findFirstOrThrow({
      where: { email: 'ana.souza@escola.com.br' },
    });
    expect(contato.nome).toBe('Ana Souza');
    expect(contato.telefone).toBe('5511988887777');
    expect(contato.etiquetas).toEqual(['ebook']);
    expect(contato.camposPersonalizados).toMatchObject({
      serie_de_interesse: '8º ano',
    });
    expect(
      await t.prisma.negocio.count({ where: { contatoId: contato.id } }),
    ).toBe(1);
  });

  it('cenário 398 (R32.26) — o RD recusa criar o webhook (testa o endereço antes): a integração é criada, o erro explica e fica em webhookErro, sem marcar a conexão; sincronizar de novo cria', async () => {
    await cadastrar('RD_STATION', APP_RD);
    const { conexaoId } = await conectar('RD_STATION');
    rd.recusarCriacao = true;
    const integracao = await criarOk('RD_STATION', { conexaoId });
    const id = integracao.webhook.id;
    expect(rd.webhooks.size).toBe(0);
    const configuracao = await configuracaoDe(id);
    expect(configuracao.webhookRegistrado).toBeUndefined();
    expect(configuracao.webhookErro).toMatch(/testa o endereço do CRM/);
    expect(await conexaoDe(conexaoId)).toMatchObject({ precisaAtencao: false });
    expect(
      (await t.prisma.webhookEntrada.findUniqueOrThrow({ where: { id } }))
        .precisaAtencao,
    ).toBe(false);
    rd.recusarCriacao = false;
    const sincronizado = await admin
      .post(`${API}/webhooks/entradas/${id}/sincronizar`)
      .expect(200);
    expect(sincronizado.body).toMatchObject({ registrado: true });
    expect(rd.webhooks.size).toBe(1);
    expect((await configuracaoDe(id)).webhookErro).toBeUndefined();

    // Renovação recusada no RD: a conexão e a integração precisam de atenção.
    rd.recusarRenovacao = true;
    rd.invalidarAcessos();
    await admin
      .post(`${API}/webhooks/entradas/${id}/buscar-campos`)
      .expect(422);
    expect(await conexaoDe(conexaoId)).toMatchObject({ precisaAtencao: true });
    expect((await conexaoDe(conexaoId)).atencaoMotivo).toMatch(
      /conecte o RD Station de novo/,
    );
  });

  it('cenário 400 (R32.26) — sincronizar o RD é uma de cada vez e adota o que o RD já tem: duas sincronizações juntas e uma criação de resposta perdida deixam um só webhook no RD', async () => {
    await cadastrar('RD_STATION', APP_RD);
    const { conexaoId } = await conectar('RD_STATION');
    // Inativa: nada vai ao RD. Depois, duas sincronizações ao mesmo tempo com o RD lento.
    const integracao = await criarOk(
      'RD_STATION',
      { conexaoId },
      { ativo: false },
    );
    const id = integracao.webhook.id;
    await admin
      .patch(`${API}/webhooks/entradas/${id}`, { ativo: true })
      .expect(200);
    expect(rd.webhooks.size).toBe(1);
    await admin
      .patch(`${API}/webhooks/entradas/${id}`, { ativo: false })
      .expect(200);
    expect(rd.webhooks.size).toBe(0);
    // Reativa só no banco (sem sincronizar) e dispara duas sincronizações juntas.
    await t.prisma.webhookEntrada.update({
      where: { id },
      data: { ativo: true },
    });
    rd.pedidos = [];
    rd.atrasoDaCriacaoMs = 300;
    const [a, b] = await Promise.all([
      admin.post(`${API}/webhooks/entradas/${id}/sincronizar`),
      admin.post(`${API}/webhooks/entradas/${id}/sincronizar`),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(rd.webhooks.size).toBe(1);
    expect(rd.quais('POST', '/integrations/webhooks').length).toBe(1);
    expect((await configuracaoDe(id)).webhookErro).toBeUndefined();
    expect((await configuracaoDe(id)).webhookRegistrado).toMatchObject({
      uuid: [...rd.webhooks.keys()][0],
    });

    // O RD cria o webhook mas a resposta se perde: o CRM não sabe o id. Tentar de novo não duplica.
    await admin
      .patch(`${API}/webhooks/entradas/${id}`, { ativo: false })
      .expect(200);
    expect(rd.webhooks.size).toBe(0);
    await t.prisma.webhookEntrada.update({
      where: { id },
      data: { ativo: true },
    });
    rd.atrasoDaCriacaoMs = 0;
    rd.perderRespostaDaCriacao = 1;
    const perdida = await admin
      .post(`${API}/webhooks/entradas/${id}/sincronizar`)
      .expect(200);
    expect(perdida.body).toMatchObject({ registrado: false });
    expect((await configuracaoDe(id)).webhookRegistrado).toBeUndefined();
    expect(rd.webhooks.size).toBe(1);
    const retentativa = await admin
      .post(`${API}/webhooks/entradas/${id}/sincronizar`)
      .expect(200);
    expect(retentativa.body).toMatchObject({ registrado: true });
    expect(rd.webhooks.size).toBe(1);
    expect((await configuracaoDe(id)).webhookRegistrado).toMatchObject({
      uuid: [...rd.webhooks.keys()][0],
    });
    // Um webhook de outro endereço no RD não é tocado.
    rd.webhooks.set('rd-de-outro', {
      url: 'https://outro.exemplo/webhook',
      event_type: 'WEBHOOK.CONVERTED',
    });
    await admin.post(`${API}/webhooks/entradas/${id}/sincronizar`).expect(200);
    expect(rd.webhooks.has('rd-de-outro')).toBe(true);
    expect(rd.webhooks.size).toBe(2);
  });

  it('cenário 401 (R32.25, R32.26) — excluir a integração com o serviço fora do ar deixa a remoção pendente: a conexão não sai (409) até o CRM remover o webhook ou o Admin confirmar; a nova tentativa remove', async () => {
    await cadastrar('RD_STATION', APP_RD);
    await cadastrar('TYPEFORM', APP_TYPEFORM);
    const { conexaoId } = await conectar('RD_STATION');
    const integracao = await criarOk('RD_STATION', { conexaoId });
    const id = integracao.webhook.id;
    expect(rd.webhooks.size).toBe(1);
    const uuid = [...rd.webhooks.keys()][0];

    rd.foraDoAr = true;
    await admin.delete(`${API}/webhooks/entradas/${id}`).expect(204);
    expect(rd.webhooks.size).toBe(1);
    const pendente = await configuracaoDe(id);
    expect(pendente.webhookRemocaoPendente).toBe(true);
    expect(pendente.webhookRegistrado).toMatchObject({ uuid });
    // Com o RD ainda fora do ar, a conexão não pode ser excluída: o 409 diz o que falta.
    const recusada = await admin.delete(`${CONEXOES}/${conexaoId}`).expect(409);
    const corpo = recusada.body as {
      mensagem: string;
      detalhes: { pendencias: { webhookId: string }[] };
    };
    expect(corpo.mensagem).toMatch(/não conseguiu remover do RD Station/);
    expect(corpo.detalhes.pendencias[0].webhookId).toBe(uuid);
    expect((await conexaoDe(conexaoId)).excluidoEm).toBeNull();
    // O RD voltou: a exclusão da conexão refaz a remoção e segue.
    rd.foraDoAr = false;
    await admin.delete(`${CONEXOES}/${conexaoId}`).expect(204);
    expect(rd.webhooks.size).toBe(0);
    const limpa = await configuracaoDe(id);
    expect(limpa.webhookRemocaoPendente).toBeUndefined();
    expect(limpa.webhookRegistrado).toBeUndefined();

    // O Admin pode descartar a pendência: a conexão sai e o CRM para de tentar.
    const outra = await conectar('RD_STATION');
    const segunda = await criarOk('RD_STATION', { conexaoId: outra.conexaoId });
    rd.foraDoAr = true;
    await admin
      .delete(`${API}/webhooks/entradas/${segunda.webhook.id}`)
      .expect(204);
    await admin.delete(`${CONEXOES}/${outra.conexaoId}`).expect(409);
    await admin
      .delete(`${CONEXOES}/${outra.conexaoId}?descartarPendencias=true`)
      .expect(204);
    expect(
      (await configuracaoDe(segunda.webhook.id)).webhookRemocaoPendente,
    ).toBeUndefined();
    rd.foraDoAr = false;

    // O mesmo no Typeform com conexão; a repetição periódica (o job) remove quando o serviço volta.
    const tf = await conectar('TYPEFORM');
    const integracaoTf = await criarOk('TYPEFORM', {
      conexaoId: tf.conexaoId,
      formularioId: 'abc123',
    });
    expect(typeform.webhooks.size).toBe(1);
    typeform.foraDoAr = true;
    await admin
      .delete(`${API}/webhooks/entradas/${integracaoTf.webhook.id}`)
      .expect(204);
    expect(typeform.webhooks.size).toBe(1);
    expect(
      (await configuracaoDe(integracaoTf.webhook.id)).webhookRemocaoPendente,
    ).toBe(true);
    await admin.delete(`${CONEXOES}/${tf.conexaoId}`).expect(409);
    typeform.foraDoAr = false;
    await t.get(AplicativosService).refazerRemocoesPendentes();
    expect(typeform.webhooks.size).toBe(0);
    expect(
      (await configuracaoDe(integracaoTf.webhook.id)).webhookRemocaoPendente,
    ).toBeUndefined();
    await admin.delete(`${CONEXOES}/${tf.conexaoId}`).expect(204);
  });

  it('cenário 402 (R32.22, R32.25) — a renovação do token que termina depois de a conexão mudar não a sobrescreve: a troca do ID do app durante a renovação mantém "precisa de atenção" e sem tokens', async () => {
    await cadastrar('TYPEFORM', APP_TYPEFORM);
    const { conexaoId } = await conectar('TYPEFORM');
    const integracao = await criarOk('TYPEFORM', {
      conexaoId,
      formularioId: 'abc123',
    });
    await t.prisma.conexaoAplicativo.update({
      where: { id: conexaoId },
      data: { expiraEm: new Date(Date.now() - 1000) },
    });
    typeform.atrasoDaRenovacaoMs = 800;
    const lenta = admin.get(
      `${API}/webhooks/entradas/${integracao.webhook.id}/formularios`,
    );
    const resposta = lenta.then((r) => r);
    // Espera a renovação chegar ao Typeform e troca o app das Configurações enquanto ela demora.
    for (
      let i = 0;
      i < 100 && typeform.quais('POST', '/oauth/token').length === 0;
      i++
    ) {
      await new Promise((resolver) => setTimeout(resolver, 20));
    }
    expect(typeform.quais('POST', '/oauth/token').length).toBe(1);
    await admin
      .put(`${APPS}/TYPEFORM`, {
        clientId: 'outro-client',
        segredo: 'novo-segredo-123456',
        confirmarTroca: true,
      })
      .expect(200);
    await resposta;
    const conexao = await conexaoDe(conexaoId);
    expect(conexao.tokensCifrados).toBeNull();
    expect(conexao.precisaAtencao).toBe(true);
    expect(conexao.atencaoMotivo).toMatch(/app de login mudou/i);
  });

  it('cenário 403 (R32.25) — duas chamadas ao mesmo tempo com o token vencido renovam uma só vez (o refresh é de uso único) e as duas dão certo', async () => {
    await cadastrar('TYPEFORM', APP_TYPEFORM);
    const { conexaoId } = await conectar('TYPEFORM');
    const integracao = await criarOk('TYPEFORM', {
      conexaoId,
      formularioId: 'abc123',
    });
    await t.prisma.conexaoAplicativo.update({
      where: { id: conexaoId },
      data: { expiraEm: new Date(Date.now() - 1000) },
    });
    typeform.pedidos = [];
    typeform.atrasoDaRenovacaoMs = 300;
    const [formularios, campos] = await Promise.all([
      admin.get(
        `${API}/webhooks/entradas/${integracao.webhook.id}/formularios`,
      ),
      admin.post(
        `${API}/webhooks/entradas/${integracao.webhook.id}/buscar-campos`,
      ),
    ]);
    expect(formularios.status).toBe(200);
    expect(campos.status).toBe(200);
    expect(typeform.quais('POST', '/oauth/token').length).toBe(1);
    expect(await conexaoDe(conexaoId)).toMatchObject({ precisaAtencao: false });
  });

  // -------------------------------------------------------------------------
  // Acesso
  // -------------------------------------------------------------------------

  it('cenário 399 (R32.22 a R32.26, R2.9) — matriz de acesso: as rotas novas dão 401 sem login e 403 a todo papel que não é Admin; o retorno público de conexões não pede sessão nem origem', async () => {
    const ID = '00000000-0000-4000-8000-000000000000';
    const rotas: readonly (readonly [
      'get' | 'put' | 'post' | 'delete',
      string,
    ])[] = [
      ['get', APPS],
      ['put', `${APPS}/TYPEFORM`],
      ['delete', `${APPS}/TYPEFORM`],
      ['get', CONEXOES],
      ['post', `${CONEXOES}/oauth/iniciar`],
      ['get', `${CONEXOES}/${ID}`],
      ['delete', `${CONEXOES}/${ID}`],
    ];
    const anonimo = clienteAnonimo(t);
    for (const [metodo, caminho] of rotas) {
      await anonimo[metodo](
        caminho,
        metodo === 'get' || metodo === 'delete' ? undefined : {},
      ).expect(401);
    }
    const papeis = PAPEIS_ANTIGOS.filter((p) => p !== 'ADMIN');
    expect(papeis.length).toBeGreaterThanOrEqual(7);
    for (const papel of papeis) {
      const cliente = await entrarComo(t, await criarUsuario(t, { papel }));
      for (const [metodo, caminho] of rotas) {
        await cliente[metodo](
          caminho,
          metodo === 'get' || metodo === 'delete' ? undefined : {},
        ).expect(403);
      }
    }
    // O Admin passa da barreira (200/404/400/422 conforme a rota, nunca 401 nem 403).
    for (const [metodo, caminho] of rotas) {
      const r = await admin[metodo](
        caminho,
        metodo === 'get' || metodo === 'delete' ? undefined : {},
      );
      expect([401, 403]).not.toContain(r.status);
    }
    // O retorno do login não pede sessão nem Origin (é o navegador voltando do serviço).
    const publico = await request(t.servidor).get(RETORNO_CONEXOES).expect(302);
    expect(publico.headers.location).toContain('motivo=state_invalido');
    expect(publico.headers['cache-control']).toBe('no-store');
    expect(publico.headers['referrer-policy']).toBe('no-referrer');
  });
});
