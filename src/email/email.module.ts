import { Global, Module } from '@nestjs/common';
import { EmailService } from './email.service';

/** Envio de e-mail (SMTP opcional), para todos os módulos. */
@Global()
@Module({
  providers: [EmailService],
  exports: [EmailService],
})
export class EmailModule {}
