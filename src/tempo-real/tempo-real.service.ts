import { Injectable, Logger } from '@nestjs/common';
import type { Namespace, Socket } from 'socket.io';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import {
  type CargaNaoLidas,
  type CargaSessaoEncerrada,
  type CargasDoServidor,
  EVENTOS_DO_SERVIDOR,
  type EventoDoServidor,
  salas,
  type TipoDeSalaPedida,
} from './catalogo';

/** O que o socket de um usuário logado carrega (`socket.data`). */
export interface DadosDoSocket {
  usuario: UsuarioAutenticado;
  conectadoEm: Date;
  /** Último "digitando" repassado por sala (limite de frequência). */
  digitandoEm: Map<string, number>;
}

/** Socket do namespace `/tempo-real`. */
export type SocketDoTempoReal = Socket<
  Record<string, (...argumentos: unknown[]) => void>,
  Record<string, (...argumentos: unknown[]) => void>,
  Record<string, never>,
  DadosDoSocket
>;

/**
 * Decide se o usuário pode entrar numa sala pedida (`conversa:<id>`,
 * `chat:<canalId>`). Registrado pelo módulo dono (atendimento, chat interno).
 */
export type AutorizadorDeSala = (
  usuario: UsuarioAutenticado,
  id: string,
) => Promise<boolean>;

/** Aviso de "digitando" de alguém da equipe, para quem quiser repassá-lo (ex.: ao contato no WhatsApp). */
export interface AvisoDeDigitando {
  usuario: UsuarioAutenticado;
  tipo: TipoDeSalaPedida;
  /** `conversaId` ou `canalId`. */
  id: string;
  ativo: boolean;
}

export type OuvinteDeDigitando = (
  aviso: AvisoDeDigitando,
) => void | Promise<void>;

/** Um socket de um usuário caiu (ligações: tolerância antes de encerrar a ligação dele). */
export type OuvinteDeDesconexao = (usuarioId: string) => void | Promise<void>;

/** Opções de uma emissão. */
export interface OpcoesDeEmissao {
  /** Salas que NÃO recebem (ex.: a sala do próprio autor). */
  exceto?: string | readonly string[];
}

/**
 * Tempo real (§2.2): emissões para salas do namespace `/tempo-real` e o
 * controle das salas dos usuários.
 *
 * - `emitir(sala, evento, dados)` emite **na hora**: use só para efêmeros
 *   ("digitando", QR do WhatsApp). O que nasce de uma alteração no banco vai pelo
 *   `TempoRealPublicador.emitirAposCommit(tx, …)`, que só emite depois do commit.
 * - `adicionarASala`/`removerDaSala` mexem em todos os sockets do usuário (ex.:
 *   tirar da `conversa:<id>` quem perdeu acesso numa transferência).
 * - `registrarAutorizadorDeSala('conversa' | 'chat', fn)`: quem decide as
 *   entradas pedidas pelo cliente. Sem autorizador, ninguém entra.
 *
 * Uma instância só da API por enquanto: as emissões chegam aos sockets
 * conectados neste processo (com mais réplicas, seria preciso um adapter do
 * Socket.IO entre elas).
 */
@Injectable()
export class TempoRealService {
  private readonly logger = new Logger('TempoReal');
  private servidor?: Namespace;
  private readonly autorizadores = new Map<
    TipoDeSalaPedida,
    AutorizadorDeSala
  >();
  private readonly ouvintesDeDigitando: OuvinteDeDigitando[] = [];
  private readonly ouvintesDeDesconexao: OuvinteDeDesconexao[] = [];

  /** Chamado pelo gateway quando o namespace sobe. */
  definirServidor(servidor: Namespace): void {
    this.servidor = servidor;
  }

  /** O namespace já subiu (há servidor HTTP)? */
  get ativo(): boolean {
    return this.servidor !== undefined;
  }

  /** Emite agora para uma ou mais salas. Sem servidor (ex.: testes sem HTTP), não faz nada. */
  emitir<E extends EventoDoServidor>(
    sala: string | readonly string[],
    evento: E,
    dados: CargasDoServidor[E],
    opcoes?: OpcoesDeEmissao,
  ): void;
  emitir(
    sala: string | readonly string[],
    evento: string,
    dados: unknown,
    opcoes?: OpcoesDeEmissao,
  ): void;
  emitir(
    sala: string | readonly string[],
    evento: string,
    dados: unknown,
    opcoes: OpcoesDeEmissao = {},
  ): void {
    const servidor = this.servidor;
    const destino = typeof sala === 'string' ? [sala] : [...sala];
    if (!servidor || destino.length === 0) {
      return;
    }
    const excluidas =
      opcoes.exceto === undefined
        ? []
        : typeof opcoes.exceto === 'string'
          ? [opcoes.exceto]
          : [...opcoes.exceto];
    let operador = servidor.to(destino);
    if (excluidas.length > 0) {
      operador = operador.except(excluidas);
    }
    operador.emit(evento, dados);
  }

  /** Atalho: emite para todos os sockets de um usuário. */
  emitirParaUsuario<E extends EventoDoServidor>(
    usuarioId: string,
    evento: E,
    dados: CargasDoServidor[E],
  ): void {
    this.emitir(salas.usuario(usuarioId), evento, dados);
  }

