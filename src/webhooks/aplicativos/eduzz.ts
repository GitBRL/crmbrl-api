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
  numeroDe,
  primeiroTexto,
  regra,
} from './cursos';
import { assinaturaHmac, cabecalho, iguaisEmTempoConstante } from './seguranca';
import type {
  AdaptadorDeAplicativo,
  EntradaDeAutenticidade,
  ItemRecebido,
  ProdutoDoItem,
  ResultadoDeAutenticidade,
} from './tipos';
import { lerCaminho } from '../entrada/mapeamento';

export const CABECALHO_DA_EDUZZ = 'x-signature';
export const EVENTO_DE_TESTE_DA_EDUZZ = 'ping';

export const EVENTOS_DA_EDUZZ = [
  evento(
    'myeduzz.invoice_paid',
    'Fatura paga',
    'COMPRA',
    'A fatura foi paga (compra aprovada).',
    regra('GANHO', ['comprou']),
  ),
  evento(
    'myeduzz.invoice_opened',
    'Fatura aberta',
    'PAGAMENTO_PENDENTE',
    'Uma fatura foi aberta para o comprador.',
    regra('ABRIR', ['fatura-aberta']),
  ),
  evento(
    'myeduzz.invoice_waiting_payment',
    'Aguardando pagamento',
    'PAGAMENTO_PENDENTE',
    'A fatura aguarda o pagamento: boleto ou Pix gerado.',
    regra('ABRIR', ['aguardando-pagamento']),
  ),
  evento(
    'myeduzz.invoice_scheduled',
    'Fatura agendada',
    'PAGAMENTO_PENDENTE',
    'A fatura está agendada para cobrança futura.',
    regra('IGNORAR'),
  ),
  evento(
    'myeduzz.invoice_recovering',
    'Fatura em recuperação',
    'PAGAMENTO_PENDENTE',
    'A Eduzz está tentando recuperar o pagamento.',
    regra('ETIQUETAR', ['em-recuperacao']),
  ),
  evento(
    'myeduzz.invoice_expired',
    'Fatura expirada',
    'PAGAMENTO_PENDENTE',
    'O prazo para pagar a fatura terminou.',
    regra('PERDIDO', ['fatura-expirada'], 'Fatura expirada'),
  ),
  evento(
    'myeduzz.invoice_canceled',
    'Fatura cancelada',
    'POS_VENDA',
    'A fatura foi cancelada.',
    regra('PERDIDO', ['fatura-cancelada'], 'Fatura cancelada'),
  ),
  evento(
    'myeduzz.invoice_waiting_refund',
    'Reembolso solicitado',
    'POS_VENDA',
    'O comprador pediu reembolso e ele ainda não foi concluído.',
    regra('ETIQUETAR', ['reembolso-solicitado']),
  ),
  evento(
    'myeduzz.invoice_refunded',
    'Fatura reembolsada',
    'POS_VENDA',
    'O valor foi devolvido ao comprador.',
    regra('PERDIDO', ['reembolsado'], 'Reembolso'),
  ),
  evento(
    'myeduzz.invoice_chargeback',
    'Chargeback',
    'POS_VENDA',
    'O comprador contestou a cobrança no cartão.',
    regra('PERDIDO', ['chargeback'], 'Chargeback'),
  ),
  evento(
    'myeduzz.invoice_negotiated',
    'Fatura negociada',
    'POS_VENDA',
    'A fatura foi renegociada.',
    regra('IGNORAR'),
  ),
  evento(
    'sun.cart_abandonment',
    'Carrinho abandonado',
    'CARRINHO',
    'O lead abandonou o carrinho sem concluir o pagamento. Sem fatura nem valor.',
    regra('ABRIR', ['carrinho-abandonado']),
  ),
  evento(
    'myeduzz.contract_created',
    'Assinatura criada',
    'ASSINATURA',
    'Um contrato (assinatura) foi criado. Pode vir sem dados do comprador.',
    regra('IGNORAR'),
  ),
  evento(
    'myeduzz.contract_canceled',
    'Assinatura cancelada',
    'ASSINATURA',
    'A assinatura foi cancelada (o CRM deduz do evento contract_updated com contract.status = canceled).',
    regra('ETIQUETAR', ['assinatura-cancelada']),
  ),
  evento(
    'myeduzz.contract_late',
    'Assinatura atrasada',
    'ASSINATURA',
    'A assinatura está atrasada, inadimplente ou suspensa (contract_updated com contract.status = late, defaulter ou suspended).',
    regra('ETIQUETAR', ['assinatura-atrasada']),
  ),
  evento(
    'myeduzz.contract_updated',
    'Assinatura atualizada',
    'ASSINATURA',
    'Outra mudança do contrato (por exemplo, voltou a ficar em dia).',
    regra('IGNORAR'),
  ),
  evento(
    'myeduzz.commission_processed',
    'Comissão processada',
    'COMPRA',
    'A comissão de uma venda foi processada.',
    regra('IGNORAR'),
  ),
] as const;

