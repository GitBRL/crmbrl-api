/**
 * Apoio dos testes do WhatsApp: o processo do gateway sozinho (sem a API), com
 * um transporte roteirizado (o teste decide QR, conexão, quedas, recebimentos
 * e falhas de envio), um relógio que não espera de verdade e um conversor de
 * mídia falso. Os eventos publicados ficam na fila `whatsapp.evento`
 * (`gateway.eventos()`), sem ninguém para consumir.
 */
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { DRIVER_DE_ARQUIVOS } from '../src/arquivos/drivers/driver-de-arquivos';
import { DriverMemoria } from '../src/arquivos/drivers/driver-memoria';
import {
  CABECALHO_TOKEN_INTERNO,
  type EventoDoGateway,
  FILA_EVENTOS_WHATSAPP,
  filaDeEnvio,
  jidDoTelefone,
  type PedidoDeEnvio,
} from '../src/canais/whatsapp/contrato-gateway';
import type { Ambiente } from '../src/config/ambiente';
import { FilaService, type Trabalho } from '../src/fila/fila.service';
import type {
  StatusWhatsapp,
  TipoMensagem,
} from '../src/generated/prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { configurarGateway } from '../src/whatsapp/aplicacao-gateway';
import { GatewayWhatsappModule } from '../src/whatsapp/gateway-whatsapp.module';
import { GerenciadorDeNumeros } from '../src/whatsapp/gerenciador-de-numeros.service';
import { ConversorDeMidia } from '../src/whatsapp/midia/conversor-de-midia';
import {
  RELOGIO_DO_GATEWAY,
  type RelogioDoGateway,
} from '../src/whatsapp/relogio';
import {
  type EnvioDoTransporte,
  FABRICA_DE_TRANSPORTE,
  type FabricaDeTransporte,
  type MensagemDoTransporte,
  type MotivoDaQueda,
  type NumeroDaSessao,
  type OuvinteDaSessao,
  type SessaoWhatsapp,
} from '../src/whatsapp/transporte/transporte';
import { telefoneSimulado } from '../src/whatsapp/transporte/transporte-simulado';
import type { AppTeste } from './utils';
import {
  ambienteDeTeste,
  TOKEN_INTERNO_DE_TESTE,
} from './utils/ambiente-teste';

// ---------------------------------------------------------------------------
// Transporte roteirizado
// ---------------------------------------------------------------------------

export class SessaoRoteirizada implements SessaoWhatsapp {
  readonly enviados: EnvioDoTransporte[] = [];
  readonly digitandos: Array<[string, boolean, boolean]> = [];
  readonly encerramentos: Array<{ sair?: boolean }> = [];
  /** Erro para devolver no próximo envio (ou em todos, com `falharSempre`). */
  falharEnvio: ((envio: EnvioDoTransporte) => Error | undefined) | null = null;
  readonly verificacoes = new Map<
    string,
    { existe: boolean; jid: string | null }
  >();

  constructor(
    readonly numero: NumeroDaSessao,
    private readonly ouvinte: OuvinteDaSessao,
    private readonly fabrica: TransporteRoteirizado,
  ) {}

  iniciar(): Promise<void> {
    this.fabrica.aoIniciar(this);
    return Promise.resolve();
  }

  encerrar(opcoes: { sair?: boolean } = {}): Promise<void> {
    this.encerramentos.push(opcoes);
    return Promise.resolve();
  }

  enviar(envio: EnvioDoTransporte): Promise<{ enviadaEm: Date }> {
    const erro = this.falharEnvio?.(envio);
    if (erro) {
      return Promise.reject(erro);
    }
    this.enviados.push(envio);
    return Promise.resolve({ enviadaEm: new Date() });
  }

  verificar(
    telefone: string,
  ): Promise<{ existe: boolean; jid: string | null }> {
    return Promise.resolve(
      this.verificacoes.get(telefone) ?? {
        existe: true,
        jid: jidDoTelefone(telefone),
      },
    );
  }

  digitando(para: string, ativo: boolean, gravando = false): Promise<void> {
    this.digitandos.push([para, ativo, gravando]);
    return Promise.resolve();
  }

  // Controles do roteiro ----------------------------------------------------

  qr(texto = 'QR-DE-TESTE'): void {
    this.ouvinte.aoQr(texto);
  }

  conectar(
    telefone = this.numero.telefone ?? telefoneSimulado(this.numero.numeroId),
  ): void {
    this.ouvinte.aoConectar({
      telefone,
      jid: jidDoTelefone(telefone),
      lid: null,
    });
  }

