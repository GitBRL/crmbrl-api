import { randomUUID } from 'node:crypto';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleInit,
} from '@nestjs/common';
import { AMBIENTE, type Ambiente } from '../../config/ambiente';
import { FilaService, type Trabalho } from '../../fila/fila.service';
import type {
  Execucao,
  Prisma,
  StatusExecucao,
  TipoExecucao,
} from '../../generated/prisma/client';
import { LogsTecnicosService } from '../../logs/logs-tecnicos.service';
import { PrismaService, type Tx } from '../../prisma/prisma.service';
import {
  type CadeiaDeAutomacao,
  executarComoAtor,
} from '../contexto/contexto-requisicao';
import {
  type DefinicaoDePassos,
  IndiceDePassos,
  type ValidadorDeConfig,
  validarDefinicao,
} from './definicao';
import { PASSOS_PADRAO } from './passos-padrao';
import {
  type DefinicaoDeTipoDePasso,
  ErroDePassoTemporario,
  type ExecucaoAtual,
  type ResultadoDoPasso,
  type Retomada,
} from './tipos';

/** Fila dos avanços (início, despertar de esperas, retomadas). */
export const FILA_AVANCAR_PASSOS = 'passos.avancar';
/** Varredura de execuções paradas (queda no meio, job perdido). */
export const FILA_RETOMAR_PASSOS = 'passos.retomar';
const AGENDA_DA_RETOMADA = '*/5 * * * *';

/** Passos seguidos sem espera numa rodada; depois disso, continua num job novo. */
const PASSOS_POR_RODADA = 50;
/** Passos por execução: acima disso é laço (FALHOU). */
export const LIMITE_DE_PASSOS_POR_EXECUCAO = 1_000;
/** Erros temporários seguidos no mesmo passo antes de falhar. */
const TENTATIVAS_TEMPORARIAS = 5;
/** Prazo da trava de execução (sobrevive a quedas). */
const PRAZO_DA_TRAVA_SEGUNDOS = 300;
/** Uma execução parada há mais que isso é retomada pela varredura. */
const PARADA_HA_SEGUNDOS = 120;

const ATIVAS: StatusExecucao[] = ['EM_ANDAMENTO', 'AGUARDANDO'];

/** O que `iniciar` recebe. */
export interface NovaExecucao {
  tipo: TipoExecucao;
  /** Nome da automação/fluxo: ator AUTOMACAO das auditorias. */
  nome: string;
  definicao: DefinicaoDePassos;
  automacaoId?: string | null;
  automacaoVersao?: number | null;
  fluxoId?: string | null;
  fluxoVersaoId?: string | null;
  /** `contato`, `negocio`, `atividade` ou `conversa`. */
  entidade?: string | null;
  entidadeId?: string | null;
  contatoId?: string | null;
  negocioId?: string | null;
  conversaId?: string | null;
  /** Evento da outbox que disparou. */
  eventoId?: string | null;
  /** Idempotência do início: com a mesma chave, devolve a execução existente. */
  chaveUnica?: string | null;
  /** Cadeia do evento que disparou (`evento.cadeia`), para a proteção contra laços. */
  cadeiaDeOrigem?: CadeiaDeAutomacao | null;
  variaveis?: Record<string, unknown>;
  contexto?: Record<string, unknown>;
  /** Modo teste/simulador: esperas de tempo puladas; os passos não devem ter efeitos externos. */
  teste?: boolean;
}

export interface OpcoesDeInicio {
  /** Cria na transação do chamador (o primeiro avanço vai para a fila, depois do commit). */
  tx?: Tx;
  /** Sem `tx`: roda os primeiros passos já, antes de devolver (chatbot, simulador). */
  executarAgora?: boolean;
}

export interface ResultadoDoAvanco {
  /** `ocupada` = outro avanço está rodando; `inexistente` = execução não encontrada. */
  estado: 'avancou' | 'ocupada' | 'inexistente';
  status: StatusExecucao | null;
}

/** Filtro de `cancelarAtivas`. */
export interface FiltroDeExecucoes {
  tipo?: TipoExecucao;
  automacaoId?: string;
  fluxoId?: string;
  contatoId?: string;
  negocioId?: string;
  conversaId?: string;
  entidadeId?: string;
}

