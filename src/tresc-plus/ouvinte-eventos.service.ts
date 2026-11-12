import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { io, type ManagerOptions, type SocketOptions } from 'socket.io-client';
import { AMBIENTE, type Ambiente } from '../config/ambiente';
import { ConexaoTrescPlusService } from './conexao.service';
import { type EventoNormalizado, normalizarEvento } from './eventos';
import { LigacoesTrescService } from './ligacoes-tresc.service';
import {
  CAMINHO_SOCKET_PADRAO,
  type FormatoDeEnvelope,
  RECONEXAO_BASE_MS,
  RECONEXAO_TETO_MS,
} from './tresc-plus.constantes';

/** O pedaço do socket.io-client que o ouvinte usa (os testes trocam por um falso). */
export interface SocketDoTrescPlus {
  on(evento: string, ouvinte: (...argumentos: unknown[]) => void): unknown;
  onAny(ouvinte: (evento: string, ...argumentos: unknown[]) => void): unknown;
  close(): unknown;
}

export type FabricaDeSocket = (
  url: string,
  opcoes: Partial<ManagerOptions & SocketOptions>,
) => SocketDoTrescPlus;

/** Token de injeção da fábrica do socket (a real é `io` do socket.io-client). */
export const FABRICA_DE_SOCKET_TRESC_PLUS = Symbol(
  'FABRICA_DE_SOCKET_TRESC_PLUS',
);

/**
 * Espera antes da próxima reconexão (ms): backoff exponencial de 1 s a 60 s com jitter de ±25%.
 * `tentativa` começa em 0. Pura e testável.
 */
export function esperaDeReconexao(
  tentativa: number,
  aleatorio: () => number = Math.random,
  baseMs: number = RECONEXAO_BASE_MS,
  tetoMs: number = RECONEXAO_TETO_MS,
): number {
  const bruta = Math.min(tetoMs, baseMs * 2 ** Math.min(tentativa, 20));
  return Math.round(bruta * (0.75 + 0.5 * aleatorio()));
}

/** Endereço do socket: o configurado ou o host da API. */
export function enderecoDoSocket(
  urlSocket: string | null,
  urlApi: string,
): string {
  return urlSocket ?? new URL(urlApi).origin;
}

/**
 * Ouvinte de eventos (R34.4): um socket.io-client por empresa, com o token do gestor na query
 * (`?token=`), em segundo plano. Reconecta com backoff (sem usar a reconexão do socket.io, para
 * o estado ficar no banco e o backoff ser testável). Cada evento passa pelo `normalizarEvento` (envelope
 * configurável) e é aplicado em série, na ordem em que chegou. O token nunca vai para log.
 */
