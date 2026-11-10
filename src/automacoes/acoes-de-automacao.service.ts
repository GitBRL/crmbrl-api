import { createHash } from 'node:crypto';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { AuditoriaService } from '../auditoria/auditoria.service';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import { normalizarEtiquetas } from '../comum/dominio/etiquetas';
import { ModelosService } from '../comum/modelos/modelos.service';
import type { DefinicaoDePassos } from '../comum/passos/definicao';
import { PassosService } from '../comum/passos/passos.service';
import {
  aguardarAte,
  type ContextoDoPasso,
  encerrar,
  irParaRamo,
  type ResultadoDoPasso,
  seguir,
} from '../comum/passos/tipos';
import { SegmentosService } from '../comum/segmentos/segmentos.service';
import { AtividadesService } from '../atividades/atividades.service';
import type { CriarAtividadeDto } from '../atividades/dto/criar-atividade.dto';
import { ContatosService } from '../contatos/contatos.service';
import { DistribuicaoService } from '../funis/distribuicao.service';
import { NegociosService } from '../funis/negocios.service';
import type { AtualizarNegocioDto } from '../funis/dto/negocios.dto';
import type { Automacao, Prisma } from '../generated/prisma/client';
import { NotificacoesService } from '../notificacoes/notificacoes.service';
import { PrismaService } from '../prisma/prisma.service';
import { montarEnvelope } from '../webhooks/saida/envelope';
import { EntregasService } from '../webhooks/saida/entregas.service';
import { VALIDADORES_DE_ACAO } from './acoes-validacao';
import {
  EVENTO_DE_WEBHOOK_DA_AUTOMACAO,
  TIPOS_DE_PASSO_DE_AUTOMACAO as T,
} from './automacoes.constantes';
import { lerCondicoes, situacaoDoHorarioDaAutomacao } from './condicoes';
import { EnvioDeMensagemDaAutomacao } from './envio-de-mensagem-da-automacao.service';

type Ctx<C> = ContextoDoPasso<C>;
type Config = Record<string, unknown>;

const UMA_HORA_MS = 3_600_000;
const MS_POR_UNIDADE = {
  minutos: 60_000,
  horas: UMA_HORA_MS,
  dias: 86_400_000,
};