interface DadosDoJob {
  execucaoId: string;
  retomada?: Retomada;
  /** Token da espera (despertar por tempo). */
  token?: string;
}

/**
 * Executor de passos (Onda B, §2.1), usado pelo chatbot e pelas automações.
 *
 * - Estado persistido em `execucoes` (passo atual, visitas, variáveis, espera) e
 *   histórico em `execucao_passos` (um registro por passo e visita, único por
 *   `chave` → um passo concluído nunca roda de novo).
 * - Esperas: `aguardarAte(data)` cria um job `passos.avancar` com `startAfter`;
 *   `aguardarEntrada()` espera `retomarComEntrada`. Um token por espera torna
 *   jobs atrasados/duplicados inofensivos.
 * - Retomada após reinício: os jobs do pg-boss sobrevivem; a varredura
 *   `passos.retomar` (a cada 5 min) re-enfileira execuções paradas.
 * - Uma execução avança por vez (trava com prazo em `travada_ate`).
 * - Os passos rodam como ator AUTOMACAO (descrição = `nome`), com a cadeia no
 *   contexto: eventos publicados por eles carregam a cadeia (proteção contra laços).
 *
 * ```ts
 * // no onModuleInit do módulo
 * this.passos.registrarTipo({ tipo: 'acao.etiquetar', execucoes: ['AUTOMACAO'],
 *   validar: (c) => (Array.isArray(c.etiquetas) ? null : 'Informe as etiquetas.'),
 *   executar: async ({ execucao, config }) => { await this.contatos.etiquetar(…); return seguir(); } });
 * // ao disparar
 * const { execucao, criada } = await this.passos.iniciar({ tipo: 'AUTOMACAO', nome: automacao.nome,
 *   definicao, automacaoId: automacao.id, contatoId, entidade: 'contato', entidadeId: contatoId,
 *   chaveUnica: `automacao:${automacao.id}:evento:${evento.id}`, cadeiaDeOrigem: evento.cadeia });
 * ```
 */
@Injectable()
export class PassosService implements OnModuleInit, OnApplicationBootstrap {
  private readonly logger = new Logger(PassosService.name);
  private readonly tipos = new Map<string, DefinicaoDeTipoDePasso<never>>();

  constructor(
    @Inject(AMBIENTE) private readonly ambiente: Ambiente,
    private readonly prisma: PrismaService,
    private readonly fila: FilaService,
    private readonly logs: LogsTecnicosService,
  ) {
    for (const tipo of PASSOS_PADRAO) {
      this.registrarTipo(tipo);
    }
  }

  async onModuleInit(): Promise<void> {
    await this.fila.trabalhar<DadosDoJob>(
      FILA_AVANCAR_PASSOS,
      (trabalho) => this.aoReceberJob(trabalho),
      {
        tentativas: 20,
        intervaloEntreTentativasSegundos: 2,
        esperaExponencial: true,
        esperaMaximaSegundos: 300,
        prazoDeExecucaoSegundos: PRAZO_DA_TRAVA_SEGUNDOS,
        intervaloDeConsultaSegundos: 1,
        concorrencia: 4,
      },
    );
    await this.fila.trabalhar(FILA_RETOMAR_PASSOS, () =>
      this.retomarParadas().then(() => undefined),
    );
    await this.fila.agendar(FILA_RETOMAR_PASSOS, AGENDA_DA_RETOMADA);
  }

  onApplicationBootstrap(): void {
    if (this.ambiente.processarFilas) {
      // Depois de um reinício, retoma o que ficou parado sem esperar o cron.
      void this.retomarParadas().catch((erro: unknown) =>
        this.logger.warn(`Retomada inicial falhou: ${String(erro)}`),
      );
    }
  }

  // -------------------------------------------------------------------------
  // Tipos de passo
  // -------------------------------------------------------------------------

