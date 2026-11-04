import {
  DICA_ATUALIZACAO,
  ehObjeto,
  mapeamentoDe,
  regras,
  textoOuNulo,
  utmsDeCaminhos,
} from './comum';
import {
  eventosDoAplicativo,
  evento,
  numeroDe,
  primeiroTexto,
  produtoDe,
  reaisDeCentavos,
  regra,
} from './cursos';
import { assinaturaHmac, iguaisEmTempoConstante } from './seguranca';
import type {
  AdaptadorDeAplicativo,
  EntradaDeAutenticidade,
  ItemRecebido,
  ResultadoDeAutenticidade,
} from './tipos';
import { lerCaminho } from '../entrada/mapeamento';

export const PARAMETRO_DA_KIWIFY = 'signature';
/** O carrinho abandonado não traz `webhook_event_type`: o CRM o chama assim. */
export const EVENTO_DO_CARRINHO_DA_KIWIFY = 'abandoned_cart';

export const EVENTOS_DA_KIWIFY = [
  evento(
    'order_approved',
    'Compra aprovada',
    'COMPRA',
    'O pagamento foi aprovado (compra_aprovada na Kiwify).',
    regra('GANHO', ['comprou']),
  ),
  evento(
    'billet_created',
    'Boleto gerado',
    'PAGAMENTO_PENDENTE',
    'O comprador gerou o boleto e ainda não pagou (boleto_gerado).',
    regra('ABRIR', ['boleto-gerado']),
  ),
  evento(
    'pix_created',
    'Pix gerado',
    'PAGAMENTO_PENDENTE',
    'O comprador gerou o Pix e ainda não pagou (pix_gerado).',
    regra('ABRIR', ['pix-gerado']),
  ),
  evento(
    'order_rejected',
    'Compra recusada',
    'PAGAMENTO_PENDENTE',
    'O pagamento foi recusado, em geral o cartão (compra_recusada). Boa oportunidade de recuperação.',
    regra('ABRIR', ['compra-recusada']),
  ),
  evento(
    EVENTO_DO_CARRINHO_DA_KIWIFY,
    'Carrinho abandonado',
    'CARRINHO',
    'O lead iniciou o checkout e não comprou (carrinho_abandonado). O formato é próprio, sem order_id.',
    regra('ABRIR', ['carrinho-abandonado']),
  ),
  evento(
    'order_refunded',
    'Compra reembolsada',
    'POS_VENDA',
    'O valor foi devolvido (compra_reembolsada).',
    regra('PERDIDO', ['reembolsado'], 'Reembolso'),
  ),
  evento(
    'chargeback',
    'Chargeback',
    'POS_VENDA',
    'O comprador contestou a cobrança no cartão.',
    regra('PERDIDO', ['chargeback'], 'Chargeback'),
  ),
  evento(
    'subscription_canceled',
    'Assinatura cancelada',
    'ASSINATURA',
    'A assinatura foi cancelada (também depois de reembolso ou chargeback de uma cobrança).',
    regra('ETIQUETAR', ['assinatura-cancelada']),
  ),
  evento(
    'subscription_late',
    'Assinatura atrasada',
    'ASSINATURA',
    'Uma cobrança da assinatura está em atraso.',
    regra('ETIQUETAR', ['assinatura-atrasada']),
  ),
  evento(
    'subscription_renewed',
    'Assinatura renovada',
    'ASSINATURA',
    'A assinatura foi renovada (nova cobrança paga).',
    regra('ETIQUETAR', ['assinatura-renovada']),
  ),
] as const;

const EVENTO_PELO_STATUS: Readonly<Record<string, string>> = {
  paid: 'order_approved',
  refused: 'order_rejected',
  refunded: 'order_refunded',
  chargedback: 'chargeback',
};

/** O código do evento: `webhook_event_type`; sem ele, deduzido do status; sem status, é o carrinho abandonado. */
export function eventoDaKiwify(corpo: Record<string, unknown>): string | null {
  const tipo = textoOuNulo(corpo.webhook_event_type);
  if (tipo) {
    return tipo.toLowerCase();
  }
  const status = textoOuNulo(corpo.order_status)?.toLowerCase();
  if (status) {
    if (EVENTO_PELO_STATUS[status]) {
      return EVENTO_PELO_STATUS[status];
    }
    if (status === 'waiting_payment') {
      const metodo = textoOuNulo(corpo.payment_method)?.toLowerCase();
      return metodo === 'pix'
        ? 'pix_created'
        : metodo === 'boleto'
          ? 'billet_created'
          : null;
    }
    return null;
  }
  return textoOuNulo(corpo.order_id) ? null : EVENTO_DO_CARRINHO_DA_KIWIFY;
}

