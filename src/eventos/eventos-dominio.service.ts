import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import {
  contextoAtual,
  executarComoAtor,
} from '../comum/contexto/contexto-requisicao';
import { sanitizarParaJson } from '../comum/dados/sanitizar';
import { AMBIENTE, type Ambiente } from '../config/ambiente';
import { FilaService, type Trabalho } from '../fila/fila.service';
import type { Prisma, TipoAtor } from '../generated/prisma/client';
import { LogsTecnicosService } from '../logs/logs-tecnicos.service';
import { PrismaService, type Tx } from '../prisma/prisma.service';
import type { TipoEventoDominio } from './tipos-eventos';

/** Fila do pg-boss que recebe um job por evento de domínio. */
export const FILA_EVENTOS_DOMINIO = 'eventos-dominio';

/** Intervalo do despachante (outbox → fila) quando `PROCESSAR_FILAS=true`. */
const INTERVALO_DO_DESPACHANTE_MS = 1_000;
const LOTE_DO_DESPACHANTE = 100;

/** Evento como os manipuladores o recebem. */
export interface EventoPublicado<T = unknown> {
  /** Id do evento na outbox — use como `id` do envelope e para deduplicar (R9.6). */
  readonly id: string;
  readonly tipo: string;
  readonly dados: T;
  readonly ocorridoEm: Date;
  readonly tipoAtor: TipoAtor;
  readonly usuarioId: string | null;
  readonly requisicaoId: string | null;
  /** 1 na primeira entrega, 2 na primeira reentrega… */
  readonly tentativa: number;
}

export type ManipuladorDeEvento<T = unknown> = (
  evento: EventoPublicado<T>,
) => Promise<void>;

interface Inscricao {
  readonly tipo: string;
  readonly nome: string;
  readonly manipulador: ManipuladorDeEvento;
}

/**
 * Eventos de domínio com outbox (R10.1).
 *
 * 1. `publicar(tx, tipo, dados)` grava o evento **na transação da alteração**:
 *    se ela desfizer, o evento some junto.
 * 2. O despachante leva os eventos gravados para a fila do pg-boss
 *    (`eventos-dominio`), numa transação própria — nada se perde se a API cair
 *    no meio.
 * 3. O trabalhador da fila entrega cada evento aos manipuladores registrados,
 *    fora da transação original. Se um falhar, o pg-boss tenta de novo (espera
 *    exponencial) e só os manipuladores que ainda não concluíram rodam outra vez.
 *
 * A entrega é "pelo menos uma vez": manipuladores devem ser idempotentes (ex.:
 * índice único por evento). Nos testes, `processarPendentes()` faz tudo na hora.
 *
 * ```ts
 * await this.eventos.publicar(tx, 'negocio.ganho', { negocioId, funilId, valor: '1500.00' });
 *
 * // no onModuleInit de quem consome (nome estável: é ele que marca a conclusão)
 * this.eventos.registrarManipulador('*', (evento) => this.enfileirarEntregas(evento), 'webhooks-saida');
 * ```
 */
