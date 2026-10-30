import { Module } from '@nestjs/common';

/**
 * Chatbot (R18, contrato da Onda B §2.4): fluxos (`FluxoChatbot`) com rascunho
 * e versões publicadas (`FluxoChatbotVersao`), executados pelo `PassosService`
 * (tipo de execução CHATBOT, uma execução por conversa), gatilhos pela outbox
 * (`conversa.criada`, `mensagem.recebida`), mensagens do bot com autor `BOT`,
 * atendente assume → `PassosService.cancelarAtivas({ conversaId }, 'atendente_assumiu')`,
 * simulador (execução com `teste: true`).
 *
 * Esqueleto da base (`base-api-b`): o `chatbot-api` preenche.
 */
@Module({
  controllers: [],
  providers: [],
  exports: [],
})
export class ChatbotModule {}
