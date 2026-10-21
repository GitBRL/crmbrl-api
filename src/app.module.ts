import { type DynamicModule, Module } from '@nestjs/common';
import { AdministracaoModule } from './administracao/administracao.module';
import { AtividadesModule } from './atividades/atividades.module';
import { AuditoriaModule } from './auditoria/auditoria.module';
import { AuditoriaConsultaModule } from './auditoria/consulta/auditoria-consulta.module';
import { AuthModule } from './auth/auth.module';
import { ComumModule } from './comum/comum.module';
import type { Ambiente } from './config/ambiente';
import { AmbienteModule } from './config/ambiente.module';
import { ContatosModule } from './contatos/contatos.module';
import { EmailModule } from './email/email.module';
import { EventosModule } from './eventos/eventos.module';
import { FilaModule } from './fila/fila.module';
import { FunisModule } from './funis/funis.module';
import { LogsModule } from './logs/logs.module';
import { NotificacoesModule } from './notificacoes/notificacoes.module';
import { PrismaModule } from './prisma/prisma.module';
import { SaudeModule } from './saude/saude.module';
import { SeedsModule } from './seeds/seeds.module';
import { UsuariosModule } from './usuarios/usuarios.module';
import { WebhooksModule } from './webhooks/webhooks.module';

/**
 * Módulo raiz. É montado no `main.ts` (e nos testes e2e) com o ambiente já
 * validado — nada aqui lê variável de ambiente na hora do import.
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
        SeedsModule,
        SaudeModule,
        // Módulos de negócio (Fase 1).
        UsuariosModule,
        ContatosModule,
        FunisModule,
        AtividadesModule,
        AuditoriaConsultaModule,
        AdministracaoModule,
        WebhooksModule,
      ],
    };
  }
}
