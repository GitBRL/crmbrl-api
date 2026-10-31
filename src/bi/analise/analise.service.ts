/**
 * Análise do BI por IA (R21, só Admin): estado e configuração, a análise de um
 * painel com os filtros da tela, as perguntas de acompanhamento e o histórico.
 *
 * Cada pedido tem duas fases: `preparar…` confere tudo (chave configurada,
 * limite diário, filtros, análise existente) e grava a linha EM_ANDAMENTO —
 * os erros aqui são respostas HTTP normais —; `executar` faz a chamada em
 * streaming, manda os eventos ao front e grava o resultado com auditoria.
 */
import { Inject, Injectable } from '@nestjs/common';
import { partialParse } from '@anthropic-ai/sdk/_vendor/partial-json-parser/parser';
import { dataLocal, inicioDoDia } from '../../atividades/fuso-horario';
import { AuditoriaService } from '../../auditoria/auditoria.service';
import type { UsuarioAutenticado } from '../../auth/usuario-autenticado';
import {
  ConflitoException,
  MuitasTentativasException,
  NaoEncontradoException,
  RegraVioladaException,
  ServicoIndisponivelException,
} from '../../comum/erros/excecoes';
import {
  montarPagina,
  type Pagina,
  paraSkipTake,
} from '../../comum/paginacao/paginacao';
import { AMBIENTE, type Ambiente } from '../../config/ambiente';
import type {
  AnaliseIa,
  AnaliseIaPergunta,
  Prisma,
} from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { travarChave } from '../../prisma/travas';
import { FUSO_DO_BI } from '../bi.constantes';
import { BiService } from '../bi.service';
import type { PainelBi, PainelCalculado } from '../bi.tipos';
import {
  ANDAMENTO_ABANDONADO_MS,
  CHAVE_CONFIGURACAO_ANALISE,
  COMO_CONFIGURAR,
  ESFORCO_ANALISE,
  INTERVALO_PARCIAL_MS,
  LIMITE_DIARIO_MAXIMO,
  LIMITE_DIARIO_PADRAO,
  MAX_PERGUNTAS_POR_ANALISE,
  MAX_TOKENS_ANALISE,
  MODELO_ANALISE,
  REGRA_ANALISE,
} from './analise.constantes';
import {
  ChamadaClaudeService,
  FalhaDaChamada,
  type UsoDeTokens,
} from './chamada-claude.service';
import type { ParametrosDoFluxo } from './cliente-anthropic';
import type {
  AnaliseDetalheDto,
  AnaliseResumoDto,
  ConfiguracaoAnaliseDto,
  EstadoAnaliseDto,
  FiltroHistoricoAnaliseDto,
  PerguntaRespondidaDto,
  SolicitarAnaliseDto,
} from './dto/analise.dto';
import type { CanalDeEventos } from './emissor-sse';
import {
  type ClasseDeId,
  type EntradaAnalise,
  idsDaEntrada,
  montarEntrada,
} from './entrada-analise';
import {
  type AcaoModelo,
  conferirResposta,
  type DestaqueModelo,
  ESQUEMA_RESPOSTA,
  type RespostaModelo,
  type RiscoModelo,
} from './esquema-analise';
import { conferirLink, type LinkConferido } from './links-analise';
import {
  mensagemDaAnalise,
  mensagemDaPergunta,
  PROMPT_DE_SISTEMA,
} from './prompt-analise';

export interface AcaoConferida {
  titulo: string;
  detalhe: string;
  prioridade: AcaoModelo['prioridade'];
  link: LinkConferido;
}

/** Resultado gravado e devolvido: a resposta do modelo com os links conferidos. */
export interface ResultadoAnalise {
  resumo: string;
  destaques: DestaqueModelo[];
  riscos: RiscoModelo[];
  acoes: AcaoConferida[];
}

export interface RespostaPergunta {
  resposta: string;
  destaques: DestaqueModelo[];
  riscos: RiscoModelo[];
  acoes: AcaoConferida[];
}

interface FiltrosGravados {
  periodo: PainelCalculado['periodo'];
  anterior: PainelCalculado['anterior'];
  aplicados: PainelCalculado['filtros'];
}

