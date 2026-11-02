import type { Prisma } from '../generated/prisma/client';
import type { LigacaoDto } from './ligacoes.dto';
import { textoDoMotivo } from './ligacoes.constantes';

/** O que a ligação carrega junto para o softphone e o histórico. */
export const INCLUIR_LIGACAO = {
  canal: { select: { id: true, nome: true } },
  contato: {
    select: {
      id: true,
      nome: true,
      telefone: true,
      empresa: { select: { nome: true } },
    },
  },
  atendente: { select: { id: true, nome: true } },
} satisfies Prisma.LigacaoInclude;

export type LigacaoCompleta = Prisma.LigacaoGetPayload<{
  include: typeof INCLUIR_LIGACAO;
}>;

const iso = (data: Date | null): string | null => data?.toISOString() ?? null;

/**
 * A ligação como a API devolve. As SDPs só saem para quem precisa delas e
 * enquanto a ligação ainda as usa: a oferta, para quem foi chamado a atender;
 * a resposta, para o atendente que ligou.
 */
export function paraLigacaoDto(
  ligacao: LigacaoCompleta,
  usuarioId: string | null,
): LigacaoDto {
  const chamado = !!usuarioId && ligacao.tocouPara.includes(usuarioId);
  const mostraOferta =
    ligacao.direcao === 'RECEBIDA' &&
    ligacao.estado === 'TOCANDO' &&
    chamado &&
    (ligacao.atendenteId === null || ligacao.atendenteId === usuarioId);
  const mostraResposta =
    ligacao.direcao === 'FEITA' &&
    (ligacao.estado === 'CHAMANDO' || ligacao.estado === 'TOCANDO') &&
    ligacao.atendenteId === usuarioId;
  return {
    id: ligacao.id,
    direcao: ligacao.direcao,
    estado: ligacao.estado,
    motivo: ligacao.motivo,
    motivoTexto: textoDoMotivo(ligacao.motivo),
    canal: ligacao.canal,
    contato: {
      id: ligacao.contato.id,
      nome: ligacao.contato.nome,
      telefone: ligacao.telefone ?? ligacao.contato.telefone,
      empresa: ligacao.contato.empresa?.nome ?? null,
    },
    conversaId: ligacao.conversaId,
    atendente: ligacao.atendente,
    atividadeId: ligacao.atividadeId,
    anotacao: ligacao.anotacao,
    iniciadaEm: ligacao.iniciadaEm.toISOString(),
    tocouEm: iso(ligacao.tocouEm),
    atendidaEm: iso(ligacao.atendidaEm),
    encerradaEm: iso(ligacao.encerradaEm),
    duracaoSegundos: ligacao.duracaoSegundos,
    expiraEm: iso(ligacao.expiraEm),
    ofertaSdp: mostraOferta ? ligacao.ofertaSdp : null,
    respostaSdp: mostraResposta ? ligacao.respostaSdp : null,
    gravar: ligacao.gravar,
    erroCodigo: ligacao.erroCodigo,
    erroMensagem: ligacao.erroMensagem,
  };
}

/** `mm:ss` (ou `h:mm:ss`) de uma duração em segundos. */
export function formatarDuracao(segundos: number): string {
  const total = Math.max(0, Math.round(segundos));
  const horas = Math.floor(total / 3600);
  const minutos = Math.floor((total % 3600) / 60);
  const resto = String(total % 60).padStart(2, '0');
  return horas > 0
    ? `${horas}:${String(minutos).padStart(2, '0')}:${resto}`
    : `${minutos}:${resto}`;
}
