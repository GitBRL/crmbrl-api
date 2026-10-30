/**
 * Contexto da requisição (ou do job) corrente, via `AsyncLocalStorage`.
 *
 * O `ContextoMiddleware` abre um contexto por requisição HTTP; o `SessaoGuard`
 * acrescenta o usuário autenticado. Jobs da fila, o despachante de eventos e a
 * configuração inicial abrem o seu com `executarComoAtor`. A auditoria, os logs
 * técnicos e a outbox leem daqui quem fez o quê, de onde e em qual requisição.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { Papel, TipoAtor } from '../../generated/prisma/client';

export interface UsuarioDoContexto {
  readonly id: string;
  readonly papel: Papel;
  readonly nome: string;
}

/**
 * Encadeamento de automações (Onda B, R19): quem roda dentro de uma execução de
 * passos leva a cadeia no contexto; a outbox grava a cadeia com cada evento
 * publicado, e os gatilhos a usam para barrar laços (profundidade máxima e
 * repetição da mesma automação).
 */
export interface CadeiaDeAutomacao {
  /** Execução (`execucoes.id`) que está rodando. */
  readonly execucaoId: string;
  /** 1 = a execução foi disparada por algo de fora; 2 = por um evento de outra execução… */
  readonly profundidade: number;
  /** Automações/fluxos da cadeia, da origem até a atual (ids). */
  readonly automacoes: readonly string[];
}

export interface ContextoRequisicao {
  /** `X-Request-Id` da requisição (R3.7), ou um id gerado para o job. */
  readonly requisicaoId: string;
  readonly ip?: string;
  readonly userAgent?: string;
  /** Usuário autenticado; preenchido pelo `SessaoGuard`. */
  readonly usuario?: UsuarioDoContexto;
  /** Sessão autenticada (para "sair" e para revogar as outras ao trocar a senha). */
  readonly sessaoId?: string;
  readonly tipoAtor: TipoAtor;
  /** Nome legível do ator: o do usuário, o do webhook, o do job… */
  readonly atorDescricao?: string;
  /** Encadeamento de automações em curso (Onda B). */
  readonly cadeia?: CadeiaDeAutomacao;
}

/** O que muda ao trocar de ator (`executarComoAtor`). */
export interface Ator {
  readonly tipoAtor: TipoAtor;
  readonly descricao?: string;
  readonly usuario?: UsuarioDoContexto;
  /** Encadeamento de automações; sem ele, herda o do contexto atual. */
  readonly cadeia?: CadeiaDeAutomacao;
}

const armazenamento = new AsyncLocalStorage<ContextoRequisicao>();

/**
 * O contexto corrente. Fora de qualquer contexto (código solto, testes de
 * unidade), devolve um contexto de `SISTEMA` com um id novo a cada chamada —
 * jobs e scripts devem usar `executarComoAtor` para ter um id estável.
 */
export function contextoAtual(): ContextoRequisicao {
  return (
    armazenamento.getStore() ?? {
      requisicaoId: randomUUID(),
      tipoAtor: 'SISTEMA',
    }
  );
}

/** Há um contexto aberto (requisição, job…)? */
export function haContexto(): boolean {
  return armazenamento.getStore() !== undefined;
}

/** Roda `fn` dentro de um contexto novo. Usado pelo middleware HTTP. */
export function executarComContexto<T>(
  contexto: ContextoRequisicao,
  fn: () => T,
): T {
  return armazenamento.run(contexto, fn);
}

/**
 * Roda `fn` como outro ator — para jobs, webhooks, automações e a configuração
 * inicial. Mantém o id da requisição do contexto atual (para correlacionar o
 * job com a requisição que o originou) ou usa `requisicaoId`, se informado.
 *
 * ```ts
 * await executarComoAtor({ tipoAtor: 'WEBHOOK', descricao: webhook.nome }, () =>
 *   this.processar(recebimento),
 * );
 * ```
 */
export function executarComoAtor<T>(
  ator: Ator,
  fn: () => T,
  requisicaoId?: string,
): T {
  const atual = armazenamento.getStore();
  return armazenamento.run(
    {
      requisicaoId: requisicaoId ?? atual?.requisicaoId ?? randomUUID(),
      ip: atual?.ip,
      userAgent: atual?.userAgent,
      tipoAtor: ator.tipoAtor,
      usuario: ator.usuario,
      atorDescricao: ator.descricao ?? ator.usuario?.nome,
      cadeia: ator.cadeia ?? atual?.cadeia,
    },
    fn,
  );
}

type ContextoMutavel = {
  -readonly [Campo in keyof ContextoRequisicao]: ContextoRequisicao[Campo];
};

/**
 * Registra no contexto corrente o usuário autenticado (chamado pelo
 * `SessaoGuard`).
 *
 * Altera o próprio objeto do contexto em vez de trocá-lo (`enterWith`): o guard
 * é assíncrono, e um contexto novo criado depois de um `await` não voltaria
 * para o roteador do Nest, que segue no contexto aberto pelo middleware. Como
 * todos compartilham o mesmo objeto, o handler, os serviços e o log HTTP passam
 * a ver o usuário.
 */
export function definirUsuarioDoContexto(
  usuario: UsuarioDoContexto,
  sessaoId: string,
): void {
  const atual = armazenamento.getStore() as ContextoMutavel | undefined;
  if (!atual) {
    return;
  }
  atual.usuario = usuario;
  atual.sessaoId = sessaoId;
  atual.tipoAtor = 'USUARIO';
  atual.atorDescricao = usuario.nome;
}
