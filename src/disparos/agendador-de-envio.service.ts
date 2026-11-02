import { Injectable } from '@nestjs/common';
import { FilaService } from '../fila/fila.service';
import type { Tx } from '../prisma/prisma.service';
import { FILA_DISPAROS_ENVIAR } from './disparos.constantes';

/** Dados do job de envio: a campanha e o instante (`proximoEnvioEm`) para o qual ele foi marcado. */
export interface PedidoDeEnvioDeCampanha {
  campanhaId: string;
  /** ISO 8601 do `proximoEnvioEm` gravado junto com o job. */
  quando: string;
}

/**
 * Põe na fila a próxima rodada de envio de uma campanha. O job leva o
 * `proximoEnvioEm` para o qual foi marcado: o motor só age se a campanha ainda
 * aguarda esse mesmo instante, então jobs repetidos ou velhos (pausa e
 * retomada, varredura) viram no-op e nunca formam duas cadeias de envio.
 * Quem chama grava `campanha.proximoEnvioEm = quando` na mesma transação.
 */
@Injectable()
export class AgendadorDeEnvio {
  constructor(private readonly fila: FilaService) {}

  async agendar(campanhaId: string, quando: Date, tx?: Tx): Promise<void> {
    const dados: PedidoDeEnvioDeCampanha = {
      campanhaId,
      quando: quando.toISOString(),
    };
    await this.fila.enviar(FILA_DISPAROS_ENVIAR, dados, {
      ...(tx ? { tx } : {}),
      ...(quando.getTime() > Date.now() ? { executarEm: quando } : {}),
      tentativas: 3,
      intervaloEntreTentativasSegundos: 30,
    });
  }
}
