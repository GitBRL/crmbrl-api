/**
 * Uma chamada ao Claude em streaming (R21), com tempo máximo por tentativa e
 * uma nova tentativa nas falhas transitórias (tempo esgotado, rede, 429, 5xx,
 * sobrecarga, resposta fora do formato). Conta os tokens de todas as
 * tentativas, inclusive as que falharam no meio. Nunca registra a chave nem o
 * conteúdo: o log leva só o tipo do erro e o status.
 */
import Anthropic from '@anthropic-ai/sdk';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  ESPERA_ENTRE_TENTATIVAS_MS,
  TENTATIVAS_ANALISE,
  TIMEOUT_ANALISE_MS,
} from './analise.constantes';
import {
  CLIENTE_ANTHROPIC,
  type ClienteAnthropic,
  type EventoDoFluxo,
  type ParametrosDoFluxo,
} from './cliente-anthropic';
import { RespostaInvalidaError } from './esquema-analise';

export interface UsoDeTokens {
  entrada: number;
  saida: number;
  cacheLeitura: number;
  cacheEscrita: number;
}

export function usoZerado(): UsoDeTokens {
  return { entrada: 0, saida: 0, cacheLeitura: 0, cacheEscrita: 0 };
}

export type FaseDaChamada = 'pensando' | 'escrevendo';

/** Quem acompanha a chamada (o streaming para o front). */
export interface ObservadorDaChamada {
  /** Começo de cada tentativa (a partir da 2ª, o front descarta o parcial). */
  aoIniciarTentativa(tentativa: number, motivo: string | null): void;
  aoMudarDeFase(fase: FaseDaChamada): void;
  /** Texto acumulado da resposta (JSON ainda incompleto). */
  aoReceberTexto(acumulado: string): void;
}

export type CodigoDaFalha =
  | 'tempo_esgotado'
  | 'indisponivel'
  | 'chave_recusada'
  | 'recusada'
  | 'resposta_incompleta'
  | 'resposta_invalida'
  | 'cancelada'
  | 'erro';

const MENSAGENS_DAS_FALHAS: Readonly<Record<CodigoDaFalha, string>> = {
  tempo_esgotado:
    'A IA demorou demais para responder, mesmo na segunda tentativa. Tente de novo em alguns minutos.',
  indisponivel:
    'O serviço de IA está indisponível ou sobrecarregado agora. Tente de novo em alguns minutos.',
  chave_recusada:
    'A chave da Anthropic foi recusada. Confira a variável ANTHROPIC_API_KEY no servidor.',
  recusada: 'A IA não quis analisar estes dados. Tente com outros filtros.',
  resposta_incompleta:
    'A resposta da IA veio incompleta. Tente de novo, se possível com um período menor.',
  resposta_invalida:
    'A resposta da IA veio num formato inesperado, mesmo na segunda tentativa. Tente de novo.',
  cancelada: 'A análise foi cancelada.',
  erro: 'Não foi possível concluir a análise com a IA. Tente de novo.',
};

export class FalhaDaChamada extends Error {
  constructor(
    readonly codigo: CodigoDaFalha,
    readonly uso: UsoDeTokens,
    readonly tentativas: number,
  ) {
    super(MENSAGENS_DAS_FALHAS[codigo]);
  }
}

export interface ResultadoDaChamada<T> {
  valor: T;
  /** Texto cru da resposta (vai para o histórico da conversa nas perguntas). */
  texto: string;
  uso: UsoDeTokens;
  tentativas: number;
}

export interface OpcoesDaChamada {
  timeoutMs: number;
  esperaMs: number;
  tentativas: number;
}

export const OPCOES_CHAMADA_CLAUDE = Symbol('OPCOES_CHAMADA_CLAUDE');

export const OPCOES_CHAMADA_PADRAO: OpcoesDaChamada = {
  timeoutMs: TIMEOUT_ANALISE_MS,
  esperaMs: ESPERA_ENTRE_TENTATIVAS_MS,
  tentativas: TENTATIVAS_ANALISE,
};

