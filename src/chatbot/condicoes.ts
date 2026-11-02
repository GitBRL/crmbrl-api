/**
 * Condições do passo `condicao` do chatbot (R18): variável, campo do contato,
 * horário, etiqueta e canal. Cada ramo do passo carrega a sua condição em
 * `ramo.config` (`{ condicao }` ou `{ condicoes: [...] }` — todas valem); o
 * primeiro ramo que bate é o escolhido, e o ramo sem condição é o "senão".
 */
import {
  FUSO_HORARIO_PADRAO,
  lerHorario,
  partesLocais,
  situacaoDoHorario,
} from '../atendimento/horario';
import { normalizarParaComparar } from './respostas';

export const OPERADORES_DE_CONDICAO = [
  'igual',
  'diferente',
  'contem',
  'comeca_com',
  'existe',
  'nao_existe',
  'maior',
  'menor',
] as const;
export type OperadorDeCondicao = (typeof OPERADORES_DE_CONDICAO)[number];

export type Condicao =
  | {
      tipo: 'variavel';
      chave: string;
      operador: OperadorDeCondicao;
      valor?: unknown;
    }
  | {
      tipo: 'campo_contato';
      /** `nome`, `email`, `telefone`, `cargo` ou `campos.<chave>`. */
      campo: string;
      operador: OperadorDeCondicao;
      valor?: unknown;
    }
  | {
      tipo: 'horario';
      /** Padrão `true`: "dentro do horário". */
      dentro?: boolean;
      /** Janela no formato de `canais.horario_atendimento`; sem ela, a do canal. */
      janela?: unknown;
    }
  | { tipo: 'etiqueta'; etiqueta: string; tem?: boolean }
  | {
      tipo: 'canal';
      canalTipos?: string[];
      canalIds?: string[];
    };

export interface AmbienteDeCondicao {
  variaveis: Readonly<Record<string, unknown>>;
  contato: {
    nome?: string | null;
    email?: string | null;
    telefone?: string | null;
    cargo?: string | null;
    etiquetas?: readonly string[];
    campos?: Readonly<Record<string, unknown>>;
  } | null;
  canal: { id: string; tipo: string; horarioAtendimento?: unknown } | null;
  agora: Date;
}

const TIPOS_DE_CONDICAO = [
  'variavel',
  'campo_contato',
  'horario',
  'etiqueta',
  'canal',
] as const;

function comoTexto(valor: unknown): string {
  if (valor === null || valor === undefined) {
    return '';
  }
  return typeof valor === 'string'
    ? valor
    : typeof valor === 'number' || typeof valor === 'boolean'
      ? String(valor)
      : JSON.stringify(valor);
}

