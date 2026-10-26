import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { Client, type Notification } from 'pg';
import { AMBIENTE, type Ambiente } from '../config/ambiente';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TempoRealPublicador } from './tempo-real.publicador';
import { TempoRealService } from './tempo-real.service';

/** Canal do NOTIFY de sessão revogada (gatilho `sessoes_revogacao_avisada`): o id da sessão. */
export const CANAL_SESSOES_REVOGADAS = 'crmbrl_sessoes_revogadas';

/** Canal do NOTIFY de notificação nova (gatilho `notificacoes_criacao_avisada`): `{ id, usuarioId }`. */
export const CANAL_NOTIFICACOES = 'crmbrl_notificacoes';

/** De quanto em quanto tempo as sessões dos sockets conectados são conferidas no banco. */
export const INTERVALO_DA_VARREDURA_MS = 60_000;

/**
 * Escuta os avisos do banco (`LISTEN`), que só chegam depois do commit:
 *
 * - sessão revogada (sair, desligamento, troca/redefinição de senha, senha
 *   temporária) → derruba na hora os sockets daquela sessão (R2.4);
 * - notificação nova → `notificacao.nova` para o dono (R10.2).
 *
 * Uma conexão própria do `pg`, que se refaz sozinha se cair (espera crescente).
 * Como rede de proteção, a cada minuto confere as sessões dos sockets
 * conectados (expiradas, revogadas, usuário inativo) e derruba os inválidos.
 */
@Injectable()
export class OuvinteDoBanco implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('TempoReal');
  private cliente?: Client;
  private conectando = false;
  private parando = false;
  private temporizadorDeReconexao?: NodeJS.Timeout;
  private varredura?: NodeJS.Timeout;

  constructor(
    @Inject(AMBIENTE) private readonly ambiente: Ambiente,
    private readonly tempoReal: TempoRealService,
    private readonly publicador: TempoRealPublicador,
    private readonly prisma: PrismaService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.conectar(1);
    this.varredura = setInterval(() => {
      this.varrerSessoes().catch((erro: unknown) =>
        this.logger.warn(`Varredura de sessões falhou: ${mensagemDe(erro)}`),
      );
    }, INTERVALO_DA_VARREDURA_MS);
    this.varredura.unref();
  }

  async onModuleDestroy(): Promise<void> {
    this.parando = true;
    clearTimeout(this.temporizadorDeReconexao);
    clearInterval(this.varredura);
    const cliente = this.cliente;
    this.cliente = undefined;
    await cliente?.end().catch(() => undefined);
  }

  /** A escuta está ativa? (diagnóstico e testes) */
  get escutando(): boolean {
    return this.cliente !== undefined;
  }

  /**
   * Confere no banco as sessões dos sockets conectados e derruba os que não
   * valem mais. Devolve quantas sessões foram encerradas.
   */
  async varrerSessoes(): Promise<number> {
    const conectadas = await this.tempoReal.sessoesConectadas();
    if (conectadas.length === 0) {
      return 0;
    }
    const validas = await this.prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT s.id::text AS id
        FROM sessoes s
        JOIN usuarios u ON u.id = s.usuario_id
       WHERE s.id = ANY(${conectadas}::uuid[])
         AND s.revogada_em IS NULL
         AND s.expira_em > now()
         AND u.ativo`);
    const ids = new Set(validas.map(({ id }) => id));
    let encerradas = 0;
    for (const sessaoId of conectadas) {
      if (!ids.has(sessaoId)) {
        this.tempoReal.encerrarSessao(sessaoId, 'sessao_expirada');
        encerradas++;
      }
    }
    return encerradas;
  }

  private async conectar(tentativa: number): Promise<void> {
    if (this.parando || this.conectando) {
      return;
    }
    this.conectando = true;
    const cliente = new Client({
      connectionString: this.ambiente.databaseUrl,
      application_name: 'crmbrl-api-tempo-real',
      connectionTimeoutMillis: 5_000,
      keepAlive: true,
    });
    cliente.on('notification', (aviso) => this.aoReceber(aviso));
    cliente.on('error', (erro) => {
      this.logger.warn(`Escuta do banco caiu: ${erro.message}`);
      this.perder(cliente);
    });
    cliente.on('end', () => this.perder(cliente));
    try {
      await cliente.connect();
      await cliente.query(`LISTEN ${CANAL_SESSOES_REVOGADAS}`);
      await cliente.query(`LISTEN ${CANAL_NOTIFICACOES}`);
      if (this.parando) {
        await cliente.end().catch(() => undefined);
        return;
      }
      this.cliente = cliente;
      if (tentativa > 1) {
        this.logger.log('Escuta do banco restabelecida.');
        // O que foi revogado enquanto ela esteve fora.
        void this.varrerSessoes().catch(() => undefined);
      }
    } catch (erro) {
      await cliente.end().catch(() => undefined);
      this.agendarReconexao(tentativa, erro);
    } finally {
      this.conectando = false;
    }
  }

  private perder(cliente: Client): void {
    if (this.cliente !== cliente) {
      return;
    }
    this.cliente = undefined;
    cliente.removeAllListeners('notification');
    void cliente.end().catch(() => undefined);
    this.agendarReconexao(1, undefined);
  }

  private agendarReconexao(tentativa: number, erro: unknown): void {
    if (this.parando) {
      return;
    }
    const esperaMs = Math.min(30_000, 1_000 * 2 ** (tentativa - 1));
    if (erro !== undefined) {
      this.logger.warn(
        `Escuta do banco indisponível (${mensagemDe(erro)}); tentando de novo em ${Math.round(esperaMs / 1000)} s.`,
      );
    }
    clearTimeout(this.temporizadorDeReconexao);
    this.temporizadorDeReconexao = setTimeout(() => {
      void this.conectar(tentativa + 1);
    }, esperaMs);
    this.temporizadorDeReconexao.unref();
  }

  private aoReceber(aviso: Notification): void {
    const conteudo = aviso.payload ?? '';
    if (aviso.channel === CANAL_SESSOES_REVOGADAS) {
      this.tempoReal.encerrarSessao(conteudo, 'sessao_revogada');
      return;
    }
    if (aviso.channel === CANAL_NOTIFICACOES) {
      let dados: { id?: unknown; usuarioId?: unknown };
      try {
        dados = JSON.parse(conteudo) as typeof dados;
      } catch {
        return;
      }
      if (typeof dados.id === 'string' && typeof dados.usuarioId === 'string') {
        this.publicador
          .entregarNotificacao(dados.id, dados.usuarioId)
          .catch((erro: unknown) =>
            this.logger.warn(
              `Falha ao entregar notificação em tempo real: ${mensagemDe(erro)}`,
            ),
          );
      }
    }
  }
}

function mensagemDe(erro: unknown): string {
  return erro instanceof Error ? erro.message : String(erro);
}
