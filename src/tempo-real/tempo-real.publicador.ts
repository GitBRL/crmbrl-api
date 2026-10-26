import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  type EventoPublicado,
  EventosDominioService,
} from '../eventos/eventos-dominio.service';
import type { TipoEventoDominio } from '../eventos/tipos-eventos';
import { NotificacaoDto } from '../notificacoes/notificacoes.dto';
import { PrismaService, type Tx } from '../prisma/prisma.service';
import {
  type CargasDoServidor,
  EVENTOS_DO_SERVIDOR,
  type EventoDoServidor,
  salas,
} from './catalogo';
import { TempoRealService } from './tempo-real.service';

/** Evento da outbox que carrega uma emissão pronta (`emitirAposCommit`). */
export const EVENTO_EMISSAO_TEMPO_REAL = 'tempo-real.emissao';

/**
 * Emissões mais velhas que isto (a API ficou fora do ar, a fila atrasou) são
 * descartadas: quem reconecta recarrega a tela pela API.
 */
export const VALIDADE_DA_EMISSAO_MS = 5 * 60_000;

/** Uma emissão: evento e dados para uma ou mais salas. */
export interface Emissao<E extends EventoDoServidor = EventoDoServidor> {
  salas: string | readonly string[];
  evento: E;
  dados: CargasDoServidor[E];
  /** Salas que não recebem (ex.: a do próprio autor). */
  exceto?: string | readonly string[];
}

/** Traduz um evento de domínio em emissões (lista vazia = nada a emitir). */
export type TradutorDeEvento<T = unknown> = (
  evento: EventoPublicado<T>,
) => Emissao[] | Promise<Emissao[]>;

/**
 * Publicador do tempo real (§2.2): manipulador da outbox que transforma o que
 * aconteceu no banco em emissões — sempre **depois do commit** (R10.1).
 *
 * Dois jeitos de usar, nos módulos de atendimento, canais e chat:
 *
 * ```ts
 * // 1. Emissão pronta, na transação da alteração (o mais simples):
 * await this.publicador.emitirAposCommit(tx, {
 *   salas: [salas.conversa(conversa.id), salas.area('COMERCIAL')],
 *   evento: 'mensagem.nova',
 *   dados: { conversaId: conversa.id, mensagem: MensagemDto.de(mensagem) },
 * });
 *
 * // 2. Tradutor de um evento de domínio que o módulo já publica:
 * this.publicador.registrarTradutor('conversa.transferida', (evento) => [...], 'atendimento:transferida');
 * ```
 *
 * A entrega é "pelo menos uma vez" (a da outbox): o front ignora repetidos
 * pelo `id` do recurso. Emissões com mais de 5 minutos são descartadas. As
 * notificações não passam por aqui como evento de domínio: o gatilho do banco
 * avisa (`OuvinteDoBanco`) e `entregarNotificacao` emite `notificacao.nova`.
 */
@Injectable()
export class TempoRealPublicador implements OnModuleInit {
  private readonly logger = new Logger('TempoReal');

  constructor(
    private readonly eventos: EventosDominioService,
    private readonly tempoReal: TempoRealService,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    this.eventos.registrarManipulador<{ emissoes: Emissao[] }>(
      EVENTO_EMISSAO_TEMPO_REAL,
      (evento) => {
        if (this.vencido(evento)) {
          return Promise.resolve();
        }
        for (const emissao of evento.dados.emissoes ?? []) {
          this.emitir(emissao);
        }
        return Promise.resolve();
      },
      'tempo-real:emissao',
    );
  }

  /**
   * Grava a(s) emissão(ões) na outbox, na transação `tx`: só saem se ela
   * confirmar. Os dados vão como JSON (datas viram texto ISO).
   */
  async emitirAposCommit(
    tx: Tx,
    emissao: Emissao | readonly Emissao[],
  ): Promise<void> {
    const emissoes = Array.isArray(emissao)
      ? [...emissao]
      : [emissao as Emissao];
    if (emissoes.length === 0) {
      return;
    }
    await this.eventos.publicar(tx, EVENTO_EMISSAO_TEMPO_REAL, { emissoes });
  }

  /**
   * Inscreve um tradutor num tipo de evento de domínio. `nome` precisa ser
   * estável (é ele que marca a conclusão do manipulador na outbox).
   */
  registrarTradutor<T = unknown>(
    tipo: TipoEventoDominio,
    tradutor: TradutorDeEvento<T>,
    nome: string,
  ): void {
    this.eventos.registrarManipulador<T>(
      tipo,
      async (evento) => {
        if (this.vencido(evento)) {
          return;
        }
        for (const emissao of await tradutor(evento)) {
          this.emitir(emissao);
        }
      },
      `tempo-real:${nome}`,
    );
  }

  /**
   * Notificação nova (aviso do banco, depois do commit): emite
   * `notificacao.nova` e a contagem do sino (`nao-lidas`) para o dono, se ele
   * estiver conectado.
   */
  async entregarNotificacao(id: string, usuarioId: string): Promise<void> {
    if (!(await this.tempoReal.estaConectado(usuarioId))) {
      return;
    }
    const notificacao = await this.prisma.notificacao.findUnique({
      where: { id },
    });
    if (!notificacao) {
      return;
    }
    const naoLidas = await this.prisma.notificacao.count({
      where: { usuarioId: notificacao.usuarioId, lidaEm: null },
    });
    const sala = salas.usuario(notificacao.usuarioId);
    this.tempoReal.emitir(sala, EVENTOS_DO_SERVIDOR.NOTIFICACAO_NOVA, {
      notificacao: NotificacaoDto.de(notificacao),
    });
    this.tempoReal.emitir(sala, EVENTOS_DO_SERVIDOR.NAO_LIDAS, {
      notificacoes: naoLidas,
    });
  }

  private emitir(emissao: Emissao): void {
    this.tempoReal.emitir(emissao.salas, emissao.evento, emissao.dados, {
      exceto: emissao.exceto,
    });
  }

  private vencido(evento: EventoPublicado): boolean {
    const idade = Date.now() - evento.ocorridoEm.getTime();
    if (idade <= VALIDADE_DA_EMISSAO_MS) {
      return false;
    }
    this.logger.debug?.(
      `Emissão de ${evento.tipo} descartada: ${Math.round(idade / 1000)} s de atraso.`,
    );
    return true;
  }
}