function comoNumero(valor: unknown): number | null {
  if (typeof valor === 'number') {
    return Number.isFinite(valor) ? valor : null;
  }
  if (typeof valor === 'string' && valor.trim() !== '') {
    const n = Number(valor.replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Compara o valor atual com o esperado pelo operador (sem acento nem caixa). */
export function compararValores(
  atual: unknown,
  operador: OperadorDeCondicao,
  esperado: unknown,
): boolean {
  const existe =
    atual !== null &&
    atual !== undefined &&
    !(typeof atual === 'string' && atual.trim() === '') &&
    !(Array.isArray(atual) && atual.length === 0);
  if (operador === 'existe') {
    return existe;
  }
  if (operador === 'nao_existe') {
    return !existe;
  }
  if (operador === 'maior' || operador === 'menor') {
    const a = comoNumero(atual);
    const b = comoNumero(esperado);
    if (a === null || b === null) {
      return false;
    }
    return operador === 'maior' ? a > b : a < b;
  }
  const a = normalizarParaComparar(comoTexto(atual));
  const b = normalizarParaComparar(comoTexto(esperado));
  switch (operador) {
    case 'igual':
      return a === b;
    case 'diferente':
      return a !== b;
    case 'contem':
      return b !== '' && a.includes(b);
    case 'comeca_com':
      return b !== '' && a.startsWith(b);
    default:
      return false;
  }
}

function valorDoCampo(
  contato: NonNullable<AmbienteDeCondicao['contato']>,
  campo: string,
): unknown {
  if (campo.startsWith('campos.')) {
    return contato.campos?.[campo.slice('campos.'.length)];
  }
  switch (campo) {
    case 'nome':
      return contato.nome;
    case 'email':
      return contato.email;
    case 'telefone':
      return contato.telefone;
    case 'cargo':
      return contato.cargo;
    default:
      return undefined;
  }
}

export function avaliarCondicao(
  condicao: Condicao,
  ambiente: AmbienteDeCondicao,
): boolean {
  switch (condicao.tipo) {
    case 'variavel':
      return compararValores(
        ambiente.variaveis[condicao.chave],
        condicao.operador,
        condicao.valor,
      );
    case 'campo_contato':
      return compararValores(
        ambiente.contato
          ? valorDoCampo(ambiente.contato, condicao.campo)
          : null,
        condicao.operador,
        condicao.valor,
      );
    case 'horario': {
      const janela = lerHorario(
        condicao.janela ?? ambiente.canal?.horarioAtendimento ?? null,
      );
      const aberto = situacaoDoHorario(janela, ambiente.agora).aberto;
      return aberto === (condicao.dentro ?? true);
    }
    case 'etiqueta': {
      const alvo = normalizarParaComparar(condicao.etiqueta);
      const tem = (ambiente.contato?.etiquetas ?? []).some(
        (e) => normalizarParaComparar(e) === alvo,
      );
      return tem === (condicao.tem ?? true);
    }
    case 'canal': {
      if (!ambiente.canal) {
        return false;
      }
      const porTipo =
        !condicao.canalTipos?.length ||
        condicao.canalTipos.includes(ambiente.canal.tipo);
      const porId =
        !condicao.canalIds?.length ||
        condicao.canalIds.includes(ambiente.canal.id);
      return porTipo && porId;
    }
    default:
      return false;
  }
}

/** Condições de um ramo (`config.condicao` ou `config.condicoes`); vazio = "senão". */
export function condicoesDoRamo(
  config: Record<string, unknown> | undefined,
): Condicao[] {
  if (!config) {
    return [];
  }
  const lista: unknown[] = Array.isArray(config.condicoes)
    ? config.condicoes
    : config.condicao
      ? [config.condicao]
      : [];
  return lista as Condicao[];
}

/** Mensagem do problema da condição, ou nulo se estiver completa. */
export function problemaDaCondicao(bruta: unknown): string | null {
  if (typeof bruta !== 'object' || bruta === null) {
    return 'A condição está incompleta.';
  }
  const c = bruta as Record<string, unknown>;
  if (
    !TIPOS_DE_CONDICAO.includes(c.tipo as (typeof TIPOS_DE_CONDICAO)[number])
  ) {
    return 'Escolha o tipo da condição.';
  }
  const precisaOperador = c.tipo === 'variavel' || c.tipo === 'campo_contato';
  if (precisaOperador) {
    if (!OPERADORES_DE_CONDICAO.includes(c.operador as OperadorDeCondicao)) {
      return 'Escolha o operador da condição.';
    }
    const semValor = c.operador === 'existe' || c.operador === 'nao_existe';
    if (
      !semValor &&
      (c.valor === undefined || c.valor === null || c.valor === '')
    ) {
      return 'Informe o valor da condição.';
    }
  }
  if (
    c.tipo === 'variavel' &&
    (typeof c.chave !== 'string' || c.chave === '')
  ) {
    return 'Informe a variável da condição.';
  }
  if (
    c.tipo === 'campo_contato' &&
    (typeof c.campo !== 'string' || c.campo === '')
  ) {
    return 'Informe o campo do contato.';
  }
  if (
    c.tipo === 'etiqueta' &&
    (typeof c.etiqueta !== 'string' || c.etiqueta.trim() === '')
  ) {
    return 'Informe a etiqueta.';
  }
  if (
    c.tipo === 'canal' &&
    !(Array.isArray(c.canalTipos) && c.canalTipos.length > 0) &&
    !(Array.isArray(c.canalIds) && c.canalIds.length > 0)
  ) {
    return 'Escolha ao menos um canal.';
  }
  return null;
}

/**
 * Uma janela de atendimento que está fechada em `agora` (aberta só dois dias
 * adiante, das 8h às 18h): o simulador a usa para "simular fora do horário".
 */
export function janelaFechadaEm(agora: Date = new Date()): {
  fusoHorario: string;
  dias: Record<string, Array<{ inicio: string; fim: string }>>;
} {
  const hoje = partesLocais(agora, FUSO_HORARIO_PADRAO);
  const diaDaSemana = new Date(
    Date.UTC(hoje.ano, hoje.mes - 1, hoje.dia),
  ).getUTCDay();
  return {
    fusoHorario: FUSO_HORARIO_PADRAO,
    dias: {
      [String((diaDaSemana + 2) % 7)]: [{ inicio: '08:00', fim: '18:00' }],
    },
  };
}
