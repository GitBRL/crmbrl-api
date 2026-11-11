import { createHmac } from 'node:crypto';
import type { Usuario } from '../src/generated/prisma/client';
import {
  type AppTeste,
  type ClienteHttp,
  criarAppTeste,
  criarContato,
  criarEquipe,
  criarNegocio,
  criarUsuario,
  drenarFilas,
  entrarComo,
  etapaDoFunilBase,
  funilBase,
  processarEventos,
} from './utils';
import {
  assinaturaEsperada,
  enviarLead,
  FILA_ENTREGAR,
  FILA_PROCESSAR,
  ServidorDeTeste,
  tokenDaUrl,
} from './webhooks-apoio';

const AC_CONTA = 'http://127.0.0.1:9/activecampaign/conta';

/**
 * As APIs de terceiros em processo (R32.8, R32.9): Typeform, ActiveCampaign e
 * ManyChat falsos, no lugar do `fetch`. Qualquer outro endereço (o destino dos
 * webhooks de saída, local) passa para o `fetch` de verdade.
 */
class AplicativosFalsos {
  formularios = [
    {
      id: 'lT9uwa',
      title: 'Contato do site',
      last_updated_at: '2026-11-01T10:00:00Z',
      _links: { display: 'https://x.typeform.com/to/lT9uwa' },
    },
    {
      id: 'abc123',
      title: 'Inscrição',
      last_updated_at: '2026-11-02T10:00:00Z',
      _links: { display: 'https://x.typeform.com/to/abc123' },
    },
  ];
  webhooks = new Map<
    string,
    { url: string; secret: string; enabled: boolean }
  >();
  chamadas: { metodo: string; url: string }[] = [];
  private espiao?: jest.SpyInstance;
  private readonly original = globalThis.fetch;

  instalar(): void {
    this.espiao = jest.spyOn(globalThis, 'fetch').mockImplementation((async (
      entrada: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url =
        typeof entrada === 'string'
          ? entrada
          : entrada instanceof URL
            ? entrada.href
            : entrada.url;
      const metodo = init?.method ?? 'GET';
      if (
        !url.startsWith('https://typeform.teste') &&
        !url.startsWith('https://manychat.teste') &&
        !url.startsWith(AC_CONTA)
      ) {
        return this.original(entrada, init);
      }
      this.chamadas.push({ metodo, url });
      const cabecalhos = (init?.headers ?? {}) as Record<string, string>;
      return this.responder(
        url,
        metodo,
        cabecalhos,
        init?.body as string | undefined,
      );
    }) as typeof fetch);
  }

  desinstalar(): void {
    this.espiao?.mockRestore();
  }

  limpar(): void {
    this.chamadas = [];
    this.webhooks.clear();
  }

  private json(status: number, corpo?: unknown): Response {
    return new Response(corpo === undefined ? null : JSON.stringify(corpo), {
      status,
    });
  }

  private responder(
    url: string,
    metodo: string,
    cabecalhos: Record<string, string>,
    corpo?: string,
  ): Response {
    if (url.startsWith('https://typeform.teste')) {
      if (cabecalhos.Authorization !== 'Bearer tf-valido') {
        return this.json(401, { code: 'AUTHENTICATION_FAILED' });
      }
      const caminho = url.replace('https://typeform.teste', '');
      if (metodo === 'GET' && caminho.startsWith('/forms?')) {
        return this.json(200, {
          total_items: this.formularios.length,
          page_count: 1,
          items: this.formularios,
        });
      }
      const detalhe = /^\/forms\/([^/]+)$/.exec(caminho);
      if (metodo === 'GET' && detalhe) {
        return this.json(200, {
          id: detalhe[1],
          title: 'Formulário',
          hidden: ['utm_source'],
          variables: { etapa: '' },
          fields: [
            {
              id: 'a',
              ref: 'nome_completo',
              title: 'Qual é o seu nome?',
              type: 'short_text',
            },
            { id: 'b', ref: 'email_contato', title: 'E-mail', type: 'email' },
          ],
        });
      }
      const hook = /^\/forms\/([^/]+)\/webhooks\/([^/]+)$/.exec(caminho);
      if (hook) {
        const chave = `${hook[1]}/${hook[2]}`;
        if (metodo === 'PUT') {
          const dados = JSON.parse(corpo ?? '{}') as {
            url: string;
            secret: string;
            enabled: boolean;
          };
          this.webhooks.set(chave, dados);
          return this.json(200, { id: hook[2], ...dados });
        }
        if (metodo === 'DELETE') {
          return this.webhooks.delete(chave) ? this.json(204) : this.json(404);
        }
      }
      return this.json(404);
    }
    if (url.startsWith('https://manychat.teste')) {
      if (cabecalhos.Authorization !== 'Bearer mc-valida') {
        return this.json(401, { status: 'error' });
      }
      return this.json(200, {
        status: 'success',
        data: [
          { id: 1, name: 'cidade', type: 'text' },
          { id: 2, name: 'renda', type: 'number' },
        ],
      });
    }
    // ActiveCampaign
    if (cabecalhos['Api-Token'] !== 'ac-valida') {
      return this.json(403, {
        message: 'The access token you provided is invalid.',
      });
    }
    return this.json(200, {
      fields: [
        { id: '3', title: 'Cidade', type: 'text' },
        { id: '12', title: 'Dono do negócio', type: 'text' },
        { id: '13', title: 'etapa_funil', type: 'text' },
      ],
      meta: { total: '3' },
    });
  }
}

interface IntegracaoCriada {
  id: string;
  url: string;
  token: string;
}

interface RecebimentoLido {
  id: string;
  status: string;
  mensagem: string | null;
  avisos: string[];
  itens: {
    indice: number;
    rotulo: string | null;
    status: string;
    mensagem: string;
  }[];
  contato: { id: string; nome: string } | null;
  negocio: { id: string; titulo: string } | null;
}

const FORM = 'application/x-www-form-urlencoded';

