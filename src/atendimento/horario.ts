/**
 * Horário de atendimento de um canal (R12), sem biblioteca: o fuso vem do
 * próprio `Intl` do Node.
 *
 * Formato gravado em `canais.horario_atendimento` (nulo = 24 horas):
 *
 * ```json
 * { "fusoHorario": "America/Sao_Paulo",
 *   "dias": { "1": [{ "inicio": "08:00", "fim": "12:00" }, { "inicio": "13:00", "fim": "18:00" }],
 *             "6": [{ "inicio": "09:00", "fim": "13:00" }] } }
 * ```
 *
 * Dias de 0 (domingo) a 6 (sábado); dia ausente ou vazio = fechado. Um
 * intervalo não atravessa a meia-noite (`fim` aceita `24:00`): o atendimento
 * das 22h às 2h é `22:00–24:00` num dia e `00:00–02:00` no seguinte — os dois
 * se juntam num período só.
 */

/** Fuso padrão do CRM (o mesmo das atividades e da fila). */
export const FUSO_HORARIO_PADRAO = 'America/Sao_Paulo';

/** Máximo de intervalos por dia. */
export const INTERVALOS_POR_DIA = 6;

const DIAS = ['0', '1', '2', '3', '4', '5', '6'] as const;
export type DiaDaSemana = (typeof DIAS)[number];

export const NOME_DO_DIA: Readonly<Record<DiaDaSemana, string>> = {
  '0': 'domingo',
  '1': 'segunda-feira',
  '2': 'terça-feira',
  '3': 'quarta-feira',
  '4': 'quinta-feira',
  '5': 'sexta-feira',
  '6': 'sábado',
};

export interface IntervaloDeAtendimento {
  /** `HH:MM`, de `00:00` a `23:59`. */
  inicio: string;
  /** `HH:MM`, depois do início; até `24:00`. */
  fim: string;
}

export interface HorarioDeAtendimento {
  fusoHorario: string;
  dias: Partial<Record<DiaDaSemana, IntervaloDeAtendimento[]>>;
}

/** Situação do canal num instante. */
export interface SituacaoDoHorario {
  /** Atende agora? */
  aberto: boolean;
  /**
   * Fechado: quando começou o fechamento atual (fim do último período aberto),
   * ou `null` se não houve período aberto nos últimos 8 dias.
   */
  fechadoDesde: Date | null;
  /** Fechado: quando abre de novo (`null` se não abre nos próximos 8 dias). */
  proximaAbertura: Date | null;
  /** Aberto: quando fecha (`null` = não fecha nos próximos 8 dias). */
  proximoFechamento: Date | null;
}

const HORA = /^([01]\d|2[0-3]):([0-5]\d)$/;
const SEMPRE_ABERTO: SituacaoDoHorario = {
  aberto: true,
  fechadoDesde: null,
  proximaAbertura: null,
  proximoFechamento: null,
};

function minutosDe(hora: string, ehFim: boolean): number | null {
  if (ehFim && hora === '24:00') {
    return 24 * 60;
  }
  const partes = HORA.exec(hora);
  if (!partes) {
    return null;
  }
  return Number(partes[1]) * 60 + Number(partes[2]);
}

/** O fuso existe no `Intl` (ex.: `America/Sao_Paulo`)? */
export function ehFusoHorarioValido(fuso: unknown): fuso is string {
  if (typeof fuso !== 'string' || fuso.trim() === '') {
    return false;
  }
  try {
    new Intl.DateTimeFormat('pt-BR', { timeZone: fuso });
    return true;
  } catch {
    return false;
  }
}

/**
 * Confere e normaliza o horário vindo da tela. Devolve o horário (intervalos
 * em ordem) ou a lista de problemas, em português.
 */
