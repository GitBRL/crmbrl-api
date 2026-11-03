/**
 * Motor do SDR com IA (R31).
 *
 * **Quando a IA assume** (`aoCriarConversa`, na transação da entrada): conversa
 * nova num canal com o SDR ligado (automático ou sugestão), de contato sem
 * negócio aberto no Comercial ou no CS (nem negócio ganho no Comercial: cliente),
 * sem responsável humano e sem opt-out; com a chave da Anthropic configurada. No
 * automático a conversa espera na fila **sem responsável** (a IA atende); na
 * sugestão ela é distribuída normalmente e a IA só sugere. Se um fluxo de
 * chatbot atende o canal, a IA só responde enquanto não houver fluxo em
 * andamento na conversa (assume ao fim do fluxo) ou quando o fluxo a chama
 * (passo `acao.passar_para_ia`).
 *
 * **Cada mensagem do lead** vira um job (`sdr.turno`) com a espera de
 * agrupamento; o job junta as mensagens ainda não atendidas, pega a trava da
 * conversa (uma execução por vez), chama o Claude com saída estruturada e aplica
 * o resultado: resposta (enviada ou sugerida), critérios com origem IA e
 * confiança, nota, temperatura e a ação (continuar, qualificar, desqualificar,
 * passar para uma pessoa). Uma pessoa que escreve ou assume (no automático)
 * para a IA; "Devolver para a IA" a retoma.
 */
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { setTimeout as esperar } from 'node:timers/promises';
import {
  type GanchoDeConversaNova,
  GanchosDoAtendimento,
  type ConversaNova,
  type DecisaoDaConversaNova,
} from '../atendimento/ganchos-do-atendimento';
import { MotorDoAtendimento } from '../atendimento/motor-do-atendimento.service';
import { AuditoriaService } from '../auditoria/auditoria.service';
import {
  ChamadaClaudeService,
  FalhaDaChamada,
  type ObservadorDaChamada,
} from '../bi/analise/chamada-claude.service';
import { RegistroCanais } from '../canais/registro-canais';
import { executarComoAtor } from '../comum/contexto/contexto-requisicao';
import { AMBIENTE, type Ambiente } from '../config/ambiente';
import {
  type EventoPublicado,
  EventosDominioService,
} from '../eventos/eventos-dominio.service';
import { FilaService, type Trabalho } from '../fila/fila.service';
import type {
  Mensagem,
  ModoSdr,
  SdrConversa,
} from '../generated/prisma/client';
import { NotificacoesService } from '../notificacoes/notificacoes.service';
import { PrismaService, type Tx } from '../prisma/prisma.service';
import {
  type ConfiguracaoParaOMotor,
  ConfiguracaoSdrService,
} from './configuracao-sdr.service';
import { type ConversaDoSdr, EfeitosSdrService } from './efeitos-sdr.service';
import { conferirTurnoDoSdr, type TurnoDoSdr } from './esquema-sdr';
import { OPCOES_SDR, type OpcoesDoSdr } from './opcoes-sdr';
import {
  OrcamentoSdrService,
  totalDeTokens,
  type UsoDeTokensSdr,
} from './orcamento-sdr.service';
import {
  type ContextoDoTurno,
  type MensagemParaOModelo,
  mensagensDaConversa,
  montarPedidoDoSdr,
  RESPOSTA_DE_VAZAMENTO_DO_SDR,
  vazaInstrucoesDoSdr,
} from './prompt-sdr';
import { interpretarTurno, type ValorDescoberto } from './qualificacao';
import { QualificacaoSdrService } from './qualificacao-sdr.service';
import {
  ESPERA_DA_TRAVA_SEGUNDOS,
  ESPERA_ENTRE_TENTATIVAS_SEGUNDOS,
  FILA_TURNO_SDR,
  MAX_ADIAMENTOS_DO_TURNO,
  MENSAGENS_NO_HISTORICO,
  TENTATIVAS_DO_TURNO,
  TIPOS_NOTIFICACAO_SDR,
  TRAVA_DO_TURNO_MS,
} from './sdr.constantes';
import {
  ATOR_DO_SDR,
  MOTIVO_DO_AVISO,
  TransicoesSdrService,
} from './transicoes-sdr.service';

/** O job do turno. */
export interface PedidoDoTurno {
  conversaId: string;
  /** Quantas vezes o job já esperou mais mensagens ou a trava. */
  adiamentos?: number;
  /** Turno sem mensagem nova do lead (o fluxo ou a devolução chamou a IA). */
  iniciar?: boolean;
}

interface DadosDeMensagemRecebida {
  mensagemId: string;
  conversaId: string;
}

interface DadosDeMensagemDaEquipe {
  conversaId: string;
  usuarioId: string;
}

interface DadosDeAtribuicao {
  conversaId: string;
  responsavelId?: string | null;
  motivo?: string;
}

const OBSERVADOR_NULO: ObservadorDaChamada = {
  aoIniciarTentativa: () => undefined,
  aoMudarDeFase: () => undefined,
  aoReceberTexto: () => undefined,
};

const PLACEHOLDER_DE_MIDIA: Readonly<Record<string, string>> = {
  IMAGEM: '[o lead enviou uma imagem]',
  AUDIO: '[o lead enviou um áudio]',
  VIDEO: '[o lead enviou um vídeo]',
  DOCUMENTO: '[o lead enviou um documento]',
  LOCALIZACAO: '[o lead enviou uma localização]',
  CONTATO: '[o lead enviou um contato]',
  FIGURINHA: '[o lead enviou uma figurinha]',
};

type ConversaDoTurno = ConversaDoSdr & {
  canal: ConversaDoSdr['canal'] & { sdr: { modo: ModoSdr } | null };
};

interface ContextoDeExecucao {
  estado: SdrConversa;
  conversa: ConversaDoTurno;
  modo: 'AUTOMATICO' | 'SUGESTAO' | 'DESLIGADO';
}

interface BloqueioDoTurno {
  titulo: string;
  motivo: string;
  /** Envia a mensagem de passagem ao lead (só no modo automático). */
  mensagem: boolean;
}

@Injectable()
export class MotorSdr implements OnModuleInit, GanchoDeConversaNova {
  private readonly logger = new Logger('Sdr');

