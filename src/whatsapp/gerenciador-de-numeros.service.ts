import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { toDataURL } from 'qrcode';
import type { Readable } from 'node:stream';
import { ArquivosService } from '../arquivos/arquivos.service';
import {
  avaliarTipo,
  descreverTamanho,
  resolverMime,
} from '../arquivos/politica';
import { AuditoriaService } from '../auditoria/auditoria.service';
import { FalhaDefinitivaDeEnvio } from '../canais/adaptador-canal';
import {
  type AtorDoComando,
  ESPERA_ENTRE_TENTATIVAS_DE_ENVIO_SEGUNDOS,
  ESPERA_MAXIMA_ENTRE_TENTATIVAS_DE_ENVIO_SEGUNDOS,
  type EstadoDoNumero,
  type EventoDoGateway,
  FILA_EVENTOS_WHATSAPP,
  filaDeEnvio,
  type PedidoDeEnvio,
  type ResultadoDaVerificacao,
  type SaudeDoGateway,
  TENTATIVAS_DE_ENVIO,
  telefoneDoJid,
} from '../canais/whatsapp/contrato-gateway';
import {
  dataDoDia,
  diaEmSaoPaulo,
  duracaoDoDigitando,
  esperaRestante,
  inicioDoProximoDia,
  lerConfiguracao,
  limiteDoDia,
  sortearIntervalo,
} from '../canais/whatsapp/protecoes';
import {
  type Ator,
  executarComoAtor,
} from '../comum/contexto/contexto-requisicao';
import { normalizarTelefone } from '../comum/dominio/telefone';
import {
  ConflitoException,
  DadosInvalidosException,
  NaoEncontradoException,
} from '../comum/erros/excecoes';
import { FilaService, type Trabalho } from '../fila/fila.service';
import type {
  Prisma,
  StatusWhatsapp,
  TipoMensagem,
  WhatsappNumero,
} from '../generated/prisma/client';
import { LogsTecnicosService } from '../logs/logs-tecnicos.service';
import { PrismaService, type Tx } from '../prisma/prisma.service';
import {
  ConversorDeMidia,
  ConversorIndisponivelError,
  MIME_DA_VOZ,
} from './midia/conversor-de-midia';
import { RELOGIO_DO_GATEWAY, type RelogioDoGateway } from './relogio';
import {
  type EnvioDoTransporte,
  FABRICA_DE_TRANSPORTE,
  type FabricaDeTransporte,
  LimiteDoWhatsapp,
  type MensagemDoTransporte,
  type MotivoDaQueda,
  type SessaoWhatsapp,
} from './transporte/transporte';

/** Ator das alterações feitas pelo gateway (auditoria, logs). */
const ATOR_DO_GATEWAY = {
  tipoAtor: 'SISTEMA',
  descricao: 'Gateway de WhatsApp',
  bancoComoSistema: true,
} as const;

/** Validade do primeiro QR e dos seguintes (como o WhatsApp Web). */
const VALIDADE_DO_PRIMEIRO_QR_MS = 60_000;
const VALIDADE_DO_QR_MS = 20_000;

/** Espera crescente da reconexão: 2 s, 4 s, 8 s… até 5 min. */
const ESPERA_INICIAL_DE_RECONEXAO_MS = 2_000;
const ESPERA_MAXIMA_DE_RECONEXAO_MS = 5 * 60_000;

/** Por quanto tempo a verificação "tem WhatsApp?" vale no cache. */
const VALIDADE_DA_VERIFICACAO_MS = 7 * 24 * 60 * 60_000;

/** Número pausado: o envio volta para a fila a cada 5 min, por até 24 h. */
const ESPERA_DO_NUMERO_PAUSADO_MS = 5 * 60_000;
const PRAZO_DO_NUMERO_PAUSADO_MS = 24 * 60 * 60_000;

/** Espera curta (sem gastar tentativa) por reconexão ou pela vez na ordem da conversa. */
const ESPERA_CURTA_DO_ENVIO_SEGUNDOS = 2;
/** Prazo de espera pela reconexão (equivale às tentativas com espera crescente). */
const PRAZO_DA_RECONEXAO_MS = 30 * 60_000;
/** Prazo de espera pela mensagem anterior da conversa, para uma presa não travar as outras. */
const PRAZO_DA_ORDEM_MS = 10 * 60_000;

/** Espalha os envios adiados para o dia seguinte (limite diário) nos primeiros minutos. */
const ESPALHAMENTO_DO_ADIAMENTO_MS = 30 * 60_000;

/** Status de mensagem que já saiu: o envio não se repete. */
const JA_ENVIADA = new Set(['ENVIADA', 'ENTREGUE', 'LIDA']);

/** Envios lembrados por processo (job repetido antes de a API gravar o `ENVIADA`). */
const ENVIOS_LEMBRADOS = 5_000;

interface SessaoAtiva {
  readonly sessao: SessaoWhatsapp;
  readonly canalId: string;
  status: StatusWhatsapp;
  telefone: string | null;
  motivo: string | null;
  qr: string | null;
  qrExpiraEm: Date | null;
  qrs: number;
}

/**
 * O coração do gateway (§2.3): uma sessão de transporte por número, o status
 * gravado em `whatsapp_numeros` e cada mudança publicada para a API na fila
 * `whatsapp.evento` (na mesma transação do status). Também consome as filas de
 * envio dos números (`whatsapp.envio.<numeroId>`, uma mensagem por vez).
 *
 * - Ao subir, reconecta os números que estavam conectados.
 * - Queda comum → reconexão com espera crescente; logout pelo celular → apaga
 *   as chaves e marca `DESCONECTADO`; QR que expirou sem leitura →
 *   `DESCONECTADO` (sem reconectar sozinho); banimento → `BANIDO`; erro grave →
 *   `ERRO`. Banimento e erro grave também pausam o número.
 * - QR → imagem (data URL, biblioteca `qrcode`) no evento `conexao`.
 * - Mídia recebida → `ArquivosService.salvar` (contexto `MENSAGEM`) antes de
 *   publicar; o tipo e o tamanho são conferidos antes do download (R11).
 * - **Proteções anti-banimento** em cada envio (R13, `protecoes.ts`): não
 *   repete mensagem já enviada, número pausado espera (até 24 h), opt-out (R4.6) e
 *   verificação do número nas mensagens ativas, limite diário com aquecimento
 *   (o excedente fica para o dia seguinte), ritmo aleatório entre envios,
 *   "digitando…"/"gravando…" antes, pausa automática depois de falhas
 *   seguidas ou de limite imposto pelo WhatsApp.
 * - Áudio de voz gravado no navegador → ogg/opus pelo `ffmpeg`.
 *
 * Uma instância do gateway só (as sessões vivem na memória deste processo).
 */