@Injectable()
export class EventosDominioService
  implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(EventosDominioService.name);
  private readonly inscricoes: Inscricao[] = [];
  private temporizador?: NodeJS.Timeout;
  private despachando?: Promise<number>;
  private parando = false;

  constructor(
    @Inject(AMBIENTE) private readonly ambiente: Ambiente,
    private readonly prisma: PrismaService,
    private readonly fila: FilaService,
    private readonly logs: LogsTecnicosService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.fila.trabalhar<{ eventoId: string }>(
      FILA_EVENTOS_DOMINIO,
      (trabalho) => this.entregar(trabalho),
      {
        tentativas: 10,
        intervaloEntreTentativasSegundos: 5,
        esperaExponencial: true,
        esperaMaximaSegundos: 3_600,
        prazoDeExecucaoSegundos: 300,
        intervaloDeConsultaSegundos: 1,
        concorrencia: 2,
      },
    );
  }

  onApplicationBootstrap(): void {
    if (this.ambiente.processarFilas) {
      this.agendarDespacho(INTERVALO_DO_DESPACHANTE_MS);
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.parando = true;
    clearTimeout(this.temporizador);
    await this.despachando?.catch(() => undefined);
  }

  /**
   * Grava o evento na outbox, dentro da transação `tx`. Ator e id da requisição
   * vêm do contexto. Os `dados` vão como JSON (datas em ISO, `Decimal` com duas
   * casas, sem campos sensíveis).
   */
  async publicar<T extends object>(
    tx: Tx,
    tipo: TipoEventoDominio,
    dados: T,
  ): Promise<EventoPublicado<T>> {
    const contexto = contextoAtual();
    const evento = await tx.eventoDominio.create({
      data: {
        tipo,
        dados: (sanitizarParaJson(dados) ?? {}) as Prisma.InputJsonValue,
        tipoAtor: contexto.tipoAtor,
        usuarioId: contexto.usuario?.id ?? null,
        requisicaoId: contexto.requisicaoId,
      },
    });
    if (this.ambiente.processarFilas) {
      // A transação ainda não confirmou; o despacho logo depois costuma
      // encontrar o evento, e o intervalo regular garante o resto.
      this.agendarDespacho(100);
    }
    return {
      id: evento.id,
      tipo: evento.tipo,
      dados: evento.dados as T,
      ocorridoEm: evento.criadoEm,
      tipoAtor: evento.tipoAtor,
      usuarioId: evento.usuarioId,
      requisicaoId: evento.requisicaoId,
      tentativa: 0,
    };
  }

  /**
   * Inscreve um manipulador num tipo de evento (ou em todos, com `'*'`).
   * O `nome` identifica o manipulador na reentrega: mantenha-o estável entre
   * versões (padrão: o nome da função).
   */
  registrarManipulador<T = unknown>(
    tipo: TipoEventoDominio | '*',
    manipulador: ManipuladorDeEvento<T>,
    nome?: string,
  ): void {
    const nomeFinal =
      nome ??
      (manipulador.name && manipulador.name !== 'anonymous'
        ? `${tipo}:${manipulador.name.replace(/^bound /, '')}`
        : `${tipo}:${this.inscricoes.length + 1}`);
    if (this.inscricoes.some((inscricao) => inscricao.nome === nomeFinal)) {
      throw new Error(
        `Já existe um manipulador de eventos chamado "${nomeFinal}".`,
      );
    }
    this.inscricoes.push({
      tipo,
      nome: nomeFinal,
      manipulador: manipulador as ManipuladorDeEvento,
    });
  }

  /**
   * Para testes: leva os eventos gravados para a fila e entrega todos agora,
   * até não sobrar nenhum (inclusive reentregas agendadas, com `incluirAgendados`).
   * Devolve quantas entregas rodaram.
   */
  async processarPendentes(
    opcoes: { incluirAgendados?: boolean } = {},
  ): Promise<number> {
    let total = 0;
    for (let rodada = 0; rodada < 25; rodada++) {
      const enfileirados = await this.despacharAgora();
      const entregues = await this.fila.drenar(FILA_EVENTOS_DOMINIO, {
        incluirAgendados: opcoes.incluirAgendados,
      });
      total += entregues;
      if (enfileirados === 0 && entregues === 0) {
        break;
      }
    }
    return total;
  }

  /** Despachante: cria na fila um job por evento ainda não enfileirado. Devolve quantos. */
  async despacharAgora(): Promise<number> {
    if (!this.fila.pronto) {
      return 0;
    }
    const execucao = (this.despachando ?? Promise.resolve(0))
      .catch(() => 0)
      .then(() => this.despacharLote());
    this.despachando = execucao;
    return execucao;
  }

  private async despacharLote(): Promise<number> {
    let total = 0;
    for (;;) {
      const quantidade = await this.prisma.$transaction(async (tx) => {
        const pendentes = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM eventos_dominio
           WHERE enfileirado_em IS NULL
           ORDER BY criado_em
           LIMIT ${LOTE_DO_DESPACHANTE}
           FOR UPDATE SKIP LOCKED`;
        if (pendentes.length === 0) {
          return 0;
        }
        // O job nasce na mesma transação que marca o evento como enfileirado.
        for (const { id } of pendentes) {
          await this.fila.enviar(
            FILA_EVENTOS_DOMINIO,
            { eventoId: id },
            { tx },
          );
        }
        await tx.eventoDominio.updateMany({
          where: { id: { in: pendentes.map(({ id }) => id) } },
          data: { enfileiradoEm: new Date() },
        });
        return pendentes.length;
      });
      total += quantidade;
      if (quantidade < LOTE_DO_DESPACHANTE) {
        return total;
      }
    }
  }

  private agendarDespacho(esperaMs: number): void {
    if (this.parando) {
      return;
    }
    clearTimeout(this.temporizador);
    this.temporizador = setTimeout(() => {
      this.despacharAgora()
        .catch((erro: unknown) =>
          this.logger.warn(
            `Despachante de eventos falhou: ${erro instanceof Error ? erro.message : String(erro)}`,
          ),
        )
        .finally(() => this.agendarDespacho(INTERVALO_DO_DESPACHANTE_MS));
    }, esperaMs);
    this.temporizador.unref();
  }

  /** Trabalhador da fila: entrega um evento aos manipuladores que ainda não concluíram. */
  private async entregar(
    trabalho: Trabalho<{ eventoId: string }>,
  ): Promise<void> {
    const registro = await this.prisma.eventoDominio.findUnique({
      where: { id: trabalho.dados.eventoId },
    });
    if (!registro || registro.processadoEm) {
      return;
    }
    const tentativa = registro.tentativas + 1;
    const evento: EventoPublicado = {
      id: registro.id,
      tipo: registro.tipo,
      dados: registro.dados,
      ocorridoEm: registro.criadoEm,
      tipoAtor: registro.tipoAtor,
      usuarioId: registro.usuarioId,
      requisicaoId: registro.requisicaoId,
      tentativa,
    };
    const concluidos = new Set(registro.manipuladoresConcluidos);
    const falhas: string[] = [];
    for (const inscricao of this.inscricoes) {
      if (inscricao.tipo !== '*' && inscricao.tipo !== registro.tipo) {
        continue;
      }
      if (concluidos.has(inscricao.nome)) {
        continue;
      }
      try {
        await executarComoAtor(
          { tipoAtor: 'SISTEMA', descricao: `Evento ${registro.tipo}` },
          () => inscricao.manipulador(evento),
          registro.requisicaoId ?? undefined,
        );
        concluidos.add(inscricao.nome);
      } catch (erro) {
        const mensagem = erro instanceof Error ? erro.message : String(erro);
        falhas.push(`${inscricao.nome}: ${mensagem}`);
        await this.logs.erro(
          'Eventos',
          `Manipulador "${inscricao.nome}" falhou no evento ${registro.tipo} (${registro.id}), tentativa ${tentativa}.`,
          erro,
          {
            eventoId: registro.id,
            tipo: registro.tipo,
            manipulador: inscricao.nome,
          },
        );
      }
    }
    await this.prisma.eventoDominio.update({
      where: { id: registro.id },
      data: {
        tentativas: tentativa,
        manipuladoresConcluidos: [...concluidos],
        erro: falhas.length > 0 ? falhas.join(' | ').slice(0, 2_000) : null,
        processadoEm: falhas.length === 0 ? new Date() : null,
      },
    });
    if (falhas.length > 0) {
      throw new Error(
        `Evento ${registro.id}: ${falhas.length} manipulador(es) falharam.`,
      );
    }
  }
}