  /** Atalho: contagens do menu (`nao-lidas`) de um usuário. */
  emitirNaoLidas(usuarioId: string, contagens: CargaNaoLidas): void {
    this.emitir(
      salas.usuario(usuarioId),
      EVENTOS_DO_SERVIDOR.NAO_LIDAS,
      contagens,
    );
  }

  /** Põe todos os sockets do usuário numa sala (ex.: membro novo de um grupo do chat). */
  adicionarASala(usuarioId: string, sala: string): void {
    this.servidor?.in(salas.usuario(usuarioId)).socketsJoin(sala);
  }

  /** Tira todos os sockets do usuário de uma sala (ex.: perdeu acesso à conversa). */
  removerDaSala(usuarioId: string, sala: string): void {
    this.servidor?.in(salas.usuario(usuarioId)).socketsLeave(sala);
  }

  /** Esvazia uma sala (ex.: canal do chat excluído). */
  esvaziarSala(sala: string): void {
    this.servidor?.in(sala).socketsLeave(sala);
  }

  /** O usuário tem algum socket conectado nesta instância? */
  async estaConectado(usuarioId: string): Promise<boolean> {
    if (!this.servidor) {
      return false;
    }
    const sockets = await this.servidor
      .in(salas.usuario(usuarioId))
      .fetchSockets();
    return sockets.length > 0;
  }

  /** Ids dos usuários conectados nesta instância (presença do chat interno). */
  async usuariosConectados(): Promise<string[]> {
    if (!this.servidor) {
      return [];
    }
    const sockets = await this.servidor.fetchSockets();
    return [
      ...new Set(
        sockets.map((socket) => (socket.data as DadosDoSocket).usuario.id),
      ),
    ];
  }

  /** Sessões com socket conectado nesta instância (varredura de sessões revogadas). */
  async sessoesConectadas(): Promise<string[]> {
    if (!this.servidor) {
      return [];
    }
    const sockets = await this.servidor.fetchSockets();
    return [
      ...new Set(
        sockets.map(
          (socket) => (socket.data as DadosDoSocket).usuario.sessaoId,
        ),
      ),
    ];
  }

  /** Derruba os sockets de uma sessão (sessão revogada: sair, desligamento, troca de senha). */
  encerrarSessao(
    sessaoId: string,
    motivo: CargaSessaoEncerrada['motivo'] = 'sessao_revogada',
  ): void {
    const servidor = this.servidor;
    if (!servidor) {
      return;
    }
    const sala = salas.sessao(sessaoId);
    servidor.to(sala).emit(EVENTOS_DO_SERVIDOR.SESSAO_ENCERRADA, { motivo });
    servidor.in(sala).disconnectSockets(true);
  }

  /** Derruba todos os sockets de um usuário. */
  desconectarUsuario(usuarioId: string): void {
    this.servidor?.in(salas.usuario(usuarioId)).disconnectSockets(true);
  }

  /** Registra quem autoriza as entradas em `conversa:<id>` ou `chat:<canalId>` (o último vale). */
  registrarAutorizadorDeSala(
    tipo: TipoDeSalaPedida,
    autorizador: AutorizadorDeSala,
  ): void {
    this.autorizadores.set(tipo, autorizador);
  }

  /** O usuário pode entrar na sala pedida? Sem autorizador registrado, não. */
  async podeEntrar(
    usuario: UsuarioAutenticado,
    tipo: TipoDeSalaPedida,
    id: string,
  ): Promise<boolean> {
    const autorizador = this.autorizadores.get(tipo);
    if (!autorizador) {
      return false;
    }
    return autorizador(usuario, id);
  }

  /** Recebe os "digitando" da equipe (ex.: o WhatsApp repassa "digitando…" ao contato). */
  aoDigitar(ouvinte: OuvinteDeDigitando): void {
    this.ouvintesDeDigitando.push(ouvinte);
  }

  /** Recebe a queda de qualquer socket de usuário (o ouvinte decide se a pessoa ficou sem nenhum). */
  aoDesconectar(ouvinte: OuvinteDeDesconexao): void {
    this.ouvintesDeDesconexao.push(ouvinte);
  }

  /** Chamado pelo gateway quando um socket cai. */
  avisarDesconexao(usuarioId: string): void {
    for (const ouvinte of this.ouvintesDeDesconexao) {
      Promise.resolve()
        .then(() => ouvinte(usuarioId))
        .catch((erro: unknown) =>
          this.logger.warn(
            `Ouvinte de desconexão falhou: ${erro instanceof Error ? erro.message : String(erro)}`,
          ),
        );
    }
  }

  /** Chamado pelo gateway depois de repassar um "digitando" à sala. */
  avisarDigitando(aviso: AvisoDeDigitando): void {
    for (const ouvinte of this.ouvintesDeDigitando) {
      Promise.resolve()
        .then(() => ouvinte(aviso))
        .catch((erro: unknown) =>
          this.logger.warn(
            `Ouvinte de "digitando" falhou: ${erro instanceof Error ? erro.message : String(erro)}`,
          ),
        );
    }
  }
}