  /**
   * Registra um tipo de passo (no construtor ou `onModuleInit` do módulo).
   * Vale para os tipos de execução em `execucoes` (padrão: todos); um tipo
   * específico tem prioridade sobre um geral de mesmo nome.
   */
  registrarTipo<C>(definicao: DefinicaoDeTipoDePasso<C>): void {
    for (const execucao of definicao.execucoes ?? ['*']) {
      const chave = `${execucao}:${definicao.tipo}`;
      if (this.tipos.has(chave)) {
        throw new Error(`Tipo de passo já registrado: ${chave}`);
      }
      this.tipos.set(chave, definicao as DefinicaoDeTipoDePasso<never>);
    }
  }

  /** Tipos de passo disponíveis para um tipo de execução. */
  tiposDisponiveis(execucao: TipoExecucao): string[] {
    const nomes = new Set<string>();
    for (const chave of this.tipos.keys()) {
      const [alvo, tipo] = chave.split(/:(.*)/s);
      if (alvo === '*' || alvo === execucao) {
        nomes.add(tipo);
      }
    }
    return [...nomes].sort();
  }

  /** Valida a definição com os tipos registrados (400 com `detalhes.problemas`). */
  validarDefinicao(
    execucao: TipoExecucao,
    entrada: unknown,
  ): DefinicaoDePassos {
    const tipos = new Map<string, ValidadorDeConfig | undefined>();
    for (const nome of this.tiposDisponiveis(execucao)) {
      tipos.set(nome, this.tipoDePasso(execucao, nome)?.validar);
    }
    return validarDefinicao(entrada, { tipos });
  }

  private tipoDePasso(
    execucao: TipoExecucao,
    tipo: string,
  ): DefinicaoDeTipoDePasso<never> | undefined {
    return this.tipos.get(`${execucao}:${tipo}`) ?? this.tipos.get(`*:${tipo}`);
  }

  // -------------------------------------------------------------------------
  // Ciclo de vida
  // -------------------------------------------------------------------------

  /**
   * Cria a execução e agenda o primeiro avanço. Com `chaveUnica` repetida,
   * devolve a existente (`criada = false`). A definição é copiada: editar a
   * automação/fluxo depois não muda esta execução.
   */
  async iniciar(
    nova: NovaExecucao,
    opcoes: OpcoesDeInicio = {},
  ): Promise<{ execucao: Execucao; criada: boolean }> {
    const id = randomUUID();
    const indice = new IndiceDePassos(nova.definicao);
    const primeiro = indice.primeiro;
    const origem = nova.cadeiaDeOrigem ?? null;
    const cadeia: CadeiaDeAutomacao = {
      execucaoId: id,
      profundidade: (origem?.profundidade ?? 0) + 1,
      automacoes: [
        ...(origem?.automacoes ?? []),
        nova.automacaoId ?? nova.fluxoId ?? id,
      ],
    };
    const criar = async (tx: Tx) => {
      const { count } = await tx.execucao.createMany({
        data: [
          {
            id,
            tipo: nova.tipo,
            nome: nova.nome,
            automacaoId: nova.automacaoId ?? null,
            automacaoVersao: nova.automacaoVersao ?? null,
            fluxoId: nova.fluxoId ?? null,
            fluxoVersaoId: nova.fluxoVersaoId ?? null,
            definicao: json(nova.definicao),
            status: primeiro ? 'EM_ANDAMENTO' : 'CONCLUIDA',
            passoAtualId: primeiro,
            visitaAtual: 1,
            visitas: primeiro ? { [primeiro]: 1 } : {},
            variaveis: json(nova.variaveis ?? {}),
            contexto: json(nova.contexto ?? {}),
            entidade: nova.entidade ?? null,
            entidadeId: nova.entidadeId ?? null,
            contatoId: nova.contatoId ?? null,
            negocioId: nova.negocioId ?? null,
            conversaId: nova.conversaId ?? null,
            eventoId: nova.eventoId ?? null,
            chaveUnica: nova.chaveUnica ?? null,
            cadeia: json(cadeia),
            teste: nova.teste ?? false,
            motivoFim: primeiro ? null : 'sem_passos',
            concluidaEm: primeiro ? null : new Date(),
          },
        ],
        skipDuplicates: true,
      });
      if (count === 0) {
        const existente = await tx.execucao.findUnique({
          where: { chaveUnica: nova.chaveUnica ?? '' },
        });
        if (!existente) {
          throw new Error(
            'Execução não criada e não encontrada pela chave única.',
          );
        }
        return { execucao: existente, criada: false };
      }
      if (primeiro && (opcoes.tx || !opcoes.executarAgora)) {
        await this.fila.enviar(FILA_AVANCAR_PASSOS, { execucaoId: id }, { tx });
      }
      const execucao = await tx.execucao.findUniqueOrThrow({ where: { id } });
      return { execucao, criada: true };
    };
    const resultado = opcoes.tx
      ? await criar(opcoes.tx)
      : await this.prisma.$transaction(criar);
    if (resultado.criada && primeiro && !opcoes.tx && opcoes.executarAgora) {
      await this.avancar(id);
      return {
        execucao: await this.prisma.execucao.findUniqueOrThrow({
          where: { id },
        }),
        criada: true,
      };
    }
    return resultado;
  }