  cair(queda: MotivoDaQueda): void {
    this.ouvinte.aoCair(queda);
  }

  receber(
    mensagem: Partial<MensagemDoTransporte> & { telefone?: string },
  ): void {
    const telefone = mensagem.telefone ?? '5511955554444';
    this.ouvinte.aoReceber({
      idExterno: `3EB0${Math.random().toString(16).slice(2, 12).toUpperCase()}`,
      remetenteJid: jidDoTelefone(telefone),
      tipo: 'TEXTO' as TipoMensagem,
      texto: 'Oi',
      recebidaEm: new Date(),
      ...mensagem,
      telefone,
    });
  }
}

export class TransporteRoteirizado implements FabricaDeTransporte {
  readonly sessoes: SessaoRoteirizada[] = [];
  /** O que acontece ao iniciar uma sessão (padrão: conecta na hora, sem QR). */
  aoIniciar: (sessao: SessaoRoteirizada) => void = (sessao) =>
    sessao.conectar();

  constructor(readonly nome: 'baileys' | 'simulado' = 'baileys') {}

  criar(numero: NumeroDaSessao, ouvinte: OuvinteDaSessao): SessaoWhatsapp {
    const sessao = new SessaoRoteirizada(numero, ouvinte, this);
    this.sessoes.push(sessao);
    return sessao;
  }

  /** A sessão mais nova do número. */
  sessao(numeroId: string): SessaoRoteirizada {
    const sessao = this.sessoes
      .filter((item) => item.numero.numeroId === numeroId)
      .at(-1);
    if (!sessao) {
      throw new Error(`Nenhuma sessão para o número ${numeroId}.`);
    }
    return sessao;
  }
}

/** Relógio que só avança quando alguém "espera": registra as esperas. */
export class RelogioFalso implements RelogioDoGateway {
  instante = Date.now();
  readonly esperas: number[] = [];
  sorteio = 0.5;

  agora(): number {
    return this.instante;
  }

  esperar(ms: number): Promise<void> {
    this.esperas.push(ms);
    this.instante += ms;
    return Promise.resolve();
  }

  aleatorio(): number {
    return this.sorteio;
  }
}

/** ffmpeg de mentira: "converte" para OGG e gera a miniatura "MINI". */
export class ConversorFalso extends ConversorDeMidia {
  readonly vozes: Array<{ nome: string; tamanho: number }> = [];
  readonly miniaturas: string[] = [];
  falharVoz: Error | null = null;

  override paraVoz(conteudo: Buffer, nome = 'audio'): Promise<Buffer> {
    this.vozes.push({ nome, tamanho: conteudo.length });
    return this.falharVoz
      ? Promise.reject(this.falharVoz)
      : Promise.resolve(Buffer.from('OggS-convertido'));
  }

  override miniatura(
    _conteudo: Buffer,
    nome = 'midia',
  ): Promise<string | undefined> {
    this.miniaturas.push(nome);
    return Promise.resolve('MINI');
  }
}

// ---------------------------------------------------------------------------
// Gateway isolado
// ---------------------------------------------------------------------------

export interface GatewayIsolado {
  readonly app: INestApplication<App>;
  readonly ambiente: Ambiente;
  readonly gerenciador: GerenciadorDeNumeros;
  readonly fila: FilaService;
  readonly prisma: PrismaService;
  readonly arquivos: DriverMemoria;
  readonly transporte: TransporteRoteirizado;
  readonly relogio: RelogioFalso;
  readonly conversor: ConversorFalso;
  /** Um `AppTeste` mínimo para as fábricas de `test/utils` (só `prisma` e `get`). */
  readonly t: AppTeste;
  pedir(metodo: 'get' | 'post', caminho: string, corpo?: object): request.Test;
  aguardarStatus(numeroId: string, status: StatusWhatsapp): Promise<void>;
  /** Eventos publicados para a API (pendentes na fila `whatsapp.evento`), na ordem. */
  eventos(): Promise<EventoDoGateway[]>;
  /** Pedidos de envio pendentes na fila do número (com `executarEm`). */
  envios(
    numeroId: string,
  ): Promise<Array<{ dados: PedidoDeEnvio; executarEm: Date }>>;
  /** Roda um envio como a fila rodaria (tentativa 1, salvo `tentativa`). */
  processar(pedido: PedidoDeEnvio, tentativa?: number): Promise<void>;
  drenarEnvios(numeroId: string): Promise<number>;
  /** TRUNCATE de tudo e filas vazias. */
  limpar(): Promise<void>;
  fechar(): Promise<void>;
}