export function validarHorario(
  valor: unknown,
): { horario: HorarioDeAtendimento; erros?: never } | { erros: string[] } {
  const erros: string[] = [];
  if (typeof valor !== 'object' || valor === null || Array.isArray(valor)) {
    return { erros: ['O horário precisa ter o fuso e os dias da semana.'] };
  }
  const { fusoHorario, dias } = valor as Record<string, unknown>;
  if (!ehFusoHorarioValido(fusoHorario)) {
    erros.push(
      'Fuso horário inválido: use um nome como America/Sao_Paulo ou America/Manaus.',
    );
  }
  if (typeof dias !== 'object' || dias === null || Array.isArray(dias)) {
    return {
      erros: [
        ...erros,
        'Informe os dias da semana (0 = domingo … 6 = sábado).',
      ],
    };
  }
  const resultado: HorarioDeAtendimento['dias'] = {};
  let algumIntervalo = false;
  for (const [chave, lista] of Object.entries(
    dias as Record<string, unknown>,
  )) {
    if (!(DIAS as readonly string[]).includes(chave)) {
      erros.push(`Dia "${chave}" inválido: use de 0 (domingo) a 6 (sábado).`);
      continue;
    }
    const dia = chave as DiaDaSemana;
    const nome = NOME_DO_DIA[dia];
    if (!Array.isArray(lista)) {
      erros.push(`Os horários de ${nome} precisam ser uma lista.`);
      continue;
    }
    if (lista.length > INTERVALOS_POR_DIA) {
      erros.push(
        `No máximo ${INTERVALOS_POR_DIA} intervalos por dia (${nome}).`,
      );
      continue;
    }
    const intervalos: Array<
      IntervaloDeAtendimento & { de: number; ate: number }
    > = [];
    for (const item of lista as unknown[]) {
      const { inicio, fim } = (item ?? {}) as Record<string, unknown>;
      const de = typeof inicio === 'string' ? minutosDe(inicio, false) : null;
      const ate = typeof fim === 'string' ? minutosDe(fim, true) : null;
      if (de === null || ate === null) {
        erros.push(`Horário inválido em ${nome}: use HH:MM, de 00:00 a 24:00.`);
        continue;
      }
      if (ate <= de) {
        erros.push(
          `Em ${nome}, o fim (${String(fim)}) precisa ser depois do início (${String(inicio)}).`,
        );
        continue;
      }
      intervalos.push({
        inicio: inicio as string,
        fim: fim as string,
        de,
        ate,
      });
    }
    intervalos.sort((a, b) => a.de - b.de);
    for (let indice = 1; indice < intervalos.length; indice++) {
      if (intervalos[indice].de < intervalos[indice - 1].ate) {
        erros.push(`Há intervalos sobrepostos em ${nome}.`);
        break;
      }
    }
    if (intervalos.length > 0) {
      algumIntervalo = true;
      resultado[dia] = intervalos.map(({ inicio, fim }) => ({ inicio, fim }));
    }
  }
  if (!algumIntervalo && erros.length === 0) {
    erros.push(
      'Defina pelo menos um intervalo — ou deixe sem horário para atender 24 horas.',
    );
  }
  if (erros.length > 0) {
    return { erros };
  }
  return { horario: { fusoHorario: fusoHorario as string, dias: resultado } };
}

/**
 * Lê o horário gravado no canal. Nulo ou inválido (gravado à mão) = 24 horas
 * — o canal nunca deixa de receber por causa de uma configuração quebrada.
 */
export function lerHorario(valor: unknown): HorarioDeAtendimento | null {
  if (valor === null || valor === undefined) {
    return null;
  }
  const lido = validarHorario(valor);
  return lido.erros ? null : lido.horario;
}

// ---------------------------------------------------------------------------
// Fuso horário com o Intl
// ---------------------------------------------------------------------------

const formatadores = new Map<string, Intl.DateTimeFormat>();