/** O valor em reais: os valores da Kiwify vêm em centavos [INFERIDO] (`Commissions.charge_amount` ou `payment.charge_amount`). */
function valorEmReais(corpo: unknown): string | null {
  for (const caminho of [
    'Commissions.charge_amount',
    'commissions.charge_amount',
    'payment.charge_amount',
  ]) {
    const centavos = numeroDe(lerCaminho(corpo, caminho));
    if (centavos !== null) {
      return reaisDeCentavos(centavos);
    }
  }
  return null;
}

const CAMINHOS_DO_PRODUTO_ID = [
  'Product.product_id',
  'product.id',
  'product_id',
];
const CAMINHOS_DO_PRODUTO_NOME = [
  'Product.product_name',
  'product.name',
  'product_name',
];

/**
 * Corpo da Kiwify: `webhook_event_type`, `order_id`, `order_status`, `Customer`,
 * `Product`, `Commissions` e `TrackingParameters` (as chaves exatas são
 * [INFERIDAS]; o objeto minúsculo da API de vendas também vale). Idempotência:
 * `order_id` + `webhook_event_type` (no carrinho, o `id`).
 */
export function normalizarKiwify(corpo: unknown): ItemRecebido[] {
  if (!ehObjeto(corpo)) {
    return [{ corpo, rotulo: null }];
  }
  const codigo = eventoDaKiwify(corpo);
  const pedido = textoOuNulo(corpo.order_id);
  const chaveDoEvento =
    pedido && codigo
      ? `pedido:${pedido}:${codigo}`
      : codigo === EVENTO_DO_CARRINHO_DA_KIWIFY && textoOuNulo(corpo.id)
        ? `carrinho:${textoOuNulo(corpo.id)}`
        : null;
  return [
    {
      corpo: {
        ...corpo,
        calculado: {
          valor: valorEmReais(corpo),
          transacao: pedido ?? textoOuNulo(corpo.id),
        },
      },
      rotulo: null,
      chaveDoEvento,
      evento: codigo,
      produtos: produtoDe(
        primeiroTexto(corpo, ...CAMINHOS_DO_PRODUTO_ID),
        primeiroTexto(corpo, ...CAMINHOS_DO_PRODUTO_NOME),
      ),
    },
  ];
}

/** `?signature=` é o HMAC-SHA1 (hexadecimal) do corpo bruto com o token do webhook como chave. */
function verificar(entrada: EntradaDeAutenticidade): ResultadoDeAutenticidade {
  if (!entrada.segredo) {
    return { ok: true };
  }
  const bruto = entrada.query[PARAMETRO_DA_KIWIFY];
  const recebida = (Array.isArray(bruto) ? bruto[0] : bruto) as unknown;
  if (typeof recebida !== 'string' || recebida.trim() === '') {
    return {
      ok: false,
      mensagem: `Assinatura ausente: a Kiwify acrescenta o parâmetro ${PARAMETRO_DA_KIWIFY} ao endereço quando o webhook tem token.`,
    };
  }
  const esperada = assinaturaHmac(
    'sha1',
    entrada.segredo,
    entrada.corpoBruto,
    'hex',
  );
  return iguaisEmTempoConstante(recebida.trim().toLowerCase(), esperada)
    ? { ok: true }
    : {
        ok: false,
        mensagem:
          'Assinatura inválida: o parâmetro signature não confere com o token da integração.',
      };
}

