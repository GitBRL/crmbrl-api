/**
 * Ritmo e janela de envio das campanhas (R17), em funções puras.
 *
 * - Intervalo entre envios: aleatório entre o mínimo e o máximo da campanha, nunca
 *   abaixo do que o número permite (R13); lote com pausa.
 * - Janela de envio no formato de `canais.horario_atendimento` (dias e horas no
 *   fuso `America/Sao_Paulo`).
 * - Estimativa de duração da campanha.
 */
import { inicioDoProximoDia } from '../canais/whatsapp/protecoes';
import {
  type HorarioDeAtendimento,
  lerHorario,
  situacaoDoHorario,
} from '../atendimento/horario';

export interface RitmoDaCampanha {
  intervaloMinimoSegundos: number;
  intervaloMaximoSegundos: number;
  loteTamanho: number | null;
  lotePausaSegundos: number | null;
}

/** O que o número (R13) impõe ao ritmo. */
export interface PisoDoNumero {
  intervaloMinimoSegundos: number;
  intervaloMaximoSegundos: number;
}

/** Intervalo efetivo: o da campanha, mas nunca mais rápido do que o número permite. */
export function intervaloEfetivo(
  ritmo: Pick<
    RitmoDaCampanha,
    'intervaloMinimoSegundos' | 'intervaloMaximoSegundos'
  >,
  piso?: PisoDoNumero | null,
): { minimo: number; maximo: number } {
  const minimo = Math.max(
    ritmo.intervaloMinimoSegundos,
    piso?.intervaloMinimoSegundos ?? 0,
  );
  const maximo = Math.max(
    minimo,
    ritmo.intervaloMaximoSegundos,
    piso?.intervaloMaximoSegundos ?? 0,
  );
  return { minimo, maximo };
}

/** Quanto esperar (ms) até o próximo envio; ao fechar o lote, a pausa do lote. */
export function esperaDepoisDoEnvio(
  ritmo: RitmoDaCampanha,
  enviadosNoLoteAntes: number,
  piso?: PisoDoNumero | null,
  aleatorio: () => number = Math.random,
): { esperaMs: number; enviadosNoLote: number; fechouLote: boolean } {
  const enviadosNoLote = enviadosNoLoteAntes + 1;
  if (
    ritmo.loteTamanho &&
    ritmo.lotePausaSegundos &&
    enviadosNoLote >= ritmo.loteTamanho
  ) {
    // Um pouco de variação na pausa também (até 10%).
    const base = ritmo.lotePausaSegundos * 1000;
    return {
      esperaMs: Math.round(base * (1 + aleatorio() * 0.1)),
      enviadosNoLote: 0,
      fechouLote: true,
    };
  }
  const { minimo, maximo } = intervaloEfetivo(ritmo, piso);
  return {
    esperaMs: Math.round((minimo + aleatorio() * (maximo - minimo)) * 1000),
    enviadosNoLote,
    fechouLote: false,
  };
}

export interface SituacaoDaJanela {
  aberta: boolean;
  /** Fechada: quando abre de novo (nula se não abre nos próximos 8 dias). */
  proximaAbertura: Date | null;
}

/** A janela de envio (nula = qualquer hora) está aberta agora? */
export function situacaoDaJanela(
  janela: unknown,
  agora: Date,
): SituacaoDaJanela {
  const horario: HorarioDeAtendimento | null = janela
    ? lerHorario(janela)
    : null;
  const situacao = situacaoDoHorario(horario, agora);
  return { aberta: situacao.aberto, proximaAbertura: situacao.proximaAbertura };
}

export interface EntradaDaEstimativa {
  total: number;
  ritmo: RitmoDaCampanha;
  /** Pisos dos números (um por canal). WhatsApp: o do número; e-mail: vazio. */
  pisos: Array<PisoDoNumero | null>;
  /** Limite do dia de cada canal (nulo = sem limite). */
  limitesDoDia: Array<number | null>;
  janela: unknown;
  inicio: Date;
}

export interface Estimativa {
  /** Tempo só de envio, em segundos, sem janela nem limite diário. */
  duracaoSegundos: number;
  /** Previsão do término considerando janela e limites (nula se não dá para prever). */
  terminoPrevisto: Date | null;
  /** Dias de calendário que o envio deve tomar. */
  dias: number;
  /** Envios por hora, em média. */
  enviosPorHora: number;
}

