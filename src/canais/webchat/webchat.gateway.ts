import { Logger } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  type OnGatewayConnection,
  type OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import type { Namespace } from 'socket.io';
import { ErroApi } from '../../comum/erros/excecoes';
import { NoBancoComoSistema } from '../../prisma/no-banco-como-sistema';
import { OPCOES_DO_SOCKET_IO } from '../../tempo-real/catalogo';
import {
  type DadosDoSocketDoVisitante,
  NAMESPACE_WEBCHAT,
  PEDIDOS_DO_VISITANTE,
  salaDoVisitante,
  type SocketDoVisitante,
  WebchatTempoReal,
} from './webchat-tempo-real';
import { WebchatService } from './webchat.service';

/** Intervalo mínimo entre dois "digitando: ativo" do mesmo socket. */
const INTERVALO_DO_DIGITANDO_MS = 2_000;

type Resposta = { ok: true } | { ok: false; erro: string; mensagem: string };

/** Motivo da recusa da conexão (`connect_error`: `message` e `data`). */
class RecusaDoVisitante extends Error {
  readonly data: { erro: string; mensagem: string };

  constructor(erro: string, mensagem: string) {
    super(erro);
    this.name = 'RecusaDoVisitante';
    this.data = { erro, mensagem };
  }
}

/**
 * Socket.IO dos visitantes do chat do site (§2.5): namespace `/webchat` em
 * `/api/socket.io`.
 *
 * - Handshake: `auth = { chave, token }`, a origem nos domínios do canal e um
 *   limite de conexões por IP. Recusa com `connect_error` (`message` =
 *   `origem_nao_permitida`, `nao_autenticado`, `nao_encontrado` ou
 *   `muitas_tentativas`).
 * - Ao conectar: sala `visitante:<id>` (todas as abas do visitante).
 * - Pedidos: `digitando { ativo }` (repassado à conversa, com limite) e `lido`.
 */
@WebSocketGateway({ ...OPCOES_DO_SOCKET_IO, namespace: NAMESPACE_WEBCHAT })
export class WebchatGateway
  implements OnGatewayInit<Namespace>, OnGatewayConnection<SocketDoVisitante>
{
  private readonly logger = new Logger('Webchat');

  constructor(
    private readonly webchat: WebchatService,
    private readonly tempoReal: WebchatTempoReal,
  ) {}

  afterInit(namespace: Namespace): void {
    this.tempoReal.definirServidor(namespace);
    namespace.use((socket, next) => {
      this.autenticar(socket as SocketDoVisitante)
        .then((dados) => {
          socket.data = dados;
          next();
        })
        .catch((erro: unknown) => {
          if (erro instanceof RecusaDoVisitante) {
            next(erro);
            return;
          }
          this.logger.warn(
            `Falha ao autenticar visitante do chat do site: ${erro instanceof Error ? erro.message : String(erro)}`,
          );
          next(
            new RecusaDoVisitante(
              'erro_interno',
              'Não foi possível conectar agora. Tente de novo.',
            ),
          );
        });
    });
  }

  async handleConnection(socket: SocketDoVisitante): Promise<void> {
    await socket.join(salaDoVisitante(socket.data.visitanteId));
  }

  @SubscribeMessage(PEDIDOS_DO_VISITANTE.DIGITANDO)
  @NoBancoComoSistema()
  async digitando(
    @ConnectedSocket() socket: SocketDoVisitante,
    @MessageBody() dados: unknown,
  ): Promise<Resposta> {
    const ativo =
      typeof dados === 'object' && dados !== null && 'ativo' in dados
        ? (dados as { ativo: unknown }).ativo !== false
        : true;
    const agora = Date.now();
    if (ativo && agora - socket.data.digitandoEm < INTERVALO_DO_DIGITANDO_MS) {
      return { ok: true };
    }
    socket.data.digitandoEm = ativo ? agora : 0;
    try {
      await this.webchat.avisarDigitando(
        { id: socket.data.visitanteId },
        ativo,
      );
      return { ok: true };
    } catch (erro) {
      return this.falha(erro);
    }
  }

  @SubscribeMessage(PEDIDOS_DO_VISITANTE.LIDO)
  @NoBancoComoSistema()
  async lido(@ConnectedSocket() socket: SocketDoVisitante): Promise<Resposta> {
    try {
      await this.webchat.marcarLidas({ id: socket.data.visitanteId });
      return { ok: true };
    } catch (erro) {
      return this.falha(erro);
    }
  }

  // R35.2: o visitante do chat do site não é usuário do CRM; o canal confere o token.
  @NoBancoComoSistema()
  private async autenticar(
    socket: SocketDoVisitante,
  ): Promise<DadosDoSocketDoVisitante> {
    const { handshake } = socket;
    const ip = ipDoHandshake(handshake.headers, handshake.address);
    if (!this.webchat.podeConectar(ip)) {
      throw new RecusaDoVisitante(
        'muitas_tentativas',
        'Muitas conexões em pouco tempo. Tente de novo em instantes.',
      );
    }
    const auth = (handshake.auth ?? {}) as Record<string, unknown>;
    const chave = typeof auth.chave === 'string' ? auth.chave : '';
    const token = typeof auth.token === 'string' ? auth.token : '';
    let canal;
    try {
      canal = await this.webchat.canalPelaChave(chave);
    } catch {
      throw new RecusaDoVisitante(
        'nao_encontrado',
        'Este chat não está disponível.',
      );
    }
    const origem = handshake.headers.origin;
    if (!this.webchat.origemAceita(canal, origem)) {
      throw new RecusaDoVisitante(
        'origem_nao_permitida',
        'Este site não está autorizado a usar o chat.',
      );
    }
    try {
      const visitante = await this.webchat.autenticar(canal.canal, token);
      return {
        visitanteId: visitante.id,
        canalId: canal.canal.id,
        digitandoEm: 0,
      };
    } catch (erro) {
      if (erro instanceof ErroApi) {
        throw new RecusaDoVisitante('nao_autenticado', erro.mensagem);
      }
      throw erro;
    }
  }

  private falha(erro: unknown): Resposta {
    if (erro instanceof ErroApi) {
      return { ok: false, erro: 'dados_invalidos', mensagem: erro.mensagem };
    }
    this.logger.warn(
      `Falha num pedido do visitante: ${erro instanceof Error ? erro.message : String(erro)}`,
    );
    return {
      ok: false,
      erro: 'erro_interno',
      mensagem: 'Não foi possível agora. Tente de novo.',
    };
  }
}

/**
 * IP do visitante: atrás do Caddy (um salto de proxy, como o `trust proxy` do
 * HTTP), o último item de `X-Forwarded-For`; senão, o endereço da conexão.
 */
export function ipDoHandshake(
  cabecalhos: Record<string, string | string[] | undefined>,
  endereco: string,
): string {
  const encaminhado = cabecalhos['x-forwarded-for'];
  const lista = (
    Array.isArray(encaminhado) ? encaminhado.join(',') : (encaminhado ?? '')
  )
    .split(',')
    .map((parte) => parte.trim())
    .filter(Boolean);
  return lista.at(-1) ?? endereco;
}
