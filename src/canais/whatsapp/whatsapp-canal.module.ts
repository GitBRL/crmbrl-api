import { Module } from '@nestjs/common';
import { AtendimentoModule } from '../../atendimento/atendimento.module';
import { AdaptadorWhatsapp } from './adaptador-whatsapp';
import { ClienteGatewayWhatsapp } from './cliente-gateway';
import { DigitandoWhatsappService } from './digitando-whatsapp.service';
import { EventosWhatsappService } from './eventos-whatsapp.service';
import { NumerosWhatsappController } from './numeros-whatsapp.controller';
import { NumerosWhatsappService } from './numeros-whatsapp.service';

/**
 * WhatsApp do lado da API (§2.3, R13):
 *
 * - `NumerosWhatsappController`/`Service` — cadastro dos números (cada um é um
 *   canal `WHATSAPP`), conectar/desconectar/status/verificar pelo gateway,
 *   limites, aquecimento, proteções e pausa (`/api/v1/whatsapp/numeros`);
 * - `AdaptadorWhatsapp` — envio: um job na fila do número
 *   (`whatsapp.envio.<numeroId>`), que o gateway consome;
 * - `EventosWhatsappService` — consome `whatsapp.evento` (mensagem recebida →
 *   Atendimento, status de entrega, conexão → `whatsapp.conexao`, digitando);
 * - `DigitandoWhatsappService` — "digitando…" do atendente para o contato;
 * - `ClienteGatewayWhatsapp` — os comandos síncronos (HTTP interno).
 *
 * O processo do gateway fica em `src/whatsapp/**`; o contrato entre os dois,
 * em `contrato-gateway.ts`; as proteções anti-banimento, em `protecoes.ts`.
 */
@Module({
  imports: [AtendimentoModule],
  controllers: [NumerosWhatsappController],
  providers: [
    ClienteGatewayWhatsapp,
    AdaptadorWhatsapp,
    EventosWhatsappService,
    DigitandoWhatsappService,
    NumerosWhatsappService,
  ],
  exports: [
    ClienteGatewayWhatsapp,
    EventosWhatsappService,
    NumerosWhatsappService,
  ],
})
export class WhatsappCanalModule {}
