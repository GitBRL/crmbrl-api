/**
 * Proteções anti-banimento dos números de WhatsApp (R13), em funções puras que
 * os dois processos usam: o gateway as aplica a cada envio
 * (`GerenciadorDeNumeros.processarEnvio`) e a API as mostra e valida
 * (Configurações → Canais).
 *
 * - **Ritmo**: entre dois envios do mesmo número, uma espera aleatória entre o
 *   intervalo mínimo e o máximo (colunas `intervalo_*_segundos`).
 * - **"Digitando…"** (ou "gravando…" no áudio) antes de cada envio, com duração
 *   proporcional ao texto.
 * - **Limite diário** (`limite_diario`) e **aquecimento** de número novo: nos
 *   primeiros `aquecimento_dias` depois da primeira conexão, o limite do dia
 *   cresce aos poucos até o limite cheio. Valem para as mensagens ativas (as que
 *   não respondem a uma conversa aberta pelo contato); as respostas contam no
 *   total, mas só são barradas com `limitarRespostas`.
 * - **Verificação** de que o telefone tem WhatsApp antes de uma mensagem ativa
 *   (com cache de 7 dias em `whatsapp_verificacoes`).
 * - **Opt-out** (R4.6): mensagem ativa para quem pediu para não receber falha.
 * - **Pausa automática** depois de falhas seguidas, de limite imposto pelo
 *   WhatsApp ou de erro grave/banimento.
 *
 * O resto das opções fica em `whatsapp_numeros.configuracao` (`ConfiguracaoDoNumero`).
 */

/** Fuso do "dia" dos limites diários. */
export const FUSO_DOS_LIMITES = 'America/Sao_Paulo';

/** Mínimo de envios por dia durante o aquecimento (o primeiro dia não fica em 1 ou 2). */
export const MINIMO_DO_AQUECIMENTO = 20;

/** Faixas aceitas das opções (a API valida; o gateway aplica com estes tetos). */
export const FAIXAS_DAS_PROTECOES = {
  limiteDiario: { minimo: 1, maximo: 100_000 },
  intervaloSegundos: { minimo: 0, maximo: 600 },
  aquecimentoDias: { minimo: 0, maximo: 90 },
  digitandoMaximoSegundos: { minimo: 0, maximo: 30 },
  pausarAposFalhasSeguidas: { minimo: 0, maximo: 100 },
} as const;

/** Opções do número guardadas em `whatsapp_numeros.configuracao` (JSON). */
export interface ConfiguracaoDoNumero {
  /** Mostra "digitando…" (ou "gravando…") ao contato antes de cada envio. */
  digitando: boolean;
  /** Teto do "digitando…", em segundos (0 = não mostra). */
  digitandoMaximoSegundos: number;
  /** Confere se o telefone tem WhatsApp antes de uma mensagem ativa. */
  verificarNumero: boolean;
  /** Falhas seguidas de envio que pausam o número sozinho (0 = nunca pausa). */
  pausarAposFalhasSeguidas: number;
  /** O limite diário vale também para as respostas a conversas abertas pelo contato. */
  limitarRespostas: boolean;
  /**
   * A pausa atual foi do gateway (falhas, limite do WhatsApp, erro grave): sai
   * sozinha quando alguém reconecta o número pelo CRM.
   */
  pausaAutomatica: boolean;
}

export const CONFIGURACAO_PADRAO: Readonly<ConfiguracaoDoNumero> = {
  digitando: true,
  digitandoMaximoSegundos: 4,
  verificarNumero: true,
  pausarAposFalhasSeguidas: 5,
  limitarRespostas: false,
  pausaAutomatica: false,
};

/** A configuração do JSON gravado, com os padrões no que faltar e os valores dentro das faixas. */
export function lerConfiguracao(json: unknown): ConfiguracaoDoNumero {
  const dados =
    json && typeof json === 'object' && !Array.isArray(json)
      ? (json as Record<string, unknown>)
      : {};
  const booleano = (chave: keyof ConfiguracaoDoNumero): boolean =>
    typeof dados[chave] === 'boolean'
      ? dados[chave]
      : (CONFIGURACAO_PADRAO[chave] as boolean);
  const inteiro = (
    chave: 'digitandoMaximoSegundos' | 'pausarAposFalhasSeguidas',
  ): number => {
    const valor = dados[chave];
    const faixa = FAIXAS_DAS_PROTECOES[chave];
    return typeof valor === 'number' && Number.isFinite(valor)
      ? Math.min(faixa.maximo, Math.max(faixa.minimo, Math.round(valor)))
      : CONFIGURACAO_PADRAO[chave];
  };
  return {
    digitando: booleano('digitando'),
    digitandoMaximoSegundos: inteiro('digitandoMaximoSegundos'),
    verificarNumero: booleano('verificarNumero'),
    pausarAposFalhasSeguidas: inteiro('pausarAposFalhasSeguidas'),
    limitarRespostas: booleano('limitarRespostas'),
    pausaAutomatica: booleano('pausaAutomatica'),
  };
}

