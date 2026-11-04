import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { aplicarMapeamento } from '../entrada/mapeamento';
import {
  completarConfiguracaoDeCurso,
  etapasDosEventos,
  produtoPassaNoFiltro,
  regraDoEvento,
  semEtapasDosEventos,
  validarProdutos,
  validarTabelaDeEventos,
} from './cursos';
import { adaptadorEduzz, eventoDaEduzz } from './eduzz';
import { adaptadorHotmart } from './hotmart';
import { adaptadorKiwify, eventoDaKiwify } from './kiwify';
import { adaptadorDe, catalogoDeAplicativos } from './registro';
import { assinaturaHmac } from './seguranca';
import type { AdaptadorDeAplicativo } from './tipos';

/** Os corpos que o enviador de exemplos do apoio manda, com as assinaturas dele (segredo de teste). */
interface Exemplo {
  aplicativo: string;
  variante: string;
  url: string;
  cabecalhos: Record<string, string>;
  corpo: string;
}
const SEGREDO = 'segredo-de-teste-1234';
const EXEMPLOS = JSON.parse(
  readFileSync(join(process.cwd(), 'test/fixtures/cursos-apoio.json'), 'utf8'),
) as Record<string, Exemplo>;

function exemplo(chave: string): Exemplo {
  const achado = EXEMPLOS[chave];
  if (!achado) {
    throw new Error(`exemplo ${chave} não existe`);
  }
  return achado;
}

function corpoDe(chave: string): unknown {
  return JSON.parse(exemplo(chave).corpo);
}

function queryDe(url: string): Record<string, string> {
  return Object.fromEntries(new URL(url, 'http://x').searchParams);
}

function item(adaptador: AdaptadorDeAplicativo, chave: string) {
  const [primeiro] = adaptador.normalizarCorpo(corpoDe(chave));
  return primeiro;
}

function lead(adaptador: AdaptadorDeAplicativo, chave: string) {
  return aplicarMapeamento(
    adaptador.definicao.modelo!.mapeamento,
    item(adaptador, chave).corpo,
    [],
  );
}

function autenticar(
  adaptador: AdaptadorDeAplicativo,
  chave: string,
  segredo: string | null = SEGREDO,
  ajustes: {
    cabecalhos?: Record<string, string>;
    query?: Record<string, string>;
    corpo?: string;
  } = {},
) {
  const e = exemplo(chave);
  return adaptador.verificarAutenticidade({
    cabecalhos: ajustes.cabecalhos ?? e.cabecalhos,
    query: ajustes.query ?? queryDe(e.url),
    corpoBruto: Buffer.from(ajustes.corpo ?? e.corpo, 'utf8'),
    segredo,
    configuracao: {},
  });
}

