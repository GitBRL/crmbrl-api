import { Injectable, type OnModuleInit } from '@nestjs/common';
import { EventosDominioService } from '../eventos/eventos-dominio.service';
import { NotificacoesService } from '../notificacoes/notificacoes.service';
import { PrismaService } from '../prisma/prisma.service';
import { TempoRealService } from '../tempo-real/tempo-real.service';
import {
  EVENTOS_DO_ATENDIMENTO,
  linkDaConversa,
  resumir,
  TIPOS_NOTIFICACAO_ATENDIMENTO,
} from './atendimento.constantes';

/** O que o evento `mensagem.recebida` traz (publicado por `AtendimentoService.receber`). */
export interface MensagemRecebida {
  mensagemId: string;
  conversaId: string;
  conversaNova: boolean;
  responsavelId: string | null;
  /** A conversa não tinha mensagens não lidas antes desta. */
  primeiraNaoLida?: boolean;
}

/**
 * Notifica o responsável da mensagem nova do contato (§2.4) — sem inundar: só
 * a primeira de uma sequência não lida, e só se a pessoa estiver fora do CRM
 * (quem está conectado já vê pelo tempo real e pelo número do menu). Conversa
 * nova já notificou na distribuição. Roda pela outbox, depois do commit.
 */
@Injectable()
export class AvisoDeMensagem implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventos: EventosDominioService,
    private readonly notificacoes: NotificacoesService,
    private readonly tempoReal: TempoRealService,
  ) {}

  onModuleInit(): void {
    this.eventos.registrarManipulador<MensagemRecebida>(
      EVENTOS_DO_ATENDIMENTO.MENSAGEM_RECEBIDA,
      async (evento) => {
        await this.avisar(evento.dados);
      },
      'atendimento:aviso-de-mensagem',
    );
  }

  /** Devolve se notificou. */
  async avisar(dados: MensagemRecebida): Promise<boolean> {
    if (dados.conversaNova || !dados.primeiraNaoLida) {
      return false;
    }
    const conversa = await this.prisma.conversa.findUnique({
      where: { id: dados.conversaId },
      select: {
        responsavelId: true,
        status: true,
        contato: { select: { nome: true } },
        canal: { select: { nome: true } },
      },
    });
    const responsavelId = conversa?.responsavelId;
    if (!conversa || !responsavelId || conversa.status === 'RESOLVIDA') {
      return false;
    }
    if (
      this.tempoReal.ativo &&
      (await this.tempoReal.estaConectado(responsavelId))
    ) {
      return false;
    }
    const mensagem = await this.prisma.mensagem.findUnique({
      where: { id: dados.mensagemId },
      select: { texto: true, tipo: true, arquivo: { select: { nome: true } } },
    });
    return this.prisma.$transaction(async (tx) => {
      const repetida = await tx.notificacao.findFirst({
        where: {
          usuarioId: responsavelId,
          tipo: TIPOS_NOTIFICACAO_ATENDIMENTO.MENSAGEM_RECEBIDA,
          dados: { path: ['mensagemId'], equals: dados.mensagemId },
        },
        select: { id: true },
      });
      if (repetida) {
        return false;
      }
      await this.notificacoes.notificar(tx, responsavelId, {
        tipo: TIPOS_NOTIFICACAO_ATENDIMENTO.MENSAGEM_RECEBIDA,
        titulo: `Nova mensagem de ${conversa.contato.nome}`,
        texto: `${conversa.canal.nome}: ${resumir(mensagem?.texto ?? mensagem?.arquivo?.nome ?? 'anexo')}`,
        link: linkDaConversa(dados.conversaId),
        dados: { conversaId: dados.conversaId, mensagemId: dados.mensagemId },
      });
      return true;
    });
  }
}
