/**
 * Configuração do assistente (R25), na linha `assistente-ia` de
 * `configuracoes`: limites (perguntas por pessoa por dia, orçamento mensal de
 * tokens) e o destino dos chamados (TicketHub ou webhook). Senha, cabeçalhos
 * e segredo ficam cifrados (AES-256-GCM) e nunca voltam inteiros.
 */
import { isUUID } from 'class-validator';
import {
  ORCAMENTO_MENSAL_MAXIMO,
  ORCAMENTO_MENSAL_PADRAO,
  PERGUNTAS_POR_DIA_MAXIMO,
  PERGUNTAS_POR_DIA_PADRAO,
  PRIORIDADES_TICKETHUB,
  type PrioridadeTicketHub,
} from './assistente.constantes';

export const DESTINOS = ['TICKETHUB', 'WEBHOOK', 'NENHUM'] as const;
export type DestinoConfigurado = (typeof DESTINOS)[number];

export interface ConfiguracaoGravada {
  perguntasPorDia: number;
  orcamentoMensalTokens: number | null;
  destino: DestinoConfigurado;
  ticketHub: {
    url: string | null;
    /** Origem que a pessoa abre no navegador (o link do chamado); padrão: `url`. */
    urlPublica: string | null;
    email: string | null;
    senhaCifrada: string | null;
    prioridade: PrioridadeTicketHub;
    sistemaId: string | null;
  };
  webhook: {
    url: string | null;
    cabecalhosCifrados: string | null;
    segredoCifrado: string | null;
    modeloCorpo: string | null;
  };
}

function inteiroEntre(
  v: unknown,
  min: number,
  max: number,
  padrao: number,
): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max
    ? v
    : padrao;
}

function textoOuNulo(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null;
}

function objeto(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

/** Lê o JSON gravado, com os padrões para o que faltar ou vier inválido. */
export function lerConfiguracaoAssistente(valor: unknown): ConfiguracaoGravada {
  const v = objeto(valor);
  const th = objeto(v.ticketHub);
  const wh = objeto(v.webhook);
  const orcamento = v.orcamentoMensalTokens;
  return {
    perguntasPorDia: inteiroEntre(
      v.perguntasPorDia,
      0,
      PERGUNTAS_POR_DIA_MAXIMO,
      PERGUNTAS_POR_DIA_PADRAO,
    ),
    orcamentoMensalTokens:
      orcamento === null
        ? null
        : inteiroEntre(
            orcamento,
            0,
            ORCAMENTO_MENSAL_MAXIMO,
            ORCAMENTO_MENSAL_PADRAO,
          ),
    destino: (DESTINOS as readonly unknown[]).includes(v.destino)
      ? (v.destino as DestinoConfigurado)
      : 'TICKETHUB',
    ticketHub: {
      url: textoOuNulo(th.url),
      urlPublica: textoOuNulo(th.urlPublica),
      email: textoOuNulo(th.email),
      senhaCifrada: textoOuNulo(th.senhaCifrada),
      prioridade: (PRIORIDADES_TICKETHUB as readonly unknown[]).includes(
        th.prioridade,
      )
        ? (th.prioridade as PrioridadeTicketHub)
        : 'media',
      sistemaId:
        typeof th.sistemaId === 'string' && isUUID(th.sistemaId)
          ? th.sistemaId
          : null,
    },
    webhook: {
      url: textoOuNulo(wh.url),
      cabecalhosCifrados: textoOuNulo(wh.cabecalhosCifrados),
      segredoCifrado: textoOuNulo(wh.segredoCifrado),
      modeloCorpo: textoOuNulo(wh.modeloCorpo),
    },
  };
}

/** O destino pronto para o envio (credenciais já decifradas). */
export type DestinoEfetivo =
  | {
      tipo: 'TICKETHUB';
      url: string;
      /** Base do link mostrado à pessoa (`<base>/chamados`). */
      urlPublica: string;
      email: string;
      senha: string;
      prioridade: PrioridadeTicketHub;
      sistemaId: string | null;
      /** A URL veio da configuração do Admin (passa pela checagem de rede, R9.1). */
      urlDoAdmin: boolean;
    }
  | {
      tipo: 'WEBHOOK';
      url: string;
      cabecalhos: Record<string, string>;
      segredo: string | null;
      modeloCorpo: string | null;
    };

export type ResultadoDoDestino =
  { pronto: true; destino: DestinoEfetivo } | { pronto: false; motivo: string };