describe('R32.15 — plataformas de curso: catálogo', () => {
  it('Hotmart, Kiwify e Eduzz estão disponíveis, com tabela de eventos, modelos e filtro por produto', () => {
    const catalogo = catalogoDeAplicativos();
    for (const aplicativo of ['HOTMART', 'KIWIFY', 'EDUZZ'] as const) {
      const definicao = catalogo.find((d) => d.aplicativo === aplicativo)!;
      expect(definicao.disponivel).toBe(true);
      expect(definicao.entrega).toBe('WEBHOOK');
      expect(definicao.credencial).toBeNull();
      expect(definicao.autenticidade.segredo).toBe('OPCIONAL');
      expect(definicao.passoAPasso.passos.length).toBeGreaterThanOrEqual(4);
      expect(definicao.modelo).not.toBeNull();
      expect(definicao.eventos?.filtroPorProduto).toBe(true);
      expect(definicao.eventos?.modelos.map((m) => m.codigo)).toEqual([
        'VENDAS',
        'SO_COMPRAS',
        'RECUPERACAO',
      ]);
      // Cada modelo tem uma regra para cada evento conhecido.
      const codigos = definicao.eventos!.eventos.map((e) => e.codigo);
      for (const modelo of definicao.eventos!.modelos) {
        expect(Object.keys(modelo.regras).sort()).toEqual([...codigos].sort());
      }
    }
  });

  it('o modelo VENDAS é o padrão: compra aprovada ganha, carrinho e boleto/Pix abrem, reembolso e chargeback perdem com motivo', () => {
    const regra = (
      aplicativo: 'HOTMART' | 'KIWIFY' | 'EDUZZ',
      codigo: string,
    ) =>
      adaptadorDe(aplicativo)!.definicao.eventos!.eventos.find(
        (e) => e.codigo === codigo,
      )!.padrao;
    expect(regra('HOTMART', 'PURCHASE_APPROVED').acao).toBe('GANHO');
    expect(regra('HOTMART', 'PURCHASE_OUT_OF_SHOPPING_CART').acao).toBe(
      'ABRIR',
    );
    expect(regra('HOTMART', 'PURCHASE_BILLET_PRINTED').acao).toBe('ABRIR');
    expect(regra('HOTMART', 'PURCHASE_REFUNDED')).toMatchObject({
      acao: 'PERDIDO',
      motivoPerda: 'Reembolso',
      etiquetas: ['reembolsado'],
    });
    expect(regra('HOTMART', 'PURCHASE_CHARGEBACK').motivoPerda).toBe(
      'Chargeback',
    );
    expect(regra('KIWIFY', 'order_approved').acao).toBe('GANHO');
    expect(regra('KIWIFY', 'pix_created').acao).toBe('ABRIR');
    expect(regra('KIWIFY', 'billet_created').acao).toBe('ABRIR');
    expect(regra('KIWIFY', 'abandoned_cart').acao).toBe('ABRIR');
    expect(regra('KIWIFY', 'order_refunded').acao).toBe('PERDIDO');
    expect(regra('KIWIFY', 'chargeback').acao).toBe('PERDIDO');
    expect(regra('KIWIFY', 'subscription_canceled').acao).toBe('ETIQUETAR');
    expect(regra('KIWIFY', 'subscription_late').acao).toBe('ETIQUETAR');
    expect(regra('KIWIFY', 'subscription_renewed').acao).toBe('ETIQUETAR');
    expect(regra('EDUZZ', 'myeduzz.invoice_paid').acao).toBe('GANHO');
    expect(regra('EDUZZ', 'myeduzz.invoice_waiting_payment').acao).toBe(
      'ABRIR',
    );
    expect(regra('EDUZZ', 'sun.cart_abandonment').acao).toBe('ABRIR');
    expect(regra('EDUZZ', 'myeduzz.invoice_chargeback').acao).toBe('PERDIDO');
  });

  it('os modelos SO_COMPRAS e RECUPERACAO ignoram o que não é deles', () => {
    const modelos = adaptadorDe('KIWIFY')!.definicao.eventos!.modelos;
    const soCompras = modelos.find((m) => m.codigo === 'SO_COMPRAS')!;
    expect(soCompras.regras.order_approved.acao).toBe('GANHO');
    expect(soCompras.regras.order_refunded.acao).toBe('IGNORAR');
    expect(soCompras.regras.abandoned_cart.acao).toBe('IGNORAR');
    const recuperacao = modelos.find((m) => m.codigo === 'RECUPERACAO')!;
    expect(recuperacao.regras.abandoned_cart.acao).toBe('ABRIR');
    expect(recuperacao.regras.order_rejected.acao).toBe('ABRIR');
    expect(recuperacao.regras.order_refunded.acao).toBe('IGNORAR');
    expect(recuperacao.regras.subscription_canceled.acao).toBe('IGNORAR');
  });
});

