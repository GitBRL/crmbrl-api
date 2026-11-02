import { Module } from '@nestjs/common';
import { AtendimentoModule } from '../../atendimento/atendimento.module';
import { CanaisComumModule } from '../comum/canais-comum.module';
import { AdaptadorEmail } from './adaptador-email';
import { EmailCanaisController } from './email-canais.controller';
import { EmailCanaisService } from './email-canais.service';
import { LeitorDeEmail } from './leitor-de-email.service';

/**
 * Canal de e-mail (§2.5, R14):
 *
 * - leitura do IMAP a cada minuto (job `email.varrer`), só mensagens novas,
 *   com `imapflow` + `mailparser`: corpo como texto, encadeamento por
 *   Message-ID/In-Reply-To/References, anexos para o `ArquivosService`;
 * - `AdaptadorEmail`: resposta pelo SMTP do canal (`nodemailer`) com os
 *   cabeçalhos de encadeamento;
 * - configuração e teste de conexão pelo Admin em `/api/v1/email/canais`.
 */
@Module({
  imports: [AtendimentoModule, CanaisComumModule],
  controllers: [EmailCanaisController],
  providers: [AdaptadorEmail, LeitorDeEmail, EmailCanaisService],
  exports: [LeitorDeEmail],
})
export class EmailCanalModule {}
