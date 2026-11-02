import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
} from '@nestjs/common';
import { createTransport } from 'nodemailer';
import { AMBIENTE, type Ambiente } from '../config/ambiente';

export interface MensagemEmail {
  para: string | readonly string[];
  assunto: string;
  /** Versão em texto puro (obrigatória: todo cliente de e-mail mostra). */
  texto: string;
  html?: string;
}

export interface ResultadoEnvio {
  /** `false` quando o SMTP não está configurado (a mensagem só foi para o log). */
  enviado: boolean;
  idMensagem?: string;
}

type Transporte = ReturnType<typeof createTransport>;

/**
 * Envio de e-mail por SMTP (nodemailer). Sem `SMTP_HOST`, `configurado` é
 * `false` e `enviar` só registra no log — convite e "esqueci minha senha"
 * ficam indisponíveis (R2.8).
 *
 * Envie depois de confirmar a transação (nunca dentro dela): um e-mail não se
 * desfaz se a transação falhar.
 *
 * ```ts
 * if (this.email.configurado) {
 *   await this.email.enviar({ para: usuario.email, assunto, texto, html });
 * }
 * ```
 */
@Injectable()
export class EmailService implements OnModuleDestroy {
  private readonly logger = new Logger(EmailService.name);
  private transporte?: Transporte;

  constructor(@Inject(AMBIENTE) private readonly ambiente: Ambiente) {}

  /** Há SMTP configurado? */
  get configurado(): boolean {
    return this.ambiente.smtp !== null;
  }

  async enviar(mensagem: MensagemEmail): Promise<ResultadoEnvio> {
    const para =
      typeof mensagem.para === 'string' ? [mensagem.para] : [...mensagem.para];
    const smtp = this.ambiente.smtp;
    if (!smtp) {
      this.logger.warn(
        `E-mail não enviado (SMTP não configurado): "${mensagem.assunto}" para ${para.join(', ')}.`,
      );
      return { enviado: false };
    }
    const info = await this.obterTransporte().sendMail({
      from: smtp.remetente,
      to: para,
      subject: mensagem.assunto,
      text: mensagem.texto,
      html: mensagem.html,
    });
    this.logger.log(
      `E-mail "${mensagem.assunto}" enviado para ${para.join(', ')}.`,
    );
    return { enviado: true, idMensagem: info.messageId };
  }

  onModuleDestroy(): void {
    this.transporte?.close();
  }

  private obterTransporte(): Transporte {
    const smtp = this.ambiente.smtp;
    if (!smtp) {
      throw new Error('SMTP não configurado.');
    }
    this.transporte ??= createTransport({
      host: smtp.host,
      port: smtp.porta,
      secure: smtp.seguro,
      auth: smtp.usuario
        ? { user: smtp.usuario, pass: smtp.senha ?? '' }
        : undefined,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
    return this.transporte;
  }
}