  constructor(
    private readonly prisma: PrismaService,
    private readonly ganchos: GanchosDoAtendimento,
    private readonly eventos: EventosDominioService,
    private readonly fila: FilaService,
    private readonly configuracao: ConfiguracaoSdrService,
    private readonly orcamento: OrcamentoSdrService,
    private readonly qualificacao: QualificacaoSdrService,
    private readonly efeitos: EfeitosSdrService,
    private readonly transicoes: TransicoesSdrService,
    private readonly chamada: ChamadaClaudeService,
    private readonly registro: RegistroCanais,
    private readonly notificacoes: NotificacoesService,
    private readonly auditoria: AuditoriaService,
    private readonly motorAtendimento: MotorDoAtendimento,
    @Inject(AMBIENTE) private readonly ambiente: Ambiente,
    @Inject(OPCOES_SDR) private readonly opcoes: OpcoesDoSdr,
  ) {}

  async onModuleInit(): Promise<void> {
    this.ganchos.registrarConversaNova(this);
    this.eventos.registrarManipulador<DadosDeMensagemRecebida>(
      'mensagem.recebida',
      (evento) => this.aoReceberMensagem(evento),
      'sdr:mensagem-recebida',
    );
    this.eventos.registrarManipulador<DadosDeMensagemDaEquipe>(
      'conversa.mensagem_da_equipe',
      (evento) => this.aoMensagemDaEquipe(evento),
      'sdr:mensagem-da-equipe',
    );
    this.eventos.registrarManipulador<DadosDeAtribuicao>(
      'conversa.atribuida',
      (evento) => this.aoAtribuir(evento),
      'sdr:conversa-atribuida',
    );
    this.eventos.registrarManipulador<DadosDeAtribuicao>(
      'conversa.transferida',
      (evento) => this.aoAtribuir(evento),
      'sdr:conversa-transferida',
    );
    this.eventos.registrarManipulador<DadosDeAtribuicao>(
      'conversa.resolvida',
      async (evento) => {
        await this.transicoes.encerrar(evento.dados.conversaId);
      },
      'sdr:conversa-resolvida',
    );
    await this.fila.trabalhar<PedidoDoTurno>(
      FILA_TURNO_SDR,
      (trabalho) => this.executarTurno(trabalho),
      {
        concorrencia: 4,
        intervaloDeConsultaSegundos: 1,
        tentativas: TENTATIVAS_DO_TURNO,
        intervaloEntreTentativasSegundos: ESPERA_ENTRE_TENTATIVAS_SEGUNDOS,
        esperaExponencial: true,
        prazoDeExecucaoSegundos: 300,
      },
    );
  }

  // -------------------------------------------------------------------------
  // Quando a IA assume
  // -------------------------------------------------------------------------

  /** Gancho da entrada: a conversa nova é da IA? (Roda na transação da entrada.) */
  async aoCriarConversa(
    tx: Tx,
    { conversa, canal, contato }: ConversaNova,
  ): Promise<DecisaoDaConversaNova> {
    const naoAssume = { manterSemResponsavel: false };
    const modo = (
      await tx.sdrCanal.findUnique({
        where: { canalId: canal.id },
        select: { modo: true },
      })
    )?.modo;
    if (!modo || modo === 'DESLIGADO' || !canal.ativo) {
      return naoAssume;
    }
    if (!this.ambiente.anthropic.configurada) {
      return naoAssume;
    }
    if (
      contato.optOutMarketing ||
      contato.excluidoEm ||
      contato.responsavelId
    ) {
      return naoAssume;
    }
    const comVendedor = await tx.negocio.findFirst({
      where: {
        contatoId: contato.id,
        excluidoEm: null,
        OR: [
          { status: 'ABERTO', funil: { area: { in: ['COMERCIAL', 'CS'] } } },
          { status: 'GANHO', funil: { area: 'COMERCIAL' } },
        ],
      },
      select: { id: true },
    });
    if (comVendedor) {
      return naoAssume;
    }
    await tx.sdrConversa.create({
      data: {
        conversaId: conversa.id,
        situacao: 'ATIVA',
        modo,
        origem: 'novo',
      },
    });
    await this.transicoes.registrarDecisao(tx, {
      conversaId: conversa.id,
      tipo: 'ASSUMIU',
      titulo:
        modo === 'AUTOMATICO'
          ? 'A IA assumiu o atendimento deste lead'
          : 'A IA vai sugerir as respostas deste lead',
      motivo: 'Conversa nova de um contato sem negócio no Comercial ou no CS.',
      modo,
      auditar: true,
    });
    return { manterSemResponsavel: modo === 'AUTOMATICO' };
  }

  /**
   * O fluxo do chatbot chama a IA (passo `acao.passar_para_ia`): ativa o SDR
   * na conversa, sem responder às mensagens que o fluxo já tratou.
   */
  async chamarPeloFluxo(
    conversaId: string,
  ): Promise<{ ativado: boolean; motivo: string | null }> {
    const conversa = await this.prisma.conversa.findUnique({
      where: { id: conversaId },
      include: { canal: { include: { sdr: true } }, contato: true },
    });
    if (!conversa || conversa.status === 'RESOLVIDA') {
      return { ativado: false, motivo: 'A conversa não está aberta.' };
    }
    const modo = conversa.canal.sdr?.modo ?? 'DESLIGADO';
    if (modo === 'DESLIGADO') {
      return {
        ativado: false,
        motivo: 'O SDR com IA está desligado neste canal.',
      };
    }
    if (!this.ambiente.anthropic.configurada) {
      return {
        ativado: false,
        motivo: 'A IA não está configurada neste servidor.',
      };
    }
    await executarComoAtor(ATOR_DO_SDR, () =>
      this.prisma.$transaction(async (tx) => {
        const atual = await this.transicoes.travarEstado(tx, conversaId);
        // O fluxo já tratou o que o lead escreveu até agora: a IA não responde a isso de novo.
        const ultima = await tx.mensagem.findFirst({
          where: { conversaId, direcao: 'ENTRADA', excluidaEm: null },
          orderBy: [{ criadoEm: 'desc' }, { id: 'desc' }],
          select: { criadoEm: true },
        });
        const dados = {
          situacao: 'ATIVA' as const,
          modo,
          origem: 'fluxo',
          mensagensSemAvanco: 0,
          processadoAte: ultima?.criadoEm ?? new Date(),
          situacaoDesde: new Date(),
          humanoId: null,
          execucaoDesde: null,
        };
        if (atual) {
          await tx.sdrConversa.update({ where: { id: atual.id }, data: dados });
        } else {
          await tx.sdrConversa.create({ data: { conversaId, ...dados } });
        }
        await this.transicoes.registrarDecisao(tx, {
          conversaId,
          tipo: 'ASSUMIU',
          titulo: 'O fluxo do chatbot passou a conversa para a IA',
          modo,
        });
        await this.transicoes.emitir(tx, conversaId, MOTIVO_DO_AVISO.ASSUMIU);
      }),
    );
    await this.enfileirar({ conversaId, iniciar: true }, 1);
    return { ativado: true, motivo: null };
  }