const STATUS_DE_CONTRATO_ATRASADO = new Set(['late', 'defaulter', 'suspended']);

/** O código do evento; `contract_updated` vira cancelada ou atrasada conforme `data.contract.status`. */
export function eventoDaEduzz(corpo: Record<string, unknown>): string | null {
  const bruto = textoOuNulo(corpo.event)?.toLowerCase() ?? null;
  if (bruto !== 'myeduzz.contract_updated') {
    return bruto;
  }
  const status = primeiroTexto(corpo, 'data.contract.status')?.toLowerCase();
  if (status === 'canceled') {
    return 'myeduzz.contract_canceled';
  }
  return status && STATUS_DE_CONTRATO_ATRASADO.has(status)
    ? 'myeduzz.contract_late'
    : bruto;
}

function ehPing(corpo: unknown): boolean {
  if (!ehObjeto(corpo)) {
    return false;
  }
  return (
    textoOuNulo(corpo.event)?.toLowerCase() === EVENTO_DE_TESTE_DA_EDUZZ ||
    primeiroTexto(corpo, 'data.message')?.toLowerCase() ===
      EVENTO_DE_TESTE_DA_EDUZZ
  );
}

function produtosDoCorpo(corpo: unknown): ProdutoDoItem[] {
  const produtos: ProdutoDoItem[] = [];
  for (const caminho of ['data.items', 'data.products']) {
    const lista = lerCaminho(corpo, caminho);
    if (Array.isArray(lista)) {
      for (const item of lista) {
        const id = primeiroTexto(item, 'productId', 'id');
        const nome = primeiroTexto(item, 'name');
        if (id || nome) {
          produtos.push({ id, nome });
        }
      }
    }
  }
  const carrinho = lerCaminho(corpo, 'data.productId');
  if (Array.isArray(carrinho)) {
    for (const id of carrinho) {
      const texto = textoOuNulo(id);
      if (texto) {
        produtos.push({ id: texto, nome: null });
      }
    }
  } else if (textoOuNulo(carrinho)) {
    produtos.push({ id: textoOuNulo(carrinho), nome: null });
  }
  return produtos;
}

/** O valor pago (quando há) ou o valor da fatura; a Eduzz manda em reais [INFERIDO]. */
function valorDaFatura(corpo: unknown): string | null {
  const pago = numeroDe(lerCaminho(corpo, 'data.paid.value'));
  if (pago !== null && pago > 0) {
    return pago.toFixed(2);
  }
  const preco = numeroDe(lerCaminho(corpo, 'data.price.value'));
  return preco !== null ? preco.toFixed(2) : null;
}

/**
 * Corpo da Eduzz: `{ id, event, data, sentDate }`. O item é o corpo mais o
 * bloco `calculado` (`valor` e `transacao`). Idempotência: o `id` do evento;
 * sem ele, `data.id` + evento.
 */