describe('R32.15 — Hotmart: corpo, evento, produto e idempotência', () => {
  const variantes: [string, string][] = [
    ['compra-aprovada', 'PURCHASE_APPROVED'],
    ['compra-completa', 'PURCHASE_COMPLETE'],
    ['compra-cancelada', 'PURCHASE_CANCELED'],
    ['boleto-gerado', 'PURCHASE_BILLET_PRINTED'],
    ['compra-atrasada', 'PURCHASE_DELAYED'],
    ['compra-expirada', 'PURCHASE_EXPIRED'],
    ['protesto', 'PURCHASE_PROTEST'],
    ['reembolso', 'PURCHASE_REFUNDED'],
    ['chargeback', 'PURCHASE_CHARGEBACK'],
    ['carrinho-abandonado', 'PURCHASE_OUT_OF_SHOPPING_CART'],
    ['assinatura-cancelada', 'SUBSCRIPTION_CANCELLATION'],
    ['assinatura-aprovada', 'PURCHASE_APPROVED'],
  ];

  it.each(variantes)(
    '%s: evento %s, produto, chave pelo id do evento e comprador pelo modelo',
    (variante, codigo) => {
      const chave = `hotmart/${variante}`;
      const i = item(adaptadorHotmart, chave);
      expect(i.evento).toBe(codigo);
      expect(i.produtos).toEqual([{ id: '1234567', nome: 'Curso Online BRL' }]);
      expect(i.chaveDoEvento).toBe(
        `id:${(corpoDe(chave) as { id: string }).id}`,
      );
      const mapeado = lead(adaptadorHotmart, chave);
      expect(mapeado.problemas).toEqual([]);
      expect(mapeado.contato).toMatchObject({
        nome: 'Maria Souza',
        email: 'maria.souza@exemplo.com.br',
        telefone: '5511988887777',
      });
      expect(mapeado.negocio.titulo).toBe('Curso Online BRL');
    },
  );

  it('a compra traz valor, origem (src/sck como UTM) e os campos do negócio; o carrinho não traz valor', () => {
    const compra = lead(adaptadorHotmart, 'hotmart/compra-aprovada');
    expect(compra.negocio.valor).toBe('497.00');
    expect(compra.utm).toMatchObject({ source: expect.any(String) });
    expect(compra.camposDoNegocio).toMatchObject({
      produto: 'Curso Online BRL',
      oferta: 'Oferta principal',
      forma_de_pagamento: 'CREDIT_CARD',
      transacao: expect.stringMatching(/^HP/),
    });
    const carrinho = lead(adaptadorHotmart, 'hotmart/carrinho-abandonado');
    expect(carrinho.negocio.valor).toBeNull();
    expect(carrinho.camposDoNegocio.transacao).toBeUndefined();
  });

  it('a assinatura cancelada usa o assinante (subscriber) e o plano', () => {
    const mapeado = lead(adaptadorHotmart, 'hotmart/assinatura-cancelada');
    expect(mapeado.contato.email).toBe('maria.souza@exemplo.com.br');
    expect(mapeado.contato.telefone).toBe('5511988887777');
    expect(mapeado.camposDoNegocio.plano).toBe('Plano mensal');
  });

  it('sem id no envelope, a chave é a transação mais o evento; sem nenhum dos dois, não há chave', () => {
    const corpo = corpoDe('hotmart/compra-aprovada') as Record<string, unknown>;
    const { id: _id, ...semId } = corpo;
    const [a] = adaptadorHotmart.normalizarCorpo(semId);
    expect(a.chaveDoEvento).toMatch(/^transacao:HP.+:PURCHASE_APPROVED$/);
    const [b] = adaptadorHotmart.normalizarCorpo({
      event: 'PURCHASE_APPROVED',
    });
    expect(b.chaveDoEvento).toBeNull();
  });

  it('o DDI de outro país entra no telefone e o 55 não se duplica', () => {
    const base = corpoDe('hotmart/compra-aprovada') as {
      data: { buyer: Record<string, unknown> };
    };
    const [exterior] = adaptadorHotmart.normalizarCorpo({
      ...base,
      data: {
        ...base.data,
        buyer: {
          ...base.data.buyer,
          checkout_phone: '912345678',
          checkout_phone_code: '351',
        },
      },
    });
    expect(
      (exterior.corpo as { calculado: { telefone: string } }).calculado
        .telefone,
    ).toBe('+351912345678');
    const [nacional] = adaptadorHotmart.normalizarCorpo({
      ...base,
      data: {
        ...base.data,
        buyer: {
          ...base.data.buyer,
          checkout_phone: '5511988887777',
          checkout_phone_code: '55',
        },
      },
    });
    expect(
      (nacional.corpo as { calculado: { telefone: string } }).calculado
        .telefone,
    ).toBe('5511988887777');
  });

  it('corpo estranho vira um item só, sem evento (nunca lança)', () => {
    expect(adaptadorHotmart.normalizarCorpo('texto')).toEqual([
      { corpo: 'texto', rotulo: null },
    ]);
    const [vazio] = adaptadorHotmart.normalizarCorpo({});
    expect(vazio.evento).toBeNull();
  });

  describe('autenticidade (X-HOTMART-HOTTOK)', () => {
    it('token igual passa; diferente, ausente ou de tamanho errado não; sem segredo na integração, passa', () => {
      const chave = 'hotmart/compra-aprovada';
      expect(autenticar(adaptadorHotmart, chave)).toEqual({ ok: true });
      expect(
        autenticar(adaptadorHotmart, chave, SEGREDO, {
          cabecalhos: { 'x-hotmart-hottok': 'outro-token-qualquer' },
        }),
      ).toMatchObject({
        ok: false,
        mensagem: expect.stringContaining('inválido'),
      });
      expect(
        autenticar(adaptadorHotmart, chave, SEGREDO, {
          cabecalhos: { 'x-hotmart-hottok': 'x' },
        }),
      ).toMatchObject({ ok: false });
      expect(
        autenticar(adaptadorHotmart, chave, SEGREDO, { cabecalhos: {} }),
      ).toMatchObject({
        ok: false,
        mensagem: expect.stringContaining('ausente'),
      });
      expect(
        autenticar(adaptadorHotmart, chave, null, { cabecalhos: {} }),
      ).toEqual({
        ok: true,
      });
    });
  });
});