const FORMATO_DO_DIA = new Intl.DateTimeFormat('en-CA', {
  timeZone: FUSO_DOS_LIMITES,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** O dia (`AAAA-MM-DD`) de um instante no fuso de São Paulo. */
export function diaEmSaoPaulo(instante: Date): string {
  return FORMATO_DO_DIA.format(instante);
}

/** O dia como a coluna `DATE` do Prisma o recebe (meia-noite UTC daquele dia). */
export function dataDoDia(dia: string): Date {
  return new Date(`${dia}T00:00:00.000Z`);
}

const UM_DIA_MS = 24 * 60 * 60 * 1000;

/** Dias de calendário (São Paulo) entre dois instantes: 0 no mesmo dia. */
export function diasEntre(inicio: Date, fim: Date): number {
  return Math.round(
    (dataDoDia(diaEmSaoPaulo(fim)).getTime() -
      dataDoDia(diaEmSaoPaulo(inicio)).getTime()) /
      UM_DIA_MS,
  );
}

/** São Paulo não tem horário de verão desde 2019: UTC−3 o ano todo. */
const DESLOCAMENTO_DE_SAO_PAULO_MS = 3 * 60 * 60 * 1000;

/** 00:00 (São Paulo) do dia seguinte ao do instante: quando o limite diário recomeça. */
export function inicioDoProximoDia(instante: Date): Date {
  const hoje = dataDoDia(diaEmSaoPaulo(instante));
  return new Date(hoje.getTime() + UM_DIA_MS + DESLOCAMENTO_DE_SAO_PAULO_MS);
}

/** O número, no que as proteções precisam. */
export interface NumeroDasProtecoes {
  limiteDiario: number;
  aquecimentoInicioEm: Date | null;
  aquecimentoDias: number;
}

export interface SituacaoDoAquecimento {
  /** Ainda no aquecimento (o limite do dia é menor que o limite cheio). */
  ativo: boolean;
  /** Dia do aquecimento (1 = o da primeira conexão), quando ativo. */
  dia: number | null;
  dias: number;
  /** Primeiro dia (São Paulo) com o limite cheio; nulo antes da primeira conexão. */
  terminaEm: string | null;
}

/** Em que ponto do aquecimento o número está. Sem primeira conexão ainda, não começou. */
export function situacaoDoAquecimento(
  numero: NumeroDasProtecoes,
  agora: Date,
): SituacaoDoAquecimento {
  const dias = numero.aquecimentoDias;
  if (!numero.aquecimentoInicioEm || dias <= 0) {
    return { ativo: false, dia: null, dias, terminaEm: null };
  }
  const passados = Math.max(0, diasEntre(numero.aquecimentoInicioEm, agora));
  const terminaEm = diaEmSaoPaulo(
    new Date(
      dataDoDia(diaEmSaoPaulo(numero.aquecimentoInicioEm)).getTime() +
        dias * UM_DIA_MS +
        12 * 60 * 60 * 1000,
    ),
  );
  return passados < dias
    ? { ativo: true, dia: passados + 1, dias, terminaEm }
    : { ativo: false, dia: null, dias, terminaEm };
}

/**
 * Limite de envios do dia: o limite cheio, ou, no aquecimento, uma rampa linear
 * até ele (dia 1 de 14 com limite 1000 → 72; dia 7 → 500), nunca abaixo de
 * `MINIMO_DO_AQUECIMENTO` nem acima do limite cheio.
 */
export function limiteDoDia(numero: NumeroDasProtecoes, agora: Date): number {
  const aquecimento = situacaoDoAquecimento(numero, agora);
  if (!aquecimento.ativo || aquecimento.dia === null) {
    return numero.limiteDiario;
  }
  const rampa = Math.ceil(
    (numero.limiteDiario * aquecimento.dia) / aquecimento.dias,
  );
  return Math.min(numero.limiteDiario, Math.max(MINIMO_DO_AQUECIMENTO, rampa));
}

/** Espera aleatória entre dois envios (ms), entre o mínimo e o máximo em segundos. */
export function sortearIntervalo(
  minimoSegundos: number,
  maximoSegundos: number,
  aleatorio: () => number = Math.random,
): number {
  const minimo = Math.max(0, Math.min(minimoSegundos, maximoSegundos));
  const maximo = Math.max(minimo, maximoSegundos);
  return Math.round((minimo + aleatorio() * (maximo - minimo)) * 1000);
}

/** Quanto ainda falta esperar (ms) para o próximo envio, dado o último. */
export function esperaRestante(
  ultimoEnvioEm: number | undefined,
  intervaloMs: number,
  agora: number,
): number {
  if (ultimoEnvioEm === undefined) {
    return 0;
  }
  return Math.max(0, ultimoEnvioEm + intervaloMs - agora);
}

/**
 * Duração do "digitando…" (ms): cerca de 1 s mais 40 ms por caractere, entre
 * 0,8 s e o teto configurado. Mídia sem legenda fica no mínimo; teto 0 desliga.
 */
export function duracaoDoDigitando(
  texto: string | null | undefined,
  maximoSegundos: number,
): number {
  if (maximoSegundos <= 0) {
    return 0;
  }
  const estimada = 1_000 + (texto?.length ?? 0) * 40;
  return Math.min(maximoSegundos * 1000, Math.max(800, estimada));
}
