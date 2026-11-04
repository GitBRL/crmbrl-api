import {
  DICA_ATUALIZACAO,
  ehObjeto,
  mapeamentoDe,
  regras,
  textoOuNulo,
} from './comum';
import {
  eventosDoAplicativo,
  evento,
  primeiroTexto,
  produtoDe,
  regra,
} from './cursos';
import { cabecalho, iguaisEmTempoConstante } from './seguranca';
import type {
  AdaptadorDeAplicativo,
  EntradaDeAutenticidade,
  ItemRecebido,
  ResultadoDeAutenticidade,
} from './tipos';

export const CABECALHO_DO_HOTMART = 'X-HOTMART-HOTTOK';

export const EVENTOS_DO_HOTMART = [
  evento(
    'PURCHASE_APPROVED',
    'Compra aprovada',
    'COMPRA',
    'O pagamento foi aprovado (também cada cobrança aprovada de uma assinatura).',
    regra('GANHO', ['comprou']),
  ),
  evento(
    'PURCHASE_COMPLETE',
    'Compra completa',
    'COMPRA',
    'O prazo de garantia terminou.',
    regra('IGNORAR'),
  ),
  evento(
    'PURCHASE_BILLET_PRINTED',
    'Boleto gerado',
    'PAGAMENTO_PENDENTE',
    'O comprador gerou o boleto e ainda não pagou (o Pix pendente pode chegar por aqui também).',
    regra('ABRIR', ['boleto-gerado']),
  ),
  evento(
    'PURCHASE_OUT_OF_SHOPPING_CART',
    'Carrinho abandonado',
    'CARRINHO',
    'O lead preencheu os dados no checkout e não comprou (verificado a cada 30 minutos). Sem valor, transação nem status.',
    regra('ABRIR', ['carrinho-abandonado']),
  ),
  evento(
    'PURCHASE_DELAYED',
    'Pagamento atrasado',
    'PAGAMENTO_PENDENTE',
    'A cobrança está em atraso.',
    regra('ETIQUETAR', ['pagamento-atrasado']),
  ),
  evento(
    'PURCHASE_EXPIRED',
    'Compra expirada',
    'PAGAMENTO_PENDENTE',
    'O prazo para pagar terminou.',
    regra('PERDIDO', ['compra-expirada'], 'Compra expirada'),
  ),
  evento(
    'PURCHASE_CANCELED',
    'Compra cancelada',
    'POS_VENDA',
    'A compra foi cancelada.',
    regra('PERDIDO', ['compra-cancelada'], 'Compra cancelada'),
  ),
  evento(
    'PURCHASE_PROTEST',
    'Compra em disputa',
    'POS_VENDA',
    'O comprador abriu uma disputa (protesto).',
    regra('ETIQUETAR', ['em-disputa']),
  ),
  evento(
    'PURCHASE_REFUNDED',
    'Compra reembolsada',
    'POS_VENDA',
    'O valor foi devolvido ao comprador.',
    regra('PERDIDO', ['reembolsado'], 'Reembolso'),
  ),
  evento(
    'PURCHASE_CHARGEBACK',
    'Chargeback',
    'POS_VENDA',
    'O comprador contestou a cobrança no cartão.',
    regra('PERDIDO', ['chargeback'], 'Chargeback'),
  ),
  evento(
    'SUBSCRIPTION_CANCELLATION',
    'Assinatura cancelada',
    'ASSINATURA',
    'O assinante (ou o produtor) cancelou a assinatura.',
    regra('ETIQUETAR', ['assinatura-cancelada']),
  ),
  evento(
    'SWITCH_PLAN',
    'Troca de plano',
    'ASSINATURA',
    'O assinante trocou de plano.',
    regra('ETIQUETAR', ['troca-de-plano']),
  ),
  evento(
    'UPDATE_SUBSCRIPTION_CHARGE_DATE',
    'Data de cobrança alterada',
    'ASSINATURA',
    'A data da próxima cobrança da assinatura mudou.',
    regra('IGNORAR'),
  ),
] as const;