  // -------------------------------------------------------------------------
  // Eventos do Atendimento
  // -------------------------------------------------------------------------

  private async aoReceberMensagem(
    evento: EventoPublicado<DadosDeMensagemRecebida>,
  ): Promise<void> {
    const estado = await this.prisma.sdrConversa.findUnique({
      where: { conversaId: evento.dados.conversaId },
      select: { situacao: true },
    });
    if (estado?.situacao !== 'ATIVA') {
      return;
    }
    const config = await this.configuracao.garantir();
    await this.enfileirar(
      { conversaId: evento.dados.conversaId },
      config.esperaAgrupamentoSegundos,
    );
  }

  private async modoAtual(conversaId: string): Promise<{
    estado: SdrConversa;
    modo: ModoSdr;
  } | null> {
    const estado = await this.prisma.sdrConversa.findUnique({
      where: { conversaId },
    });
    if (!estado || estado.situacao !== 'ATIVA') {
      return null;
    }
    const conversa = await this.prisma.conversa.findUnique({
      where: { id: conversaId },
      select: { canal: { select: { sdr: { select: { modo: true } } } } },
    });
    return { estado, modo: conversa?.canal.sdr?.modo ?? 'DESLIGADO' };
  }

  /**
   * Uma pessoa da equipe escreveu ao contato. Automático: a IA para. Sugestão:
   * as sugestões pendentes perdem a vez (a pessoa respondeu por conta própria).
   */
  private async aoMensagemDaEquipe(
    evento: EventoPublicado<DadosDeMensagemDaEquipe>,
  ): Promise<void> {
    const { conversaId, usuarioId } = evento.dados;
    const atual = await this.modoAtual(conversaId);
    if (!atual) {
      return;
    }
    if (atual.modo === 'SUGESTAO') {
      await executarComoAtor(ATOR_DO_SDR, () =>
        this.prisma.$transaction(async (tx) => {
          if (
            (await this.transicoes.marcarSugestoesObsoletas(tx, conversaId)) > 0
          ) {
            await this.transicoes.emitir(
              tx,
              conversaId,
              MOTIVO_DO_AVISO.SUGESTAO_RESOLVIDA,
            );
          }
        }),
      );
      return;
    }
    const pessoa = await this.prisma.usuario.findUnique({
      where: { id: usuarioId },
      select: { id: true, nome: true },
    });
    await this.transicoes.humanoAssumiu(
      conversaId,
      pessoa,
      'Uma pessoa da equipe escreveu ao lead.',
    );
  }

  /** Atribuição ou transferência da conversa por alguém que não é a própria IA. */
  private async aoAtribuir(
    evento: EventoPublicado<DadosDeAtribuicao>,
  ): Promise<void> {
    if (evento.tipoAtor === 'IA') {
      return;
    }
    const { conversaId, motivo } = evento.dados;
    if (
      evento.tipo === 'conversa.atribuida' &&
      motivo !== 'ASSUMIDA' &&
      motivo !== 'MANUAL'
    ) {
      return;
    }
    const atual = await this.modoAtual(conversaId);
    if (!atual || atual.modo !== 'AUTOMATICO') {
      return;
    }
    if (evento.tipoAtor === 'USUARIO' && evento.usuarioId) {
      const pessoa = await this.prisma.usuario.findUnique({
        where: { id: evento.usuarioId },
        select: { id: true, nome: true },
      });
      await this.transicoes.humanoAssumiu(
        conversaId,
        pessoa,
        evento.tipo === 'conversa.transferida'
          ? 'Uma pessoa transferiu a conversa.'
          : 'Uma pessoa assumiu a conversa.',
      );
      return;
    }
    // Chatbot ou automação passou a conversa para a equipe.
    await executarComoAtor(ATOR_DO_SDR, () =>
      this.prisma.$transaction(async (tx) => {
        const estado = await this.transicoes.travarEstado(tx, conversaId);
        if (!estado || estado.situacao !== 'ATIVA') {
          return;
        }
        await tx.sdrConversa.update({
          where: { id: estado.id },
          data: {
            situacao: 'PASSADA_HUMANO',
            motivo: 'Um fluxo automático passou a conversa para a equipe.',
            situacaoDesde: new Date(),
            execucaoDesde: null,
          },
        });
        await this.transicoes.registrarDecisao(tx, {
          conversaId,
          tipo: 'PASSOU_HUMANO',
          titulo:
            'Um fluxo automático passou a conversa para a equipe: a IA parou',
          modo: estado.modo,
        });
        await this.transicoes.emitir(
          tx,
          conversaId,
          MOTIVO_DO_AVISO.PASSOU_HUMANO,
        );
      }),
    );
  }

  // -------------------------------------------------------------------------
  // O job do turno
  // -------------------------------------------------------------------------

  async enfileirar(
    pedido: PedidoDoTurno,
    atrasoSegundos: number,
  ): Promise<void> {
    await this.fila.enviar<PedidoDoTurno>(FILA_TURNO_SDR, pedido, {
      atrasoSegundos: Math.max(0, Math.ceil(atrasoSegundos)),
      tentativas: TENTATIVAS_DO_TURNO,
      intervaloEntreTentativasSegundos: ESPERA_ENTRE_TENTATIVAS_SEGUNDOS,
      esperaExponencial: true,
    });
  }

