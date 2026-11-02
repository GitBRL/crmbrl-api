import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { AuditoriaService } from '../auditoria/auditoria.service';
import { MotorDoAtendimento } from '../atendimento/motor-do-atendimento.service';
import { executarComoAtor } from '../comum/contexto/contexto-requisicao';
import { EVENTOS_DA_ONDA_B } from '../comum/gatilhos/catalogo';
import {
  type GatilhoDisparado,
  GatilhosService,
} from '../comum/gatilhos/gatilhos.service';
import { instantaneoDoContato } from '../contatos/instantaneos';
import { EventosDominioService } from '../eventos/eventos-dominio.service';
import { PrismaService } from '../prisma/prisma.service';
import { ConfiguracaoDisparosService } from './configuracao-disparos.service';
import {
  JANELA_DE_RESPOSTA_DIAS,
  JANELA_DE_SAIDA_DIAS,
  REGRA_DISPAROS,
} from './disparos.constantes';
import { ProgressoDaCampanha } from './progresso-da-campanha.service';
import { ehPalavraDeSaida } from './ritmo';

const UM_DIA_MS = 24 * 3_600_000;

/**
 * Respostas às campanhas (R17), pelo evento `mensagem.recebida` (gatilhos):
 *
 * - **Resposta**: a mensagem do contato dentro de 7 dias do envio marca o
 *   destinatário como "respondeu" (uma vez) e publica `campanha.respondida`. A
 *   mensagem já está no Atendimento (a conversa do contato), como qualquer outra.
 * - **Palavra de saída** (`SAIR`, `PARAR`, `CANCELAR`, configuráveis; a mensagem
 *   inteira, sem acento nem caixa), dentro de 30 dias do envio: aplica o opt-out
 *   do contato (R4.6) — auditado como `AUTOMACAO` —, tira dele os envios
 *   pendentes de qualquer campanha e responde a confirmação na conversa.
 */
@Injectable()
export class RespostasDeCampanha implements OnModuleInit {
  private readonly logger = new Logger(RespostasDeCampanha.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gatilhos: GatilhosService,
    private readonly configuracao: ConfiguracaoDisparosService,
    private readonly motor: MotorDoAtendimento,
    private readonly eventos: EventosDominioService,
    private readonly auditoria: AuditoriaService,
    private readonly progresso: ProgressoDaCampanha,
  ) {}

  onModuleInit(): void {
    this.gatilhos.registrarDestino({
      nome: 'disparos',
      eventos: ['mensagem.recebida'],
      ignorarLimiteDeEncadeamento: true,
      aoDisparar: (gatilho) => this.aoReceber(gatilho),
    });
  }

  aoReceber(gatilho: GatilhoDisparado): Promise<void> {
    const mensagemId =
      gatilho.ids.mensagemId ??
      (typeof gatilho.evento.dados.mensagemId === 'string'
        ? gatilho.evento.dados.mensagemId
        : null);
    return mensagemId ? this.tratar(mensagemId) : Promise.resolve();
  }

  /** Trata uma mensagem recebida (idempotente). */
  async tratar(mensagemId: string): Promise<void> {
    const mensagem = await this.prisma.mensagem.findUnique({
      where: { id: mensagemId },
      include: { canal: true, conversa: true },
    });
    if (!mensagem || mensagem.direcao !== 'ENTRADA' || mensagem.excluidaEm) {
      return;
    }
    if (mensagem.canal.tipo !== 'WHATSAPP' && mensagem.canal.tipo !== 'EMAIL') {
      return;
    }
    const contatoId = mensagem.conversa.contatoId;
    const desde = new Date(
      mensagem.ocorridaEm.getTime() - JANELA_DE_SAIDA_DIAS * UM_DIA_MS,
    );
    const recentes = await this.prisma.campanhaDestinatario.findMany({
      where: {
        contatoId,
        // ENVIANDO também: a resposta pode chegar antes de a sincronização marcar ENVIADO.
        status: { in: ['ENVIANDO', 'ENVIADO'] },
        mensagem: {
          is: { ocorridaEm: { gte: desde, lte: mensagem.ocorridaEm } },
        },
        campanha: { canal: mensagem.canal.tipo, excluidoEm: null },
      },
      orderBy: { mensagem: { ocorridaEm: 'desc' } },
      include: { campanha: true, mensagem: { select: { ocorridaEm: true } } },
    });
    const ultimo = recentes[0];
    if (!ultimo) {
      return;
    }
    const configuracao = await this.configuracao.obter();
    await executarComoAtor(
      { tipoAtor: 'AUTOMACAO', descricao: ultimo.campanha.nome },
      async () => {
        if (ehPalavraDeSaida(mensagem.texto, configuracao.palavrasDeSaida)) {
          await this.aplicarSaida(mensagem.id, configuracao.mensagemDeSaida);
          return;
        }
        const limite =
          mensagem.ocorridaEm.getTime() - JANELA_DE_RESPOSTA_DIAS * UM_DIA_MS;
        const alvo = recentes.find(
          (d) =>
            d.respondeuEm === null &&
            (d.mensagem?.ocorridaEm.getTime() ?? 0) >= limite,
        );
        if (alvo) {
          await this.registrarResposta(
            alvo.id,
            mensagem.id,
            mensagem.conversaId,
            mensagem.ocorridaEm,
          );
        }
      },
    );
  }

