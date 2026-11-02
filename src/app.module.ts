import { type DynamicModule, Module } from '@nestjs/common';
import { AdministracaoModule } from './administracao/administracao.module';
import { ArquivosHttpModule, ArquivosModule } from './arquivos/arquivos.module';
import { AtendimentoModule } from './atendimento/atendimento.module';
import { AtividadesModule } from './atividades/atividades.module';
import { AssistenteModule } from './assistente/assistente.module';
import { PushModule } from './push/push.module';
import { AuditoriaModule } from './auditoria/auditoria.module';
import { AuditoriaConsultaModule } from './auditoria/consulta/auditoria-consulta.module';
import { AuthModule } from './auth/auth.module';
import { AnaliseModule } from './bi/analise/analise.module';
import { BiModule } from './bi/bi.module';
import { AutomacoesModule } from './automacoes/automacoes.module';
import { CanaisModule } from './canais/canais.module';
import { ChatbotModule } from './chatbot/chatbot.module';
import { ChatInternoModule } from './chat-interno/chat-interno.module';
import { AutomacaoComumModule } from './comum/automacao-comum.module';
import { ComumModule } from './comum/comum.module';
import type { Ambiente } from './config/ambiente';
import { AmbienteModule } from './config/ambiente.module';
import { ContatosModule } from './contatos/contatos.module';
import { DisparosModule } from './disparos/disparos.module';
import { EmailModule } from './email/email.module';
import { EventosModule } from './eventos/eventos.module';
import { FilaModule } from './fila/fila.module';
import { FinanceiroModule } from './financeiro/financeiro.module';
import { FunisModule } from './funis/funis.module';
import { ImportacaoModule } from './importacao/importacao.module';
import { LogsModule } from './logs/logs.module';
import { NotificacoesModule } from './notificacoes/notificacoes.module';
import { PrismaModule } from './prisma/prisma.module';
import { MonitoramentoModule } from './saude/monitoramento/monitoramento.module';
import { SaudeModule } from './saude/saude.module';
import { SeedsModule } from './seeds/seeds.module';
import { TempoRealModule } from './tempo-real/tempo-real.module';
import { UsuariosModule } from './usuarios/usuarios.module';
import { WebhooksModule } from './webhooks/webhooks.module';

/**
 * Módulo raiz da API. É montado no `main.ts` (e nos testes e2e) com o ambiente
 * já validado — nada aqui lê variável de ambiente na hora do import. O gateway
 * de WhatsApp é outro processo, com o seu próprio módulo raiz
 * (`src/whatsapp/gateway-whatsapp.module.ts`).
 */
@Module({})
export class AppModule {
  /**
   * @param ambiente resultado de `lerAmbiente()`.
   * @param observe `ObserveModule.forRoot(...)`, só quando as chaves do Observe existem.
   */
  static forRoot(ambiente: Ambiente, observe?: DynamicModule): DynamicModule {
    return {
      module: AppModule,
      imports: [
        // O Observe entra primeiro: módulos globais desligam na ordem inversa
        // da importação, e ele precisa ser o último a parar para enviar o que
        // ainda tiver guardado. Pelo mesmo motivo o Prisma vem antes da fila e
        // dos eventos: eles param primeiro, com o banco ainda conectado.
        ...(observe ? [observe] : []),
        AmbienteModule.forRoot(ambiente),
        PrismaModule,
        LogsModule,
        ComumModule,
        EmailModule,
        FilaModule,
        EventosModule,
        AuditoriaModule,
        NotificacoesModule,
        AuthModule,
        // Onda A: arquivos (MinIO/S3) e tempo real (Socket.IO), globais.
        ArquivosModule,
        TempoRealModule,
        // Onda B: modelos, segmentos, executor de passos e gatilhos, globais.
        AutomacaoComumModule,
        SeedsModule,
        SaudeModule,
        MonitoramentoModule,
        // Módulos de negócio (Fase 1).
        UsuariosModule,
        ContatosModule,
        FunisModule,
        AtividadesModule,
        AuditoriaConsultaModule,
        AdministracaoModule,
        WebhooksModule,
        // Módulos de negócio (Onda A): rotas de arquivos, atendimento, canais
        // (WhatsApp, chat do site, e-mail, Meta) e chat interno.
        ArquivosHttpModule,
        AtendimentoModule,
        CanaisModule,
        ChatInternoModule,
        // Módulos de negócio (Onda B): importação, disparos, chatbot e automações.
        ImportacaoModule,
        DisparosModule,
        ChatbotModule,
        AutomacoesModule,
        // Módulos de negócio (Onda C): BI.
        BiModule,
        AnaliseModule,
        // Onda C: financeiro (contratos, parcelas, régua de cobrança).
        FinanceiroModule,
        // Onda D: assistente de IA e chamados.
        AssistenteModule,
        // Onda D: notificações push.
        PushModule,
      ],
    };
  }
}
