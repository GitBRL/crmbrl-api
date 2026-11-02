import { Injectable, Logger } from '@nestjs/common';
import type { Notificacao } from '../generated/prisma/client';
import type { Tx } from '../prisma/prisma.service';

/** Quem quer saber das notificações recém-criadas (R26: o push). Roda **na transação** que as criou. */
export type OuvinteDeNotificacoes = (
  tx: Tx,
  notificacoes: readonly Notificacao[],
) => Promise<void>;

/**
 * Registro de ouvintes das notificações internas. O `NotificacoesService`
 * avisa os ouvintes logo depois de gravar, na mesma transação: o que o ouvinte
 * criar (um job na fila, por exemplo) só existe se a alteração for confirmada.
 * Falha de um ouvinte nunca derruba a regra de negócio que gerou a notificação.
 */
@Injectable()
export class OuvintesDeNotificacao {
  private readonly logger = new Logger(OuvintesDeNotificacao.name);
  private readonly ouvintes: OuvinteDeNotificacoes[] = [];

  registrar(ouvinte: OuvinteDeNotificacoes): void {
    this.ouvintes.push(ouvinte);
  }

  async avisar(tx: Tx, notificacoes: readonly Notificacao[]): Promise<void> {
    if (notificacoes.length === 0) {
      return;
    }
    for (const ouvinte of this.ouvintes) {
      try {
        await ouvinte(tx, notificacoes);
      } catch (erro) {
        this.logger.error(
          `Ouvinte de notificações falhou: ${erro instanceof Error ? erro.name : 'erro'}`,
        );
      }
    }
  }
}
