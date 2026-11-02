/**
 * Gatilhos de agenda das automações (Onda B, §2.5): recorrência e "N dias
 * antes/depois de" um campo de data. Funções puras, no fuso de São Paulo por
 * padrão (o mesmo dos agendamentos da fila).
 */
import {
  dataLocal,
  ehFusoHorarioValido,
  inicioDoDia,
} from '../../atividades/fuso-horario';
import { FUSO_HORARIO_PADRAO } from '../../fila/fila.service';

/** Recorrência: `{ frequencia: 'semanal', hora: '09:00', diasDaSemana: [1, 3] }`. */
export interface Recorrencia {
  frequencia: 'diaria' | 'semanal' | 'mensal';
  /** `HH:MM`, hora local. */
  hora: string;
  /** Semanal: 0 = domingo … 6 = sábado. */
  diasDaSemana?: number[];
  /** Mensal: 1 a 31 (num mês mais curto, vale o último dia). */
  diaDoMes?: number;
  /** Padrão: America/Sao_Paulo. */
  fusoHorario?: string;
}

/**
 * Data relativa: dispara `dias` depois (negativo = antes) da data em `campo`,
 * na `hora` local. Ex.: `{ campo: 'negocio.previsaoFechamento', dias: -3, hora: '09:00' }`.
 */
export interface DataRelativa {
  campo: string;
  dias: number;
  hora: string;
  fusoHorario?: string;
}

/**
 * Campos de data aceitos na data relativa (a busca é do módulo de automações).
 * Também vale `contato.campos.<chave>` (campo personalizado com data `AAAA-MM-DD`).
 */
export const CAMPOS_DE_DATA_RELATIVA = {
  'contato.criadoEm': { rotulo: 'Criação do contato', entidade: 'contato' },
  'negocio.criadoEm': { rotulo: 'Criação do negócio', entidade: 'negocio' },
  'negocio.previsaoFechamento': {
    rotulo: 'Previsão de fechamento',
    entidade: 'negocio',
  },
  'negocio.ganhoEm': { rotulo: 'Data do ganho', entidade: 'negocio' },
  'atividade.venceEm': {
    rotulo: 'Vencimento da atividade',
    entidade: 'atividade',
  },
} as const;

const HORA = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Problema da recorrência, ou nulo. */
export function problemaDaRecorrencia(entrada: unknown): string | null {
  if (!ehObjeto(entrada)) {
    return 'Informe a recorrência.';
  }
  if (!['diaria', 'semanal', 'mensal'].includes(entrada.frequencia as string)) {
    return 'A frequência deve ser diária, semanal ou mensal.';
  }
  if (typeof entrada.hora !== 'string' || !HORA.test(entrada.hora)) {
    return 'Informe a hora no formato HH:MM.';
  }
  if (entrada.frequencia === 'semanal') {
    const dias = entrada.diasDaSemana;
    if (
      !Array.isArray(dias) ||
      dias.length === 0 ||
      !dias.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)
    ) {
      return 'Escolha ao menos um dia da semana.';
    }
  }
  if (entrada.frequencia === 'mensal') {
    const dia = entrada.diaDoMes;
    if (!Number.isInteger(dia) || (dia as number) < 1 || (dia as number) > 31) {
      return 'Informe o dia do mês (1 a 31).';
    }
  }
  if (
    entrada.fusoHorario !== undefined &&
    (typeof entrada.fusoHorario !== 'string' ||
      !ehFusoHorarioValido(entrada.fusoHorario))
  ) {
    return 'Fuso horário inválido.';
  }
  return null;
}

/** Problema da data relativa, ou nulo. */
export function problemaDaDataRelativa(entrada: unknown): string | null {
  if (!ehObjeto(entrada)) {
    return 'Informe a data relativa.';
  }
  const campo = entrada.campo;
  if (
    typeof campo !== 'string' ||
    !(
      campo in CAMPOS_DE_DATA_RELATIVA ||
      (campo.startsWith('contato.campos.') && campo.length > 15)
    )
  ) {
    return 'Campo de data inválido.';
  }
  if (
    !Number.isInteger(entrada.dias) ||
    Math.abs(entrada.dias as number) > 3_650
  ) {
    return 'Informe quantos dias antes ou depois.';
  }
  if (typeof entrada.hora !== 'string' || !HORA.test(entrada.hora)) {
    return 'Informe a hora no formato HH:MM.';
  }
  if (
    entrada.fusoHorario !== undefined &&
    (typeof entrada.fusoHorario !== 'string' ||
      !ehFusoHorarioValido(entrada.fusoHorario))
  ) {
    return 'Fuso horário inválido.';
  }
  return null;
}

