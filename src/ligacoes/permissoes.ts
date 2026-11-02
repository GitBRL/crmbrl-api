/**
 * Regras da permissão do cliente para ligar (R29), em funções puras — testadas
 * em `permissoes.spec.ts`. Limites da Meta (referência §3.3): 1 pedido por 24 h
 * e 2 por 7 dias por cliente; a permissão temporária vale 7 dias; 4 ligações
 * feitas seguidas sem resposta revogam.
 */
import type {
  SituacaoPermissaoLigacao,
  TipoPermissaoLigacao,
} from '../generated/prisma/client';
import {
  LIMITE_DE_PEDIDOS_24H,
  LIMITE_DE_PEDIDOS_7D,
  SEM_RESPOSTA_QUE_REVOGAM,
} from './ligacoes.constantes';

const HORA_MS = 60 * 60 * 1000;
export const DIA_MS = 24 * HORA_MS;
/** Validade da permissão temporária. */
export const VALIDADE_TEMPORARIA_MS = 7 * DIA_MS;

export interface AvaliacaoDePedido {
  pode: boolean;
  motivo: 'limite_24h' | 'limite_7d' | null;
  /** Quando o pedido volta a ser possível (nulo se já é possível). */
  liberaEm: Date | null;
  /** Pedidos nas últimas 24 h e nos últimos 7 dias (para mostrar "1 de 1"). */
  usoNas24h: number;
  usoNos7d: number;
  maximo24h: number;
  maximo7d: number;
}

/** Os pedidos já feitos deixam fazer mais um agora? */
export function avaliarPedido(
  pedidosEm: readonly Date[],
  agora: Date = new Date(),
): AvaliacaoDePedido {
  const momento = agora.getTime();
  const dos7 = pedidosEm
    .map((data) => data.getTime())
    .filter((t) => momento - t < 7 * DIA_MS)
    .sort((a, b) => a - b);
  const dos24 = dos7.filter((t) => momento - t < DIA_MS);
  let liberaEm: Date | null = null;
  let motivo: AvaliacaoDePedido['motivo'] = null;
  if (dos24.length >= LIMITE_DE_PEDIDOS_24H) {
    // Libera quando o mais antigo dentro da janela de 24 h sai dela.
    const base = dos24[dos24.length - LIMITE_DE_PEDIDOS_24H] as number;
    liberaEm = new Date(base + DIA_MS);
    motivo = 'limite_24h';
  }
  if (dos7.length >= LIMITE_DE_PEDIDOS_7D) {
    const base = dos7[dos7.length - LIMITE_DE_PEDIDOS_7D] as number;
    const libera7 = new Date(base + 7 * DIA_MS);
    if (!liberaEm || libera7 > liberaEm) {
      liberaEm = libera7;
      motivo = 'limite_7d';
    }
  }
  return {
    pode: motivo === null,
    motivo,
    liberaEm,
    usoNas24h: dos24.length,
    usoNos7d: dos7.length,
    maximo24h: LIMITE_DE_PEDIDOS_24H,
    maximo7d: LIMITE_DE_PEDIDOS_7D,
  };
}

/** Pedidos que ainda contam (os dos últimos 7 dias): o resto é descartado ao gravar. */
export function pedidosQueContam(
  pedidosEm: readonly Date[],
  agora: Date = new Date(),
): Date[] {
  return pedidosEm.filter(
    (data) => agora.getTime() - data.getTime() < 7 * DIA_MS,
  );
}

/** Situação para mostrar: a temporária vencida aparece como `EXPIRADA`. */
export type SituacaoExibida = SituacaoPermissaoLigacao | 'EXPIRADA';

export interface PermissaoGravada {
  situacao: SituacaoPermissaoLigacao;
  tipo: TipoPermissaoLigacao | null;
  validaAte: Date | null;
}

export function situacaoExibida(
  permissao: PermissaoGravada | null,
  agora: Date = new Date(),
): SituacaoExibida {
  if (!permissao) {
    return 'NENHUMA';
  }
  if (
    permissao.situacao === 'CONCEDIDA' &&
    permissao.tipo === 'TEMPORARIA' &&
    permissao.validaAte &&
    permissao.validaAte <= agora
  ) {
    return 'EXPIRADA';
  }
  return permissao.situacao;
}

/** Dá para ligar agora com o que o CRM sabe? (A Meta é consultada de novo antes de ligar.) */
export function podeLigarSegundoORegistro(
  permissao: PermissaoGravada | null,
  agora: Date = new Date(),
): boolean {
  return situacaoExibida(permissao, agora) === 'CONCEDIDA';
}

/** O resultado de mais uma ligação feita muda a contagem de "sem resposta seguidas". */
export function contarSemResposta(
  atual: number,
  desfecho: 'atendida' | 'sem_resposta' | 'ignorar',
): { total: number; revoga: boolean } {
  if (desfecho === 'ignorar') {
    return { total: atual, revoga: false };
  }
  if (desfecho === 'atendida') {
    return { total: 0, revoga: false };
  }
  const total = atual + 1;
  return { total, revoga: total >= SEM_RESPOSTA_QUE_REVOGAM };
}
