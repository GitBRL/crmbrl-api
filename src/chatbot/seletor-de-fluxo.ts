/**
 * Qual fluxo atende a mensagem (R18): gatilho, canal e palavra-chave.
 * Funções puras (a consulta ao banco fica em `EntradaDoBot`).
 */
import type { GatilhoFluxo } from '../generated/prisma/client';
import { normalizarParaComparar } from './respostas';

export interface FluxoCandidato {
  id: string;
  gatilho: GatilhoFluxo;
  palavrasChave: readonly string[];
  /** Vazio = todos os canais. */
  canalIds: readonly string[];
  prioridade: number;
  criadoEm: Date;
}

export interface SituacaoDaMensagem {
  canalId: string;
  texto: string | null;
  /** A mensagem abriu a conversa. */
  conversaNova: boolean;
  /** Nenhum fluxo rodou ainda nesta conversa. */
  semExecucaoAnterior: boolean;
  /** O canal está fora do horário de atendimento agora. */
  foraDoHorario: boolean;
}

/** Ordem de preferência no empate de prioridade: o mais específico primeiro. */
const ORDEM_DO_GATILHO: Record<GatilhoFluxo, number> = {
  PALAVRA_CHAVE: 0,
  FORA_DO_HORARIO: 1,
  NOVA_CONVERSA: 2,
  SEMPRE: 3,
};

/** A palavra-chave aparece no texto (palavra ou expressão inteira, sem acento nem caixa)? */
export function textoTemPalavraChave(
  texto: string | null,
  palavras: readonly string[],
): boolean {
  if (!texto) {
    return false;
  }
  const alvo = ` ${normalizarParaComparar(texto)
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')} `;
  return palavras.some((palavra) => {
    const chave = normalizarParaComparar(palavra)
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return chave !== '' && alvo.includes(` ${chave} `);
  });
}

/** O gatilho do fluxo vale para esta mensagem? */
export function gatilhoCombina(
  fluxo: Pick<FluxoCandidato, 'gatilho' | 'palavrasChave'>,
  situacao: SituacaoDaMensagem,
): boolean {
  switch (fluxo.gatilho) {
    case 'NOVA_CONVERSA':
      return situacao.conversaNova && situacao.semExecucaoAnterior;
    case 'SEMPRE':
      return situacao.semExecucaoAnterior;
    case 'FORA_DO_HORARIO':
      return situacao.semExecucaoAnterior && situacao.foraDoHorario;
    case 'PALAVRA_CHAVE':
      return textoTemPalavraChave(situacao.texto, fluxo.palavrasChave);
    default:
      return false;
  }
}

/** O fluxo que atende (maior prioridade; empate: gatilho mais específico, depois o mais antigo). */
export function escolherFluxo<F extends FluxoCandidato>(
  candidatos: readonly F[],
  situacao: SituacaoDaMensagem,
): F | null {
  const servem = candidatos.filter(
    (fluxo) =>
      (fluxo.canalIds.length === 0 ||
        fluxo.canalIds.includes(situacao.canalId)) &&
      gatilhoCombina(fluxo, situacao),
  );
  servem.sort(
    (a, b) =>
      b.prioridade - a.prioridade ||
      ORDEM_DO_GATILHO[a.gatilho] - ORDEM_DO_GATILHO[b.gatilho] ||
      a.criadoEm.getTime() - b.criadoEm.getTime(),
  );
  return servem[0] ?? null;
}
