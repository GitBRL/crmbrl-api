import { io, type Socket } from 'socket.io-client';
import { NOME_COOKIE_SESSAO } from '../../src/auth/cookies';
import {
  CAMINHO_SOCKET_IO,
  type CargasDoServidor,
  type EventoDoServidor,
  NAMESPACE_TEMPO_REAL,
  type RespostaDoTempoReal,
} from '../../src/tempo-real/catalogo';
import type { AppTeste } from './app-teste';
import { ORIGEM_DE_TESTE } from './ambiente-teste';
import type { ClienteHttp } from './clientes';

/** Cliente Socket.IO de verdade, ligado à API de teste. */
export type SocketDeTeste = Socket;

export interface OpcoesDoSocketDeTeste {
  /** `Origin` do handshake (padrão: a origem permitida dos testes; `null` = sem). */
  origem?: string | null;
  /** Prazo para conectar, em ms (padrão 5 s). */
  prazoMs?: number;
}

/** Resultado de uma tentativa de conexão (para testar recusas). */
export type TentativaDeConexao =
  | { conectado: true; socket: SocketDeTeste }
  | {
      conectado: false;
      /** `nao_autenticado`, `origem_nao_permitida` ou `troca_de_senha_pendente`. */
      erro: string;
      mensagem?: string;
    };

function criarSocket(
  base: string,
  cookie: string | undefined,
  opcoes: OpcoesDoSocketDeTeste,
): SocketDeTeste {
  const origem = opcoes.origem === undefined ? ORIGEM_DE_TESTE : opcoes.origem;
  return io(`${base}${NAMESPACE_TEMPO_REAL}`, {
    path: CAMINHO_SOCKET_IO,
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
    timeout: opcoes.prazoMs ?? 5_000,
    extraHeaders: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(origem ? { Origin: origem } : {}),
    },
  });
}

/**
 * Tenta conectar ao `/tempo-real` com o cookie do cliente (ou nenhum) e diz
 * se conseguiu. A API passa a ouvir numa porta livre (`t.escutar()`).
 *
 * ```ts
 * const r = await tentarConectarTempoReal(t, undefined);
 * expect(r).toMatchObject({ conectado: false, erro: 'nao_autenticado' });
 * ```
 */
export async function tentarConectarTempoReal(
  t: AppTeste,
  cliente: Pick<ClienteHttp, 'cookie'> | string | undefined,
  opcoes: OpcoesDoSocketDeTeste = {},
): Promise<TentativaDeConexao> {
  const base = await t.escutar();
  const cookie =
    typeof cliente === 'string'
      ? cliente.startsWith(`${NOME_COOKIE_SESSAO}=`)
        ? cliente
        : `${NOME_COOKIE_SESSAO}=${cliente}`
      : cliente?.cookie;
  const socket = criarSocket(base, cookie, opcoes);
  return new Promise<TentativaDeConexao>((resolver) => {
    socket.once('connect', () => resolver({ conectado: true, socket }));
    socket.once('connect_error', (erro: Error & { data?: unknown }) => {
      socket.close();
      const dados = erro.data as
        { erro?: string; mensagem?: string } | undefined;
      resolver({
        conectado: false,
        erro: dados?.erro ?? erro.message,
        mensagem: dados?.mensagem,
      });
    });
  });
}

/** Conecta ao `/tempo-real` como o cliente logado; lança se a conexão for recusada. */
export async function conectarTempoReal(
  t: AppTeste,
  cliente: Pick<ClienteHttp, 'cookie'>,
  opcoes: OpcoesDoSocketDeTeste = {},
): Promise<SocketDeTeste> {
  const tentativa = await tentarConectarTempoReal(t, cliente, opcoes);
  if (!tentativa.conectado) {
    throw new Error(`Conexão do tempo real recusada: ${tentativa.erro}`);
  }
  return tentativa.socket;
}

/** Espera o próximo `evento` no socket (lança depois de `prazoMs`). */
export function esperarEvento<E extends EventoDoServidor>(
  socket: SocketDeTeste,
  evento: E,
  prazoMs?: number,
): Promise<CargasDoServidor[E]>;
export function esperarEvento<T = unknown>(
  socket: SocketDeTeste,
  evento: string,
  prazoMs?: number,
): Promise<T>;
export function esperarEvento(
  socket: SocketDeTeste,
  evento: string,
  prazoMs = 3_000,
): Promise<unknown> {
  return new Promise((resolver, rejeitar) => {
    const temporizador = setTimeout(() => {
      socket.off(evento, ouvir);
      rejeitar(new Error(`O evento "${evento}" não chegou em ${prazoMs} ms.`));
    }, prazoMs);
    const ouvir = (dados: unknown) => {
      clearTimeout(temporizador);
      resolver(dados);
    };
    socket.once(evento, ouvir);
  });
}

/** Garante que `evento` NÃO chega em `ms` (padrão 300 ms). */
export function semEvento(
  socket: SocketDeTeste,
  evento: string,
  ms = 300,
): Promise<void> {
  return new Promise((resolver, rejeitar) => {
    const ouvir = (dados: unknown) => {
      clearTimeout(temporizador);
      rejeitar(
        new Error(
          `O evento "${evento}" chegou sem ser esperado: ${JSON.stringify(dados)}`,
        ),
      );
    };
    const temporizador = setTimeout(() => {
      socket.off(evento, ouvir);
      resolver();
    }, ms);
    socket.once(evento, ouvir);
  });
}

/** Pedido do cliente com confirmação (`conversa.entrar`, `chat.entrar`…). */
export function pedirAoTempoReal(
  socket: SocketDeTeste,
  evento: string,
  dados: unknown,
  prazoMs = 3_000,
): Promise<RespostaDoTempoReal> {
  return socket
    .timeout(prazoMs)
    .emitWithAck(evento, dados) as Promise<RespostaDoTempoReal>;
}

/** Espera o socket cair (ex.: sessão revogada). Devolve o motivo do socket.io. */
export function esperarDesconexao(
  socket: SocketDeTeste,
  prazoMs = 3_000,
): Promise<string> {
  if (socket.disconnected) {
    return Promise.resolve('ja_desconectado');
  }
  return new Promise((resolver, rejeitar) => {
    const temporizador = setTimeout(
      () => rejeitar(new Error(`O socket não caiu em ${prazoMs} ms.`)),
      prazoMs,
    );
    socket.once('disconnect', (motivo) => {
      clearTimeout(temporizador);
      resolver(motivo);
    });
  });
}

/** Fecha os sockets do teste. */
export function fecharSockets(
  ...sockets: Array<SocketDeTeste | undefined>
): void {
  for (const socket of sockets) {
    socket?.close();
  }
}