  private async registrarResposta(
    destinatarioId: string,
    mensagemId: string,
    conversaId: string,
    quando: Date,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const marcado = await tx.campanhaDestinatario.updateMany({
        where: { id: destinatarioId, respondeuEm: null },
        data: { respondeuEm: quando },
      });
      if (marcado.count === 0) {
        return;
      }
      const destinatario = await tx.campanhaDestinatario.findUniqueOrThrow({
        where: { id: destinatarioId },
      });
      await this.eventos.publicar(tx, EVENTOS_DA_ONDA_B.CAMPANHA_RESPONDIDA, {
        campanhaId: destinatario.campanhaId,
        destinatarioId,
        contatoId: destinatario.contatoId,
        conversaId,
        mensagemId,
      });
      await this.progresso.atualizar(tx, destinatario.campanhaId);
    });
  }

  private async aplicarSaida(
    mensagemId: string,
    confirmacao: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const mensagem = await tx.mensagem.findUniqueOrThrow({
        where: { id: mensagemId },
        include: { canal: true, conversa: true },
      });
      const contatoId = mensagem.conversa.contatoId;
      const contato = await tx.contato.findFirst({
        where: { id: contatoId, excluidoEm: null },
      });
      if (!contato) {
        return;
      }
      const agora = new Date();
      const desde = new Date(
        agora.getTime() - JANELA_DE_SAIDA_DIAS * UM_DIA_MS,
      );
      const afetados = await tx.campanhaDestinatario.findMany({
        where: {
          contatoId,
          status: { in: ['ENVIANDO', 'ENVIADO'] },
          optOutEm: null,
          mensagem: { is: { ocorridaEm: { gte: desde } } },
          campanha: { canal: mensagem.canal.tipo },
        },
        include: { campanha: { select: { id: true, nome: true } } },
      });
      if (afetados.length === 0 && contato.optOutMarketing) {
        return; // repetição do evento: já tratado
      }
      if (!contato.optOutMarketing) {
        const depois = await tx.contato.update({
          where: { id: contatoId },
          data: { optOutMarketing: true, optOutEm: agora },
        });
        await this.auditoria.registrar(tx, {
          acao: 'contato.atualizado',
          entidade: 'contato',
          entidadeId: contatoId,
          resumo: `Contato "${contato.nome}" pediu para sair das campanhas (opt-out) respondendo "${(mensagem.texto ?? '').trim()}"`,
          dados: {
            alteracoes: { optOutMarketing: { de: false, para: true } },
            regra: 'R4.6',
            campanhas: afetados.map((d) => d.campanha.nome),
          },
          relacionados: { empresa: depois.empresaId },
        });
        await this.eventos.publicar(tx, 'contato.atualizado', {
          ...instantaneoDoContato(depois),
          camposAlterados: ['optOutMarketing'],
          motivo: 'opt_out_campanha',
        });
      }
      if (afetados.length > 0) {
        await tx.campanhaDestinatario.updateMany({
          where: { id: { in: afetados.map((d) => d.id) } },
          data: { optOutEm: agora },
        });
      }
      const pendentes = await tx.campanhaDestinatario.findMany({
        where: { contatoId, status: 'PENDENTE' },
        select: { campanhaId: true },
      });
      if (pendentes.length > 0) {
        await tx.campanhaDestinatario.updateMany({
          where: { contatoId, status: 'PENDENTE' },
          data: {
            status: 'EXCLUIDO',
            motivo: 'O contato pediu para sair das campanhas (opt-out).',
          },
        });
      }
      await this.motor.criarSaida(tx, mensagem.conversa, mensagem.canal, {
        texto: confirmacao,
        autorId: null,
        metadados: {
          optOut: true,
          campanhaId: afetados[0]?.campanha.id ?? null,
        },
      });
      const campanhas = new Set([
        ...afetados.map((d) => d.campanhaId),
        ...pendentes.map((d) => d.campanhaId),
      ]);
      for (const campanhaId of campanhas) {
        await this.progresso.atualizar(tx, campanhaId);
      }
      this.logger.debug?.(
        `Opt-out do contato ${contatoId} aplicado (${REGRA_DISPAROS}).`,
      );
    });
  }
}
