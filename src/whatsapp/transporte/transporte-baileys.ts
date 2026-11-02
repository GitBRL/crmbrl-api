import type { Logger } from '@nestjs/common';
import type {
  BaileysEventMap,
  MiscMessageGenerationOptions,
  proto,
  WAMessage,
  WASocket,
  WAVersion,
} from 'baileys' with { 'resolution-mode': 'import' };
import {
  ehJidDeContato,
  jidDoTelefone,
  telefoneDoJid,
} from '../../canais/whatsapp/contrato-gateway';
import type { CriptografiaService } from '../../comum/criptografia/criptografia.service';
import type { PrismaService } from '../../prisma/prisma.service';
import {
  carregarEstadoDeAutenticacao,
  CredenciaisIlegiveisError,
  type EstadoDeAutenticacao,
} from './estado-de-autenticacao';
import {
  classificarQueda,
  conteudoDoEnvio,
  ehLimiteDoWhatsapp,
  interpretarConteudo,
  mensagemCitada,
  numeroDoProtobuf,
  presencaDigitando,
  statusDoRecibo,
} from './mensagens-baileys';
import {
  type EnvioDoTransporte,
  type FabricaDeTransporte,
  LimiteDoWhatsapp,
  type NumeroDaSessao,
  type OuvinteDaSessao,
  type SessaoWhatsapp,
} from './transporte';

/** O que o transporte usa do pacote `baileys` (só ESM: carregado com `import()`). */
export type ModuloBaileys = Pick<
  typeof import('baileys', { with: { 'resolution-mode': 'import' } }),
  | 'makeWASocket'
  | 'initAuthCreds'
  | 'BufferJSON'
  | 'proto'
  | 'makeCacheableSignalKeyStore'
  | 'fetchLatestWaWebVersion'
  | 'normalizeMessageContent'
  | 'downloadMediaMessage'
  | 'jidNormalizedUser'
>;

/** Carrega o Baileys (os testes de unidade passam um falso). */
export type CarregadorDoBaileys = () => Promise<ModuloBaileys>;

export const carregarBaileys: CarregadorDoBaileys = () => import('baileys');

export interface DependenciasDoBaileys {
  prisma: PrismaService;
  cripto: CriptografiaService;
  logger: Logger;
  carregar?: CarregadorDoBaileys;
  /** Busca a versão atual do WhatsApp Web ao conectar (padrão: sim; senão, a do pacote). */
  buscarVersao?: boolean;
}

/** Reinícios seguidos sem abrir a conexão (o 515 depois do QR é normal; em laço, não). */
const MAXIMO_DE_REINICIOS = 3;
/** Mensagens enviadas guardadas para o reenvio que o WhatsApp pede (`getMessage`). */
const MENSAGENS_GUARDADAS = 500;
/** Prazo para descobrir a versão atual do WhatsApp Web. */
const PRAZO_DA_VERSAO_MS = 5_000;
/** Grupos, listas de transmissão, status e canais: fora do atendimento. */
const JID_IGNORADO = /@(g\.us|broadcast|newsletter)$/;

/**
 * Transporte real (`WHATSAPP_SIMULADO=false`): Baileys, WebSocket direto com o
 * WhatsApp (sem navegador), uma sessão por número.
 *
 * - **Autenticação** no Postgres, cifrada (`estado-de-autenticacao.ts`).
 * - **QR**: cada `qr` do Baileys vai para o `aoQr` (o gerenciador gera a
 *   imagem e publica); o 515 que vem logo depois da leitura reabre o socket
 *   aqui mesmo, sem o gerenciador perceber.
 * - **Quedas** classificadas em `classificarQueda` (logout, banimento, erro
 *   grave, QR sem leitura ou queda comum, que o gerenciador reconecta).
 * - **Entrada**: só conversas com contatos (grupos, status e canais são
 *   ignorados); o remetente vai pelo telefone quando o WhatsApp o informa (ou
 *   pelo mapeamento LID → telefone), senão pelo `@lid`. A mídia é baixada só
 *   se a política de arquivos aceitar (o gerenciador chama `baixar`).
 * - **Saída**: `sendMessage` com o id gerado pela API (`messageId`), citação e
 *   miniatura; `rate-overlimit` vira `LimiteDoWhatsapp`.
 * - Não marca "online" ao conectar (o celular continua recebendo as
 *   notificações) e não pede o histórico completo; mensagens antigas da
 *   sincronização inicial não entram no Atendimento (só as `notify`).
 */