/** Pedido preparado, pronto para `executar`. */
export interface PedidoPreparado {
  tipo: 'analise' | 'pergunta';
  analiseId: string;
  perguntaId: string | null;
  painel: PainelBi;
  periodo: PainelCalculado['periodo'];
  ids: Map<string, ClasseDeId>;
  parametros: ParametrosDoFluxo;
  usuario: UsuarioAutenticado;
}

interface ConfiguracaoAnalise {
  limiteDiario: number;
}

type AnaliseComUsuario = AnaliseIa & {
  usuario: { id: string; nome: string };
  _count: { perguntas: number };
  perguntas?: AnaliseIaPergunta[];
};

function lerConfiguracao(valor: unknown): ConfiguracaoAnalise {
  const limite = (valor as { limiteDiario?: unknown } | null)?.limiteDiario;
  return {
    limiteDiario:
      typeof limite === 'number' &&
      Number.isInteger(limite) &&
      limite >= 0 &&
      limite <= LIMITE_DIARIO_MAXIMO
        ? limite
        : LIMITE_DIARIO_PADRAO,
  };
}

function inicioDeHoje(agora = new Date()): Date {
  const hoje = dataLocal(agora, FUSO_DO_BI);
  return inicioDoDia(hoje.ano, hoje.mes, hoje.dia, FUSO_DO_BI);
}

function segundosAteAmanha(agora = new Date()): number {
  const hoje = dataLocal(agora, FUSO_DO_BI);
  const amanha = inicioDoDia(hoje.ano, hoje.mes, hoje.dia + 1, FUSO_DO_BI);
  return Math.max(1, Math.ceil((amanha.getTime() - agora.getTime()) / 1000));
}

/** Link conferido → texto de link, para refazer a resposta do modelo na conversa. */
function linkComoTexto(link: LinkConferido): string {
  const consulta = new URLSearchParams(link.parametros).toString();
  return consulta ? `${link.caminho}?${consulta}` : link.caminho;
}

/** O que o modelo "disse" (forma do esquema), refeito do resultado gravado — determinístico para o cache. */
function comoRespostaDoModelo(r: {
  resumo: string;
  destaques: DestaqueModelo[];
  riscos: RiscoModelo[];
  acoes: AcaoConferida[];
}): string {
  // Chaves sempre na mesma ordem (o JSONB reordena as gravadas).
  const resposta: RespostaModelo = {
    resumo: r.resumo,
    destaques: r.destaques.map((d) => ({
      titulo: d.titulo,
      detalhe: d.detalhe,
      tendencia: d.tendencia,
    })),
    riscos: r.riscos.map((d) => ({
      titulo: d.titulo,
      detalhe: d.detalhe,
      gravidade: d.gravidade,
    })),
    acoes: r.acoes.map((a) => ({
      titulo: a.titulo,
      detalhe: a.detalhe,
      prioridade: a.prioridade,
      link: linkComoTexto({
        ...a.link,
        parametros: Object.fromEntries(
          Object.entries(a.link.parametros).sort(([x], [y]) =>
            x.localeCompare(y),
          ),
        ),
      }),
      rotuloLink: a.link.rotulo,
    })),
  };
  return JSON.stringify(resposta);
}

function tokens(linha: {
  tokensEntrada: number;
  tokensSaida: number;
  tokensCacheLeitura: number;
  tokensCacheEscrita: number;
}): UsoDeTokens {
  return {
    entrada: linha.tokensEntrada,
    saida: linha.tokensSaida,
    cacheLeitura: linha.tokensCacheLeitura,
    cacheEscrita: linha.tokensCacheEscrita,
  };
}

function colunasDeTokens(uso: UsoDeTokens) {
  return {
    tokensEntrada: uso.entrada,
    tokensSaida: uso.saida,
    tokensCacheLeitura: uso.cacheLeitura,
    tokensCacheEscrita: uso.cacheEscrita,
  };
}

/** Versão parcial e segura do JSON em formação (sem os links ainda não conferidos). */
function resultadoParcial(texto: string): Record<string, unknown> | null {
  let parcial: unknown;
  try {
    parcial = partialParse(texto);
  } catch {
    return null;
  }
  if (
    typeof parcial !== 'object' ||
    parcial === null ||
    Array.isArray(parcial)
  ) {
    return null;
  }
  const p = parcial as Record<string, unknown>;
  const saida: Record<string, unknown> = {};
  if (typeof p.resumo === 'string') {
    saida.resumo = p.resumo;
  }
  for (const campo of ['destaques', 'riscos'] as const) {
    if (Array.isArray(p[campo])) {
      saida[campo] = p[campo];
    }
  }
  if (Array.isArray(p.acoes)) {
    saida.acoes = (p.acoes as Record<string, unknown>[])
      .filter((a) => typeof a === 'object' && a !== null)
      .map((a) => ({
        titulo: a.titulo,
        detalhe: a.detalhe,
        prioridade: a.prioridade,
      }));
  }
  return saida;
}

