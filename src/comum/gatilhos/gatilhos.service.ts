import { Injectable } from '@nestjs/common';
import {
  type EventoPublicado,
  EventosDominioService,
} from '../../eventos/eventos-dominio.service';
import { FilaService } from '../../fila/fila.service';
import type { LimiteExecucao } from '../../generated/prisma/client';
import { LogsTecnicosService } from '../../logs/logs-tecnicos.service';
import { PrismaService, type Tx } from '../../prisma/prisma.service';
import type { CadeiaDeAutomacao } from '../contexto/contexto-requisicao';
import {
  type EntidadeDeGatilho,
  entidadeDoEvento,
  type IdsDoEvento,
  idsDoEvento,
  permiteEncadear,
} from './catalogo';

/** O evento como os destinos de gatilho recebem. */
export interface GatilhoDisparado<T = Record<string, unknown>> {
  readonly evento: EventoPublicado<T>;
  readonly tipo: string;
  /** Entidade principal do evento (`negocio` em `negocio.movido`…), com o id. */
  readonly entidade: { tipo: EntidadeDeGatilho; id: string } | null;
  readonly ids: IdsDoEvento;
  /** Cadeia de automações que publicou o evento (nula se não veio de uma). */
  readonly cadeia: CadeiaDeAutomacao | null;
}

/** Quem recebe eventos de domínio como gatilhos (automações, chatbot, disparos). */
export interface DestinoDeGatilho {
  /** Nome estável (vira o nome do manipulador da outbox: `gatilhos:<nome>`). */
  nome: string;
  /** Tipos de evento de interesse, ou `'*'`. */
  eventos: readonly string[] | '*';
  /**
   * Chamado uma vez por evento (entrega "pelo menos uma vez": use `chaveUnica`
   * ao iniciar execuções). Lançar faz a outbox tentar de novo mais tarde.
   */
  aoDisparar(gatilho: GatilhoDisparado): Promise<void>;
  /**
   * Receber também eventos de cadeias no limite de profundidade (padrão: não —
   * o evento é descartado com um aviso nos logs técnicos). O chatbot, que não
   * encadeia, pode ligar.
   */
  ignorarLimiteDeEncadeamento?: boolean;
}

/** Gatilho de agenda (cron do pg-boss, no fuso de São Paulo). */
export interface AgendaDeGatilho {
  /** Nome estável: a fila é `gatilhos.agenda.<nome>`. */
  nome: string;
  /** Expressão cron, ex.: `*\/5 * * * *`. */
  cron: string;
  /** A varredura (idempotente: use `chaveUnica` ao iniciar execuções). */
  executar(agora: Date): Promise<void>;
}

/** Entrada de `podeExecutarParaEntidade`. */
export interface LimiteDaAutomacao {
  automacaoId: string;
  entidadeId: string;
  limite: LimiteExecucao;
  /** Para `UMA_VEZ_POR_PERIODO`. */
  periodoDias?: number | null;
  agora?: Date;
}

/**
 * Gatilhos (Onda B, §2.1): entrega os eventos de domínio da outbox aos destinos
 * registrados (automações, chatbot, disparos) e roda as agendas (cron).
 *
 * ```ts
 * // onModuleInit do módulo de automações
 * this.gatilhos.registrarDestino({ nome: 'automacoes', eventos: '*',
 *   aoDisparar: (g) => this.aoEvento(g) });
 * await this.gatilhos.registrarAgenda({ nome: 'automacoes', cron: '*\/5 * * * *',
 *   executar: (agora) => this.varrerAgendas(agora) });
 * ```
 */
