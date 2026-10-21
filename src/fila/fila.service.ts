import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import {
  fromPrisma,
  type Job,
  PgBoss,
  type Queue,
  type SendOptions,
} from 'pg-boss';
import {
  contextoAtual,
  executarComoAtor,
} from '../comum/contexto/contexto-requisicao';
import { ServicoIndisponivelException } from '../comum/erros/excecoes';
import { AMBIENTE, type Ambiente } from '../config/ambiente';
import { LogsTecnicosService } from '../logs/logs-tecnicos.service';
import type { Tx } from '../prisma/prisma.service';

/** Schema próprio do pg-boss, no mesmo banco da API. */
export const ESQUEMA_DA_FILA = 'pgboss';

/** Fuso dos agendamentos (`agendar`). */
export const FUSO_HORARIO_PADRAO = 'America/Sao_Paulo';

/** Quanto `enviar` espera a fila ficar pronta (banco fora do ar na subida). */
const PRAZO_PARA_FILA_PRONTA_MS = 15_000;

/** Um job recebido pelo manipulador. */
export interface Trabalho<T> {
  readonly id: string;
  readonly fila: string;
  readonly dados: T;
  /** 1 na primeira execução, 2 na primeira retentativa… */
  readonly tentativa: number;
}

export type ManipuladorDeTrabalho<T> = (trabalho: Trabalho<T>) => Promise<void>;

/** Configuração da fila (vale para todos os jobs dela). */
export interface OpcoesDaFila {
  /** Retentativas depois da primeira falha (padrão do pg-boss: 2). */
  tentativas?: number;
  /** Espera antes de tentar de novo, em segundos. */
  intervaloEntreTentativasSegundos?: number;
  /** Espera exponencial a partir do intervalo. */
  esperaExponencial?: boolean;
  /** Teto da espera exponencial, em segundos. */
  esperaMaximaSegundos?: number;
  /** Tempo máximo de uma execução, em segundos (padrão do pg-boss: 15 min). */
  prazoDeExecucaoSegundos?: number;
  /** Por quanto tempo um job concluído fica guardado, em segundos (padrão: 7 dias). */
  guardarConcluidosPorSegundos?: number;
}

/** Como o trabalhador busca jobs (só em produção, com `PROCESSAR_FILAS=true`). */
export interface OpcoesDoTrabalhador extends OpcoesDaFila {
  /** Jobs da fila processados em paralelo nesta réplica (padrão 1). */
  concorrencia?: number;
  /** Intervalo de consulta da fila, em segundos (padrão 2, mínimo 0,5). */
  intervaloDeConsultaSegundos?: number;
}

/** Opções de um job. */
export interface OpcoesDeEnvio {
  /**
   * Transação Prisma em curso: o job só existe se ela confirmar (o pg-boss usa
   * o mesmo banco). Use sempre que o job depender da alteração.
   */
  tx?: Tx;
  /** Executar a partir deste momento. */
  executarEm?: Date;
  /** Ou: executar daqui a tantos segundos. */
  atrasoSegundos?: number;
  /** Chave de unicidade (`singletonKey`): não cria outro job com a mesma chave pendente. */
  chaveUnica?: string;
  prioridade?: number;
  tentativas?: number;
  intervaloEntreTentativasSegundos?: number;
  esperaExponencial?: boolean;
}

/** Job como `listarTrabalhos` devolve (para testes e diagnóstico). */
export interface TrabalhoListado<T = unknown> {
  readonly id: string;
  readonly estado: string;
  readonly dados: T;
  readonly executarEm: Date;
  readonly tentativas: number;
}

/** Envelope dos dados de um job: leva o id da requisição que o criou. */
interface Envelope<T> {
  __dados: T;
  __requisicaoId?: string;
}

interface Registro {
  manipulador: ManipuladorDeTrabalho<unknown>;
  opcoes: OpcoesDoTrabalhador;
}

interface Agendamento {
  cron: string;
  dados: object;
  fusoHorario: string;
}