  /**
   * Entrega uma entrada a uma execução que espera (`aguardarEntrada`): o passo
   * em espera roda de novo com `retomada = { motivo: 'entrada', entrada }`.
   * Sem `tx`, roda já (se outra rodada estiver em curso, vai para a fila).
   * Devolve falso se a execução não estava esperando entrada.
   */
  async retomarComEntrada(
    execucaoId: string,
    entrada: unknown,
    opcoes: { tx?: Tx } = {},
  ): Promise<boolean> {
    const banco = opcoes.tx ?? this.prisma;
    const execucao = await banco.execucao.findUnique({
      where: { id: execucaoId },
      select: { status: true, aguardandoEntrada: true },
    });
    if (execucao?.status !== 'AGUARDANDO' || !execucao.aguardandoEntrada) {
      return false;
    }
    const retomada: Retomada = {
      motivo: 'entrada',
      entrada: copiaJson(entrada),
    };
    if (opcoes.tx) {
      await this.fila.enviar(
        FILA_AVANCAR_PASSOS,
        { execucaoId, retomada },
        { tx: opcoes.tx },
      );
      return true;
    }
    const resultado = await this.avancar(execucaoId, retomada);
    if (resultado.estado === 'ocupada') {
      await this.fila.enviar(
        FILA_AVANCAR_PASSOS,
        { execucaoId, retomada },
        { atrasoSegundos: 1 },
      );
    }
    return true;
  }

  /** Cancela uma execução ativa. Devolve se cancelou. */
  async cancelar(
    execucaoId: string,
    motivo: string,
    opcoes: { tx?: Tx } = {},
  ): Promise<boolean> {
    const { count } = await (opcoes.tx ?? this.prisma).execucao.updateMany({
      where: { id: execucaoId, status: { in: ATIVAS } },
      data: dadosDoFim('CANCELADA', motivo),
    });
    return count > 0;
  }

  /**
   * Cancela as execuções ativas que batem com o filtro (atendente assumiu a
   * conversa, critério de parada…). Devolve quantas.
   */
  async cancelarAtivas(
    filtro: FiltroDeExecucoes,
    motivo: string,
    opcoes: { tx?: Tx } = {},
  ): Promise<number> {
    if (Object.values(filtro).every((valor) => valor === undefined)) {
      throw new Error('cancelarAtivas exige ao menos um filtro.');
    }
    const { count } = await (opcoes.tx ?? this.prisma).execucao.updateMany({
      where: { ...filtro, status: { in: ATIVAS } },
      data: dadosDoFim('CANCELADA', motivo),
    });
    return count;
  }

