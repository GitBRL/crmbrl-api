import { Inject, Injectable } from '@nestjs/common';
import { sendNotification, WebPushError } from 'web-push';
import { AMBIENTE, type Ambiente } from '../config/ambiente';
import { PRAZO_DO_ENVIO_MS, VALIDADE_DO_PUSH_S } from './push.constantes';

/** A inscrição do aparelho, como o navegador a entregou. */
export interface AssinaturaDePush {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export type ResultadoDoEnvio =
  | { ok: true }
  | {
      ok: false;
      /** Status HTTP do serviço de push; `null` = falha de rede ou tempo esgotado. */
      status: number | null;
      mensagem: string;
    };

/** Quem fala com o serviço de push do navegador. Nos testes, um falso. */
export const SERVICO_DE_PUSH = Symbol('SERVICO_DE_PUSH');

export interface ServicoDePush {
  enviar(
    assinatura: AssinaturaDePush,
    carga: string,
  ): Promise<ResultadoDoEnvio>;
}

/** `web-push` com as chaves VAPID do ambiente (R26). Nunca registra o endpoint nem as chaves. */
@Injectable()
export class ServicoWebPush implements ServicoDePush {
  constructor(@Inject(AMBIENTE) private readonly ambiente: Ambiente) {}

  async enviar(
    assinatura: AssinaturaDePush,
    carga: string,
  ): Promise<ResultadoDoEnvio> {
    const { push } = this.ambiente;
    const privada = push.chavePrivada();
    if (!push.configurada || !push.chavePublica || !privada || !push.assunto) {
      return { ok: false, status: null, mensagem: 'Push não configurado.' };
    }
    try {
      await sendNotification(assinatura, carga, {
        vapidDetails: {
          subject: push.assunto,
          publicKey: push.chavePublica,
          privateKey: privada,
        },
        TTL: VALIDADE_DO_PUSH_S,
        urgency: 'normal',
        timeout: PRAZO_DO_ENVIO_MS,
      });
      return { ok: true };
    } catch (erro) {
      if (erro instanceof WebPushError) {
        return {
          ok: false,
          status: erro.statusCode,
          mensagem: `O serviço de push respondeu ${erro.statusCode}.`,
        };
      }
      return {
        ok: false,
        status: null,
        mensagem: 'Falha de rede ao falar com o serviço de push.',
      };
    }
  }
}
