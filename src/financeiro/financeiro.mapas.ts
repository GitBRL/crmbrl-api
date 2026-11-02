/** Formatos de saída do Financeiro (valores em texto decimal, datas `AAAA-MM-DD`). */
import { formatarValor } from '../comum/dominio/dinheiro';
import type {
  Contato,
  Contrato,
  Empresa,
  Parcela,
  StatusParcela,
  Usuario,
} from '../generated/prisma/client';
import {
  deDataDoBanco,
  deDataDoBancoOuNulo,
  diasEntre,
  faixaDeAtraso,
} from './datas';
import type { FaixaDeAtraso } from './financeiro.constantes';

export function codigoDoContrato(numero: number): string {
  return `C-${String(numero).padStart(6, '0')}`;
}

type ContratoComRelacoes = Contrato & {
  empresa?: Pick<Empresa, 'id' | 'nome'> | null;
  contato?: Pick<Contato, 'id' | 'nome'> | null;
  responsavelCs?: Pick<Usuario, 'id' | 'nome'> | null;
  negocio?: { id: string; titulo: string } | null;
};

export interface ContratoDto {
  id: string;
  numero: number;
  codigo: string;
  empresa: { id: string; nome: string } | null;
  contato: { id: string; nome: string } | null;
  negocio: { id: string; titulo: string } | null;
  produto: string;
  descricao: string | null;
  valor: string;
  periodicidade: Contrato['periodicidade'];
  mrr: string;
  inicioEm: string;
  fimEm: string | null;
  renovacaoEm: string | null;
  renovacaoAutomatica: boolean;
  diaVencimento: number | null;
  status: Contrato['status'];
  responsavelCs: { id: string; nome: string } | null;
  canceladoEm: string | null;
  motivoCancelamento: string | null;
  encerradoEm: string | null;
  criadoEm: string;
  atualizadoEm: string;
  /** Quem vê pode alterar (gestão, ou CS da carteira). */
  podeEditar: boolean;
  /** Preenchidos só no detalhe. */
  resumoParcelas?: ResumoDasParcelas;
}

export interface ResumoDasParcelas {
  total: number;
  abertas: number;
  atrasadas: number;
  pagas: number;
  valorEmAberto: string;
  valorAtrasado: string;
  valorPago: string;
}

export function contratoParaDto(
  c: ContratoComRelacoes,
  podeEditar: boolean,
): ContratoDto {
  return {
    id: c.id,
    numero: c.numero,
    codigo: codigoDoContrato(c.numero),
    empresa: c.empresa ? { id: c.empresa.id, nome: c.empresa.nome } : null,
    contato: c.contato ? { id: c.contato.id, nome: c.contato.nome } : null,
    negocio: c.negocio ? { id: c.negocio.id, titulo: c.negocio.titulo } : null,
    produto: c.produto,
    descricao: c.descricao,
    valor: formatarValor(c.valor) ?? '0.00',
    periodicidade: c.periodicidade,
    mrr: formatarValor(c.mrr) ?? '0.00',
    inicioEm: deDataDoBanco(c.inicioEm),
    fimEm: deDataDoBancoOuNulo(c.fimEm),
    renovacaoEm: deDataDoBancoOuNulo(c.renovacaoEm),
    renovacaoAutomatica: c.renovacaoAutomatica,
    diaVencimento: c.diaVencimento,
    status: c.status,
    responsavelCs: c.responsavelCs
      ? { id: c.responsavelCs.id, nome: c.responsavelCs.nome }
      : null,
    canceladoEm: c.canceladoEm?.toISOString() ?? null,
    motivoCancelamento: c.motivoCancelamento,
    encerradoEm: c.encerradoEm?.toISOString() ?? null,
    criadoEm: c.criadoEm.toISOString(),
    atualizadoEm: c.atualizadoEm.toISOString(),
    podeEditar,
  };
}

/** ABERTO já vencido conta como ATRASADO mesmo antes de o job marcar. */
export function statusEfetivo(
  p: Pick<Parcela, 'status' | 'vencimento'>,
  hoje: string,
): StatusParcela {
  if (p.status === 'ABERTO' && deDataDoBanco(p.vencimento) < hoje) {
    return 'ATRASADO';
  }
  return p.status;
}

