/**
 * Regras puras da qualificação do SDR (R31): interpretar o valor de um
 * critério pelo tipo, calcular a nota e a temperatura, e decidir o que a ação
 * pedida pela IA vira de fato. Sem banco nem rede.
 *
 * - **Nota** (0 a 100): soma dos pesos dos critérios descobertos com confiança
 *   suficiente, sobre a soma dos pesos de todos os critérios ativos.
 * - **Temperatura**: quente (nota >= faixa quente), morno (>= faixa morna), frio.
 * - **Qualificado**: todos os critérios obrigatórios descobertos (com
 *   confiança suficiente) e nota >= nota mínima.
 */
import type {
  AcaoSdr,
  AlvoCriterioSdr,
  TemperaturaSdr,
  TipoCriterioSdr,
} from '../generated/prisma/client';
import { MAX_CARACTERES_VALOR_SDR } from './sdr.constantes';

/** O critério como o motor o usa. */
export interface CriterioDoMotor {
  chave: string;
  rotulo: string;
  instrucao: string;
  tipo: TipoCriterioSdr;
  opcoes: string[];
  alvo: AlvoCriterioSdr;
  campo: string | null;
  peso: number;
  obrigatorio: boolean;
}

export type ValorDeCriterio = string | number | boolean;

/** Um valor já interpretado e guardado. */
export interface ValorDescoberto {
  chave: string;
  valor: ValorDeCriterio;
  /** 0 a 1. */
  confianca: number;
}

/** O que a IA devolveu para um critério (ainda sem confiar). */
export interface CriterioDaIa {
  chave: string;
  valor: string;
  confianca: number;
}

export interface FaixasDeTemperatura {
  quente: number;
  morno: number;
}

export interface ParametrosDeQualificacao {
  notaMinima: number;
  faixas: FaixasDeTemperatura;
  /** Confiança mínima para valer (0 a 1). */
  confiancaMinima: number;
}