@Injectable()
export class GatilhosService {
  private readonly agendas = new Map<string, AgendaDeGatilho>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventos: EventosDominioService,
    private readonly fila: FilaService,
    private readonly logs: LogsTecnicosService,
  ) {}

  /** Registra um destino (no `onModuleInit` do módulo). */
  registrarDestino(destino: DestinoDeGatilho): void {
    const interessa =
      destino.eventos === '*'
        ? () => true
        : (tipo: string) =>
            (destino.eventos as readonly string[]).includes(tipo);
    this.eventos.registrarManipulador(
      '*',
      async (evento) => {
        if (!interessa(evento.tipo)) {
          return;
        }
        const gatilho = gatilhoDoEvento(
          evento as EventoPublicado<Record<string, unknown>>,
        );
        if (!destino.ignorarLimiteDeEncadeamento) {
          const permissao = permiteEncadear(gatilho.cadeia);
          if (!permissao.permitido) {
            await this.logs.aviso(
              'Gatilhos',
              `Evento ${evento.tipo} (${evento.id}) não entregue a "${destino.nome}": ${permissao.motivo}`,
              { eventoId: evento.id, cadeia: gatilho.cadeia },
            );
            return;
          }
        }
        await destino.aoDisparar(gatilho);
      },
      `gatilhos:${destino.nome}`,
    );
  }

  /** Registra uma agenda (no `onModuleInit`). Com `PROCESSAR_FILAS=false`, só roda por `executarAgenda`. */
  async registrarAgenda(agenda: AgendaDeGatilho): Promise<void> {
    if (this.agendas.has(agenda.nome)) {
      throw new Error(`Agenda de gatilho já registrada: ${agenda.nome}`);
    }
    this.agendas.set(agenda.nome, agenda);
    const fila = filaDaAgenda(agenda.nome);
    await this.fila.trabalhar(fila, () => agenda.executar(new Date()), {
      tentativas: 0,
      prazoDeExecucaoSegundos: 900,
    });
    await this.fila.agendar(fila, agenda.cron);
  }

  /** Para testes (e diagnóstico): roda a agenda agora, com o "agora" informado. */
  async executarAgenda(nome: string, agora = new Date()): Promise<void> {
    const agenda = this.agendas.get(nome);
    if (!agenda) {
      throw new Error(`Agenda de gatilho não registrada: ${nome}`);
    }
    await agenda.executar(agora);
  }

  /**
   * O limite de execução por entidade (R19) permite mais uma? Conta as
   * execuções (fora as de teste) da automação para a entidade. Para não haver
   * corrida, combine com a `chaveUnica` de `chaveDeLimite`.
   */
  async podeExecutarParaEntidade(
    limite: LimiteDaAutomacao,
    tx?: Tx,
  ): Promise<boolean> {
    if (limite.limite === 'SEMPRE') {
      return true;
    }
    const agora = limite.agora ?? new Date();
    const desde =
      limite.limite === 'UMA_VEZ_POR_PERIODO'
        ? new Date(agora.getTime() - (limite.periodoDias ?? 1) * 86_400_000)
        : undefined;
    const existente = await (tx ?? this.prisma).execucao.findFirst({
      where: {
        automacaoId: limite.automacaoId,
        entidadeId: limite.entidadeId,
        teste: false,
        ...(desde ? { criadoEm: { gte: desde } } : {}),
      },
      select: { id: true },
    });
    return existente === null;
  }
}

/**
 * `chaveUnica` para iniciar a execução respeitando o limite (R19) mesmo com
 * eventos simultâneos: UMA_VEZ → uma por entidade; UMA_VEZ_POR_PERIODO → uma
 * por janela de `periodoDias`; SEMPRE → uma por evento (reentrega não duplica).
 * Não use no modo teste: a execução de teste ocuparia a chave.
 */
export function chaveDeLimite(
  automacaoId: string,
  entidadeId: string,
  limite: LimiteExecucao,
  origem: {
    eventoId?: string;
    periodoDias?: number | null;
    agora?: Date;
    extra?: string;
  },
): string {
  switch (limite) {
    case 'UMA_VEZ':
      return `automacao:${automacaoId}:entidade:${entidadeId}`;
    case 'UMA_VEZ_POR_PERIODO': {
      const periodoMs = (origem.periodoDias ?? 1) * 86_400_000;
      const janela = Math.floor(
        (origem.agora ?? new Date()).getTime() / periodoMs,
      );
      return `automacao:${automacaoId}:entidade:${entidadeId}:janela:${janela}`;
    }
    case 'SEMPRE':
      return `automacao:${automacaoId}:entidade:${entidadeId}:${origem.eventoId ? `evento:${origem.eventoId}` : (origem.extra ?? String(Date.now()))}`;
  }
}

export function filaDaAgenda(nome: string): string {
  return `gatilhos.agenda.${nome}`;
}

export function gatilhoDoEvento(
  evento: EventoPublicado<Record<string, unknown>>,
): GatilhoDisparado {
  const ids = idsDoEvento(evento.dados);
  const tipoDaEntidade = entidadeDoEvento(evento.tipo);
  const idDaEntidade = tipoDaEntidade
    ? ids[`${tipoDaEntidade}Id` as keyof IdsDoEvento]
    : undefined;
  return {
    evento,
    tipo: evento.tipo,
    entidade:
      tipoDaEntidade && idDaEntidade
        ? { tipo: tipoDaEntidade, id: idDaEntidade }
        : null,
    ids,
    cadeia: evento.cadeia ?? null,
  };
}