type ParcelaComRelacoes = Parcela & {
  contrato?: {
    id: string;
    numero: number;
    produto: string;
    responsavelCsId: string | null;
  } | null;
  contato?: Pick<Contato, 'id' | 'nome' | 'email' | 'telefone'> | null;
  empresa?: Pick<Empresa, 'id' | 'nome'> | null;
};

export interface ParcelaDto {
  id: string;
  numero: string;
  sequencia: number | null;
  contrato: { id: string; codigo: string; produto: string } | null;
  contato: {
    id: string;
    nome: string;
    email: string | null;
    telefone: string | null;
  } | null;
  empresa: { id: string; nome: string } | null;
  origem: Parcela['origem'];
  descricao: string | null;
  vencimento: string;
  vencimentoOriginal: string;
  valor: string;
  valorPago: string | null;
  status: StatusParcela;
  /** Status gravado; `status` já considera o vencimento. */
  statusGravado: StatusParcela;
  diasEmAtraso: number;
  faixaDeAtraso: FaixaDeAtraso | null;
  linkBoleto: string | null;
  linkPagamento: string | null;
  pix: string | null;
  pagoEm: string | null;
  formaPagamento: Parcela['formaPagamento'];
  baixaOrigem: string | null;
  renegociadaParaId: string | null;
  promessaAte: string | null;
  criadoEm: string;
  atualizadoEm: string;
  podeEditar: boolean;
}

export function parcelaParaDto(
  p: ParcelaComRelacoes,
  hoje: string,
  podeEditar: boolean,
): ParcelaDto {
  const efetivo = statusEfetivo(p, hoje);
  const dias =
    efetivo === 'ATRASADO' ? diasEntre(deDataDoBanco(p.vencimento), hoje) : 0;
  return {
    id: p.id,
    numero: p.numero,
    sequencia: p.sequencia,
    contrato: p.contrato
      ? {
          id: p.contrato.id,
          codigo: codigoDoContrato(p.contrato.numero),
          produto: p.contrato.produto,
        }
      : null,
    contato: p.contato
      ? {
          id: p.contato.id,
          nome: p.contato.nome,
          email: p.contato.email,
          telefone: p.contato.telefone,
        }
      : null,
    empresa: p.empresa ? { id: p.empresa.id, nome: p.empresa.nome } : null,
    origem: p.origem,
    descricao: p.descricao,
    vencimento: deDataDoBanco(p.vencimento),
    vencimentoOriginal: deDataDoBanco(p.vencimentoOriginal),
    valor: formatarValor(p.valor) ?? '0.00',
    valorPago: formatarValor(p.valorPago),
    status: efetivo,
    statusGravado: p.status,
    diasEmAtraso: dias,
    faixaDeAtraso: faixaDeAtraso(dias),
    linkBoleto: p.linkBoleto,
    linkPagamento: p.linkPagamento,
    pix: p.pix,
    pagoEm: deDataDoBancoOuNulo(p.pagoEm),
    formaPagamento: p.formaPagamento,
    baixaOrigem: p.baixaOrigem,
    renegociadaParaId: p.renegociadaParaId,
    promessaAte: deDataDoBancoOuNulo(p.promessaAte),
    criadoEm: p.criadoEm.toISOString(),
    atualizadoEm: p.atualizadoEm.toISOString(),
    podeEditar,
  };
}

/** `Contrato` incluído nas consultas de parcela. */
export const INCLUIR_PARCELA = {
  contrato: {
    select: { id: true, numero: true, produto: true, responsavelCsId: true },
  },
  contato: { select: { id: true, nome: true, email: true, telefone: true } },
  empresa: { select: { id: true, nome: true } },
} as const;

export const INCLUIR_CONTRATO = {
  empresa: { select: { id: true, nome: true } },
  contato: { select: { id: true, nome: true } },
  negocio: { select: { id: true, titulo: true } },
  responsavelCs: { select: { id: true, nome: true } },
} as const;
