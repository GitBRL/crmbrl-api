import { Inject, Logger } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  type OnGatewayConnection,
  type OnGatewayDisconnect,
  type OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import type { Namespace } from 'socket.io';
import { SessoesService } from '../auth/sessoes.service';
import { ehUuid } from '../comum/validacao/parse-id.pipe';
import { AMBIENTE, type Ambiente } from '../config/ambiente';
import { autenticarHandshake, RecusaDeConexao } from './autenticacao-socket';
import {
  EVENTOS_DO_CLIENTE,
  EVENTOS_DO_SERVIDOR,
  NAMESPACE_TEMPO_REAL,
  OPCOES_DO_SOCKET_IO,
  type RespostaDoTempoReal,
  salas,
  type TipoDeSalaPedida,
} from './catalogo';
import {
  type DadosDoSocket,
  type SocketDoTempoReal,
  TempoRealService,
} from './tempo-real.service';

/** Intervalo mínimo entre dois "digitando: ativo" do mesmo socket na mesma sala. */
const INTERVALO_DO_DIGITANDO_MS = 2_000;

const RESPOSTA_OK: RespostaDoTempoReal = { ok: true };

/**
 * Gateway do tempo real (§2.2): namespace `/tempo-real` em `/api/socket.io`.
 *
 * - Handshake autenticado pelo cookie `crmbrl_sessao` e pela origem
 *   (`autenticarHandshake`); sem sessão válida, a conexão é recusada
 *   (`connect_error` com `message` = `nao_autenticado`, `origem_nao_permitida`
 *   ou `troca_de_senha_pendente`).
 * - Ao conectar: salas `usuario:<id>`, `papel:<papel>`, `area:<area>`,
 *   `lideres:<area>` (só líderes) e a interna `sessao:<id>` (derrubada quando
 *   a sessão é revogada).
 * - Pedidos do cliente: `conversa.entrar`/`sair`, `chat.entrar`/`sair` (com o
 *   autorizador do módulo dono) e `digitando` (repassado à sala, com limite).
 *
 * Os handlers nunca lançam: respondem `{ ok: false, erro, mensagem }` no ack.
 */
