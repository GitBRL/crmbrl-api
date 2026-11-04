import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import type { Usuario } from '../src/generated/prisma/client';
import {
  type AppTeste,
  type ClienteHttp,
  criarAppTeste,
  criarContato,
  criarEquipe,
  criarUsuario,
  drenarFilas,
  entrarComo,
  etapaDoFunilBase,
  funilBase,
  processarEventos,
} from './utils';
import {
  FILA_ENTREGAR,
  FILA_PROCESSAR,
  ServidorDeTeste,
  tokenDaUrl,
} from './webhooks-apoio';

/**
 * Plataformas de curso (R32.15, cenários 360 a 379): Hotmart, Kiwify e Eduzz
 * com os corpos reais do enviador de exemplos do apoio
 * (`test/fixtures/cursos-apoio.json`), a tabela de eventos, o filtro por
 * produto, a autenticidade de cada plataforma, a idempotência e o gatilho
 * "entra na etapa X" da saída no estilo do Clint.
 */

interface Exemplo {
  aplicativo: string;
  variante: string;
  url: string;
  cabecalhos: Record<string, string>;
  corpo: string;
}
const EXEMPLOS = JSON.parse(
  readFileSync(join(process.cwd(), 'test/fixtures/cursos-apoio.json'), 'utf8'),
) as Record<string, Exemplo>;

const SEGREDO = 'segredo-de-teste-1234';
const EMAIL = 'maria.souza@exemplo.com.br';

type Corpo = Record<string, unknown>;

/** O corpo do exemplo como objeto, com ajustes por caminho (`data.buyer.email`). */
function exemplo(chave: string, ajustes: Record<string, unknown> = {}): Corpo {
  const corpo = JSON.parse(EXEMPLOS[chave].corpo) as Corpo;
  for (const [caminho, valor] of Object.entries(ajustes)) {
    const trechos = caminho.split('.');
    let atual = corpo;
    for (const trecho of trechos.slice(0, -1)) {
      atual = atual[trecho] as Corpo;
    }
    atual[trechos[trechos.length - 1]] = valor;
  }
  return corpo;
}

const hmac = (
  algoritmo: 'sha1' | 'sha256',
  segredo: string,
  corpo: string,
  codificacao: 'hex' | 'base64',
) => createHmac(algoritmo, segredo).update(corpo).digest(codificacao);

interface IntegracaoCriada {
  id: string;
  url: string;
  token: string;
}

interface RecebimentoLido {
  id: string;
  status: string;
  mensagem: string;
  avisos: string[];
  recusadoNaRecepcao: boolean;
  itens: {
    status: string;
    mensagem: string;
    evento?: string | null;
    chave?: string | null;
    contatoId: string | null;
    negocioId: string | null;
    avisos: string[];
  }[];
}