/** Instante de `HH:MM` no dia local (ano, mês, dia) do fuso. */
export function momentoLocal(
  ano: number,
  mes: number,
  dia: number,
  hora: string,
  fuso: string,
): Date {
  const [h, m] = hora.split(':').map(Number);
  return new Date(
    inicioDoDia(ano, mes, dia, fuso).getTime() + (h * 60 + m) * 60_000,
  );
}

/** Primeira ocorrência da recorrência estritamente depois de `apos`. */
export function proximaOcorrencia(recorrencia: Recorrencia, apos: Date): Date {
  const fuso = recorrencia.fusoHorario ?? FUSO_HORARIO_PADRAO;
  const hoje = dataLocal(apos, fuso);
  for (let deslocamento = 0; deslocamento <= 400; deslocamento++) {
    const dia = new Date(
      Date.UTC(hoje.ano, hoje.mes - 1, hoje.dia + deslocamento),
    );
    const ano = dia.getUTCFullYear();
    const mes = dia.getUTCMonth() + 1;
    const diaDoMes = dia.getUTCDate();
    if (!casaComRecorrencia(recorrencia, ano, mes, diaDoMes, dia.getUTCDay())) {
      continue;
    }
    const momento = momentoLocal(ano, mes, diaDoMes, recorrencia.hora, fuso);
    if (momento.getTime() > apos.getTime()) {
      return momento;
    }
  }
  throw new Error('Recorrência sem ocorrência no próximo ano.');
}

function casaComRecorrencia(
  recorrencia: Recorrencia,
  ano: number,
  mes: number,
  dia: number,
  diaDaSemana: number,
): boolean {
  switch (recorrencia.frequencia) {
    case 'diaria':
      return true;
    case 'semanal':
      return (recorrencia.diasDaSemana ?? []).includes(diaDaSemana);
    case 'mensal': {
      const ultimoDia = new Date(Date.UTC(ano, mes, 0)).getUTCDate();
      return dia === Math.min(recorrencia.diaDoMes ?? 1, ultimoDia);
    }
  }
}

/** Alvo da data relativa num dia: que data o campo precisa ter para disparar hoje. */
export interface AlvoDaDataRelativa {
  /** Data (`AAAA-MM-DD`) que o campo precisa ter — compare assim colunas `date` e campos personalizados. */
  diaDoCampo: string;
  /** Início e fim (exclusivo) desse dia no fuso — compare assim colunas `timestamptz`. */
  inicio: Date;
  fim: Date;
  /** Quando dispara hoje (a `hora` local de hoje). */
  momentoDoDisparo: Date;
}

/**
 * Para o dia local de `agora`: a data do campo que faz a regra disparar hoje
 * (hoje − `dias`) e o momento do disparo. O módulo de automações busca as
 * entidades com o campo nesse dia e inicia uma execução por entidade, com
 * `chaveUnica = automacao:<id>:data:<entidadeId>:<diaDoCampo>`.
 */
export function alvoDaDataRelativa(
  regra: DataRelativa,
  agora: Date,
): AlvoDaDataRelativa {
  const fuso = regra.fusoHorario ?? FUSO_HORARIO_PADRAO;
  const hoje = dataLocal(agora, fuso);
  const campo = new Date(
    Date.UTC(hoje.ano, hoje.mes - 1, hoje.dia - regra.dias),
  );
  const ano = campo.getUTCFullYear();
  const mes = campo.getUTCMonth() + 1;
  const dia = campo.getUTCDate();
  return {
    diaDoCampo: `${ano}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`,
    inicio: inicioDoDia(ano, mes, dia, fuso),
    fim: inicioDoDia(ano, mes, dia + 1, fuso),
    momentoDoDisparo: momentoLocal(
      hoje.ano,
      hoje.mes,
      hoje.dia,
      regra.hora,
      fuso,
    ),
  };
}

/** Próxima varredura da data relativa (todo dia na `hora`) depois de `apos`. */
export function proximaVarreduraDaDataRelativa(
  regra: DataRelativa,
  apos: Date,
): Date {
  return proximaOcorrencia(
    { frequencia: 'diaria', hora: regra.hora, fusoHorario: regra.fusoHorario },
    apos,
  );
}

function ehObjeto(valor: unknown): valor is Record<string, unknown> {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor);
}