  /**
   * "Reexecutar passo com erro": volta a execução FALHOU para EM_ANDAMENTO no
   * mesmo passo (o registro com ERRO roda de novo, com tentativa + 1).
   */
  async reexecutarPasso(
    execucaoId: string,
    opcoes: { executarAgora?: boolean } = {},
  ): Promise<boolean> {
    const reaberta = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.execucao.updateMany({
        where: {
          id: execucaoId,
          status: 'FALHOU',
          passoAtualId: { not: null },
        },
        data: {
          status: 'EM_ANDAMENTO',
          erro: null,
          motivoFim: null,
          concluidaEm: null,
        },
      });
      if (count > 0 && !opcoes.executarAgora) {
        await this.fila.enviar(FILA_AVANCAR_PASSOS, { execucaoId }, { tx });
      }
      return count > 0;
    });
    if (reaberta && opcoes.executarAgora) {
      await this.avancar(execucaoId);
    }
    return reaberta;
  }

  /**
   * Re-enfileira execuções paradas: EM_ANDAMENTO sem trava há mais de 2 min
   * (queda no meio) e AGUARDANDO com o prazo vencido há mais de 2 min (job
   * perdido). Devolve quantas.
   */
  async retomarParadas(agora = new Date()): Promise<number> {
    const limite = new Date(agora.getTime() - PARADA_HA_SEGUNDOS * 1_000);
    const paradas = await this.prisma.execucao.findMany({
      where: {
        OR: [
          {
            status: 'EM_ANDAMENTO',
            atualizadoEm: { lt: limite },
            OR: [{ travadaAte: null }, { travadaAte: { lt: agora } }],
          },
          { status: 'AGUARDANDO', aguardandoAte: { lt: limite } },
        ],
      },
      select: { id: true, status: true, esperaToken: true },
      take: 500,
    });
    for (const parada of paradas) {
      const dados: DadosDoJob =
        parada.status === 'AGUARDANDO'
          ? {
              execucaoId: parada.id,
              retomada: { motivo: 'tempo' },
              token: parada.esperaToken ?? undefined,
            }
          : { execucaoId: parada.id };
      await this.fila.enviar(FILA_AVANCAR_PASSOS, dados, {
        chaveUnica: `retomar:${parada.id}`,
      });
    }
    return paradas.length;
  }

  // -------------------------------------------------------------------------
  // Avanço
  // -------------------------------------------------------------------------

  private async aoReceberJob(trabalho: Trabalho<DadosDoJob>): Promise<void> {
    const { execucaoId, retomada, token } = trabalho.dados;
    const resultado = await this.avancar(execucaoId, retomada, token);
    if (resultado.estado === 'ocupada') {
      // A outra rodada está no meio: o pg-boss tenta de novo em instantes.
      throw new Error(`Execução ${execucaoId} ocupada; tentando de novo.`);
    }
  }

  /**
   * Roda a execução a partir do passo atual até uma espera, o fim ou o limite
   * da rodada. Normalmente chamado pela fila; público para o chatbot e testes.
   */
  async avancar(
    execucaoId: string,
    retomadaInicial?: Retomada,
    tokenInicial?: string,
  ): Promise<ResultadoDoAvanco> {
    const trava = randomUUID();
    const travadas = await this.prisma.$executeRaw`
      UPDATE execucoes
         SET travada_ate = now() + make_interval(secs => ${PRAZO_DA_TRAVA_SEGUNDOS}),
             trava = ${trava}
       WHERE id = ${execucaoId}::uuid
         AND status IN ('EM_ANDAMENTO', 'AGUARDANDO')
         AND (travada_ate IS NULL OR travada_ate < now())`;
    if (travadas === 0) {
      const atual = await this.prisma.execucao.findUnique({
        where: { id: execucaoId },
        select: { status: true },
      });
      if (!atual) {
        return { estado: 'inexistente', status: null };
      }
      return {
        estado: ATIVAS.includes(atual.status) ? 'ocupada' : 'avancou',
        status: atual.status,
      };
    }
    let retomada: Retomada | null = retomadaInicial ?? null;
    let token: string | undefined = tokenInicial;
    let continuarDepois = false;
    try {
      for (let rodada = 0; ; rodada++) {
        if (rodada >= PASSOS_POR_RODADA) {
          continuarDepois = true;
          break;
        }
        const proxima = await this.executarUmPasso(execucaoId, retomada, token);
        if (proxima === null) {
          break;
        }
        retomada = proxima.retomada;
        token = proxima.token;
      }
    } finally {
      await this.prisma.execucao.updateMany({
        where: { id: execucaoId, trava },
        data: { travadaAte: null, trava: null },
      });
    }
    if (continuarDepois) {
      await this.fila.enviar(FILA_AVANCAR_PASSOS, { execucaoId });
    }
    const final = await this.prisma.execucao.findUnique({
      where: { id: execucaoId },
      select: { status: true },
    });
    return { estado: 'avancou', status: final?.status ?? null };
  }

  /**
   * Um passo. Devolve nulo para parar a rodada, ou a retomada do próximo
   * (espera simulada no modo teste).
   */
  private async executarUmPasso(
    execucaoId: string,
    retomada: Retomada | null,
    token: string | undefined,
  ): Promise<{ retomada: Retomada | null; token?: string } | null> {
    const execucao = await this.prisma.execucao.findUnique({
      where: { id: execucaoId },
    });
    if (!execucao || !ATIVAS.includes(execucao.status)) {
      return null;
    }
    if (execucao.status === 'AGUARDANDO') {
      const valida =
        retomada?.motivo === 'entrada'
          ? execucao.aguardandoEntrada
          : retomada?.motivo === 'tempo' &&
            execucao.aguardandoAte !== null &&
            (token === undefined || token === execucao.esperaToken);
      if (!valida) {
        return null;
      }
    } else {
      retomada = null;
    }
    const passoId = execucao.passoAtualId;
    if (!passoId) {
      await this.finalizar(execucao.id, 'CONCLUIDA', 'concluida');
      return null;
    }
    const definicao = execucao.definicao as unknown as DefinicaoDePassos;
    const indice = new IndiceDePassos(definicao);
    const passo = indice.obter(passoId);
    if (!passo) {
      await this.falhar(
        execucao.id,
        `O passo "${passoId}" não existe na definição.`,
      );
      return null;
    }
    if (execucao.passosExecutados >= LIMITE_DE_PASSOS_POR_EXECUCAO) {
      await this.falhar(
        execucao.id,
        `Limite de ${LIMITE_DE_PASSOS_POR_EXECUCAO} passos atingido (possível laço).`,
      );
      return null;
    }
    const chave = `${passoId}:${execucao.visitaAtual}`;
    let registro = await this.prisma.execucaoPasso.findUnique({
      where: { execucaoId_chave: { execucaoId, chave } },
    });
    let resultado: ResultadoDoPasso;
    if (registro?.status === 'CONCLUIDO') {
      // Já rodou nesta visita (idempotência): só refaz a transição.
      resultado = (registro.resultado as { decisao: ResultadoDoPasso } | null)
        ?.decisao ?? { acao: 'seguir' };
      if (resultado.acao === 'aguardar') {
        resultado = { acao: 'seguir' };
      }
    } else {
      if (!registro) {
        const ordem =
          (await this.prisma.execucaoPasso.count({ where: { execucaoId } })) +
          1;
        registro = await this.prisma.execucaoPasso.create({
          data: {
            execucaoId,
            passoId,
            tipo: passo.tipo,
            visita: execucao.visitaAtual,
            chave,
            ordem,
          },
        });
      } else {
        registro = await this.prisma.execucaoPasso.update({
          where: { id: registro.id },
          data: {
            status: 'EXECUTANDO',
            tentativas: { increment: 1 },
            erro: null,
          },
        });
      }
      const tipo = this.tipoDePasso(execucao.tipo, passo.tipo);
      try {
        if (!tipo) {
          throw new Error(`Tipo de passo desconhecido: "${passo.tipo}".`);
        }
        const atual = execucaoAtual(execucao);
        resultado = await executarComoAtor(
          {
            tipoAtor: 'AUTOMACAO',
            descricao: execucao.nome,
            cadeia: atual.cadeia,
          },
          () =>
            tipo.executar({
              execucao: atual,
              passo: passo as never,
              config: (passo.config ?? {}) as never,
              visita: execucao.visitaAtual,
              tentativa: registro!.tentativas,
              chaveIdempotencia: `${execucaoId}:${chave}`,
              retomada,
              agora: new Date(),
            }),
        );
        resultado = conferirResultado(resultado, passo.id, indice);
      } catch (erro) {
        const mensagem = erro instanceof Error ? erro.message : String(erro);
        if (
          erro instanceof ErroDePassoTemporario &&
          registro.tentativas < TENTATIVAS_TEMPORARIAS
        ) {
          const espera =
            erro.esperaSegundos ??
            Math.min(600, 15 * 2 ** (registro.tentativas - 1));
          await this.prisma.execucaoPasso.update({
            where: { id: registro.id },
            data: { erro: mensagem.slice(0, 2_000) },
          });
          await this.fila.enviar(
            FILA_AVANCAR_PASSOS,
            {
              execucaoId,
              ...(retomada ? { retomada } : {}),
              ...(token ? { token } : {}),
            },
            { atrasoSegundos: espera },
          );
          return null;
        }
        await this.prisma.execucaoPasso.update({
          where: { id: registro.id },
          data: {
            status: 'ERRO',
            erro: mensagem.slice(0, 2_000),
            concluidoEm: new Date(),
          },
        });
        await this.falhar(execucao.id, mensagem);
        await this.logs.aviso(
          'Passos',
          `Passo "${passo.id}" (${passo.tipo}) falhou na execução ${execucaoId}: ${mensagem}`,
          {
            execucaoId,
            passoId: passo.id,
            tipo: passo.tipo,
          },
        );
        return null;
      }
    }
    return this.aplicarTransicao(
      execucao,
      registro.id,
      indice,
      passoId,
      resultado,
    );
  }

  private async aplicarTransicao(
    execucao: Execucao,
    registroId: string,
    indice: IndiceDePassos,
    passoId: string,
    resultado: ResultadoDoPasso,
  ): Promise<{ retomada: Retomada | null; token?: string } | null> {
    const agora = new Date();
    const variaveis = resultado.variaveis
      ? {
          ...(execucao.variaveis as Record<string, unknown>),
          ...resultado.variaveis,
        }
      : undefined;
    const historico = json({
      decisao: resultado,
      saida: resultado.saida ?? null,
    });
    let dados: Prisma.ExecucaoUpdateManyMutationInput;
    let continuar: { retomada: Retomada | null; token?: string } | null = {
      retomada: null,
    };
    let statusDoRegistro: 'CONCLUIDO' | 'AGUARDANDO' = 'CONCLUIDO';
    let despertarEm: Date | null = null;
    const novoToken = randomUUID();

    if (resultado.acao === 'aguardar') {
      statusDoRegistro = 'AGUARDANDO';
      const simulada =
        execucao.teste && resultado.ate !== undefined && !resultado.entrada;
      dados = {
        status: 'AGUARDANDO',
        aguardandoAte: resultado.ate ?? null,
        aguardandoEntrada: resultado.entrada ?? false,
        esperaToken: novoToken,
      };
      if (simulada) {
        continuar = {
          retomada: { motivo: 'tempo', simulada: true },
          token: novoToken,
        };
      } else {
        continuar = null;
        despertarEm = execucao.teste ? null : (resultado.ate ?? null);
      }
    } else if (resultado.acao === 'encerrar') {
      dados = dadosDoFim(
        resultado.status ?? 'CONCLUIDA',
        resultado.motivo ?? 'encerrada',
      );
      continuar = null;
    } else {
      const proximo =
        resultado.acao === 'ramo'
          ? indice.entrarNoRamo(passoId, resultado.ramoId)
          : resultado.acao === 'ir_para'
            ? resultado.passoId
            : indice.depoisDe(passoId);
      if (proximo === null) {
        dados = dadosDoFim('CONCLUIDA', 'concluida');
        continuar = null;
      } else {
        const visitas = { ...(execucao.visitas as Record<string, number>) };
        const visita = (visitas[proximo] ?? 0) + 1;
        visitas[proximo] = visita;
        dados = {
          status: 'EM_ANDAMENTO',
          passoAtualId: proximo,
          visitaAtual: visita,
          visitas,
          aguardandoAte: null,
          aguardandoEntrada: false,
          esperaToken: null,
        };
      }
    }
    const aplicada = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.execucao.updateMany({
        where: { id: execucao.id, status: { in: ATIVAS } },
        data: {
          ...dados,
          ...(variaveis ? { variaveis: json(variaveis) } : {}),
          passosExecutados: { increment: 1 },
        },
      });
      if (count === 0) {
        // Cancelada no meio do passo: registra o passo e para.
        await tx.execucaoPasso.update({
          where: { id: registroId },
          data: {
            status: 'CONCLUIDO',
            resultado: historico,
            concluidoEm: agora,
          },
        });
        return false;
      }
      await tx.execucaoPasso.update({
        where: { id: registroId },
        data: {
          status: statusDoRegistro,
          resultado: historico,
          concluidoEm: statusDoRegistro === 'CONCLUIDO' ? agora : null,
        },
      });
      if (despertarEm) {
        await this.fila.enviar(
          FILA_AVANCAR_PASSOS,
          {
            execucaoId: execucao.id,
            retomada: { motivo: 'tempo' },
            token: novoToken,
          },
          { tx, executarEm: despertarEm },
        );
      }
      return true;
    });
    return aplicada ? continuar : null;
  }

  private async finalizar(
    id: string,
    status: 'CONCLUIDA' | 'CANCELADA',
    motivo: string,
  ): Promise<void> {
    await this.prisma.execucao.updateMany({
      where: { id, status: { in: ATIVAS } },
      data: dadosDoFim(status, motivo),
    });
  }

  private async falhar(id: string, erro: string): Promise<void> {
    await this.prisma.execucao.updateMany({
      where: { id, status: { in: ATIVAS } },
      data: {
        status: 'FALHOU',
        erro: erro.slice(0, 2_000),
        motivoFim: 'erro',
        concluidaEm: new Date(),
        aguardandoAte: null,
        aguardandoEntrada: false,
        esperaToken: null,
      },
    });
  }
}

