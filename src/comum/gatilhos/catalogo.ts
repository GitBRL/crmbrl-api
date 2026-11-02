/**
 * Catálogo dos gatilhos das automações (Onda B, §2.5) e utilitários sobre os
 * eventos de domínio: que entidade cada evento afeta e os ids que ele carrega.
 */
import type { CadeiaDeAutomacao } from '../contexto/contexto-requisicao';

/** Entidade alvo de uma automação (`automacoes.entidade`). */
export type EntidadeDeGatilho =
  'contato' | 'negocio' | 'atividade' | 'conversa';

/**
 * Eventos de domínio novos da Onda B (quem publica, na transação da alteração):
 * - `campanha.respondida` — disparos: o destinatário respondeu
 *   `{ campanhaId, destinatarioId, contatoId, conversaId, mensagemId }`;
 * - `campanha.concluida` — disparos `{ campanhaId, enviados, falhas }`;
 * - `importacao.concluida` — importação `{ importacaoId, tipo, criados, atualizados, ignorados, erros }`;
 * - `chatbot.transferida` — chatbot passou a conversa para humano
 *   `{ conversaId, contatoId, fluxoId, execucaoId, filaId }`.
 */
export const EVENTOS_DA_ONDA_B = {
  CAMPANHA_RESPONDIDA: 'campanha.respondida',
  CAMPANHA_CONCLUIDA: 'campanha.concluida',
  IMPORTACAO_CONCLUIDA: 'importacao.concluida',
  CHATBOT_TRANSFERIDA: 'chatbot.transferida',
} as const;

export interface GatilhoDoCatalogo {
  /** Tipo do evento de domínio (`automacoes.evento`) ou chave da agenda. */
  evento: string;
  rotulo: string;
  entidade: EntidadeDeGatilho;
  /** `evento` = outbox; `agenda` = varredura do módulo de automações (sem evento). */
  origem: 'evento' | 'agenda';
  /**
   * Filtros aceitos em `automacoes.gatilho_config` (o módulo de automações
   * confere): ex. `{ funilId, etapaId }`, `{ palavras: [] }`, `{ notaMaxima }`.
   */
  filtros: readonly string[];
}

export const CATALOGO_DE_GATILHOS: readonly GatilhoDoCatalogo[] = [
  {
    evento: 'contato.criado',
    rotulo: 'Contato criado',
    entidade: 'contato',
    origem: 'evento',
    filtros: ['origem'],
  },
  {
    evento: 'contato.atualizado',
    rotulo: 'Contato atualizado',
    entidade: 'contato',
    origem: 'evento',
    filtros: [],
  },
  {
    evento: 'negocio.criado',
    rotulo: 'Negócio criado',
    entidade: 'negocio',
    origem: 'evento',
    filtros: ['funilId', 'etapaId'],
  },
  {
    evento: 'negocio.movido',
    rotulo: 'Negócio movido para a etapa',
    entidade: 'negocio',
    origem: 'evento',
    filtros: ['funilId', 'etapaId'],
  },
  {
    evento: 'negocio.ganho',
    rotulo: 'Negócio ganho',
    entidade: 'negocio',
    origem: 'evento',
    filtros: ['funilId'],
  },
  {
    evento: 'negocio.perdido',
    rotulo: 'Negócio perdido',
    entidade: 'negocio',
    origem: 'evento',
    filtros: ['funilId'],
  },
  {
    evento: 'negocio.parado',
    rotulo: 'Negócio parado na etapa (acima do prazo)',
    entidade: 'negocio',
    origem: 'agenda',
    filtros: ['funilId', 'etapaId'],
  },
  {
    evento: 'atividade.criada',
    rotulo: 'Atividade criada',
    entidade: 'atividade',
    origem: 'evento',
    filtros: ['tipo'],
  },
  {
    evento: 'atividade.atrasada',
    rotulo: 'Atividade atrasada',
    entidade: 'atividade',
    origem: 'agenda',
    filtros: ['tipo'],
  },
  {
    evento: 'conversa.criada',
    rotulo: 'Conversa nova',
    entidade: 'conversa',
    origem: 'evento',
    filtros: ['canalTipo', 'canalId'],
  },
  {
    evento: 'conversa.resolvida',
    rotulo: 'Conversa resolvida',
    entidade: 'conversa',
    origem: 'evento',
    filtros: ['canalTipo', 'canalId'],
  },
  {
    evento: 'mensagem.recebida',
    rotulo: 'Mensagem recebida contendo palavra',
    entidade: 'conversa',
    origem: 'evento',
    filtros: ['palavras', 'canalTipo'],
  },
  {
    evento: 'conversa.avaliada',
    rotulo: 'Satisfação recebida',
    entidade: 'conversa',
    origem: 'evento',
    filtros: ['notaMinima', 'notaMaxima'],
  },
  {
    evento: 'campanha.respondida',
    rotulo: 'Campanha respondida',
    entidade: 'contato',
    origem: 'evento',
    filtros: ['campanhaId'],
  },
];