function semAcento(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Chave estável: minúsculas, sem acento, números e `_`. */
export function normalizarChave(texto: string): string {
  return semAcento(texto)
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export type Interpretacao =
  { ok: true; valor: ValorDeCriterio } | { ok: false; motivo: string };

function interpretarNumero(texto: string): number | null {
  let limpo = texto.replace(/[^\d.,-]/g, '');
  if (!/\d/.test(limpo)) {
    return null;
  }
  if (limpo.includes(',')) {
    limpo = limpo.replace(/\./g, '').replace(',', '.');
  } else if (/^-?\d{1,3}(\.\d{3})+$/.test(limpo)) {
    limpo = limpo.replace(/\./g, '');
  }
  const numero = Number(limpo);
  return Number.isFinite(numero) ? numero : null;
}

function interpretarData(texto: string): string | null {
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(texto.trim());
  const br = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(texto.trim());
  const [ano, mes, dia] = iso
    ? [Number(iso[1]), Number(iso[2]), Number(iso[3])]
    : br
      ? [Number(br[3]), Number(br[2]), Number(br[1])]
      : [0, 0, 0];
  if (!ano) {
    return null;
  }
  const data = new Date(Date.UTC(ano, mes - 1, dia));
  if (
    data.getUTCFullYear() !== ano ||
    data.getUTCMonth() !== mes - 1 ||
    data.getUTCDate() !== dia
  ) {
    return null;
  }
  return `${String(ano).padStart(4, '0')}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
}

const SIM = new Set(['sim', 's', 'yes', 'true', '1', 'verdadeiro']);
const NAO = new Set(['nao', 'n', 'no', 'false', '0', 'falso']);

/** Interpreta o texto que a IA devolveu conforme o tipo do critério. */
export function interpretarValor(
  criterio: Pick<CriterioDoMotor, 'tipo' | 'opcoes'>,
  bruto: unknown,
): Interpretacao {
  const texto =
    typeof bruto === 'string'
      ? bruto.trim()
      : typeof bruto === 'number' || typeof bruto === 'boolean'
        ? String(bruto)
        : '';
  if (!texto) {
    return { ok: false, motivo: 'valor vazio' };
  }
  switch (criterio.tipo) {
    case 'TEXTO':
      return {
        ok: true,
        valor:
          texto.length > MAX_CARACTERES_VALOR_SDR
            ? `${texto.slice(0, MAX_CARACTERES_VALOR_SDR - 1)}…`
            : texto,
      };
    case 'OPCAO': {
      const alvo = semAcento(texto);
      const achada = criterio.opcoes.find((o) => semAcento(o) === alvo);
      return achada
        ? { ok: true, valor: achada }
        : { ok: false, motivo: 'fora das opções do critério' };
    }
    case 'NUMERO': {
      const numero = interpretarNumero(texto);
      return numero === null
        ? { ok: false, motivo: 'não é um número' }
        : { ok: true, valor: numero };
    }
    case 'DATA': {
      const data = interpretarData(texto);
      return data === null
        ? { ok: false, motivo: 'não é uma data válida' }
        : { ok: true, valor: data };
    }
    case 'SIM_NAO': {
      const alvo = semAcento(texto);
      if (SIM.has(alvo)) {
        return { ok: true, valor: true };
      }
      if (NAO.has(alvo)) {
        return { ok: true, valor: false };
      }
      return { ok: false, motivo: 'não é sim nem não' };
    }
  }
}

/** O valor como texto para notas e telas ("Sim", "1.500", "03/02/2027"). */
export function formatarValor(
  criterio: Pick<CriterioDoMotor, 'tipo'>,
  valor: ValorDeCriterio,
): string {
  if (typeof valor === 'boolean') {
    return valor ? 'Sim' : 'Não';
  }
  if (criterio.tipo === 'DATA' && typeof valor === 'string') {
    const [ano, mes, dia] = valor.split('-');
    return ano && mes && dia ? `${dia}/${mes}/${ano}` : valor;
  }
  return String(valor);
}

function confiancaValida(confianca: unknown): number {
  const numero = typeof confianca === 'number' ? confianca : Number.NaN;
  if (!Number.isFinite(numero)) {
    return 0;
  }
  return Math.min(1, Math.max(0, Math.round(numero * 100) / 100));
}

/** Nota de 0 a 100 pelos pesos dos critérios descobertos. */
export function calcularNota(
  criterios: readonly CriterioDoMotor[],
  valores: ReadonlyMap<string, ValorDescoberto>,
  confiancaMinima: number,
): number {
  const total = criterios.reduce((soma, c) => soma + c.peso, 0);
  if (total <= 0) {
    return 0;
  }
  const obtido = criterios.reduce((soma, c) => {
    const v = valores.get(c.chave);
    return v && v.confianca >= confiancaMinima ? soma + c.peso : soma;
  }, 0);
  return Math.round((obtido / total) * 100);
}

export function temperaturaDaNota(
  nota: number,
  faixas: FaixasDeTemperatura,
): TemperaturaSdr {
  if (nota >= faixas.quente) {
    return 'QUENTE';
  }
  return nota >= faixas.morno ? 'MORNO' : 'FRIO';
}

export interface AvaliacaoDaQualificacao {
  nota: number;
  temperatura: TemperaturaSdr;
  /** Chaves dos obrigatórios que ainda faltam (ou sem confiança). */
  faltamObrigatorios: string[];
  /** Chaves de todos os critérios ainda sem valor confiável. */
  faltam: string[];
  qualificado: boolean;
}

export function avaliarQualificacao(
  criterios: readonly CriterioDoMotor[],
  valores: ReadonlyMap<string, ValorDescoberto>,
  parametros: ParametrosDeQualificacao,
): AvaliacaoDaQualificacao {
  const nota = calcularNota(criterios, valores, parametros.confiancaMinima);
  const sem = criterios.filter((c) => {
    const v = valores.get(c.chave);
    return !v || v.confianca < parametros.confiancaMinima;
  });
  const faltamObrigatorios = sem
    .filter((c) => c.obrigatorio)
    .map((c) => c.chave);
  return {
    nota,
    temperatura: temperaturaDaNota(nota, parametros.faixas),
    faltamObrigatorios,
    faltam: sem.map((c) => c.chave),
    qualificado:
      criterios.length > 0 &&
      faltamObrigatorios.length === 0 &&
      nota >= parametros.notaMinima,
  };
}

export interface EntradaDoTurno {
  criterios: readonly CriterioDoMotor[];
  /** Valores já descobertos antes deste turno. */
  anteriores: ReadonlyMap<string, ValorDescoberto>;
  /** O que a IA devolveu neste turno. */
  daIa: readonly CriterioDaIa[];
  acao: AcaoSdr;
  parametros: ParametrosDeQualificacao;
}

export interface ResultadoDoTurno {
  /** Valores aceitos neste turno (novos ou que mudaram). */
  aceitos: ValorDescoberto[];
  /** Critérios que a IA devolveu e foram recusados, com o motivo. */
  recusados: { chave: string; motivo: string }[];
  /** Valores depois do turno (anteriores + aceitos). */
  valores: Map<string, ValorDescoberto>;
  avaliacao: AvaliacaoDaQualificacao;
  /** O que a ação pedida vira (um "qualificado" sem critérios volta a "continuar"). */
  acao: AcaoSdr;
  /** Por que a ação foi trocada (nulo = foi a pedida). */
  motivoDaTroca: string | null;
  /** O turno não trouxe nada novo para a qualificação. */
  semAvanco: boolean;
}

/**
 * Aplica o que a IA devolveu: aceita os critérios válidos (chave conhecida,
 * valor do tipo certo, confiança suficiente para valer), recalcula nota e
 * temperatura e confere se "qualificado" se sustenta.
 */
export function interpretarTurno(entrada: EntradaDoTurno): ResultadoDoTurno {
  const porChave = new Map(entrada.criterios.map((c) => [c.chave, c]));
  const valores = new Map(entrada.anteriores);
  const aceitos: ValorDescoberto[] = [];
  const recusados: { chave: string; motivo: string }[] = [];
  for (const item of entrada.daIa) {
    const chave = normalizarChave(String(item.chave ?? ''));
    const criterio = porChave.get(chave);
    if (!criterio) {
      recusados.push({
        chave: String(item.chave),
        motivo: 'critério desconhecido',
      });
      continue;
    }
    const interpretado = interpretarValor(criterio, item.valor);
    if (!interpretado.ok) {
      recusados.push({ chave, motivo: interpretado.motivo });
      continue;
    }
    const confianca = confiancaValida(item.confianca);
    if (confianca < entrada.parametros.confiancaMinima) {
      recusados.push({ chave, motivo: 'confiança baixa' });
      continue;
    }
    const antes = valores.get(chave);
    if (antes && antes.valor === interpretado.valor) {
      // Mesmo valor: só guarda se a confiança subiu.
      if (confianca > antes.confianca) {
        const atualizado = { chave, valor: interpretado.valor, confianca };
        valores.set(chave, atualizado);
        aceitos.push(atualizado);
      }
      continue;
    }
    const novo = { chave, valor: interpretado.valor, confianca };
    valores.set(chave, novo);
    aceitos.push(novo);
  }
  const avaliacao = avaliarQualificacao(
    entrada.criterios,
    valores,
    entrada.parametros,
  );
  let acao = entrada.acao;
  let motivoDaTroca: string | null = null;
  if (acao === 'QUALIFICADO' && !avaliacao.qualificado) {
    acao = 'CONTINUAR';
    motivoDaTroca =
      avaliacao.faltamObrigatorios.length > 0
        ? `Faltam critérios obrigatórios: ${avaliacao.faltamObrigatorios.join(', ')}.`
        : `A nota ${avaliacao.nota} está abaixo da mínima ${entrada.parametros.notaMinima}.`;
  }
  return {
    aceitos,
    recusados,
    valores,
    avaliacao,
    acao,
    motivoDaTroca,
    semAvanco: aceitos.length === 0,
  };
}