/** UUID determinístico a partir de um texto (id de evento estável por passo). */
function uuidDe(texto: string): string {
  const h = createHash('sha256').update(texto).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * Ações das automações (R19): os tipos de passo `acao.*` e `condicao`,
 * registrados no executor para execuções `AUTOMACAO`. Cada ação passa pelos
 * serviços de domínio (as mesmas regras de negócio e auditoria das ações
 * humanas), com o ator AUTOMACAO (descrição = nome da automação) que o
 * executor põe no contexto. A identidade usada nas permissões é a de um Admin
 * ativo: quem limita o alcance é o escopo (área) da automação, conferido ao
 * iniciar. No modo teste nada tem efeito: a saída do passo mostra o que seria feito.
 *
 * Antes de cada passo vale a guarda: automação removida ou pausada, critérios
 * de parada (respondeu, ganhou, perdeu, saiu do segmento), opt-out de marketing
 * (R4.6) e horário permitido (fora dele, espera a próxima abertura).
 */
@Injectable()
export class AcoesDeAutomacao implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passos: PassosService,
    private readonly segmentos: SegmentosService,
    private readonly modelos: ModelosService,
    private readonly mensagens: EnvioDeMensagemDaAutomacao,
    private readonly contatos: ContatosService,
    private readonly negocios: NegociosService,
    private readonly distribuicao: DistribuicaoService,
    private readonly atividades: AtividadesService,
    private readonly notificacoes: NotificacoesService,
    private readonly entregas: EntregasService,
    private readonly auditoria: AuditoriaService,
  ) {}

  onModuleInit(): void {
    const registrar = <C extends Config>(
      tipo: string,
      executar: (ctx: Ctx<C>) => Promise<ResultadoDoPasso>,
    ) =>
      this.passos.registrarTipo<C>({
        tipo,
        execucoes: ['AUTOMACAO'],
        validar: VALIDADORES_DE_ACAO[tipo],
        executar: async (ctx) => (await this.guarda(ctx)) ?? executar(ctx),
      });
    registrar(T.WHATSAPP, (c) => this.mensagens.enviar(c, 'WHATSAPP'));
    registrar(T.EMAIL, (c) => this.mensagens.enviar(c, 'EMAIL'));
    registrar(T.ATIVIDADE, (c) => this.criarAtividade(c));
    registrar(T.MOVER_ETAPA, (c) => this.moverEtapa(c));
    registrar(T.ATRIBUIR, (c) => this.atribuir(c));
    registrar(T.ETIQUETAR, (c) => this.etiquetar(c));
    registrar(T.CRIAR_NEGOCIO, (c) => this.criarNegocio(c));
    registrar(T.NOTIFICAR, (c) => this.notificar(c));
    registrar(T.WEBHOOK, (c) => this.chamarWebhook(c));
    registrar(T.CHATBOT, (c) => this.iniciarChatbot(c));
    registrar(T.CONDICAO, (c) => this.condicao(c));
  }

  // -------------------------------------------------------------------------
  // Guarda
  // -------------------------------------------------------------------------

  /** `null` = pode agir; senão, o resultado que o passo devolve no lugar da ação. */
  async guarda(ctx: Ctx<Config>): Promise<ResultadoDoPasso | null> {
    const { execucao } = ctx;
    if (execucao.teste) {
      return null;
    }
    const automacao = execucao.automacaoId
      ? await this.prisma.automacao.findUnique({
          where: { id: execucao.automacaoId },
        })
      : null;
    if (!automacao || automacao.excluidoEm) {
      return encerrar('automacao_removida', { status: 'CANCELADA' });
    }
    const motivo = await this.motivoDeParada(automacao, execucao.id, {
      contatoId: execucao.contatoId,
      negocioId: execucao.negocioId,
    });
    if (motivo) {
      return encerrar(motivo, { status: 'CANCELADA' });
    }
    if (!automacao.ativa) {
      // Pausada: a execução fica parada e confere de novo a cada hora.
      return aguardarAte(new Date(ctx.agora.getTime() + UMA_HORA_MS), {
        saida: { pausada: true },
      });
    }
    const horario = situacaoDoHorarioDaAutomacao(
      lerCondicoes(automacao.condicoes),
      ctx.agora,
    );
    if (!horario.pode) {
      return horario.proximaAbertura
        ? aguardarAte(horario.proximaAbertura, {
            saida: {
              foraDoHorario: true,
              retomaEm: horario.proximaAbertura.toISOString(),
            },
          })
        : encerrar('fora_do_horario', { status: 'CANCELADA' });
    }
    return null;
  }

  /** Critérios de parada (R19) e opt-out de marketing (R4.6); o motivo, ou nulo. */
  async motivoDeParada(
    automacao: Automacao,
    execucaoId: string,
    alvo: { contatoId: string | null; negocioId: string | null },
  ): Promise<string | null> {
    if (!alvo.contatoId) {
      return null;
    }
    const contato = await this.prisma.contato.findUnique({
      where: { id: alvo.contatoId },
      select: { excluidoEm: true, optOutMarketing: true },
    });
    if (!contato || contato.excluidoEm) {
      return 'contato_removido';
    }
    if (automacao.marketing && contato.optOutMarketing) {
      return 'opt_out';
    }
    const criterios = automacao.criteriosParada;
    if (criterios.length === 0) {
      return null;
    }
    const inicio = (
      await this.prisma.execucao.findUniqueOrThrow({
        where: { id: execucaoId },
        select: { criadoEm: true },
      })
    ).criadoEm;
    if (criterios.includes('RESPONDEU')) {
      const respondeu = await this.prisma.mensagem.findFirst({
        where: {
          direcao: 'ENTRADA',
          ocorridaEm: { gt: inicio },
          conversa: { contatoId: alvo.contatoId },
        },
        select: { id: true },
      });
      if (respondeu) {
        return 'criterio:RESPONDEU';
      }
    }
    for (const [criterio, status, motivo] of [
      ['GANHOU', 'GANHO', 'criterio:GANHOU'],
      ['PERDEU', 'PERDIDO', 'criterio:PERDEU'],
    ] as const) {
      if (!criterios.includes(criterio)) {
        continue;
      }
      const encerrado = await this.prisma.negocio.findFirst({
        where: alvo.negocioId
          ? { id: alvo.negocioId, status }
          : {
              contatoId: alvo.contatoId,
              status,
              OR: [{ ganhoEm: { gt: inicio } }, { perdidoEm: { gt: inicio } }],
            },
        select: { id: true },
      });
      if (encerrado) {
        return motivo;
      }
    }
    if (criterios.includes('SAIU_DO_SEGMENTO')) {
      const { segmento } = lerCondicoes(automacao.condicoes);
      if (
        segmento &&
        !(await this.segmentos.contem(segmento, alvo.contatoId, {
          excluirOptOut: automacao.marketing,
          ...(alvo.negocioId ? { negocioId: alvo.negocioId } : {}),
        }))
      ) {
        return 'criterio:SAIU_DO_SEGMENTO';
      }
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Utilidades
  // -------------------------------------------------------------------------

  /** Identidade (permissões) das chamadas aos serviços de domínio: um Admin ativo. */
  private async executor(): Promise<UsuarioAutenticado> {
    const admin = await this.prisma.usuario.findFirst({
      where: { papel: 'ADMIN', ativo: true },
      orderBy: { criadoEm: 'asc' },
    });
    if (!admin) {
      throw new Error('Não há um Admin ativo para executar a automação.');
    }
    return {
      id: admin.id,
      nome: admin.nome,
      email: admin.email,
      papel: admin.papel,
      area: null,
      nomeSetor: null,
      liderId: null,
      deveTrocarSenha: false,
      sessaoId: 'automacao',
    };
  }

  private alvoDe(ctx: Ctx<Config>) {
    return {
      contatoId: ctx.execucao.contatoId ?? undefined,
      negocioId: ctx.execucao.negocioId ?? undefined,
      variaveis: { ...ctx.execucao.variaveis },
    };
  }

  private async renderizar(ctx: Ctx<Config>, texto: string): Promise<string> {
    return (
      await this.modelos.renderizarPara(texto, this.alvoDe(ctx), {
        semente: ctx.chaveIdempotencia,
      })
    ).texto.trim();
  }

  private async automacaoDaExecucao(
    ctx: Ctx<Config>,
  ): Promise<Automacao | null> {
    return ctx.execucao.automacaoId
      ? this.prisma.automacao.findUnique({
          where: { id: ctx.execucao.automacaoId },
        })
      : null;
  }

  /** Responsável natural da execução: do negócio, senão do contato. */
  private async responsavelNatural(ctx: Ctx<Config>): Promise<string | null> {
    if (ctx.execucao.negocioId) {
      const negocio = await this.prisma.negocio.findUnique({
        where: { id: ctx.execucao.negocioId },
        select: { responsavelId: true },
      });
      if (negocio?.responsavelId) {
        return negocio.responsavelId;
      }
    }
    if (ctx.execucao.contatoId) {
      const contato = await this.prisma.contato.findUnique({
        where: { id: ctx.execucao.contatoId },
        select: { responsavelId: true },
      });
      return contato?.responsavelId ?? null;
    }
    return null;
  }

  private async usuarioAtivo(
    id: string | null | undefined,
  ): Promise<string | null> {
    if (!id) {
      return null;
    }
    const u = await this.prisma.usuario.findFirst({
      where: { id, ativo: true },
      select: { id: true },
    });
    return u?.id ?? null;
  }

  // -------------------------------------------------------------------------
  // Condição ("Se…")
  // -------------------------------------------------------------------------

  private async condicao(ctx: Ctx<Config>): Promise<ResultadoDoPasso> {
    const segmento = ctx.config.segmento as Parameters<
      SegmentosService['contem']
    >[0];
    const automacao = await this.automacaoDaExecucao(ctx);
    const dentro = ctx.execucao.contatoId
      ? await this.segmentos.contem(segmento, ctx.execucao.contatoId, {
          excluirOptOut: false,
          ...(ctx.execucao.negocioId
            ? { negocioId: ctx.execucao.negocioId }
            : {}),
        })
      : false;
    void automacao;
    const ramo = dentro ? 'sim' : 'nao';
    const existe = (ctx.passo.ramos ?? []).some((r) => r.id === ramo);
    return existe
      ? irParaRamo(ramo, { saida: { resultado: ramo } })
      : seguir({ saida: { resultado: ramo, semRamo: true } });
  }

  // -------------------------------------------------------------------------
  // Atividade
  // -------------------------------------------------------------------------

  private async criarAtividade(ctx: Ctx<Config>): Promise<ResultadoDoPasso> {
    const c = ctx.config;
    const titulo = await this.renderizar(ctx, String(c.titulo));
    const descricao =
      typeof c.descricao === 'string' && c.descricao.trim()
        ? await this.renderizar(ctx, c.descricao)
        : null;
    const prazo = c.prazo as
      { quantidade: number; unidade: keyof typeof MS_POR_UNIDADE } | undefined;
    const venceEm = new Date(
      ctx.agora.getTime() +
        (prazo
          ? prazo.quantidade * MS_POR_UNIDADE[prazo.unidade]
          : 24 * UMA_HORA_MS),
    ).toISOString();
    const automacao = await this.automacaoDaExecucao(ctx);
    const responsavelId =
      (await this.usuarioAtivo(c.responsavelId as string | undefined)) ??
      (await this.usuarioAtivo(await this.responsavelNatural(ctx))) ??
      (await this.usuarioAtivo(automacao?.criadoPorId));
    if (ctx.execucao.teste) {
      return seguir({
        saida: { simulado: true, titulo, descricao, venceEm, responsavelId },
      });
    }
    if (!responsavelId) {
      throw new Error(
        'Não há responsável para a atividade: defina uma pessoa na ação ou um responsável no contato ou negócio.',
      );
    }
    const dto = {
      tipo: c.tipo,
      titulo,
      descricao,
      prioridade: c.prioridade ?? 'MEDIA',
      venceEm,
      responsavelId,
      contatoId: ctx.execucao.contatoId,
      negocioId: ctx.execucao.negocioId,
    } as unknown as CriarAtividadeDto;
    const atividade = await this.atividades.criar(await this.executor(), dto);
    return seguir({
      saida: { atividadeId: atividade.id, titulo, venceEm, responsavelId },
      variaveis: { atividadeId: atividade.id },
    });
  }

  // -------------------------------------------------------------------------
  // Mover etapa
  // -------------------------------------------------------------------------

  private async moverEtapa(ctx: Ctx<Config>): Promise<ResultadoDoPasso> {
    const etapaId = ctx.config.etapaId as string;
    if (!ctx.execucao.negocioId) {
      return seguir({ saida: { pulado: 'sem_negocio' } });
    }
    const negocio = await this.prisma.negocio.findFirst({
      where: { id: ctx.execucao.negocioId, excluidoEm: null },
      select: { etapaId: true, status: true },
    });
    if (!negocio) {
      return seguir({ saida: { pulado: 'negocio_removido' } });
    }
    if (negocio.etapaId === etapaId) {
      return seguir({ saida: { pulado: 'ja_na_etapa' } });
    }
    if (ctx.execucao.teste) {
      return seguir({ saida: { simulado: true, etapaId } });
    }
    const motivoPerda =
      typeof ctx.config.motivoPerda === 'string'
        ? ctx.config.motivoPerda
        : undefined;
    await this.negocios.mover(await this.executor(), ctx.execucao.negocioId, {
      etapaId,
      ...(motivoPerda ? { motivoPerda } : {}),
    });
    return seguir({ saida: { etapaId } });
  }

  // -------------------------------------------------------------------------
  // Atribuir responsável / rodízio
  // -------------------------------------------------------------------------

  private async atribuir(ctx: Ctx<Config>): Promise<ResultadoDoPasso> {
    const c = ctx.config;
    const estrategia = c.estrategia as
      'RESPONSAVEL_FIXO' | 'RODIZIO' | 'LIDER_DA_AREA';
    const negocio = ctx.execucao.negocioId
      ? await this.prisma.negocio.findFirst({
          where: { id: ctx.execucao.negocioId, excluidoEm: null },
          select: {
            responsavelId: true,
            funil: { select: { id: true, area: true, visibilidade: true } },
          },
        })
      : null;
    if (!negocio && !ctx.execucao.contatoId) {
      return seguir({ saida: { pulado: 'sem_alvo' } });
    }
    const automacao = await this.automacaoDaExecucao(ctx);
    const area =
      (c.area as string | undefined) ??
      negocio?.funil.area ??
      automacao?.area ??
      null;
    if (ctx.execucao.teste) {
      return seguir({ saida: { simulado: true, estrategia, area } });
    }
    let responsavelId: string | null;
    if (estrategia === 'RESPONSAVEL_FIXO') {
      responsavelId = c.responsavelId as string;
    } else {
      if (!area) {
        throw new Error('Informe a área do rodízio ou do líder.');
      }
      // No negócio, o rodízio do setor do funil respeita quem atua nele (R5.13).
      const destino =
        negocio && negocio.funil.area === area ? negocio.funil : area;
      responsavelId = await this.prisma.$transaction((tx) =>
        this.distribuicao.escolherResponsavel(tx, destino, estrategia),
      );
      if (!responsavelId) {
        throw new Error(
          'Não há ninguém disponível para receber (rodízio sem participantes).',
        );
      }
    }
    const executor = await this.executor();
    if (negocio) {
      if (negocio.responsavelId === responsavelId) {
        return seguir({
          saida: { pulado: 'ja_e_o_responsavel', responsavelId },
        });
      }
      await this.negocios.atualizar(executor, ctx.execucao.negocioId!, {
        responsavelId,
      } as unknown as AtualizarNegocioDto);
    } else {
      const contato = await this.prisma.contato.findUnique({
        where: { id: ctx.execucao.contatoId! },
        select: { responsavelId: true },
      });
      if (contato?.responsavelId === responsavelId) {
        return seguir({
          saida: { pulado: 'ja_e_o_responsavel', responsavelId },
        });
      }
      await this.contatos.atualizar(executor, ctx.execucao.contatoId!, {
        responsavelId,
      });
    }
    return seguir({ saida: { responsavelId, estrategia } });
  }

  // -------------------------------------------------------------------------
  // Etiquetar
  // -------------------------------------------------------------------------

  private async etiquetar(ctx: Ctx<Config>): Promise<ResultadoDoPasso> {
    if (!ctx.execucao.contatoId) {
      return seguir({ saida: { pulado: 'sem_contato' } });
    }
    const contato = await this.prisma.contato.findFirst({
      where: { id: ctx.execucao.contatoId, excluidoEm: null },
      select: { etiquetas: true },
    });
    if (!contato) {
      return seguir({ saida: { pulado: 'contato_removido' } });
    }
    const adicionar = (ctx.config.adicionar as string[] | undefined) ?? [];
    const remover = new Set(
      ((ctx.config.remover as string[] | undefined) ?? []).map((e) =>
        e.trim().toLocaleLowerCase('pt-BR'),
      ),
    );
    const etiquetas = normalizarEtiquetas([
      ...contato.etiquetas.filter(
        (e) => !remover.has(e.trim().toLocaleLowerCase('pt-BR')),
      ),
      ...adicionar,
    ]);
    const igual =
      etiquetas.length === contato.etiquetas.length &&
      etiquetas.every((e, i) => e === contato.etiquetas[i]);
    if (igual) {
      return seguir({ saida: { pulado: 'sem_mudanca' } });
    }
    if (ctx.execucao.teste) {
      return seguir({ saida: { simulado: true, etiquetas } });
    }
    await this.contatos.atualizar(
      await this.executor(),
      ctx.execucao.contatoId,
      {
        etiquetas,
      },
    );
    return seguir({ saida: { etiquetas } });
  }

  // -------------------------------------------------------------------------
  // Criar negócio em outro funil
  // -------------------------------------------------------------------------

  private async criarNegocio(ctx: Ctx<Config>): Promise<ResultadoDoPasso> {
    const c = ctx.config;
    if (!ctx.execucao.contatoId) {
      return seguir({ saida: { pulado: 'sem_contato' } });
    }
    const funilId = c.funilId as string;
    const etapa = c.etapaId
      ? await this.prisma.etapa.findFirst({
          where: { id: c.etapaId as string, funilId },
        })
      : await this.prisma.etapa.findFirst({
          where: { funilId, tipo: 'ABERTA' },
          orderBy: { ordem: 'asc' },
        });
    if (!etapa) {
      throw new Error('A etapa do novo negócio não existe no funil escolhido.');
    }
    const titulo =
      typeof c.titulo === 'string' && c.titulo.trim()
        ? await this.renderizar(ctx, c.titulo)
        : undefined;
    if (ctx.execucao.teste) {
      return seguir({
        saida: { simulado: true, funilId, etapaId: etapa.id, titulo },
      });
    }
    const responsavelFixoId = await this.usuarioAtivo(
      c.responsavelId as string | undefined,
    );
    const estrategia =
      (c.estrategia as
        'RODIZIO' | 'RESPONSAVEL_FIXO' | 'LIDER_DA_AREA' | undefined) ??
      (responsavelFixoId ? 'RESPONSAVEL_FIXO' : 'RODIZIO');
    const resultado = await this.prisma.$transaction((tx) =>
      this.negocios.criarAutomatico(tx, {
        contatoId: ctx.execucao.contatoId!,
        funilId,
        etapaId: etapa.id,
        titulo,
        valor:
          c.valor !== undefined && c.valor !== null
            ? `${c.valor as string | number}`
            : undefined,
        origem: 'OUTRO',
        origemDetalhe: ctx.execucao.nome,
        estrategia,
        responsavelFixoId: responsavelFixoId ?? undefined,
      }),
    );
    return seguir({
      saida: {
        negocioId: resultado.negocio.id,
        criado: resultado.criado,
        reconversao: resultado.reconversao,
      },
    });
  }

  // -------------------------------------------------------------------------
  // Notificar usuário
  // -------------------------------------------------------------------------

  private async notificar(ctx: Ctx<Config>): Promise<ResultadoDoPasso> {
    const c = ctx.config;
    const titulo = await this.renderizar(ctx, String(c.titulo));
    const texto =
      typeof c.texto === 'string' && c.texto.trim()
        ? await this.renderizar(ctx, c.texto)
        : null;
    let destinatarios: string[] = [];
    if (c.para === 'usuarios') {
      const ativos = await this.prisma.usuario.findMany({
        where: { id: { in: c.usuarioIds as string[] }, ativo: true },
        select: { id: true },
      });
      destinatarios = ativos.map((u) => u.id);
    } else {
      const responsavelId = await this.responsavelNatural(ctx);
      if (c.para === 'responsavel' && responsavelId) {
        destinatarios = (await this.usuarioAtivo(responsavelId))
          ? [responsavelId]
          : [];
      } else if (c.para === 'lider' && responsavelId) {
        const responsavel = await this.prisma.usuario.findUnique({
          where: { id: responsavelId },
          select: { liderId: true },
        });
        const lider = await this.usuarioAtivo(responsavel?.liderId);
        destinatarios = lider ? [lider] : [];
      }
    }
    if (destinatarios.length === 0) {
      return seguir({ saida: { pulado: 'sem_destinatario' } });
    }
    if (ctx.execucao.teste) {
      return seguir({
        saida: { simulado: true, titulo, texto, destinatarios },
      });
    }
    const link = ctx.execucao.contatoId
      ? `/contatos/${ctx.execucao.contatoId}`
      : null;
    // Um job repetido não notifica de novo: a marca vai nos dados da notificação.
    const jaFeita = await this.prisma.notificacao.findFirst({
      where: {
        usuarioId: { in: destinatarios },
        dados: { path: ['chaveIdempotencia'], equals: ctx.chaveIdempotencia },
      },
      select: { id: true },
    });
    if (jaFeita) {
      return seguir({ saida: { jaNotificado: true, destinatarios } });
    }
    await this.prisma.$transaction(async (tx) => {
      await this.notificacoes.notificarVarios(tx, destinatarios, {
        tipo: 'automacao.notificacao',
        titulo,
        texto,
        link,
        dados: {
          chaveIdempotencia: ctx.chaveIdempotencia,
          automacaoId: ctx.execucao.automacaoId,
          execucaoId: ctx.execucao.id,
        },
      });
      await this.auditoria.registrar(tx, {
        acao: 'automacao.notificou',
        entidade: 'automacao',
        entidadeId: ctx.execucao.automacaoId,
        resumo: `Automação "${ctx.execucao.nome}" notificou ${destinatarios.length} pessoa(s): ${titulo}`,
        dados: { destinatarios, titulo },
        relacionados: { contato: ctx.execucao.contatoId },
      });
    });
    return seguir({ saida: { destinatarios, titulo } });
  }

  // -------------------------------------------------------------------------
  // Webhook de saída
  // -------------------------------------------------------------------------

  private async chamarWebhook(ctx: Ctx<Config>): Promise<ResultadoDoPasso> {
    const webhookId = ctx.config.webhookId as string;
    const destino = await this.prisma.webhookSaida.findFirst({
      where: { id: webhookId, excluidoEm: null, ativo: true },
      select: { id: true, nome: true },
    });
    if (!destino) {
      throw new Error(
        'O webhook de saída da ação não existe ou está desativado.',
      );
    }
    if (ctx.execucao.teste) {
      return seguir({ saida: { simulado: true, webhook: destino.nome } });
    }
    const contato = ctx.execucao.contatoId
      ? await this.prisma.contato.findUnique({
          where: { id: ctx.execucao.contatoId },
          select: { id: true, nome: true, email: true, telefone: true },
        })
      : null;
    const negocio = ctx.execucao.negocioId
      ? await this.prisma.negocio.findUnique({
          where: { id: ctx.execucao.negocioId },
          select: {
            id: true,
            titulo: true,
            valor: true,
            etapaId: true,
            funilId: true,
          },
        })
      : null;
    const agora = new Date();
    const eventoId = uuidDe(`webhook:${ctx.chaveIdempotencia}`);
    const envelope = montarEnvelope({
      id: eventoId,
      tipo: EVENTO_DE_WEBHOOK_DA_AUTOMACAO,
      ocorridoEm: agora,
      dados: {
        automacao: { id: ctx.execucao.automacaoId, nome: ctx.execucao.nome },
        execucaoId: ctx.execucao.id,
        entidade: ctx.execucao.entidade,
        entidadeId: ctx.execucao.entidadeId,
        contato,
        negocio: negocio
          ? { ...negocio, valor: negocio.valor.toString() }
          : null,
        variaveis: ctx.execucao.variaveis,
      },
    });
    const criadas = await this.prisma.webhookEntrega.createManyAndReturn({
      data: [
        {
          webhookId: destino.id,
          eventoId,
          tipoEvento: EVENTO_DE_WEBHOOK_DA_AUTOMACAO,
          payload: envelope as unknown as Prisma.InputJsonObject,
          status: 'PENDENTE',
          proximaTentativaEm: agora,
        },
      ],
      skipDuplicates: true,
      select: { id: true },
    });
    if (criadas.length === 0) {
      return seguir({ saida: { jaEnviado: true, webhook: destino.nome } });
    }
    // Uma tentativa já; falhas seguem a agenda de novas tentativas dos webhooks (R9.4).
    await this.entregas.executarTentativa(criadas[0].id, agora.toISOString());
    return seguir({
      saida: { webhook: destino.nome, entregaId: criadas[0].id },
    });
  }

  // -------------------------------------------------------------------------
  // Chatbot
  // -------------------------------------------------------------------------

  private async iniciarChatbot(ctx: Ctx<Config>): Promise<ResultadoDoPasso> {
    const fluxo = await this.prisma.fluxoChatbot.findFirst({
      where: {
        id: ctx.config.fluxoId as string,
        excluidoEm: null,
        ativo: true,
      },
      include: { versaoPublicada: true },
    });
    if (!fluxo?.versaoPublicada) {
      throw new Error('O fluxo do chatbot não está publicado e ativo.');
    }
    const conversaId =
      ctx.execucao.conversaId ??
      (ctx.execucao.contatoId
        ? (
            await this.prisma.conversa.findFirst({
              where: {
                contatoId: ctx.execucao.contatoId,
                status: { not: 'RESOLVIDA' },
              },
              orderBy: { ultimaMensagemEm: { sort: 'desc', nulls: 'last' } },
              select: { id: true },
            })
          )?.id
        : undefined);
    if (!conversaId) {
      return seguir({ saida: { pulado: 'sem_conversa_em_aberto' } });
    }
    if (ctx.execucao.teste) {
      return seguir({
        saida: { simulado: true, fluxo: fluxo.nome, conversaId },
      });
    }
    const { execucao, criada } = await this.passos.iniciar(
      {
        tipo: 'CHATBOT',
        nome: fluxo.nome,
        fluxoId: fluxo.id,
        fluxoVersaoId: fluxo.versaoPublicada.id,
        definicao: fluxo.versaoPublicada
          .definicao as unknown as DefinicaoDePassos,
        entidade: 'conversa',
        entidadeId: conversaId,
        conversaId,
        contatoId: ctx.execucao.contatoId,
        negocioId: ctx.execucao.negocioId,
        chaveUnica: `automacao-chatbot:${ctx.chaveIdempotencia}`,
        contexto: {
          origem: 'automacao',
          automacaoId: ctx.execucao.automacaoId,
        },
      },
      { executarAgora: true },
    );
    return seguir({
      saida: {
        fluxo: fluxo.nome,
        execucaoDoFluxoId: execucao.id,
        jaIniciado: !criada,
      },
    });
  }
}