/** Ids que um evento de domínio carrega (no nível de cima dos `dados`, ou no negócio). */
export interface IdsDoEvento {
  contatoId?: string;
  negocioId?: string;
  conversaId?: string;
  atividadeId?: string;
  mensagemId?: string;
  empresaId?: string;
  campanhaId?: string;
}

const CHAVES_DE_ID = [
  'contatoId',
  'negocioId',
  'conversaId',
  'atividadeId',
  'mensagemId',
  'empresaId',
  'campanhaId',
] as const;

export function idsDoEvento(dados: unknown): IdsDoEvento {
  const ids: IdsDoEvento = {};
  if (typeof dados !== 'object' || dados === null) {
    return ids;
  }
  const registro = dados as Record<string, unknown>;
  for (const chave of CHAVES_DE_ID) {
    if (typeof registro[chave] === 'string') {
      ids[chave] = registro[chave];
    }
  }
  // Eventos de negócio: o contato vem dentro de `negocio.contato`.
  const negocio = registro.negocio as
    { contato?: { id?: unknown } } | undefined;
  if (!ids.contatoId && typeof negocio?.contato?.id === 'string') {
    ids.contatoId = negocio.contato.id;
  }
  return ids;
}

/** Entidade principal de um tipo de evento (pelo catálogo, ou pelo prefixo). */
export function entidadeDoEvento(tipo: string): EntidadeDeGatilho | null {
  const doCatalogo = CATALOGO_DE_GATILHOS.find((g) => g.evento === tipo);
  if (doCatalogo) {
    return doCatalogo.entidade;
  }
  const prefixo = tipo.split('.')[0];
  if (
    prefixo === 'contato' ||
    prefixo === 'negocio' ||
    prefixo === 'atividade' ||
    prefixo === 'conversa'
  ) {
    return prefixo;
  }
  return prefixo === 'mensagem' ? 'conversa' : null;
}

/** Limites da proteção contra laços (R19). */
export const LIMITES_DE_ENCADEAMENTO = {
  /** Execuções encadeadas (evento de uma automação disparando outra) no máximo. */
  profundidadeMaxima: 5,
  /** Vezes que a mesma automação aparece numa cadeia. */
  repeticoesDaMesmaAutomacao: 3,
} as const;

/**
 * A cadeia do evento permite iniciar (mais) esta automação? Sem cadeia (o
 * evento não veio de uma execução), sempre. Sem `automacaoId`, só confere a
 * profundidade.
 */
export function permiteEncadear(
  cadeia: CadeiaDeAutomacao | null | undefined,
  automacaoId?: string,
): { permitido: true } | { permitido: false; motivo: string } {
  if (!cadeia) {
    return { permitido: true };
  }
  if (cadeia.profundidade >= LIMITES_DE_ENCADEAMENTO.profundidadeMaxima) {
    return {
      permitido: false,
      motivo: `Encadeamento máximo de ${LIMITES_DE_ENCADEAMENTO.profundidadeMaxima} automações atingido.`,
    };
  }
  if (automacaoId) {
    const repeticoes = cadeia.automacoes.filter(
      (id) => id === automacaoId,
    ).length;
    if (repeticoes >= LIMITES_DE_ENCADEAMENTO.repeticoesDaMesmaAutomacao) {
      return {
        permitido: false,
        motivo: `A automação já disparou ${repeticoes} vezes nesta cadeia.`,
      };
    }
  }
  return { permitido: true };
}
