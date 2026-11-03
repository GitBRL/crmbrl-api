import { Injectable, Logger } from '@nestjs/common';
import { CriptografiaService } from '../../comum/criptografia/criptografia.service';
import { NaoAutenticadoException } from '../../comum/erros/excecoes';
import { FilaService } from '../../fila/fila.service';
import type { Canal } from '../../generated/prisma/client';
import { LogsTecnicosService } from '../../logs/logs-tecnicos.service';
import { PrismaService } from '../../prisma/prisma.service';
import { SegredosDoCanal } from '../comum/segredos-do-canal';
import {
  EntradaWhatsappOficialService,
  FILA_WEBHOOK_WHATSAPP_OFICIAL,
  type TrabalhoDoWebhookOficial,
} from './entrada-whatsapp-oficial.service';
import { mudancasDoWebhook } from './eventos-oficial';
import type { SegredosOficiais } from './formato-meta';

/**
 * Parte do WhatsApp oficial no webhook da Meta (R28). O endereço é o mesmo do
 * Instagram e do Messenger (`/api/v1/publico/meta/webhook`): o
 * `WebhookMetaService` entrega aqui o que tem `object: whatsapp_business_account`.
 *
 * - **Verificação (GET):** vale o verify token de qualquer canal do WhatsApp oficial.
 * - **Entrega (POST):** cada mudança (`entry[].changes[]`) acha o canal pelo
 *   `metadata.phone_number_id`; a assinatura `X-Hub-Signature-256` é conferida
 *   com o app secret **desse** canal; a mudança vai para a fila e a resposta é
 *   200 na hora. Só entram campos que alguém trata (`messages`); os outros são
 *   ignorados com log em nível debug.
 */
@Injectable()
export class WebhookWhatsappOficialService {
  private readonly logger = new Logger('WhatsAppOficial');

  constructor(
    private readonly prisma: PrismaService,
    private readonly cripto: CriptografiaService,
    private readonly segredos: SegredosDoCanal,
    private readonly fila: FilaService,
    private readonly logs: LogsTecnicosService,
    private readonly entrada: EntradaWhatsappOficialService,
  ) {}

  /** O token é o verify token de algum canal do WhatsApp oficial? */
  async tokenDeVerificacaoValido(token: string): Promise<boolean> {
    if (token === '') {
      return false;
    }
    const canais = await this.prisma.canal.findMany({
      where: { tipo: 'WHATSAPP_OFICIAL', excluidoEm: null },
    });
    return canais.some((canal) => {
      const { tokenVerificacao } =
        this.segredos.lerSemFalhar<SegredosOficiais>(canal) ?? {};
      return (
        !!tokenVerificacao &&
        this.cripto.compararSeguro(tokenVerificacao, token)
      );
    });
  }

  /** Recebe o POST: confere a assinatura de cada canal e enfileira as mudanças. */
  async receber(
    corpo: unknown,
    bruto: Buffer | undefined,
    assinatura: string | undefined,
  ): Promise<{ recebidas: number }> {
    const mudancas = mudancasDoWebhook(corpo).filter((mudanca) => {
      const tratado = this.entrada.trataCampo(mudanca.campo);
      if (!tratado) {
        this.logger.debug?.(
          `Campo "${mudanca.campo}" do webhook do WhatsApp oficial ignorado.`,
        );
      }
      return tratado;
    });
    if (mudancas.length === 0) {
      return { recebidas: 0 };
    }
    const canais = await this.prisma.canal.findMany({
      where: {
        tipo: 'WHATSAPP_OFICIAL',
        excluidoEm: null,
        idExterno: { in: [...new Set(mudancas.map((m) => m.phoneNumberId))] },
      },
    });
    if (canais.length === 0) {
      this.logger.debug?.(
        `Webhook do WhatsApp oficial para ${mudancas.map((m) => m.phoneNumberId).join(', ')}: nenhum canal.`,
      );
      return { recebidas: 0 };
    }
    const assinaturaConfere = new Map<string, boolean>();
    const confere = (canal: Canal): boolean => {
      let valida = assinaturaConfere.get(canal.id);
      if (valida === undefined) {
        const { appSecret } =
          this.segredos.lerSemFalhar<SegredosOficiais>(canal) ?? {};
        valida =
          !!appSecret &&
          !!bruto &&
          this.cripto.verificarHmac(appSecret, bruto, assinatura);
        assinaturaConfere.set(canal.id, valida);
      }
      return valida;
    };
    if (!canais.some(confere)) {
      await this.logs.aviso(
        'WhatsAppOficial',
        assinatura
          ? 'Webhook do WhatsApp oficial com assinatura inválida (X-Hub-Signature-256 não confere com o app secret do canal).'
          : 'Webhook do WhatsApp oficial sem a assinatura X-Hub-Signature-256.',
        { canais: canais.map(({ id }) => id) },
      );
      throw new NaoAutenticadoException(
        assinatura
          ? 'Assinatura inválida: X-Hub-Signature-256 não confere.'
          : 'Assinatura ausente: envie X-Hub-Signature-256.',
      );
    }
    let recebidas = 0;
    for (const mudanca of mudancas) {
      const canal = canais.find(
        (item) => item.idExterno === mudanca.phoneNumberId,
      );
      // Cada canal só aceita o que foi assinado com o app secret dele.
      if (!canal || !canal.ativo || !confere(canal)) {
        continue;
      }
      await this.fila.enviar(FILA_WEBHOOK_WHATSAPP_OFICIAL, {
        canalId: canal.id,
        campo: mudanca.campo,
        valor: mudanca.valor,
      } satisfies TrabalhoDoWebhookOficial);
      recebidas++;
    }
    return { recebidas };
  }
}