export function normalizarEduzz(corpo: unknown): ItemRecebido[] {
  if (!ehObjeto(corpo)) {
    return [{ corpo, rotulo: null }];
  }
  const codigo = eventoDaEduzz(corpo);
  const id = textoOuNulo(corpo.id);
  const dado = primeiroTexto(corpo, 'data.id');
  const chaveDoEvento = id
    ? `id:${id}`
    : dado && codigo
      ? `dado:${dado}:${codigo}`
      : null;
  return [
    {
      corpo: {
        ...corpo,
        calculado: {
          valor: valorDaFatura(corpo),
          transacao: primeiroTexto(
            corpo,
            'data.id',
            'data.contract.id',
            'data.transactionId',
          ),
        },
      },
      rotulo: null,
      chaveDoEvento,
      evento: codigo,
      produtos: produtosDoCorpo(corpo),
    },
  ];
}

/** `x-signature`: HMAC-SHA256 do corpo bruto com a chave de acesso, em hexadecimal ou base64 (e `sha256=` na frente é tolerado). */
function verificar(entrada: EntradaDeAutenticidade): ResultadoDeAutenticidade {
  if (!entrada.segredo) {
    return { ok: true };
  }
  const recebida = cabecalho(entrada.cabecalhos, CABECALHO_DA_EDUZZ);
  if (!recebida || recebida.trim() === '') {
    return {
      ok: false,
      mensagem: `Assinatura ausente: a Eduzz assina o envio no cabeçalho ${CABECALHO_DA_EDUZZ}.`,
    };
  }
  const assinatura = recebida.trim().replace(/^sha256=/i, '');
  const hexadecimal = assinaturaHmac(
    'sha256',
    entrada.segredo,
    entrada.corpoBruto,
    'hex',
  );
  const base64 = assinaturaHmac(
    'sha256',
    entrada.segredo,
    entrada.corpoBruto,
    'base64',
  );
  // As duas comparações sempre rodam (sem curto-circuito).
  const confereHex = iguaisEmTempoConstante(
    assinatura.toLowerCase(),
    hexadecimal,
  );
  const confereBase64 = iguaisEmTempoConstante(assinatura, base64);
  return confereHex || confereBase64
    ? { ok: true }
    : {
        ok: false,
        mensagem: `Assinatura inválida: o cabeçalho ${CABECALHO_DA_EDUZZ} não confere com a chave de acesso da integração.`,
      };
}

