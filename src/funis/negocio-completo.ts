/**
 * O negócio como os serviços dos funis o carregam (com funil, etapa, contato,
 * empresa e responsável) e as derivações que dependem só dele: status pela
 * etapa (R5.3), tempo na etapa e "parado" (R5.10).
 */
import type {
  Prisma,
  StatusNegocio,
  TipoEtapa,
} from '../generated/prisma/client';

/** `include` padrão de um negócio: o que o cartão e o detalhe mostram. */
export const INCLUIR_NEGOCIO = {
  funil: {
    select: {
      id: true,
      nome: true,
      area: true,
      ativo: true,
      visibilidade: true,
    },
  },
  etapa: {
    select: {
      id: true,
      nome: true,
      tipo: true,
      ordem: true,
      prazoDias: true,
      probabilidade: true,
    },
  },
  contato: {
    select: {
      id: true,
      nome: true,
      email: true,
      telefone: true,
      etiquetas: true,
      empresaId: true,
    },
  },
  empresa: { select: { id: true, nome: true } },
  responsavel: { select: { id: true, nome: true, avatarUrl: true } },
  primeiraInteracaoPor: { select: { id: true, nome: true, avatarUrl: true } },
} satisfies Prisma.NegocioInclude;

export type NegocioCompleto = Prisma.NegocioGetPayload<{
  include: typeof INCLUIR_NEGOCIO;
}>;

const RESUMO_ETAPA = {
  select: { id: true, nome: true, tipo: true, ordem: true },
} as const;

/** `include` de uma movimentação no histórico (R5.4). */
export const INCLUIR_MOVIMENTACAO = {
  deEtapa: RESUMO_ETAPA,
  paraEtapa: RESUMO_ETAPA,
  usuario: { select: { id: true, nome: true, avatarUrl: true } },
} satisfies Prisma.NegocioMovimentacaoInclude;

export type MovimentacaoCompleta = Prisma.NegocioMovimentacaoGetPayload<{
  include: typeof INCLUIR_MOVIMENTACAO;
}>;

const MS_POR_DIA = 86_400_000;

/** R5.3: o status do negócio deriva do tipo da etapa. */
export function statusDaEtapa(tipo: TipoEtapa): StatusNegocio {
  switch (tipo) {
    case 'GANHO':
      return 'GANHO';
    case 'PERDIDO':
      return 'PERDIDO';
    default:
      return 'ABERTO';
  }
}

/** Dias inteiros desde que o negócio entrou na etapa atual. */
export function diasNaEtapa(etapaDesde: Date, agora: Date): number {
  return Math.max(
    0,
    Math.floor((agora.getTime() - etapaDesde.getTime()) / MS_POR_DIA),
  );
}

/**
 * R5.10: negócio aberto está **parado** quando o tempo na etapa passou do
 * prazo-alvo dela. Etapa sem prazo nunca deixa o negócio parado.
 */
export function estaParado(
  negocio: {
    readonly status: StatusNegocio;
    readonly etapaDesde: Date;
  },
  prazoDias: number | null,
  agora: Date,
): boolean {
  if (negocio.status !== 'ABERTO' || prazoDias === null) {
    return false;
  }
  return (
    agora.getTime() - negocio.etapaDesde.getTime() > prazoDias * MS_POR_DIA
  );
}

/** Limite de `etapaDesde` abaixo do qual um negócio aberto na etapa está parado. */
export function limiteDeParado(prazoDias: number, agora: Date): Date {
  return new Date(agora.getTime() - prazoDias * MS_POR_DIA);
}

/** Data (sem hora) do Prisma (`@db.Date`) → `'2026-10-31'`. */
export function formatarDataSemHora(data: Date | null): string | null {
  return data ? data.toISOString().slice(0, 10) : null;
}

/** `'2026-10-31'` → `Date` à meia-noite UTC (como o Postgres guarda `date`). */
export function lerDataSemHora(texto: string): Date {
  return new Date(`${texto}T00:00:00.000Z`);
}