describe('R32.15 — Kiwify: corpo, evento, produto e idempotência', () => {
  const variantes: [string, string][] = [
    ['compra-aprovada', 'order_approved'],
    ['boleto-gerado', 'billet_created'],
    ['pix-gerado', 'pix_created'],
    ['compra-recusada', 'order_rejected'],
    ['compra-reembolsada', 'order_refunded'],
    ['chargeback', 'chargeback'],
    ['carrinho-abandonado', 'abandoned_cart'],
    ['assinatura-cancelada', 'subscription_canceled'],
    ['assinatura-atrasada', 'subscription_late'],
    ['assinatura-renovada', 'subscription_renewed'],
    ['compra-aprovada-alt', 'order_approved'],
  ];

  it.each(variantes)(
    '%s: evento %s, produto, chave e comprador pelo modelo',
    (variante, codigo) => {
      const chave = `kiwify/${variante}`;
      const i = item(adaptadorKiwify, chave);
      expect(i.evento).toBe(codigo);
      expect(i.produtos).toEqual([
        { id: expect.any(String), nome: 'Curso Online BRL' },
      ]);
      const corpo = corpoDe(chave) as Record<string, string>;
      expect(i.chaveDoEvento).toBe(
        codigo === 'abandoned_cart'
          ? `carrinho:${corpo.id}`
          : `pedido:${corpo.order_id}:${codigo}`,
      );
      const mapeado = lead(adaptadorKiwify, chave);
      expect(mapeado.problemas).toEqual([]);
      expect(mapeado.contato).toMatchObject({
        nome: 'Maria Souza',
        email: 'maria.souza@exemplo.com.br',
        telefone: '5511988887777',
      });
      expect(mapeado.negocio.titulo).toBe('Curso Online BRL');
    },
  );

  it('o valor vem em centavos e vira reais; as chaves minúsculas da API também valem; o carrinho não tem valor', () => {
    expect(lead(adaptadorKiwify, 'kiwify/compra-aprovada').negocio.valor).toBe(
      '497.00',
    );
    expect(
      lead(adaptadorKiwify, 'kiwify/compra-aprovada-alt').negocio.valor,
    ).toBe('497.00');
    expect(
      lead(adaptadorKiwify, 'kiwify/carrinho-abandonado').negocio.valor,
    ).toBeNull();
  });

  it('UTMs de TrackingParameters e tracking; transação, produto e forma de pagamento no negócio', () => {
    for (const chave of [
      'kiwify/compra-aprovada',
      'kiwify/compra-aprovada-alt',
    ]) {
      const mapeado = lead(adaptadorKiwify, chave);
      expect(mapeado.utm).toMatchObject({ source: expect.any(String) });
      expect(mapeado.camposDoNegocio).toMatchObject({
        produto: 'Curso Online BRL',
        forma_de_pagamento: 'credit_card',
        transacao: (corpoDe(chave) as { order_id: string }).order_id,
      });
    }
  });

  it('a assinatura traz o plano', () => {
    expect(
      lead(adaptadorKiwify, 'kiwify/assinatura-renovada').camposDoNegocio.plano,
    ).toBe('Plano mensal');
  });

  it('sem webhook_event_type, o evento sai do status do pedido; sem pedido, é carrinho', () => {
    expect(eventoDaKiwify({ order_status: 'paid' })).toBe('order_approved');
    expect(eventoDaKiwify({ order_status: 'refused' })).toBe('order_rejected');
    expect(eventoDaKiwify({ order_status: 'refunded' })).toBe('order_refunded');
    expect(eventoDaKiwify({ order_status: 'chargedback' })).toBe('chargeback');
    expect(
      eventoDaKiwify({
        order_status: 'waiting_payment',
        payment_method: 'pix',
      }),
    ).toBe('pix_created');
    expect(
      eventoDaKiwify({
        order_status: 'waiting_payment',
        payment_method: 'boleto',
      }),
    ).toBe('billet_created');
    expect(eventoDaKiwify({ order_status: 'algo_novo' })).toBeNull();
    expect(eventoDaKiwify({ email: 'a@b.com' })).toBe('abandoned_cart');
    expect(eventoDaKiwify({ order_id: 'x' })).toBeNull();
  });

  describe('autenticidade (?signature, HMAC-SHA1 em hexadecimal do corpo bruto)', () => {
    it('a assinatura do enviador do apoio confere (o mesmo cálculo da documentação da Kiwify)', () => {
      for (const [variante] of variantes) {
        expect(autenticar(adaptadorKiwify, `kiwify/${variante}`)).toEqual({
          ok: true,
        });
      }
    });

    it('vetor de teste: o HMAC-SHA1 de um corpo conhecido', () => {
      expect(assinaturaHmac('sha1', 'chave', '{"a":1}', 'hex')).toHaveLength(
        40,
      );
      const corpo = '{"order_id":"1","webhook_event_type":"order_approved"}';
      const assinatura = assinaturaHmac('sha1', 'meu-token', corpo, 'hex');
      const verificar = (query: Record<string, string>, bruto = corpo) =>
        adaptadorKiwify.verificarAutenticidade({
          cabecalhos: {},
          query,
          corpoBruto: Buffer.from(bruto),
          segredo: 'meu-token',
          configuracao: {},
        });
      expect(verificar({ signature: assinatura })).toEqual({ ok: true });
      expect(verificar({ signature: assinatura.toUpperCase() })).toEqual({
        ok: true,
      });
    });

    it('corpo alterado, assinatura errada ou ausente e token diferente recusam; sem segredo passa', () => {
      const chave = 'kiwify/compra-aprovada';
      expect(
        autenticar(adaptadorKiwify, chave, SEGREDO, {
          corpo: exemplo(chave).corpo.replace('497', '1'),
        }),
      ).toMatchObject({
        ok: false,
        mensagem: expect.stringContaining('inválida'),
      });
      expect(
        autenticar(adaptadorKiwify, chave, SEGREDO, {
          query: { signature: 'a'.repeat(40) },
        }),
      ).toMatchObject({ ok: false });
      expect(
        autenticar(adaptadorKiwify, chave, SEGREDO, { query: {} }),
      ).toMatchObject({
        ok: false,
        mensagem: expect.stringContaining('ausente'),
      });
      expect(
        autenticar(adaptadorKiwify, chave, 'token-diferente-do-outro'),
      ).toMatchObject({ ok: false });
      expect(autenticar(adaptadorKiwify, chave, null, { query: {} })).toEqual({
        ok: true,
      });
    });

    it('a assinatura repetida na query (lista) usa a primeira', () => {
      const chave = 'kiwify/compra-aprovada';
      const e = exemplo(chave);
      const valida = queryDe(e.url).signature;
      const resultado = adaptadorKiwify.verificarAutenticidade({
        cabecalhos: {},
        query: { signature: [valida, 'outra'] },
        corpoBruto: Buffer.from(e.corpo),
        segredo: SEGREDO,
        configuracao: {},
      });
      expect(resultado).toEqual({ ok: true });
    });
  });
});