export async function criarGatewayIsolado(
  opcoes: { transporte?: TransporteRoteirizado } = {},
): Promise<GatewayIsolado> {
  const ambiente = ambienteDeTeste();
  const transporte = opcoes.transporte ?? new TransporteRoteirizado();
  const relogio = new RelogioFalso();
  const conversor = new ConversorFalso();
  const arquivos = new DriverMemoria();
  const modulo = await Test.createTestingModule({
    imports: [GatewayWhatsappModule.forRoot(ambiente)],
  })
    .overrideProvider(FABRICA_DE_TRANSPORTE)
    .useValue(transporte)
    .overrideProvider(DRIVER_DE_ARQUIVOS)
    .useValue(arquivos)
    .overrideProvider(RELOGIO_DO_GATEWAY)
    .useValue(relogio)
    .overrideProvider(ConversorDeMidia)
    .useValue(conversor)
    .compile();
  const app = modulo.createNestApplication<NestExpressApplication>({
    bodyParser: false,
    logger: false,
  });
  configurarGateway(app);
  await app.init();
  const servidor = app.getHttpServer() as App;
  const gerenciador = app.get(GerenciadorDeNumeros);
  const fila = app.get(FilaService);
  const prisma = app.get(PrismaService);
  const t = {
    prisma,
    ambiente,
    arquivos,
    fila,
    get: <T>(token: unknown) => app.get<T>(token as never, { strict: false }),
  } as unknown as AppTeste;

  return {
    app: app as INestApplication<App>,
    ambiente,
    gerenciador,
    fila,
    prisma,
    arquivos,
    transporte,
    relogio,
    conversor,
    t,
    pedir: (metodo, caminho, corpo) => {
      const pedido = request(servidor)
        [metodo](caminho)
        .set(CABECALHO_TOKEN_INTERNO, TOKEN_INTERNO_DE_TESTE);
      return corpo === undefined ? pedido : pedido.send(corpo);
    },
    aguardarStatus: async (numeroId, status) => {
      const limite = Date.now() + 5_000;
      for (;;) {
        await gerenciador.aguardarAvisos(numeroId);
        const numero = await prisma.whatsappNumero.findUniqueOrThrow({
          where: { id: numeroId },
        });
        if (numero.status === status) {
          return;
        }
        if (Date.now() > limite) {
          throw new Error(
            `O número ${numeroId} ficou em ${numero.status}, não em ${status}.`,
          );
        }
        await new Promise((resolver) => setTimeout(resolver, 10));
      }
    },
    eventos: async () => {
      await gerenciador.aguardarAvisos();
      const jobs = await fila.listarTrabalhos<EventoDoGateway>(
        FILA_EVENTOS_WHATSAPP,
      );
      return jobs
        .sort((a, b) => a.executarEm.getTime() - b.executarEm.getTime())
        .map((job) => job.dados);
    },
    envios: async (numeroId) =>
      (await fila.listarTrabalhos<PedidoDeEnvio>(filaDeEnvio(numeroId))).map(
        (job) => ({ dados: job.dados, executarEm: job.executarEm }),
      ),
    processar: (pedido, tentativa = 1) =>
      gerenciador.processarEnvio({
        id: 'job',
        fila: filaDeEnvio(pedido.numeroId),
        dados: pedido,
        tentativa,
      } satisfies Trabalho<PedidoDeEnvio>),
    drenarEnvios: (numeroId) => fila.drenar(filaDeEnvio(numeroId)),
    limpar: async () => {
      await gerenciador.aguardarAvisos();
      const tabelas = await prisma.$queryRaw<{ tablename: string }[]>`
        SELECT tablename FROM pg_tables
         WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
      const lista = tabelas
        .map(({ tablename }) => `"public"."${tablename}"`)
        .join(', ');
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          'ALTER TABLE "eventos_auditoria" DISABLE TRIGGER "eventos_auditoria_sem_truncate"',
        );
        await tx.$executeRawUnsafe(
          `TRUNCATE ${lista} RESTART IDENTITY CASCADE`,
        );
        await tx.$executeRawUnsafe(
          'ALTER TABLE "eventos_auditoria" ENABLE TRIGGER "eventos_auditoria_sem_truncate"',
        );
      });
      await fila.limparTrabalhos();
      arquivos.limpar();
      transporte.sessoes.splice(0);
      relogio.esperas.splice(0);
      conversor.vozes.splice(0);
      conversor.miniaturas.splice(0);
      conversor.falharVoz = null;
    },
    fechar: () => app.close(),
  };
}
