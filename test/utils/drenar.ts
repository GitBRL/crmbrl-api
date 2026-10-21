import type { AppTeste } from './app-teste';

/**
 * Entrega agora os eventos de domínio gravados na outbox (R10.1): leva-os para a
 * fila e roda os manipuladores. Com `incluirAgendados`, também as reentregas
 * marcadas para o futuro. Devolve quantas entregas rodaram.
 */
export function processarEventos(
  t: AppTeste,
  opcoes: { incluirAgendados?: boolean } = {},
): Promise<number> {
  return t.eventos.processarPendentes(opcoes);
}

/**
 * Executa agora os jobs das filas (todas com manipulador, ou só as informadas).
 * Com `incluirAgendados`, também os marcados para o futuro (retentativas).
 */
export function drenarFilas(
  t: AppTeste,
  filas?: string | readonly string[],
  opcoes: { incluirAgendados?: boolean } = {},
): Promise<number> {
  return t.fila.drenar(filas, opcoes);
}

/** Eventos e filas até não sobrar nada (um evento pode gerar job, e um job, evento). */
export async function drenarTudo(
  t: AppTeste,
  opcoes: { incluirAgendados?: boolean } = {},
): Promise<number> {
  let total = 0;
  for (let rodada = 0; rodada < 20; rodada++) {
    const eventos = await processarEventos(t, opcoes);
    const jobs = await drenarFilas(t, undefined, opcoes);
    total += eventos + jobs;
    if (eventos === 0 && jobs === 0) {
      break;
    }
  }
  return total;
}
