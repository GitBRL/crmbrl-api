import { formatarDuracao } from '../ligacoes/ligacao-dto';
import type { Ligacao } from '../generated/prisma/client';
import {
  RESULTADO_POR_ESTADO,
  textoDoMotivo,
} from '../ligacoes/ligacoes.constantes';

/** Texto da atividade `LIGACAO` do contato. */
export function descricaoDaAtividade(
  ligacao: Pick<
    Ligacao,
    | 'direcao'
    | 'estado'
    | 'motivo'
    | 'duracaoSegundos'
    | 'campanhaNome'
    | 'qualificacaoNome'
    | 'qualificacaoNota'
    | 'anotacao'
    | 'telefone'
  >,
): string {
  const linhas = [
    `Direção: ${ligacao.direcao === 'RECEBIDA' ? 'recebida' : 'feita'} pelo 3C+.`,
    ligacao.telefone ? `Telefone: ${ligacao.telefone}.` : null,
    `Resultado: ${RESULTADO_POR_ESTADO[ligacao.estado]}${
      ligacao.motivo && ligacao.estado !== 'ENCERRADA'
        ? ` (${textoDoMotivo(ligacao.motivo)})`
        : ''
    }`,
    ligacao.estado === 'ENCERRADA'
      ? `Duração: ${formatarDuracao(ligacao.duracaoSegundos ?? 0)}.`
      : null,
    ligacao.campanhaNome ? `Campanha: ${ligacao.campanhaNome}.` : null,
    ligacao.qualificacaoNome
      ? `Qualificação: ${ligacao.qualificacaoNome}.`
      : null,
    ligacao.qualificacaoNota ? `Observação: ${ligacao.qualificacaoNota}` : null,
    ligacao.anotacao ? `\nAnotação: ${ligacao.anotacao}` : null,
  ];
  return linhas.filter(Boolean).join('\n');
}
