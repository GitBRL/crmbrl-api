import { Injectable } from '@nestjs/common';
import type { Canal, Contato, Conversa } from '../generated/prisma/client';
import type { Tx } from '../prisma/prisma.service';

/** O que o gancho recebe quando uma conversa nova acaba de nascer (ainda na transação da entrada). */
export interface ConversaNova {
  conversa: Conversa;
  canal: Canal;
  contato: Contato;
}

/** Resposta do gancho. */
export interface DecisaoDaConversaNova {
  /**
   * `true`: a conversa fica na fila **sem responsável**, sem passar pela
   * distribuição (alguém, como o SDR com IA, está cuidando dela).
   */
  manterSemResponsavel: boolean;
}

export interface GanchoDeConversaNova {
  /** Roda dentro da transação da entrada, depois de gravar a primeira mensagem. */
  aoCriarConversa(tx: Tx, dados: ConversaNova): Promise<DecisaoDaConversaNova>;
}

/**
 * Pontos de extensão do Atendimento para módulos que ficam "acima" dele
 * (hoje, o SDR com IA, R31) sem criar dependência circular: o módulo de cima
 * se registra no `onModuleInit` e o Atendimento o chama nos pontos abaixo.
 */
@Injectable()
export class GanchosDoAtendimento {
  private conversaNova: GanchoDeConversaNova | null = null;

  /** Um só gancho de conversa nova (o último registro vale). */
  registrarConversaNova(gancho: GanchoDeConversaNova): void {
    this.conversaNova = gancho;
  }

  async aoCriarConversa(
    tx: Tx,
    dados: ConversaNova,
  ): Promise<DecisaoDaConversaNova> {
    return (
      (await this.conversaNova?.aoCriarConversa(tx, dados)) ?? {
        manterSemResponsavel: false,
      }
    );
  }
}