describe('Plataformas de curso (e2e, R32.15)', () => {
  let t: AppTeste;
  let admin: ClienteHttp;
  let adminUsuario: Usuario;
  const destino = new ServidorDeTeste();
  let tf: { chamadas: { metodo: string; url: string }[]; segredo: string };
  let espiao: jest.SpyInstance | undefined;

  beforeAll(async () => {
    await destino.iniciar();
    const original = globalThis.fetch;
    tf = { chamadas: [], segredo: '' };
    // Typeform falso em processo (só o que a integração do Typeform pede ao criar).
    espiao = jest.spyOn(globalThis, 'fetch').mockImplementation((async (
      entrada: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url =
        typeof entrada === 'string'
          ? entrada
          : entrada instanceof URL
            ? entrada.href
            : entrada.url;
      if (!url.startsWith('https://typeform.teste')) {
        return original(entrada, init);
      }
      const metodo = init?.method ?? 'GET';
      tf.chamadas.push({ metodo, url });
      if (metodo === 'PUT' && typeof init?.body === 'string') {
        tf.segredo = (JSON.parse(init.body) as { secret: string }).secret;
      }
      return new Response(
        JSON.stringify({ items: [], total_items: 0, page_count: 1 }),
        { status: 200 },
      );
    }) as typeof fetch);
    t = await criarAppTeste({
      variaveis: {
        WEBHOOKS_PERMITIR_REDE_INTERNA: 'true',
        TYPEFORM_API_URL: 'https://typeform.teste',
      },
    });
  });

  beforeEach(async () => {
    await t.limparBanco();
    destino.limpar();
    tf.chamadas = [];
    adminUsuario = await criarUsuario(t, { papel: 'ADMIN', nome: 'Admin' });
    admin = await entrarComo(t, adminUsuario);
  });

  afterAll(async () => {
    espiao?.mockRestore();
    await t.fechar();
    await destino.parar();
  });

  const processar = () =>
    drenarFilas(t, FILA_PROCESSAR, { incluirAgendados: true });

  /** Cria a integração no funil Comercial (etapa inicial "Novo") e devolve o endereço. */
  const criar = async (
    corpo: Record<string, unknown>,
  ): Promise<IntegracaoCriada> => {
    const comercial = await funilBase(t, 'COMERCIAL');
    const resposta = await admin
      .post('/api/v1/webhooks/entradas', {
        nome: `Curso ${Math.random().toString(36).slice(2, 8)}`,
        funilId: comercial.id,
        etapaId: comercial.etapas[0].id,
        ...corpo,
      })
      .expect(201);
    const body = resposta.body as { webhook: { id: string }; url: string };
    return { id: body.webhook.id, url: body.url, token: tokenDaUrl(body.url) };
  };

  const criarHotmart = (extra: Record<string, unknown> = {}) =>
    criar({ aplicativo: 'HOTMART', segredo: SEGREDO, ...extra });
  const criarKiwify = (extra: Record<string, unknown> = {}) =>
    criar({ aplicativo: 'KIWIFY', segredo: SEGREDO, ...extra });
  const criarEduzz = (extra: Record<string, unknown> = {}) =>
    criar({ aplicativo: 'EDUZZ', segredo: SEGREDO, ...extra });

  /** POST ao endereço público, com query string e cabeçalhos. `corpo` texto vai como veio (o HMAC é do corpo bruto). */
  const postar = (
    integracao: IntegracaoCriada,
    corpo: string | Corpo,
    opcoes: { query?: string; cabecalhos?: Record<string, string> } = {},
  ): request.Test => {
    let pedido = request(t.servidor).post(
      `/api/v1/webhooks/entrada/${integracao.token}${opcoes.query ?? ''}`,
    );
    pedido = pedido.set('Content-Type', 'application/json');
    for (const [nome, valor] of Object.entries(opcoes.cabecalhos ?? {})) {
      pedido = pedido.set(nome, valor);
    }
    return pedido.send(
      typeof corpo === 'string' ? corpo : JSON.stringify(corpo),
    );
  };

  const lerRecebimento = async (id: string): Promise<RecebimentoLido> =>
    (await admin.get(`/api/v1/webhooks/recebimentos/${id}`).expect(200))
      .body as RecebimentoLido;

  /** Hotmart: o token no cabeçalho. */
  const enviarHotmart = async (
    integracao: IntegracaoCriada,
    corpo: Corpo,
    cabecalhos: Record<string, string> = { 'X-HOTMART-HOTTOK': SEGREDO },
  ): Promise<RecebimentoLido> => {
    const resposta = await postar(integracao, corpo, { cabecalhos }).expect(
      202,
    );
    await processar();
    return lerRecebimento((resposta.body as { id: string }).id);
  };

  /** Kiwify: `?signature=` com o HMAC-SHA1 (hex) do corpo bruto. */
  const enviarKiwify = async (
    integracao: IntegracaoCriada,
    corpo: Corpo,
  ): Promise<RecebimentoLido> => {
    const bruto = JSON.stringify(corpo);
    const resposta = await postar(integracao, bruto, {
      query: `?signature=${hmac('sha1', SEGREDO, bruto, 'hex')}`,
    }).expect(202);
    await processar();
    return lerRecebimento((resposta.body as { id: string }).id);
  };

  /** Eduzz: `x-signature` com o HMAC-SHA256 do corpo bruto (hex ou base64). */
  const enviarEduzz = async (
    integracao: IntegracaoCriada,
    corpo: Corpo,
    codificacao: 'hex' | 'base64' = 'hex',
  ): Promise<RecebimentoLido> => {
    const bruto = JSON.stringify(corpo);
    const resposta = await postar(integracao, bruto, {
      cabecalhos: {
        'x-signature': hmac('sha256', SEGREDO, bruto, codificacao),
      },
    }).expect(202);
    await processar();
    return lerRecebimento((resposta.body as { id: string }).id);
  };

  const negociosDe = (email: string) =>
    t.prisma.negocio.findMany({
      where: { contato: { email }, funil: { area: 'COMERCIAL' } },
      include: { etapa: true },
      orderBy: { criadoEm: 'asc' },
    });

  const contatoPorEmail = (email: string) =>
    t.prisma.contato.findFirst({ where: { email } });

  const etapaId = async (chave: string) =>
    (await etapaDoFunilBase(t, 'COMERCIAL', chave)).id;

  const configuracaoDe = async (id: string) =>
    (
      (await admin.get(`/api/v1/webhooks/entradas/${id}`).expect(200)).body as {
        configuracao: Record<string, unknown>;
      }
    ).configuracao;

  // -------------------------------------------------------------------------
  // Catálogo e configuração
  // -------------------------------------------------------------------------

  it('cenário 360 (R32.15) — o catálogo traz Hotmart, Kiwify e Eduzz disponíveis, com os eventos, os modelos prontos e o filtro por produto; a criação grava a tabela padrão', async () => {
    const catalogo = (
      await admin.get('/api/v1/webhooks/aplicativos').expect(200)
    ).body as {
      aplicativos: {
        aplicativo: string;
        disponivel: boolean;
        autenticidade: {
          tipo: string;
          segredo: string;
          cabecalho: string | null;
        };
        credencial: unknown;
        eventos: {
          filtroPorProduto: boolean;
          eventos: {
            codigo: string;
            nome: string;
            grupo: string;
            padrao: { acao: string };
          }[];
          modelos: {
            codigo: string;
            regras: Record<string, { acao: string }>;
          }[];
        } | null;
      }[];
    };
    const de = (aplicativo: string) =>
      catalogo.aplicativos.find((a) => a.aplicativo === aplicativo)!;
    expect(de('HOTMART')).toMatchObject({
      disponivel: true,
      credencial: null,
      autenticidade: {
        tipo: 'HOTMART_HOTTOK',
        segredo: 'OPCIONAL',
        cabecalho: 'X-HOTMART-HOTTOK',
      },
    });
    expect(de('KIWIFY').autenticidade.tipo).toBe('KIWIFY_ASSINATURA');
    expect(de('EDUZZ')).toMatchObject({
      disponivel: true,
      autenticidade: { tipo: 'EDUZZ_ASSINATURA', cabecalho: 'x-signature' },
    });
    for (const aplicativo of ['HOTMART', 'KIWIFY', 'EDUZZ']) {
      const eventos = de(aplicativo).eventos!;
      expect(eventos.filtroPorProduto).toBe(true);
      expect(eventos.modelos.map((m) => m.codigo)).toEqual([
        'VENDAS',
        'SO_COMPRAS',
        'RECUPERACAO',
      ]);
      expect(eventos.eventos.every((e) => e.nome && e.grupo)).toBe(true);
    }
    expect(
      de('HOTMART').eventos!.eventos.find(
        (e) => e.codigo === 'PURCHASE_APPROVED',
      ),
    ).toMatchObject({ nome: 'Compra aprovada', padrao: { acao: 'GANHO' } });
    // Os aplicativos sem tabela de eventos trazem `eventos: null`.
    expect(de('TYPEFORM').eventos).toBeNull();

    const integracao = await criarHotmart();
    const configuracao = (await configuracaoDe(integracao.id)) as {
      eventos: Record<
        string,
        { acao: string; etiquetas: string[]; motivoPerda: string | null }
      >;
    };
    expect(Object.keys(configuracao.eventos).sort()).toEqual(
      de('HOTMART')
        .eventos!.eventos.map((e) => e.codigo)
        .sort(),
    );
    expect(configuracao.eventos.PURCHASE_REFUNDED).toMatchObject({
      acao: 'PERDIDO',
      motivoPerda: 'Reembolso',
      etiquetas: ['reembolsado'],
    });
    // Só o Admin vê o catálogo e cria (R32.13).
    const { membros } = await criarEquipe(t, 'COMERCIAL', { membros: 1 });
    await (
      await entrarComo(t, membros[0])
    )
      .get('/api/v1/webhooks/aplicativos')
      .expect(403);
  });

  it('cenário 361 (R32.15) — configuração da tabela e do filtro: valida ação, etapa (do funil e aberta), motivo e produtos; só vale nas plataformas de curso; mudar o funil limpa as etapas escolhidas', async () => {
    const integracao = await criarHotmart();
    const qualificacao = await etapaId('qualificacao');
    const ganho = await etapaId('ganho');
    const patch = (configuracao: Record<string, unknown>) =>
      admin.patch(`/api/v1/webhooks/entradas/${integracao.id}`, {
        configuracao,
      });

    const valida = await patch({
      eventos: {
        PURCHASE_BILLET_PRINTED: {
          acao: 'ABRIR',
          etapaId: qualificacao,
          etiquetas: ['Boleto'],
        },
        PURCHASE_APPROVED: { acao: 'GANHO', etiquetas: ['aluno'] },
      },
      produtos: ['1234567', 'Curso Online BRL'],
    }).expect(200);
    expect(
      (valida.body as { configuracao: Record<string, unknown> }).configuracao,
    ).toMatchObject({
      produtos: ['1234567', 'Curso Online BRL'],
      eventos: {
        PURCHASE_BILLET_PRINTED: {
          acao: 'ABRIR',
          etapaId: qualificacao,
          etiquetas: ['Boleto'],
        },
      },
    });

    const erro = async (
      configuracao: Record<string, unknown>,
      trecho: string,
    ) => {
      const resposta = await patch(configuracao).expect(400);
      expect(JSON.stringify(resposta.body)).toContain(trecho);
    };
    await erro(
      { eventos: { PURCHASE_APPROVED: { acao: 'VOAR' } } },
      'acao deve ser',
    );
    await erro(
      {
        eventos: {
          PURCHASE_APPROVED: { acao: 'GANHO', etapaId: qualificacao },
        },
      },
      'só vale na ação ABRIR',
    );
    await erro(
      { eventos: { PURCHASE_APPROVED: { acao: 'ABRIR', etapaId: ganho } } },
      'etapa aberta',
    );
    await erro(
      {
        eventos: {
          PURCHASE_APPROVED: {
            acao: 'ABRIR',
            etapaId: '11111111-2222-3333-4444-555555555555',
          },
        },
      },
      'não pertence ao funil',
    );
    await erro(
      { eventos: { PURCHASE_APPROVED: { acao: 'GANHO', motivoPerda: 'x' } } },
      'só vale na ação PERDIDO',
    );
    await erro({ eventos: [] }, 'objeto');
    await erro({ produtos: 'curso' }, 'lista');
    await erro({ produtos: [''] }, 'texto');

    // `null` volta ao padrão (a chave some, valem os padrões do evento).
    await patch({ produtos: null }).expect(200);
    expect(await configuracaoDe(integracao.id)).not.toHaveProperty('produtos');

    // Só nas plataformas de curso.
    const webhook = await criar({ nome: 'Genérico' });
    const resposta = await admin
      .patch(`/api/v1/webhooks/entradas/${webhook.id}`, {
        configuracao: { eventos: { A: { acao: 'GANHO' } } },
      })
      .expect(400);
    expect(JSON.stringify(resposta.body)).toContain('plataformas de curso');
    // Mudar o funil limpa as etapas escolhidas da tabela.
    await admin
      .patch(`/api/v1/webhooks/entradas/${integracao.id}`, {
        configuracao: {
          eventos: {
            PURCHASE_BILLET_PRINTED: {
              acao: 'ABRIR',
              etapaId: await etapaId('qualificacao'),
            },
          },
        },
      })
      .expect(200);
    const outro = await funilBase(t, 'MARKETING');
    await admin
      .patch(`/api/v1/webhooks/entradas/${integracao.id}`, {
        funilId: outro.id,
        etapaId: outro.etapas[0].id,
      })
      .expect(200);
    const configuracao = (await configuracaoDe(integracao.id)) as {
      eventos: Record<string, { etapaId: string | null }>;
    };
    expect(configuracao.eventos.PURCHASE_BILLET_PRINTED.etapaId).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Hotmart
  // -------------------------------------------------------------------------

  it('cenário 362 (R32.15) — Hotmart: compra aprovada vira ganho com valor, produto, origem e etiqueta; o histórico mostra o evento', async () => {
    const integracao = await criarHotmart({ etiquetasFixas: ['Hotmart'] });
    const recebimento = await enviarHotmart(
      integracao,
      exemplo('hotmart/compra-aprovada'),
    );
    expect(recebimento).toMatchObject({
      status: 'PROCESSADO',
      mensagem: expect.stringMatching(
        /^Evento "Compra aprovada"; Contato "Maria Souza" criado/,
      ) as string,
    });
    expect(recebimento.itens[0]).toMatchObject({
      status: 'PROCESSADO',
      evento: 'PURCHASE_APPROVED',
      chave: expect.stringMatching(/^id:/) as string,
    });
    const [negocio] = await negociosDe(EMAIL);
    expect(negocio).toMatchObject({
      status: 'GANHO',
      titulo: 'Curso Online BRL',
      camposPersonalizados: {
        produto: 'Curso Online BRL',
        oferta: 'Oferta principal',
        forma_de_pagamento: 'CREDIT_CARD',
        transacao: expect.stringMatching(/^HP/) as string,
      },
    });
    expect(negocio.etapa.tipo).toBe('GANHO');
    expect(negocio.valor.toFixed(2)).toBe('497.00');
    expect(negocio.utm).toMatchObject({ source: expect.any(String) });
    const contato = await contatoPorEmail(EMAIL);
    expect(contato?.telefone).toBe('5511988887777');
    expect(contato?.etiquetas).toEqual(
      expect.arrayContaining(['Hotmart', 'comprou']),
    );
    // O histórico filtra por aplicativo e mostra o evento.
    const historico = (
      await admin
        .get('/api/v1/webhooks/recebimentos?aplicativo=HOTMART')
        .expect(200)
    ).body as {
      itens: { id: string; aplicativo: string; itens: { evento: string }[] }[];
    };
    expect(historico.itens).toHaveLength(1);
    expect(historico.itens[0]).toMatchObject({
      aplicativo: 'HOTMART',
      itens: [{ evento: 'PURCHASE_APPROVED' }],
    });
  });

  it('cenário 363 (R32.15) — Hotmart: carrinho abandonado e boleto abrem o negócio na etapa inicial (ou na escolhida) e a compra aprovada o ganha, sem duplicar', async () => {
    const qualificacao = await etapaId('qualificacao');
    const integracao = await criarHotmart();
    await admin
      .patch(`/api/v1/webhooks/entradas/${integracao.id}`, {
        configuracao: {
          eventos: {
            PURCHASE_BILLET_PRINTED: {
              acao: 'ABRIR',
              etapaId: qualificacao,
              etiquetas: ['boleto-gerado'],
            },
          },
        },
      })
      .expect(200);
    const carrinho = await enviarHotmart(
      integracao,
      exemplo('hotmart/carrinho-abandonado'),
    );
    expect(carrinho.status).toBe('PROCESSADO');
    let negocios = await negociosDe(EMAIL);
    expect(negocios).toHaveLength(1);
    expect(negocios[0]).toMatchObject({
      status: 'ABERTO',
      titulo: 'Curso Online BRL',
    });
    expect(negocios[0].etapa.nome).toBe('Novo');
    expect(negocios[0].valor.toFixed(2)).toBe('0.00');
    expect((await contatoPorEmail(EMAIL))?.etiquetas).toContain(
      'carrinho-abandonado',
    );

    await enviarHotmart(integracao, exemplo('hotmart/boleto-gerado'));
    negocios = await negociosDe(EMAIL);
    expect(negocios).toHaveLength(1);
    expect(negocios[0].etapa.nome).toBe('Qualificação');
    expect(negocios[0].valor.toFixed(2)).toBe('497.00');

    const aprovada = await enviarHotmart(
      integracao,
      exemplo('hotmart/compra-aprovada'),
    );
    expect(aprovada.status).toBe('PROCESSADO');
    negocios = await negociosDe(EMAIL);
    expect(negocios).toHaveLength(1);
    expect(negocios[0].status).toBe('GANHO');
    expect(negocios[0].etapa.tipo).toBe('GANHO');
    expect((await contatoPorEmail(EMAIL))?.etiquetas).toEqual(
      expect.arrayContaining([
        'carrinho-abandonado',
        'boleto-gerado',
        'comprou',
      ]),
    );
  });

  it('cenário 364 (R32.15) — Hotmart: carrinho sem e-mail nem telefone é ignorado (não é erro); a compra sem contato é erro', async () => {
    const integracao = await criarHotmart();
    const semContato = exemplo('hotmart/carrinho-abandonado', {
      'data.buyer': {},
    });
    const carrinho = await enviarHotmart(integracao, semContato);
    expect(carrinho).toMatchObject({
      status: 'IGNORADO',
      mensagem: expect.stringContaining('sem e-mail nem telefone') as string,
    });
    expect(await t.prisma.contato.count()).toBe(0);
    const compra = await enviarHotmart(
      integracao,
      exemplo('hotmart/compra-aprovada', {
        'data.buyer': { name: 'Sem Meio' },
      }),
    );
    expect(compra.status).toBe('ERRO');
    expect(compra.mensagem).toMatch(/Sem e-mail nem telefone/);
  });

  it('cenário 365 (R32.15) — Hotmart: reembolso e chargeback etiquetam e perdem o negócio da mesma transação, com motivo, sem mexer no valor; sem compra conhecida, nada é criado', async () => {
    const integracao = await criarHotmart();
    const aprovada = exemplo('hotmart/compra-aprovada');
    await enviarHotmart(integracao, aprovada);
    const transacao = (aprovada.data as { purchase: { transaction: string } })
      .purchase.transaction;
    const reembolso = await enviarHotmart(
      integracao,
      exemplo('hotmart/reembolso', {
        'data.purchase.transaction': transacao,
        'data.purchase.price.value': 100,
      }),
    );
    expect(reembolso).toMatchObject({
      status: 'PROCESSADO',
      mensagem: expect.stringContaining('perdido') as string,
    });
    const [negocio] = await negociosDe(EMAIL);
    expect(negocio).toMatchObject({
      status: 'PERDIDO',
      motivoPerda: 'Reembolso',
    });
    expect(negocio.etapa.tipo).toBe('PERDIDO');
    expect(negocio.valor.toFixed(2)).toBe('497.00');
    expect(negocio.titulo).toBe('Curso Online BRL');
    expect((await contatoPorEmail(EMAIL))?.etiquetas).toEqual(
      expect.arrayContaining(['comprou', 'reembolsado']),
    );
    expect(await negociosDe(EMAIL)).toHaveLength(1);

    // Chargeback de quem não é contato: ignorado, sem criar contato nem negócio.
    const desconhecido = await enviarHotmart(
      integracao,
      exemplo('hotmart/chargeback', {
        'data.buyer.email': 'ninguem@exemplo.com.br',
        'data.buyer.checkout_phone': '21999990000',
      }),
    );
    expect(desconhecido).toMatchObject({
      status: 'IGNORADO',
      mensagem: expect.stringContaining(
        'só age sobre um comprador que já é contato',
      ) as string,
    });
    expect(await contatoPorEmail('ninguem@exemplo.com.br')).toBeNull();

    // Compra expirada sem nenhum negócio do comprador: ignorada.
    const outra = await criarContato(t, {
      email: 'solto@exemplo.com.br',
      nome: 'Solto',
    });
    const expirada = await enviarHotmart(
      integracao,
      exemplo('hotmart/compra-expirada', {
        'data.buyer.email': 'solto@exemplo.com.br',
        'data.buyer.checkout_phone': '',
      }),
    );
    expect(expirada.status).toBe('IGNORADO');
    expect(expirada.mensagem).toContain(
      'nenhum negócio dele para marcar como perdido',
    );
    expect(
      await t.prisma.negocio.count({ where: { contatoId: outra.id } }),
    ).toBe(0);
  });

  it('cenário 366 (R32.15) — Hotmart: a tabela personalizada manda: ignorar, só etiquetar, evento fora da tabela; assinatura cancelada etiqueta o contato', async () => {
    const integracao = await criarHotmart();
    await admin
      .patch(`/api/v1/webhooks/entradas/${integracao.id}`, {
        configuracao: {
          eventos: {
            PURCHASE_APPROVED: { acao: 'IGNORAR' },
            PURCHASE_PROTEST: { acao: 'ETIQUETAR', etiquetas: ['Disputa'] },
          },
        },
      })
      .expect(200);
    const ignorada = await enviarHotmart(
      integracao,
      exemplo('hotmart/compra-aprovada'),
    );
    expect(ignorada).toMatchObject({
      status: 'IGNORADO',
      mensagem: expect.stringContaining(
        'configurado para ser ignorado',
      ) as string,
    });
    expect(await t.prisma.contato.count()).toBe(0);

    // Etiquetar não cria contato...
    const protesto = await enviarHotmart(
      integracao,
      exemplo('hotmart/protesto'),
    );
    expect(protesto.status).toBe('IGNORADO');
    // ...mas etiqueta quem já existe, sem criar negócio.
    await criarContato(t, { email: EMAIL, nome: 'Maria' });
    const etiquetada = await enviarHotmart(
      integracao,
      exemplo('hotmart/protesto'),
    );
    expect(etiquetada.status).toBe('PROCESSADO');
    expect(etiquetada.mensagem).toContain('etiquetado (Disputa)');
    expect((await contatoPorEmail(EMAIL))?.etiquetas).toContain('Disputa');
    expect(await negociosDe(EMAIL)).toHaveLength(0);

    const cancelada = await enviarHotmart(
      integracao,
      exemplo('hotmart/assinatura-cancelada'),
    );
    expect(cancelada.status).toBe('PROCESSADO');
    expect((await contatoPorEmail(EMAIL))?.etiquetas).toContain(
      'assinatura-cancelada',
    );

    // Evento que a tabela não conhece: ignorado, com o motivo.
    const novo = await enviarHotmart(
      integracao,
      exemplo('hotmart/compra-aprovada', { event: 'EVENTO_NOVO' }),
    );
    expect(novo).toMatchObject({
      status: 'IGNORADO',
      mensagem: expect.stringContaining(
        '"EVENTO_NOVO" não está na tabela de eventos',
      ) as string,
    });
    // ...e passa a valer se o Admin o acrescentar.
    await admin
      .patch(`/api/v1/webhooks/entradas/${integracao.id}`, {
        configuracao: {
          eventos: { EVENTO_NOVO: { acao: 'ETIQUETAR', etiquetas: ['Novo'] } },
        },
      })
      .expect(200);
    const tratado = await enviarHotmart(
      integracao,
      exemplo('hotmart/compra-aprovada', {
        event: 'EVENTO_NOVO',
        id: 'outro-id-1',
      }),
    );
    expect(tratado.status).toBe('PROCESSADO');
  });

  it('cenário 367 (R32.15) — Hotmart: o hottok vale (igual, diferente, ausente); recusado fica no histórico como erro e não processa', async () => {
    const integracao = await criarHotmart();
    const corpo = exemplo('hotmart/compra-aprovada');
    const errado = await postar(integracao, corpo, {
      cabecalhos: { 'X-HOTMART-HOTTOK': 'token-errado-qualquer' },
    }).expect(401);
    const ausente = await postar(integracao, corpo).expect(401);
    expect(JSON.stringify(errado.body)).toContain('inválido');
    expect(JSON.stringify(ausente.body)).toContain('ausente');
    const recusado = await lerRecebimento(
      (errado.body as { detalhes: { recebimentoId: string } }).detalhes
        .recebimentoId,
    );
    expect(recusado).toMatchObject({
      status: 'ERRO',
      recusadoNaRecepcao: true,
    });
    await processar();
    expect(await t.prisma.contato.count()).toBe(0);
    // O hottok é a própria chave: nunca vai para o histórico (nem o cabeçalho dos recusados).
    for (const id of [
      (errado.body as { detalhes: { recebimentoId: string } }).detalhes
        .recebimentoId,
    ]) {
      const detalhe = (
        await admin.get(`/api/v1/webhooks/recebimentos/${id}`).expect(200)
      ).body as { cabecalhos: Record<string, string> };
      expect(Object.keys(detalhe.cabecalhos)).not.toContain('x-hotmart-hottok');
      expect(JSON.stringify(detalhe)).not.toContain('token-errado-qualquer');
    }
    const aceito = await enviarHotmart(integracao, corpo);
    const detalheAceito = (
      await admin.get(`/api/v1/webhooks/recebimentos/${aceito.id}`).expect(200)
    ).body as { cabecalhos: Record<string, string> };
    expect(JSON.stringify(detalheAceito.cabecalhos)).not.toContain(SEGREDO);
    // Sem segredo na integração, o endereço secreto é a única proteção.
    const aberta = await criar({ aplicativo: 'HOTMART' });
    const resposta = await postar(aberta, corpo).expect(202);
    await processar();
    expect(
      (await lerRecebimento((resposta.body as { id: string }).id)).status,
    ).toBe('PROCESSADO');
  });

  // -------------------------------------------------------------------------
  // Kiwify
  // -------------------------------------------------------------------------

  it('cenário 368 (R32.15) — Kiwify: signature na query (HMAC-SHA1 hex do corpo bruto); a do enviador confere; inválida, ausente e corpo alterado dão 401', async () => {
    const integracao = await criarKiwify();
    const amostra = EXEMPLOS['kiwify/compra-aprovada'];
    // A assinatura que o enviador do apoio calculou, no corpo exatamente como saiu dele.
    const resposta = await postar(integracao, amostra.corpo, {
      query: amostra.url.slice(amostra.url.indexOf('?')),
    }).expect(202);
    await processar();
    expect(
      (await lerRecebimento((resposta.body as { id: string }).id)).status,
    ).toBe('PROCESSADO');
    expect(await negociosDe(EMAIL)).toHaveLength(1);

    const corpo = exemplo('kiwify/boleto-gerado');
    const bruto = JSON.stringify(corpo);
    const valida = hmac('sha1', SEGREDO, bruto, 'hex');
    await postar(integracao, bruto, {
      query: `?signature=${'0'.repeat(40)}`,
    }).expect(401);
    await postar(integracao, bruto).expect(401);
    await postar(integracao, bruto, { query: '?outro=1' }).expect(401);
    await postar(integracao, bruto.replace('Maria', 'Mario'), {
      query: `?signature=${valida}`,
    }).expect(401);
    await postar(integracao, bruto, {
      query: `?x=1&signature=${hmac('sha1', 'token-de-outra-pessoa', bruto, 'hex')}`,
    }).expect(401);
    // Aceita a assinatura em maiúsculas e com outros parâmetros na query.
    await postar(integracao, bruto, {
      query: `?x=1&signature=${valida.toUpperCase()}`,
    }).expect(202);
    const recusados = await t.prisma.webhookRecebimento.count({
      where: { webhookId: integracao.id, status: 'ERRO' },
    });
    expect(recusados).toBe(5);
  });

  it('cenário 369 (R32.15) — Kiwify: aprovada ganha com o valor em reais; Pix, boleto, recusada e carrinho abrem; reembolso e chargeback perdem; assinatura etiqueta', async () => {
    const integracao = await criarKiwify();
    const pix = await enviarKiwify(integracao, exemplo('kiwify/pix-gerado'));
    expect(pix.itens[0]).toMatchObject({
      status: 'PROCESSADO',
      evento: 'pix_created',
    });
    let negocios = await negociosDe(EMAIL);
    expect(negocios).toHaveLength(1);
    expect(negocios[0]).toMatchObject({ status: 'ABERTO' });
    expect(negocios[0].etapa.nome).toBe('Novo');
    expect((await contatoPorEmail(EMAIL))?.etiquetas).toContain('pix-gerado');

    const aprovada = exemplo('kiwify/compra-aprovada');
    await enviarKiwify(integracao, aprovada);
    negocios = await negociosDe(EMAIL);
    expect(negocios).toHaveLength(1);
    expect(negocios[0]).toMatchObject({
      status: 'GANHO',
      titulo: 'Curso Online BRL',
    });
    expect(negocios[0].valor.toFixed(2)).toBe('497.00');
    expect(negocios[0].camposPersonalizados).toMatchObject({
      transacao: aprovada.order_id,
      forma_de_pagamento: 'credit_card',
    });

    const reembolso = await enviarKiwify(
      integracao,
      exemplo('kiwify/compra-reembolsada', { order_id: aprovada.order_id }),
    );
    expect(reembolso.status).toBe('PROCESSADO');
    negocios = await negociosDe(EMAIL);
    expect(negocios).toHaveLength(1);
    expect(negocios[0]).toMatchObject({
      status: 'PERDIDO',
      motivoPerda: 'Reembolso',
    });

    for (const [variante, etiqueta] of [
      ['assinatura-cancelada', 'assinatura-cancelada'],
      ['assinatura-atrasada', 'assinatura-atrasada'],
      ['assinatura-renovada', 'assinatura-renovada'],
    ]) {
      const r = await enviarKiwify(integracao, exemplo(`kiwify/${variante}`));
      expect(r.status).toBe('PROCESSADO');
      expect((await contatoPorEmail(EMAIL))?.etiquetas).toContain(etiqueta);
    }
    // Compra recusada e carrinho abrem negócio para outro comprador.
    for (const [variante, email, etiqueta] of [
      ['compra-recusada', 'recusada@exemplo.com.br', 'compra-recusada'],
      ['carrinho-abandonado', 'carrinho@exemplo.com.br', 'carrinho-abandonado'],
    ]) {
      // Outro e-mail e outro telefone: o telefone também deduplica o contato (R4.2).
      const ajustes =
        variante === 'carrinho-abandonado'
          ? {
              email,
              phone: `+5521${Math.floor(900000000 + Math.random() * 99999999)}`,
            }
          : {
              'Customer.email': email,
              'Customer.mobile': `+5531${Math.floor(900000000 + Math.random() * 99999999)}`,
            };
      const r = await enviarKiwify(
        integracao,
        exemplo(`kiwify/${variante}`, ajustes),
      );
      expect(r.status).toBe('PROCESSADO');
      const outros = await negociosDe(email);
      expect(outros).toHaveLength(1);
      expect(outros[0].status).toBe('ABERTO');
      expect((await contatoPorEmail(email))?.etiquetas).toContain(etiqueta);
    }
    // Chargeback depois do reembolso: o negócio já está perdido, nada a fazer.
    const chargeback = await enviarKiwify(
      integracao,
      exemplo('kiwify/chargeback', { order_id: aprovada.order_id }),
    );
    expect(chargeback.status).toBe('IGNORADO');
  });

  it('cenário 370 (R32.15) — Kiwify: as chaves minúsculas do objeto de venda da API também são lidas', async () => {
    const integracao = await criarKiwify();
    const r = await enviarKiwify(
      integracao,
      exemplo('kiwify/compra-aprovada-alt'),
    );
    expect(r.status).toBe('PROCESSADO');
    const [negocio] = await negociosDe(EMAIL);
    expect(negocio.status).toBe('GANHO');
    expect(negocio.valor.toFixed(2)).toBe('497.00');
    expect(negocio.utm).toMatchObject({ source: expect.any(String) });
  });

  // -------------------------------------------------------------------------
  // Eduzz
  // -------------------------------------------------------------------------

  it('cenário 371 (R32.15) — Eduzz: x-signature (HMAC-SHA256 do corpo bruto) em hexadecimal ou base64; a do enviador confere; inválida e ausente dão 401', async () => {
    const integracao = await criarEduzz();
    for (const chave of ['eduzz/fatura-paga', 'eduzz/fatura-paga+base64']) {
      const amostra = EXEMPLOS[chave];
      // Na segunda rodada o evento repete: o importante é a aceitação (202).
      await postar(integracao, amostra.corpo, {
        cabecalhos: amostra.cabecalhos,
      }).expect(202);
    }
    await processar();
    // São dois eventos diferentes (cada exemplo tem o seu id): duas faturas pagas.
    expect(await negociosDe(EMAIL)).toHaveLength(2);
    const corpo = JSON.stringify(exemplo('eduzz/fatura-aberta'));
    await postar(integracao, corpo, {
      cabecalhos: { 'x-signature': 'a'.repeat(64) },
    }).expect(401);
    await postar(integracao, corpo).expect(401);
    await postar(integracao, corpo, {
      cabecalhos: {
        'x-signature': hmac('sha256', 'outra-chave-qualquer', corpo, 'hex'),
      },
    }).expect(401);
    await postar(integracao, corpo.replace('Maria', 'Mario'), {
      cabecalhos: { 'x-signature': hmac('sha256', SEGREDO, corpo, 'base64') },
    }).expect(401);
    await postar(integracao, corpo, {
      cabecalhos: { 'x-signature': hmac('sha256', SEGREDO, corpo, 'base64') },
    }).expect(202);
    // O `originSecret` do corpo e a assinatura não vão para o histórico.
    const enviado = await enviarEduzz(
      integracao,
      exemplo('eduzz/fatura-paga', { id: 'evento-historico-1' }),
    );
    const detalhe = (
      await admin.get(`/api/v1/webhooks/recebimentos/${enviado.id}`).expect(200)
    ).body as {
      cabecalhos: Record<string, string>;
      corpo: { data: { producer: { originSecret: string } } };
    };
    expect(detalhe.corpo.data.producer.originSecret).toBe('[omitido]');
    expect(JSON.stringify(detalhe)).not.toContain(SEGREDO);
    expect(Object.keys(detalhe.cabecalhos)).not.toContain('x-signature');
    // O processamento não depende do que foi ocultado.
    expect(enviado.status).toBe('PROCESSADO');
  });

  it('cenário 372 (R32.15) — Eduzz: o ping responde 2xx sem processar nada (fica no histórico como ignorado); ping com assinatura inválida é recusado', async () => {
    const integracao = await criarEduzz();
    const ping = EXEMPLOS['eduzz/ping'];
    const resposta = await postar(integracao, ping.corpo, {
      cabecalhos: ping.cabecalhos,
    }).expect(202);
    expect(resposta.body).toMatchObject({ status: 'IGNORADO' });
    // Já está resolvido na chegada, sem passar pela fila de processamento.
    const recebimento = await lerRecebimento(
      (resposta.body as { id: string }).id,
    );
    await processar();
    expect(recebimento).toMatchObject({
      status: 'IGNORADO',
      recusadoNaRecepcao: false,
      mensagem: expect.stringContaining('ping') as string,
    });
    expect(await t.prisma.contato.count()).toBe(0);
    await postar(integracao, ping.corpo, {
      cabecalhos: { 'x-signature': 'f'.repeat(64) },
    }).expect(401);
    // Sem chave na integração, o ping também responde 2xx.
    const aberta = await criar({ aplicativo: 'EDUZZ' });
    await postar(aberta, {
      id: 'p1',
      event: 'ping',
      data: { message: 'ping' },
    }).expect(202);
  });

  it('cenário 373 (R32.15) — Eduzz: fatura aguardando abre, paga ganha, expirada e chargeback perdem; carrinho abre; contrato cancelado etiqueta; contrato sem comprador é ignorado', async () => {
    const integracao = await criarEduzz();
    const aguardando = await enviarEduzz(
      integracao,
      exemplo('eduzz/fatura-aguardando-pagamento'),
    );
    expect(aguardando.itens[0].evento).toBe('myeduzz.invoice_waiting_payment');
    let negocios = await negociosDe(EMAIL);
    expect(negocios).toHaveLength(1);
    expect(negocios[0].status).toBe('ABERTO');
    expect(negocios[0].valor.toFixed(2)).toBe('497.00');

    const paga = exemplo('eduzz/fatura-paga');
    await enviarEduzz(integracao, paga, 'base64');
    negocios = await negociosDe(EMAIL);
    expect(negocios).toHaveLength(1);
    expect(negocios[0]).toMatchObject({
      status: 'GANHO',
      titulo: 'Curso Online BRL',
    });
    expect(negocios[0].camposPersonalizados).toMatchObject({
      transacao: (paga.data as { id: string }).id,
      oferta: 'Oferta principal',
    });

    const chargeback = await enviarEduzz(
      integracao,
      exemplo('eduzz/fatura-chargeback', {
        'data.id': (paga.data as { id: string }).id,
      }),
    );
    expect(chargeback.status).toBe('PROCESSADO');
    negocios = await negociosDe(EMAIL);
    expect(negocios[0]).toMatchObject({
      status: 'PERDIDO',
      motivoPerda: 'Chargeback',
    });

    // Fatura expirada de quem tem um negócio aberto: perde com o motivo da tabela.
    const aberta = await enviarEduzz(
      integracao,
      exemplo('eduzz/fatura-aguardando-pagamento', {
        id: 'evento-aguardando-2',
        'data.buyer.email': 'outro@exemplo.com.br',
        'data.buyer.cellphone': '(21) 98888-0000',
      }),
    );
    expect(aberta.status).toBe('PROCESSADO');
    await enviarEduzz(
      integracao,
      exemplo('eduzz/fatura-expirada', {
        'data.buyer.email': 'outro@exemplo.com.br',
        'data.buyer.cellphone': '(21) 98888-0000',
      }),
    );
    expect((await negociosDe('outro@exemplo.com.br'))[0]).toMatchObject({
      status: 'PERDIDO',
      motivoPerda: 'Fatura expirada',
    });

    const carrinho = await enviarEduzz(
      integracao,
      exemplo('eduzz/carrinho-abandonado', {
        'data.customer.email': 'cart@exemplo.com.br',
        'data.customer.phone': '+5531988880000',
      }),
    );
    expect(carrinho.status).toBe('PROCESSADO');
    expect((await negociosDe('cart@exemplo.com.br'))[0].status).toBe('ABERTO');

    const cancelado = await enviarEduzz(
      integracao,
      exemplo('eduzz/contrato-cancelado'),
    );
    expect(cancelado.itens[0].evento).toBe('myeduzz.contract_canceled');
    expect(cancelado.status).toBe('PROCESSADO');
    expect((await contatoPorEmail(EMAIL))?.etiquetas).toContain(
      'assinatura-cancelada',
    );

    // Evento de assinatura que só etiqueta, mas veio sem dados do comprador: nada a fazer.
    await admin
      .patch(`/api/v1/webhooks/entradas/${integracao.id}`, {
        configuracao: {
          eventos: {
            'myeduzz.contract_created': {
              acao: 'ETIQUETAR',
              etiquetas: ['assinou'],
            },
          },
        },
      })
      .expect(200);
    const semComprador = await enviarEduzz(
      integracao,
      exemplo('eduzz/contrato-sem-comprador'),
    );
    expect(semComprador).toMatchObject({
      status: 'IGNORADO',
      mensagem: expect.stringContaining('sem e-mail nem telefone') as string,
    });
  });

  // -------------------------------------------------------------------------
  // Filtro por produto, idempotência e modos
  // -------------------------------------------------------------------------

  it('cenário 374 (R32.15) — filtro opcional por produto: por id ou nome, nas três plataformas; fora do filtro é ignorado com o motivo', async () => {
    const hotmart = await criarHotmart({
      configuracao: { produtos: ['1234567'] },
    });
    const dentro = await enviarHotmart(
      hotmart,
      exemplo('hotmart/compra-aprovada'),
    );
    expect(dentro.status).toBe('PROCESSADO');
    const fora = await enviarHotmart(
      hotmart,
      exemplo('hotmart/compra-aprovada', {
        id: 'id-outro-produto',
        'data.product.id': 999,
        'data.product.name': 'Outro Curso',
        'data.buyer.email': 'fora@exemplo.com.br',
      }),
    );
    expect(fora).toMatchObject({
      status: 'IGNORADO',
      mensagem: expect.stringContaining(
        'Produto fora do filtro desta integração (Outro Curso)',
      ) as string,
    });
    expect(await contatoPorEmail('fora@exemplo.com.br')).toBeNull();

    const kiwify = await criarKiwify({
      configuracao: { produtos: ['curso online brl'] },
    });
    expect(
      (await enviarKiwify(kiwify, exemplo('kiwify/compra-aprovada'))).status,
    ).toBe('PROCESSADO');
    const foraKiwify = await enviarKiwify(
      kiwify,
      exemplo('kiwify/compra-aprovada', {
        order_id: 'pedido-outro',
        'Product.product_name': 'Outro Curso',
        'Customer.email': 'fora@exemplo.com.br',
      }),
    );
    expect(foraKiwify.status).toBe('IGNORADO');

    const eduzz = await criarEduzz({ configuracao: { produtos: ['123456'] } });
    expect(
      (await enviarEduzz(eduzz, exemplo('eduzz/fatura-paga'))).status,
    ).toBe('PROCESSADO');
    // O carrinho da Eduzz só traz os ids dos produtos.
    expect(
      (await enviarEduzz(eduzz, exemplo('eduzz/carrinho-abandonado'))).status,
    ).toBe('PROCESSADO');
    const foraEduzz = await enviarEduzz(
      eduzz,
      exemplo('eduzz/fatura-paga', {
        id: 'evento-outro',
        'data.items': [{ productId: '777', name: 'Outro' }],
        'data.buyer.email': 'fora@exemplo.com.br',
      }),
    );
    expect(foraEduzz.status).toBe('IGNORADO');
    // Sem filtro (lista vazia), tudo passa.
    await admin
      .patch(`/api/v1/webhooks/entradas/${eduzz.id}`, {
        configuracao: { produtos: [] },
      })
      .expect(200);
    const todos = await enviarEduzz(
      eduzz,
      exemplo('eduzz/fatura-paga', {
        id: 'evento-outro-2',
        'data.items': [{ productId: '777', name: 'Outro' }],
        'data.buyer.email': 'fora@exemplo.com.br',
      }),
    );
    expect(todos.status).toBe('PROCESSADO');
  });

  it('cenário 375 (R32.15) — idempotência: o mesmo evento de cada plataforma, reenviado, não cria outro negócio; o repetido fica ignorado e aponta o primeiro', async () => {
    const hotmart = await criarHotmart();
    const compra = exemplo('hotmart/compra-aprovada');
    const primeiro = await enviarHotmart(hotmart, compra);
    const repetido = await enviarHotmart(hotmart, compra);
    expect(primeiro.status).toBe('PROCESSADO');
    expect(repetido).toMatchObject({
      status: 'IGNORADO',
      mensagem: expect.stringContaining(
        `Evento repetido: já foi processado (recebimento ${primeiro.id})`,
      ) as string,
    });
    expect(await negociosDe(EMAIL)).toHaveLength(1);
    // Sem `id` no envelope, vale a transação mais o evento.
    const { id: _id, ...semId } = exemplo('hotmart/compra-aprovada', {
      'data.purchase.transaction': 'HPSEMID0001',
      'data.buyer.email': 'semid@exemplo.com.br',
      'data.buyer.checkout_phone': '21977770001',
    });
    expect((await enviarHotmart(hotmart, semId)).status).toBe('PROCESSADO');
    const porTransacao = await enviarHotmart(hotmart, semId);
    expect(porTransacao.status).toBe('IGNORADO');
    expect(porTransacao.mensagem).toContain('Evento repetido');
    // Outro evento da mesma transação não é repetição.
    expect(
      (
        await enviarHotmart(
          hotmart,
          exemplo('hotmart/compra-completa', {
            'data.purchase.transaction': (
              compra.data as { purchase: { transaction: string } }
            ).purchase.transaction,
          }),
        )
      ).itens[0].mensagem,
    ).toContain('ignorado');

    const kiwify = await criarKiwify();
    const aprovada = exemplo('kiwify/compra-aprovada');
    await enviarKiwify(kiwify, aprovada);
    const reenvio = await enviarKiwify(kiwify, aprovada);
    expect(reenvio.status).toBe('IGNORADO');
    // O mesmo pedido e o mesmo tipo de evento, mesmo com outro corpo, é o mesmo evento.
    const outroCorpo = await enviarKiwify(kiwify, {
      ...aprovada,
      updated_at: '2030-01-01 10:00',
    });
    expect(outroCorpo.status).toBe('IGNORADO');
    // Um negócio da Hotmart e um da Kiwify (o mesmo contato).
    expect(await negociosDe(EMAIL)).toHaveLength(2);

    const eduzz = await criarEduzz();
    const paga = exemplo('eduzz/fatura-paga');
    await enviarEduzz(eduzz, paga);
    expect((await enviarEduzz(eduzz, paga, 'base64')).status).toBe('IGNORADO');
    // Sem `id` no envelope, vale `data.id` + evento.
    const { id: _idEduzz, ...semIdEduzz } = exemplo('eduzz/fatura-paga', {
      'data.id': '777001',
      'data.buyer.email': 'semid-eduzz@exemplo.com.br',
      'data.buyer.cellphone': '(21) 97777-0002',
    });
    expect((await enviarEduzz(eduzz, semIdEduzz)).status).toBe('PROCESSADO');
    expect((await enviarEduzz(eduzz, semIdEduzz)).status).toBe('IGNORADO');
    expect(await negociosDe(EMAIL)).toHaveLength(3);
  });

  it('cenário 376 (R32.15) — idempotência: um envio que deu erro pode ser reenviado e processar; dois envios simultâneos do mesmo evento processam só um', async () => {
    const hotmart = await criarHotmart();
    const comErro = exemplo('hotmart/compra-aprovada', {
      'data.buyer': { name: 'Sem Meio' },
    });
    expect((await enviarHotmart(hotmart, comErro)).status).toBe('ERRO');
    // O reenvio do mesmo evento, agora com os dados completos, processa: o erro não conta como processado.
    const corrigido = await enviarHotmart(
      hotmart,
      exemplo('hotmart/compra-aprovada', { id: comErro.id }),
    );
    expect(corrigido.status).toBe('PROCESSADO');

    const kiwify = await criarKiwify();
    const corpo = exemplo('kiwify/pix-gerado', {
      'Customer.email': 'paralelo@exemplo.com.br',
      'Customer.mobile': '+5521966660000',
    });
    const bruto = JSON.stringify(corpo);
    const assinatura = `?signature=${hmac('sha1', SEGREDO, bruto, 'hex')}`;
    const respostas = await Promise.all(
      [1, 2, 3].map(() => postar(kiwify, bruto, { query: assinatura })),
    );
    expect(respostas.map((r) => r.status)).toEqual([202, 202, 202]);
    await processar();
    expect(await negociosDe('paralelo@exemplo.com.br')).toHaveLength(1);
    const lidos = await Promise.all(
      respostas.map((r) => lerRecebimento((r.body as { id: string }).id)),
    );
    expect(lidos.filter((r) => r.status === 'PROCESSADO')).toHaveLength(1);
    expect(lidos.filter((r) => r.status === 'IGNORADO')).toHaveLength(2);
  });

  it('cenário 377 (R32.15) — modo Criar: cada compra aprovada cria o negócio (a idempotência continua barrando o reenvio do mesmo evento)', async () => {
    const integracao = await criarHotmart({ modo: 'CRIAR' });
    await enviarHotmart(integracao, exemplo('hotmart/compra-aprovada'));
    await enviarHotmart(
      integracao,
      exemplo('hotmart/compra-aprovada', {
        id: 'outra-compra',
        'data.purchase.transaction': 'HPOUTRA',
      }),
    );
    const negocios = await negociosDe(EMAIL);
    expect(negocios).toHaveLength(2);
    expect(negocios.every((n) => n.status === 'GANHO')).toBe(true);
    // Modo Atualizar: sem contato, o evento é ignorado.
    const atualizar = await criarHotmart({ modo: 'ATUALIZAR' });
    const r = await enviarHotmart(
      atualizar,
      exemplo('hotmart/compra-aprovada', {
        'data.buyer.email': 'novo@exemplo.com.br',
      }),
    );
    expect(r.status).toBe('IGNORADO');
    expect(await contatoPorEmail('novo@exemplo.com.br')).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Typeform e saída no estilo do Clint
  // -------------------------------------------------------------------------

  it('cenário 378 (R32.15, R32.10) — Typeform: o mesmo event_id reenviado não cria outro negócio; outro event_id da mesma pessoa só reconverte', async () => {
    const integracao = await criar({
      aplicativo: 'TYPEFORM',
      credencial: { token: 'tf-valido' },
      configuracao: { formularioId: 'aB3dE5gH' },
    });
    expect(tf.segredo).not.toBe('');
    const amostra = JSON.parse(EXEMPLOS['typeform/padrao'].corpo) as {
      event_id: string;
    };
    const enviar = async (corpo: Corpo) => {
      const bruto = JSON.stringify(corpo);
      const resposta = await postar(integracao, bruto, {
        cabecalhos: {
          'Typeform-Signature': `sha256=${hmac('sha256', tf.segredo, bruto, 'base64')}`,
        },
      }).expect(202);
      await processar();
      return lerRecebimento((resposta.body as { id: string }).id);
    };
    const primeiro = await enviar(amostra);
    expect(primeiro.status).toBe('PROCESSADO');
    expect(primeiro.itens[0].chave).toBe(amostra.event_id);
    const contatos = await t.prisma.contato.findMany();
    expect(contatos).toHaveLength(1);
    const negociosAntes = await t.prisma.negocio.count({
      where: { contatoId: contatos[0].id },
    });
    expect(negociosAntes).toBeGreaterThan(0);

    const repetido = await enviar(amostra);
    expect(repetido).toMatchObject({
      status: 'IGNORADO',
      mensagem: expect.stringContaining(
        `Evento repetido: já foi processado (recebimento ${primeiro.id})`,
      ) as string,
    });
    expect(
      await t.prisma.negocio.count({ where: { contatoId: contatos[0].id } }),
    ).toBe(negociosAntes);
    const historico = await t.prisma.webhookRecebimento.count({
      where: { webhookId: integracao.id },
    });
    expect(historico).toBe(2);

    // Outro event_id (nova resposta da mesma pessoa) segue o fluxo normal: reconversão.
    const novo = await enviar({ ...amostra, event_id: 'novo-evento-123' });
    expect(novo.status).toBe('PROCESSADO');
    expect(
      await t.prisma.negocio.count({ where: { contatoId: contatos[0].id } }),
    ).toBe(negociosAntes);
  });

  it('cenário 379 (R32.12) — saída do Clint: "entra na etapa X" dispara também quando o negócio é CRIADO direto na etapa X, uma vez só, pela API e por uma integração', async () => {
    const comercial = await funilBase(t, 'COMERCIAL');
    const proposta = await etapaDoFunilBase(t, 'COMERCIAL', 'proposta');
    const qualificacao = await etapaDoFunilBase(t, 'COMERCIAL', 'qualificacao');
    const criarDestino = async (gatilhos: unknown[], nome: string) =>
      (
        await admin
          .post('/api/v1/webhooks/saidas', {
            nome,
            url: `${destino.url}/${nome}`,
            formato: 'CLINT',
            metodo: 'POST',
            gatilhos,
            campos: [
              { origem: 'contato.email', identificador: 'email' },
              { origem: 'etapa.nome', identificador: 'etapa' },
              { origem: 'evento.gatilho', identificador: 'gatilho' },
            ],
          })
          .expect(201)
      ).body as { webhook: { id: string } };
    const soEntra = await criarDestino(
      [{ tipo: 'ENTRA_NA_ETAPA', etapaId: proposta.id }],
      'entra',
    );
    // Criado + entra na mesma etapa: uma entrega por evento de negócio (a criação).
    const ambos = await criarDestino(
      [
        { tipo: 'NEGOCIO_CRIADO' },
        { tipo: 'ENTRA_NA_ETAPA', etapaId: proposta.id },
      ],
      'ambos',
    );
    const contato = await criarContato(t, {
      email: 'direto@exemplo.com.br',
      nome: 'Direto',
    });
    // Pela API, direto na etapa Proposta.
    await admin
      .post('/api/v1/negocios', {
        contatoId: contato.id,
        funilId: comercial.id,
        etapaId: proposta.id,
        titulo: 'Direto na Proposta',
      })
      .expect(201);
    // Direto em outra etapa: não dispara "entra na Proposta".
    await admin
      .post('/api/v1/negocios', {
        contatoId: contato.id,
        funilId: comercial.id,
        etapaId: qualificacao.id,
        titulo: 'Em Qualificação',
      })
      .expect(201);
    await processarEventos(t);
    const entregas = (webhook: string) =>
      t.prisma.webhookEntrega.findMany({ where: { webhookId: webhook } });
    expect(await entregas(soEntra.webhook.id)).toHaveLength(1);
    // O destino com os dois gatilhos recebe uma entrega só pela criação (não duas).
    expect(await entregas(ambos.webhook.id)).toHaveLength(2);

    // Por uma integração cuja etapa de entrada é a Proposta: criar o negócio nela dispara uma vez.
    const integracao = await criarHotmart({ etapaId: proposta.id });
    await enviarHotmart(
      integracao,
      exemplo('hotmart/carrinho-abandonado', {
        'data.buyer.email': 'viaintegracao@exemplo.com.br',
      }),
    );
    await processarEventos(t);
    expect(await entregas(soEntra.webhook.id)).toHaveLength(2);
    await drenarFilas(t, FILA_ENTREGAR, { incluirAgendados: true });
    const enviados = destino.recebidos
      .filter((p) => p.caminho === '/entra')
      .map((p) => JSON.parse(p.corpo) as Record<string, string>);
    expect(enviados).toHaveLength(2);
    expect(enviados).toEqual(
      expect.arrayContaining([
        {
          email: 'direto@exemplo.com.br',
          etapa: 'Proposta',
          gatilho: 'ENTRA_NA_ETAPA',
        },
        {
          email: 'viaintegracao@exemplo.com.br',
          etapa: 'Proposta',
          gatilho: 'ENTRA_NA_ETAPA',
        },
      ]),
    );
  });
});
