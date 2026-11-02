import { Module } from '@nestjs/common';
import { AtendimentoModule } from '../atendimento/atendimento.module';
import { ContatosModule } from '../contatos/contatos.module';
import { FunisModule } from '../funis/funis.module';
import { AcessoChatbot } from './acesso-chatbot.service';
import { AcoesDoBot } from './acoes-do-bot.service';
import { ChatbotController } from './chatbot.controller';
import { EntradaDoBot } from './entrada-do-bot.service';
import { FluxosChatbotService } from './fluxos.service';
import { MensagensDoBot } from './mensagens-do-bot.service';
import { PassosDoChatbot } from './passos-do-chatbot.service';
import { SimuladorDoChatbot } from './simulador.service';
import { TransferenciaDoBot } from './transferencia-do-bot.service';

/**
 * Chatbot (R18, contrato da Onda B §2.4): fluxos (`FluxoChatbot`) com rascunho
 * e versões publicadas (`FluxoChatbotVersao`, imutáveis), executados pelo
 * `PassosService` (tipo `CHATBOT`, uma execução por conversa).
 *
 * - `EntradaDoBot`: gatilhos pela outbox (`mensagem.recebida` inicia o fluxo ou
 *   entrega a resposta; atendente que assume, responde, transfere ou resolve
 *   cancela o fluxo).
 * - `PassosDoChatbot`: tipos de passo (mensagem, perguntas, condição, ações,
 *   transferir); `MensagensDoBot` envia como autor `BOT` pelo Atendimento;
 *   `AcoesDoBot`/`TransferenciaDoBot` agem pelas mesmas regras e auditoria das
 *   ações humanas, com ator `AUTOMACAO` (descrição = nome do fluxo).
 * - `SimuladorDoChatbot`: execução em modo teste, sem efeitos reais.
 * - Rotas em `/chatbot/**` (`ChatbotController`).
 */
@Module({
  imports: [AtendimentoModule, ContatosModule, FunisModule],
  controllers: [ChatbotController],
  providers: [
    AcessoChatbot,
    AcoesDoBot,
    EntradaDoBot,
    FluxosChatbotService,
    MensagensDoBot,
    PassosDoChatbot,
    SimuladorDoChatbot,
    TransferenciaDoBot,
  ],
  exports: [FluxosChatbotService],
})
export class ChatbotModule {}
