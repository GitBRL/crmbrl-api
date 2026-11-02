import { Module } from '@nestjs/common';
import { AcessoChatService } from './acesso-chat.service';
import { CanaisChatService } from './canais-chat.service';
import { ChatInternoController } from './chat-interno.controller';
import { MensagensChatService } from './mensagens-chat.service';
import { MontagemChatService } from './montagem-chat.service';
import { PublicacaoChatService } from './publicacao-chat.service';
import { SincronizacaoChatService } from './sincronizacao-chat.service';
import { TempoRealChatService } from './tempo-real-chat.service';

/**
 * Chat interno da equipe (§2.6, R15).
 *
 * - **Canais padrão** — "Geral" (todos os usuários ativos) e um por área (as
 *   pessoas da área e o C-level): criados e mantidos pela
 *   `SincronizacaoChatService` (na subida, a cada minuto, depois de um
 *   desligamento e sob demanda).
 * - **Grupos** (qualquer pessoa cria; administradores mexem), **diretas**
 *   (uma por par, privadas — nem o Admin lê), mensagens com anexo (contexto
 *   `CHAT`), respostas, **menções** `<@id>` (notificam) e **referências**
 *   `<negocio|contato|empresa:id>` (viram links), editar e excluir as
 *   próprias, não lidas, silenciar e busca (`CanaisChatService`,
 *   `MensagensChatService`, `ChatInternoController`).
 * - **Tempo real** — os eventos `chat_mensagem.*` e `chat_canal.atualizado` da
 *   outbox viram `chat.mensagem` (sala `chat:<canalId>`), `chat.atualizado` e
 *   `nao-lidas` (sala de cada membro) depois do commit
 *   (`TempoRealChatService`). O `AcessoChatService` autoriza a sala e os
 *   anexos só para membros.
 */
@Module({
  controllers: [ChatInternoController],
  providers: [
    AcessoChatService,
    MontagemChatService,
    PublicacaoChatService,
    SincronizacaoChatService,
    TempoRealChatService,
    CanaisChatService,
    MensagensChatService,
  ],
  exports: [AcessoChatService, SincronizacaoChatService],
})
export class ChatInternoModule {}