function dadosDoFim(
  status: 'CONCLUIDA' | 'CANCELADA',
  motivo: string,
): Prisma.ExecucaoUpdateManyMutationInput {
  return {
    status,
    motivoFim: motivo,
    passoAtualId: status === 'CONCLUIDA' ? null : undefined,
    concluidaEm: new Date(),
    aguardandoAte: null,
    aguardandoEntrada: false,
    esperaToken: null,
  };
}

/** Confere o que o passo devolveu (ramo e desvio existentes). */
function conferirResultado(
  resultado: ResultadoDoPasso,
  passoId: string,
  indice: IndiceDePassos,
): ResultadoDoPasso {
  if (!resultado || typeof resultado !== 'object' || !('acao' in resultado)) {
    throw new Error(`O passo "${passoId}" não devolveu um resultado válido.`);
  }
  if (resultado.acao === 'ramo') {
    indice.entrarNoRamo(passoId, resultado.ramoId);
  }
  if (resultado.acao === 'ir_para' && !indice.existe(resultado.passoId)) {
    throw new Error(
      `Desvio para um passo que não existe: "${resultado.passoId}".`,
    );
  }
  if (resultado.acao === 'aguardar' && !resultado.ate && !resultado.entrada) {
    throw new Error(`O passo "${passoId}" pediu espera sem prazo nem entrada.`);
  }
  return resultado;
}