export class TransporteBaileys implements FabricaDeTransporte {
  readonly nome = 'baileys' as const;
  private modulo?: Promise<ModuloBaileys>;
  private versao?: Promise<WAVersion | undefined>;

  constructor(private readonly dependencias: DependenciasDoBaileys) {}

  criar(numero: NumeroDaSessao, ouvinte: OuvinteDaSessao): SessaoWhatsapp {
    return new SessaoBaileys(numero, ouvinte, {
      prisma: this.dependencias.prisma,
      cripto: this.dependencias.cripto,
      logger: this.dependencias.logger,
      baileys: () => this.carregar(),
      versao: () => this.versaoDoWhatsappWeb(),
    });
  }

  private carregar(): Promise<ModuloBaileys> {
    this.modulo ??= (this.dependencias.carregar ?? carregarBaileys)().catch(
      (erro: unknown) => {
        this.modulo = undefined;
        throw erro;
      },
    );
    return this.modulo;
  }

  /** A versão atual do WhatsApp Web (uma vez por processo); `undefined` = a do pacote. */
  private versaoDoWhatsappWeb(): Promise<WAVersion | undefined> {
    if (this.dependencias.buscarVersao === false) {
      return Promise.resolve(undefined);
    }
    this.versao ??= this.carregar()
      .then((baileys) =>
        baileys.fetchLatestWaWebVersion({
          signal: AbortSignal.timeout(PRAZO_DA_VERSAO_MS),
        }),
      )
      .then((resultado) => (resultado.isLatest ? resultado.version : undefined))
      .catch(() => undefined);
    return this.versao;
  }
}

interface ApoioDaSessao {
  prisma: PrismaService;
  cripto: CriptografiaService;
  logger: Logger;
  baileys: () => Promise<ModuloBaileys>;
  versao: () => Promise<WAVersion | undefined>;
}

class SessaoBaileys implements SessaoWhatsapp {
  private baileys: ModuloBaileys | null = null;
  private versao: WAVersion | undefined;
  private estado: EstadoDeAutenticacao | null = null;
  private socket: WASocket | null = null;
  private aberta = false;
  private encerrada = false;
  private reinicios = 0;
  private readonly enviadas = new Map<string, proto.IMessage>();
  private readonly inscritos = new Set<string>();
  private entrada: Promise<void> = Promise.resolve();
  private readonly loggerDoBaileys: LoggerDoBaileys;

  constructor(
    private readonly numero: NumeroDaSessao,
    private readonly ouvinte: OuvinteDaSessao,
    private readonly apoio: ApoioDaSessao,
  ) {
    this.loggerDoBaileys = criarLoggerDoBaileys(apoio.logger, {
      numero: numero.numeroId,
    });
  }

  async iniciar(): Promise<void> {
    try {
      const baileys = await this.apoio.baileys();
      this.baileys = baileys;
      this.estado = await carregarEstadoDeAutenticacao(this.numero.numeroId, {
        prisma: this.apoio.prisma,
        cripto: this.apoio.cripto,
        baileys: {
          initAuthCreds: baileys.initAuthCreds,
          BufferJSON: baileys.BufferJSON,
          reviverChaveDeSincronizacao: (valor) =>
            baileys.proto.Message.AppStateSyncKeyData.fromObject(
              valor as Record<string, unknown>,
            ),
        },
        avisar: (mensagem) => this.apoio.logger.warn(mensagem),
      });
      this.versao = await this.apoio.versao();
    } catch (erro) {
      if (!this.encerrada) {
        this.ouvinte.aoCair(
          erro instanceof CredenciaisIlegiveisError
            ? { motivo: erro.message, erroGrave: true }
            : {
                motivo: `Não foi possível iniciar a conexão com o WhatsApp (${mensagemDe(erro)}).`,
              },
        );
      }
      return;
    }
    if (!this.encerrada) {
      this.abrir();
    }
  }

