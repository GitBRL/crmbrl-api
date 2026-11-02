import { Injectable } from '@nestjs/common';
import { EventosDominioService } from '../eventos/eventos-dominio.service';
import type { ChatMensagem } from '../generated/prisma/client';
import type { Tx } from '../prisma/prisma.service';
import {
  type DadosDoEventoDeCanal,
  type DadosDoEventoDeMensagem,
  EVENTOS_DO_CHAT,
} from './regras-chat';

/**
 * O que o chat grava na outbox, sempre na transação da alteração (R10.1): os
 * eventos `chat_mensagem.*` e `chat_canal.atualizado` levam só ids — nada de
 * conteúdo, porque as diretas são privadas — e o tempo real monta as emissões
 * depois do commit (`TempoRealChatService`). Também cria os avisos do sistema
 * ("Ana adicionou Pedro"), mensagens sem autor.
 */
@Injectable()
export class PublicacaoChatService {
  constructor(private readonly eventos: EventosDominioService) {}

  async mensagemCriada(
    tx: Tx,
    canalId: string,
    mensagemId: string,
  ): Promise<void> {
    await this.eventos.publicar<DadosDoEventoDeMensagem>(
      tx,
      EVENTOS_DO_CHAT.MENSAGEM_CRIADA,
      { canalId, mensagemId },
    );
  }

  async mensagemEditada(
    tx: Tx,
    canalId: string,
    mensagemId: string,
  ): Promise<void> {
    await this.eventos.publicar<DadosDoEventoDeMensagem>(
      tx,
      EVENTOS_DO_CHAT.MENSAGEM_EDITADA,
      { canalId, mensagemId },
    );
  }

  async mensagemExcluida(
    tx: Tx,
    canalId: string,
    mensagemId: string,
  ): Promise<void> {
    await this.eventos.publicar<DadosDoEventoDeMensagem>(
      tx,
      EVENTOS_DO_CHAT.MENSAGEM_EXCLUIDA,
      { canalId, mensagemId },
    );
  }

  /** Nome, descrição, arquivamento, membros ou administradores mudaram. */
  async canalAtualizado(tx: Tx, dados: DadosDoEventoDeCanal): Promise<void> {
    await this.eventos.publicar<DadosDoEventoDeCanal>(
      tx,
      EVENTOS_DO_CHAT.CANAL_ATUALIZADO,
      {
        canalId: dados.canalId,
        ...(dados.entraram?.length ? { entraram: dados.entraram } : {}),
        ...(dados.sairam?.length ? { sairam: dados.sairam } : {}),
      },
    );
  }

  /**
   * Aviso do sistema no canal (sem autor; não conta como não lida). O texto
   * pode ter marcações de menção para os nomes ficarem sempre atuais — sem
   * notificar ninguém (`mencoes` fica vazio).
   */
  async aviso(tx: Tx, canalId: string, texto: string): Promise<ChatMensagem> {
    const agora = new Date();
    const mensagem = await tx.chatMensagem.create({
      data: { canalId, autorId: null, texto, criadoEm: agora },
    });
    await tx.chatCanal.update({
      where: { id: canalId },
      data: { ultimaMensagemEm: agora },
    });
    await this.mensagemCriada(tx, canalId, mensagem.id);
    return mensagem;
  }
}
