import type { DynamicModule, NestApplicationOptions } from '@nestjs/common';
import { PREFIXO_DAS_ROTAS } from './aplicacao';
import type { Ambiente } from './config/ambiente';

/** Nome do serviço no painel do Observe. */
const ID_DO_SERVICO = 'crmbrl-api';

/**
 * Rotas que não viram trace: o healthcheck do Docker consulta a saúde a cada
 * 10 s, o que sozinho gastaria quase toda a cota gratuita de eventos.
 */
const ROTAS_IGNORADAS = [new RegExp(`^/${PREFIXO_DAS_ROTAS}/saude(?:[/?]|$)`)];

export interface Observabilidade {
  /** `ObserveModule.forRoot(...)`, que entra primeiro nos imports do módulo raiz. */
  modulo: DynamicModule;
  /** Gancho de instrumentação passado ao `NestFactory.create`. */
  instrumento: NestApplicationOptions['instrument'];
}

/**
 * Prepara o `@nestjs/observe` (traces, erros e métricas) só quando
 * `OBSERVE_APP_KEY` e `OBSERVE_APP_SECRET` estão definidas. Sem as duas o pacote
 * nem é carregado: nada é instrumentado nem enviado.
 */
export async function carregarObservabilidade(
  ambiente: Ambiente,
): Promise<Observabilidade | null> {
  if (!ambiente.observe) {
    return null;
  }
  // O pacote só existe como ESM; o import dinâmico também evita carregá-lo à toa.
  const { createObserveModule } = await import('@nestjs/observe');
  const { ObserveModule, ObserveInstrument } = createObserveModule();
  return {
    modulo: ObserveModule.forRoot({
      appKey: ambiente.observe.appKey,
      appSecret: ambiente.observe.appSecret,
      serviceId: ID_DO_SERVICO,
      http: { ignore: ROTAS_IGNORADAS },
    }),
    instrumento: ObserveInstrument,
  };
}