describe('Integrações por aplicativo (e2e, R32)', () => {
  let t: AppTeste;
  let adminUsuario: Usuario;
  let admin: ClienteHttp;
  const apps = new AplicativosFalsos();
  const destino = new ServidorDeTeste();

  beforeAll(async () => {
    await destino.iniciar();
    apps.instalar();
    t = await criarAppTeste({
      variaveis: {
        WEBHOOKS_PERMITIR_REDE_INTERNA: 'true',
        TYPEFORM_API_URL: 'https://typeform.teste',
        MANYCHAT_API_URL: 'https://manychat.teste',
      },
    });
  });

  beforeEach(async () => {
    await t.limparBanco();
    apps.limpar();
    destino.limpar();
    adminUsuario = await criarUsuario(t, { papel: 'ADMIN', nome: 'Admin' });
    admin = await entrarComo(t, adminUsuario);
  });

  afterAll(async () => {
    apps.desinstalar();
    await t.fechar();
    await destino.parar();
  });

  const processar = () =>
    drenarFilas(t, FILA_PROCESSAR, { incluirAgendados: true });

  /** Cria a integração no funil Comercial (etapa "Novo") e devolve o endereço. */
  const criar = async (
    corpo: Record<string, unknown>,
  ): Promise<IntegracaoCriada> => {
    const comercial = await funilBase(t, 'COMERCIAL');
    const resposta = await admin
      .post('/api/v1/webhooks/entradas', {
        nome: `Integração ${Math.random().toString(36).slice(2, 8)}`,
        funilId: comercial.id,
        etapaId: comercial.etapas[0].id,
        ...corpo,
      })
      .expect(201);
    const body = resposta.body as { webhook: { id: string }; url: string };
    return { id: body.webhook.id, url: body.url, token: tokenDaUrl(body.url) };
  };

  /** Envia um corpo e processa a fila. Devolve o recebimento já lido pela API. */
  const enviar = async (
    integracao: IntegracaoCriada,
    corpo: string | object,
    cabecalhos: Record<string, string> = {},
    status = 202,
  ): Promise<RecebimentoLido | null> => {
    const resposta = await enviarLead(
      t,
      integracao.token,
      corpo,
      cabecalhos,
    ).expect(status);
    if (status !== 202) {
      return null;
    }
    await processar();
    const { id } = resposta.body as { id: string };
    return (await admin.get(`/api/v1/webhooks/recebimentos/${id}`).expect(200))
      .body as RecebimentoLido;
  };

  /** Os negócios do contato no funil Comercial (o ganho passa um para o CS, R5.7). */
  const negociosDe = (contatoEmail: string) =>
    t.prisma.negocio.findMany({
      where: {
        contato: { email: contatoEmail },
        funil: { area: 'COMERCIAL' },
      },
      include: { etapa: true, responsavel: true },
      orderBy: { criadoEm: 'asc' },
    });

  const mapeamento = (
    campos: [string, string][],
    extra: Record<string, unknown> = {},
  ) => ({
    modeloMapeamento: 'PERSONALIZADO',
    mapeamento: {
      campos: campos.map(([caminho, destino]) => ({ caminho, destino })),
    },
    ...extra,
  });

  // -------------------------------------------------------------------------
  // Catálogo e compatibilidade
  // -------------------------------------------------------------------------

  it('cenário 316 (R32.1) — o catálogo traz os 12 aplicativos em ordem alfabética, só o Admin vê, e os da H2 não se criam', async () => {
    const catalogo = (
      await admin.get('/api/v1/webhooks/aplicativos').expect(200)
    ).body as {
      aplicativos: {
        aplicativo: string;
        nome: string;
        disponivel: boolean;
        credencial: unknown[] | null;
        passoAPasso: { passos: string[] };
      }[];
      destinos: { destino: string }[];
    };
    expect(catalogo.aplicativos.map(({ nome }) => nome)).toEqual([
      'ActiveCampaign',
      'Eduzz',
      'Elementor',
      'Facebook Lead Ads',
      'Great Pages',
      'Hotmart',
      'Kiwify',
      'Lead Lovers',
      'ManyChat',
      'RD Station',
      'Typeform',
      'Webhook',
    ]);
    const typeform = catalogo.aplicativos.find(
      ({ aplicativo }) => aplicativo === 'TYPEFORM',
    );
    expect(typeform?.credencial).toHaveLength(1);
    expect(typeform?.passoAPasso.passos.length).toBeGreaterThan(2);
    expect(catalogo.destinos.map(({ destino }) => destino)).toEqual(
      expect.arrayContaining(['etapa', 'dono', 'status', 'motivoPerda']),
    );
    const { membros } = await criarEquipe(t, 'COMERCIAL', { membros: 1 });
    await (
      await entrarComo(t, membros[0])
    )
      .get('/api/v1/webhooks/aplicativos')
      .expect(403);
    // Hotmart, Kiwify e Eduzz chegaram na H2 (R32.15, cenários 360 a 379 em integracoes-cursos).
    for (const aplicativo of ['HOTMART', 'KIWIFY', 'EDUZZ']) {
      expect(
        catalogo.aplicativos.find((a) => a.aplicativo === aplicativo)
          ?.disponivel,
      ).toBe(true);
    }
  });

  it('cenário 317 (R32.2, R8.5) — o webhook sem aplicativo continua igual: Webhook, negócio, criar ou atualizar e reconversão no mesmo endereço', async () => {
    const integracao = await criar({});
    const dto = (
      await admin.get(`/api/v1/webhooks/entradas/${integracao.id}`).expect(200)
    ).body as Record<string, unknown>;
    expect(dto).toMatchObject({
      aplicativo: 'WEBHOOK',
      alvo: 'NEGOCIO',
      modo: 'CRIAR_OU_ATUALIZAR',
      statusInicial: 'ABERTO',
      modeloMapeamento: 'GENERICO',
      situacao: 'ATIVA',
      precisaAtencao: false,
      enderecoDisponivel: true,
    });
    const primeiro = await enviar(integracao, {
      name: 'Ana Lima',
      email: 'ana@x.com',
      phone: '11987654321',
    });
    expect(primeiro).toMatchObject({
      status: 'PROCESSADO',
      mensagem: expect.stringMatching(
        /^Contato "Ana Lima" criado; negócio criado em Comercial \/ Novo/,
      ) as string,
    });
    const segundo = await enviar(integracao, {
      name: 'Ana Lima',
      email: 'ana@x.com',
    });
    expect(segundo?.mensagem).toMatch(
      /reconvertido \(já existia\); reconversão registrada no negócio aberto "Ana Lima"/,
    );
    expect(await negociosDe('ana@x.com')).toHaveLength(1);
    // O endereço completo reabre para o assistente (só o Admin).
    const endereco = (
      await admin
        .get(`/api/v1/webhooks/entradas/${integracao.id}/endereco`)
        .expect(200)
    ).body as { url: string };
    expect(endereco.url).toBe(integracao.url);
  });

  // -------------------------------------------------------------------------
  // Aplicativos por webhook
  // -------------------------------------------------------------------------

  it('cenário 318 (R32.2) — Elementor com Advanced Data (formulário aninhado) cria o negócio, com UTMs; sem Advanced Data e em JSON também', async () => {
    const integracao = await criar({
      aplicativo: 'ELEMENTOR',
      etiquetasFixas: ['Site'],
    });
    const aninhado =
      'form[id]=3f8a1c2&form[name]=Contato' +
      '&fields[name][id]=name&fields[name][value]=Maria+Souza' +
      '&fields[email][id]=email&fields[email][value]=maria%40empresa.com.br' +
      '&fields[field_phone][value]=%2811%29+98765-4321' +
      '&fields[utm_source][value]=google&fields[utm_campaign][value]=black-friday';
    // O modelo do Elementor lê name/email/phone; o telefone aqui vem em outro ID, ainda sem mapear.
    const recebimento = await enviar(integracao, aninhado, {
      'Content-Type': FORM,
    });
    expect(recebimento?.status).toBe('PROCESSADO');
    const [negocio] = await negociosDe('maria@empresa.com.br');
    expect(negocio).toMatchObject({
      titulo: 'Maria Souza',
      utm: { source: 'google', campaign: 'black-friday' },
    });
    const contato = await t.prisma.contato.findFirstOrThrow({
      where: { email: 'maria@empresa.com.br' },
    });
    expect(contato.etiquetas).toEqual(['Site']);
    // Sem Advanced Data (chaves simples).
    const simples = await enviar(
      integracao,
      'name=Joao&email=joao%40x.com&phone=11999998888&utm_medium=cpc',
      { 'Content-Type': FORM },
    );
    expect(simples?.status).toBe('PROCESSADO');
    expect((await negociosDe('joao@x.com'))[0].utm).toEqual({ medium: 'cpc' });
    // JSON com fields[id].value.
    const json = await enviar(integracao, {
      form: { id: 'f', name: 'X' },
      fields: { name: { value: 'Ana' }, email: { value: 'ana@x.com' } },
    });
    expect(json?.status).toBe('PROCESSADO');
    // O corpo guardado mantém a estrutura recebida.
    const detalhe = (
      await admin
        .get(`/api/v1/webhooks/recebimentos/${recebimento?.id}`)
        .expect(200)
    ).body as { corpo: { fields: { email: { value: string } } } };
    expect(detalhe.corpo.fields.email.value).toBe('maria@empresa.com.br');
  });

  it('cenário 319 (R32.6) — RD Station com {"leads":[…]}: cada lead é processado, o resultado fica por lead e o reprocessamento refaz só o que falhou', async () => {
    const integracao = await criar({ aplicativo: 'RD_STATION' });
    const lead = (
      nome: string,
      email: string | null,
      fone = '11987654321',
    ) => ({
      name: nome,
      email,
      mobile_phone: fone,
      tags: ['ebook'],
      custom_fields: { nome_escola: 'Colégio Central' },
      last_conversion: {
        conversion_origin: { source: 'google', medium: 'cpc' },
      },
    });
    const corpo = {
      entity_type: 'WEBHOOK.CONVERTED',
      leads: [
        lead('Ana', 'ana@x.com'),
        lead('Beto', 'beto@x.com', '11987650002'),
        {
          ...lead('Caio', null),
          mobile_phone: null,
          personal_phone: null,
          email_secundario: 'caio@x.com',
        },
      ],
    };
    const recebimento = await enviar(integracao, corpo);
    expect(recebimento?.status).toBe('ERRO');
    expect(recebimento?.mensagem).toMatch(
      /^3 itens: 2 processado\(s\), 1 com erro\. lead 3 de 3: Sem e-mail nem telefone/,
    );
    expect(
      recebimento?.itens.map(({ status, rotulo }) => [rotulo, status]),
    ).toEqual([
      ['lead 1 de 3', 'PROCESSADO'],
      ['lead 2 de 3', 'PROCESSADO'],
      ['lead 3 de 3', 'ERRO'],
    ]);
    expect(await t.prisma.negocio.count()).toBe(2);
    const ana = await t.prisma.contato.findFirstOrThrow({
      where: { email: 'ana@x.com' },
    });
    expect(ana.camposPersonalizados).toEqual({
      nome_escola: 'Colégio Central',
    });
    expect(ana.etiquetas).toEqual(['ebook']);
    expect((await negociosDe('ana@x.com'))[0].utm).toEqual({
      source: 'google',
      medium: 'cpc',
    });

    // O Admin ajusta o mapeamento e reprocessa: só o lead 3 é refeito (nenhuma reconversão a mais).
    await admin
      .patch(
        `/api/v1/webhooks/entradas/${integracao.id}`,
        mapeamento([
          ['name', 'nome'],
          ['email', 'email'],
          ['email_secundario', 'email'],
        ]),
      )
      .expect(200);
    await admin
      .post(`/api/v1/webhooks/recebimentos/${recebimento?.id}/reprocessar`)
      .expect(202);
    await processar();
    const depois = (
      await admin
        .get(`/api/v1/webhooks/recebimentos/${recebimento?.id}`)
        .expect(200)
    ).body as RecebimentoLido;
    expect(depois.status).toBe('PROCESSADO');
    expect(depois.itens.map(({ status }) => status)).toEqual([
      'PROCESSADO',
      'PROCESSADO',
      'PROCESSADO',
    ]);
    expect(await t.prisma.negocio.count()).toBe(3);
    expect(
      await t.prisma.negocio.aggregate({ _sum: { reconversoes: true } }),
    ).toMatchObject({ _sum: { reconversoes: 0 } });
  });

  it('cenário 320 (R32.9) — RD Station com chave no cabeçalho: sem a chave 401, com a chave 202, e o cabeçalho da chave não fica guardado', async () => {
    const integracao = await criar({
      aplicativo: 'RD_STATION',
      segredo: 'chave-do-rd-123456',
      configuracao: { cabecalhoDeAutenticacao: 'X-Minha-Chave' },
    });
    const corpo = { name: 'Ana', email: 'ana@x.com' };
    await enviarLead(t, integracao.token, corpo).expect(401);
    await enviarLead(t, integracao.token, corpo, {
      'X-Minha-Chave': 'errada',
    }).expect(401);
    const resposta = await enviarLead(t, integracao.token, corpo, {
      'X-Minha-Chave': 'chave-do-rd-123456',
    }).expect(202);
    await processar();
    const guardado = await t.prisma.webhookRecebimento.findUniqueOrThrow({
      where: { id: (resposta.body as { id: string }).id },
    });
    expect(guardado.status).toBe('PROCESSADO');
    expect(guardado.cabecalhos).not.toHaveProperty('x-minha-chave');
    // Os dois recusados ficaram registrados como erro, sem reprocessamento.
    expect(
      await t.prisma.webhookRecebimento.count({
        where: { status: 'ERRO', tentativas: 0 },
      }),
    ).toBe(2);
  });

  it('cenário 321 (R32.2, R32.8) — ActiveCampaign: form-urlencoded contact[...] cria o negócio e "Buscar campos" dá nome aos contact[fields][<id>]', async () => {
    const integracao = await criar({
      aplicativo: 'ACTIVE_CAMPAIGN',
      credencial: { urlConta: `${AC_CONTA}/`, chaveApi: 'ac-valida' },
    });
    const dto = (
      await admin.get(`/api/v1/webhooks/entradas/${integracao.id}`).expect(200)
    ).body as {
      credencial: {
        configurada: boolean;
        campos: { chave: string; valor: string }[];
      };
    };
    // A credencial nunca volta inteira: a URL aparece, a chave só mascarada.
    expect(dto.credencial.campos).toEqual([
      expect.objectContaining({ chave: 'urlConta', valor: AC_CONTA }),
      expect.objectContaining({
        chave: 'chaveApi',
        secreto: true,
        valor: '••••••••lida',
      }),
    ]);
    expect(JSON.stringify(dto)).not.toContain('ac-valida');
    const campos = (
      await admin
        .post(`/api/v1/webhooks/entradas/${integracao.id}/buscar-campos`)
        .expect(200)
    ).body as { campos: { caminho: string; rotulo: string }[] };
    expect(campos.campos).toEqual(
      expect.arrayContaining([
        { caminho: 'contact.fields.3', rotulo: 'Cidade', tipo: 'text' },
        {
          caminho: 'contact.fields.12',
          rotulo: 'Dono do negócio',
          tipo: 'text',
        },
      ]),
    );
    const detalhe = (
      await admin.get(`/api/v1/webhooks/entradas/${integracao.id}`).expect(200)
    ).body as {
      camposBuscados: { caminho: string }[];
      camposBuscadosEm: string;
    };
    expect(detalhe.camposBuscados.map(({ caminho }) => caminho)).toContain(
      'contact.fields.3',
    );
    expect(apps.chamadas[0].url).toBe(
      `${AC_CONTA}/api/3/fields?limit=100&offset=0`,
    );

    const corpo =
      'type=automation&contact[id]=17&contact[email]=maria%40empresa.com.br&contact[first_name]=Maria&contact[last_name]=Souza' +
      '&contact[phone]=11987654321&contact[orgname]=Empresa+Ltda&contact[tags]=lead-quente%2Cwebinar&contact[fields][3]=Natal';
    const recebimento = await enviar(integracao, corpo, {
      'Content-Type': FORM,
    });
    expect(recebimento?.status).toBe('PROCESSADO');
    const [negocio] = await negociosDe('maria@empresa.com.br');
    expect(negocio.titulo).toBe('Maria Souza');
    expect(
      (
        await t.prisma.contato.findFirstOrThrow({
          where: { email: 'maria@empresa.com.br' },
        })
      ).etiquetas,
    ).toEqual(['lead-quente', 'webinar']);
    // Os campos recebidos mostram os caminhos, com exemplos mascarados.
    const recebidos = (
      await admin
        .get(`/api/v1/webhooks/entradas/${integracao.id}/campos-recebidos`)
        .expect(200)
    ).body as {
      campos: { caminho: string; exemplo: string | null }[];
      recebimentosLidos: number;
    };
    expect(recebidos.recebimentosLidos).toBe(1);
    expect(recebidos.campos).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          caminho: 'contact.email',
          exemplo: 'ma•••@empresa.com.br',
        }),
        expect.objectContaining({ caminho: 'contact.fields.3' }),
      ]),
    );
    expect(JSON.stringify(recebidos)).not.toContain('maria@empresa.com.br');
    expect(JSON.stringify(recebidos)).not.toContain('11987654321');
  });

  it('cenário 322 (R32.9) — credencial inválida: a integração fica "precisa de atenção", o Admin é avisado uma vez, e trocar a credencial resolve', async () => {
    const integracao = await criar({
      aplicativo: 'ACTIVE_CAMPAIGN',
      credencial: { urlConta: AC_CONTA, chaveApi: 'ac-invalida' },
    });
    const teste = (
      await admin
        .post(`/api/v1/webhooks/entradas/${integracao.id}/testar-credencial`)
        .expect(200)
    ).body as { valida: boolean; mensagem: string };
    expect(teste.valida).toBe(false);
    expect(teste.mensagem).toMatch(/recusou a credencial \(HTTP 403\)/);
    const marcada = (
      await admin.get(`/api/v1/webhooks/entradas/${integracao.id}`).expect(200)
    ).body as {
      situacao: string;
      precisaAtencao: boolean;
      atencaoMotivo: string;
    };
    expect(marcada).toMatchObject({
      situacao: 'PRECISA_ATENCAO',
      precisaAtencao: true,
    });
    // Buscar campos com a chave ruim: 422, sem nova notificação.
    await admin
      .post(`/api/v1/webhooks/entradas/${integracao.id}/buscar-campos`)
      .expect(422);
    const avisos = await t.prisma.notificacao.findMany({
      where: { tipo: 'integracao.precisa_atencao' },
    });
    expect(avisos).toHaveLength(1);
    expect(avisos[0]).toMatchObject({
      usuarioId: adminUsuario.id,
      titulo: expect.stringContaining('precisa de atenção') as string,
    });
    expect(JSON.stringify(avisos[0])).not.toContain('ac-invalida');
    // A lista filtra pelas que precisam de atenção.
    const lista = (
      await admin
        .get('/api/v1/webhooks/entradas?precisaAtencao=true')
        .expect(200)
    ).body as { itens: { id: string }[] };
    expect(lista.itens.map(({ id }) => id)).toEqual([integracao.id]);
    // Credencial nova: a situação recomeça e o teste passa.
    await admin
      .patch(`/api/v1/webhooks/entradas/${integracao.id}`, {
        credencial: { chaveApi: 'ac-valida' },
      })
      .expect(200);
    const resolvida = (
      await admin
        .post(`/api/v1/webhooks/entradas/${integracao.id}/testar-credencial`)
        .expect(200)
    ).body as { valida: boolean };
    expect(resolvida.valida).toBe(true);
    expect(
      (
        (
          await admin
            .get(`/api/v1/webhooks/entradas/${integracao.id}`)
            .expect(200)
        ).body as { situacao: string }
      ).situacao,
    ).toBe('ATIVA');
    // Credencial ausente ou campo desconhecido: 400.
    await admin
      .post('/api/v1/webhooks/entradas', {
        nome: 'sem credencial',
        aplicativo: 'MANYCHAT',
      })
      .expect(400);
    await admin
      .patch(`/api/v1/webhooks/entradas/${integracao.id}`, {
        credencial: { lixo: 'x' },
      })
      .expect(400);
  });

  it('R32.8, R10.3 — trocar a URL da conta exige a chave no mesmo envio: a chave guardada não vai para outro destino', async () => {
    const integracao = await criar({
      aplicativo: 'ACTIVE_CAMPAIGN',
      credencial: { urlConta: AC_CONTA, chaveApi: 'ac-valida' },
    });
    const antes = await t.prisma.webhookEntrada.findUniqueOrThrow({
      where: { id: integracao.id },
      select: { credencialCifrada: true },
    });
    const recusa = (
      await admin
        .patch(`/api/v1/webhooks/entradas/${integracao.id}`, {
          credencial: { urlConta: 'https://coletor.exemplo.org' },
        })
        .expect(400)
    ).body as { mensagem: string };
    expect(recusa.mensagem).toMatch(/Chave da API/);
    const depois = await t.prisma.webhookEntrada.findUniqueOrThrow({
      where: { id: integracao.id },
      select: { credencialCifrada: true },
    });
    expect(depois.credencialCifrada).toBe(antes.credencialCifrada);
    // Com a chave nova no mesmo envio, a troca vale; só a chave também vale.
    await admin
      .patch(`/api/v1/webhooks/entradas/${integracao.id}`, {
        credencial: { urlConta: AC_CONTA, chaveApi: 'ac-valida' },
      })
      .expect(200);
  });

  it('R4.6 — a exportação de dados pessoais traz os recebimentos de webhook do titular (corpo, IP e integração)', async () => {
    const integracao = await criar({ aplicativo: 'RD_STATION' });
    await enviar(integracao, {
      leads: [
        { name: 'Ana Titular', email: 'ana.titular@x.com', cf_cpf: '123' },
        { name: 'Beto Outro', email: 'beto.outro@x.com' },
      ],
    });
    const ana = await t.prisma.contato.findFirstOrThrow({
      where: { email: 'ana.titular@x.com' },
    });
    const exportado = (
      await admin.get(`/api/v1/contatos/${ana.id}/dados-pessoais`).expect(200)
    ).body as {
      recebimentosDeWebhook: {
        corpo: { leads: { email: string }[] };
        integracao: { aplicativo: string };
      }[];
    };
    expect(exportado.recebimentosDeWebhook).toHaveLength(1);
    expect(exportado.recebimentosDeWebhook[0].integracao.aplicativo).toBe(
      'RD_STATION',
    );
    expect(exportado.recebimentosDeWebhook[0].corpo.leads[0].email).toBe(
      'ana.titular@x.com',
    );
  });

  it('R32.2 — RD Station: o recebimento processa no máximo 100 leads e registra os excedentes como ignorados', async () => {
    const integracao = await criar({ aplicativo: 'RD_STATION' });
    const leads = Array.from({ length: 103 }, (_, i) => ({
      name: `Lead ${i + 1}`,
      email: `lead${i + 1}@x.com`,
    }));
    const recebimento = await enviar(integracao, { leads });
    expect(await t.prisma.contato.count()).toBe(100);
    expect(recebimento?.itens).toHaveLength(101);
    expect(recebimento?.itens[100]).toMatchObject({
      status: 'IGNORADO',
      rotulo: 'excedentes',
    });
    expect(recebimento?.itens[100].mensagem).toMatch(
      /3 item\(ns\) além do limite de 100/,
    );
  });

  it('cenário 323 (R32.8) — testar credencial antes de criar: o aplicativo aceita ou recusa, sem gravar nada', async () => {
    const ruim = (
      await admin
        .post('/api/v1/webhooks/entradas/testar-credencial', {
          aplicativo: 'MANYCHAT',
          credencial: { chaveApi: 'mc-invalida' },
        })
        .expect(200)
    ).body as { valida: boolean };
    expect(ruim.valida).toBe(false);
    const boa = (
      await admin
        .post('/api/v1/webhooks/entradas/testar-credencial', {
          aplicativo: 'MANYCHAT',
          credencial: { chaveApi: 'mc-valida' },
        })
        .expect(200)
    ).body as { valida: boolean };
    expect(boa.valida).toBe(true);
    expect(await t.prisma.webhookEntrada.count()).toBe(0);
    expect(await t.prisma.notificacao.count()).toBe(0);
  });

  it('cenário 324 (R32.2) — Great Pages e Lead Lovers com mapeamento digitado: formulário ou JSON criam o negócio', async () => {
    const great = await criar({ aplicativo: 'GREAT_PAGES' });
    expect(
      (
        await enviar(
          great,
          'nome=Ana+Lima&email=ana%40x.com&telefone=11987654321&utm_source=facebook',
          { 'Content-Type': FORM },
        )
      )?.status,
    ).toBe('PROCESSADO');
    expect((await negociosDe('ana@x.com'))[0].utm).toEqual({
      source: 'facebook',
    });
    const lead = await criar({
      aplicativo: 'LEAD_LOVERS',
      ...mapeamento([
        ['Nome do Lead', 'nome'],
        ['E-mail do Lead', 'email'],
        ['Tags', 'etiquetas'],
      ]),
    });
    expect(
      (
        await enviar(lead, {
          'Nome do Lead': 'Beto',
          'E-mail do Lead': 'beto@x.com',
          Tags: 'lead-quente',
        })
      )?.status,
    ).toBe('PROCESSADO');
    expect(
      (
        await t.prisma.contato.findFirstOrThrow({
          where: { email: 'beto@x.com' },
        })
      ).etiquetas,
    ).toEqual(['lead-quente']);
    // Modelo do aplicativo não vale no mapeamento de outro: GENERICO só no Webhook.
    await admin
      .post('/api/v1/webhooks/entradas', {
        nome: 'x',
        aplicativo: 'GREAT_PAGES',
        modeloMapeamento: 'GENERICO',
      })
      .expect(400);
  });

  it('cenário 325 (R32.2) — ManyChat: Full Contact Data cria o negócio com custom_fields e tags; contato do Instagram sem e-mail e telefone dá erro claro', async () => {
    const integracao = await criar({
      aplicativo: 'MANYCHAT',
      credencial: { chaveApi: 'mc-valida' },
    });
    const completo = {
      id: '4812345678',
      first_name: 'Maria',
      last_name: 'Souza',
      name: 'Maria Souza',
      email: 'maria@empresa.com.br',
      phone: '+5511987654321',
      ig_username: 'maria.souza',
      tags: [{ id: 1, name: 'lead-quente' }],
      custom_fields: [
        { id: 10, name: 'cidade', type: 'text', value: 'São Paulo' },
      ],
    };
    expect((await enviar(integracao, completo))?.status).toBe('PROCESSADO');
    const contato = await t.prisma.contato.findFirstOrThrow({
      where: { email: 'maria@empresa.com.br' },
    });
    expect(contato).toMatchObject({
      etiquetas: ['lead-quente'],
      camposPersonalizados: { cidade: 'São Paulo' },
    });
    const instagram = await enviar(integracao, {
      id: '99',
      name: 'Joana',
      ig_username: 'joana.ig',
    });
    expect(instagram).toMatchObject({ status: 'ERRO' });
    expect(instagram?.mensagem).toMatch(/colete e-mail ou telefone no fluxo/);
    // "Buscar campos" lê os campos personalizados do ManyChat.
    const campos = (
      await admin
        .post(`/api/v1/webhooks/entradas/${integracao.id}/buscar-campos`)
        .expect(200)
    ).body as { campos: { caminho: string }[] };
    expect(campos.campos.map(({ caminho }) => caminho)).toEqual(
      expect.arrayContaining(['custom_fields.cidade', 'custom_fields.renda']),
    );
  });

  // -------------------------------------------------------------------------
  // Typeform
  // -------------------------------------------------------------------------

  const respostaDoTypeform = (
    nome: string,
    email: string,
    extra: Record<string, unknown> = {},
  ) => ({
    event_id: `evt-${email}`,
    event_type: 'form_response',
    form_response: {
      form_id: 'lT9uwa',
      token: 'abc',
      submitted_at: '2026-11-04T12:01:00Z',
      hidden: { utm_source: 'instagram' },
      definition: {
        id: 'lT9uwa',
        title: 'Contato',
        fields: [
          {
            id: 'a',
            title: 'Qual é o seu nome?',
            type: 'short_text',
            ref: 'nome_completo',
          },
        ],
      },
      answers: [
        {
          type: 'text',
          text: nome,
          field: { id: 'a', type: 'short_text', ref: 'nome_completo' },
        },
        {
          type: 'email',
          email,
          field: { id: 'b', type: 'email', ref: 'email_contato' },
        },
      ],
      ...extra,
    },
  });

  const assinar = (segredo: string, corpo: string) =>
    `sha256=${createHmac('sha256', segredo).update(corpo).digest('base64')}`;

  it('cenário 326 (R32.9, R32.10) — Typeform: o CRM registra o webhook no formulário com segredo; resposta assinada cria o negócio; assinatura inválida ou ausente é recusada', async () => {
    const integracao = await criar({
      aplicativo: 'TYPEFORM',
      credencial: { token: 'tf-valido' },
      configuracao: { formularioId: 'lT9uwa' },
    });
    // PUT /forms/{id}/webhooks/{tag}, com o endereço, o segredo e enabled.
    expect(apps.webhooks.size).toBe(1);
    const [[chave, registrado]] = [...apps.webhooks.entries()];
    expect(chave).toMatch(/^lT9uwa\/crmbrl-/);
    expect(registrado).toMatchObject({ url: integracao.url, enabled: true });
    expect(registrado.secret.length).toBeGreaterThan(20);
    const dto = (
      await admin.get(`/api/v1/webhooks/entradas/${integracao.id}`).expect(200)
    ).body as {
      exigeAssinatura: boolean;
      configuracao: {
        formularioId: string;
        webhookRegistrado: { formularioId: string };
      };
      segredoMascarado: string;
    };
    expect(dto).toMatchObject({
      exigeAssinatura: true,
      configuracao: {
        formularioId: 'lT9uwa',
        webhookRegistrado: { formularioId: 'lT9uwa' },
      },
    });
    expect(JSON.stringify(dto)).not.toContain(registrado.secret);

    const corpo = JSON.stringify(
      respostaDoTypeform('Maria Souza', 'maria@empresa.com.br'),
    );
    const ok = await enviar(integracao, corpo, {
      'Typeform-Signature': assinar(registrado.secret, corpo),
      'Content-Type': 'application/json',
    });
    expect(ok?.status).toBe('PROCESSADO');
    expect((await negociosDe('maria@empresa.com.br'))[0]).toMatchObject({
      titulo: 'Maria Souza',
      utm: { source: 'instagram' },
    });
    // Assinatura de outro segredo, corpo adulterado e sem assinatura: 401 e erro registrado.
    await enviarLead(t, integracao.token, corpo, {
      'Typeform-Signature': assinar('outro-segredo', corpo),
      'Content-Type': 'application/json',
    }).expect(401);
    await enviarLead(t, integracao.token, corpo.replace('Maria', 'Mario'), {
      'Typeform-Signature': assinar(registrado.secret, corpo),
      'Content-Type': 'application/json',
    }).expect(401);
    await enviarLead(t, integracao.token, corpo, {
      'Content-Type': 'application/json',
    }).expect(401);
    const recusados = await t.prisma.webhookRecebimento.findMany({
      where: { status: 'ERRO', tentativas: 0 },
    });
    expect(recusados).toHaveLength(3);
    expect(recusados[0].mensagem).toMatch(/Assinatura (inválida|ausente)/);
    expect(await t.prisma.negocio.count()).toBe(1);
  });

  it('cenário 342 (R32.4, R32.10) — Typeform, como no Clint: a variável com o nome de uma etapa (valor diferente de 0) leva o negócio a essa etapa', async () => {
    const integracao = await criar({
      aplicativo: 'TYPEFORM',
      credencial: { token: 'tf-valido' },
      configuracao: { formularioId: 'lT9uwa' },
    });
    const [[, registrado]] = [...apps.webhooks.entries()];
    const corpo = JSON.stringify(
      respostaDoTypeform('Rita Lima', 'rita@empresa.com.br', {
        variables: [
          { key: 'score', type: 'number', number: 0 },
          { key: 'qualificacao', type: 'number', number: 0 },
          { key: 'PROPOSTA', type: 'number', number: 1 },
        ],
      }),
    );
    const ok = await enviar(integracao, corpo, {
      'Typeform-Signature': assinar(registrado.secret, corpo),
      'Content-Type': 'application/json',
    });
    expect(ok?.status).toBe('PROCESSADO');
    expect(ok?.mensagem).toMatch(/negócio criado em Comercial \/ Proposta/);
  });

  it('cenário 327 (R32.10) — Typeform: lista formulários e perguntas, troca o formulário (remove o webhook do antigo), desativa (enabled=false) e remove ao excluir', async () => {
    const integracao = await criar({
      aplicativo: 'TYPEFORM',
      credencial: { token: 'tf-valido' },
    });
    expect(apps.webhooks.size).toBe(0);
    const formularios = (
      await admin
        .get(`/api/v1/webhooks/entradas/${integracao.id}/formularios`)
        .expect(200)
    ).body as { id: string; titulo: string }[];
    expect(formularios.map(({ id }) => id)).toEqual(['lT9uwa', 'abc123']);
    const campos = (
      await admin
        .get(
          `/api/v1/webhooks/entradas/${integracao.id}/formularios/lT9uwa/campos`,
        )
        .expect(200)
    ).body as { caminho: string; rotulo: string }[];
    expect(campos).toEqual(
      expect.arrayContaining([
        {
          caminho: 'nome_completo',
          rotulo: 'Qual é o seu nome?',
          tipo: 'short_text',
        },
        {
          caminho: 'hidden.utm_source',
          rotulo: 'Campo oculto utm_source',
          tipo: 'hidden',
        },
      ]),
    );
    // Escolher o formulário registra o webhook.
    await admin
      .patch(`/api/v1/webhooks/entradas/${integracao.id}`, {
        configuracao: { formularioId: 'lT9uwa' },
      })
      .expect(200);
    expect([...apps.webhooks.keys()].map((k) => k.split('/')[0])).toEqual([
      'lT9uwa',
    ]);
    // Trocar o formulário tira o webhook do antigo e põe no novo.
    await admin
      .patch(`/api/v1/webhooks/entradas/${integracao.id}`, {
        configuracao: { formularioId: 'abc123' },
      })
      .expect(200);
    expect([...apps.webhooks.keys()].map((k) => k.split('/')[0])).toEqual([
      'abc123',
    ]);
    // "Buscar campos" usa o formulário escolhido e guarda o resultado.
    const buscados = (
      await admin
        .post(`/api/v1/webhooks/entradas/${integracao.id}/buscar-campos`)
        .expect(200)
    ).body as { campos: { caminho: string }[] };
    expect(buscados.campos.map(({ caminho }) => caminho)).toContain(
      'email_contato',
    );
    // Desativar mantém o webhook, mas desabilitado; reativar habilita.
    await admin
      .patch(`/api/v1/webhooks/entradas/${integracao.id}`, { ativo: false })
      .expect(200);
    expect([...apps.webhooks.values()][0].enabled).toBe(false);
    await admin
      .patch(`/api/v1/webhooks/entradas/${integracao.id}`, { ativo: true })
      .expect(200);
    expect([...apps.webhooks.values()][0].enabled).toBe(true);
    // Regenerar o token registra o endereço novo.
    const novo = (
      await admin
        .post(`/api/v1/webhooks/entradas/${integracao.id}/regenerar-token`)
        .expect(200)
    ).body as { url: string };
    expect([...apps.webhooks.values()][0].url).toBe(novo.url);
    // Excluir remove o webhook do formulário.
    await admin
      .delete(`/api/v1/webhooks/entradas/${integracao.id}`)
      .expect(204);
    expect(apps.webhooks.size).toBe(0);
    expect(apps.chamadas.some(({ metodo }) => metodo === 'DELETE')).toBe(true);
  });

  it('cenário 328 (R32.9) — Typeform com token expirado: 422, "precisa de atenção" e aviso ao Admin; o segredo do webhook não aparece em auditoria nem em aviso', async () => {
    const integracao = await criar({
      aplicativo: 'TYPEFORM',
      credencial: { token: 'tf-expirado' },
      configuracao: { formularioId: 'lT9uwa' },
    });
    // O registro do webhook falhou: a integração foi criada, mas precisa de atenção.
    const criada = (
      await admin.get(`/api/v1/webhooks/entradas/${integracao.id}`).expect(200)
    ).body as { situacao: string; configuracao: { webhookErro: string } };
    expect(criada.situacao).toBe('PRECISA_ATENCAO');
    expect(criada.configuracao.webhookErro).toMatch(
      /recusou a credencial \(HTTP 401\)/,
    );
    await admin
      .get(`/api/v1/webhooks/entradas/${integracao.id}/formularios`)
      .expect(422);
    expect(
      await t.prisma.notificacao.count({
        where: { tipo: 'integracao.precisa_atencao' },
      }),
    ).toBe(1);
    const sincronizar = (
      await admin
        .post(`/api/v1/webhooks/entradas/${integracao.id}/sincronizar`)
        .expect(200)
    ).body as { registrado: boolean; erro: string };
    expect(sincronizar.registrado).toBe(false);
    const auditoria = JSON.stringify(
      await t.prisma.eventoAuditoria.findMany({
        where: { entidade: 'webhook_entrada' },
      }),
      (_chave, valor: unknown) =>
        typeof valor === 'bigint' ? String(valor) : valor,
    );
    expect(auditoria).not.toContain('tf-expirado');
    // Token novo + sincronizar: volta a funcionar.
    await admin
      .patch(`/api/v1/webhooks/entradas/${integracao.id}`, {
        credencial: { token: 'tf-valido' },
      })
      .expect(200);
    expect(apps.webhooks.size).toBe(1);
    expect(
      (
        (
          await admin
            .get(`/api/v1/webhooks/entradas/${integracao.id}`)
            .expect(200)
        ).body as { situacao: string }
      ).situacao,
    ).toBe('ATIVA');
  });

  // -------------------------------------------------------------------------
  // Ação: alvo × modo, atualizações, avisos
  // -------------------------------------------------------------------------

  const mapaCompleto = (extra: [string, string][] = []) =>
    mapeamento([['nome', 'nome'], ['email', 'email'], ...extra]);

  it('cenário 329 (R32.3) — modo CRIAR: todo recebimento cria um negócio novo, mesmo com outro aberto do contato', async () => {
    const integracao = await criar({ modo: 'CRIAR' });
    expect(
      (await enviar(integracao, { name: 'Ana', email: 'ana@x.com' }))?.mensagem,
    ).toMatch(/Contato "Ana" criado; negócio criado/);
    const segundo = await enviar(integracao, {
      name: 'Ana',
      email: 'ana@x.com',
    });
    expect(segundo?.mensagem).toMatch(
      /reconvertido \(já existia\); negócio criado em Comercial \/ Novo/,
    );
    expect(await negociosDe('ana@x.com')).toHaveLength(2);
    expect(
      await t.prisma.negocio.count({ where: { reconversoes: { gt: 0 } } }),
    ).toBe(0);
  });

  it('cenário 330 (R32.3, R5.6) — criar ou atualizar: atualiza o negócio aberto (etapa mapeada) e registra a reconversão; com o negócio ganho, cria outro', async () => {
    const integracao = await criar({
      ...mapaCompleto([
        ['etapa', 'etapa'],
        ['valor', 'valor'],
      ]),
    });
    await enviar(integracao, { nome: 'Ana', email: 'ana@x.com', valor: '100' });
    const segundo = await enviar(integracao, {
      nome: 'Ana',
      email: 'ana@x.com',
      etapa: 'qualificação',
      valor: '2.500,00',
    });
    expect(segundo?.mensagem).toMatch(
      /reconversão registrada no negócio aberto "Ana"; atualizações: valor; etapa → Qualificação/,
    );
    const [negocio] = await negociosDe('ana@x.com');
    expect(negocio).toMatchObject({ reconversoes: 1 });
    expect(negocio.etapa.nome).toBe('Qualificação');
    expect(negocio.valor.toFixed(2)).toBe('2500.00');
    // Ganho: o próximo recebimento não encontra aberto e cria um negócio novo.
    await enviar(integracao, {
      nome: 'Ana',
      email: 'ana@x.com',
      etapa: 'Ganho',
    });
    expect((await negociosDe('ana@x.com'))[0].status).toBe('GANHO');
    await enviar(integracao, { nome: 'Ana', email: 'ana@x.com' });
    expect(await negociosDe('ana@x.com')).toHaveLength(2);
  });

  it('cenário 331 (R32.3) — modo ATUALIZAR: sem contato ou sem negócio aberto o recebimento fica IGNORADO; com negócio, atualiza etapa, dono e status', async () => {
    const { membros } = await criarEquipe(t, 'COMERCIAL', { membros: 1 });
    await t.prisma.usuario.update({
      where: { id: membros[0].id },
      data: {
        email: 'vendedor@brl.com.br',
        identificadorIntegracao: 'Ana.Vendas',
      },
    });
    const integracao = await criar({
      modo: 'ATUALIZAR',
      ...mapeamento([
        ['email', 'email'],
        ['etapa', 'etapa'],
        ['vendedor', 'dono'],
        ['situacao', 'status'],
        ['motivo', 'motivoPerda'],
      ]),
    });
    // Sem nome no mapeamento: o modo ATUALIZAR não exige.
    const semContato = await enviar(integracao, {
      email: 'ninguem@x.com',
      etapa: 'Proposta',
    });
    expect(semContato).toMatchObject({ status: 'IGNORADO' });
    expect(semContato?.mensagem).toMatch(
      /Contato não encontrado .*modo Atualizar não cria contato/,
    );
    const contato = await criarContato(t, { email: 'ana@x.com', nome: 'Ana' });
    const semNegocio = await enviar(integracao, {
      email: 'ana@x.com',
      etapa: 'Proposta',
    });
    expect(semNegocio).toMatchObject({
      status: 'IGNORADO',
      contato: { id: contato.id },
    });
    expect(semNegocio?.mensagem).toMatch(
      /nenhum negócio aberto dele em Comercial/,
    );
    expect(await t.prisma.negocio.count()).toBe(0);

    const negocio = await criarNegocio(t, { contato, area: 'COMERCIAL' });
    // Etapa por posição, dono por identificador (sem diferenciar maiúsculas).
    const mover = await enviar(integracao, {
      email: 'ana@x.com',
      etapa: '4',
      vendedor: 'ana.vendas',
    });
    expect(mover?.status).toBe('PROCESSADO');
    expect(mover?.mensagem).toMatch(
      /negócio aberto ".+" atualizado; atualizações: dono → .+; etapa → Proposta/,
    );
    expect(
      await t.prisma.negocio.findUniqueOrThrow({
        where: { id: negocio.id },
        include: { etapa: true },
      }),
    ).toMatchObject({
      responsavelId: membros[0].id,
      etapa: { nome: 'Proposta' },
    });
    // Dono por e-mail; status "lost" com o motivo mapeado (R5.5).
    const perdido = await enviar(integracao, {
      email: 'ana@x.com',
      vendedor: 'VENDEDOR@brl.com.br',
      situacao: 'lost',
      motivo: 'Preço',
    });
    expect(perdido?.status).toBe('PROCESSADO');
    expect(
      await t.prisma.negocio.findUniqueOrThrow({
        where: { id: negocio.id },
        include: { etapa: true },
      }),
    ).toMatchObject({
      status: 'PERDIDO',
      motivoPerda: 'Preço',
      etapa: { nome: 'Perdido' },
    });
    // O contato está sem negócio aberto de novo: ignorado.
    expect(
      (await enviar(integracao, { email: 'ana@x.com', etapa: '1' }))?.status,
    ).toBe('IGNORADO');
    // A auditoria do negócio mostra o ator WEBHOOK e a integração.
    const eventos = await t.prisma.eventoAuditoria.findMany({
      where: { entidade: 'negocio', entidadeId: negocio.id },
      orderBy: { criadoEm: 'asc' },
    });
    expect(eventos.map(({ acao }) => acao)).toEqual(
      expect.arrayContaining(['negocio.movido', 'negocio.perdido']),
    );
    expect(eventos.every(({ tipoAtor }) => tipoAtor === 'WEBHOOK')).toBe(true);
  });

  it('cenário 332 (R32.3) — alvo contato: cria só o contato; o segundo envio atualiza nome, cargo, etiquetas e campos; ATUALIZAR só acha', async () => {
    const integracao = await criar({
      alvo: 'CONTATO',
      etiquetasFixas: ['Feira'],
      ...mapeamento([
        ['nome', 'nome'],
        ['email', 'email'],
        ['cargo', 'cargo'],
        ['cidade', 'camposPersonalizados.cidade'],
      ]),
    });
    expect(
      (
        await enviar(integracao, {
          nome: 'Ana',
          email: 'ana@x.com',
          cidade: 'Natal',
        })
      )?.mensagem,
    ).toBe('Contato "Ana" criado.');
    expect(await t.prisma.negocio.count()).toBe(0);
    const recebimento = await enviar(integracao, {
      nome: 'Ana Lima',
      email: 'ana@x.com',
      cargo: 'Diretora',
      cidade: 'Recife',
    });
    expect(recebimento).toMatchObject({
      status: 'PROCESSADO',
      negocio: null,
      mensagem: 'Contato "Ana Lima" atualizado.',
    });
    expect(
      await t.prisma.contato.findFirstOrThrow({
        where: { email: 'ana@x.com' },
      }),
    ).toMatchObject({
      nome: 'Ana Lima',
      cargo: 'Diretora',
      camposPersonalizados: { cidade: 'Recife' },
      etiquetas: ['Feira'],
    });
    expect(await t.prisma.negocio.count()).toBe(0);
    expect(await t.prisma.contato.count()).toBe(1);
    const so = await criar({
      alvo: 'CONTATO',
      modo: 'ATUALIZAR',
      ...mapeamento([
        ['email', 'email'],
        ['cidade', 'camposPersonalizados.cidade'],
      ]),
    });
    expect(
      (await enviar(so, { email: 'nova@x.com', cidade: 'X' }))?.status,
    ).toBe('IGNORADO');
    expect(await t.prisma.contato.count()).toBe(1);
  });

  it('cenário 333 (R32.4) — etapa por nome sem acento, status won/lost, motivo padrão da integração, e valores desconhecidos viram avisos sem derrubar o recebimento', async () => {
    const { membros } = await criarEquipe(t, 'COMERCIAL', { membros: 1 });
    const outraArea = await criarEquipe(t, 'CS', { membros: 1 });
    await t.prisma.usuario.update({
      where: { id: membros[0].id },
      data: { email: 'ana@brl.com.br' },
    });
    const integracao = await criar({
      motivoPerdaPadrao: 'Perdido pela integração',
      ...mapaCompleto([
        ['etapa', 'etapa'],
        ['vendedor', 'dono'],
        ['situacao', 'status'],
      ]),
    });
    // Etapa "X" e dono inexistentes: avisos; o contato e o negócio saem do mesmo jeito.
    const avisos = await enviar(integracao, {
      nome: 'Ana',
      email: 'ana@x.com',
      etapa: 'Etapa Fantasma',
      vendedor: 'ninguem@brl.com.br',
      situacao: 'talvez',
    });
    expect(avisos?.status).toBe('PROCESSADO');
    expect(avisos?.avisos).toEqual([
      'Dono "ninguem@brl.com.br" não encontrado (e-mail ou identificador de um usuário ativo): ignorado.',
      'Etapa "Etapa Fantasma" não existe no funil Comercial: ignorada.',
      'Status "talvez" desconhecido (use aberto, ganho ou perdido): ignorado.',
    ]);
    expect(avisos?.mensagem).toMatch(
      /Avisos: Dono "ninguem@brl.com.br" não encontrado/,
    );
    expect((await negociosDe('ana@x.com'))[0].etapa.nome).toBe('Novo');
    // Dono de outra área: aviso.
    const deOutraArea = await enviar(integracao, {
      nome: 'Beto',
      email: 'beto@x.com',
      vendedor: outraArea.membros[0].email,
    });
    expect(deOutraArea?.avisos[0]).toMatch(/não atua no funil Comercial/);
    // Nome da etapa sem acento e sem diferenciar maiúsculas; status "won".
    await enviar(integracao, {
      nome: 'Ana',
      email: 'ana@x.com',
      etapa: 'QUALIFICACAO',
    });
    expect((await negociosDe('ana@x.com'))[0].etapa.nome).toBe('Qualificação');
    const ganho = await enviar(integracao, {
      nome: 'Ana',
      email: 'ana@x.com',
      situacao: 'won',
    });
    expect(ganho?.mensagem).toMatch(/etapa → Ganho, status → ganho/);
    // Perdido sem motivo mapeado: o motivo padrão da integração.
    await enviar(integracao, {
      nome: 'Caio',
      email: 'caio@x.com',
      situacao: 'perdido',
    });
    expect((await negociosDe('caio@x.com'))[0]).toMatchObject({
      status: 'PERDIDO',
      motivoPerda: 'Perdido pela integração',
    });
    // Etapa e status em conflito: a etapa vence, com aviso.
    const conflito = await enviar(integracao, {
      nome: 'Davi',
      email: 'davi@x.com',
      etapa: 'Proposta',
      situacao: 'ganho',
    });
    expect(conflito?.avisos[0]).toMatch(
      /Status "ganho" ignorado: a etapa "Proposta" define o status aberto/,
    );
  });

  it('cenário 334 (R32.4, R5.5) — perdido sem motivo não perde o negócio (aviso); status inicial GANHO e PERDIDO (este exige o motivo padrão)', async () => {
    const semMotivo = await criar({
      ...mapaCompleto([['situacao', 'status']]),
    });
    const resposta = await enviar(semMotivo, {
      nome: 'Ana',
      email: 'ana@x.com',
      situacao: 'perdido',
    });
    expect(resposta?.status).toBe('PROCESSADO');
    expect(resposta?.avisos.join(' ')).toMatch(/a perda exige motivo/);
    expect((await negociosDe('ana@x.com'))[0].status).toBe('ABERTO');
    await admin
      .post('/api/v1/webhooks/entradas', {
        nome: 'perdida sem motivo',
        statusInicial: 'PERDIDO',
      })
      .expect(400);
    const ganhos = await criar({ statusInicial: 'GANHO' });
    await enviar(ganhos, { name: 'Beto', email: 'beto@x.com' });
    expect((await negociosDe('beto@x.com'))[0]).toMatchObject({
      status: 'GANHO',
    });
    const perdidos = await criar({
      statusInicial: 'PERDIDO',
      motivoPerdaPadrao: 'Sem interesse',
    });
    await enviar(perdidos, { name: 'Caio', email: 'caio@x.com' });
    expect((await negociosDe('caio@x.com'))[0]).toMatchObject({
      status: 'PERDIDO',
      motivoPerda: 'Sem interesse',
    });
  });

  it('cenário 335 (R32.4) — identificador nas integrações: opcional, único sem diferenciar maiúsculas, editável pelo Admin', async () => {
    const { membros } = await criarEquipe(t, 'COMERCIAL', { membros: 2 });
    const editar = (id: string, valor: string | null) =>
      admin.patch(`/api/v1/usuarios/${id}`, { identificadorIntegracao: valor });
    const a = (await editar(membros[0].id, 'ana.vendas').expect(200)).body as {
      identificadorIntegracao: string;
    };
    expect(a.identificadorIntegracao).toBe('ana.vendas');
    const conflito = await editar(membros[1].id, 'ANA.VENDAS').expect(409);
    expect(
      (conflito.body as { detalhes: { campos: string[] } }).detalhes.campos,
    ).toEqual(['identificadorIntegracao']);
    await editar(membros[1].id, 'com espaço').expect(400);
    expect(
      (
        (await editar(membros[0].id, null).expect(200)).body as {
          identificadorIntegracao: string | null;
        }
      ).identificadorIntegracao,
    ).toBeNull();
    await editar(membros[1].id, 'ANA.VENDAS').expect(200);
    const criado = await admin
      .post('/api/v1/usuarios', {
        nome: 'Nova',
        email: 'nova@brl.com.br',
        papel: 'MEMBRO',
        area: 'COMERCIAL',
        liderId: membros[0].liderId,
        senhaTemporaria: 'Senha@Temporaria1',
        identificadorIntegracao: 'nova-1',
      })
      .expect(201);
    expect(
      (criado.body as { usuario: { identificadorIntegracao: string } }).usuario
        .identificadorIntegracao,
    ).toBe('nova-1');
  });

  // -------------------------------------------------------------------------
  // Histórico
  // -------------------------------------------------------------------------

  it('cenário 336 (R32.7) — histórico de todas as integrações com filtros por aplicativo, integração, status e data; detalhe e reprocessar', async () => {
    const generico = await criar({ nome: 'Site' });
    const elementor = await criar({
      aplicativo: 'ELEMENTOR',
      nome: 'Formulário do site',
    });
    await enviar(generico, { name: 'Ana', email: 'ana@x.com' });
    await enviar(elementor, 'name=Beto&email=beto%40x.com', {
      'Content-Type': FORM,
    });
    await enviar(generico, { name: 'sem contato' });
    const todos = (await admin.get('/api/v1/webhooks/recebimentos').expect(200))
      .body as {
      itens: {
        aplicativo: string;
        integracao: { id: string; nome: string };
        status: string;
      }[];
      total: number;
    };
    expect(todos.total).toBe(3);
    const filtrar = async (consulta: string) =>
      (
        (
          await admin
            .get(`/api/v1/webhooks/recebimentos?${consulta}`)
            .expect(200)
        ).body as { total: number }
      ).total;
    expect(await filtrar('aplicativo=ELEMENTOR')).toBe(1);
    expect(await filtrar('aplicativo=ELEMENTOR,WEBHOOK')).toBe(3);
    expect(await filtrar(`integracaoId=${generico.id}`)).toBe(2);
    expect(await filtrar('status=ERRO')).toBe(1);
    expect(
      await filtrar(
        `aplicativo=WEBHOOK&status=PROCESSADO&integracaoId=${generico.id}`,
      ),
    ).toBe(1);
    expect(await filtrar('de=2999-01-01')).toBe(0);
    expect(await filtrar('de=2000-01-01&ate=2999-01-01')).toBe(3);
    await admin
      .get('/api/v1/webhooks/recebimentos?aplicativo=INEXISTENTE')
      .expect(400);
    await admin
      .get(
        '/api/v1/webhooks/recebimentos?integracaoId=00000000-0000-4000-8000-000000000000',
      )
      .expect(404);
    const erro = todos.itens.find(({ status }) => status === 'ERRO');
    const detalhe = (
      await admin
        .get(
          `/api/v1/webhooks/recebimentos/${(erro as unknown as { id: string }).id}`,
        )
        .expect(200)
    ).body as {
      corpo: unknown;
      cabecalhos: Record<string, string>;
      integracao: { nome: string };
      podeReprocessar: boolean;
    };
    expect(detalhe).toMatchObject({
      corpo: { name: 'sem contato' },
      integracao: { nome: 'Site' },
      podeReprocessar: true,
    });
    // Só o Admin acessa o histórico.
    const { membros } = await criarEquipe(t, 'COMERCIAL', { membros: 1 });
    await (
      await entrarComo(t, membros[0])
    )
      .get('/api/v1/webhooks/recebimentos')
      .expect(403);
  });

  it('cenário 341 (R4.6, R32.6) — anonimizar o contato de qualquer lead apaga corpo, mensagem, avisos e itens do recebimento', async () => {
    const integracao = await criar({ aplicativo: 'RD_STATION' });
    const lead = (nome: string, email: string, fone: string) => ({
      name: nome,
      email,
      mobile_phone: fone,
    });
    const recebimento = await enviar(integracao, {
      leads: [
        lead('Ana Lima', 'ana@x.com', '11987650001'),
        lead('Beto Dias', 'beto@x.com', '11987650002'),
      ],
    });
    expect(recebimento?.status).toBe('PROCESSADO');
    const beto = await t.prisma.contato.findFirstOrThrow({
      where: { email: 'beto@x.com' },
    });
    await admin
      .post(`/api/v1/contatos/${beto.id}/anonimizar`, {
        motivo: 'Pedido do titular',
      })
      .expect(204);
    await processarEventos(t);
    const depois = (
      await admin
        .get(`/api/v1/webhooks/recebimentos/${recebimento?.id}`)
        .expect(200)
    ).body as { itens: unknown[]; avisos: string[]; corpo: unknown };
    expect(depois).toMatchObject({ itens: [], avisos: [], corpo: null });
    const texto = JSON.stringify(depois);
    // O contato da Ana continua existindo (o vínculo mostra o nome dela); os dados de ninguém ficam no recebimento.
    for (const dado of ['Beto Dias', 'ana@x.com', 'beto@x.com']) {
      expect(texto).not.toContain(dado);
    }
  });

  // -------------------------------------------------------------------------
  // Saída no estilo do Clint
  // -------------------------------------------------------------------------

  const entregar = (incluirAgendados = true) =>
    drenarFilas(t, FILA_ENTREGAR, { incluirAgendados });

  it('cenário 337 (R32.12) — saída do Clint em POST: gatilho "entra na etapa X" com filtro de funil envia só os campos escolhidos, com os identificadores editados', async () => {
    const { membros } = await criarEquipe(t, 'COMERCIAL', { membros: 1 });
    await t.prisma.usuario.update({
      where: { id: membros[0].id },
      data: {
        identificadorIntegracao: 'ana.vendas',
        email: 'ana@brl.com.br',
        nome: 'Ana Vendas',
      },
    });
    const proposta = await etapaDoFunilBase(t, 'COMERCIAL', 'proposta');
    const comercial = await funilBase(t, 'COMERCIAL');
    const catalogo = (
      await admin.get('/api/v1/webhooks/saidas/formato-clint').expect(200)
    ).body as {
      gatilhos: { tipo: string }[];
      campos: { origem: string; identificadorPadrao: string }[];
      metodos: string[];
    };
    expect(catalogo.gatilhos.map(({ tipo }) => tipo)).toEqual([
      'NEGOCIO_CRIADO',
      'ENTRA_NA_ETAPA',
      'MUDA_DE_ETAPA',
      'MUDA_DE_STATUS',
    ]);
    expect(catalogo.campos.map(({ origem }) => origem)).toEqual(
      expect.arrayContaining([
        'contato.email',
        'dono.identificador',
        'utm.source',
      ]),
    );
    expect(catalogo.metodos).toEqual(['POST', 'GET']);

    const resposta = await admin
      .post('/api/v1/webhooks/saidas', {
        nome: 'Clint',
        url: `${destino.url}/hook`,
        formato: 'CLINT',
        metodo: 'POST',
        gatilhos: [{ tipo: 'ENTRA_NA_ETAPA', etapaId: proposta.id }],
        campos: [
          { origem: 'contato.nome', identificador: 'nome_do_lead' },
          { origem: 'contato.email', identificador: 'email' },
          { origem: 'etapa.nome', identificador: 'etapa' },
          { origem: 'etapa.anterior', identificador: 'de' },
          { origem: 'negocio.valor', identificador: 'valor' },
          { origem: 'dono.identificador', identificador: 'vendedor' },
          { origem: 'contato.etiquetas', identificador: 'tags' },
          {
            origem: 'contato.camposPersonalizados.cidade',
            identificador: 'cidade',
          },
          { origem: 'evento.gatilho', identificador: 'gatilho' },
        ],
      })
      .expect(201);
    const { webhook, segredo } = resposta.body as {
      webhook: {
        id: string;
        formato: string;
        metodo: string;
        eventos: string[];
        gatilhos: { tipo: string; funilId: string; etapaId: string }[];
      };
      segredo: string;
    };
    // O funil do gatilho é o da etapa escolhida.
    expect(webhook).toMatchObject({
      formato: 'CLINT',
      metodo: 'POST',
      eventos: [],
      gatilhos: [
        { tipo: 'ENTRA_NA_ETAPA', etapaId: proposta.id, funilId: comercial.id },
      ],
    });

    const contato = await criarContato(t, {
      nome: 'Maria',
      email: 'maria@x.com',
    });
    await t.prisma.contato.update({
      where: { id: contato.id },
      data: { etiquetas: ['vip'], camposPersonalizados: { cidade: 'Natal' } },
    });
    const negocio = await criarNegocio(t, {
      contato,
      area: 'COMERCIAL',
      responsavel: membros[0],
      valor: '1500.00',
    });
    // Mover para outra etapa não dispara; para a Proposta, sim.
    const qualificacao = await etapaDoFunilBase(t, 'COMERCIAL', 'qualificacao');
    await admin
      .post(`/api/v1/negocios/${negocio.id}/mover`, {
        etapaId: qualificacao.id,
      })
      .expect(200);
    await admin
      .post(`/api/v1/negocios/${negocio.id}/mover`, { etapaId: proposta.id })
      .expect(200);
    await processarEventos(t);
    expect(
      await t.prisma.webhookEntrega.count({ where: { webhookId: webhook.id } }),
    ).toBe(1);
    await entregar();
    expect(destino.recebidos).toHaveLength(1);
    const pedido = destino.recebidos[0];
    expect(pedido.metodo).toBe('POST');
    expect(pedido.cabecalhos['content-type']).toMatch(/^application\/json/);
    expect(JSON.parse(pedido.corpo)).toEqual({
      nome_do_lead: 'Maria',
      email: 'maria@x.com',
      etapa: 'Proposta',
      de: 'Qualificação',
      valor: '1500.00',
      vendedor: 'ana.vendas',
      tags: ['vip'],
      cidade: 'Natal',
      gatilho: 'ENTRA_NA_ETAPA',
    });
    expect(pedido.cabecalhos['x-crm-assinatura']).toBe(
      assinaturaEsperada(
        segredo,
        pedido.cabecalhos['x-crm-timestamp'] as string,
        pedido.corpo,
      ),
    );
    expect(pedido.cabecalhos['x-crm-evento']).toBe('negocio.movido');
    // A entrega fica registrada como as demais (R9.5), com o corpo enviado.
    const entrega = await t.prisma.webhookEntrega.findFirstOrThrow({
      where: { webhookId: webhook.id },
    });
    expect(entrega).toMatchObject({ status: 'ENTREGUE', statusHttp: 200 });
    expect(
      (entrega.payload as { dados: { nome_do_lead: string }; formato: string })
        .dados.nome_do_lead,
    ).toBe('Maria');
    // Filtro de funil: o gatilho de outro funil não casa.
    const marketing = await funilBase(t, 'MARKETING');
    await admin
      .patch(`/api/v1/webhooks/saidas/${webhook.id}`, {
        gatilhos: [{ tipo: 'MUDA_DE_ETAPA', funilId: marketing.id }],
      })
      .expect(200);
    const negocio2 = await criarNegocio(t, { area: 'COMERCIAL' });
    await admin
      .post(`/api/v1/negocios/${negocio2.id}/mover`, {
        etapaId: qualificacao.id,
      })
      .expect(200);
    await processarEventos(t);
    expect(
      await t.prisma.webhookEntrega.count({ where: { webhookId: webhook.id } }),
    ).toBe(1);
  });

  it('cenário 338 (R32.12) — saída do Clint em GET: os campos vão na URL, sem corpo; "muda de status" cobre ganho, perdido e reabrir; validações', async () => {
    const resposta = await admin
      .post('/api/v1/webhooks/saidas', {
        nome: 'Clint GET',
        url: `${destino.url}/hook?chave=abc`,
        formato: 'CLINT',
        metodo: 'GET',
        gatilhos: [{ tipo: 'MUDA_DE_STATUS' }],
        campos: [
          { origem: 'negocio.titulo', identificador: 'negocio' },
          { origem: 'negocio.status', identificador: 'status' },
          { origem: 'negocio.motivoPerda', identificador: 'motivo' },
          { origem: 'contato.etiquetas', identificador: 'tags' },
        ],
      })
      .expect(201);
    const { webhook, segredo } = resposta.body as {
      webhook: { id: string };
      segredo: string;
    };
    const contato = await criarContato(t, { nome: 'Ana', email: 'ana@x.com' });
    await t.prisma.contato.update({
      where: { id: contato.id },
      data: { etiquetas: ['a', 'b'] },
    });
    const negocio = await criarNegocio(t, {
      contato,
      area: 'COMERCIAL',
      titulo: 'Plano Pro',
    });
    const perdido = await etapaDoFunilBase(t, 'COMERCIAL', 'perdido');
    const qualificacao = await etapaDoFunilBase(t, 'COMERCIAL', 'qualificacao');
    await admin
      .post(`/api/v1/negocios/${negocio.id}/mover`, {
        etapaId: qualificacao.id,
      })
      .expect(200);
    await admin
      .post(`/api/v1/negocios/${negocio.id}/mover`, {
        etapaId: perdido.id,
        motivoPerda: 'Preço',
      })
      .expect(200);
    await admin.post(`/api/v1/negocios/${negocio.id}/reabrir`, {}).expect(200);
    await processarEventos(t);
    await entregar();
    // Só as mudanças de status (perdido e reaberto): o movimento comum não entrega.
    expect(destino.recebidos).toHaveLength(2);
    const [primeiro, segundo] = destino.recebidos.sort((a, b) =>
      a.caminho.localeCompare(b.caminho),
    );
    for (const pedido of destino.recebidos) {
      expect(pedido.metodo).toBe('GET');
      expect(pedido.corpo).toBe('');
      expect(pedido.cabecalhos['content-type']).toBeUndefined();
      const consulta = pedido.caminho.slice(pedido.caminho.indexOf('?') + 1);
      expect(pedido.cabecalhos['x-crm-assinatura']).toBe(
        assinaturaEsperada(
          segredo,
          pedido.cabecalhos['x-crm-timestamp'] as string,
          new URLSearchParams(consulta).toString().replace(/^chave=abc&/, ''),
        ),
      );
    }
    const parametros = [primeiro, segundo].map(({ caminho }) =>
      Object.fromEntries(new URL(caminho, 'http://x').searchParams),
    );
    expect(parametros).toEqual(
      expect.arrayContaining([
        {
          chave: 'abc',
          negocio: 'Plano Pro',
          status: 'perdido',
          motivo: 'Preço',
          tags: 'a,b',
        },
        {
          chave: 'abc',
          negocio: 'Plano Pro',
          status: 'aberto',
          motivo: '',
          tags: 'a,b',
        },
      ]),
    );
    expect(
      await t.prisma.webhookEntrega.count({ where: { webhookId: webhook.id } }),
    ).toBe(2);

    // Teste do destino no formato Clint: campos simples na URL.
    destino.limpar();
    await admin
      .post(`/api/v1/webhooks/saidas/${webhook.id}/testar`)
      .expect(200);
    expect(destino.recebidos[0].caminho).toMatch(/evento=webhook\.teste/);

    // Validações.
    const base = { nome: 'x', url: `${destino.url}/h` };
    const campos = [{ origem: 'contato.email', identificador: 'email' }];
    await admin
      .post('/api/v1/webhooks/saidas', { ...base, formato: 'CLINT', campos })
      .expect(400);
    await admin
      .post('/api/v1/webhooks/saidas', {
        ...base,
        formato: 'CLINT',
        gatilhos: [{ tipo: 'NEGOCIO_CRIADO' }],
      })
      .expect(400);
    await admin
      .post('/api/v1/webhooks/saidas', {
        ...base,
        formato: 'CLINT',
        gatilhos: [{ tipo: 'ENTRA_NA_ETAPA' }],
        campos,
      })
      .expect(400);
    await admin
      .post('/api/v1/webhooks/saidas', {
        ...base,
        formato: 'CLINT',
        gatilhos: [{ tipo: 'NEGOCIO_CRIADO' }],
        campos: [...campos, { origem: 'contato.nome', identificador: 'email' }],
      })
      .expect(400);
    await admin
      .post('/api/v1/webhooks/saidas', {
        ...base,
        formato: 'CLINT',
        gatilhos: [{ tipo: 'NEGOCIO_CRIADO' }],
        campos: [{ origem: 'contato.senha', identificador: 'x' }],
      })
      .expect(400);
    await admin
      .post('/api/v1/webhooks/saidas', {
        ...base,
        formato: 'CLINT',
        eventos: ['contato.criado'],
        gatilhos: [{ tipo: 'NEGOCIO_CRIADO' }],
        campos,
      })
      .expect(400);
    // O envelope do CRM segue como era: eventos obrigatórios, sem GET.
    await admin.post('/api/v1/webhooks/saidas', { ...base }).expect(400);
    await admin
      .post('/api/v1/webhooks/saidas', {
        ...base,
        eventos: ['contato.criado'],
        metodo: 'GET',
      })
      .expect(400);
    const envelope = await admin
      .post('/api/v1/webhooks/saidas', {
        ...base,
        nome: 'envelope',
        eventos: ['contato.criado'],
      })
      .expect(201);
    expect(
      (envelope.body as { webhook: { formato: string; metodo: string } })
        .webhook,
    ).toMatchObject({ formato: 'ENVELOPE_CRM', metodo: 'POST' });
  });

  it('cenário 339 (R32.12, R9.4) — o destino do Clint mantém a fila, as tentativas e a desativação automática do R9; negócio criado por integração dispara "negócio criado"', async () => {
    const resposta = await admin
      .post('/api/v1/webhooks/saidas', {
        nome: 'Clint criado',
        url: `${destino.url}/hook`,
        formato: 'CLINT',
        gatilhos: [{ tipo: 'NEGOCIO_CRIADO' }],
        campos: [
          { origem: 'contato.email', identificador: 'email' },
          { origem: 'negocio.origem', identificador: 'origem' },
          { origem: 'negocio.origemDetalhe', identificador: 'integracao' },
        ],
      })
      .expect(201);
    const { webhook } = resposta.body as { webhook: { id: string } };
    destino.responder({ status: 500, corpo: 'erro' });
    const integracao = await criar({ nome: 'Landing' });
    await enviar(integracao, { name: 'Ana', email: 'ana@x.com' });
    await processarEventos(t);
    await entregar(false);
    expect(JSON.parse(destino.recebidos[0].corpo)).toEqual({
      email: 'ana@x.com',
      origem: 'WEBHOOK',
      integracao: 'Landing',
    });
    // A primeira tentativa falhou (500): nova tentativa agendada, como no R9.4.
    const entrega = await t.prisma.webhookEntrega.findFirstOrThrow({
      where: { webhookId: webhook.id },
    });
    expect(entrega).toMatchObject({
      status: 'PENDENTE',
      tentativas: 1,
      statusHttp: 500,
    });
    await t.prisma.webhookEntrega.update({
      where: { id: entrega.id },
      data: { proximaTentativaEm: new Date() },
    });
    const reenvio = await admin
      .post(
        `/api/v1/webhooks/saidas/${webhook.id}/entregas/${entrega.id}/reenviar`,
      )
      .expect(202);
    expect(reenvio.body).toBeDefined();
    await entregar();
    expect(
      (
        await t.prisma.webhookEntrega.findUniqueOrThrow({
          where: { id: entrega.id },
        })
      ).status,
    ).toBe('ENTREGUE');
  });
});