/** O DDI + número do comprador (a Hotmart manda o código do país à parte). */
function telefoneDoComprador(corpo: unknown): string | null {
  const codigo = primeiroTexto(corpo, 'data.buyer.checkout_phone_code');
  const numero = primeiroTexto(corpo, 'data.buyer.checkout_phone');
  if (numero) {
    const digitos = numero.replace(/\D/g, '');
    if (!codigo || codigo === '55' || digitos.startsWith(codigo)) {
      return numero;
    }
    return `+${codigo}${digitos}`;
  }
  const ddd = primeiroTexto(corpo, 'data.subscriber.phone.dddCell');
  const celular = primeiroTexto(corpo, 'data.subscriber.phone.cell');
  if (celular) {
    return `${ddd ?? ''}${celular}`;
  }
  const fixo = primeiroTexto(corpo, 'data.subscriber.phone.phone');
  return fixo
    ? `${primeiroTexto(corpo, 'data.subscriber.phone.dddPhone') ?? ''}${fixo}`
    : null;
}

/**
 * Corpo da Hotmart (webhook 2.0.0): `{ id, creation_date, event, version, data }`.
 * O item é o corpo mais o bloco `calculado` (`telefone` com DDI e `transacao`).
 * Idempotência: o `id` do evento; sem ele, a transação mais o evento.
 */
export function normalizarHotmart(corpo: unknown): ItemRecebido[] {
  if (!ehObjeto(corpo)) {
    return [{ corpo, rotulo: null }];
  }
  const codigo = textoOuNulo(corpo.event)?.toUpperCase() ?? null;
  const id = textoOuNulo(corpo.id);
  const transacao = primeiroTexto(corpo, 'data.purchase.transaction');
  const chaveDoEvento = id
    ? `id:${id}`
    : transacao && codigo
      ? `transacao:${transacao}:${codigo}`
      : null;
  return [
    {
      corpo: {
        ...corpo,
        calculado: {
          telefone: telefoneDoComprador(corpo),
          transacao: transacao ?? primeiroTexto(corpo, 'data.subscription.id'),
        },
      },
      rotulo: null,
      chaveDoEvento,
      evento: codigo,
      produtos: produtoDe(
        primeiroTexto(corpo, 'data.product.id', 'data.product.ucode'),
        primeiroTexto(corpo, 'data.product.name'),
      ),
    },
  ];
}

/** O hottok vem no cabeçalho e é comparado direto (a Hotmart não usa HMAC). */
function verificar(entrada: EntradaDeAutenticidade): ResultadoDeAutenticidade {
  if (!entrada.segredo) {
    return { ok: true };
  }
  const recebido = cabecalho(entrada.cabecalhos, CABECALHO_DO_HOTMART);
  if (!recebido) {
    return {
      ok: false,
      mensagem: `Token ausente: a Hotmart envia o hottok no cabeçalho ${CABECALHO_DO_HOTMART}.`,
    };
  }
  return iguaisEmTempoConstante(recebido.trim(), entrada.segredo)
    ? { ok: true }
    : {
        ok: false,
        mensagem: `Token inválido: o cabeçalho ${CABECALHO_DO_HOTMART} não confere com o hottok da integração.`,
      };
}