@Injectable()
export class GerenciadorDeNumeros
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger('Gateway');
  private readonly ativas = new Map<string, SessaoAtiva>();
  private readonly tentativasDeReconexao = new Map<string, number>();
  private readonly reconexoes = new Map<string, NodeJS.Timeout>();
  private readonly filasRegistradas = new Set<string>();
  private readonly cadeias = new Map<string, Promise<void>>();
  /** Último envio de cada número (ritmo entre envios). */
  private readonly ultimoEnvio = new Map<string, number>();
  /** Mensagens diferentes que falharam seguidas, por número (pausa automática). */
  private readonly falhasSeguidas = new Map<string, Set<string>>();
  /**
   * Envios que já saíram por este processo (id no WhatsApp → quando saiu). A
   * nova tentativa de uma mensagem que falhou ganha outro id e sai de novo.
   */
  private readonly enviadas = new Map<string, Date>();
  private parando = false;

  constructor(
    @Inject(FABRICA_DE_TRANSPORTE)
    private readonly transporte: FabricaDeTransporte,
    private readonly prisma: PrismaService,
    private readonly fila: FilaService,
    private readonly arquivos: ArquivosService,
    private readonly auditoria: AuditoriaService,
    private readonly logs: LogsTecnicosService,
    private readonly conversor: ConversorDeMidia,
    @Inject(RELOGIO_DO_GATEWAY) private readonly relogio: RelogioDoGateway,
  ) {}

  /** O transporte é o simulado? */
  get simulado(): boolean {
    return this.transporte.nome === 'simulado';
  }

  async onApplicationBootstrap(): Promise<void> {
    this.logger.log(
      `Gateway de WhatsApp com transporte ${this.transporte.nome}.`,
    );
    await executarComoAtor(ATOR_DO_GATEWAY, () => this.retomarNumeros()).catch(
      (erro: unknown) =>
        this.logger.warn(
          `Não foi possível retomar os números ao subir: ${mensagemDe(erro)}`,
        ),
    );
  }

  async onModuleDestroy(): Promise<void> {
    this.parando = true;
    for (const temporizador of this.reconexoes.values()) {
      clearTimeout(temporizador);
    }
    this.reconexoes.clear();
    await this.aguardarAvisos().catch(() => undefined);
    await Promise.all(
      [...this.ativas.values()].map((ativa) =>
        ativa.sessao.encerrar().catch(() => undefined),
      ),
    );
    this.ativas.clear();
  }

  /**
   * Inicia a conexão do número (idempotente: se já está ativa, só devolve o
   * estado). Uma pausa automática (erro grave, banimento, falhas) sai aqui:
   * reconectar pelo CRM é a decisão de voltar a usar o número.
   */
  async conectar(
    numeroId: string,
    ator?: AtorDoComando | null,
  ): Promise<EstadoDoNumero> {
    return executarComoAtor(atorDe(ator), async () => {
      const numero = await this.numero(numeroId);
      if (!this.ativas.has(numeroId)) {
        this.cancelarReconexao(numeroId);
        this.tentativasDeReconexao.set(numeroId, 0);
        this.falhasSeguidas.delete(numeroId);
        await this.tirarPausaAutomatica(numero);
        await this.abrirSessao(numeroId, numero.canalId, {
          telefone: numero.telefone,
          jaConectado: false,
        });
      }
      return this.estado(numeroId);
    });
  }

  /** Fecha a sessão; com `sair`, faz logout e apaga as chaves (precisa de QR novo). */
  async desconectar(
    numeroId: string,
    opcoes: { sair?: boolean } = {},
    ator?: AtorDoComando | null,
  ): Promise<EstadoDoNumero> {
    return executarComoAtor(atorDe(ator), async () => {
      const numero = await this.numero(numeroId);
      this.cancelarReconexao(numeroId);
      const ativa = this.ativas.get(numeroId);
      this.ativas.delete(numeroId);
      await ativa?.sessao
        .encerrar({ sair: opcoes.sair })
        .catch(() => undefined);
      await this.mudarStatus(numeroId, numero.canalId, {
        status: 'DESCONECTADO',
        motivo: opcoes.sair
          ? 'Número desvinculado pelo CRM.'
          : 'Desconectado pelo CRM.',
        apagarChaves: opcoes.sair ?? false,
        auditoria: {
          acao: 'whatsapp.desconectado',
          resumo: opcoes.sair
            ? `Número de WhatsApp "${numero.nome}" desvinculado`
            : `Número de WhatsApp "${numero.nome}" desconectado`,
        },
      });
      return this.estado(numeroId);
    });
  }

  /** Estado atual do número (banco + QR em memória). */
  async estado(numeroId: string): Promise<EstadoDoNumero> {
    const numero = await this.numero(numeroId);
    const ativa = this.ativas.get(numeroId);
    const qrValido =
      ativa?.qr && ativa.qrExpiraEm && ativa.qrExpiraEm > new Date()
        ? ativa
        : null;
    return {
      numeroId,
      canalId: numero.canalId,
      status: numero.status,
      telefone: numero.telefone,
      motivo: numero.motivo,
      qr: numero.status === 'AGUARDANDO_QR' ? (qrValido?.qr ?? null) : null,
      qrExpiraEm:
        numero.status === 'AGUARDANDO_QR'
          ? (qrValido?.qrExpiraEm?.toISOString() ?? null)
          : null,
    };
  }

  /** O telefone tem WhatsApp? Usa o cache de 7 dias (`whatsapp_verificacoes`). */
  async verificar(
    numeroId: string,
    telefoneInformado: string,
  ): Promise<ResultadoDaVerificacao> {
    const normalizado = normalizarTelefone(telefoneInformado);
    if (!normalizado.valido) {
      throw new DadosInvalidosException(normalizado.motivo);
    }
    const telefone = normalizado.telefone;
    const cache = await this.prisma.whatsappVerificacao.findUnique({
      where: { telefone },
    });
    if (
      cache &&
      this.relogio.agora() - cache.verificadoEm.getTime() <
        VALIDADE_DA_VERIFICACAO_MS
    ) {
      return { telefone, existe: cache.existe, jid: cache.jid, doCache: true };
    }
    const ativa = this.conectada(numeroId);
    const { existe, jid } = await ativa.sessao.verificar(telefone);
    await this.prisma.whatsappVerificacao.upsert({
      where: { telefone },
      create: { telefone, existe, jid },
      update: { existe, jid, verificadoEm: new Date() },
    });
    return { telefone, existe, jid, doCache: false };
  }

  /**
   * "Digitando…" do atendente para o contato (repassado pela API). Melhor
   * esforço: número desconectado ou falha do WhatsApp não são erro.
   */
  async digitando(
    numeroId: string,
    para: string,
    ativo: boolean,
  ): Promise<void> {
    await this.numero(numeroId);
    const ativa = this.ativas.get(numeroId);
    if (!ativa || ativa.status !== 'CONECTADO') {
      return;
    }
    await ativa.sessao.digitando(para, ativo).catch(() => undefined);
  }

  /** Para o `POST /simulador/receber`: uma mensagem "recebida" pelo número conectado. */
  async receberSimulada(
    numeroId: string,
    mensagem: MensagemDoTransporte,
  ): Promise<void> {
    this.conectada(numeroId);
    await this.processarRecebida(numeroId, mensagem);
  }

  /** Resumo para o `GET /saude`. */
  async saude(): Promise<SaudeDoGateway> {
    const numeros: SaudeDoGateway['numeros'] = {};
    for (const ativa of this.ativas.values()) {
      numeros[ativa.status] = (numeros[ativa.status] ?? 0) + 1;
    }
    let banco: SaudeDoGateway['banco'] = 'ok';
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      banco = 'erro';
    }
    const fila: SaudeDoGateway['fila'] = this.fila.pronto ? 'ok' : 'erro';
    return {
      status: banco === 'ok' && fila === 'ok' ? 'ok' : 'degradado',
      simulado: this.simulado,
      numeros,
      banco,
      fila,
    };
  }

  // -------------------------------------------------------------------------
  // Sessões
  // -------------------------------------------------------------------------

  /** Ao subir: reconecta quem estava conectado; QR que ficou pendente volta a desconectado. */
  private async retomarNumeros(): Promise<void> {
    const numeros = await this.prisma.whatsappNumero.findMany({
      where: {
        status: { in: ['CONECTADO', 'CONECTANDO', 'AGUARDANDO_QR'] },
        canal: { excluidoEm: null, tipo: 'WHATSAPP' },
      },
    });
    for (const numero of numeros) {
      if (numero.status === 'AGUARDANDO_QR' || !numero.telefone) {
        await this.mudarStatus(numero.id, numero.canalId, {
          status: 'DESCONECTADO',
          motivo: 'A leitura do QR não terminou antes de o serviço reiniciar.',
        });
        continue;
      }
      await this.abrirSessao(numero.id, numero.canalId, {
        telefone: numero.telefone,
        jaConectado: true,
      });
    }
    if (numeros.length > 0) {
      this.logger.log(`${numeros.length} número(s) retomado(s) ao subir.`);
    }
  }

  private async abrirSessao(
    numeroId: string,
    canalId: string,
    opcoes: { telefone: string | null; jaConectado: boolean },
  ): Promise<void> {
    await this.registrarFilaDeEnvio(numeroId);
    const sessao = this.transporte.criar(
      {
        numeroId,
        canalId,
        telefone: opcoes.telefone,
        jaConectado: opcoes.jaConectado,
      },
      {
        aoQr: (qr) =>
          this.emOrdem(numeroId, 'QR', () => this.aoQr(numeroId, sessao, qr)),
        aoConectar: (conta) =>
          this.emOrdem(numeroId, 'conexão', () =>
            this.aoConectar(numeroId, sessao, conta),
          ),
        aoCair: (queda) =>
          this.emOrdem(numeroId, 'queda', () =>
            this.aoCair(numeroId, sessao, queda),
          ),
        aoReceber: (mensagem) =>
          this.emOrdem(numeroId, 'mensagem recebida', () =>
            this.processarRecebida(numeroId, mensagem),
          ),
        aoStatus: (idExterno, status, em, erro) =>
          this.emOrdem(numeroId, 'status', () =>
            this.publicar({
              tipo: 'status',
              numeroId,
              canalId,
              idExterno,
              status,
              erro: erro ?? null,
              em: em.toISOString(),
            }),
          ),
        aoDigitando: (remetenteJid, telefone, ativo) =>
          this.emOrdem(numeroId, 'digitando', () =>
            this.publicar({
              tipo: 'digitando',
              numeroId,
              canalId,
              remetenteJid,
              telefone,
              ativo,
            }),
          ),
      },
    );
    this.ativas.set(numeroId, {
      sessao,
      canalId,
      status: 'CONECTANDO',
      telefone: opcoes.telefone,
      motivo: null,
      qr: null,
      qrExpiraEm: null,
      qrs: 0,
    });
    await this.mudarStatus(numeroId, canalId, {
      status: 'CONECTANDO',
      motivo: null,
    });
    await sessao.iniciar();
  }

  /** A sessão ainda é a ativa do número? (avisos de uma sessão já trocada são ignorados) */
  private ativaDa(
    numeroId: string,
    sessao: SessaoWhatsapp,
  ): SessaoAtiva | null {
    const ativa = this.ativas.get(numeroId);
    return ativa && ativa.sessao === sessao ? ativa : null;
  }

  private async aoQr(
    numeroId: string,
    sessao: SessaoWhatsapp,
    qr: string,
  ): Promise<void> {
    const ativa = this.ativaDa(numeroId, sessao);
    if (!ativa) {
      return;
    }
    ativa.qrs += 1;
    ativa.qr = await toDataURL(qr, { margin: 1, width: 320 });
    ativa.qrExpiraEm = new Date(
      Date.now() +
        (ativa.qrs === 1 ? VALIDADE_DO_PRIMEIRO_QR_MS : VALIDADE_DO_QR_MS),
    );
    await this.mudarStatus(numeroId, ativa.canalId, {
      status: 'AGUARDANDO_QR',
      motivo: null,
      qr: ativa.qr,
      qrExpiraEm: ativa.qrExpiraEm,
    });
  }

  private async aoConectar(
    numeroId: string,
    sessao: SessaoWhatsapp,
    conta: { telefone: string; jid: string; lid?: string | null },
  ): Promise<void> {
    const ativa = this.ativaDa(numeroId, sessao);
    if (!ativa) {
      return;
    }
    ativa.qr = null;
    ativa.qrExpiraEm = null;
    ativa.telefone = conta.telefone;
    this.tentativasDeReconexao.set(numeroId, 0);
    const numero = await this.numero(numeroId);
    // O mesmo celular em dois canais duplicaria cada conversa: o segundo não fica.
    const outro = await this.prisma.canal.findFirst({
      where: {
        tipo: 'WHATSAPP',
        idExterno: conta.telefone,
        excluidoEm: null,
        id: { not: ativa.canalId },
      },
      select: { nome: true },
    });
    if (outro) {
      this.ativas.delete(numeroId);
      await sessao.encerrar({ sair: true }).catch(() => undefined);
      const motivo = `Este celular já está conectado no canal "${outro.nome}". Use outro número ou desconecte aquele canal antes.`;
      await this.mudarStatus(numeroId, ativa.canalId, {
        status: 'ERRO',
        motivo,
        apagarChaves: true,
        auditoria: {
          acao: 'whatsapp.erro',
          resumo: `Número de WhatsApp "${numero.nome}": ${motivo}`,
        },
      });
      return;
    }
    await this.mudarStatus(numeroId, ativa.canalId, {
      status: 'CONECTADO',
      motivo: null,
      telefone: conta.telefone,
      jid: conta.jid,
      lid: conta.lid ?? null,
      conectado: true,
      auditoria:
        numero.status === 'CONECTADO'
          ? undefined
          : {
              acao: 'whatsapp.conectado',
              resumo: `Número de WhatsApp "${numero.nome}" conectado (${conta.telefone})`,
            },
    });
  }

  private async aoCair(
    numeroId: string,
    sessao: SessaoWhatsapp,
    queda: MotivoDaQueda,
  ): Promise<void> {
    const ativa = this.ativaDa(numeroId, sessao);
    if (!ativa) {
      return;
    }
    const numero = await this.numero(numeroId);
    if (
      queda.logout ||
      queda.banido ||
      queda.erroGrave ||
      queda.semLeituraDoQr
    ) {
      this.ativas.delete(numeroId);
      await ativa.sessao.encerrar().catch(() => undefined);
      const status: StatusWhatsapp = queda.banido
        ? 'BANIDO'
        : queda.erroGrave
          ? 'ERRO'
          : 'DESCONECTADO';
      await this.mudarStatus(numeroId, ativa.canalId, {
        status,
        motivo: queda.motivo,
        // Logout: as chaves não valem mais. QR sem leitura: as credenciais
        // ainda não registradas só atrapalhariam a próxima tentativa.
        apagarChaves: Boolean(queda.logout || queda.semLeituraDoQr),
        pausar: queda.banido || queda.erroGrave ? queda.motivo : undefined,
        auditoria: queda.semLeituraDoQr
          ? undefined
          : {
              acao:
                status === 'BANIDO'
                  ? 'whatsapp.banido'
                  : status === 'ERRO'
                    ? 'whatsapp.erro'
                    : 'whatsapp.desconectado',
              resumo: `Número de WhatsApp "${numero.nome}": ${queda.motivo}`,
            },
      });
      return;
    }
    // Queda comum: reconecta com espera crescente.
    this.ativas.delete(numeroId);
    await ativa.sessao.encerrar().catch(() => undefined);
    const tentativa = (this.tentativasDeReconexao.get(numeroId) ?? 0) + 1;
    this.tentativasDeReconexao.set(numeroId, tentativa);
    const esperaMs = Math.min(
      ESPERA_MAXIMA_DE_RECONEXAO_MS,
      ESPERA_INICIAL_DE_RECONEXAO_MS * 2 ** (tentativa - 1),
    );
    await this.mudarStatus(numeroId, ativa.canalId, {
      status: 'CONECTANDO',
      motivo: `${queda.motivo} Reconectando em ${Math.round(esperaMs / 1000)} s.`,
      tentativasReconexao: tentativa,
    });
    if (this.parando) {
      return;
    }
    this.cancelarReconexao(numeroId);
    const temporizador = setTimeout(() => {
      this.reconexoes.delete(numeroId);
      if (this.ativas.has(numeroId)) {
        return;
      }
      void executarComoAtor(ATOR_DO_GATEWAY, () =>
        this.abrirSessao(numeroId, ativa.canalId, {
          telefone: ativa.telefone,
          jaConectado: true,
        }),
      ).catch((erro: unknown) =>
        this.logger.warn(
          `Reconexão do número ${numeroId} falhou: ${mensagemDe(erro)}`,
        ),
      );
    }, esperaMs);
    temporizador.unref();
    this.reconexoes.set(numeroId, temporizador);
  }

  private cancelarReconexao(numeroId: string): void {
    clearTimeout(this.reconexoes.get(numeroId));
    this.reconexoes.delete(numeroId);
  }

  // -------------------------------------------------------------------------
  // Entrada
  // -------------------------------------------------------------------------

  /** Mensagem recebida: guarda a mídia (contexto MENSAGEM) e publica para a API. */
  private async processarRecebida(
    numeroId: string,
    mensagem: MensagemDoTransporte,
  ): Promise<void> {
    const ativa = this.ativas.get(numeroId);
    const canalId = ativa?.canalId ?? (await this.numero(numeroId)).canalId;
    const metadados: Record<string, unknown> = { ...mensagem.metadados };
    const arquivoId = mensagem.midia
      ? await this.guardarMidiaRecebida(mensagem, metadados)
      : null;
    await this.publicar({
      tipo: 'mensagem',
      numeroId,
      canalId,
      idExterno: mensagem.idExterno,
      remetenteJid: mensagem.remetenteJid,
      telefone: mensagem.telefone,
      nome: mensagem.nome ?? null,
      tipoMensagem: mensagem.tipo,
      texto: mensagem.texto ?? null,
      arquivoId,
      respondeAIdExterno: mensagem.respondeAIdExterno ?? null,
      metadados: Object.keys(metadados).length > 0 ? metadados : undefined,
      recebidaEm: mensagem.recebidaEm.toISOString(),
    });
    await this.prisma.whatsappNumero
      .update({ where: { id: numeroId }, data: { ultimoEventoEm: new Date() } })
      .catch(() => undefined);
  }

  /**
   * Guarda a mídia recebida e devolve o id do arquivo. Tipo recusado ou grande
   * demais (R11) não é baixado; falha no download não perde a mensagem: ela
   * chega sem o anexo, com o motivo em `metadados`.
   */
  private async guardarMidiaRecebida(
    mensagem: MensagemDoTransporte,
    metadados: Record<string, unknown>,
  ): Promise<string | null> {
    const midia = mensagem.midia;
    if (!midia) {
      return null;
    }
    const mime = resolverMime(midia.mime, midia.nome);
    const politica = avaliarTipo(mime, 'MENSAGEM');
    const recusar = (motivo: string): null => {
      metadados.midiaRecusada = motivo;
      metadados.midiaNome = midia.nome;
      return null;
    };
    if (!politica.aceito) {
      return recusar(politica.motivo);
    }
    const tamanho = midia.tamanho ?? midia.conteudo?.length ?? undefined;
    if (tamanho !== undefined && tamanho > politica.limiteBytes) {
      return recusar(
        `O arquivo passa do limite de ${descreverTamanho(politica.limiteBytes)}.`,
      );
    }
    let conteudo: Buffer | Readable;
    try {
      if (midia.conteudo) {
        conteudo = midia.conteudo;
      } else if (midia.baixar) {
        conteudo = await midia.baixar();
      } else {
        return recusar('A mídia não veio com a mensagem.');
      }
    } catch (erro) {
      this.logger.warn(
        `Mídia da mensagem ${mensagem.idExterno} não baixou: ${mensagemDe(erro)}`,
      );
      metadados.midiaFalhou =
        'Não foi possível baixar a mídia do WhatsApp. Peça para o contato enviar de novo.';
      metadados.midiaNome = midia.nome;
      return null;
    }
    try {
      const arquivo = await this.arquivos.salvar(conteudo, {
        nome: midia.nome,
        mime,
        tamanho,
        contexto: 'MENSAGEM',
        duracaoSegundos: midia.duracaoSegundos ?? undefined,
        largura: midia.largura ?? undefined,
        altura: midia.altura ?? undefined,
      });
      return arquivo.id;
    } catch (erro) {
      return recusar(mensagemDe(erro));
    }
  }

  // -------------------------------------------------------------------------
  // Saída
  // -------------------------------------------------------------------------

  /** Cria (uma vez por processo) o trabalhador da fila de envio do número. */
  private async registrarFilaDeEnvio(numeroId: string): Promise<void> {
    const nome = filaDeEnvio(numeroId);
    if (this.filasRegistradas.has(nome)) {
      return;
    }
    this.filasRegistradas.add(nome);
    await this.fila.trabalhar<PedidoDeEnvio>(
      nome,
      (trabalho) => this.processarEnvio(trabalho),
      {
        tentativas: TENTATIVAS_DE_ENVIO,
        intervaloEntreTentativasSegundos:
          ESPERA_ENTRE_TENTATIVAS_DE_ENVIO_SEGUNDOS,
        esperaExponencial: true,
        esperaMaximaSegundos: ESPERA_MAXIMA_ENTRE_TENTATIVAS_DE_ENVIO_SEGUNDOS,
        concorrencia: 1,
        intervaloDeConsultaSegundos: 1,
      },
    );
  }

  /** Devolve o envio à fila em instantes, sem gastar tentativa. */
  private async reagendarEnvio(
    pedido: PedidoDeEnvio,
    esperaDesde: number,
  ): Promise<void> {
    await this.fila.enviar(
      filaDeEnvio(pedido.numeroId),
      { ...pedido, esperaDesde: new Date(esperaDesde).toISOString() },
      {
        atrasoSegundos: ESPERA_CURTA_DO_ENVIO_SEGUNDOS,
        tentativas: TENTATIVAS_DE_ENVIO,
        intervaloEntreTentativasSegundos:
          ESPERA_ENTRE_TENTATIVAS_DE_ENVIO_SEGUNDOS,
        esperaExponencial: true,
      },
    );
  }

  /** Há mensagem de saída da mesma conversa, criada antes e ainda pendente? */
  private async temAnteriorPendente(
    pedido: PedidoDeEnvio,
    criadoEm: Date,
  ): Promise<boolean> {
    const anteriores = await this.prisma.mensagem.findMany({
      where: {
        conversaId: pedido.conversaId,
        direcao: 'SAIDA',
        status: 'PENDENTE',
        excluidaEm: null,
        id: { not: pedido.mensagemId },
        OR: [
          { criadoEm: { lt: criadoEm } },
          { criadoEm, id: { lt: pedido.mensagemId } },
        ],
      },
      select: { idExterno: true },
      take: 20,
    });
    // Quem este processo já enviou só espera o evento de status voltar.
    return anteriores.some(
      ({ idExterno }) => !idExterno || !this.enviadas.has(idExterno),
    );
  }

  /**
   * Um envio da fila do número, com as proteções anti-banimento (R13). Número
   * desconectado ou falha passageira: lança (o pg-boss tenta de novo); na
   * última tentativa, ou numa falha definitiva, publica `FALHOU` com o motivo.
   * Número pausado: volta para a fila a cada 5 min, por até 24 h. Passou do
   * limite do dia: o envio vai para a fila de amanhã.
   */
  async processarEnvio(trabalho: Trabalho<PedidoDeEnvio>): Promise<void> {
    const pedido = trabalho.dados;
    const ultima = trabalho.tentativa > TENTATIVAS_DE_ENVIO;
    const falhar = (erro: string) => this.publicarFalha(pedido, erro);

    // Já saiu (job repetido depois de uma queda): não envia de novo.
    const mensagem = await this.prisma.mensagem.findUnique({
      where: { id: pedido.mensagemId },
      select: {
        status: true,
        excluidaEm: true,
        idExterno: true,
        criadoEm: true,
      },
    });
    if (mensagem?.excluidaEm) {
      return;
    }
    // Job de uma tentativa anterior (a nova tentativa ganhou outro id): fica sem efeito.
    if (mensagem?.idExterno && mensagem.idExterno !== pedido.idExterno) {
      this.logger.debug(
        `Envio ${pedido.mensagemId} ignorado: é de uma tentativa anterior da mensagem.`,
      );
      return;
    }
    if (mensagem?.status && JA_ENVIADA.has(mensagem.status)) {
      this.logger.debug(
        `Envio ${pedido.mensagemId} ignorado: a mensagem já está ${mensagem.status}.`,
      );
      return;
    }
    // Já saiu por este processo, mas a API ainda não gravou (job duplicado ou
    // falha ao publicar o status): só publica o ENVIADA de novo.
    const enviadaAntes = this.enviadas.get(pedido.idExterno);
    if (enviadaAntes) {
      await this.publicarEnviada(pedido, enviadaAntes);
      return;
    }

    const agoraEspera = this.relogio.agora();
    const esperaDesde = pedido.esperaDesde
      ? Date.parse(pedido.esperaDesde)
      : agoraEspera;
    const ativa = this.ativas.get(pedido.numeroId);
    if (!ativa || ativa.status !== 'CONECTADO') {
      if (ultima || agoraEspera - esperaDesde >= PRAZO_DA_RECONEXAO_MS) {
        await falhar('O número de WhatsApp está desconectado.');
        return;
      }
      // Esperado (queda, reinício, reconexão): volta em instantes, sem gastar
      // tentativa nem espalhar os envios pela espera crescente (a ordem fica).
      await this.reagendarEnvio(pedido, esperaDesde);
      return;
    }
    // Ordem da conversa: com uma mensagem anterior ainda pendente, espera a vez.
    if (
      mensagem &&
      agoraEspera - esperaDesde < PRAZO_DA_ORDEM_MS &&
      (await this.temAnteriorPendente(pedido, mensagem.criadoEm))
    ) {
      await this.reagendarEnvio(pedido, esperaDesde);
      return;
    }
    const numero = await this.prisma.whatsappNumero.findUnique({
      where: { id: pedido.numeroId },
    });
    if (!numero) {
      await falhar('O número de WhatsApp foi removido do CRM.');
      return;
    }
    if (numero.pausadoEm) {
      // Pausado: o envio volta para a fila daqui a pouco (sem gastar as
      // tentativas), até a retomada ou o prazo.
      const agoraMs = this.relogio.agora();
      const desde = pedido.adiadoDesde
        ? Date.parse(pedido.adiadoDesde)
        : agoraMs;
      if (agoraMs - desde >= PRAZO_DO_NUMERO_PAUSADO_MS) {
        await falhar(
          `O número de WhatsApp ficou pausado por mais de 24 horas${numero.pausaMotivo ? ` (${numero.pausaMotivo})` : ''}. Retome o número e tente de novo.`,
        );
        return;
      }
      await this.fila.enviar(
        filaDeEnvio(pedido.numeroId),
        { ...pedido, adiadoDesde: new Date(desde).toISOString() },
        { executarEm: new Date(agoraMs + ESPERA_DO_NUMERO_PAUSADO_MS) },
      );
      return;
    }
    const configuracao = lerConfiguracao(numero.configuracao);
    const ativaDoContato = !pedido.respostaAoContato;

    // Opt-out (R4.6): mensagem ativa para quem pediu para não receber.
    if (ativaDoContato) {
      const contato = await this.prisma.contato.findUnique({
        where: { id: pedido.contatoId },
        select: { optOutMarketing: true },
      });
      if (contato?.optOutMarketing) {
        await falhar(
          'O contato pediu para não receber mensagens (opt-out). Só dá para responder quando ele escrever.',
        );
        return;
      }
    }

    // Limite diário e aquecimento: o excedente fica para amanhã.
    const agora = new Date(this.relogio.agora());
    if (ativaDoContato || configuracao.limitarRespostas) {
      const enviadosHoje = await this.enviadosNoDia(numero.id, agora);
      const limite = limiteDoDia(numero, agora);
      if (enviadosHoje >= limite) {
        await this.adiarParaAmanha(pedido, agora, limite);
        return;
      }
    }

    // Verificação do número (mensagem ativa), com o cache de 7 dias.
    let para = pedido.para;
    if (ativaDoContato && configuracao.verificarNumero) {
      const telefone = telefoneDoJid(para);
      if (telefone) {
        const verificacao = await this.verificar(numero.id, telefone);
        if (!verificacao.existe) {
          await falhar('Este número não tem WhatsApp.');
          return;
        }
        if (verificacao.jid) {
          para = verificacao.jid;
        }
      }
    }

    let envio: EnvioDoTransporte;
    try {
      envio = await this.montarEnvio(pedido, para);
    } catch (erro) {
      if (erro instanceof FalhaDefinitivaDeEnvio) {
        await falhar(erro.message);
        return;
      }
      throw erro;
    }

    // Ritmo: espera aleatória desde o último envio do número.
    const intervalo = sortearIntervalo(
      numero.intervaloMinimoSegundos,
      numero.intervaloMaximoSegundos,
      () => this.relogio.aleatorio(),
    );
    await this.relogio.esperar(
      esperaRestante(
        this.ultimoEnvio.get(numero.id),
        intervalo,
        this.relogio.agora(),
      ),
    );

    // "Digitando…" (ou "gravando…" no áudio) antes de enviar.
    if (configuracao.digitando && pedido.digitando !== false) {
      const duracao = duracaoDoDigitando(
        envio.texto,
        configuracao.digitandoMaximoSegundos,
      );
      if (duracao > 0) {
        await ativa.sessao
          .digitando(para, true, envio.tipo === 'AUDIO')
          .catch(() => undefined);
        await this.relogio.esperar(duracao);
      }
    }

    // A conexão caiu durante as esperas: volta para a fila (não conta como falha do número).
    if (this.ativas.get(numero.id) !== ativa || ativa.status !== 'CONECTADO') {
      if (ultima) {
        await falhar('O número de WhatsApp está desconectado.');
        return;
      }
      throw new Error(
        `Número ${pedido.numeroId} caiu antes do envio ${pedido.mensagemId}: espera a reconexão.`,
      );
    }

    let enviadaEm: Date;
    try {
      ({ enviadaEm } = await ativa.sessao.enviar(envio));
    } catch (erro) {
      if (erro instanceof FalhaDefinitivaDeEnvio) {
        await falhar(erro.message);
        return;
      }
      if (erro instanceof LimiteDoWhatsapp) {
        await this.pausarAutomaticamente(
          numero,
          'O WhatsApp limitou os envios deste número. Espere algumas horas antes de retomar.',
        );
      } else {
        await this.registrarFalhaSeguida(
          numero,
          pedido.mensagemId,
          configuracao,
        );
      }
      if (ultima) {
        await falhar('Não foi possível enviar a mensagem pelo WhatsApp.');
        return;
      }
      throw erro;
    }
    // Saiu: daqui em diante, uma falha (ao publicar) só repete a publicação.
    this.lembrarEnviada(pedido.idExterno, enviadaEm);
    this.ultimoEnvio.set(numero.id, this.relogio.agora());
    this.falhasSeguidas.delete(numero.id);
    await this.publicarEnviada(pedido, enviadaEm, agora);
  }

  /** O envio pronto para o transporte: mídia lida (e convertida na voz) e a citação. */
  private async montarEnvio(
    pedido: PedidoDeEnvio,
    para: string,
  ): Promise<EnvioDoTransporte> {
    let midia: EnvioDoTransporte['midia'] = null;
    if (pedido.arquivoId) {
      let lido: Awaited<ReturnType<ArquivosService['lerConteudo']>>;
      try {
        lido = await this.arquivos.lerConteudo(pedido.arquivoId);
      } catch (erro) {
        if (erro instanceof NaoEncontradoException) {
          throw new FalhaDefinitivaDeEnvio(
            'O arquivo da mensagem não foi encontrado.',
            'sem_arquivo',
          );
        }
        throw erro;
      }
      midia = {
        conteudo: lido.conteudo,
        nome: lido.arquivo.nome,
        mime: lido.arquivo.mime,
      };
      if (pedido.tipo === 'AUDIO' && pedido.voz) {
        midia = await this.converterVoz(midia);
      } else if (pedido.tipo === 'IMAGEM' || pedido.tipo === 'VIDEO') {
        midia.miniatura = await this.conversor.miniatura(
          midia.conteudo,
          midia.nome,
        );
      }
    }
    const citada = pedido.respondeAIdExterno
      ? await this.prisma.mensagem.findUnique({
          where: {
            canalId_idExterno: {
              canalId: pedido.canalId,
              idExterno: pedido.respondeAIdExterno,
            },
          },
          select: { texto: true, direcao: true },
        })
      : null;
    return {
      idExterno: pedido.idExterno,
      para,
      tipo: pedido.tipo,
      texto: pedido.texto ?? null,
      midia,
      voz: pedido.tipo === 'AUDIO' && (pedido.voz ?? false),
      respondeAIdExterno: pedido.respondeAIdExterno ?? null,
      citada: citada
        ? { texto: citada.texto, deMim: citada.direcao === 'SAIDA' }
        : null,
      metadados: pedido.metadados ?? null,
    };
  }

  /**
   * Voz gravada no navegador → ogg/opus. Sem `ffmpeg`: no modo simulado o
   * áudio segue como veio; no real, só se já for ogg (senão o celular não toca).
   */
  private async converterVoz(
    midia: NonNullable<EnvioDoTransporte['midia']>,
  ): Promise<NonNullable<EnvioDoTransporte['midia']>> {
    try {
      const convertido = await this.conversor.paraVoz(
        midia.conteudo,
        midia.nome,
      );
      return {
        conteudo: convertido,
        nome: midia.nome.replace(/\.[a-z0-9]{1,8}$/i, '') + '.ogg',
        mime: MIME_DA_VOZ,
      };
    } catch (erro) {
      const jaEOgg = midia.mime.startsWith('audio/ogg');
      if (
        jaEOgg ||
        (this.simulado && erro instanceof ConversorIndisponivelError)
      ) {
        return { ...midia, mime: jaEOgg ? MIME_DA_VOZ : midia.mime };
      }
      this.logger.warn(`Conversão do áudio de voz falhou: ${mensagemDe(erro)}`);
      await this.logs
        .erro(
          'Gateway',
          'Conversão do áudio de voz para o WhatsApp falhou.',
          erro,
        )
        .catch(() => undefined);
      throw new FalhaDefinitivaDeEnvio(
        'Não foi possível converter o áudio para mensagem de voz.',
        'conversao_de_audio',
      );
    }
  }

  /**
   * `ENVIADA` para a API; com `contarEm`, conta o envio no dia na mesma
   * transação (a primeira vez; a republicação não conta de novo).
   */
  private async publicarEnviada(
    pedido: PedidoDeEnvio,
    enviadaEm: Date,
    contarEm?: Date,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx: Tx) => {
      if (contarEm) {
        await this.contarNoDia(tx, pedido.numeroId, contarEm, 'enviados');
      }
      await this.publicar(
        {
          tipo: 'status',
          numeroId: pedido.numeroId,
          canalId: pedido.canalId,
          idExterno: pedido.idExterno,
          status: 'ENVIADA',
          em: enviadaEm.toISOString(),
        },
        tx,
      );
    });
  }

  private lembrarEnviada(idExterno: string, enviadaEm: Date): void {
    this.enviadas.set(idExterno, enviadaEm);
    if (this.enviadas.size > ENVIOS_LEMBRADOS) {
      const maisAntiga = this.enviadas.keys().next().value;
      if (maisAntiga !== undefined) {
        this.enviadas.delete(maisAntiga);
      }
    }
  }

  private async publicarFalha(
    pedido: PedidoDeEnvio,
    erro: string,
  ): Promise<void> {
    const agora = new Date(this.relogio.agora());
    await this.prisma.$transaction(async (tx: Tx) => {
      await this.contarNoDia(tx, pedido.numeroId, agora, 'falhas');
      await this.publicar(
        {
          tipo: 'status',
          numeroId: pedido.numeroId,
          canalId: pedido.canalId,
          idExterno: pedido.idExterno,
          status: 'FALHOU',
          erro,
          em: agora.toISOString(),
        },
        tx,
      );
    });
  }

  /** Passou do limite do dia: o mesmo pedido volta para a fila, a partir de amanhã. */
  private async adiarParaAmanha(
    pedido: PedidoDeEnvio,
    agora: Date,
    limite: number,
  ): Promise<void> {
    const executarEm = new Date(
      inicioDoProximoDia(agora).getTime() +
        Math.round(this.relogio.aleatorio() * ESPALHAMENTO_DO_ADIAMENTO_MS),
    );
    await this.fila.enviar(filaDeEnvio(pedido.numeroId), pedido, {
      executarEm,
    });
    this.logger.log(
      `Envio ${pedido.mensagemId} adiado para ${executarEm.toISOString()}: o número ${pedido.numeroId} chegou ao limite de ${limite} envios hoje.`,
    );
  }

  private async enviadosNoDia(numeroId: string, agora: Date): Promise<number> {
    const contagem = await this.prisma.whatsappEnvioDiario.findUnique({
      where: {
        numeroId_dia: { numeroId, dia: dataDoDia(diaEmSaoPaulo(agora)) },
      },
      select: { enviados: true },
    });
    return contagem?.enviados ?? 0;
  }

  private async contarNoDia(
    tx: Tx,
    numeroId: string,
    agora: Date,
    campo: 'enviados' | 'falhas',
  ): Promise<void> {
    const dia = dataDoDia(diaEmSaoPaulo(agora));
    await tx.whatsappEnvioDiario.upsert({
      where: { numeroId_dia: { numeroId, dia } },
      create: { numeroId, dia, [campo]: 1 },
      update: { [campo]: { increment: 1 } },
    });
  }

  /** Mais uma mensagem que não saiu; com N mensagens diferentes seguidas, pausa o número. */
  private async registrarFalhaSeguida(
    numero: WhatsappNumero,
    mensagemId: string,
    configuracao: ReturnType<typeof lerConfiguracao>,
  ): Promise<void> {
    const falhas = this.falhasSeguidas.get(numero.id) ?? new Set<string>();
    falhas.add(mensagemId);
    this.falhasSeguidas.set(numero.id, falhas);
    const limite = configuracao.pausarAposFalhasSeguidas;
    if (limite > 0 && falhas.size >= limite) {
      this.falhasSeguidas.delete(numero.id);
      await this.pausarAutomaticamente(
        numero,
        `${falhas.size} mensagens seguidas não saíram. Confira o número no celular antes de retomar.`,
      );
    }
  }

  /** Pausa automática (falhas, limite do WhatsApp): nada sai até alguém retomar ou reconectar. */
  private async pausarAutomaticamente(
    numero: WhatsappNumero,
    motivo: string,
  ): Promise<void> {
    const pausou = await this.prisma.$transaction(async (tx: Tx) => {
      const atual = await tx.whatsappNumero.findUnique({
        where: { id: numero.id },
        select: { pausadoEm: true, configuracao: true },
      });
      if (!atual || atual.pausadoEm) {
        return false;
      }
      await tx.whatsappNumero.update({
        where: { id: numero.id },
        data: {
          pausadoEm: new Date(),
          pausaMotivo: motivo,
          configuracao: {
            ...objetoDe(atual.configuracao),
            pausaAutomatica: true,
          } as Prisma.InputJsonObject,
        },
      });
      await this.auditoria.registrar(tx, {
        acao: 'whatsapp.pausado',
        entidade: 'whatsapp_numero',
        entidadeId: numero.id,
        resumo: `Número de WhatsApp "${numero.nome}" pausado automaticamente: ${motivo}`,
        dados: { canalId: numero.canalId, motivo, automatica: true },
      });
      await this.publicarConexaoAtual(tx, numero.id);
      return true;
    });
    if (pausou) {
      this.logger.warn(
        `Número ${numero.id} pausado automaticamente: ${motivo}`,
      );
    }
  }

  /** Reconectar pelo CRM tira a pausa automática (a manual fica). */
  private async tirarPausaAutomatica(numero: WhatsappNumero): Promise<void> {
    if (
      !numero.pausadoEm ||
      !lerConfiguracao(numero.configuracao).pausaAutomatica
    ) {
      return;
    }
    await this.prisma.$transaction(async (tx: Tx) => {
      await tx.whatsappNumero.update({
        where: { id: numero.id },
        data: {
          pausadoEm: null,
          pausaMotivo: null,
          configuracao: {
            ...objetoDe(numero.configuracao),
            pausaAutomatica: false,
          } as Prisma.InputJsonObject,
        },
      });
      await this.auditoria.registrar(tx, {
        acao: 'whatsapp.retomado',
        entidade: 'whatsapp_numero',
        entidadeId: numero.id,
        resumo: `Número de WhatsApp "${numero.nome}" retomado ao reconectar`,
        dados: { canalId: numero.canalId, automatica: true },
      });
    });
  }

  // -------------------------------------------------------------------------
  // Apoio
  // -------------------------------------------------------------------------

  private async numero(numeroId: string): Promise<WhatsappNumero> {
    const numero = await this.prisma.whatsappNumero.findFirst({
      where: { id: numeroId, canal: { excluidoEm: null } },
    });
    if (!numero) {
      throw new NaoEncontradoException('Número de WhatsApp não encontrado.');
    }
    return numero;
  }

  private conectada(numeroId: string): SessaoAtiva {
    const ativa = this.ativas.get(numeroId);
    if (!ativa || ativa.status !== 'CONECTADO') {
      throw new ConflitoException('O número de WhatsApp não está conectado.', {
        status: ativa?.status ?? 'DESCONECTADO',
      });
    }
    return ativa;
  }

  /**
   * Grava o status do número e publica o evento `conexao` na mesma transação
   * (o job só existe se o status mudou de fato), com auditoria quando pedida.
   */
  private async mudarStatus(
    numeroId: string,
    canalId: string,
    mudanca: {
      status: StatusWhatsapp;
      motivo: string | null;
      telefone?: string;
      jid?: string;
      lid?: string | null;
      qr?: string;
      qrExpiraEm?: Date;
      conectado?: boolean;
      tentativasReconexao?: number;
      apagarChaves?: boolean;
      /** Pausa automática junto (erro grave, banimento), com este motivo. */
      pausar?: string;
      auditoria?: { acao: string; resumo: string };
    },
  ): Promise<void> {
    const ativa = this.ativas.get(numeroId);
    if (ativa) {
      ativa.status = mudanca.status;
      ativa.motivo = mudanca.motivo;
    }
    const agora = new Date();
    await this.prisma.$transaction(async (tx: Tx) => {
      if (mudanca.apagarChaves) {
        await tx.whatsappChave.deleteMany({ where: { numeroId } });
      }
      const antes = mudanca.pausar
        ? await tx.whatsappNumero.findUnique({
            where: { id: numeroId },
            select: { pausadoEm: true, configuracao: true },
          })
        : null;
      const numero = await tx.whatsappNumero.update({
        where: { id: numeroId },
        data: {
          status: mudanca.status,
          motivo: mudanca.motivo,
          ultimoEventoEm: agora,
          ...(mudanca.telefone ? { telefone: mudanca.telefone } : {}),
          ...(mudanca.jid ? { jid: mudanca.jid } : {}),
          ...(mudanca.lid !== undefined ? { lid: mudanca.lid } : {}),
          ...(mudanca.qr ? { ultimoQrEm: agora } : {}),
          ...(mudanca.conectado
            ? { conectadoEm: agora, tentativasReconexao: 0 }
            : {}),
          ...(mudanca.tentativasReconexao !== undefined
            ? { tentativasReconexao: mudanca.tentativasReconexao }
            : {}),
          ...(mudanca.status === 'DESCONECTADO' ||
          mudanca.status === 'BANIDO' ||
          mudanca.status === 'ERRO'
            ? { desconectadoEm: agora }
            : {}),
          ...(mudanca.pausar && antes && !antes.pausadoEm
            ? {
                pausadoEm: agora,
                pausaMotivo: mudanca.pausar,
                configuracao: {
                  ...objetoDe(antes.configuracao),
                  pausaAutomatica: true,
                } as Prisma.InputJsonObject,
              }
            : {}),
        },
      });
      if (mudanca.conectado && !numero.aquecimentoInicioEm) {
        await tx.whatsappNumero.update({
          where: { id: numeroId },
          data: { aquecimentoInicioEm: agora },
        });
      }
      if (mudanca.conectado && mudanca.telefone) {
        // O canal é roteado pelo telefone conectado (`canais.id_externo`).
        await tx.canal.update({
          where: { id: canalId },
          data: { idExterno: mudanca.telefone },
        });
      }
      if (mudanca.auditoria) {
        await this.auditoria.registrar(tx, {
          acao: mudanca.auditoria.acao,
          entidade: 'whatsapp_numero',
          entidadeId: numeroId,
          resumo: mudanca.auditoria.resumo,
          dados: {
            canalId,
            status: mudanca.status,
            ...(mudanca.motivo ? { motivo: mudanca.motivo } : {}),
            ...(numero.telefone ? { telefone: numero.telefone } : {}),
            ...(mudanca.pausar ? { pausado: true } : {}),
          },
        });
      }
      await this.publicar(
        {
          tipo: 'conexao',
          numeroId,
          canalId,
          status: mudanca.status,
          qr: mudanca.qr ?? null,
          qrExpiraEm: mudanca.qrExpiraEm?.toISOString() ?? null,
          telefone: numero.telefone,
          motivo: mudanca.motivo,
          em: agora.toISOString(),
        },
        tx,
      );
    });
  }

  /** Evento `conexao` com o status atual (ex.: depois de uma pausa), para a tela se atualizar. */
  private async publicarConexaoAtual(tx: Tx, numeroId: string): Promise<void> {
    const numero = await tx.whatsappNumero.findUniqueOrThrow({
      where: { id: numeroId },
      select: { canalId: true, status: true, telefone: true, motivo: true },
    });
    await this.publicar(
      {
        tipo: 'conexao',
        numeroId,
        canalId: numero.canalId,
        status: numero.status,
        qr: null,
        qrExpiraEm: null,
        telefone: numero.telefone,
        motivo: numero.motivo,
        em: new Date().toISOString(),
      },
      tx,
    );
  }

  private async publicar(evento: EventoDoGateway, tx?: Tx): Promise<void> {
    await this.fila.enviar(FILA_EVENTOS_WHATSAPP, evento, tx ? { tx } : {});
  }

  /**
   * Avisos do transporte: rodam fora do fluxo dele, como o gateway, um de cada
   * vez por número e na ordem em que chegaram (QR, conectado, mensagens,
   * status…), e nunca lançam.
   */
  private emOrdem(
    numeroId: string,
    descricao: string,
    fn: () => Promise<void>,
  ): void {
    const anterior = this.cadeias.get(numeroId) ?? Promise.resolve();
    const atual = anterior
      .then(() => executarComoAtor(ATOR_DO_GATEWAY, fn))
      .catch(async (erro: unknown) => {
        this.logger.warn(`Falha ao tratar ${descricao}: ${mensagemDe(erro)}`);
        await this.logs
          .erro('Gateway', `Falha ao tratar ${descricao} do WhatsApp.`, erro)
          .catch(() => undefined);
      });
    this.cadeias.set(numeroId, atual);
    void atual.finally(() => {
      if (this.cadeias.get(numeroId) === atual) {
        this.cadeias.delete(numeroId);
      }
    });
  }

  /** Espera os avisos pendentes de um número (testes e desligamento). */
  async aguardarAvisos(numeroId?: string): Promise<void> {
    const pendentes = numeroId
      ? [this.cadeias.get(numeroId)]
      : [...this.cadeias.values()];
    await Promise.all(pendentes.map((cadeia) => cadeia ?? Promise.resolve()));
  }
}

