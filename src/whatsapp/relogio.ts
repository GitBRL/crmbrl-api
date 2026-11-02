/**
 * Relógio do gateway: o tempo e as esperas das proteções anti-banimento
 * (ritmo entre envios, "digitando…"). Os testes trocam por um falso, que não
 * espera de verdade.
 */
export const RELOGIO_DO_GATEWAY = Symbol('RELOGIO_DO_GATEWAY');

export interface RelogioDoGateway {
  /** Agora, em ms desde a época. */
  agora(): number;
  /** Espera `ms` milissegundos. */
  esperar(ms: number): Promise<void>;
  /** Número entre 0 e 1 (o sorteio do intervalo entre envios). */
  aleatorio(): number;
}

export const RELOGIO_REAL: RelogioDoGateway = {
  agora: () => Date.now(),
  esperar: (ms) =>
    ms > 0
      ? new Promise((resolver) => setTimeout(resolver, ms))
      : Promise.resolve(),
  aleatorio: () => Math.random(),
};