describe('Integrações por aplicativo — proteção SSRF da conta (e2e, R32.8, R9.1)', () => {
  let t: AppTeste;
  let admin: ClienteHttp;
  let espiao: jest.SpyInstance;

  beforeAll(async () => {
    espiao = jest.spyOn(globalThis, 'fetch');
    // Sem WEBHOOKS_PERMITIR_REDE_INTERNA: rede interna e localhost são recusados.
    t = await criarAppTeste();
  });

  beforeEach(async () => {
    await t.limparBanco();
    espiao.mockClear();
    admin = await entrarComo(
      t,
      await criarUsuario(t, { papel: 'ADMIN', nome: 'Admin' }),
    );
  });

  afterAll(async () => {
    espiao.mockRestore();
    await t.fechar();
  });

  it('cenário 340 (R32.8, R9.1) — a URL da conta do ActiveCampaign em rede interna é recusada ao criar, ao editar e ao testar antes de criar, sem nenhuma chamada', async () => {
    for (const urlConta of [
      'http://127.0.0.1/api',
      'https://10.0.0.5',
      'https://169.254.169.254',
      'https://usuario:senha@conta.api-us1.com',
    ]) {
      await admin
        .post('/api/v1/webhooks/entradas', {
          nome: `AC ${urlConta}`,
          aplicativo: 'ACTIVE_CAMPAIGN',
          credencial: { urlConta, chaveApi: 'k' },
        })
        .expect((resposta) => {
          expect([400, 422]).toContain(resposta.status);
        });
    }
    await admin
      .post('/api/v1/webhooks/entradas/testar-credencial', {
        aplicativo: 'ACTIVE_CAMPAIGN',
        credencial: { urlConta: 'https://10.0.0.5', chaveApi: 'k' },
      })
      .expect(422);
    expect(await t.prisma.webhookEntrada.count()).toBe(0);
    expect(
      espiao.mock.calls.filter(([url]) => String(url).includes('10.0.0.5')),
    ).toHaveLength(0);
  });
});
