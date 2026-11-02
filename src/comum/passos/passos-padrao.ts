import {
  aguardarAte,
  type DefinicaoDeTipoDePasso,
  encerrar,
  seguir,
} from './tipos';

/** `aguardar`: `{ quantidade, unidade: 'minutos' | 'horas' | 'dias' }` ou `{ ate: ISO 8601 }`. */
export interface ConfigDeAguardar {
  quantidade?: number;
  unidade?: 'minutos' | 'horas' | 'dias';
  ate?: string;
}

const SEGUNDOS_POR_UNIDADE = {
  minutos: 60,
  horas: 3_600,
  dias: 86_400,
} as const;

/** Momento em que a espera termina, a partir de `agora`. */
export function fimDaEspera(config: ConfigDeAguardar, agora: Date): Date {
  if (config.ate) {
    return new Date(config.ate);
  }
  const segundos =
    (config.quantidade ?? 0) *
    SEGUNDOS_POR_UNIDADE[config.unidade ?? 'minutos'];
  return new Date(agora.getTime() + segundos * 1_000);
}

export const PASSO_AGUARDAR: DefinicaoDeTipoDePasso<ConfigDeAguardar> = {
  tipo: 'aguardar',
  validar: (config) => {
    const c = config as ConfigDeAguardar;
    if (c.ate !== undefined) {
      return typeof c.ate === 'string' &&
        !Number.isNaN(new Date(c.ate).getTime())
        ? null
        : 'Informe a data da espera.';
    }
    if (
      typeof c.quantidade !== 'number' ||
      !Number.isFinite(c.quantidade) ||
      c.quantidade <= 0
    ) {
      return 'Informe quanto tempo aguardar.';
    }
    return (c.unidade ?? 'minutos') in SEGUNDOS_POR_UNIDADE
      ? null
      : 'Use minutos, horas ou dias.';
  },
  executar: ({ config, retomada, agora }) => {
    if (retomada?.motivo === 'tempo') {
      return Promise.resolve(
        seguir({ saida: { simulada: retomada.simulada ?? false } }),
      );
    }
    const ate = fimDaEspera(config, agora);
    return Promise.resolve(
      ate.getTime() <= agora.getTime()
        ? seguir({ saida: { ate: ate.toISOString(), vencida: true } })
        : aguardarAte(ate, { saida: { ate: ate.toISOString() } }),
    );
  },
};

/** `encerrar`: `{ motivo? }` — termina a execução (CONCLUIDA). */
export const PASSO_ENCERRAR: DefinicaoDeTipoDePasso<{ motivo?: string }> = {
  tipo: 'encerrar',
  executar: ({ config }) =>
    Promise.resolve(encerrar(config.motivo ?? 'encerrada')),
};

/** Tipos que todo executor conhece (chatbot e automações). */
export const PASSOS_PADRAO: readonly DefinicaoDeTipoDePasso<never>[] = [
  PASSO_AGUARDAR as DefinicaoDeTipoDePasso<never>,
  PASSO_ENCERRAR as DefinicaoDeTipoDePasso<never>,
];