  /** O manipulador do job (público para os testes). */
  executarTurno(trabalho: Trabalho<PedidoDoTurno>): Promise<void> {
    return executarComoAtor(ATOR_DO_SDR, () =>
      this.turno(trabalho.dados, trabalho.tentativa > TENTATIVAS_DO_TURNO),
    );
  }

  private async carregar(
    conversaId: string,
  ): Promise<ContextoDeExecucao | null> {
    const estado = await this.prisma.sdrConversa.findUnique({
      where: { conversaId },
    });
    if (!estado || estado.situacao !== 'ATIVA') {
      return null;
    }
    const conversa = await this.prisma.conversa.findUnique({
      where: { id: conversaId },
      include: {
        canal: { include: { sdr: { select: { modo: true } } } },
        contato: true,
        fila: { select: { area: true } },
      },
    });
    if (!conversa) {
      return null;
    }
    return {
      estado,
      conversa,
      modo: conversa.canal.sdr?.modo ?? 'DESLIGADO',
    };
  }

  private mensagensNovas(
    conversaId: string,
    desde: Date | null,
  ): Promise<Mensagem[]> {
    return this.prisma.mensagem.findMany({
      where: {
        conversaId,
        direcao: 'ENTRADA',
        excluidaEm: null,
        tipo: { not: 'REACAO' },
        ...(desde ? { criadoEm: { gt: desde } } : {}),
      },
      orderBy: [{ criadoEm: 'asc' }, { id: 'asc' }],
    });
  }

  private async turno(
    pedido: PedidoDoTurno,
    ultimaTentativa: boolean,
  ): Promise<void> {
    const ctx = await this.carregar(pedido.conversaId);
    if (!ctx) {
      return;
    }
    const { estado, conversa } = ctx;
    if (conversa.status === 'RESOLVIDA') {
      await this.transicoes.encerrar(conversa.id);
      return;
    }
    if (ctx.modo === 'AUTOMATICO') {
      // Uma pessoa já escreveu ao lead desde que a IA assumiu (o evento dela pode estar na fila).
      const humano = await this.humanoEscreveuDesde(
        conversa.id,
        estado.situacaoDesde,
      );
      if (humano !== undefined) {
        await this.transicoes.humanoAssumiu(
          conversa.id,
          humano,
          'Uma pessoa da equipe escreveu ao lead.',
        );
        return;
      }
    }
    const adiamentos = pedido.adiamentos ?? 0;
    const novas = await this.mensagensNovas(conversa.id, estado.processadoAte);
    const ultimaDoLead = novas.at(-1) ?? null;
    if (await this.fluxoDeChatbotAtivo(conversa.id)) {
      // O fluxo tem a conversa: as mensagens dele não são da IA (ela assume ao fim do fluxo).
      if (ultimaDoLead) {
        await this.prisma.sdrConversa.update({
          where: { id: estado.id },
          data: { processadoAte: ultimaDoLead.criadoEm },
        });
      }
      return;
    }
    if (novas.length === 0 && !pedido.iniciar) {
      return;
    }
    const cfg = await this.configuracao.paraOMotor();
    // Agrupamento: o lead ainda está escrevendo? Espera a janela fechar.
    if (ultimaDoLead && adiamentos < MAX_ADIAMENTOS_DO_TURNO) {
      const janelaMs = cfg.config.esperaAgrupamentoSegundos * 1000;
      const idade = Date.now() - ultimaDoLead.criadoEm.getTime();
      if (idade < janelaMs) {
        await this.enfileirar(
          { ...pedido, adiamentos: adiamentos + 1 },
          (janelaMs - idade) / 1000 + 0.2,
        );
        return;
      }
    }
    if (!(await this.pegarTrava(estado.id))) {
      if (adiamentos < MAX_ADIAMENTOS_DO_TURNO) {
        await this.enfileirar(
          { ...pedido, adiamentos: adiamentos + 1 },
          ESPERA_DA_TRAVA_SEGUNDOS,
        );
      }
      return;
    }
    try {
      await this.rodarTurno(
        ctx,
        cfg,
        novas,
        pedido.iniciar === true,
        ultimaTentativa,
      );
    } finally {
      await this.soltarTrava(estado.id);
    }
    // Chegou mensagem do lead durante o turno: outro turno.
    const depois = await this.prisma.sdrConversa.findUnique({
      where: { id: estado.id },
      select: { situacao: true, processadoAte: true },
    });
    if (depois?.situacao === 'ATIVA') {
      const pendentes = await this.mensagensNovas(
        conversa.id,
        depois.processadoAte,
      );
      if (pendentes.length > 0) {
        await this.enfileirar(
          { conversaId: conversa.id },
          cfg.config.esperaAgrupamentoSegundos,
        );
      }
    }
  }

  /** Quem da equipe escreveu ao lead depois de `desde` (nulo = ninguém). */
  private async humanoEscreveuDesde(
    conversaId: string,
    desde: Date,
  ): Promise<{ id: string; nome: string } | null | undefined> {
    const mensagem = await this.prisma.mensagem.findFirst({
      where: {
        conversaId,
        direcao: 'SAIDA',
        autorTipo: 'USUARIO',
        criadoEm: { gte: desde },
      },
      select: { autor: { select: { id: true, nome: true } } },
    });
    return mensagem ? (mensagem.autor ?? null) : undefined;
  }

  private async fluxoDeChatbotAtivo(conversaId: string): Promise<boolean> {
    const ativos = await this.prisma.execucao.count({
      where: {
        tipo: 'CHATBOT',
        conversaId,
        teste: false,
        status: { in: ['EM_ANDAMENTO', 'AGUARDANDO'] },
      },
    });
    return ativos > 0;
  }

  /** Uma execução por conversa por vez: a trava vive no estado e vence em minutos. */
  private async pegarTrava(estadoId: string): Promise<boolean> {
    const vencida = new Date(Date.now() - TRAVA_DO_TURNO_MS);
    const r = await this.prisma.sdrConversa.updateMany({
      where: {
        id: estadoId,
        situacao: 'ATIVA',
        OR: [{ execucaoDesde: null }, { execucaoDesde: { lt: vencida } }],
      },
      data: { execucaoDesde: new Date() },
    });
    return r.count > 0;
  }