/** Tipo da mensagem pela mídia (para o simulador). */
export function tipoPelaMidia(mime: string): TipoMensagem {
  if (mime.startsWith('image/')) {
    return mime === 'image/webp' ? 'FIGURINHA' : 'IMAGEM';
  }
  if (mime.startsWith('audio/')) {
    return 'AUDIO';
  }
  if (mime.startsWith('video/')) {
    return 'VIDEO';
  }
  return 'DOCUMENTO';
}

/**
 * Quem pediu o comando na API (auditoria em nome dele), ou o próprio gateway.
 * O banco fica sempre no contexto de sistema (R35.2): a API já autorizou o comando.
 */
function atorDe(ator: AtorDoComando | null | undefined): Ator {
  return ator
    ? {
        tipoAtor: 'USUARIO',
        descricao: ator.nome,
        usuario: { id: ator.id, nome: ator.nome, papel: ator.papel },
        bancoComoSistema: true,
      }
    : ATOR_DO_GATEWAY;
}

function objetoDe(json: unknown): Record<string, unknown> {
  return json && typeof json === 'object' && !Array.isArray(json)
    ? (json as Record<string, unknown>)
    : {};
}

function mensagemDe(erro: unknown): string {
  return erro instanceof Error ? erro.message : String(erro);
}