  async encerrar(opcoes: { sair?: boolean } = {}): Promise<void> {
    if (this.encerrada) {
      return;
    }
    this.encerrada = true;
    const socket = this.socket;
    this.socket = null;
    const estavaAberta = this.aberta;
    this.aberta = false;
    if (socket) {
      if (opcoes.sair && estavaAberta) {
        this.estado?.desativar();
        await socket.logout().catch(() => undefined);
      } else {
        await socket.end(undefined).catch(() => undefined);
      }
    }
    await this.estado?.aguardarGravacoes().catch(() => undefined);
    this.estado?.desativar();
  }

  async enviar(envio: EnvioDoTransporte): Promise<{ enviadaEm: Date }> {
    const socket = this.socket;
    if (!socket || !this.aberta) {
      throw new Error('O número não está conectado ao WhatsApp agora.');
    }
    const conteudo = conteudoDoEnvio(envio);
    if (
      envio.midia?.miniatura &&
      ('image' in conteudo || 'video' in conteudo)
    ) {
      Object.assign(conteudo, { jpegThumbnail: envio.midia.miniatura });
    }
    const opcoes: MiscMessageGenerationOptions = {
      messageId: envio.idExterno,
    };
    if (envio.respondeAIdExterno) {
      opcoes.quoted = mensagemCitada(
        envio.para,
        envio.respondeAIdExterno,
        envio.citada,
      ) as WAMessage;
    }
    let enviada: WAMessage | undefined;
    try {
      enviada = await socket.sendMessage(envio.para, conteudo, opcoes);
    } catch (erro) {
      if (ehLimiteDoWhatsapp(erro)) {
        throw new LimiteDoWhatsapp();
      }
      throw erro;
    }
    if (enviada?.message) {
      this.guardarEnviada(envio.idExterno, enviada.message);
    }
    return { enviadaEm: new Date() };
  }

  async verificar(
    telefone: string,
  ): Promise<{ existe: boolean; jid: string | null }> {
    const socket = this.socket;
    if (!socket || !this.aberta) {
      throw new Error('O número não está conectado ao WhatsApp agora.');
    }
    const [resultado] = (await socket.onWhatsApp(telefone)) ?? [];
    return resultado?.exists
      ? { existe: true, jid: resultado.jid }
      : { existe: false, jid: null };
  }

  async digitando(
    para: string,
    ativo: boolean,
    gravando = false,
  ): Promise<void> {
    if (!this.socket || !this.aberta) {
      return;
    }
    await this.socket.sendPresenceUpdate(
      ativo ? (gravando ? 'recording' : 'composing') : 'paused',
      para,
    );
  }

  // -------------------------------------------------------------------------
  // Socket
  // -------------------------------------------------------------------------

  private abrir(): void {
    const baileys = this.baileys as ModuloBaileys;
    const estado = this.estado as EstadoDeAutenticacao;
    const socket = baileys.makeWASocket({
      auth: {
        creds: estado.state.creds,
        keys: baileys.makeCacheableSignalKeyStore(
          estado.state.keys,
          this.loggerDoBaileys,
        ),
      },
      logger: this.loggerDoBaileys,
      ...(this.versao ? { version: this.versao } : {}),
      markOnlineOnConnect: false,
      // Sem o histórico completo; a sincronização inicial fica (o Baileys tira
      // dela o mapeamento LID → telefone). O que chega por ela não é "notify"
      // e não entra no Atendimento.
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      shouldIgnoreJid: (jid: string) => JID_IGNORADO.test(jid),
      getMessage: (chave: proto.IMessageKey) =>
        Promise.resolve(chave.id ? this.enviadas.get(chave.id) : undefined),
    });
    this.socket = socket;
    socket.ev.on('creds.update', () => {
      void estado.salvarCredenciais().catch(() => undefined);
    });
    socket.ev.on('connection.update', (atualizacao) =>
      this.aoMudarConexao(socket, atualizacao),
    );
    socket.ev.on('messages.upsert', (evento) => {
      if (socket !== this.socket) {
        return;
      }
      this.entrada = this.entrada
        .then(() => this.aoReceber(socket, evento))
        .catch((erro: unknown) =>
          this.apoio.logger.warn(
            `Mensagem recebida do WhatsApp não foi tratada: ${mensagemDe(erro)}`,
          ),
        );
    });
    socket.ev.on('messages.update', (atualizacoes) => {
      if (socket === this.socket) {
        this.aoAtualizar(atualizacoes);
      }
    });
    socket.ev.on('presence.update', (presenca) => {
      if (socket !== this.socket) {
        return;
      }
      this.entrada = this.entrada
        .then(() => this.aoMudarPresenca(socket, presenca))
        .catch(() => undefined);
    });
  }

