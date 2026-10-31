import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { lerHorario, situacaoDoHorario } from '../atendimento/horario';
import {
  type GatilhoDisparado,
  GatilhosService,
} from '../comum/gatilhos/gatilhos.service';
import { PassosService } from '../comum/passos/passos.service';
import type { DefinicaoDePassos } from '../comum/passos/definicao';
import { PrismaService } from '../prisma/prisma.service';
import {
  DESTINO_DE_GATILHO_CHATBOT,
  EVENTOS_ACOMPANHADOS_PELO_CHATBOT,
  MOTIVOS_DE_FIM,
} from './chatbot.constantes';
import { VARIAVEL_DA_ULTIMA_ENTRADA } from './passos-do-chatbot.service';
import { escolherFluxo } from './seletor-de-fluxo';

interface DadosDeMensagemRecebida {
  mensagemId: string;
  conversaId: string;
  canalId: string;
  contatoId: string;
  conversaNova?: boolean;
}

/**
 * Entrada do chatbot (R18): recebe os eventos do Atendimento pela outbox
 * (`GatilhosService`) e
 *
 * - `mensagem.recebida`: se há fluxo esperando resposta nesta conversa, entrega
 *   a mensagem; senão escolhe o fluxo ativo (gatilho, canal, palavra-chave,
 *   prioridade) e inicia uma execução da **versão publicada**, uma por conversa.
 *   Com atendente já envolvido na conversa, o bot não entra;
 * - atendente assumiu (atribuição `ASSUMIDA`/`MANUAL`), transferiu, respondeu
 *   (`mensagem.enviada` de usuário) ou resolveu a conversa: cancela o fluxo.
 *   Eventos que o próprio bot gerou (cadeia de automação) não contam.
 */
@Injectable()
export class EntradaDoBot implements OnModuleInit {
  private readonly logger = new Logger(EntradaDoBot.name);

  constructor(
    private readonly gatilhos: GatilhosService,
    private readonly prisma: PrismaService,
    private readonly passos: PassosService,
  ) {}

  onModuleInit(): void {
    this.gatilhos.registrarDestino({
      nome: DESTINO_DE_GATILHO_CHATBOT,
      eventos: EVENTOS_ACOMPANHADOS_PELO_CHATBOT,
      ignorarLimiteDeEncadeamento: true,
      aoDisparar: (gatilho) => this.aoEvento(gatilho),
    });
  }

  async aoEvento(g: GatilhoDisparado): Promise<void> {
    if (g.cadeia) {
      // Evento causado por uma automação ou pelo próprio bot: não é o atendente.
      return;
    }
    const dados = g.evento.dados as Record<string, unknown>;
    switch (g.tipo) {
      case 'mensagem.recebida':
        await this.aoReceberMensagem(
          g,
          dados as unknown as DadosDeMensagemRecebida,
        );
        return;
      case 'mensagem.enviada': {
        const mensagem = await this.prisma.mensagem.findUnique({
          where: { id: String(dados.mensagemId) },
          select: { autorTipo: true, conversaId: true },
        });
        if (mensagem?.autorTipo === 'USUARIO') {
          await this.cancelar(
            mensagem.conversaId,
            MOTIVOS_DE_FIM.ATENDENTE_ASSUMIU,
          );
        }
        return;
      }
      case 'conversa.atribuida':
        if (dados.motivo === 'ASSUMIDA' || dados.motivo === 'MANUAL') {
          await this.cancelar(
            String(dados.conversaId),
            MOTIVOS_DE_FIM.ATENDENTE_ASSUMIU,
          );
        }
        return;
      case 'conversa.transferida':
        await this.cancelar(
          String(dados.conversaId),
          MOTIVOS_DE_FIM.CONVERSA_TRANSFERIDA,
        );
        return;
      case 'conversa.resolvida':
        await this.cancelar(
          String(dados.conversaId),
          MOTIVOS_DE_FIM.CONVERSA_RESOLVIDA,
        );
        return;
      default:
        return;
    }
  }

  private async cancelar(conversaId: string, motivo: string): Promise<void> {
    await this.passos.cancelarAtivas({ conversaId, tipo: 'CHATBOT' }, motivo);
  }

