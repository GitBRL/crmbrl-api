import type { CadeiaDeAutomacao } from '../contexto/contexto-requisicao';
import type { TipoExecucao } from '../../generated/prisma/client';
import type { Passo, ValidadorDeConfig } from './definicao';

/** Dados extras gravados no histórico do passo (`execucao_passos.resultado.saida`). */
export type SaidaDoPasso = Record<string, unknown>;

interface Comum {
  /** Vai para o histórico do passo. */
  saida?: SaidaDoPasso;
  /** Mescladas (raso) nas variáveis da execução (`{{variaveis.*}}`). */
  variaveis?: Record<string, unknown>;
}

/** O que o passo decidiu. Use os construtores abaixo (`seguir()`, `irParaRamo()`…). */
export type ResultadoDoPasso =
  | (Comum & { acao: 'seguir' })
  | (Comum & { acao: 'ramo'; ramoId: string })
  | (Comum & { acao: 'ir_para'; passoId: string })
  | (Comum & {
      acao: 'aguardar';
      /** Acorda neste momento (job do pg-boss com `startAfter`). */
      ate?: Date;
      /** Espera uma entrada (`retomarComEntrada`); com `ate`, também acorda por tempo. */
      entrada?: boolean;
    })
  | (Comum & {
      acao: 'encerrar';
      /** Padrão: CONCLUIDA. */
      status?: 'CONCLUIDA' | 'CANCELADA';
      motivo?: string;
    });

export const seguir = (extras: Comum = {}): ResultadoDoPasso => ({
  acao: 'seguir',
  ...extras,
});
export const irParaRamo = (
  ramoId: string,
  extras: Comum = {},
): ResultadoDoPasso => ({ acao: 'ramo', ramoId, ...extras });
export const irPara = (
  passoId: string,
  extras: Comum = {},
): ResultadoDoPasso => ({ acao: 'ir_para', passoId, ...extras });
export const aguardarAte = (
  ate: Date,
  extras: Comum = {},
): ResultadoDoPasso => ({ acao: 'aguardar', ate, ...extras });
export const aguardarEntrada = (
  opcoes: Comum & { ate?: Date } = {},
): ResultadoDoPasso => ({ acao: 'aguardar', entrada: true, ...opcoes });
export const encerrar = (
  motivo?: string,
  extras: Comum & { status?: 'CONCLUIDA' | 'CANCELADA' } = {},
): ResultadoDoPasso => ({ acao: 'encerrar', motivo, ...extras });

/** Por que um passo em espera voltou a rodar. */
export type Retomada =
  | {
      motivo: 'tempo';
      /** No modo teste a espera é pulada na hora. */
      simulada?: boolean;
    }
  | { motivo: 'entrada'; entrada: unknown };

/** A execução como o passo a vê (só leitura). */
export interface ExecucaoAtual {
  readonly id: string;
  readonly tipo: TipoExecucao;
  /** Nome da automação/fluxo (ator AUTOMACAO das auditorias). */
  readonly nome: string;
  readonly teste: boolean;
  readonly automacaoId: string | null;
  readonly fluxoId: string | null;
  readonly entidade: string | null;
  readonly entidadeId: string | null;
  readonly contatoId: string | null;
  readonly negocioId: string | null;
  readonly conversaId: string | null;
  readonly variaveis: Readonly<Record<string, unknown>>;
  /** Dados do gatilho (o que `iniciar` recebeu em `contexto`). */
  readonly contexto: Readonly<Record<string, unknown>>;
  readonly cadeia: CadeiaDeAutomacao;
}

export interface ContextoDoPasso<C = Record<string, unknown>> {
  readonly execucao: ExecucaoAtual;
  readonly passo: Passo<C>;
  /** `passo.config` (ou `{}`). */
  readonly config: C;
  /** Visita do passo nesta execução (1, 2… quando revisitado por desvio). */
  readonly visita: number;
  /** Tentativa deste passo nesta visita (1, 2… após erro temporário, queda ou nova espera). */
  readonly tentativa: number;
  /**
   * `<execucaoId>:<passoId>:<visita>` — use para deduplicar efeitos externos
   * (ex.: `chaveUnica` de job, id de mensagem): numa queda no meio do passo,
   * ele roda de novo com a mesma chave.
   */
  readonly chaveIdempotencia: string;
  /** Presente quando o passo volta de uma espera (`aguardar…`). */
  readonly retomada: Retomada | null;
  readonly agora: Date;
}

/**
 * Tipo de passo registrado por um módulo (`PassosService.registrarTipo`). O
 * `executar` roda como ator AUTOMACAO (descrição = nome da execução, com a
 * cadeia no contexto): chame os serviços de domínio normalmente.
 */
export interface DefinicaoDeTipoDePasso<C = Record<string, unknown>> {
  /** Ex.: `mensagem`, `acao.etiquetar`. */
  tipo: string;
  /** Em quais execuções vale (padrão: todas). */
  execucoes?: readonly TipoExecucao[];
  /** Confere `config` ao salvar a definição. */
  validar?: ValidadorDeConfig;
  executar(contexto: ContextoDoPasso<C>): Promise<ResultadoDoPasso>;
}

/**
 * Erro passageiro (rede, gateway fora do ar…): o executor tenta o passo de novo
 * mais tarde (espera crescente, até 5 vezes) antes de marcar a execução como FALHOU.
 */
export class ErroDePassoTemporario extends Error {
  constructor(
    mensagem: string,
    readonly esperaSegundos?: number,
  ) {
    super(mensagem);
    this.name = 'ErroDePassoTemporario';
  }
}