export const adaptadorKiwify: AdaptadorDeAplicativo = {
  definicao: {
    aplicativo: 'KIWIFY',
    nome: 'Kiwify',
    descricao:
      'Receba vendas, Pix e boletos gerados, carrinhos abandonados, reembolsos e assinaturas da Kiwify e escolha o que cada evento faz no funil.',
    disponivel: true,
    entrega: 'WEBHOOK',
    tiposDeConteudo: ['application/json'],
    autenticidade: {
      tipo: 'KIWIFY_ASSINATURA',
      descricao: `Opcional, mas recomendado: defina um token no webhook da Kiwify e informe o mesmo aqui. A Kiwify acrescenta ao endereço o parâmetro ${PARAMETRO_DA_KIWIFY} (HMAC-SHA1 em hexadecimal do corpo, com o token como chave) e a integração recusa assinatura ausente ou diferente.`,
      segredo: 'OPCIONAL',
      rotuloDoSegredo: 'Token do webhook',
      cabecalho: null,
    },
    credencial: null,
    buscaCampos: false,
    escolheFormulario: false,
    passoAPasso: {
      titulo: 'Na Kiwify',
      passos: [
        'Na Kiwify, abra Apps > Webhooks e clique em "Criar Webhook".',
        'No painel lateral, escolha o produto (ou todos), os eventos (compra aprovada, boleto gerado, Pix gerado, compra recusada, carrinho abandonado, reembolso, chargeback, assinatura cancelada, atrasada e renovada), cole o endereço da integração e defina um token. Informe o mesmo token aqui.',
        'Clique em "Criar" e use "Testar Webhook" (com dados fictícios) para ver o recebimento aqui. Em "Ver logs" você reenvia os que falharam: o CRM ignora o evento repetido.',
        'A Kiwify não tem lista pública de campos do webhook de venda: depois do teste, use "Atualizar campos recebidos" para conferir o mapeamento.',
        'No CRM, ajuste a tabela de eventos (ignorar, abrir negócio na etapa X, ganho com valor, perdido com motivo ou só etiquetar) e, se quiser, filtre por produto.',
      ],
    },
    modelo: {
      nome: 'Kiwify',
      descricao:
        'Comprador (Customer), produto como título, valor da venda (de centavos para reais), UTMs (TrackingParameters) e produto, transação, forma de pagamento e plano como campos do negócio. Aceita também as chaves minúsculas do objeto de venda da API.',
      mapeamento: mapeamentoDe([
        ...regras(
          'nome',
          'Customer.full_name',
          'Customer.name',
          'customer.name',
          'name',
        ),
        ...regras('email', 'Customer.email', 'customer.email', 'email'),
        ...regras(
          'telefone',
          'Customer.mobile',
          'customer.mobile',
          'Customer.phone',
          'phone',
        ),
        ...regras('titulo', ...CAMINHOS_DO_PRODUTO_NOME),
        ...regras('valor', 'calculado.valor'),
        ...utmsDeCaminhos('TrackingParameters.'),
        ...utmsDeCaminhos('tracking.'),
        ...regras('utm.source', 'TrackingParameters.src', 'tracking.src'),
        ...regras('utm.campaign', 'TrackingParameters.sck', 'tracking.sck'),
        ...regras(
          'negocio.camposPersonalizados.produto',
          ...CAMINHOS_DO_PRODUTO_NOME,
        ),
        ...regras(
          'negocio.camposPersonalizados.transacao',
          'calculado.transacao',
        ),
        ...regras(
          'negocio.camposPersonalizados.forma_de_pagamento',
          'payment_method',
        ),
        ...regras(
          'negocio.camposPersonalizados.plano',
          'Subscription.plan.name',
        ),
      ]),
      exemplo: {
        order_id: 'b6c2f3a0-7d3e-4a5b-8f10-0c9d7e6a1234',
        order_status: 'paid',
        webhook_event_type: 'order_approved',
        payment_method: 'credit_card',
        Customer: {
          full_name: 'Maria Souza',
          email: 'maria@empresa.com.br',
          mobile: '+5511987654321',
        },
        Product: { product_id: 'e1f2', product_name: 'Curso Online BRL' },
        Commissions: { charge_amount: 49700, currency: 'BRL' },
        TrackingParameters: {
          utm_source: 'instagram',
          utm_campaign: 'black-friday',
        },
        calculado: {
          valor: '497.00',
          transacao: 'b6c2f3a0-7d3e-4a5b-8f10-0c9d7e6a1234',
        },
      },
    },
    dicas: [
      'Os valores da Kiwify chegam em centavos: o modelo divide por 100 e usa o resultado em calculado.valor.',
      'O carrinho abandonado tem formato próprio (sem order_id, sem order_status e sem webhook_event_type): nome, e-mail, telefone e produto vêm na raiz.',
      'Reembolso e chargeback de uma cobrança de assinatura cancelam a assinatura: chegam também como assinatura cancelada.',
      DICA_ATUALIZACAO,
    ],
    eventos: eventosDoAplicativo(EVENTOS_DA_KIWIFY, 'order_approved', [
      'billet_created',
      'pix_created',
      'order_rejected',
      EVENTO_DO_CARRINHO_DA_KIWIFY,
    ]),
  },
  normalizarCorpo: normalizarKiwify,
  verificarAutenticidade: verificar,
};