@WebSocketGateway({ ...OPCOES_DO_SOCKET_IO, namespace: NAMESPACE_TEMPO_REAL })
export class TempoRealGateway
  implements
    OnGatewayInit<Namespace>,
    OnGatewayConnection<SocketDoTempoReal>,
    OnGatewayDisconnect<SocketDoTempoReal>
{
  private readonly logger = new Logger('TempoReal');
  private readonly origensPermitidas: ReadonlySet<string>;

  constructor(
    @Inject(AMBIENTE) ambiente: Ambiente,
    private readonly sessoes: SessoesService,
    private readonly tempoReal: TempoRealService,
  ) {
    this.origensPermitidas = new Set(ambiente.origensPermitidas);
  }

  afterInit(namespace: Namespace): void {
    this.tempoReal.definirServidor(namespace);
    namespace.use((socket, next) => {
      autenticarHandshake(
        socket.handshake.headers,
        this.origensPermitidas,
        this.sessoes,
      )
        .then((resultado) => {
          if (!resultado.aceito) {
            next(new RecusaDeConexao(resultado.erro, resultado.mensagem));
            return;
          }
          const dados: DadosDoSocket = {
            usuario: resultado.usuario,
            conectadoEm: new Date(),
            digitandoEm: new Map(),
          };
          socket.data = dados;
          next();
        })
        .catch((erro: unknown) => {
          this.logger.warn(
            `Falha ao autenticar conexão do tempo real: ${erro instanceof Error ? erro.message : String(erro)}`,
          );
          next(
            new RecusaDeConexao(
              'nao_autenticado',
              'Não foi possível validar a sessão agora. Tente de novo.',
            ),
          );
        });
    });
  }

  async handleConnection(socket: SocketDoTempoReal): Promise<void> {
    const { usuario } = socket.data;
    const salasIniciais = [
      salas.usuario(usuario.id),
      salas.papel(usuario.papel),
      salas.sessao(usuario.sessaoId),
      ...(usuario.area ? [salas.area(usuario.area)] : []),
      ...(usuario.area && usuario.papel === 'LIDER'
        ? [salas.lideres(usuario.area)]
        : []),
    ];
    await socket.join(salasIniciais);
  }

  handleDisconnect(socket: SocketDoTempoReal): void {
    socket.data?.digitandoEm?.clear();
    if (socket.data?.usuario) {
      this.tempoReal.avisarDesconexao(socket.data.usuario.id);
    }
  }

  @SubscribeMessage(EVENTOS_DO_CLIENTE.CONVERSA_ENTRAR)
  entrarNaConversa(
    @ConnectedSocket() socket: SocketDoTempoReal,
    @MessageBody() dados: unknown,
  ): Promise<RespostaDoTempoReal> {
    return this.entrar(socket, 'conversa', idDe(dados, 'conversaId'));
  }

  @SubscribeMessage(EVENTOS_DO_CLIENTE.CONVERSA_SAIR)
  sairDaConversa(
    @ConnectedSocket() socket: SocketDoTempoReal,
    @MessageBody() dados: unknown,
  ): Promise<RespostaDoTempoReal> {
    return this.sair(socket, 'conversa', idDe(dados, 'conversaId'));
  }

  @SubscribeMessage(EVENTOS_DO_CLIENTE.CHAT_ENTRAR)
  entrarNoChat(
    @ConnectedSocket() socket: SocketDoTempoReal,
    @MessageBody() dados: unknown,
  ): Promise<RespostaDoTempoReal> {
    return this.entrar(socket, 'chat', idDe(dados, 'canalId'));
  }

  @SubscribeMessage(EVENTOS_DO_CLIENTE.CHAT_SAIR)
  sairDoChat(
    @ConnectedSocket() socket: SocketDoTempoReal,
    @MessageBody() dados: unknown,
  ): Promise<RespostaDoTempoReal> {
    return this.sair(socket, 'chat', idDe(dados, 'canalId'));
  }

  @SubscribeMessage(EVENTOS_DO_CLIENTE.DIGITANDO)
  digitando(
    @ConnectedSocket() socket: SocketDoTempoReal,
    @MessageBody() dados: unknown,
  ): RespostaDoTempoReal {
    const conversaId = idDe(dados, 'conversaId');
    const canalId = conversaId ? undefined : idDe(dados, 'canalId');
    const ativo =
      typeof dados === 'object' && dados !== null && 'ativo' in dados
        ? (dados as { ativo: unknown }).ativo !== false
        : true;
    const tipo: TipoDeSalaPedida | undefined = conversaId
      ? 'conversa'
      : canalId
        ? 'chat'
        : undefined;
    const id = conversaId ?? canalId;
    if (!tipo || !id) {
      return invalido('Informe conversaId ou canalId.');
    }
    const sala = tipo === 'conversa' ? salas.conversa(id) : salas.chat(id);
    if (!socket.rooms.has(sala)) {
      return {
        ok: false,
        erro: 'sem_permissao',
        mensagem: 'Entre na conversa antes de avisar que está digitando.',
      };
    }
    const agora = Date.now();
    const anterior = socket.data.digitandoEm.get(sala) ?? 0;
    if (ativo && agora - anterior < INTERVALO_DO_DIGITANDO_MS) {
      return RESPOSTA_OK;
    }
    socket.data.digitandoEm.set(sala, ativo ? agora : 0);
    const { usuario } = socket.data;
    socket.to(sala).emit(EVENTOS_DO_SERVIDOR.DIGITANDO, {
      ...(tipo === 'conversa' ? { conversaId: id } : { canalId: id }),
      ativo,
      usuario: { id: usuario.id, nome: usuario.nome },
    });
    this.tempoReal.avisarDigitando({ usuario, tipo, id, ativo });
    return RESPOSTA_OK;
  }

  private async entrar(
    socket: SocketDoTempoReal,
    tipo: TipoDeSalaPedida,
    id: string | undefined,
  ): Promise<RespostaDoTempoReal> {
    if (!id) {
      return invalido(
        tipo === 'conversa' ? 'Informe o conversaId.' : 'Informe o canalId.',
      );
    }
    try {
      const pode = await this.tempoReal.podeEntrar(
        socket.data.usuario,
        tipo,
        id,
      );
      if (!pode) {
        return {
          ok: false,
          erro: 'sem_permissao',
          mensagem:
            tipo === 'conversa'
              ? 'Você não tem acesso a esta conversa.'
              : 'Você não participa deste canal.',
        };
      }
      await socket.join(
        tipo === 'conversa' ? salas.conversa(id) : salas.chat(id),
      );
      return RESPOSTA_OK;
    } catch (erro) {
      this.logger.warn(
        `Falha ao autorizar a sala ${tipo}:${id}: ${erro instanceof Error ? erro.message : String(erro)}`,
      );
      return {
        ok: false,
        erro: 'erro_interno',
        mensagem: 'Não foi possível entrar agora. Tente de novo.',
      };
    }
  }

  private async sair(
    socket: SocketDoTempoReal,
    tipo: TipoDeSalaPedida,
    id: string | undefined,
  ): Promise<RespostaDoTempoReal> {
    if (!id) {
      return invalido(
        tipo === 'conversa' ? 'Informe o conversaId.' : 'Informe o canalId.',
      );
    }
    const sala = tipo === 'conversa' ? salas.conversa(id) : salas.chat(id);
    await socket.leave(sala);
    socket.data.digitandoEm.delete(sala);
    return RESPOSTA_OK;
  }
}

function idDe(
  dados: unknown,
  campo: 'conversaId' | 'canalId',
): string | undefined {
  if (typeof dados !== 'object' || dados === null) {
    return undefined;
  }
  const valor = (dados as Record<string, unknown>)[campo];
  return ehUuid(valor) ? valor.toLowerCase() : undefined;
}

function invalido(mensagem: string): RespostaDoTempoReal {
  return { ok: false, erro: 'dados_invalidos', mensagem };
}