/**
 * Fila de jobs e agendamentos, sobre o pg-boss (schema `pgboss` no mesmo banco).
 *
 * - Sobe e para com o Nest. Se o banco estiver fora do ar na subida, a API sobe
 *   assim mesmo e a fila tenta de novo em segundo plano.
 * - Com `PROCESSAR_FILAS=false` (testes, réplicas só HTTP) os trabalhadores e os
 *   agendamentos não rodam: nos testes, `drenar()` executa os jobs na hora.
 * - O manipulador roda num contexto de ator `SISTEMA` com o id da requisição que
 *   criou o job; falhas vão para os logs técnicos (R3.6) e o pg-boss tenta de novo.
 *
 * ```ts
 * // no onModuleInit do módulo dono da fila
 * await this.fila.trabalhar<{ entregaId: string }>('webhooks-saida.entregar',
 *   (trabalho) => this.entregar(trabalho.dados.entregaId), { tentativas: 0 });
 * // dentro da transação que criou a entrega
 * await this.fila.enviar('webhooks-saida.entregar', { entregaId }, { tx });
 * // job recorrente
 * await this.fila.agendar('atividades.lembretes', '*\/15 * * * *');
 * ```
 */
@Injectable()
export class FilaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FilaService.name);
  private readonly registros = new Map<string, Registro>();
  private readonly agendamentos = new Map<string, Agendamento>();
  private readonly filasCriadas = new Set<string>();
  private readonly trabalhadoresAtivos = new Set<string>();
  private boss?: PgBoss;
  private readonly pronta: Promise<PgBoss>;
  private avisarPronta!: (boss: PgBoss) => void;
  private temporizadorDeRetentativa?: NodeJS.Timeout;
  private parando = false;

  constructor(
    @Inject(AMBIENTE) private readonly ambiente: Ambiente,
    private readonly logs: LogsTecnicosService,
  ) {
    this.pronta = new Promise((resolver) => {
      this.avisarPronta = resolver;
    });
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.iniciar();
    } catch (erro) {
      this.logger.warn(
        `Fila indisponível na subida (${mensagemDe(erro)}); tentando de novo em segundo plano.`,
      );
      this.tentarIniciarDepois(1);
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.parando = true;
    clearTimeout(this.temporizadorDeRetentativa);
    const boss = this.boss;
    this.boss = undefined;
    if (boss) {
      await boss.stop({
        graceful: this.ambiente.processarFilas,
        timeout: 10_000,
        close: true,
      });
    }
  }

  /** A fila já subiu? */
  get pronto(): boolean {
    return this.boss !== undefined;
  }

  /** Cria um job. Devolve o id, ou `null` se a `chaveUnica` impediu. */
  async enviar<T extends object>(
    fila: string,
    dados: T,
    opcoes: OpcoesDeEnvio = {},
  ): Promise<string | null> {
    const boss = await this.obterBoss();
    await this.criarFila(fila);
    const envelope: Envelope<T> = {
      __dados: dados,
      __requisicaoId: contextoAtual().requisicaoId,
    };
    const opcoesDeEnvio: SendOptions = semIndefinidos({
      db: opcoes.tx ? fromPrisma(opcoes.tx) : undefined,
      startAfter: opcoes.executarEm ?? opcoes.atrasoSegundos,
      singletonKey: opcoes.chaveUnica,
      priority: opcoes.prioridade,
      retryLimit: opcoes.tentativas,
      retryDelay: opcoes.intervaloEntreTentativasSegundos,
      retryBackoff: opcoes.esperaExponencial,
    });
    return boss.send(fila, envelope, opcoesDeEnvio);
  }

  /**
   * Registra o manipulador da fila (chame no `onModuleInit` do módulo dono).
   * Com `PROCESSAR_FILAS=true`, começa a consumir; senão, só `drenar()` executa.
   */
  async trabalhar<T>(
    fila: string,
    manipulador: ManipuladorDeTrabalho<T>,
    opcoes: OpcoesDoTrabalhador = {},
  ): Promise<void> {
    this.registros.set(fila, {
      manipulador: manipulador as ManipuladorDeTrabalho<unknown>,
      opcoes,
    });
    if (this.boss) {
      await this.ativarTrabalhador(this.boss, fila);
    }
  }

  /**
   * Job recorrente pela expressão cron (no fuso de São Paulo). A fila precisa de
   * um manipulador (`trabalhar`). Com `PROCESSAR_FILAS=false` não agenda nada.
   */
  async agendar(
    fila: string,
    cron: string,
    dados: object = {},
    opcoes: { fusoHorario?: string } = {},
  ): Promise<void> {
    this.agendamentos.set(fila, {
      cron,
      dados,
      fusoHorario: opcoes.fusoHorario ?? FUSO_HORARIO_PADRAO,
    });
    if (this.boss) {
      await this.ativarAgendamento(this.boss, fila);
    }
  }

  /**
   * Para testes: executa agora os jobs pendentes das filas (todas as que têm
   * manipulador, ou só as informadas), até não sobrar nenhum. Com
   * `incluirAgendados`, executa também os marcados para o futuro (inclusive
   * retentativas). Devolve quantos jobs rodaram.
   */
  async drenar(
    filas?: string | readonly string[],
    opcoes: { incluirAgendados?: boolean; maxRodadas?: number } = {},
  ): Promise<number> {
    const boss = await this.obterBoss();
    const nomes =
      filas === undefined
        ? [...this.registros.keys()]
        : typeof filas === 'string'
          ? [filas]
          : [...filas];
    let total = 0;
    for (let rodada = 0; rodada < (opcoes.maxRodadas ?? 25); rodada++) {
      let nestaRodada = 0;
      for (const fila of nomes) {
        const registro = this.registros.get(fila);
        if (!registro) {
          continue;
        }
        await this.criarFila(fila, registro.opcoes);
        const jobs = await boss.fetch<Envelope<unknown>>(fila, {
          batchSize: 50,
          ignoreStartAfter: opcoes.incluirAgendados ?? false,
        });
        for (const job of jobs) {
          nestaRodada++;
          try {
            await this.executar(fila, job, registro.manipulador);
            await boss.complete(fila, job);
          } catch (erro) {
            await boss.fail(fila, job, { mensagem: mensagemDe(erro) });
          }
        }
      }
      total += nestaRodada;
      if (nestaRodada === 0) {
        break;
      }
    }
    return total;
  }

  /** Jobs de uma fila (pendentes por padrão), para testes e diagnóstico. */
  async listarTrabalhos<T = unknown>(
    fila: string,
    opcoes: { apenasPendentes?: boolean } = {},
  ): Promise<TrabalhoListado<T>[]> {
    const boss = await this.obterBoss();
    await this.criarFila(fila);
    const jobs = await boss.findJobs<Envelope<T>>(fila, {
      queued: opcoes.apenasPendentes ?? true,
    });
    return jobs.map((job) => ({
      id: job.id,
      estado: job.state,
      dados: abrirEnvelope<T>(job.data).dados,
      executarEm: job.startAfter,
      tentativas: job.retryCount,
    }));
  }

  /** Para testes: apaga todos os jobs de todas as filas. */
  async limparTrabalhos(): Promise<void> {
    const boss = await this.obterBoss();
    await boss.deleteAllJobs();
  }

  /** Cria a fila (idempotente) e mantém as opções em dia. */
  async criarFila(fila: string, opcoes?: OpcoesDaFila): Promise<void> {
    if (this.filasCriadas.has(fila) && !opcoes) {
      return;
    }
    const boss = await this.obterBoss();
    const configuracao = opcoesDaFila(
      opcoes ?? this.registros.get(fila)?.opcoes,
    );
    if (!this.filasCriadas.has(fila)) {
      await boss.createQueue(fila, configuracao);
      this.filasCriadas.add(fila);
    }
    if (Object.keys(configuracao).length > 0) {
      await boss.updateQueue(fila, configuracao);
    }
  }

  private async iniciar(): Promise<void> {
    const processar = this.ambiente.processarFilas;
    const boss = new PgBoss({
      connectionString: this.ambiente.databaseUrl,
      schema: ESQUEMA_DA_FILA,
      application_name: 'crmbrl-api-fila',
      max: 4,
      connectionTimeoutMillis: 5_000,
      migrate: true,
      supervise: processar,
      schedule: processar,
    });
    boss.on('error', (erro: Error) =>
      this.logger.error(`Erro na fila: ${erro.message}`, erro.stack),
    );
    boss.on('warning', (aviso: { message: string }) =>
      this.logger.warn(`Aviso da fila: ${aviso.message}`),
    );
    try {
      await boss.start();
    } catch (erro) {
      await boss.stop({ graceful: false, close: true }).catch(() => undefined);
      throw erro;
    }
    if (this.parando) {
      await boss.stop({ graceful: false, close: true });
      return;
    }
    this.boss = boss;
    for (const fila of this.registros.keys()) {
      await this.ativarTrabalhador(boss, fila);
    }
    for (const fila of this.agendamentos.keys()) {
      await this.ativarAgendamento(boss, fila);
    }
    this.avisarPronta(boss);
    this.logger.log(
      processar
        ? 'Fila pronta (pg-boss), com trabalhadores e agendamentos.'
        : 'Fila pronta (pg-boss), sem trabalhadores (PROCESSAR_FILAS=false).',
    );
  }

  private tentarIniciarDepois(tentativa: number): void {
    if (this.parando) {
      return;
    }
    const esperaMs = Math.min(30_000, 1_000 * 2 ** tentativa);
    this.temporizadorDeRetentativa = setTimeout(() => {
      this.iniciar().catch((erro: unknown) => {
        this.logger.warn(`Fila ainda indisponível: ${mensagemDe(erro)}`);
        this.tentarIniciarDepois(tentativa + 1);
      });
    }, esperaMs);
    this.temporizadorDeRetentativa.unref();
  }

  private async obterBoss(): Promise<PgBoss> {
    if (this.boss) {
      return this.boss;
    }
    let temporizador: NodeJS.Timeout | undefined;
    const prazo = new Promise<never>((_resolver, rejeitar) => {
      temporizador = setTimeout(
        () =>
          rejeitar(
            new ServicoIndisponivelException(
              'A fila de processamento está indisponível. Tente de novo em instantes.',
            ),
          ),
        PRAZO_PARA_FILA_PRONTA_MS,
      );
    });
    try {
      return await Promise.race([this.pronta, prazo]);
    } finally {
      clearTimeout(temporizador);
    }
  }

  private async ativarTrabalhador(boss: PgBoss, fila: string): Promise<void> {
    const registro = this.registros.get(fila);
    if (!registro) {
      return;
    }
    await this.criarFila(fila, registro.opcoes);
    if (!this.ambiente.processarFilas || this.trabalhadoresAtivos.has(fila)) {
      return;
    }
    this.trabalhadoresAtivos.add(fila);
    await boss.work<Envelope<unknown>>(
      fila,
      {
        batchSize: 1,
        localConcurrency: registro.opcoes.concorrencia ?? 1,
        pollingIntervalSeconds:
          registro.opcoes.intervaloDeConsultaSegundos ?? 2,
      },
      async (jobs) => {
        for (const job of jobs) {
          await this.executar(fila, job, registro.manipulador);
        }
      },
    );
  }

  private async ativarAgendamento(boss: PgBoss, fila: string): Promise<void> {
    const agendamento = this.agendamentos.get(fila);
    if (!agendamento) {
      return;
    }
    await this.criarFila(fila);
    if (!this.ambiente.processarFilas) {
      return;
    }
    const envelope: Envelope<object> = { __dados: agendamento.dados };
    await boss.schedule(fila, agendamento.cron, envelope, {
      tz: agendamento.fusoHorario,
    });
  }

  private async executar(
    fila: string,
    job: Job<Envelope<unknown>>,
    manipulador: ManipuladorDeTrabalho<unknown>,
  ): Promise<void> {
    const { dados, requisicaoId } = abrirEnvelope(job.data);
    await executarComoAtor(
      { tipoAtor: 'SISTEMA', descricao: `Fila ${fila}` },
      async () => {
        try {
          await manipulador({
            id: job.id,
            fila,
            dados,
            tentativa: job.retryCount + 1,
          });
        } catch (erro) {
          await this.logs.erro(
            `Fila:${fila}`,
            `Falha no job ${job.id}: ${mensagemDe(erro)}`,
            erro,
            {
              jobId: job.id,
              tentativa: job.retryCount + 1,
            },
          );
          throw erro;
        }
      },
      requisicaoId,
    );
  }
}

function abrirEnvelope<T>(dados: unknown): { dados: T; requisicaoId?: string } {
  if (typeof dados === 'object' && dados !== null && '__dados' in dados) {
    const envelope = dados as Envelope<T>;
    return { dados: envelope.__dados, requisicaoId: envelope.__requisicaoId };
  }
  return { dados: dados as T };
}

function opcoesDaFila(opcoes: OpcoesDaFila | undefined): Omit<Queue, 'name'> {
  if (!opcoes) {
    return {};
  }
  return semIndefinidos({
    retryLimit: opcoes.tentativas,
    retryDelay: opcoes.intervaloEntreTentativasSegundos,
    retryBackoff: opcoes.esperaExponencial,
    retryDelayMax: opcoes.esperaMaximaSegundos,
    expireInSeconds: opcoes.prazoDeExecucaoSegundos,
    deleteAfterSeconds: opcoes.guardarConcluidosPorSegundos,
  });
}

function semIndefinidos<T extends object>(objeto: T): T {
  return Object.fromEntries(
    Object.entries(objeto).filter(([, valor]) => valor !== undefined),
  ) as T;
}

function mensagemDe(erro: unknown): string {
  return erro instanceof Error ? erro.message : String(erro);
}
