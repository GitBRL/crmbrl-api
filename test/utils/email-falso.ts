import type {
  MensagemEmail,
  ResultadoEnvio,
} from '../../src/email/email.service';

/**
 * Substitui o `EmailService` nos testes: guarda as mensagens em vez de enviar.
 * `configurado` começa `true` (convite e "esqueci a senha" disponíveis); mude
 * para `false` para simular a API sem SMTP.
 */
export class EmailFalso {
  configurado = true;
  readonly enviados: MensagemEmail[] = [];

  enviar(mensagem: MensagemEmail): Promise<ResultadoEnvio> {
    if (!this.configurado) {
      return Promise.resolve({ enviado: false });
    }
    this.enviados.push(mensagem);
    return Promise.resolve({
      enviado: true,
      idMensagem: `falso-${this.enviados.length}`,
    });
  }

  /** A última mensagem (para um destinatário, se informado). */
  ultimo(para?: string): MensagemEmail | undefined {
    const filtradas = para
      ? this.enviados.filter((mensagem) =>
          (typeof mensagem.para === 'string'
            ? [mensagem.para]
            : mensagem.para
          ).includes(para),
        )
      : this.enviados;
    return filtradas.at(-1);
  }

  /** O token do link (`?token=…`) da última mensagem. */
  tokenDoUltimo(para?: string): string | undefined {
    const texto = this.ultimo(para)?.texto ?? '';
    const encontrado = /[?&]token=([^&\s]+)/.exec(texto);
    return encontrado ? decodeURIComponent(encontrado[1]) : undefined;
  }

  limpar(): void {
    this.enviados.length = 0;
    this.configurado = true;
  }
}