  private aoMudarConexao(
    socket: WASocket,
    atualizacao: BaileysEventMap['connection.update'],
  ): void {
    if (socket !== this.socket || this.encerrada) {
      return;
    }
    const baileys = this.baileys as ModuloBaileys;
    if (atualizacao.qr) {
      this.ouvinte.aoQr(atualizacao.qr);
    }
    if (atualizacao.connection === 'open') {
      this.aberta = true;
      this.reinicios = 0;
      const eu = socket.user;
      const jid = eu?.id ? baileys.jidNormalizedUser(eu.id) : '';
      const telefone = telefoneDoJid(jid);
      if (!telefone) {
        this.ouvinte.aoCair({
          motivo:
            'O WhatsApp conectou, mas não informou o número do celular. Tente conectar de novo.',
          erroGrave: true,
        });
        return;
      }
      this.ouvinte.aoConectar({
        telefone,
        jid,
        lid: eu?.lid ? baileys.jidNormalizedUser(eu.lid) : null,
      });
      return;
    }
    if (atualizacao.connection !== 'close') {
      return;
    }
    this.aberta = false;
    this.socket = null;
    const erro = atualizacao.lastDisconnect?.error;
    const codigo = (erro as { output?: { statusCode?: number } } | undefined)
      ?.output?.statusCode;
    const reacao = classificarQueda(codigo, erro?.message, {
      registrado: (this.estado as EstadoDeAutenticacao).registrado,
    });
    if (reacao.reiniciar) {
      if (this.reinicios < MAXIMO_DE_REINICIOS) {
        this.reinicios += 1;
        this.abrir();
        return;
      }
      this.ouvinte.aoCair({
        motivo: 'A conexão com o WhatsApp reiniciou várias vezes seguidas.',
      });
      return;
    }
    this.ouvinte.aoCair(reacao.queda);
  }

  private async aoReceber(
    socket: WASocket,
    evento: BaileysEventMap['messages.upsert'],
  ): Promise<void> {
    if (evento.type !== 'notify') {
      return;
    }
    const baileys = this.baileys as ModuloBaileys;
    for (const mensagem of evento.messages) {
      const chave = mensagem.key;
      const jid = chave.remoteJid;
      if (
        !mensagem.message ||
        chave.fromMe ||
        !chave.id ||
        !jid ||
        !ehJidDeContato(jid)
      ) {
        continue;
      }
      const interpretado = interpretarConteudo(
        baileys.normalizeMessageContent(mensagem.message),
        chave.id,
      );
      if (!interpretado) {
        continue;
      }
      const telefone = await this.telefoneDe(socket, jid, chave.remoteJidAlt);
      const remetenteJid = telefone
        ? jidDoTelefone(telefone)
        : baileys.jidNormalizedUser(jid);
      const segundos = numeroDoProtobuf(mensagem.messageTimestamp);
      this.ouvinte.aoReceber({
        idExterno: chave.id,
        remetenteJid,
        telefone,
        nome: mensagem.pushName ?? null,
        tipo: interpretado.tipo,
        texto: interpretado.texto,
        respondeAIdExterno: interpretado.respondeAIdExterno,
        metadados: {
          ...interpretado.metadados,
          ...(jid.endsWith('@lid')
            ? { lid: baileys.jidNormalizedUser(jid) }
            : {}),
        },
        midia: interpretado.midia
          ? {
              ...interpretado.midia,
              baixar: () =>
                baileys.downloadMediaMessage(
                  mensagem,
                  'stream',
                  {},
                  {
                    logger: this.loggerDoBaileys,
                    reuploadRequest: (original) =>
                      socket.updateMediaMessage(original),
                  },
                ),
            }
          : null,
        recebidaEm: segundos ? new Date(segundos * 1000) : new Date(),
      });
      this.inscreverPresenca(socket, remetenteJid);
    }
  }

  private aoAtualizar(atualizacoes: BaileysEventMap['messages.update']): void {
    for (const { key: chave, update: mudanca } of atualizacoes) {
      if (!chave.fromMe || !chave.id) {
        continue;
      }
      const status = statusDoRecibo(mudanca.status);
      if (status) {
        this.ouvinte.aoStatus(
          chave.id,
          status,
          new Date(),
          status === 'FALHOU'
            ? 'O WhatsApp não conseguiu entregar a mensagem.'
            : undefined,
        );
      }
    }
  }

