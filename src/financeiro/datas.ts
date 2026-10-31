/**
 * Datas do Financeiro: vencimentos são datas (`AAAA-MM-DD`) no fuso de São Paulo,
 * gravadas como `DATE`. Funções puras.
 */
import { dataLocal } from '../atividades/fuso-horario';
import type { PeriodicidadeContrato } from '../generated/prisma/client';
import {
  FAIXAS_DE_ATRASO,
  type FaixaDeAtraso,
  FUSO_DO_FINANCEIRO,
} from './financeiro.constantes';

const DATA = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `AAAA-MM-DD` é uma data de calendário que existe? */
export function ehDataIso(texto: unknown): texto is string {
  if (typeof texto !== 'string') {
    return false;
  }
  const m = DATA.exec(texto);
  if (!m) {
    return false;
  }
  const d = new Date(`${texto}T00:00:00.000Z`);
  return (
    !Number.isNaN(d.getTime()) &&
    d.getUTCFullYear() === Number(m[1]) &&
    d.getUTCMonth() + 1 === Number(m[2]) &&
    d.getUTCDate() === Number(m[3])
  );
}

/** Data de hoje no fuso do Financeiro, `AAAA-MM-DD`. */
export function hojeLocal(
  agora: Date = new Date(),
  fuso: string = FUSO_DO_FINANCEIRO,
): string {
  const l = dataLocal(agora, fuso);
  return `${String(l.ano).padStart(4, '0')}-${String(l.mes).padStart(2, '0')}-${String(l.dia).padStart(2, '0')}`;
}