/** Falha de uma tentativa, já classificada. */
class FalhaDaTentativa extends Error {
  constructor(
    readonly codigo: CodigoDaFalha,
    readonly transitoria: boolean,
  ) {
    super(codigo);
  }
}

function esperar(ms: number, sinal: AbortSignal): Promise<void> {
  return new Promise((resolver) => {
    const fim = () => {
      clearTimeout(relogio);
      sinal.removeEventListener('abort', fim);
      resolver();
    };
    const relogio = setTimeout(fim, ms);
    sinal.addEventListener('abort', fim, { once: true });
  });
}

/** Soma o uso que os eventos informam (valores cumulativos dentro da tentativa). */
function atualizarUso(uso: UsoDeTokens, evento: EventoDoFluxo): void {
  const fonte =
    evento.type === 'message_start'
      ? evento.message.usage
      : evento.type === 'message_delta'
        ? evento.usage
        : null;
  if (!fonte) {
    return;
  }
  uso.entrada = Math.max(uso.entrada, fonte.input_tokens ?? 0);
  uso.saida = Math.max(uso.saida, fonte.output_tokens ?? 0);
  uso.cacheLeitura = Math.max(
    uso.cacheLeitura,
    fonte.cache_read_input_tokens ?? 0,
  );
  uso.cacheEscrita = Math.max(
    uso.cacheEscrita,
    fonte.cache_creation_input_tokens ?? 0,
  );
}

function somar(total: UsoDeTokens, parcela: UsoDeTokens): void {
  total.entrada += parcela.entrada;
  total.saida += parcela.saida;
  total.cacheLeitura += parcela.cacheLeitura;
  total.cacheEscrita += parcela.cacheEscrita;
}

@Injectable()
export class ChamadaClaudeService {
  private readonly log = new Logger('AnaliseIa');

  constructor(
    @Inject(CLIENTE_ANTHROPIC) private readonly cliente: ClienteAnthropic,
    @Inject(OPCOES_CHAMADA_CLAUDE) private readonly opcoes: OpcoesDaChamada,
  ) {}

  /**
   * Faz a chamada e devolve o valor que `validar` extrai do JSON final
   * (`validar` lança `RespostaInvalidaError` para formato errado, o que conta
   * como falha transitória). `cancelar` interrompe tudo (o front fechou).
   */
  async executar<T>(
    parametros: ParametrosDoFluxo,
    observador: ObservadorDaChamada,
    validar: (json: unknown) => T,
    cancelar: AbortSignal,
  ): Promise<ResultadoDaChamada<T>> {
    const total = usoZerado();
    let motivo: string | null = null;
    for (let tentativa = 1; ; tentativa++) {
      observador.aoIniciarTentativa(tentativa, motivo);
      const uso = usoZerado();
      try {
        const { texto, valor } = await this.tentar(
          parametros,
          observador,
          validar,
          cancelar,
          uso,
        );
        somar(total, uso);
        return { valor, texto, uso: total, tentativas: tentativa };
      } catch (erro) {
        somar(total, uso);
        const falha = this.classificar(erro, cancelar);
        this.log.warn(
          `Tentativa ${tentativa} da análise falhou: ${falha.codigo}${erro instanceof Anthropic.APIError && erro.status ? ` (HTTP ${erro.status})` : ''}`,
        );
        if (!falha.transitoria || tentativa >= this.opcoes.tentativas) {
          throw new FalhaDaChamada(falha.codigo, total, tentativa);
        }
        motivo = falha.codigo;
        await esperar(this.opcoes.esperaMs, cancelar);
        if (cancelar.aborted) {
          throw new FalhaDaChamada('cancelada', total, tentativa);
        }
      }
    }
  }