  private async soltarTrava(estadoId: string): Promise<void> {
    await this.prisma.sdrConversa.updateMany({
      where: { id: estadoId },
      data: { execucaoDesde: null },
    });
  }

  // -------------------------------------------------------------------------
  // Um turno
  // -------------------------------------------------------------------------

  private async bloqueioDoTurno(
    ctx: ContextoDeExecucao,
    cfg: ConfiguracaoParaOMotor,
  ): Promise<BloqueioDoTurno | null> {
    const { estado, conversa, modo } = ctx;
    const { config } = cfg;
    if (modo === 'DESLIGADO') {
      return {
        titulo: 'O SDR com IA foi desligado neste canal',
        motivo: 'O SDR com IA foi desligado neste canal.',
        mensagem: false,
      };
    }
    if (!this.ambiente.anthropic.configurada) {
      return {
        titulo: 'A IA não está configurada neste servidor',
        motivo: 'A chave da Anthropic não está configurada neste servidor.',
        mensagem: false,
      };
    }
    if (!conversa.canal.ativo || conversa.canal.excluidoEm) {
      return {
        titulo: 'O canal está desativado',
        motivo: 'O canal desta conversa está desativado.',
        mensagem: false,
      };
    }
    if (conversa.contato.excluidoEm || conversa.contato.optOutMarketing) {
      return {
        titulo: 'O contato pediu para não receber mensagens (opt-out)',
        motivo: 'O contato está com opt-out: a IA não envia mensagens.',
        mensagem: false,
      };
    }
    if (await this.orcamento.esgotado()) {
      return {
        titulo: 'Orçamento mensal de tokens esgotado',
        motivo: 'O orçamento mensal de tokens do SDR acabou.',
        mensagem: true,
      };
    }
    if (
      totalDeTokens({
        entrada: estado.tokensEntrada,
        saida: estado.tokensSaida,
        cacheLeitura: estado.tokensCacheLeitura,
        cacheEscrita: estado.tokensCacheEscrita,
      }) >= config.maxTokensPorConversa
    ) {
      return {
        titulo: 'Limite de tokens da conversa atingido',
        motivo: `A conversa chegou ao limite de ${config.maxTokensPorConversa.toLocaleString('pt-BR')} tokens.`,
        mensagem: true,
      };
    }
    if (estado.mensagensIa >= config.maxMensagensPorConversa) {
      return {
        titulo: 'Limite de mensagens da IA nesta conversa',
        motivo: `A IA já enviou ${estado.mensagensIa} mensagens (limite da conversa).`,
        mensagem: true,
      };
    }
    if (modo === 'AUTOMATICO') {
      const adaptador = this.registro.buscar(conversa.canal.tipo);
      const permissao = adaptador?.podeResponder?.(conversa, conversa.canal);
      if (permissao && !permissao.pode) {
        return {
          titulo: 'Fora da janela de resposta do canal (24 h)',
          motivo:
            permissao.motivo ??
            'O canal não aceita resposta agora (janela de 24 h fechada).',
          mensagem: false,
        };
      }
    }
    return null;
  }

  private async rodarTurno(
    ctx: ContextoDeExecucao,
    cfg: ConfiguracaoParaOMotor,
    novas: Mensagem[],
    iniciar: boolean,
    ultimaTentativa: boolean,
  ): Promise<void> {
    const { estado, conversa, modo } = ctx;
    const ultimaDoLead = novas.at(-1) ?? null;
    const processadoAte = ultimaDoLead?.criadoEm ?? estado.processadoAte;

    const bloqueio = await this.bloqueioDoTurno(ctx, cfg);
    if (bloqueio) {
      await this.passarParaHumanoSemIa(ctx, cfg, {
        bloqueio,
        processadoAte,
        tipo: 'BLOQUEIO',
      });
      return;
    }

    const adaptador = this.registro.buscar(conversa.canal.tipo);
    if (modo === 'AUTOMATICO') {
      void adaptador
        ?.digitar?.(conversa, conversa.canal, true, cfg.config.nomeAssistente)
        ?.catch(() => undefined);
    }

    const entrada = await this.montarEntrada(ctx, cfg, iniciar);
    let valor: TurnoDoSdr;
    let uso: UsoDeTokensSdr;
    let tentativas: number;
    try {
      const resultado = await this.chamada.executar(
        montarPedidoDoSdr(entrada.dados, entrada.mensagens),
        OBSERVADOR_NULO,
        conferirTurnoDoSdr,
        new AbortController().signal,
      );
      valor = resultado.valor;
      uso = resultado.uso;
      tentativas = resultado.tentativas;
    } catch (erro) {
      await this.pararDigitando(ctx, cfg);
      if (!(erro instanceof FalhaDaChamada)) {
        throw erro;
      }
      await this.tratarFalha(ctx, cfg, erro, processadoAte, ultimaTentativa);
      return;
    }

    try {
      if (modo === 'AUTOMATICO' && this.opcoes.simularDigitacao) {
        const pausa = Math.min(
          this.opcoes.digitandoMaximoMs,
          Math.max(
            this.opcoes.digitandoMinimoMs,
            valor.resposta.length * this.opcoes.digitandoPorCaractereMs,
          ),
        );
        await esperar(pausa);
      }
      await this.aplicarTurno({
        ctx,
        cfg,
        turno: valor,
        uso,
        tentativas,
        ultimaDoLead,
      });
    } finally {
      await this.pararDigitando(ctx, cfg);
    }
  }

  private async pararDigitando(
    ctx: ContextoDeExecucao,
    cfg: ConfiguracaoParaOMotor,
  ): Promise<void> {
    if (ctx.modo !== 'AUTOMATICO') {
      return;
    }
    const adaptador = this.registro.buscar(ctx.conversa.canal.tipo);
    await adaptador
      ?.digitar?.(
        ctx.conversa,
        ctx.conversa.canal,
        false,
        cfg.config.nomeAssistente,
      )
      ?.catch(() => undefined);
  }