@Injectable()
export class OuvinteDeEventosTrescPlus
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger('TrescPlusOuvinte');
  private socket: SocketDoTrescPlus | null = null;
  private tentativa = 0;
  private temporizador: NodeJS.Timeout | undefined;
  private parado = true;
  private geracao = 0;
  private formato: FormatoDeEnvelope = 'AUTO';
  private serie: Promise<void> = Promise.resolve();

  constructor(
    private readonly conexao: ConexaoTrescPlusService,
    private readonly ligacoes: LigacoesTrescService,
    @Inject(AMBIENTE) private readonly ambiente: Ambiente,
    @Inject(FABRICA_DE_SOCKET_TRESC_PLUS)
    private readonly fabrica: FabricaDeSocket,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.ambiente.trescPlus.ouvinteAtivo) return;
    this.conexao.aoMudar(() => this.reiniciar());
    await this.iniciar().catch((erro: unknown) =>
      this.logger.warn(`Ouvinte do 3C+ não iniciou: ${mensagemDe(erro)}`),
    );
  }

  onModuleDestroy(): void {
    this.parar();
  }

  /** Há um socket aberto (ou tentando)? */
  get ativo(): boolean {
    return !this.parado;
  }

  async reiniciar(): Promise<void> {
    this.parar();
    await this.iniciar();
  }

  async iniciar(): Promise<void> {
    const config = await this.conexao.ler();
    const token = this.conexao.tokenDaEmpresa(config);
    if (!config.ativa || !token) {
      await this.conexao.registrarEstadoDoOuvinte('desconectado');
      return;
    }
    try {
      // O token do gestor só vai para um host permitido (R34.1).
      this.conexao.exigirEnderecoPermitido(config);
    } catch {
      await this.conexao.registrarEstadoDoOuvinte('endereco_nao_permitido');
      return;
    }
    this.parado = false;
    this.formato = config.formatoEnvelope as FormatoDeEnvelope;
    this.conectar(
      enderecoDoSocket(config.urlSocket, config.urlApi),
      config.caminhoSocket || CAMINHO_SOCKET_PADRAO,
      token,
    );
  }

  parar(): void {
    this.parado = true;
    this.geracao += 1;
    clearTimeout(this.temporizador);
    this.temporizador = undefined;
    this.fechar();
  }

  private fechar(): void {
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      try {
        socket.close();
      } catch {
        // já fechado
      }
    }
  }

  private conectar(url: string, caminho: string, token: string): void {
    this.fechar();
    const geracao = this.geracao;
    const socket = this.fabrica(url, {
      path: caminho,
      transports: ['websocket'],
      query: { token },
      reconnection: false,
      timeout: 15_000,
    });
    this.socket = socket;
    const valida = (): boolean =>
      !this.parado && geracao === this.geracao && this.socket === socket;
    socket.on('connect', () => {
      if (!valida()) return;
      this.tentativa = 0;
      void this.conexao.registrarEstadoDoOuvinte('conectado');
      this.logger.log('Conectado ao socket do 3C+.');
    });
    socket.on('disconnect', () => {
      if (!valida()) return;
      void this.conexao.registrarEstadoDoOuvinte('reconectando');
      this.agendar(url, caminho, token, geracao);
    });
    socket.on('connect_error', (erro: unknown) => {
      if (!valida()) return;
      // Só a mensagem: o objeto do erro pode carregar a URL com o token.
      this.logger.warn(
        `Falha ao conectar ao socket do 3C+: ${mensagemDe(erro).replace(token, '***')}`,
      );
      void this.conexao.registrarEstadoDoOuvinte('erro');
      this.agendar(url, caminho, token, geracao);
    });
    socket.onAny((evento: string, ...argumentos: unknown[]) => {
      if (!valida()) return;
      const normalizado = normalizarEvento(evento, argumentos, this.formato);
      if (normalizado) this.enfileirar(normalizado);
    });
  }

  private agendar(
    url: string,
    caminho: string,
    token: string,
    geracao: number,
  ): void {
    if (this.parado || geracao !== this.geracao || this.temporizador) return;
    const espera = esperaDeReconexao(this.tentativa);
    this.tentativa += 1;
    this.fechar();
    this.temporizador = setTimeout(() => {
      this.temporizador = undefined;
      if (this.parado || geracao !== this.geracao) return;
      this.conectar(url, caminho, token);
    }, espera);
    this.temporizador.unref();
  }

  /** Aplica os eventos um a um, na ordem de chegada; uma falha não derruba o ouvinte. */
  private enfileirar(evento: EventoNormalizado): void {
    this.serie = this.serie.then(async () => {
      try {
        await this.ligacoes.processarEvento(evento);
      } catch (erro) {
        this.logger.warn(
          `Evento ${evento.tipo} do 3C+ falhou: ${mensagemDe(erro)}`,
        );
      }
    });
  }

  /** Para os testes: espera os eventos já recebidos terminarem de ser aplicados. */
  async aguardarFila(): Promise<void> {
    await this.serie;
  }
}

function mensagemDe(erro: unknown): string {
  return erro instanceof Error ? erro.message : String(erro);
}

/** A fábrica real do socket.io-client. */
export const FABRICA_REAL: FabricaDeSocket = (url, opcoes) =>
  io(url, opcoes) as unknown as SocketDoTrescPlus;