function execucaoAtual(execucao: Execucao): ExecucaoAtual {
  const cadeia = execucao.cadeia as unknown as CadeiaDeAutomacao;
  return {
    id: execucao.id,
    tipo: execucao.tipo,
    nome: execucao.nome,
    teste: execucao.teste,
    automacaoId: execucao.automacaoId,
    fluxoId: execucao.fluxoId,
    entidade: execucao.entidade,
    entidadeId: execucao.entidadeId,
    contatoId: execucao.contatoId,
    negocioId: execucao.negocioId,
    conversaId: execucao.conversaId,
    variaveis: (execucao.variaveis ?? {}) as Record<string, unknown>,
    contexto: (execucao.contexto ?? {}) as Record<string, unknown>,
    cadeia: cadeia?.execucaoId
      ? cadeia
      : { execucaoId: execucao.id, profundidade: 1, automacoes: [] },
  };
}

/**
 * Cópia em JSON puro (datas em ISO). Não usa `sanitizarParaJson`: definições e
 * variáveis podem ser profundas e ter chaves como `token` (cabeçalhos de webhook).
 */
function copiaJson(valor: unknown): unknown {
  return valor === undefined
    ? null
    : (JSON.parse(JSON.stringify(valor)) as unknown);
}

function json(valor: unknown): Prisma.InputJsonValue {
  return (copiaJson(valor) ?? {}) as Prisma.InputJsonValue;
}