@Injectable()
export class AnaliseService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditoria: AuditoriaService,
    private readonly bi: BiService,
    private readonly chamada: ChamadaClaudeService,
    @Inject(AMBIENTE) private readonly ambiente: Ambiente,
  ) {}

  // -------------------------------------------------------------------------
  // Estado e configuração
  // -------------------------------------------------------------------------

  async estado(): Promise<EstadoAnaliseDto> {
    const configurada = this.ambiente.anthropic.configurada;
    const { limiteDiario } = await this.configuracao();
    const usadasHoje = await this.contarHoje(this.prisma);
    const restantesHoje = Math.max(0, limiteDiario - usadasHoje);
    let motivo: string | null = null;
    if (!configurada) {
      motivo = 'A análise por IA ainda não foi configurada no servidor.';
    } else if (limiteDiario === 0) {
      motivo = 'A análise por IA está desligada (limite diário zero).';
    } else if (restantesHoje === 0) {
      motivo = `O limite de ${limiteDiario} análises por dia foi atingido. Amanhã libera de novo.`;
    }
    return {
      configurada,
      comoConfigurar: configurada ? null : COMO_CONFIGURAR,
      disponivel: motivo === null,
      motivo,
      modelo: MODELO_ANALISE,
      limiteDiario,
      usadasHoje,
      restantesHoje,
      maxPerguntasPorAnalise: MAX_PERGUNTAS_POR_ANALISE,
    };
  }

  async configuracao(): Promise<ConfiguracaoAnalise> {
    const linha = await this.prisma.configuracao.findUnique({
      where: { chave: CHAVE_CONFIGURACAO_ANALISE },
    });
    return lerConfiguracao(linha?.valor);
  }

  async configurar(
    usuario: UsuarioAutenticado,
    dto: ConfiguracaoAnaliseDto,
  ): Promise<EstadoAnaliseDto> {
    await this.prisma.$transaction(async (tx) => {
      const linha = await tx.configuracao.findUnique({
        where: { chave: CHAVE_CONFIGURACAO_ANALISE },
      });
      const antes = lerConfiguracao(linha?.valor);
      const depois = lerConfiguracao({ limiteDiario: dto.limiteDiario });
      await tx.configuracao.upsert({
        where: { chave: CHAVE_CONFIGURACAO_ANALISE },
        create: {
          chave: CHAVE_CONFIGURACAO_ANALISE,
          valor: { ...depois },
          atualizadoPorId: usuario.id,
        },
        update: { valor: { ...depois }, atualizadoPorId: usuario.id },
      });
      await this.auditoria.registrar(tx, {
        acao: 'bi.analise_ia_configurada',
        entidade: 'configuracao',
        entidadeId: null,
        resumo: `${usuario.nome} mudou o limite de análises por IA de ${antes.limiteDiario} para ${depois.limiteDiario} por dia`,
        dados: { antes, depois, regra: REGRA_ANALISE },
      });
    });
    return this.estado();
  }

  /** Análises que contam no limite de hoje: concluídas e em andamento recentes. */
  private contarHoje(
    db: Prisma.TransactionClient | PrismaService,
  ): Promise<number> {
    return db.analiseIa.count({
      where: {
        criadoEm: { gte: inicioDeHoje() },
        OR: [
          { status: 'CONCLUIDA' },
          {
            status: 'EM_ANDAMENTO',
            criadoEm: { gte: new Date(Date.now() - ANDAMENTO_ABANDONADO_MS) },
          },
        ],
      },
    });
  }

  private exigirConfigurada(): void {
    if (!this.ambiente.anthropic.configurada) {
      throw new ServicoIndisponivelException(
        'A análise por IA ainda não foi configurada no servidor.',
        {
          regra: REGRA_ANALISE,
          motivo: 'nao_configurada',
          comoConfigurar: COMO_CONFIGURAR,
        },
      );
    }
  }

  // -------------------------------------------------------------------------
  // Análise
  // -------------------------------------------------------------------------

  async prepararAnalise(
    usuario: UsuarioAutenticado,
    dto: SolicitarAnaliseDto,
  ): Promise<PedidoPreparado> {
    this.exigirConfigurada();
    const { painel, ...filtro } = dto;
    // Mesmo cálculo (e visibilidade) da tela; o cache curto do BI vale aqui.
    const calculado = await this.bi.painel(usuario, painel, filtro);
    const { entrada, idsConhecidos } = montarEntrada(calculado);
    const filtros: FiltrosGravados = {
      periodo: calculado.periodo,
      anterior: calculado.anterior,
      aplicados: calculado.filtros,
    };
    const mensagemInicial = mensagemDaAnalise(entrada);
    const { limiteDiario } = await this.configuracao();
    const analise = await this.prisma.$transaction(async (tx) => {
      await travarChave(tx, 'analise-ia', 'limite-diario');
      const usadas = await this.contarHoje(tx);
      if (usadas >= limiteDiario) {
        throw new MuitasTentativasException(
          limiteDiario === 0
            ? 'A análise por IA está desligada (limite diário zero).'
            : `O limite de ${limiteDiario} análises por dia foi atingido. Amanhã libera de novo.`,
          segundosAteAmanha(),
          { regra: REGRA_ANALISE, limiteDiario, usadasHoje: usadas },
        );
      }
      return tx.analiseIa.create({
        data: {
          usuarioId: usuario.id,
          painel,
          filtros: filtros as unknown as Prisma.InputJsonValue,
          entrada: entrada as unknown as Prisma.InputJsonValue,
          mensagemInicial,
          modelo: MODELO_ANALISE,
        },
      });
    });
    return {
      tipo: 'analise',
      analiseId: analise.id,
      perguntaId: null,
      painel,
      periodo: calculado.periodo,
      ids: idsConhecidos,
      parametros: this.parametros([{ role: 'user', content: mensagemInicial }]),
      usuario,
    };
  }

  // -------------------------------------------------------------------------
  // Pergunta de acompanhamento
  // -------------------------------------------------------------------------

  async prepararPergunta(
    usuario: UsuarioAutenticado,
    analiseId: string,
    pergunta: string,
  ): Promise<PedidoPreparado> {
    this.exigirConfigurada();
    const texto = pergunta.trim();
    return this.prisma.$transaction(async (tx) => {
      await travarChave(tx, 'analise-ia', analiseId);
      const analise = await tx.analiseIa.findUnique({
        where: { id: analiseId },
        include: { perguntas: { orderBy: { criadoEm: 'asc' } } },
      });
      if (!analise) {
        throw new NaoEncontradoException('Análise não encontrada.');
      }
      if (analise.status !== 'CONCLUIDA' || !analise.resultado) {
        throw new RegraVioladaException(
          REGRA_ANALISE,
          'Só dá para perguntar sobre uma análise concluída.',
        );
      }
      const abandonada = Date.now() - ANDAMENTO_ABANDONADO_MS;
      if (
        analise.perguntas.some(
          (p) =>
            p.status === 'EM_ANDAMENTO' && p.criadoEm.getTime() > abandonada,
        )
      ) {
        throw new ConflitoException(
          'Já há uma pergunta sendo respondida sobre esta análise. Espere terminar.',
          { regra: REGRA_ANALISE },
        );
      }
      const feitas = analise.perguntas.filter(
        (p) => p.status !== 'FALHOU',
      ).length;
      if (feitas >= MAX_PERGUNTAS_POR_ANALISE) {
        throw new RegraVioladaException(
          REGRA_ANALISE,
          `Cada análise aceita até ${MAX_PERGUNTAS_POR_ANALISE} perguntas. Peça uma análise nova para continuar.`,
          { maxPerguntasPorAnalise: MAX_PERGUNTAS_POR_ANALISE },
        );
      }
      const entrada = analise.entrada as unknown as EntradaAnalise;
      const mensagens: ParametrosDoFluxo['messages'] = [
        { role: 'user', content: analise.mensagemInicial },
        {
          role: 'assistant',
          content: comoRespostaDoModelo(
            analise.resultado as unknown as ResultadoAnalise,
          ),
        },
      ];
      for (const anterior of analise.perguntas) {
        if (anterior.status === 'CONCLUIDA' && anterior.resposta) {
          const r = anterior.resposta as unknown as RespostaPergunta;
          mensagens.push(
            { role: 'user', content: mensagemDaPergunta(anterior.pergunta) },
            {
              role: 'assistant',
              content: comoRespostaDoModelo({ ...r, resumo: r.resposta }),
            },
          );
        }
      }
      mensagens.push({ role: 'user', content: mensagemDaPergunta(texto) });
      const nova = await tx.analiseIaPergunta.create({
        data: { analiseId, pergunta: texto },
      });
      const filtros = analise.filtros as unknown as FiltrosGravados;
      return {
        tipo: 'pergunta' as const,
        analiseId,
        perguntaId: nova.id,
        painel: analise.painel as PainelBi,
        periodo: filtros.periodo,
        ids: idsDaEntrada(entrada),
        parametros: this.parametros(mensagens),
        usuario,
      };
    });
  }

  // -------------------------------------------------------------------------
  // Execução (streaming)
  // -------------------------------------------------------------------------

  /**
   * Faz a chamada, manda os eventos (`inicio`, `nova_tentativa`, `fase`,
   * `parcial`, `concluido` ou `erro`) e grava o resultado. Nunca lança.
   */
  async executar(
    pedido: PedidoPreparado,
    canal: CanalDeEventos,
    cancelar: AbortSignal,
  ): Promise<void> {
    const inicio = Date.now();
    canal.enviar('inicio', {
      tipo: pedido.tipo,
      analiseId: pedido.analiseId,
      perguntaId: pedido.perguntaId,
      painel: pedido.painel,
      periodo: pedido.periodo,
      modelo: MODELO_ANALISE,
    });
    let ultimoParcial = 0;
    try {
      const resultado = await this.chamada.executar(
        pedido.parametros,
        {
          aoIniciarTentativa: (tentativa, motivo) => {
            ultimoParcial = 0;
            if (tentativa > 1) {
              canal.enviar('nova_tentativa', { tentativa, motivo });
            }
          },
          aoMudarDeFase: (fase) => canal.enviar('fase', { fase }),
          aoReceberTexto: (acumulado) => {
            const agora = Date.now();
            if (agora - ultimoParcial < INTERVALO_PARCIAL_MS) {
              return;
            }
            const parcial = resultadoParcial(acumulado);
            if (parcial) {
              ultimoParcial = agora;
              canal.enviar('parcial', parcial);
            }
          },
        },
        (json) => conferirResposta(json),
        cancelar,
      );
      const conferido = this.conferirLinks(resultado.valor, pedido);
      const duracaoMs = Date.now() - inicio;
      if (pedido.tipo === 'analise') {
        await this.gravarAnalise(pedido, {
          status: 'CONCLUIDA',
          resultado: conferido,
          uso: resultado.uso,
          tentativas: resultado.tentativas,
          duracaoMs,
          erro: null,
        });
        const estado = await this.estado();
        canal.enviar('concluido', {
          tipo: 'analise',
          analiseId: pedido.analiseId,
          resultado: conferido,
          tokens: resultado.uso,
          tentativas: resultado.tentativas,
          duracaoMs,
          restantesHoje: estado.restantesHoje,
        });
      } else {
        const resposta: RespostaPergunta = {
          resposta: conferido.resumo,
          destaques: conferido.destaques,
          riscos: conferido.riscos,
          acoes: conferido.acoes,
        };
        await this.gravarPergunta(pedido, {
          status: 'CONCLUIDA',
          resposta,
          uso: resultado.uso,
          tentativas: resultado.tentativas,
          duracaoMs,
          erro: null,
        });
        canal.enviar('concluido', {
          tipo: 'pergunta',
          analiseId: pedido.analiseId,
          perguntaId: pedido.perguntaId,
          resposta,
          tokens: resultado.uso,
          tentativas: resultado.tentativas,
          duracaoMs,
        });
      }
    } catch (erro) {
      const falha =
        erro instanceof FalhaDaChamada
          ? erro
          : new FalhaDaChamada(
              'erro',
              { entrada: 0, saida: 0, cacheLeitura: 0, cacheEscrita: 0 },
              0,
            );
      const dados = {
        status: 'FALHOU' as const,
        uso: falha.uso,
        tentativas: falha.tentativas,
        duracaoMs: Date.now() - inicio,
        erro: falha.message,
      };
      try {
        if (pedido.tipo === 'analise') {
          await this.gravarAnalise(
            pedido,
            { ...dados, resultado: null },
            falha.codigo,
          );
        } else {
          await this.gravarPergunta(
            pedido,
            { ...dados, resposta: null },
            falha.codigo,
          );
        }
      } finally {
        canal.enviar('erro', {
          codigo: falha.codigo,
          mensagem: falha.message,
          analiseId: pedido.analiseId,
          perguntaId: pedido.perguntaId,
        });
      }
    }
  }

  private parametros(
    mensagens: ParametrosDoFluxo['messages'],
  ): ParametrosDoFluxo {
    return {
      model: MODELO_ANALISE,
      max_tokens: MAX_TOKENS_ANALISE,
      // Recusa por política: a API refaz com o modelo de reserva padrão.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      thinking: { type: 'adaptive' },
      output_config: {
        effort: ESFORCO_ANALISE,
        format: { type: 'json_schema', schema: ESQUEMA_RESPOSTA },
      },
      // Sistema fixo em cache; a breakpoint automática cobre a conversa (perguntas).
      cache_control: { type: 'ephemeral' },
      system: [
        {
          type: 'text',
          text: PROMPT_DE_SISTEMA,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: mensagens,
    };
  }

  private conferirLinks(
    resposta: RespostaModelo,
    pedido: PedidoPreparado,
  ): ResultadoAnalise {
    return {
      resumo: resposta.resumo,
      destaques: resposta.destaques,
      riscos: resposta.riscos,
      acoes: resposta.acoes.map((acao) => ({
        titulo: acao.titulo,
        detalhe: acao.detalhe,
        prioridade: acao.prioridade,
        link: conferirLink(
          acao.link,
          acao.rotuloLink,
          pedido.ids,
          pedido.painel,
        ),
      })),
    };
  }

  private async gravarAnalise(
    pedido: PedidoPreparado,
    r: {
      status: 'CONCLUIDA' | 'FALHOU';
      resultado: ResultadoAnalise | null;
      uso: UsoDeTokens;
      tentativas: number;
      duracaoMs: number;
      erro: string | null;
    },
    codigo?: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const analise = await tx.analiseIa.update({
        where: { id: pedido.analiseId },
        data: {
          status: r.status,
          resultado: (r.resultado ?? undefined) as
            Prisma.InputJsonValue | undefined,
          erro: r.erro,
          tentativas: r.tentativas,
          duracaoMs: r.duracaoMs,
          concluidoEm: new Date(),
          ...colunasDeTokens(r.uso),
        },
      });
      const filtros = analise.filtros as unknown as FiltrosGravados;
      await this.auditoria.registrar(tx, {
        acao:
          r.status === 'CONCLUIDA'
            ? 'bi.analise_ia_concluida'
            : 'bi.analise_ia_falhou',
        entidade: 'analise_ia',
        entidadeId: pedido.analiseId,
        resumo:
          r.status === 'CONCLUIDA'
            ? `${pedido.usuario.nome} pediu a análise por IA do painel ${pedido.painel} do BI`
            : `A análise por IA do painel ${pedido.painel} pedida por ${pedido.usuario.nome} falhou`,
        dados: {
          painel: pedido.painel,
          periodo: filtros.periodo,
          filtros: filtros.aplicados,
          modelo: MODELO_ANALISE,
          tentativas: r.tentativas,
          tokens: r.uso,
          duracaoMs: r.duracaoMs,
          ...(codigo ? { falha: codigo } : {}),
          regra: REGRA_ANALISE,
        },
      });
    });
  }

  private async gravarPergunta(
    pedido: PedidoPreparado,
    r: {
      status: 'CONCLUIDA' | 'FALHOU';
      resposta: RespostaPergunta | null;
      uso: UsoDeTokens;
      tentativas: number;
      duracaoMs: number;
      erro: string | null;
    },
    codigo?: string,
  ): Promise<void> {
    const perguntaId = pedido.perguntaId as string;
    await this.prisma.$transaction(async (tx) => {
      const pergunta = await tx.analiseIaPergunta.update({
        where: { id: perguntaId },
        data: {
          status: r.status,
          resposta: (r.resposta ?? undefined) as
            Prisma.InputJsonValue | undefined,
          erro: r.erro,
          tentativas: r.tentativas,
          duracaoMs: r.duracaoMs,
          concluidoEm: new Date(),
          ...colunasDeTokens(r.uso),
        },
      });
      // Os totais da análise somam as perguntas.
      await tx.analiseIa.update({
        where: { id: pedido.analiseId },
        data: {
          tokensEntrada: { increment: r.uso.entrada },
          tokensSaida: { increment: r.uso.saida },
          tokensCacheLeitura: { increment: r.uso.cacheLeitura },
          tokensCacheEscrita: { increment: r.uso.cacheEscrita },
        },
      });
      await this.auditoria.registrar(tx, {
        acao:
          r.status === 'CONCLUIDA'
            ? 'bi.analise_ia_pergunta_respondida'
            : 'bi.analise_ia_pergunta_falhou',
        entidade: 'analise_ia',
        entidadeId: pedido.analiseId,
        resumo:
          r.status === 'CONCLUIDA'
            ? `${pedido.usuario.nome} fez uma pergunta sobre a análise por IA do painel ${pedido.painel}`
            : `A pergunta de ${pedido.usuario.nome} sobre a análise por IA do painel ${pedido.painel} falhou`,
        dados: {
          perguntaId,
          pergunta: pergunta.pergunta,
          modelo: MODELO_ANALISE,
          tentativas: r.tentativas,
          tokens: r.uso,
          duracaoMs: r.duracaoMs,
          ...(codigo ? { falha: codigo } : {}),
          regra: REGRA_ANALISE,
        },
      });
    });
  }

  // -------------------------------------------------------------------------
  // Histórico
  // -------------------------------------------------------------------------

  async historico(
    filtro: FiltroHistoricoAnaliseDto,
  ): Promise<Pagina<AnaliseResumoDto>> {
    const where: Prisma.AnaliseIaWhereInput = {
      ...(filtro.usuarioId ? { usuarioId: filtro.usuarioId } : {}),
      ...(filtro.painel ? { painel: filtro.painel } : {}),
    };
    const [linhas, total] = await Promise.all([
      this.prisma.analiseIa.findMany({
        where,
        orderBy: { criadoEm: 'desc' },
        include: {
          usuario: { select: { id: true, nome: true } },
          _count: { select: { perguntas: true } },
        },
        ...paraSkipTake(filtro),
      }),
      this.prisma.analiseIa.count({ where }),
    ]);
    return montarPagina(
      linhas.map((l) => this.resumo(l)),
      total,
      filtro,
    );
  }

  async detalhe(id: string): Promise<AnaliseDetalheDto> {
    const analise = await this.prisma.analiseIa.findUnique({
      where: { id },
      include: {
        usuario: { select: { id: true, nome: true } },
        _count: { select: { perguntas: true } },
        perguntas: { orderBy: { criadoEm: 'asc' } },
      },
    });
    if (!analise) {
      throw new NaoEncontradoException('Análise não encontrada.');
    }
    return Object.assign(this.resumo(analise), {
      resultado: (analise.resultado ??
        null) as unknown as AnaliseDetalheDto['resultado'],
      entrada: analise.entrada as Record<string, unknown>,
      perguntas: (analise.perguntas ?? []).map((p): PerguntaRespondidaDto => ({
        id: p.id,
        pergunta: p.pergunta,
        resposta: (p.resposta ??
          null) as unknown as PerguntaRespondidaDto['resposta'],
        status: p.status,
        erro: p.erro,
        tentativas: p.tentativas,
        tokens: tokens(p),
        duracaoMs: p.duracaoMs,
        criadoEm: p.criadoEm.toISOString(),
      })),
    });
  }

  private resumo(analise: AnaliseComUsuario): AnaliseResumoDto {
    const filtros = analise.filtros as unknown as FiltrosGravados;
    const resultado = analise.resultado as unknown as ResultadoAnalise | null;
    return {
      id: analise.id,
      usuario: analise.usuario,
      painel: analise.painel,
      periodo: filtros.periodo,
      filtros: filtros.aplicados,
      status: analise.status,
      erro: analise.erro,
      resumo: resultado?.resumo ?? null,
      modelo: analise.modelo,
      tentativas: analise.tentativas,
      totalPerguntas: analise._count.perguntas,
      tokens: tokens(analise),
      duracaoMs: analise.duracaoMs,
      criadoEm: analise.criadoEm.toISOString(),
      concluidoEm: analise.concluidoEm?.toISOString() ?? null,
    };
  }
}