export const adaptadorHotmart: AdaptadorDeAplicativo = {
  definicao: {
    aplicativo: 'HOTMART',
    nome: 'Hotmart',
    descricao:
      'Receba compras, boletos, carrinhos abandonados, reembolsos e assinaturas da Hotmart e escolha o que cada evento faz no funil.',
    disponivel: true,
    entrega: 'WEBHOOK',
    tiposDeConteudo: ['application/json'],
    autenticidade: {
      tipo: 'HOTMART_HOTTOK',
      descricao: `Opcional, mas recomendado: cole o hottok (o token do webhook da sua conta). A Hotmart o envia no cabeçalho ${CABECALHO_DO_HOTMART} e a integração recusa quem não o trouxer igual.`,
      segredo: 'OPCIONAL',
      rotuloDoSegredo: 'Hottok',
      cabecalho: CABECALHO_DO_HOTMART,
    },
    credencial: null,
    buscaCampos: false,
    escolheFormulario: false,
    passoAPasso: {
      titulo: 'Na Hotmart',
      passos: [
        'Entre na Hotmart e abra Ferramentas > Webhook (API e notificações) > "Configurar" ou "Cadastrar webhook".',
        'Dê um nome, escolha a versão 2.0.0, o produto (ou todos) e os eventos que quer enviar: compra aprovada, boleto impresso, carrinho abandonado, reembolso, chargeback, assinatura cancelada etc.',
        'Cole o endereço da integração no campo da URL e salve. A Hotmart mostra o hottok da conta nessa página: cole-o aqui no campo "Hottok" para o CRM recusar chamadas que não sejam dela.',
        'Use "Enviar teste" (ou faça uma compra de teste) e confira em "Histórico". A Hotmart reenvia automaticamente os envios que falham; o CRM ignora o evento repetido.',
        'No CRM, ajuste a tabela de eventos: o que cada evento faz (ignorar, abrir negócio na etapa X, ganho com valor, perdido com motivo ou só etiquetar) e, se quiser, filtre por produto.',
      ],
    },
    modelo: {
      nome: 'Hotmart',
      descricao:
        'Comprador (nome, e-mail, telefone), produto como título, valor da compra, origem (src e sck como UTM) e produto, oferta, transação e forma de pagamento como campos do negócio.',
      mapeamento: mapeamentoDe([
        ...regras('nome', 'data.buyer.name', 'data.subscriber.name'),
        ...regras('email', 'data.buyer.email', 'data.subscriber.email'),
        ...regras(
          'telefone',
          'calculado.telefone',
          'data.buyer.checkout_phone',
          'data.buyer.phone',
        ),
        ...regras('titulo', 'data.product.name'),
        ...regras('valor', 'data.purchase.price.value'),
        ...regras('utm.source', 'data.purchase.origin.src'),
        ...regras('utm.campaign', 'data.purchase.origin.sck'),
        ...regras('utm.content', 'data.purchase.origin.xcod'),
        ...regras('negocio.camposPersonalizados.produto', 'data.product.name'),
        ...regras(
          'negocio.camposPersonalizados.oferta',
          'data.purchase.offer.name',
          'data.offer.code',
        ),
        ...regras(
          'negocio.camposPersonalizados.transacao',
          'calculado.transacao',
        ),
        ...regras(
          'negocio.camposPersonalizados.forma_de_pagamento',
          'data.purchase.payment.type',
        ),
        ...regras(
          'negocio.camposPersonalizados.plano',
          'data.subscription.plan.name',
        ),
      ]),
      exemplo: {
        id: '1c1c0b5e-6bde-4f6e-9a47-2f1d3f5f8b10',
        event: 'PURCHASE_APPROVED',
        version: '2.0.0',
        data: {
          product: { id: 1234567, name: 'Curso Online BRL' },
          buyer: {
            name: 'Maria Souza',
            email: 'maria@empresa.com.br',
            checkout_phone: '11987654321',
            checkout_phone_code: '55',
          },
          purchase: {
            status: 'APPROVED',
            transaction: 'HP12345678901234',
            price: { value: 497, currency_value: 'BRL' },
            offer: { code: 'abc12345', name: 'Oferta principal' },
            payment: { type: 'CREDIT_CARD' },
            origin: { src: 'instagram', sck: 'black-friday' },
          },
        },
        calculado: { telefone: '11987654321', transacao: 'HP12345678901234' },
      },
    },
    dicas: [
      'O evento de carrinho abandonado não traz valor, transação nem status; só comprador (se o lead informou), produto e oferta.',
      'A Hotmart não manda UTMs: só src, sck e xcod (origem do link), mapeados como fonte, campanha e conteúdo.',
      DICA_ATUALIZACAO,
    ],
    eventos: eventosDoAplicativo(EVENTOS_DO_HOTMART, 'PURCHASE_APPROVED', [
      'PURCHASE_BILLET_PRINTED',
      'PURCHASE_OUT_OF_SHOPPING_CART',
    ]),
  },
  normalizarCorpo: normalizarHotmart,
  verificarAutenticidade: verificar,
};