  /** O histórico, os dados do contato e a qualificação parcial (só deste contato). */
  private async montarEntrada(
    ctx: ContextoDeExecucao,
    cfg: ConfiguracaoParaOMotor,
    iniciar: boolean,
  ) {
    const { estado, conversa } = ctx;
    const mensagens = await this.prisma.mensagem.findMany({
      where: {
        conversaId: conversa.id,
        direcao: { in: ['ENTRADA', 'SAIDA'] },
        excluidaEm: null,
        tipo: { not: 'REACAO' },
        OR: [{ status: null }, { status: { not: 'FALHOU' } }],
      },
      orderBy: [{ criadoEm: 'desc' }, { id: 'desc' }],
      take: MENSAGENS_NO_HISTORICO,
      select: { direcao: true, tipo: true, texto: true, autorTipo: true },
    });
    mensagens.reverse();
    const historico: MensagemParaOModelo[] = mensagens.map((m) => ({
      papel: m.direcao === 'ENTRADA' ? 'lead' : 'equipe',
      texto: m.texto?.trim() || PLACEHOLDER_DE_MIDIA[m.tipo] || '',
    }));
    const ultimoLead = historico.map((m) => m.papel).lastIndexOf('lead');
    const depoisDoLead = historico
      .slice(ultimoLead + 1)
      .map((m) => m.texto)
      .filter(Boolean);
    const valores = await this.valoresDoEstado(estado.id);
    const contexto: ContextoDoTurno = {
      canal: conversa.canal.tipo,
      nome: conversa.contato.nome.trim().split(/\s+/)[0] || null,
      primeiraRespostaDaIa: estado.mensagensIa === 0,
      mensagensDaIa: estado.mensagensIa,
      origem: estado.origem,
      valores,
      nota: estado.nota,
      temperatura: estado.temperatura,
      depoisDoLead,
    };
    return {
      dados: {
        config: cfg.config,
        regras: cfg.regras,
        criterios: cfg.criterios,
        artigos: cfg.artigos,
        contexto,
      },
      mensagens: mensagensDaConversa(
        historico,
        iniciar
          ? '<mensagem_do_lead>\n[a conversa acabou de ser passada para você: apresente-se e continue a partir do que já foi dito]\n</mensagem_do_lead>'
          : undefined,
      ),
    };
  }

  private async valoresDoEstado(
    estadoId: string,
  ): Promise<Map<string, ValorDescoberto>> {
    return this.prisma.$transaction((tx) =>
      this.qualificacao.valoresDoEstado(tx, estadoId),
    );
  }

  // -------------------------------------------------------------------------
  // Falhas e bloqueios
  // -------------------------------------------------------------------------

  private async tratarFalha(
    ctx: ContextoDeExecucao,
    cfg: ConfiguracaoParaOMotor,
    erro: FalhaDaChamada,
    processadoAte: Date | null,
    ultimaTentativa: boolean,
  ): Promise<void> {
    const uso: UsoDeTokensSdr = erro.uso;
    const transitoria = [
      'tempo_esgotado',
      'indisponivel',
      'resposta_invalida',
      'resposta_incompleta',
      'erro',
    ].includes(erro.codigo);
    this.logger.warn(
      `Turno do SDR na conversa ${ctx.conversa.id} falhou: ${erro.codigo} (${erro.tentativas} tentativa(s))`,
    );
    if (transitoria && !ultimaTentativa) {
      await this.prisma.$transaction(async (tx) => {
        await this.transicoes.registrarDecisao(tx, {
          conversaId: ctx.conversa.id,
          tipo: 'FALHA',
          titulo:
            'A IA não conseguiu responder agora: nova tentativa em instantes',
          motivo: erro.message,
          modo: ctx.modo === 'DESLIGADO' ? null : ctx.modo,
          modelo: cfg.config.modelo,
          uso,
          tentativas: erro.tentativas,
          auditar: false,
        });
        await this.orcamento.avisarSeNecessario(tx);
      });
      // O pg-boss tenta o job de novo (com espera crescente).
      throw erro;
    }
    const chaveRecusada = erro.codigo === 'chave_recusada';
    await this.passarParaHumanoSemIa(ctx, cfg, {
      bloqueio: {
        titulo: chaveRecusada
          ? 'A chave da Anthropic foi recusada: a IA não consegue responder'
          : transitoria
            ? 'A IA ficou indisponível: passou para a equipe'
            : 'A IA recusou responder: passou para a equipe',
        motivo: erro.message,
        mensagem: true,
      },
      processadoAte,
      tipo: 'FALHA',
      uso,
      tentativas: erro.tentativas,
      avisarAdmin: chaveRecusada,
    });
  }