describe('R32.15 — Eduzz: corpo, evento, produto e idempotência', () => {
  const variantes: [string, string][] = [
    ['fatura-paga', 'myeduzz.invoice_paid'],
    ['fatura-aberta', 'myeduzz.invoice_opened'],
    ['fatura-aguardando-pagamento', 'myeduzz.invoice_waiting_payment'],
    ['fatura-recuperando', 'myeduzz.invoice_recovering'],
    ['fatura-expirada', 'myeduzz.invoice_expired'],
    ['fatura-cancelada', 'myeduzz.invoice_canceled'],
    ['fatura-reembolsada', 'myeduzz.invoice_refunded'],
    ['fatura-chargeback', 'myeduzz.invoice_chargeback'],
    ['carrinho-abandonado', 'sun.cart_abandonment'],
    ['contrato-criado', 'myeduzz.contract_created'],
    ['contrato-cancelado', 'myeduzz.contract_canceled'],
  ];

  it.each(variantes)(
    '%s: evento %s, produto, chave pelo id do evento e comprador pelo modelo',
    (variante, codigo) => {
      const chave = `eduzz/${variante}`;
      const i = item(adaptadorEduzz, chave);
      expect(i.evento).toBe(codigo);
      expect(i.produtos?.length).toBeGreaterThan(0);
      expect(i.chaveDoEvento).toBe(
        `id:${(corpoDe(chave) as { id: string }).id}`,
      );
      const mapeado = lead(adaptadorEduzz, chave);
      expect(mapeado.problemas).toEqual([]);
      expect(mapeado.contato).toMatchObject({
        nome: 'Maria Souza',
        email: 'maria.souza@exemplo.com.br',
        telefone: '5511988887777',
      });
    },
  );

  it('fatura: título e produto, valor pago ou da fatura, oferta, transação, UTMs e forma de pagamento', () => {
    const paga = lead(adaptadorEduzz, 'eduzz/fatura-paga');
    expect(paga.negocio).toMatchObject({
      titulo: 'Curso Online BRL',
      valor: '497.00',
    });
    expect(paga.camposDoNegocio).toMatchObject({
      produto: 'Curso Online BRL',
      oferta: 'Oferta principal',
      forma_de_pagamento: 'creditCard',
      transacao: expect.any(String),
    });
    expect(paga.utm).toMatchObject({ source: expect.any(String) });
    // Aguardando pagamento: nada pago ainda, vale o preço da fatura.
    expect(
      lead(adaptadorEduzz, 'eduzz/fatura-aguardando-pagamento').negocio.valor,
    ).toBe('497.00');
  });

  it('carrinho: comprador em data.customer, só os ids dos produtos e UTMs de data.tracker', () => {
    const i = item(adaptadorEduzz, 'eduzz/carrinho-abandonado');
    expect(i.produtos).toEqual([{ id: '123456', nome: null }]);
    const mapeado = lead(adaptadorEduzz, 'eduzz/carrinho-abandonado');
    expect(mapeado.negocio.valor).toBeNull();
    expect(mapeado.utm).toMatchObject({ source: expect.any(String) });
  });

  it('contrato sem dados do comprador não tem e-mail nem telefone (o processamento o ignora)', () => {
    const mapeado = lead(adaptadorEduzz, 'eduzz/contrato-sem-comprador');
    expect(mapeado.contato.email).toBeNull();
    expect(mapeado.problemas.join(' ')).toContain('Sem e-mail nem telefone');
  });

  it('contract_updated vira cancelada ou atrasada pelo status do contrato; senão, continua contract_updated', () => {
    const atualizado = (status: string) =>
      eventoDaEduzz({
        event: 'myeduzz.contract_updated',
        data: { contract: { status } },
      });
    expect(atualizado('canceled')).toBe('myeduzz.contract_canceled');
    expect(atualizado('late')).toBe('myeduzz.contract_late');
    expect(atualizado('defaulter')).toBe('myeduzz.contract_late');
    expect(atualizado('suspended')).toBe('myeduzz.contract_late');
    expect(atualizado('upToDate')).toBe('myeduzz.contract_updated');
  });

  it('sem id no envelope, a chave é data.id + evento', () => {
    const corpo = corpoDe('eduzz/fatura-paga') as Record<string, unknown>;
    const { id: _id, ...semId } = corpo;
    const [a] = adaptadorEduzz.normalizarCorpo(semId);
    expect(a.chaveDoEvento).toMatch(/^dado:.+:myeduzz\.invoice_paid$/);
  });

  describe('ping', () => {
    it('o ping responde sem processar; outros eventos não', () => {
      expect(
        adaptadorEduzz.respostaSemProcessar?.(corpoDe('eduzz/ping')),
      ).toContain('ping');
      expect(
        adaptadorEduzz.respostaSemProcessar?.({ event: 'ping', data: {} }),
      ).toContain('ping');
      expect(
        adaptadorEduzz.respostaSemProcessar?.({ data: { message: 'ping' } }),
      ).toContain('ping');
      expect(
        adaptadorEduzz.respostaSemProcessar?.(corpoDe('eduzz/fatura-paga')),
      ).toBeNull();
      expect(adaptadorEduzz.respostaSemProcessar?.('texto')).toBeNull();
    });
  });

  describe('autenticidade (x-signature: HMAC-SHA256 do corpo bruto, hex ou base64)', () => {
    it('a assinatura em hexadecimal e a em base64 do enviador do apoio conferem', () => {
      expect(autenticar(adaptadorEduzz, 'eduzz/fatura-paga')).toEqual({
        ok: true,
      });
      expect(autenticar(adaptadorEduzz, 'eduzz/fatura-paga+base64')).toEqual({
        ok: true,
      });
      expect(autenticar(adaptadorEduzz, 'eduzz/ping')).toEqual({ ok: true });
    });

    it('hexadecimal em maiúsculas e o prefixo sha256= também valem', () => {
      const e = exemplo('eduzz/fatura-paga');
      const hex = e.cabecalhos['x-signature'];
      expect(
        autenticar(adaptadorEduzz, 'eduzz/fatura-paga', SEGREDO, {
          cabecalhos: { 'x-signature': hex.toUpperCase() },
        }),
      ).toEqual({ ok: true });
      expect(
        autenticar(adaptadorEduzz, 'eduzz/fatura-paga', SEGREDO, {
          cabecalhos: { 'x-signature': `sha256=${hex}` },
        }),
      ).toEqual({ ok: true });
    });

    it('corpo alterado, chave errada, assinatura ausente ou vazia recusam; sem segredo passa', () => {
      const chave = 'eduzz/fatura-paga';
      expect(
        autenticar(adaptadorEduzz, chave, SEGREDO, {
          corpo: exemplo(chave).corpo.replace('497', '1'),
        }),
      ).toMatchObject({
        ok: false,
        mensagem: expect.stringContaining('inválida'),
      });
      expect(
        autenticar(adaptadorEduzz, chave, 'chave-de-outra-pessoa'),
      ).toMatchObject({ ok: false });
      expect(
        autenticar(adaptadorEduzz, chave, SEGREDO, { cabecalhos: {} }),
      ).toMatchObject({
        ok: false,
        mensagem: expect.stringContaining('ausente'),
      });
      expect(
        autenticar(adaptadorEduzz, chave, SEGREDO, {
          cabecalhos: { 'x-signature': '  ' },
        }),
      ).toMatchObject({ ok: false });
      expect(
        autenticar(adaptadorEduzz, chave, null, { cabecalhos: {} }),
      ).toEqual({
        ok: true,
      });
    });
  });
});

