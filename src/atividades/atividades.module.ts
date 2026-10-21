import { Module } from '@nestjs/common';
import { AtividadesController } from './atividades.controller';
import { AtividadesService } from './atividades.service';
import { LembretesAtividadesService } from './lembretes-atividades.service';

/**
 * Atividades (R6): tarefas, ligações, reuniões, e-mails, WhatsApp e notas, com
 * o job de lembretes a cada 15 minutos (R6.5, fila `atividades.lembretes`).
 *
 * Usa só serviços globais da base (Prisma, auditoria, eventos, notificações e
 * fila). Exporta `AtividadesService` (e as funções de `regras-atividades`)
 * para quem precisar das mesmas regras, como a linha do tempo (R3.5).
 */
@Module({
  controllers: [AtividadesController],
  providers: [AtividadesService, LembretesAtividadesService],
  exports: [AtividadesService, LembretesAtividadesService],
})
export class AtividadesModule {}
