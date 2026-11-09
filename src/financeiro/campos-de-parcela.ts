/**
 * Importação de parcelas (R22.5): campos da planilha, sugestão pelo nome da coluna
 * e leitura tolerante dos valores (datas dd/mm/aaaa, valores 1.234,56, situações).
 * Funções puras.
 */
import type { CampoDeImportacao } from '../importacao/campos';
import type { FormaPagamento } from '../generated/prisma/client';
import { ehDataIso } from './datas';

export const CAMPOS_DE_PARCELA: readonly CampoDeImportacao[] = [
  {
    chave: 'numero',
    rotulo: 'Número do título',
    obrigatorio: true,
    sinonimos: [
      'numero',
      'numero do titulo',
      'titulo',
      'n titulo',
      'nosso numero',
      'id',
      'codigo',
      'parcela',
      'fatura',
      'documento',
    ],
  },
  {
    chave: 'nome',
    rotulo: 'Cliente',
    sinonimos: [
      'cliente',
      'nome',
      'nome do cliente',
      'razao social',
      'pagador',
      'sacado',
    ],
  },
  {
    chave: 'telefone',
    rotulo: 'Telefone',
    sinonimos: ['telefone', 'celular', 'whatsapp', 'fone', 'tel', 'phone'],
  },
  { chave: 'email', rotulo: 'E-mail', sinonimos: ['email', 'e mail', 'mail'] },
  {
    chave: 'empresa',
    rotulo: 'Empresa',
    sinonimos: ['empresa', 'company', 'organizacao'],
  },
  {
    chave: 'contrato',
    rotulo: 'Contrato (C-000012)',
    sinonimos: [
      'contrato',
      'contrato c 000012',
      'codigo do contrato',
      'n contrato',
    ],
  },
  {
    chave: 'vencimento',
    rotulo: 'Vencimento',
    sinonimos: [
      'vencimento',
      'data de vencimento',
      'vence em',
      'due date',
      'data vencimento',
    ],
  },
  {
    chave: 'valor',
    rotulo: 'Valor',
    sinonimos: [
      'valor',
      'valor do titulo',
      'valor total',
      'amount',
      'valor parcela',
    ],
  },
  {
    chave: 'status',
    rotulo: 'Situação',
    sinonimos: ['status', 'situacao', 'estado'],
  },
  {
    chave: 'pagoEm',
    rotulo: 'Data do pagamento',
    sinonimos: [
      'data do pagamento',
      'pago em',
      'data pagamento',
      'pagamento',
      'data de pagamento',
      'data baixa',
    ],
  },
  {
    chave: 'valorPago',
    rotulo: 'Valor pago',
    sinonimos: ['valor pago', 'valor recebido', 'recebido'],
  },
  {
    chave: 'formaPagamento',
    rotulo: 'Forma de pagamento',
    sinonimos: [
      'forma de pagamento',
      'forma pagamento',
      'meio de pagamento',
      'forma',
    ],
  },
  {
    chave: 'linkBoleto',
    rotulo: 'Link do boleto',
    sinonimos: [
      'link do boleto',
      'boleto',
      'link boleto',
      'url do boleto',
      'url boleto',
    ],
  },
  {
    chave: 'linkPagamento',
    rotulo: 'Link de pagamento',
    sinonimos: [
      'link de pagamento',
      'link pagamento',
      'url de pagamento',
      'link para pagamento',
      'checkout',
    ],
  },
  {
    chave: 'pix',
    rotulo: 'Pix copia e cola',
    sinonimos: [
      'pix',
      'pix copia e cola',
      'chave pix',
      'codigo pix',
      'copia e cola',
    ],
  },
  {
    chave: 'descricao',
    rotulo: 'Descrição',
    sinonimos: ['descricao', 'observacao', 'historico', 'referencia'],
  },
];

/** Valor em reais de uma célula (`R$ 1.234,56`, `1234.56`, `1.234,5`); `null` se não for número. */
export function lerValorDaPlanilha(texto: string): string | null {
  let t = texto.replace(/[R$\s]/gi, '');
  if (t === '' || !/^-?[\d.,]+$/.test(t)) return null;
  const virgula = t.lastIndexOf(',');
  const ponto = t.lastIndexOf('.');
  if (virgula > ponto) {
    t = t.replace(/\./g, '').replace(',', '.');
  } else if (
    virgula === -1 &&
    ponto !== -1 &&
    (t.indexOf('.') !== ponto || /^\d{1,3}\.\d{3}$/.test(t))
  ) {
    // Pontos como separador de milhar (1.234 ou 1.234.567).
    t = t.replace(/\./g, '');
  } else {
    t = t.replace(/,/g, '');
  }
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0) return null;
  const fixo = n.toFixed(2);
  return /^\d{1,12}\.\d{2}$/.test(fixo) ? fixo : null;
}

/** Data `AAAA-MM-DD` ou `dd/mm/aaaa` (também `dd-mm-aaaa`); `null` se inválida. */
export function lerDataDaPlanilha(texto: string): string | null {
  const t = texto.trim().slice(0, 10);
  if (ehDataIso(t)) return t;
  const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(
    texto.trim().slice(0, 10),
  );
  if (!m) return null;
  const iso = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return ehDataIso(iso) ? iso : null;
}

function semAcento(t: string): string {
  return t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

export type SituacaoDaPlanilha = 'PAGO' | 'CANCELADO' | 'ABERTO';

/** Situação escrita na planilha → o que o Financeiro faz. `null` = não reconhecida. */
export function lerSituacaoDaPlanilha(
  texto: string,
): SituacaoDaPlanilha | null {
  const t = semAcento(texto);
  if (
    [
      'pago',
      'paga',
      'pagou',
      'quitado',
      'quitada',
      'liquidado',
      'liquidada',
      'baixado',
      'baixada',
      'recebido',
      'recebida',
      'paid',
    ].includes(t)
  )
    return 'PAGO';
  if (['cancelado', 'cancelada', 'canceled', 'cancelled'].includes(t))
    return 'CANCELADO';
  if (
    [
      'aberto',
      'aberta',
      'em aberto',
      'pendente',
      'atrasado',
      'atrasada',
      'vencido',
      'vencida',
      'a receber',
      'open',
      'overdue',
    ].includes(t)
  )
    return 'ABERTO';
  return null;
}

export function lerFormaDePagamento(texto: string): FormaPagamento | null {
  const t = semAcento(texto);
  if (t.includes('pix')) return 'PIX';
  if (t.includes('boleto')) return 'BOLETO';
  if (t.includes('cartao') || t.includes('credito') || t.includes('debito'))
    return 'CARTAO';
  if (t.includes('transf') || t === 'ted' || t === 'doc')
    return 'TRANSFERENCIA';
  if (t.includes('dinheiro') || t.includes('especie')) return 'DINHEIRO';
  return t === '' ? null : 'OUTRO';
}