describe('R32.15 — tabela de eventos e filtro por produto', () => {
  const eventos = adaptadorHotmart.definicao.eventos!.eventos;

  it('a regra gravada vale; o que faltar usa o padrão do evento; código desconhecido não tem regra', () => {
    const gravada = {
      eventos: {
        PURCHASE_APPROVED: {
          acao: 'ABRIR',
          etapaId: 'a'.repeat(8) + '-aaaa-aaaa-aaaa-' + 'a'.repeat(12),
          etiquetas: ['x'],
        },
      },
    };
    expect(
      regraDoEvento(eventos, gravada, 'PURCHASE_APPROVED')?.regra,
    ).toMatchObject({
      acao: 'ABRIR',
      etiquetas: ['x'],
    });
    expect(
      regraDoEvento(eventos, gravada, 'PURCHASE_REFUNDED')?.regra.acao,
    ).toBe('PERDIDO');
    expect(regraDoEvento(eventos, {}, 'PURCHASE_APPROVED')?.regra.acao).toBe(
      'GANHO',
    );
    expect(regraDoEvento(eventos, {}, 'EVENTO_NOVO')).toBeNull();
    // Um evento fora da lista conhecida pode ser tratado se estiver na tabela.
    expect(
      regraDoEvento(
        eventos,
        {
          eventos: { EVENTO_NOVO: { acao: 'ETIQUETAR', etiquetas: ['novo'] } },
        },
        'EVENTO_NOVO',
      )?.regra.acao,
    ).toBe('ETIQUETAR');
    // Regra malformada no banco: cai no padrão.
    expect(
      regraDoEvento(
        eventos,
        { eventos: { PURCHASE_APPROVED: { acao: 'VOAR' } } },
        'PURCHASE_APPROVED',
      )?.regra.acao,
    ).toBe('GANHO');
  });

  it('validarTabelaDeEventos aceita as ações e recusa o que não faz sentido', () => {
    const etapaId = '11111111-2222-3333-4444-555555555555';
    expect(
      validarTabelaDeEventos({
        A: { acao: 'IGNORAR' },
        B: {
          acao: 'ABRIR',
          etapaId: etapaId.toUpperCase(),
          etiquetas: [' vip ', 'VIP'],
        },
        C: { acao: 'GANHO', etiquetas: ['comprou'] },
        D: { acao: 'PERDIDO', motivoPerda: ' Reembolso ', etiquetas: [] },
        E: { acao: 'ETIQUETAR', etiquetas: ['x'] },
      }),
    ).toEqual({
      valor: {
        A: { acao: 'IGNORAR', etapaId: null, motivoPerda: null, etiquetas: [] },
        B: { acao: 'ABRIR', etapaId, motivoPerda: null, etiquetas: ['vip'] },
        C: {
          acao: 'GANHO',
          etapaId: null,
          motivoPerda: null,
          etiquetas: ['comprou'],
        },
        D: {
          acao: 'PERDIDO',
          etapaId: null,
          motivoPerda: 'Reembolso',
          etiquetas: [],
        },
        E: {
          acao: 'ETIQUETAR',
          etapaId: null,
          motivoPerda: null,
          etiquetas: ['x'],
        },
      },
    });
    const problema = (valor: unknown) => {
      const r = validarTabelaDeEventos(valor);
      return 'problema' in r ? r.problema : null;
    };
    expect(problema([])).toContain('objeto');
    expect(problema({ 'a b': { acao: 'GANHO' } })).toContain('inválido');
    expect(problema({ A: { acao: 'VOAR' } })).toContain('acao deve ser');
    expect(problema({ A: 'x' })).toContain('objeto');
    expect(problema({ A: { acao: 'GANHO', etapaId: etapaId } })).toContain(
      'só vale na ação ABRIR',
    );
    expect(problema({ A: { acao: 'ABRIR', etapaId: 'não-é-uuid' } })).toContain(
      'id de uma etapa',
    );
    expect(problema({ A: { acao: 'GANHO', motivoPerda: 'x' } })).toContain(
      'só vale na ação PERDIDO',
    );
    expect(problema({ A: { acao: 'PERDIDO', motivoPerda: ' ' } })).toContain(
      'motivoPerda',
    );
    expect(problema({ A: { acao: 'IGNORAR', etiquetas: ['x'] } })).toContain(
      'não leva etiquetas',
    );
    expect(problema({ A: { acao: 'GANHO', etiquetas: 'x' } })).toContain(
      'lista de textos',
    );
    const muitos = Object.fromEntries(
      Array.from({ length: 61 }, (_, i) => [`E${i}`, { acao: 'IGNORAR' }]),
    );
    expect(problema(muitos)).toContain('no máximo');
  });

  it('validarProdutos aparece sem repetidos, aceita números e recusa o que não é texto', () => {
    expect(
      validarProdutos([
        ' 1234567 ',
        'Curso Online BRL',
        'curso online brl',
        99,
      ]),
    ).toEqual({
      valor: ['1234567', 'Curso Online BRL', '99'],
    });
    expect(validarProdutos([])).toEqual({ valor: [] });
    expect(validarProdutos('x')).toHaveProperty('problema');
    expect(validarProdutos([''])).toHaveProperty('problema');
    expect(validarProdutos([{}])).toHaveProperty('problema');
  });

  it('o filtro compara id ou nome sem diferenciar maiúsculas; vazio deixa passar tudo', () => {
    const produtos = [{ id: '1234567', nome: 'Curso Online BRL' }];
    expect(produtoPassaNoFiltro([], produtos)).toBe(true);
    expect(produtoPassaNoFiltro([], [])).toBe(true);
    expect(produtoPassaNoFiltro(['1234567'], produtos)).toBe(true);
    expect(produtoPassaNoFiltro(['curso online brl'], produtos)).toBe(true);
    expect(produtoPassaNoFiltro(['outro'], produtos)).toBe(false);
    expect(produtoPassaNoFiltro(['1234567'], [])).toBe(false);
    expect(produtoPassaNoFiltro(['123'], [{ id: null, nome: null }])).toBe(
      false,
    );
  });

  it('a criação grava a tabela padrão sem sobrescrever a que o Admin mandou; mudar de funil limpa as etapas', () => {
    const definicao = adaptadorHotmart.definicao;
    const completa = completarConfiguracaoDeCurso(definicao, {});
    expect(Object.keys(completa.eventos as object)).toHaveLength(
      definicao.eventos!.eventos.length,
    );
    const propria = { eventos: { PURCHASE_APPROVED: { acao: 'GANHO' } } };
    expect(completarConfiguracaoDeCurso(definicao, propria)).toEqual(propria);
    // Aplicativo sem tabela de eventos não ganha nada.
    expect(
      completarConfiguracaoDeCurso(
        { eventos: undefined },
        { formularioId: 'x' },
      ),
    ).toEqual({ formularioId: 'x' });
    const etapaId = '11111111-2222-3333-4444-555555555555';
    const comEtapa = {
      eventos: { A: { acao: 'ABRIR', etapaId }, B: { acao: 'GANHO' } },
    };
    expect(etapasDosEventos(comEtapa)).toEqual([etapaId]);
    expect(etapasDosEventos(semEtapasDosEventos(comEtapa))).toEqual([]);
    expect(etapasDosEventos({})).toEqual([]);
  });
});