/** `AAAA-MM-DD` → `Date` (meia-noite UTC) para colunas `DATE`. */
export function paraDataDoBanco(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

/** Coluna `DATE` → `AAAA-MM-DD`. */
export function deDataDoBanco(data: Date): string {
  return data.toISOString().slice(0, 10);
}

export function deDataDoBancoOuNulo(data: Date | null): string | null {
  return data ? deDataDoBanco(data) : null;
}

/** Dias de `de` até `ate` (positivo quando `ate` é depois). */
export function diasEntre(de: string, ate: string): number {
  return Math.round(
    (paraDataDoBanco(ate).getTime() - paraDataDoBanco(de).getTime()) /
      86_400_000,
  );
}

export function somarDias(iso: string, dias: number): string {
  return deDataDoBanco(
    new Date(paraDataDoBanco(iso).getTime() + dias * 86_400_000),
  );
}

/** Último dia do mês (`ano`, `mes` de 1 a 12). */
export function ultimoDiaDoMes(ano: number, mes: number): number {
  return new Date(Date.UTC(ano, mes, 0)).getUTCDate();
}

/**
 * Soma meses mantendo o dia (ou `dia`); mês mais curto usa o último dia.
 * `somarMeses('2026-01-31', 1)` → `2026-02-28`.
 */
export function somarMeses(iso: string, meses: number, dia?: number): string {
  const [ano, mes, diaOriginal] = iso.split('-').map(Number);
  const total = ano * 12 + (mes - 1) + meses;
  const novoAno = Math.floor(total / 12);
  const novoMes = (total % 12) + 1;
  const d = Math.min(dia ?? diaOriginal, ultimoDiaDoMes(novoAno, novoMes));
  return `${String(novoAno).padStart(4, '0')}-${String(novoMes).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Primeiro dia do mês da data (`2026-03-17` → `2026-03-01`). */
export function inicioDoMes(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}

/** `AAAA-MM` do mês da data. */
export function mesDe(iso: string): string {
  return iso.slice(0, 7);
}

/** Meses de `AAAA-MM` a `AAAA-MM` (inclusive). */
export function mesesEntre(de: string, ate: string): string[] {
  const lista: string[] = [];
  let atual = `${de}-01`;
  const fim = `${ate}-01`;
  while (atual <= fim && lista.length < 600) {
    lista.push(atual.slice(0, 7));
    atual = somarMeses(atual, 1, 1);
  }
  return lista;
}

/** Último dia do mês `AAAA-MM`. */
export function fimDoMes(mes: string): string {
  const [ano, m] = mes.split('-').map(Number);
  return `${mes}-${String(ultimoDiaDoMes(ano, m)).padStart(2, '0')}`;
}

/** Meses de cada período de cobrança; 0 = cobrança única. */
export function mesesDaPeriodicidade(p: PeriodicidadeContrato): number {
  switch (p) {
    case 'MENSAL':
      return 1;
    case 'BIMESTRAL':
      return 2;
    case 'TRIMESTRAL':
      return 3;
    case 'SEMESTRAL':
      return 6;
    case 'ANUAL':
      return 12;
    default:
      return 0;
  }
}

/** MRR equivalente do valor de um período, em centavos (arredonda ao centavo). */
export function mrrEmCentavos(
  valorEmCentavos: number,
  periodicidade: PeriodicidadeContrato,
): number {
  const meses = mesesDaPeriodicidade(periodicidade);
  return meses === 0 ? 0 : Math.round(valorEmCentavos / meses);
}

/** Faixa de inadimplência dos dias de atraso (≥ 1); `null` se não está atrasada. */
export function faixaDeAtraso(diasEmAtraso: number): FaixaDeAtraso | null {
  if (diasEmAtraso < 1) {
    return null;
  }
  if (diasEmAtraso <= 30) {
    return FAIXAS_DE_ATRASO[0];
  }
  if (diasEmAtraso <= 60) {
    return FAIXAS_DE_ATRASO[1];
  }
  if (diasEmAtraso <= 90) {
    return FAIXAS_DE_ATRASO[2];
  }
  return FAIXAS_DE_ATRASO[3];
}

/** Limites `[de, ate]` (dias de atraso, inclusive) de uma faixa; `ate` nulo = sem teto. */
export function limitesDaFaixa(faixa: FaixaDeAtraso): {
  de: number;
  ate: number | null;
} {
  switch (faixa) {
    case '0-30':
      return { de: 1, ate: 30 };
    case '31-60':
      return { de: 31, ate: 60 };
    case '61-90':
      return { de: 61, ate: 90 };
    default:
      return { de: 91, ate: null };
  }
}

/** `HH:MM` → minutos desde a meia-noite. */
export function minutosDoHorario(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/**
 * Vencimentos de um contrato: uma parcela por período a partir do início, até a
 * data final (`ate`, inclusive) ou `quantidade` (padrão 12 quando não há fim).
 */
export function vencimentosDoContrato(opcoes: {
  inicio: string;
  periodicidade: PeriodicidadeContrato;
  diaVencimento?: number | null;
  ate?: string | null;
  quantidade?: number;
  /** Primeiro período a gerar (0 = o início do contrato). */
  aPartirDoPeriodo?: number;
  limite: number;
}): string[] {
  const meses = mesesDaPeriodicidade(opcoes.periodicidade);
  if (meses === 0) {
    return [primeiroVencimento(opcoes.inicio, opcoes.diaVencimento)];
  }
  const maximo = Math.min(
    opcoes.quantidade ?? (opcoes.ate ? opcoes.limite : 12),
    opcoes.limite,
  );
  const lista: string[] = [];
  for (let k = opcoes.aPartirDoPeriodo ?? 0; lista.length < maximo; k++) {
    const vencimento = somarMeses(
      opcoes.inicio,
      k * meses,
      opcoes.diaVencimento ?? undefined,
    );
    if (vencimento < opcoes.inicio) {
      // Dia de vencimento já passado no mês de início: a cobrança começa no período seguinte.
      continue;
    }
    if (opcoes.ate && vencimento > opcoes.ate) {
      break;
    }
    lista.push(vencimento);
  }
  return lista;
}

function primeiroVencimento(inicio: string, dia?: number | null): string {
  if (!dia) {
    return inicio;
  }
  const v = somarMeses(inicio, 0, dia);
  return v < inicio ? somarMeses(inicio, 1, dia) : v;
}
