/**
 * Assistente de ajuda por IA (R25), para todos os papéis: estado e limites, a
 * pergunta em streaming (SSE), as conversas da própria pessoa e a avaliação
 * das respostas.
 *
 * Cada pergunta tem duas fases, como a análise do BI: `preparar` confere tudo
 * (IA configurada, base com artigos, limite diário da pessoa, orçamento do
 * mês, conversa) e grava a pergunta EM_ANDAMENTO — os erros aqui são respostas
 * HTTP normais —; `executar` faz a chamada ao Claude em streaming, manda os
 * eventos ao front e grava a resposta com auditoria.
 *
 * Para a IA vão só: as instruções e a base de conhecimento (sistema, em
 * cache), o papel e a área da pessoa, a tela sem ids nem consulta e o que ela
 * escreveu (com as perguntas e respostas anteriores da mesma conversa).
 */
import { Inject, Injectable } from '@nestjs/common';
import { dataLocal, inicioDoDia } from '../atividades/fuso-horario';
import { AuditoriaService } from '../auditoria/auditoria.service';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import {
  ChamadaClaudeService,
  FalhaDaChamada,
  type CodigoDaFalha,
  type UsoDeTokens,
} from '../bi/analise/chamada-claude.service';
import type { ParametrosDoFluxo } from '../bi/analise/cliente-anthropic';
import type { CanalDeEventos } from '../bi/analise/emissor-sse';
import {
  ConflitoException,
  MuitasTentativasException,
  NaoEncontradoException,
  RegraVioladaException,
  ServicoIndisponivelException,
} from '../comum/erros/excecoes';
import { AMBIENTE, type Ambiente } from '../config/ambiente';
import type {
  AssistenteChamado,
  AssistentePergunta,
  Prisma,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { travarChave } from '../prisma/travas';
import {
  ANDAMENTO_ABANDONADO_MS,
  AVISO_DE_REGISTRO,
  CATEGORIAS_DE_CHAMADO,
  type Categoria,
  ESFORCO_ASSISTENTE,
  HISTORICO_ENVIADO,
  INTERVALO_PARCIAL_MS,
  MAX_CARACTERES_PERGUNTA,
  MAX_PERGUNTAS_POR_CONVERSA,
  MAX_TOKENS_ASSISTENTE,
  MODELO_ASSISTENTE,
  REGRA_ASSISTENTE,
  ROTULO_DA_CATEGORIA,
} from './assistente.constantes';
import { BaseDeConhecimentoService } from './base-de-conhecimento';
import { chamadoParaDto } from './chamados/chamados-assistente.service';
import type { ConfiguracaoGravada } from './configuracao-assistente';
import { ConfiguracaoAssistenteService } from './configuracao-assistente.service';
import type {
  ConversaAssistenteDto,
  EstadoAssistenteDto,
  PerguntaAssistenteDto,
  PerguntarDto,
} from './dto/assistente.dto';
import {
  conferirRespostaDoAssistente,
  ESQUEMA_RESPOSTA_ASSISTENTE,
  respostaParcial,
} from './esquema-assistente';
import {
  INSTRUCOES_DO_ASSISTENTE,
  mensagemDaPergunta,
  RESPOSTA_DE_VAZAMENTO,
  type RespostaDoAssistente,
  respostaComoTexto,
  sanitizarTela,
  vazaInstrucoes,
} from './prompt-assistente';

/** Fuso do limite diário e do mês do orçamento. */
const FUSO = 'America/Sao_Paulo';

export const MENSAGENS_DO_ASSISTENTE: Readonly<Record<CodigoDaFalha, string>> =
  {
    tempo_esgotado:
      'O assistente demorou demais para responder. Tente de novo em alguns minutos.',
    indisponivel:
      'O serviço de IA está indisponível ou sobrecarregado agora. Tente de novo em alguns minutos.',
    chave_recusada:
      'O assistente está com um problema de configuração no servidor. Avise o Admin.',
    recusada:
      'O assistente não pôde responder a esta pergunta. Tente escrever de outro jeito.',
    resposta_incompleta:
      'A resposta veio incompleta. Tente de novo, se possível com uma pergunta mais curta.',
    resposta_invalida: 'A resposta veio num formato inesperado. Tente de novo.',
    cancelada: 'A pergunta foi cancelada.',
    erro: 'Não foi possível responder agora. Tente de novo.',
  };

export function inicioDeHoje(agora = new Date()): Date {
  const hoje = dataLocal(agora, FUSO);
  return inicioDoDia(hoje.ano, hoje.mes, hoje.dia, FUSO);
}

export function inicioDoMes(agora = new Date()): Date {
  const hoje = dataLocal(agora, FUSO);
  return inicioDoDia(hoje.ano, hoje.mes, 1, FUSO);
}

/** Início do dia `AAAA-MM-DD` em São Paulo (`depois` = o dia seguinte). */
export function inicioDoDiaTexto(dia: string, depois = false): Date {
  const [ano, mes, d] = dia.split('-').map(Number);
  return inicioDoDia(ano, mes, d + (depois ? 1 : 0), FUSO);
}

function segundosAteAmanha(agora = new Date()): number {
  const hoje = dataLocal(agora, FUSO);
  const amanha = inicioDoDia(hoje.ano, hoje.mes, hoje.dia + 1, FUSO);
  return Math.max(1, Math.ceil((amanha.getTime() - agora.getTime()) / 1000));
}

function segundosAteOProximoMes(agora = new Date()): number {
  const hoje = dataLocal(agora, FUSO);
  const proximo = inicioDoDia(hoje.ano, hoje.mes + 1, 1, FUSO);
  return Math.max(1, Math.ceil((proximo.getTime() - agora.getTime()) / 1000));
}

export function totalDeTokens(p: {
  tokensEntrada: number;
  tokensSaida: number;
  tokensCacheLeitura: number;
  tokensCacheEscrita: number;
}): number {
  return (
    p.tokensEntrada +
    p.tokensSaida +
    p.tokensCacheLeitura +
    p.tokensCacheEscrita
  );
}

/** Pergunta como a API devolve (sem os campos do Admin). */
export function perguntaParaDto(
  p: AssistentePergunta & { chamado?: AssistenteChamado | null },
): PerguntaAssistenteDto {
  const categoria = (p.categoria as Categoria | null) ?? null;
  return {
    id: p.id,
    conversaId: p.conversaId,
    pergunta: p.pergunta,
    tela: p.tela,
    modulo: p.modulo,
    status: p.status,
    resposta: p.resposta,
    resolvido: p.resolvido,
    categoria,
    resumoDoPedido: p.resumoDoPedido,
    erro: p.erro,
    avaliacao: p.avaliacao,
    podeAbrirChamado:
      p.status === 'CONCLUIDA' &&
      categoria !== null &&
      CATEGORIAS_DE_CHAMADO.includes(categoria) &&
      !p.chamado,
    chamado: p.chamado ? chamadoParaDto(p.chamado) : null,
    criadoEm: p.criadoEm.toISOString(),
  };
}

export interface PedidoDoAssistente {
  conversaId: string;
  perguntaId: string;
  conversaNova: boolean;
  usuario: UsuarioAutenticado;
  modulo: string;
  parametros: ParametrosDoFluxo;
}

@Injectable()
export class AssistenteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditoria: AuditoriaService,
    private readonly chamada: ChamadaClaudeService,
    private readonly base: BaseDeConhecimentoService,
    private readonly configuracao: ConfiguracaoAssistenteService,
    @Inject(AMBIENTE) private readonly ambiente: Ambiente,
  ) {}

  // -------------------------------------------------------------------------
  // Limites
  // -------------------------------------------------------------------------

  /** Perguntas da pessoa que contam no limite de hoje. */
  contarHoje(
    db: Prisma.TransactionClient | PrismaService,
    usuarioId: string,
  ): Promise<number> {
    return db.assistentePergunta.count({
      where: {
        usuarioId,
        criadoEm: { gte: inicioDeHoje() },
        OR: [
          { status: 'CONCLUIDA' },
          {
            status: 'EM_ANDAMENTO',
            criadoEm: { gte: new Date(Date.now() - ANDAMENTO_ABANDONADO_MS) },
          },
          // Falha que já gastou tokens segue contando (teto de custo).
          {
            status: 'FALHOU',
            tokensSaida: { gt: 0 },
            NOT: { erro: MENSAGENS_DO_ASSISTENTE.cancelada },
          },
        ],
      },
    });
  }

  /** Tokens gastos no mês (todas as pessoas). */
  async tokensNoMes(
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<number> {
    const soma = await db.assistentePergunta.aggregate({
      where: { criadoEm: { gte: inicioDoMes() } },
      _sum: {
        tokensEntrada: true,
        tokensSaida: true,
        tokensCacheLeitura: true,
        tokensCacheEscrita: true,
      },
    });
    return totalDeTokens({
      tokensEntrada: soma._sum.tokensEntrada ?? 0,
      tokensSaida: soma._sum.tokensSaida ?? 0,
      tokensCacheLeitura: soma._sum.tokensCacheLeitura ?? 0,
      tokensCacheEscrita: soma._sum.tokensCacheEscrita ?? 0,
    });
  }

  /** Por que o assistente não pode responder agora (independe da pessoa). */
  private motivoGeral(
    config: ConfiguracaoGravada,
    tokensNoMes: number,
  ): string | null {
    if (!this.ambiente.anthropic.configurada) {
      return 'O assistente de IA ainda não foi configurado no servidor.';
    }
    if (this.base.atual().artigos.length === 0) {
      return 'A base de conhecimento do assistente está vazia.';
    }
    if (config.perguntasPorDia === 0) {
      return 'O assistente de IA está desligado.';
    }
    if (
      config.orcamentoMensalTokens !== null &&
      tokensNoMes >= config.orcamentoMensalTokens
    ) {
      return 'O orçamento de uso da IA deste mês acabou. O assistente volta no mês que vem (ou quando o Admin aumentar o orçamento).';
    }
    return null;
  }

  async estado(usuario: UsuarioAutenticado): Promise<EstadoAssistenteDto> {
    const config = await this.configuracao.ler();
    const [usadasHoje, tokens] = await Promise.all([
      this.contarHoje(this.prisma, usuario.id),
      this.tokensNoMes(),
    ]);
    const restantesHoje = Math.max(0, config.perguntasPorDia - usadasHoje);
    let motivo = this.motivoGeral(config, tokens);
    if (!motivo && restantesHoje === 0) {
      motivo = `Você chegou ao limite de ${config.perguntasPorDia} perguntas por dia. Amanhã libera de novo.`;
    }
    return {
      disponivel: motivo === null,
      motivo,
      aviso: AVISO_DE_REGISTRO,
      modelo: MODELO_ASSISTENTE,
      perguntasPorDia: config.perguntasPorDia,
      usadasHoje,
      restantesHoje,
      maxCaracteresPergunta: MAX_CARACTERES_PERGUNTA,
      maxPerguntasPorConversa: MAX_PERGUNTAS_POR_CONVERSA,
      chamadosDisponiveis: this.configuracao.destinoDe(config).pronto,
      categoriasComChamado: [...CATEGORIAS_DE_CHAMADO],
    };
  }

  // -------------------------------------------------------------------------
  // Pergunta
  // -------------------------------------------------------------------------

  private parametros(
    mensagens: ParametrosDoFluxo['messages'],
  ): ParametrosDoFluxo {
    const base = this.base.atual();
    return {
      model: MODELO_ASSISTENTE,
      max_tokens: MAX_TOKENS_ASSISTENTE,
      // Recusa por política: a API refaz com o modelo de reserva padrão.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      thinking: { type: 'adaptive' },
      output_config: {
        effort: ESFORCO_ASSISTENTE,
        format: { type: 'json_schema', schema: ESQUEMA_RESPOSTA_ASSISTENTE },
      },
      // Instruções + base fixas em cache; a breakpoint automática cobre a conversa.
      cache_control: { type: 'ephemeral' },
      system: [
        { type: 'text', text: INSTRUCOES_DO_ASSISTENTE },
        {
          type: 'text',
          text: base.texto,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: mensagens,
    };
  }

  async preparar(
    usuario: UsuarioAutenticado,
    dto: PerguntarDto,
  ): Promise<PedidoDoAssistente> {
    const config = await this.configuracao.ler();
    const { tela, modulo } = sanitizarTela(dto.tela);
    const texto = dto.pergunta.trim();
    return this.prisma.$transaction(async (tx) => {
      await travarChave(tx, 'assistente-ia', usuario.id);
      const motivo = this.motivoGeral(config, await this.tokensNoMes(tx));
      if (motivo) {
        if (!this.ambiente.anthropic.configurada) {
          throw new ServicoIndisponivelException(motivo, {
            regra: REGRA_ASSISTENTE,
            motivo: 'nao_configurado',
          });
        }
        if (this.base.atual().artigos.length === 0) {
          throw new ServicoIndisponivelException(motivo, {
            regra: REGRA_ASSISTENTE,
            motivo: 'base_vazia',
          });
        }
        const orcamento = config.perguntasPorDia !== 0;
        throw new MuitasTentativasException(
          motivo,
          orcamento ? segundosAteOProximoMes() : undefined,
          {
            regra: REGRA_ASSISTENTE,
            motivo: orcamento ? 'orcamento_mensal' : 'desligado',
          },
        );
      }
      const usadas = await this.contarHoje(tx, usuario.id);
      if (usadas >= config.perguntasPorDia) {
        throw new MuitasTentativasException(
          `Você chegou ao limite de ${config.perguntasPorDia} perguntas por dia. Amanhã libera de novo.`,
          segundosAteAmanha(),
          {
            regra: REGRA_ASSISTENTE,
            motivo: 'limite_diario',
            perguntasPorDia: config.perguntasPorDia,
            usadasHoje: usadas,
          },
        );
      }
      const mensagens: ParametrosDoFluxo['messages'] = [];
      let conversaId: string;
      let conversaNova = false;
      const { papel, area } = usuario;
      if (dto.conversaId) {
        const conversa = await tx.assistenteConversa.findUnique({
          where: { id: dto.conversaId },
        });
        if (!conversa || conversa.usuarioId !== usuario.id) {
          throw new NaoEncontradoException('Conversa não encontrada.');
        }
        if (
          conversa.papel !== usuario.papel ||
          conversa.area !== usuario.area
        ) {
          // Papel mudou no meio da conversa: começa outra (as permissões mudaram).
          throw new RegraVioladaException(
            REGRA_ASSISTENTE,
            'O seu papel mudou desde o início desta conversa. Comece uma conversa nova.',
          );
        }
        const anteriores = await tx.assistentePergunta.findMany({
          where: { conversaId: conversa.id },
          orderBy: { criadoEm: 'asc' },
        });
        const abandonada = Date.now() - ANDAMENTO_ABANDONADO_MS;
        if (
          anteriores.some(
            (p) =>
              p.status === 'EM_ANDAMENTO' && p.criadoEm.getTime() > abandonada,
          )
        ) {
          throw new ConflitoException(
            'Ainda estou respondendo a pergunta anterior desta conversa. Espere terminar.',
            { regra: REGRA_ASSISTENTE },
          );
        }
        const validas = anteriores.filter(
          (p) =>
            p.status === 'CONCLUIDA' &&
            p.resposta !== null &&
            p.categoria !== null,
        );
        if (validas.length >= MAX_PERGUNTAS_POR_CONVERSA) {
          throw new RegraVioladaException(
            REGRA_ASSISTENTE,
            `Esta conversa chegou a ${MAX_PERGUNTAS_POR_CONVERSA} perguntas. Comece uma conversa nova.`,
            { maxPerguntasPorConversa: MAX_PERGUNTAS_POR_CONVERSA },
          );
        }
        // O histórico manda os pares mais recentes, como foram enviados.
        for (const p of validas.slice(-HISTORICO_ENVIADO)) {
          mensagens.push(
            {
              role: 'user',
              content: mensagemDaPergunta({
                papel: conversa.papel,
                area: conversa.area,
                tela: p.tela,
                pergunta: p.pergunta,
              }),
            },
            {
              role: 'assistant',
              content: respostaComoTexto({
                resposta: p.resposta ?? '',
                resolvido: p.resolvido ?? false,
                categoria: p.categoria as Categoria,
                resumoDoPedido: p.resumoDoPedido ?? '',
              }),
            },
          );
        }
        conversaId = conversa.id;
        await tx.assistenteConversa.update({
          where: { id: conversa.id },
          data: { atualizadoEm: new Date() },
        });
      } else {
        const conversa = await tx.assistenteConversa.create({
          data: {
            usuarioId: usuario.id,
            papel: usuario.papel,
            area: usuario.area,
            titulo: texto.length > 120 ? `${texto.slice(0, 119)}…` : texto,
          },
        });
        conversaId = conversa.id;
        conversaNova = true;
      }
      mensagens.push({
        role: 'user',
        content: mensagemDaPergunta({ papel, area, tela, pergunta: texto }),
      });
      const pergunta = await tx.assistentePergunta.create({
        data: {
          conversaId,
          usuarioId: usuario.id,
          area: usuario.area,
          pergunta: texto,
          tela,
          modulo,
          modelo: MODELO_ASSISTENTE,
        },
      });
      return {
        conversaId,
        perguntaId: pergunta.id,
        conversaNova,
        usuario,
        modulo,
        parametros: this.parametros(mensagens),
      };
    });
  }

  /**
   * Faz a chamada e manda os eventos (`inicio`, `fase`, `parcial`,
   * `nova_tentativa`, `concluido` ou `erro`). Grava e audita. Nunca lança.
   */
  async executar(
    pedido: PedidoDoAssistente,
    canal: CanalDeEventos,
    cancelar: AbortSignal,
  ): Promise<void> {
    const inicio = Date.now();
    canal.enviar('inicio', {
      conversaId: pedido.conversaId,
      perguntaId: pedido.perguntaId,
      conversaNova: pedido.conversaNova,
      modelo: MODELO_ASSISTENTE,
    });
    let ultimoParcial = 0;
    let ultimoTexto = '';
    try {
      const resultado = await this.chamada.executar(
        pedido.parametros,
        {
          aoIniciarTentativa: (tentativa, motivo) => {
            ultimoParcial = 0;
            ultimoTexto = '';
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
            const texto = respostaParcial(acumulado);
            // O parcial não pode adiantar um vazamento que a conferência final tiraria.
            if (texto && texto !== ultimoTexto && !vazaInstrucoes(texto, 6)) {
              ultimoParcial = agora;
              ultimoTexto = texto;
              canal.enviar('parcial', { resposta: texto });
            }
          },
        },
        (json) => conferirRespostaDoAssistente(json),
        cancelar,
      );
      let resposta: RespostaDoAssistente = resultado.valor;
      const vazou = vazaInstrucoes(resposta.resposta);
      if (vazou) {
        resposta = {
          resposta: RESPOSTA_DE_VAZAMENTO,
          resolvido: false,
          categoria: 'fora_do_escopo',
          resumoDoPedido: 'Pedido para revelar as instruções do assistente',
        };
      }
      const duracaoMs = Date.now() - inicio;
      await this.gravar(pedido, {
        status: 'CONCLUIDA',
        resposta,
        uso: resultado.uso,
        tentativas: resultado.tentativas,
        duracaoMs,
        erro: null,
        vazou,
      });
      const config = await this.configuracao.ler();
      const usadas = await this.contarHoje(this.prisma, pedido.usuario.id);
      const pedeChamado = CATEGORIAS_DE_CHAMADO.includes(resposta.categoria);
      canal.enviar('concluido', {
        conversaId: pedido.conversaId,
        perguntaId: pedido.perguntaId,
        resposta: resposta.resposta,
        resolvido: resposta.resolvido,
        categoria: resposta.categoria,
        resumoDoPedido: resposta.resumoDoPedido,
        podeAbrirChamado:
          pedeChamado && this.configuracao.destinoDe(config).pronto,
        restantesHoje: Math.max(0, config.perguntasPorDia - usadas),
        duracaoMs,
      });
    } catch (erro) {
      const falha =
        erro instanceof FalhaDaChamada
          ? erro
          : new FalhaDaChamada(
              'erro',
              { entrada: 0, saida: 0, cacheLeitura: 0, cacheEscrita: 0 },
              0,
            );
      const mensagem = MENSAGENS_DO_ASSISTENTE[falha.codigo];
      try {
        await this.gravar(
          pedido,
          {
            status: 'FALHOU',
            resposta: null,
            uso: falha.uso,
            tentativas: falha.tentativas,
            duracaoMs: Date.now() - inicio,
            erro: mensagem,
            vazou: false,
          },
          falha.codigo,
        );
      } finally {
        canal.enviar('erro', {
          codigo: falha.codigo,
          mensagem,
          conversaId: pedido.conversaId,
          perguntaId: pedido.perguntaId,
        });
      }
    }
  }

  private async gravar(
    pedido: PedidoDoAssistente,
    r: {
      status: 'CONCLUIDA' | 'FALHOU';
      resposta: RespostaDoAssistente | null;
      uso: UsoDeTokens;
      tentativas: number;
      duracaoMs: number;
      erro: string | null;
      vazou: boolean;
    },
    codigo?: CodigoDaFalha,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.assistentePergunta.update({
        where: { id: pedido.perguntaId },
        data: {
          status: r.status,
          resposta: r.resposta?.resposta ?? null,
          resolvido: r.resposta?.resolvido ?? null,
          categoria: r.resposta?.categoria ?? null,
          resumoDoPedido: r.resposta?.resumoDoPedido ?? null,
          erro: r.erro,
          tentativas: r.tentativas,
          tokensEntrada: r.uso.entrada,
          tokensSaida: r.uso.saida,
          tokensCacheLeitura: r.uso.cacheLeitura,
          tokensCacheEscrita: r.uso.cacheEscrita,
          duracaoMs: r.duracaoMs,
          concluidoEm: new Date(),
        },
      });
      const u = pedido.usuario;
      await this.auditoria.registrar(tx, {
        acao:
          r.status === 'CONCLUIDA'
            ? 'assistente.pergunta_respondida'
            : 'assistente.pergunta_falhou',
        entidade: 'assistente_pergunta',
        entidadeId: pedido.perguntaId,
        resumo:
          r.status === 'CONCLUIDA' && r.resposta
            ? `${u.nome} usou o assistente de IA (${ROTULO_DA_CATEGORIA[r.resposta.categoria]}${r.resposta.resolvido ? ', resolvido' : ''})`
            : `A pergunta de ${u.nome} ao assistente de IA falhou`,
        dados: {
          conversaId: pedido.conversaId,
          modulo: pedido.modulo,
          categoria: r.resposta?.categoria ?? null,
          resolvido: r.resposta?.resolvido ?? null,
          ...(r.vazou
            ? { respostaSubstituida: 'vazamento_de_instrucoes' }
            : {}),
          ...(codigo ? { falha: codigo } : {}),
          tokens: totalDeTokens({
            tokensEntrada: r.uso.entrada,
            tokensSaida: r.uso.saida,
            tokensCacheLeitura: r.uso.cacheLeitura,
            tokensCacheEscrita: r.uso.cacheEscrita,
          }),
          tentativas: r.tentativas,
          regra: REGRA_ASSISTENTE,
        },
      });
    });
  }

  // -------------------------------------------------------------------------
  // Conversas e avaliação (da própria pessoa)
  // -------------------------------------------------------------------------

  async conversas(
    usuario: UsuarioAutenticado,
  ): Promise<ConversaAssistenteDto[]> {
    const lista = await this.prisma.assistenteConversa.findMany({
      where: { usuarioId: usuario.id },
      orderBy: { atualizadoEm: 'desc' },
      take: 30,
      include: { _count: { select: { perguntas: true } } },
    });
    return lista.map((c) => ({
      id: c.id,
      titulo: c.titulo,
      criadoEm: c.criadoEm.toISOString(),
      atualizadoEm: c.atualizadoEm.toISOString(),
      totalPerguntas: c._count.perguntas,
    }));
  }

  /** Uma conversa: a própria (qualquer uma para o Admin). */
  async conversa(
    usuario: UsuarioAutenticado,
    id: string,
  ): Promise<ConversaAssistenteDto> {
    const c = await this.prisma.assistenteConversa.findUnique({
      where: { id },
      include: {
        perguntas: {
          orderBy: { criadoEm: 'asc' },
          include: { chamado: true },
        },
      },
    });
    if (!c || (c.usuarioId !== usuario.id && usuario.papel !== 'ADMIN')) {
      throw new NaoEncontradoException('Conversa não encontrada.');
    }
    return {
      id: c.id,
      titulo: c.titulo,
      criadoEm: c.criadoEm.toISOString(),
      atualizadoEm: c.atualizadoEm.toISOString(),
      totalPerguntas: c.perguntas.length,
      perguntas: c.perguntas.map(perguntaParaDto),
    };
  }

  async avaliar(
    usuario: UsuarioAutenticado,
    perguntaId: string,
    avaliacao: 'UTIL' | 'NAO_UTIL' | null,
  ): Promise<PerguntaAssistenteDto> {
    return this.prisma.$transaction(async (tx) => {
      const p = await tx.assistentePergunta.findUnique({
        where: { id: perguntaId },
      });
      if (!p || p.usuarioId !== usuario.id) {
        throw new NaoEncontradoException('Resposta não encontrada.');
      }
      if (p.status !== 'CONCLUIDA') {
        throw new RegraVioladaException(
          REGRA_ASSISTENTE,
          'Só dá para avaliar uma resposta concluída.',
        );
      }
      const atualizada = await tx.assistentePergunta.update({
        where: { id: perguntaId },
        data: { avaliacao, avaliadoEm: avaliacao ? new Date() : null },
        include: { chamado: true },
      });
      if (p.avaliacao !== avaliacao) {
        await this.auditoria.registrar(tx, {
          acao: 'assistente.resposta_avaliada',
          entidade: 'assistente_pergunta',
          entidadeId: perguntaId,
          resumo: `${usuario.nome} avaliou uma resposta do assistente de IA como ${avaliacao === 'UTIL' ? 'útil' : avaliacao === 'NAO_UTIL' ? 'não útil' : 'sem avaliação'}`,
          dados: {
            antes: p.avaliacao,
            depois: avaliacao,
            regra: REGRA_ASSISTENTE,
          },
        });
      }
      return perguntaParaDto(atualizada);
    });
  }
}
