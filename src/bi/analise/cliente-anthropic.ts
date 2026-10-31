/**
 * Cliente da Anthropic (R21) como provider injetável: a aplicação usa o SDK
 * oficial; os testes trocam por um falso (`overrideProvider(CLIENTE_ANTHROPIC)`).
 * A chave é lida pelo próprio SDK de `ANTHROPIC_API_KEY` e nunca passa por
 * aqui; as novas tentativas ficam com o `ChamadaClaudeService` (o SDK não
 * repete sozinho: `maxRetries: 0`).
 */
import Anthropic from '@anthropic-ai/sdk';
import type {
  BetaMessage,
  BetaMessageStreamParams,
  BetaRawMessageStreamEvent,
} from '@anthropic-ai/sdk/resources/beta/messages';
import type { Provider } from '@nestjs/common';
import { AMBIENTE, type Ambiente } from '../../config/ambiente';

export type ParametrosDoFluxo = BetaMessageStreamParams;
export type EventoDoFluxo = BetaRawMessageStreamEvent;
export type MensagemFinal = BetaMessage;

/** Uma resposta em streaming: os eventos crus e a mensagem completa no fim. */
export interface FluxoDeMensagem extends AsyncIterable<EventoDoFluxo> {
  finalMessage(): Promise<MensagemFinal>;
  abort(): void;
}

/** O pedaço do SDK que a análise usa. */
export interface ClienteAnthropic {
  transmitir(
    parametros: ParametrosDoFluxo,
    opcoes: { signal: AbortSignal; timeout: number },
  ): FluxoDeMensagem;
}

export const CLIENTE_ANTHROPIC = Symbol('CLIENTE_ANTHROPIC');

/** Cliente de verdade: `client.beta.messages.stream(...)`. */
export function criarClienteAnthropic(ambiente: Ambiente): ClienteAnthropic {
  let cliente: Anthropic | null = null;
  return {
    transmitir(parametros, opcoes) {
      // Criado na primeira chamada: sem chave, a API sobe normalmente e só
      // o estado da análise avisa que falta configurar.
      cliente ??= new Anthropic({
        ...(ambiente.anthropic.urlBase
          ? { baseURL: ambiente.anthropic.urlBase }
          : {}),
        maxRetries: 0,
      });
      return cliente.beta.messages.stream(parametros, {
        signal: opcoes.signal,
        timeout: opcoes.timeout,
        maxRetries: 0,
      });
    },
  };
}

export const PROVIDER_CLIENTE_ANTHROPIC: Provider = {
  provide: CLIENTE_ANTHROPIC,
  inject: [AMBIENTE],
  useFactory: (ambiente: Ambiente) => criarClienteAnthropic(ambiente),
};