  private async aoMudarPresenca(
    socket: WASocket,
    presenca: BaileysEventMap['presence.update'],
  ): Promise<void> {
    if (!ehJidDeContato(presenca.id)) {
      return;
    }
    const [atual] = Object.values(presenca.presences);
    const telefone = await this.telefoneDe(socket, presenca.id, undefined);
    const baileys = this.baileys as ModuloBaileys;
    this.ouvinte.aoDigitando(
      telefone
        ? jidDoTelefone(telefone)
        : baileys.jidNormalizedUser(presenca.id),
      telefone,
      presencaDigitando(atual?.lastKnownPresence),
    );
  }

  /** Telefone do contato: do JID, do JID alternativo ou do mapeamento LID → telefone. */
  private async telefoneDe(
    socket: WASocket,
    jid: string,
    alternativo: string | undefined,
  ): Promise<string | null> {
    const direto =
      telefoneDoJid(jid) ?? (alternativo ? telefoneDoJid(alternativo) : null);
    if (direto || !jid.endsWith('@lid')) {
      return direto;
    }
    const mapeado = await socket.signalRepository.lidMapping
      .getPNForLID(jid)
      .catch(() => null);
    return mapeado ? telefoneDoJid(mapeado) : null;
  }

  /** Pede ao WhatsApp a presença do contato (para receber o "digitando…"), uma vez por sessão. */
  private inscreverPresenca(socket: WASocket, jid: string): void {
    if (this.inscritos.has(jid)) {
      return;
    }
    this.inscritos.add(jid);
    void socket.presenceSubscribe(jid).catch(() => undefined);
  }

  private guardarEnviada(id: string, mensagem: proto.IMessage): void {
    this.enviadas.set(id, mensagem);
    if (this.enviadas.size > MENSAGENS_GUARDADAS) {
      const maisAntiga = this.enviadas.keys().next().value;
      if (maisAntiga !== undefined) {
        this.enviadas.delete(maisAntiga);
      }
    }
  }
}

/** O logger que o Baileys espera (o `ILogger` dele, no formato do pino). */
export interface LoggerDoBaileys {
  level: string;
  child(contexto: Record<string, unknown>): LoggerDoBaileys;
  trace(objeto: unknown, mensagem?: string): void;
  debug(objeto: unknown, mensagem?: string): void;
  info(objeto: unknown, mensagem?: string): void;
  warn(objeto: unknown, mensagem?: string): void;
  error(objeto: unknown, mensagem?: string): void;
}

/**
 * Logger no formato que o Baileys espera (pino), ligado ao logger do Nest:
 * erros viram avisos e avisos viram depuração — o Baileys avisa muito sobre
 * coisas normais (descriptografia repetida, reenvios).
 */
export function criarLoggerDoBaileys(
  logger: Logger,
  contexto: Record<string, unknown> = {},
): LoggerDoBaileys {
  const escrever =
    (nivel: 'warn' | 'debug') =>
    (objeto: unknown, mensagem?: string): void => {
      const detalhe =
        typeof objeto === 'string'
          ? objeto
          : objeto instanceof Error
            ? objeto.message
            : jsonCurto(objeto);
      const texto = [mensagem, detalhe].filter(Boolean).join(' — ');
      const numero =
        typeof contexto.numero === 'string' ? ` (${contexto.numero})` : '';
      logger[nivel](`Baileys${numero}: ${texto}`);
    };
  const nada = (): void => undefined;
  return {
    level: 'warn',
    child: (extra: Record<string, unknown>) =>
      criarLoggerDoBaileys(logger, { ...contexto, ...extra }),
    trace: nada,
    debug: nada,
    info: nada,
    warn: escrever('debug'),
    error: escrever('warn'),
  };
}

/** O objeto do log em JSON (até 500 caracteres); referência circular não derruba quem logou. */
function jsonCurto(objeto: unknown): string | undefined {
  try {
    return JSON.stringify(objeto)?.slice(0, 500);
  } catch {
    return '[objeto não serializável]';
  }
}

function mensagemDe(erro: unknown): string {
  return erro instanceof Error ? erro.message : String(erro);
}
