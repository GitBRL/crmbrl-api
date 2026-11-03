/** Os estados de gravação, transcrição e resumo como a API os mostra (minúsculos, em português). */
import type {
  SituacaoGravacaoLigacao,
  SituacaoResumoLigacao,
  SituacaoTranscricaoLigacao,
} from '../generated/prisma/client';

export type SituacaoDaGravacao = 'sem' | 'enviando' | 'pronta' | 'falhou';
export type SituacaoDaTranscricao =
  'pendente' | 'processando' | 'pronta' | 'falhou' | 'desativada';
export type SituacaoDoResumo =
  'pendente' | 'processando' | 'pronto' | 'falhou' | 'desativado';

export interface SituacoesDaLigacao {
  gravacao: SituacaoDaGravacao;
  transcricao: SituacaoDaTranscricao | null;
  resumo: SituacaoDoResumo | null;
}

export function situacoesDaLigacao(ligacao: {
  gravacaoSituacao: SituacaoGravacaoLigacao;
  transcricaoSituacao: SituacaoTranscricaoLigacao | null;
  resumoSituacao: SituacaoResumoLigacao | null;
}): SituacoesDaLigacao {
  return {
    gravacao: ligacao.gravacaoSituacao.toLowerCase() as SituacaoDaGravacao,
    transcricao: ligacao.transcricaoSituacao
      ? (ligacao.transcricaoSituacao.toLowerCase() as SituacaoDaTranscricao)
      : null,
    resumo: ligacao.resumoSituacao
      ? (ligacao.resumoSituacao.toLowerCase() as SituacaoDoResumo)
      : null,
  };
}