  private async aoReceberMensagem(
    g: GatilhoDisparado,
    d: DadosDeMensagemRecebida,
  ): Promise<void> {
    const mensagem = await this.prisma.mensagem.findUnique({
      where: { id: d.mensagemId },
      select: { id: true, texto: true, arquivoId: true },
    });
    if (!mensagem) {
      return;
    }
    const ativa = await this.prisma.execucao.findFirst({
      where: {
        tipo: 'CHATBOT',
        conversaId: d.conversaId,
        teste: false,
        status: { in: ['EM_ANDAMENTO', 'AGUARDANDO'] },
      },
      orderBy: { criadoEm: 'desc' },
    });
    if (ativa) {
      // Atendente já respondeu/assumiu (o evento dele pode ainda estar na fila): o bot sai.
      if (await this.atendenteAtuou(d.conversaId)) {
        await this.cancelar(d.conversaId, MOTIVOS_DE_FIM.ATENDENTE_ASSUMIU);
        return;
      }
      if (ativa.status === 'EM_ANDAMENTO') {
        // O bot está no meio de um passo: a outbox entrega de novo daqui a pouco.
        throw new Error('O chatbot está respondendo; tentando de novo.');
      }
      const variaveis = ativa.variaveis as Record<string, unknown>;
      if (variaveis[VARIAVEL_DA_ULTIMA_ENTRADA] === mensagem.id) {
        return;
      }
      if (ativa.aguardandoEntrada) {
        await this.passos.retomarComEntrada(ativa.id, {
          texto: mensagem.texto,
          mensagemId: mensagem.id,
          arquivoId: mensagem.arquivoId,
        });
      }
      return;
    }
    await this.iniciarFluxo(g, d, mensagem.texto);
  }

  private async iniciarFluxo(
    g: GatilhoDisparado,
    d: DadosDeMensagemRecebida,
    texto: string | null,
  ): Promise<void> {
    const conversa = await this.prisma.conversa.findUnique({
      where: { id: d.conversaId },
      include: { canal: true },
    });
    if (!conversa || conversa.status === 'RESOLVIDA') {
      return;
    }
    if (await this.atendenteAtuou(d.conversaId)) {
      return;
    }
    const candidatos = await this.prisma.fluxoChatbot.findMany({
      where: {
        ativo: true,
        excluidoEm: null,
        versaoPublicadaId: { not: null },
      },
      include: { versaoPublicada: true },
    });
    if (candidatos.length === 0) {
      return;
    }
    const anteriores = await this.prisma.execucao.count({
      where: { tipo: 'CHATBOT', conversaId: d.conversaId, teste: false },
    });
    const horario = lerHorario(conversa.canal.horarioAtendimento);
    const fluxo = escolherFluxo(candidatos, {
      canalId: conversa.canalId,
      texto,
      conversaNova: d.conversaNova === true,
      semExecucaoAnterior: anteriores === 0,
      foraDoHorario: !situacaoDoHorario(horario).aberto,
    });
    const versao = fluxo?.versaoPublicada;
    if (!fluxo || !versao) {
      return;
    }
    const { criada } = await this.passos.iniciar(
      {
        tipo: 'CHATBOT',
        nome: fluxo.nome,
        fluxoId: fluxo.id,
        fluxoVersaoId: versao.id,
        definicao: versao.definicao as unknown as DefinicaoDePassos,
        entidade: 'conversa',
        entidadeId: conversa.id,
        conversaId: conversa.id,
        contatoId: conversa.contatoId,
        eventoId: g.evento.id,
        chaveUnica: `chatbot:${conversa.id}:${d.mensagemId}`,
        cadeiaDeOrigem: g.cadeia,
        contexto: {
          gatilho: fluxo.gatilho,
          mensagemId: d.mensagemId,
          canalTipo: conversa.canal.tipo,
          versao: versao.numero,
        },
        variaveis: {
          canal: conversa.canal.tipo,
          primeira_mensagem: texto ?? '',
        },
      },
      { executarAgora: true },
    );
    if (criada) {
      this.logger.debug?.(
        `Fluxo "${fluxo.nome}" v${versao.numero} iniciado na conversa ${conversa.id}.`,
      );
    }
  }

  /** Um atendente já escreveu, assumiu ou transferiu a conversa? Então o bot não entra. */
  private async atendenteAtuou(conversaId: string): Promise<boolean> {
    const [mensagem, atribuicao] = await Promise.all([
      this.prisma.mensagem.findFirst({
        where: { conversaId, direcao: 'SAIDA', autorTipo: 'USUARIO' },
        select: { id: true },
      }),
      this.prisma.conversaAtribuicao.findFirst({
        where: {
          conversaId,
          tipoAtor: 'USUARIO',
          motivo: { in: ['ASSUMIDA', 'MANUAL', 'TRANSFERENCIA'] },
        },
        select: { id: true },
      }),
    ]);
    return mensagem !== null || atribuicao !== null;
  }
}
