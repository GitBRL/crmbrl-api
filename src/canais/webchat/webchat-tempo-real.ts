import { Injectable, Logger } from '@nestjs/common';
import type { Namespace, Socket } from 'socket.io';

/**
 * Catálogo do Socket.IO dos visitantes do chat do site (§2.5): namespace
 * `/webchat` no mesmo caminho do tempo real (`/api/socket.io`). É o contrato
 * com o widget (`widget/widget-do-site.ts`).
 *
 * Conexão (só o transporte `websocket`, que não depende de CORS):
 * `wss://<api>/api/socket.io/?EIO=4&transport=websocket`, pacote de conexão ao
 * namespace com `{ chave, token }`. A origem precisa estar nos domínios do canal.
 */
export const NAMESPACE_WEBCHAT = '/webchat';

/** Servidor → visitante. */
export const EVENTOS_PARA_O_VISITANTE = {
  /** `MensagemPublicaDto` nova (da equipe, ou do próprio visitante em outra aba). Ack `{ ok, vista }`. */
  MENSAGEM: 'mensagem',
  /** `{ ativo, nome? }`: alguém da equipe está digitando. */
  DIGITANDO: 'digitando',
} as const;

/** Visitante → servidor (ack `{ ok }` ou `{ ok: false, erro, mensagem }`). */
export const PEDIDOS_DO_VISITANTE = {
  /** `{ ativo }`: o visitante está digitando (repassado à conversa). */
  DIGITANDO: 'digitando',
  /** `{}`: o visitante viu as mensagens (marca as da equipe como lidas). */
  LIDO: 'lido',
} as const;

/** Sala de todos os sockets (abas) de um visitante. */
export function salaDoVisitante(visitanteId: string): string {
  return `visitante:${visitanteId}`;
}

/** Dados guardados no socket do visitante depois do handshake. */
export interface DadosDoSocketDoVisitante {
  visitanteId: string;
  canalId: string;
  digitandoEm: number;
}

export type SocketDoVisitante = Socket<
  Record<string, (...argumentos: unknown[]) => void>,
  Record<string, (...argumentos: unknown[]) => void>,
  Record<string, never>,
  DadosDoSocketDoVisitante
>;

/** Confirmação de uma mensagem entregue ao widget. */
export interface ConfirmacaoDoVisitante {
  entregue: boolean;
  vista: boolean;
}

/** Quanto o servidor espera a confirmação de entrega de uma mensagem. */
const PRAZO_DA_CONFIRMACAO_MS = 5_000;

/**
 * Emissões para os visitantes do chat do site (namespace `/webchat`). Fora do
 * `TempoRealService` porque o namespace é outro (e não tem sessão de usuário).
 */
@Injectable()
export class WebchatTempoReal {
  private readonly logger = new Logger('Webchat');
  private servidor?: Namespace;

  definirServidor(servidor: Namespace): void {
    this.servidor = servidor;
  }

  /** Emite agora para os visitantes (todas as abas). Sem servidor (testes sem HTTP), não faz nada. */
  emitir(
    visitanteIds: readonly string[],
    evento: string,
    dados: unknown,
  ): void {
    if (!this.servidor || visitanteIds.length === 0) {
      return;
    }
    this.servidor.to(visitanteIds.map(salaDoVisitante)).emit(evento, dados);
  }

  /**
   * Entrega uma mensagem aos visitantes e espera a confirmação de algum socket
   * (`{ ok, vista }`): `entregue` se alguma aba confirmou, `vista` se alguma
   * mostrou na tela (painel aberto e aba visível).
   */
  async entregar(
    visitanteIds: readonly string[],
    dados: unknown,
  ): Promise<ConfirmacaoDoVisitante> {
    if (!this.servidor || visitanteIds.length === 0) {
      return { entregue: false, vista: false };
    }
    try {
      const respostas: unknown[] = await this.servidor
        .to(visitanteIds.map(salaDoVisitante))
        .timeout(PRAZO_DA_CONFIRMACAO_MS)
        .emitWithAck(EVENTOS_PARA_O_VISITANTE.MENSAGEM, dados);
      return {
        entregue: respostas.length > 0,
        vista: respostas.some(
          (resposta) =>
            typeof resposta === 'object' &&
            resposta !== null &&
            (resposta as { vista?: unknown }).vista === true,
        ),
      };
    } catch (erro) {
      // Sem resposta no prazo (aba fechada no meio, rede ruim): fica "enviada".
      this.logger.debug?.(
        `Mensagem do chat do site sem confirmação: ${erro instanceof Error ? erro.message : String(erro)}`,
      );
      return { entregue: false, vista: false };
    }
  }

  /** Algum socket do visitante está conectado agora? */
  async estaConectado(visitanteId: string): Promise<boolean> {
    if (!this.servidor) {
      return false;
    }
    const sockets = await this.servidor
      .in(salaDoVisitante(visitanteId))
      .fetchSockets();
    return sockets.length > 0;
  }

  /** Derruba os sockets do visitante (ex.: ele encerrou a conversa e apagou o token). */
  desconectar(visitanteId: string): void {
    this.servidor?.in(salaDoVisitante(visitanteId)).disconnectSockets(true);
  }
}
