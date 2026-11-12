import type { Papel, Prisma } from '../generated/prisma/client';
import { ehAdmin, ehLider } from '../comum/dominio/papeis';
import { situacoesDaLigacao } from '../transcricao/situacoes';
import type { ResumoGravado } from '../transcricao/transcricao.constantes';
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
  papel: Papel | null = null,
): LigacaoDto {
  const chamado = !!usuarioId && ligacao.tocouPara.includes(usuarioId);
  const mostraOferta =
    ligacao.direcao === 'RECEBIDA' &&
    ligacao.estado === 'TOCANDO' &&
    chamado &&
    !ligacao.recusadaPor.includes(usuarioId) &&
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
    provedor: ligacao.provedor,
    idExterno: ligacao.idExterno,
    negocioId: ligacao.negocioId,
    qualificacao:
      ligacao.qualificacaoNome !== null
        ? {
            id: ligacao.qualificacaoId,
            nome: ligacao.qualificacaoNome,
            observacao: ligacao.qualificacaoNota,
            conversao: ligacao.qualificacaoConversao,
            qualificadaEm: iso(ligacao.qualificadaEm),
          }
        : null,
    campanha:
      ligacao.campanhaId !== null
        ? {
            id: ligacao.campanhaId,
            nome: ligacao.campanhaNome,
            modo: ligacao.modoChamada,
          }
        : null,
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
    ...estadosDeProcessamento(ligacao, papel),
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

/** Gravação, transcrição e resumo da ligação (R30), sem o texto da transcrição (`GET /ligacoes/:id/transcricao`). */
function estadosDeProcessamento(
  ligacao: LigacaoCompleta,
  papel: Papel | null,
): Pick<LigacaoDto, 'gravacao' | 'transcricao' | 'resumo'> {
  const situacoes = situacoesDaLigacao(ligacao);
  const resumo = ligacao.resumo as ResumoGravado | null;
  return {
    gravacao: {
      situacao: situacoes.gravacao,
      erro: ligacao.gravacaoErro,
      duracaoSegundos: ligacao.gravacaoDuracaoSegundos,
      disponivel:
        ligacao.gravacaoArquivoId !== null &&
        ligacao.gravacaoRemovidaEm === null &&
        ligacao.gravacaoSituacao === 'PRONTA',
      removidaEm: iso(ligacao.gravacaoRemovidaEm),
      podeBaixar: papel !== null && (ehAdmin(papel) || ehLider(papel)),
    },
    transcricao: {
      situacao: situacoes.transcricao,
      erro: ligacao.transcricaoErro,
      processadaEm: iso(ligacao.transcricaoProcessadaEm),
    },
    resumo: {
      situacao: situacoes.resumo,
      erro: ligacao.resumoErro,
      processadoEm: iso(ligacao.resumoProcessadoEm),
      conteudo: resumo
        ? {
            assunto: resumo.assunto,
            pontosPrincipais: resumo.pontosPrincipais,
            combinados: resumo.combinados,
            proximosPassos: resumo.proximosPassos,
            sentimento: resumo.sentimento,
            sentimentoMotivo: resumo.sentimentoMotivo,
            sugestoes: resumo.sugestoes.map((s) => ({
              id: s.id,
              titulo: s.titulo,
              descricao: s.descricao,
              tipo: s.tipo,
              prazoEmDias: s.prazoEmDias,
              atividadeId: s.atividadeId,
              descartadaEm: s.descartadaEm,
            })),
            modelo: resumo.modelo,
          }
        : null,
    },
  };
}