  private async tentar<T>(
    parametros: ParametrosDoFluxo,
    observador: ObservadorDaChamada,
    validar: (json: unknown) => T,
    cancelar: AbortSignal,
    uso: UsoDeTokens,
  ): Promise<{ texto: string; valor: T }> {
    const controle = new AbortController();
    let esgotou = false;
    const relogio = setTimeout(() => {
      esgotou = true;
      controle.abort();
    }, this.opcoes.timeoutMs);
    const repassar = () => controle.abort();
    cancelar.addEventListener('abort', repassar, { once: true });
    try {
      if (cancelar.aborted) {
        throw new FalhaDaTentativa('cancelada', false);
      }
      const fluxo = this.cliente.transmitir(parametros, {
        signal: controle.signal,
        timeout: this.opcoes.timeoutMs,
      });
      let acumulado = '';
      let fase: FaseDaChamada | null = null;
      try {
        for await (const evento of fluxo) {
          atualizarUso(uso, evento);
          if (evento.type === 'content_block_start') {
            const tipo = evento.content_block.type;
            const nova: FaseDaChamada | null =
              tipo === 'thinking' || tipo === 'redacted_thinking'
                ? 'pensando'
                : tipo === 'text'
                  ? 'escrevendo'
                  : null;
            if (nova && nova !== fase) {
              fase = nova;
              observador.aoMudarDeFase(nova);
            }
          } else if (
            evento.type === 'content_block_delta' &&
            evento.delta.type === 'text_delta'
          ) {
            acumulado += evento.delta.text;
            observador.aoReceberTexto(acumulado);
          }
        }
        const final = await fluxo.finalMessage();
        uso.entrada = final.usage.input_tokens ?? uso.entrada;
        uso.saida = final.usage.output_tokens ?? uso.saida;
        uso.cacheLeitura =
          final.usage.cache_read_input_tokens ?? uso.cacheLeitura;
        uso.cacheEscrita =
          final.usage.cache_creation_input_tokens ?? uso.cacheEscrita;
        if (final.stop_reason === 'refusal') {
          throw new FalhaDaTentativa('recusada', false);
        }
        if (final.stop_reason === 'max_tokens') {
          throw new FalhaDaTentativa('resposta_incompleta', false);
        }
        const texto = final.content
          .map((bloco) => (bloco.type === 'text' ? bloco.text : ''))
          .join('');
        let json: unknown;
        try {
          json = JSON.parse(texto);
        } catch {
          throw new RespostaInvalidaError('JSON inválido');
        }
        return { texto, valor: validar(json) };
      } catch (erro) {
        fluxo.abort();
        throw erro;
      }
    } catch (erro) {
      if (esgotou && !(erro instanceof FalhaDaTentativa)) {
        throw new FalhaDaTentativa('tempo_esgotado', true);
      }
      throw erro;
    } finally {
      clearTimeout(relogio);
      cancelar.removeEventListener('abort', repassar);
    }
  }

  private classificar(erro: unknown, cancelar: AbortSignal): FalhaDaTentativa {
    if (erro instanceof FalhaDaTentativa) {
      return erro;
    }
    if (cancelar.aborted) {
      return new FalhaDaTentativa('cancelada', false);
    }
    if (erro instanceof RespostaInvalidaError) {
      return new FalhaDaTentativa('resposta_invalida', true);
    }
    if (erro instanceof Anthropic.APIConnectionError) {
      return new FalhaDaTentativa('indisponivel', true);
    }
    if (erro instanceof Anthropic.AuthenticationError) {
      return new FalhaDaTentativa('chave_recusada', false);
    }
    if (erro instanceof Anthropic.PermissionDeniedError) {
      return new FalhaDaTentativa('chave_recusada', false);
    }
    if (erro instanceof Anthropic.RateLimitError) {
      return new FalhaDaTentativa('indisponivel', true);
    }
    if (erro instanceof Anthropic.APIError) {
      // 5xx, 529 (sobrecarga) e erros no meio do streaming (sem status).
      const status = erro.status;
      return new FalhaDaTentativa(
        status === undefined || status >= 500 ? 'indisponivel' : 'erro',
        status === undefined || status >= 500,
      );
    }
    return new FalhaDaTentativa('erro', false);
  }
}