function formatador(fuso: string): Intl.DateTimeFormat {
  let existente = formatadores.get(fuso);
  if (!existente) {
    existente = new Intl.DateTimeFormat('en-US', {
      timeZone: fuso,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatadores.set(fuso, existente);
  }
  return existente;
}

/** Data e hora "de parede" do instante no fuso. */
export interface PartesLocais {
  ano: number;
  mes: number;
  dia: number;
  hora: number;
  minuto: number;
  segundo: number;
}

export function partesLocais(instante: Date, fuso: string): PartesLocais {
  const partes: Record<string, number> = {};
  for (const parte of formatador(fuso).formatToParts(instante)) {
    if (parte.type !== 'literal') {
      partes[parte.type] = Number(parte.value);
    }
  }
  return {
    ano: partes.year,
    mes: partes.month,
    dia: partes.day,
    hora: partes.hour % 24,
    minuto: partes.minute,
    segundo: partes.second,
  };
}

/** Diferença (ms) entre a hora de parede no fuso e o UTC, no instante. */
function deslocamento(instante: number, fuso: string): number {
  const local = partesLocais(new Date(instante), fuso);
  const comoUtc = Date.UTC(
    local.ano,
    local.mes - 1,
    local.dia,
    local.hora,
    local.minuto,
    local.segundo,
  );
  return comoUtc - Math.floor(instante / 1000) * 1000;
}

/**
 * O instante de uma hora de parede no fuso (`minutos` desde a meia-noite do
 * dia local). Na hora que não existe (início do horário de verão), cai na
 * seguinte; na que se repete, fica com a primeira.
 */
export function instanteLocal(
  ano: number,
  mes: number,
  dia: number,
  minutos: number,
  fuso: string,
): Date {
  const parede = Date.UTC(ano, mes - 1, dia, 0, minutos);
  let instante = parede - deslocamento(parede, fuso);
  instante = parede - deslocamento(instante, fuso);
  return new Date(instante);
}

/** Uma data do calendário (sem hora), com o dia da semana. */
interface DataDoCalendario {
  ano: number;
  mes: number;
  dia: number;
  diaDaSemana: DiaDaSemana;
}

function somarDias(base: DataDoCalendario, dias: number): DataDoCalendario {
  const data = new Date(Date.UTC(base.ano, base.mes - 1, base.dia + dias));
  return {
    ano: data.getUTCFullYear(),
    mes: data.getUTCMonth() + 1,
    dia: data.getUTCDate(),
    diaDaSemana: String(data.getUTCDay()) as DiaDaSemana,
  };
}

/** Janela pesquisada para os lados (dias). */
const ALCANCE_EM_DIAS = 8;

/** Períodos abertos (início/fim) ao redor do instante, já juntando os contíguos. */
function periodosAbertos(
  horario: HorarioDeAtendimento,
  agora: Date,
): Array<{ inicio: Date; fim: Date }> {
  const local = partesLocais(agora, horario.fusoHorario);
  const hoje = somarDias(
    { ano: local.ano, mes: local.mes, dia: local.dia, diaDaSemana: '0' },
    0,
  );
  const periodos: Array<{ inicio: Date; fim: Date }> = [];
  for (let desvio = -ALCANCE_EM_DIAS; desvio <= ALCANCE_EM_DIAS; desvio++) {
    const data = somarDias(hoje, desvio);
    for (const intervalo of horario.dias[data.diaDaSemana] ?? []) {
      const de = minutosDe(intervalo.inicio, false);
      const ate = minutosDe(intervalo.fim, true);
      if (de === null || ate === null || ate <= de) {
        continue;
      }
      periodos.push({
        inicio: instanteLocal(
          data.ano,
          data.mes,
          data.dia,
          de,
          horario.fusoHorario,
        ),
        fim: instanteLocal(
          data.ano,
          data.mes,
          data.dia,
          ate,
          horario.fusoHorario,
        ),
      });
    }
  }
  periodos.sort((a, b) => a.inicio.getTime() - b.inicio.getTime());
  const juntos: Array<{ inicio: Date; fim: Date }> = [];
  for (const periodo of periodos) {
    const ultimo = juntos.at(-1);
    if (ultimo && periodo.inicio.getTime() <= ultimo.fim.getTime()) {
      if (periodo.fim > ultimo.fim) {
        ultimo.fim = periodo.fim;
      }
    } else {
      juntos.push({ ...periodo });
    }
  }
  return juntos;
}

/** O canal atende agora? E desde/até quando? Sem horário = sempre aberto. */
export function situacaoDoHorario(
  horario: HorarioDeAtendimento | null,
  agora: Date = new Date(),
): SituacaoDoHorario {
  if (!horario) {
    return SEMPRE_ABERTO;
  }
  const momento = agora.getTime();
  const periodos = periodosAbertos(horario, agora);
  const atual = periodos.find(
    (periodo) =>
      periodo.inicio.getTime() <= momento && momento < periodo.fim.getTime(),
  );
  if (atual) {
    const ultimoDia = periodos.at(-1);
    return {
      aberto: true,
      fechadoDesde: null,
      proximaAbertura: null,
      // Período que chega ao fim da janela pesquisada: "não fecha" por ora.
      proximoFechamento: atual === ultimoDia ? null : atual.fim,
    };
  }
  let fechadoDesde: Date | null = null;
  let proximaAbertura: Date | null = null;
  for (const periodo of periodos) {
    if (periodo.fim.getTime() <= momento) {
      fechadoDesde = periodo.fim;
    } else if (periodo.inicio.getTime() > momento && !proximaAbertura) {
      proximaAbertura = periodo.inicio;
    }
  }
  return {
    aberto: false,
    fechadoDesde,
    proximaAbertura,
    proximoFechamento: null,
  };
}

/**
 * Início da contagem do SLA (R12): a chegada da mensagem — ou a abertura
 * seguinte, quando ela chega fora do horário de atendimento.
 */
export function inicioDaContagem(
  horario: HorarioDeAtendimento | null,
  chegada: Date,
): Date {
  const situacao = situacaoDoHorario(horario, chegada);
  return !situacao.aberto && situacao.proximaAbertura
    ? situacao.proximaAbertura
    : chegada;
}

/**
 * A resposta automática de fora do horário já saiu neste período fechado?
 * (Uma vez por conversa por período: depois que o canal abre e fecha de novo,
 * a próxima mensagem fora do horário recebe outra.)
 */
export function jaRespondeuForaDoHorario(
  respondidoEm: Date | null,
  situacao: SituacaoDoHorario,
): boolean {
  if (!respondidoEm) {
    return false;
  }
  return !situacao.fechadoDesde || respondidoEm >= situacao.fechadoDesde;
}