export const adaptadorEduzz: AdaptadorDeAplicativo = {
  definicao: {
    aplicativo: 'EDUZZ',
    nome: 'Eduzz',
    descricao:
      'Receba faturas, carrinhos abandonados e assinaturas da Eduzz e escolha o que cada evento faz no funil.',
    disponivel: true,
    entrega: 'WEBHOOK',
    tiposDeConteudo: ['application/json'],
    autenticidade: {
      tipo: 'EDUZZ_ASSINATURA',
      descricao: `Opcional, mas recomendado: informe a chave de acesso da configuração do webhook na Eduzz. A Eduzz assina o corpo (HMAC-SHA256, em hexadecimal ou base64) no cabeçalho ${CABECALHO_DA_EDUZZ} e a integração recusa assinatura ausente ou diferente. O evento de teste "ping" recebe resposta de sucesso sem ser processado.`,
      segredo: 'OPCIONAL',
      rotuloDoSegredo: 'Chave de acesso',
      cabecalho: CABECALHO_DA_EDUZZ,
    },
    credencial: null,
    buscaCampos: false,
    escolheFormulario: false,
    passoAPasso: {
      titulo: 'Na Eduzz',
      passos: [
        'No Console do Desenvolvedor da Eduzz, abra Configurações > Webhook e clique em "+ Nova configuração".',
        'Dê um nome, defina a chave de acesso (ela assina as mensagens: informe a mesma aqui), cole o endereço da integração como URL de destino e escolha os eventos: faturas (paga, aguardando pagamento, reembolsada, chargeback…), carrinho abandonado e contratos.',
        'Valide a URL: a Eduzz envia o evento "ping" e espera uma resposta 200 a 299, que o CRM dá sem processar nada.',
        'Se a Eduzz pedir os produtos, escolha os específicos ou todos. Em "Histórico", reenvie os que falharam: o CRM ignora o evento repetido.',
        'No CRM, ajuste a tabela de eventos (ignorar, abrir negócio na etapa X, ganho com valor, perdido com motivo ou só etiquetar) e, se quiser, filtre por produto.',
      ],
    },
    modelo: {
      nome: 'Eduzz',
      descricao:
        'Comprador (buyer, ou customer no carrinho), produto como título, valor pago ou da fatura, UTMs e produto, oferta, transação e forma de pagamento como campos do negócio.',
      mapeamento: mapeamentoDe([
        ...regras('nome', 'data.buyer.name', 'data.customer.name'),
        ...regras('email', 'data.buyer.email', 'data.customer.email'),
        ...regras(
          'telefone',
          'data.buyer.cellphone',
          'data.buyer.phone',
          'data.buyer.phone2',
          'data.customer.phone',
        ),
        ...regras('titulo', 'data.items.0.name', 'data.products.0.name'),
        ...regras('valor', 'calculado.valor'),
        ...regras('utm.source', 'data.utm.source', 'data.tracker.utmSource'),
        ...regras('utm.medium', 'data.utm.medium', 'data.tracker.utmMedium'),
        ...regras(
          'utm.campaign',
          'data.utm.campaign',
          'data.tracker.utmCampaign',
        ),
        ...regras('utm.content', 'data.utm.content', 'data.tracker.utmContent'),
        ...regras('utm.term', 'data.utm.term'),
        ...regras(
          'negocio.camposPersonalizados.produto',
          'data.items.0.name',
          'data.products.0.name',
        ),
        ...regras('negocio.camposPersonalizados.oferta', 'data.offer.name'),
        ...regras(
          'negocio.camposPersonalizados.transacao',
          'calculado.transacao',
        ),
        ...regras(
          'negocio.camposPersonalizados.forma_de_pagamento',
          'data.paymentMethod',
        ),
        ...regras(
          'negocio.camposPersonalizados.plano',
          'data.products.0.plan.name',
        ),
      ]),
      exemplo: {
        id: '3f0f6a8e-2f6b-4e0f-9a31-6c1c0b0a7f21',
        event: 'myeduzz.invoice_paid',
        sentDate: '2026-11-04T12:00:00.000Z',
        data: {
          id: '9001',
          status: 'paid',
          buyer: {
            name: 'Maria Souza',
            email: 'maria@empresa.com.br',
            cellphone: '(11) 98765-4321',
          },
          items: [
            {
              productId: '123456',
              name: 'Curso Online BRL',
              price: { currency: 'BRL', value: 497 },
            },
          ],
          offer: { name: 'Oferta principal' },
          price: { currency: 'BRL', value: 497 },
          paid: { currency: 'BRL', value: 497 },
          paymentMethod: 'creditCard',
          utm: { source: 'instagram', campaign: 'black-friday' },
        },
        calculado: { valor: '497.00', transacao: '9001' },
      },
    },
    dicas: [
      'O carrinho abandonado (sun.cart_abandonment) traz o comprador em data.customer e só os ids dos produtos (data.productId); as UTMs ficam em data.tracker.',
      'A Eduzz não tem evento próprio de assinatura cancelada: o CRM a deduz do contract_updated com contract.status = canceled (e deduz atrasada de late, defaulter ou suspended).',
      DICA_ATUALIZACAO,
    ],
    eventos: eventosDoAplicativo(EVENTOS_DA_EDUZZ, 'myeduzz.invoice_paid', [
      'myeduzz.invoice_opened',
      'myeduzz.invoice_waiting_payment',
      'sun.cart_abandonment',
    ]),
  },
  normalizarCorpo: normalizarEduzz,
  verificarAutenticidade: verificar,
  /** `data.producer.originSecret` é o token de segurança da Eduzz: não vai para o histórico. */
  ocultarSegredosDoCorpo(corpo) {
    if (
      !ehObjeto(corpo) ||
      !ehObjeto(corpo.data) ||
      !ehObjeto(corpo.data.producer) ||
      !('originSecret' in corpo.data.producer)
    ) {
      return corpo;
    }
    return {
      ...corpo,
      data: {
        ...corpo.data,
        producer: { ...corpo.data.producer, originSecret: '[omitido]' },
      },
    };
  },
  respostaSemProcessar(corpo) {
    return ehPing(corpo)
      ? 'Evento de teste (ping) da Eduzz: respondido com sucesso, nada foi processado.'
      : null;
  },
};