/**
 * Estima a duração. O rodízio divide o trabalho entre os canais: cada canal
 * envia no seu ritmo (intervalo médio), em paralelo ao próximo — mas a campanha
 * envia um por vez (um job), então o ritmo é o do intervalo efetivo médio dividido
 * pelo rodízio apenas no limite diário. Mantém a conta simples e conservadora:
 * `total × intervalo médio` + pausas dos lotes, percorrendo a janela e o limite
 * diário somado dos canais.
 */
export function estimarDuracao(entrada: EntradaDaEstimativa): Estimativa {
  const { total, ritmo, pisos, limitesDoDia } = entrada;
  if (total <= 0) {
    return {
      duracaoSegundos: 0,
      terminoPrevisto: entrada.inicio,
      dias: 0,
      enviosPorHora: 0,
    };
  }
  const piso = pisos.reduce<PisoDoNumero | null>(
    (maior, atual) =>
      !atual
        ? maior
        : !maior
          ? atual
          : {
              intervaloMinimoSegundos: Math.max(
                maior.intervaloMinimoSegundos,
                atual.intervaloMinimoSegundos,
              ),
              intervaloMaximoSegundos: Math.max(
                maior.intervaloMaximoSegundos,
                atual.intervaloMaximoSegundos,
              ),
            },
    null,
  );
  const { minimo, maximo } = intervaloEfetivo(ritmo, piso);
  const medio = (minimo + maximo) / 2;
  const porEnvio = Math.max(medio, 0.5);
  const pausas =
    ritmo.loteTamanho && ritmo.lotePausaSegundos
      ? Math.floor(total / ritmo.loteTamanho) * ritmo.lotePausaSegundos
      : 0;
  const duracaoSegundos = Math.round(total * porEnvio + pausas);
  const enviosPorHora = Math.round(
    3600 / (porEnvio + (pausas > 0 ? pausas / total : 0)),
  );

  const limiteSomado = limitesDoDia.every((limite) => limite !== null)
    ? limitesDoDia.reduce<number>((soma, limite) => soma + (limite ?? 0), 0)
    : null;

  // Simula hora a hora (no máximo 90 dias) respeitando a janela e o limite diário.
  let restante = total;
  let cursor = new Date(entrada.inicio);
  let enviadosNoDia = 0;
  let diaAtual = diaDe(cursor);
  const diasUsados = new Set<string>();
  const porHora = Math.max(1, enviosPorHora);
  for (let passos = 0; passos < 24 * 90 && restante > 0; passos++) {
    const dia = diaDe(cursor);
    if (dia !== diaAtual) {
      diaAtual = dia;
      enviadosNoDia = 0;
    }
    const janela = situacaoDaJanela(entrada.janela, cursor);
    if (!janela.aberta) {
      if (!janela.proximaAbertura) {
        return {
          duracaoSegundos,
          terminoPrevisto: null,
          dias: 0,
          enviosPorHora,
        };
      }
      cursor = janela.proximaAbertura;
      continue;
    }
    let capacidade = porHora;
    if (limiteSomado !== null) {
      const sobra = limiteSomado - enviadosNoDia;
      if (sobra <= 0) {
        cursor = inicioDoProximoDia(cursor);
        continue;
      }
      capacidade = Math.min(capacidade, sobra);
    }
    const nesta = Math.min(restante, capacidade);
    restante -= nesta;
    enviadosNoDia += nesta;
    diasUsados.add(dia);
    cursor = new Date(cursor.getTime() + (nesta / porHora) * 3_600_000);
  }
  return {
    duracaoSegundos,
    terminoPrevisto: restante > 0 ? null : cursor,
    dias: diasUsados.size,
    enviosPorHora,
  };
}

function diaDe(data: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(data);
}

/** Texto sem acento, minúsculo e sem pontuação nas pontas (compara palavras de saída). */
export function normalizarPalavra(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu, '')
    .replace(/\s+/g, ' ');
}

/** A mensagem é só uma das palavras de saída (inteira, sem acento nem caixa)? */
export function ehPalavraDeSaida(
  texto: string | null | undefined,
  palavras: readonly string[],
): boolean {
  if (!texto) {
    return false;
  }
  const normalizado = normalizarPalavra(texto);
  return (
    normalizado !== '' &&
    palavras.some((palavra) => normalizarPalavra(palavra) === normalizado)
  );
}