  /**
   * Passa para uma pessoa sem uma resposta da IA (bloqueio ou falha): no
   * automático, com a mensagem de passagem da configuração (se `mensagem`).
   */
  private async passarParaHumanoSemIa(
    ctx: ContextoDeExecucao,
    cfg: ConfiguracaoParaOMotor,
    p: {
      bloqueio: BloqueioDoTurno;
      processadoAte: Date | null;
      tipo: 'BLOQUEIO' | 'FALHA';
      uso?: UsoDeTokensSdr;
      tentativas?: number;
      avisarAdmin?: boolean;
    },
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const estado = await this.transicoes.travarEstado(tx, ctx.conversa.id);
      if (!estado || estado.situacao !== 'ATIVA') {
        return;
      }
      const conversa = await this.conversaDoTurno(tx, ctx.conversa.id);
      if (!conversa) {
        return;
      }
      const uso = p.uso ?? {
        entrada: 0,
        saida: 0,
        cacheLeitura: 0,
        cacheEscrita: 0,
      };
      let enviou = false;
      if (
        ctx.modo === 'AUTOMATICO' &&
        p.bloqueio.mensagem &&
        conversa.status !== 'RESOLVIDA'
      ) {
        await this.efeitos.enviarComoIa(
          tx,
          conversa,
          cfg.config.mensagemPassagem,
          {
            sdrDecisao: p.tipo.toLowerCase(),
          },
        );
        enviou = true;
      }
      await tx.sdrConversa.update({
        where: { id: estado.id },
        data: {
          processadoAte: p.processadoAte ?? undefined,
          mensagensIa: { increment: enviou ? 1 : 0 },
          ...usoNoEstado(uso),
        },
      });
      const atualizado = await tx.sdrConversa.findUniqueOrThrow({
        where: { id: estado.id },
      });
      await this.efeitos.passarParaHumano(
        tx,
        atualizado,
        conversa,
        {
          motivo: p.bloqueio.motivo,
          resumo: estado.resumo ?? '',
          nota: estado.nota,
          temperatura: estado.temperatura,
        },
        p.tipo,
        p.bloqueio.titulo,
      );
      if (totalDeTokens(uso) > 0) {
        await this.transicoes.registrarDecisao(tx, {
          conversaId: conversa.id,
          tipo: 'FALHA',
          titulo: 'Tokens gastos em tentativas que não deram resposta',
          modo: estado.modo,
          modelo: cfg.config.modelo,
          uso,
          tentativas: p.tentativas,
          auditar: false,
        });
      }
      if (p.avisarAdmin) {
        await this.notificacoes.notificarAdmins(tx, {
          tipo: TIPOS_NOTIFICACAO_SDR.FALHA,
          titulo: 'O SDR com IA não consegue responder',
          texto:
            'A Anthropic recusou a chave configurada no servidor (ANTHROPIC_API_KEY). As conversas estão sendo passadas para a equipe.',
          link: '/configuracoes/sdr',
        });
      }
      await this.orcamento.avisarSeNecessario(tx);
    });
  }

  private conversaDoTurno(
    tx: Tx,
    conversaId: string,
  ): Promise<ConversaDoTurno | null> {
    return tx.conversa.findUnique({
      where: { id: conversaId },
      include: {
        canal: { include: { sdr: { select: { modo: true } } } },
        contato: true,
        fila: { select: { area: true } },
      },
    });
  }

  // -------------------------------------------------------------------------
  // Aplicar o resultado
  // -------------------------------------------------------------------------

  private async aplicarTurno(a: {
    ctx: ContextoDeExecucao;
    cfg: ConfiguracaoParaOMotor;
    turno: TurnoDoSdr;
    uso: UsoDeTokensSdr;
    tentativas: number;
    ultimaDoLead: Mensagem | null;
  }): Promise<void> {
    const { ctx, cfg, turno, uso, tentativas, ultimaDoLead } = a;
    const { config, regras } = cfg;
    await this.prisma.$transaction(async (tx) => {
      const estado = await this.transicoes.travarEstado(tx, ctx.conversa.id);
      const conversa = await this.conversaDoTurno(tx, ctx.conversa.id);
      const descartar = async (
        titulo: string,
        motivo: string,
      ): Promise<void> => {
        // O turno perdeu a vez, mas os tokens foram gastos: contam no registro.
        await this.transicoes.registrarDecisao(tx, {
          conversaId: ctx.conversa.id,
          tipo: 'BLOQUEIO',
          titulo,
          motivo,
          resposta: turno.resposta,
          modo: ctx.modo === 'DESLIGADO' ? null : ctx.modo,
          modelo: config.modelo,
          baseVersao: config.baseVersao,
          uso,
          tentativas,
          auditar: true,
        });
        if (estado) {
          await tx.sdrConversa.update({
            where: { id: estado.id },
            data: usoNoEstado(uso),
          });
        }
        await this.orcamento.avisarSeNecessario(tx);
      };
      if (!estado || !conversa || estado.situacao !== 'ATIVA') {
        await descartar(
          'Resposta da IA descartada: a conversa mudou enquanto ela respondia',
          'A situação do SDR na conversa mudou durante o turno.',
        );
        return;
      }
      if (conversa.status === 'RESOLVIDA') {
        await descartar(
          'Resposta da IA descartada: a conversa foi resolvida',
          'A conversa foi resolvida durante o turno.',
        );
        return;
      }
      const modo = conversa.canal.sdr?.modo ?? 'DESLIGADO';
      if (modo === 'AUTOMATICO') {
        const humano = await tx.mensagem.findFirst({
          where: {
            conversaId: conversa.id,
            direcao: 'SAIDA',
            autorTipo: 'USUARIO',
            criadoEm: { gte: estado.situacaoDesde },
          },
          select: { autorId: true },
        });
        if (humano) {
          await descartar(
            'Resposta da IA descartada: uma pessoa respondeu primeiro',
            'Uma pessoa da equipe escreveu ao lead enquanto a IA respondia.',
          );
          const pessoa = humano.autorId
            ? await tx.usuario.findUnique({
                where: { id: humano.autorId },
                select: { id: true, nome: true },
              })
            : null;
          await tx.sdrConversa.update({
            where: { id: estado.id },
            data: {
              situacao: 'HUMANO',
              humanoId: pessoa?.id ?? null,
              motivo: 'Uma pessoa da equipe escreveu ao lead.',
              situacaoDesde: new Date(),
            },
          });
          await this.transicoes.emitir(
            tx,
            conversa.id,
            MOTIVO_DO_AVISO.HUMANO_ASSUMIU,
          );
          return;
        }
      }
      const automatico = modo === 'AUTOMATICO';

      // Critérios, nota e temperatura.
      const anteriores = await this.qualificacao.valoresDoEstado(tx, estado.id);
      const interp = interpretarTurno({
        criterios: cfg.criterios,
        anteriores,
        daIa: turno.criterios,
        acao: turno.acao,
        parametros: {
          notaMinima: config.notaMinimaQualificado,
          faixas: { quente: config.faixaQuente, morno: config.faixaMorno },
          confiancaMinima: regras.confiancaMinima,
        },
      });
      await this.qualificacao.gravarValores(
        tx,
        estado,
        interp.aceitos,
        cfg.criterios,
        ultimaDoLead?.id ?? null,
      );
      const { nota, temperatura } = interp.avaliacao;

      // A ação efetiva e o que a IA diz.
      let acao = interp.acao;
      let motivo = turno.motivo || 'Sem motivo informado.';
      if (interp.motivoDaTroca) {
        motivo = `${motivo} (Não qualificou: ${interp.motivoDaTroca})`.trim();
      }
      let resposta = turno.resposta.trim();
      let usarPassagem = false;
      const semAvancoNovo =
        acao === 'CONTINUAR' && interp.semAvanco
          ? estado.mensagensSemAvanco + 1
          : 0;
      if (acao === 'CONTINUAR') {
        if (regras.semAvanco && semAvancoNovo >= config.maxMensagensSemAvanco) {
          acao = 'PASSAR_HUMANO';
          motivo = `Limite de ${config.maxMensagensSemAvanco} mensagens sem avanço na qualificação.`;
          usarPassagem = true;
        } else if (estado.mensagensIa + 1 >= config.maxMensagensPorConversa) {
          acao = 'PASSAR_HUMANO';
          motivo = `Limite de ${config.maxMensagensPorConversa} mensagens da IA nesta conversa.`;
          usarPassagem = true;
        }
      }
      if (!resposta || (acao === 'PASSAR_HUMANO' && usarPassagem)) {
        resposta = config.mensagemPassagem;
      }
      let vazou = false;
      if (vazaInstrucoesDoSdr(resposta)) {
        vazou = true;
        resposta = RESPOSTA_DE_VAZAMENTO_DO_SDR;
      }
      const resumo = turno.resumo || estado.resumo || '';

      // Estado: nota, temperatura, resumo, tokens, contadores.
      await tx.sdrConversa.update({
        where: { id: estado.id },
        data: {
          nota,
          temperatura,
          modo: automatico ? 'AUTOMATICO' : 'SUGESTAO',
          resumo: resumo || null,
          motivo,
          mensagensSemAvanco: semAvancoNovo,
          processadoAte: ultimaDoLead?.criadoEm ?? estado.processadoAte,
          ...usoNoEstado(uso),
        },
      });
      const criteriosDaDecisao = turno.criterios.map((c) => ({
        chave: c.chave,
        valor: c.valor,
        confianca: c.confianca,
        aceito: interp.aceitos.some((x) => x.chave === c.chave),
      }));
      const descobertos = interp.aceitos
        .map(
          (v) =>
            cfg.criterios.find((c) => c.chave === v.chave)?.rotulo ?? v.chave,
        )
        .join(', ');
      const titulo = this.tituloDoTurno(automatico, acao, descobertos, nota);
      const decisaoId = await this.transicoes.registrarDecisao(tx, {
        conversaId: conversa.id,
        tipo: 'TURNO',
        acao,
        titulo,
        motivo,
        resumo: resumo || null,
        resposta,
        criterios: criteriosDaDecisao,
        nota,
        temperatura,
        modo,
        modelo: config.modelo,
        baseVersao: config.baseVersao,
        mensagemId: ultimaDoLead?.id ?? null,
        uso,
        tentativas,
      });
      if (vazou) {
        await this.transicoes.registrarDecisao(tx, {
          conversaId: conversa.id,
          tipo: 'BLOQUEIO',
          titulo:
            'A resposta da IA repetia as instruções internas e foi trocada',
          motivo: 'Proteção contra vazamento do prompt de sistema.',
          modo,
          auditar: true,
        });
      }
      const atualizado = await tx.sdrConversa.findUniqueOrThrow({
        where: { id: estado.id },
      });

      if (!automatico) {
        // Sugestão: a IA só propõe. Os campos e a ação esperam a aprovação.
        await this.transicoes.marcarSugestoesObsoletas(tx, conversa.id);
        await tx.sdrSugestao.create({
          data: {
            conversaId: conversa.id,
            decisaoId,
            texto: resposta,
            acao,
            motivo,
            resumo: resumo || null,
            criterios: criteriosDaDecisao,
          },
        });
        await this.orcamento.avisarSeNecessario(tx);
        await this.transicoes.emitir(tx, conversa.id, MOTIVO_DO_AVISO.SUGESTAO);
        return;
      }

      // Automático: escreve nos campos, responde e aplica a ação.
      await this.qualificacao.escreverNosCampos(
        tx,
        atualizado,
        conversa.contatoId,
        conversa.negocioId ? [conversa.negocioId] : [],
        cfg.criterios,
        regras.confiancaMinima,
      );
      await this.efeitos.enviarComoIa(tx, conversa, resposta, { decisaoId });
      await tx.sdrConversa.update({
        where: { id: estado.id },
        data: {
          mensagensIa: { increment: 1 },
          ...(estado.primeiraRespostaEm
            ? {}
            : { primeiraRespostaEm: new Date() }),
        },
      });
      const comMensagem = await tx.sdrConversa.findUniqueOrThrow({
        where: { id: estado.id },
      });
      const dados = { motivo, resumo, nota, temperatura };
      if (acao === 'QUALIFICADO') {
        await this.efeitos.qualificar(tx, comMensagem, conversa, cfg, dados);
      } else if (acao === 'DESQUALIFICADO') {
        await this.efeitos.desqualificar(tx, comMensagem, conversa, dados);
      } else if (acao === 'PASSAR_HUMANO') {
        await this.efeitos.passarParaHumano(tx, comMensagem, conversa, dados);
      } else {
        await this.transicoes.emitir(tx, conversa.id, MOTIVO_DO_AVISO.TURNO);
      }
      await this.orcamento.avisarSeNecessario(tx);
    });
  }

  private tituloDoTurno(
    automatico: boolean,
    acao: string,
    descobertos: string,
    nota: number,
  ): string {
    const verbo = automatico ? 'Respondeu' : 'Sugeriu uma resposta';
    const partes = [verbo];
    if (descobertos) {
      partes.push(`descobriu: ${descobertos}`);
    }
    partes.push(`nota ${nota}`);
    if (acao !== 'CONTINUAR') {
      partes.push(
        acao === 'QUALIFICADO'
          ? 'qualificado'
          : acao === 'DESQUALIFICADO'
            ? 'desqualificado'
            : 'passar para a equipe',
      );
    }
    return partes.join(' · ');
  }
}

function usoNoEstado(uso: UsoDeTokensSdr) {
  return {
    tokensEntrada: { increment: uso.entrada },
    tokensSaida: { increment: uso.saida },
    tokensCacheLeitura: { increment: uso.cacheLeitura },
    tokensCacheEscrita: { increment: uso.cacheEscrita },
  };
}
