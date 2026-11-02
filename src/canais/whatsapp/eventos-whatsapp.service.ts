import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { AtendimentoService } from '../../atendimento/atendimento.service';
import type { RemetenteDaEntrada } from '../../atendimento/entrada';
import { executarComoAtor } from '../../comum/contexto/contexto-requisicao';
import { FilaService } from '../../fila/fila.service';
import { PrismaService } from '../../prisma/prisma.service';
import { EVENTOS_DO_SERVIDOR, salas } from '../../tempo-real/catalogo';
import { TempoRealService } from '../../tempo-real/tempo-real.service';
import {
  type EventoConexao,
  type EventoDigitando,
  type EventoDoGateway,
  type EventoMensagemRecebida,
  FILA_EVENTOS_WHATSAPP,
} from './contrato-gateway';

/** Quem acompanha a conexão dos números (Configurações → Canais). */
export const SALAS_DE_QUEM_GERENCIA_CANAIS = [salas.papel('ADMIN')];

/**
 * Consome a fila `whatsapp.evento` (gateway → API, §2.3):
 *
 * - `mensagem` → `AtendimentoService.receber` (contato pelo telefone ou pelo
 *   `@lid`; conversa pelo JID do remetente);
 * - `status` → `AtendimentoService.atualizarStatus`;
 * - `conexao` → `whatsapp.conexao` em tempo real para quem gerencia canais,
 *   com o estado **atual** do número no banco (o gateway já o gravou): um aviso
 *   que chega fora de ordem não mostra um status velho, e o QR só vai enquanto
 *   o número espera a leitura e se for o mais novo;
 * - `digitando` → `digitando` na sala da conversa em aberto do contato.
 */
@Injectable()
export class EventosWhatsappService implements OnModuleInit {
  private readonly logger = new Logger('WhatsApp');
  /** Validade do último QR emitido por número (para não trocar um QR novo por um velho). */
  private readonly ultimoQr = new Map<string, number>();

  constructor(
    private readonly fila: FilaService,
    private readonly atendimento: AtendimentoService,
    private readonly tempoReal: TempoRealService,
    private readonly prisma: PrismaService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.fila.trabalhar<EventoDoGateway>(
      FILA_EVENTOS_WHATSAPP,
      (trabalho) => this.processar(trabalho.dados),
      {
        tentativas: 5,
        intervaloEntreTentativasSegundos: 5,
        esperaExponencial: true,
        intervaloDeConsultaSegundos: 0.5,
        // Um por vez: os eventos de um número são tratados na ordem em que o
        // gateway os publicou.
        concorrencia: 1,
      },
    );
  }

  /** Processa um evento do gateway (público para os testes). */
  async processar(evento: EventoDoGateway): Promise<void> {
    switch (evento.tipo) {
      case 'mensagem':
        await this.receber(evento);
        return;
      case 'status':
        await executarComoAtor(
          { tipoAtor: 'SISTEMA', descricao: 'WhatsApp' },
          () =>
            this.atendimento.atualizarStatus(
              evento.canalId,
              evento.idExterno,
              evento.status,
              evento.erro ?? undefined,
              new Date(evento.em),
            ),
        );
        return;
      case 'conexao':
        await this.avisarConexao(evento);
        return;
      case 'digitando':
        await this.repassarDigitando(evento);
        return;
      default:
        this.logger.warn(
          `Evento do gateway desconhecido ignorado: ${JSON.stringify(evento).slice(0, 200)}`,
        );
    }
  }

  private async receber(evento: EventoMensagemRecebida): Promise<void> {
    const remetente: RemetenteDaEntrada = evento.telefone
      ? {
          tipo: 'WHATSAPP',
          valor: evento.telefone,
          nome: evento.nome ?? undefined,
        }
      : {
          tipo: 'WHATSAPP_LID',
          valor: evento.remetenteJid,
          nome: evento.nome ?? undefined,
        };
    await executarComoAtor({ tipoAtor: 'SISTEMA', descricao: 'WhatsApp' }, () =>
      this.atendimento.receber({
        canalId: evento.canalId,
        remetente,
        idExternoConversa: evento.remetenteJid,
        mensagem: {
          idExterno: evento.idExterno,
          tipo: evento.tipoMensagem,
          texto: evento.texto ?? undefined,
          arquivoId: evento.arquivoId ?? undefined,
          respondeAIdExterno: evento.respondeAIdExterno ?? undefined,
          recebidaEm: new Date(evento.recebidaEm),
          metadados: evento.metadados,
        },
      }),
    );
  }

  private async avisarConexao(evento: EventoConexao): Promise<void> {
    const numero = await this.prisma.whatsappNumero.findUnique({
      where: { id: evento.numeroId },
      select: { status: true, telefone: true, motivo: true },
    });
    if (!numero) {
      return;
    }
    const expiraEm = evento.qrExpiraEm ? Date.parse(evento.qrExpiraEm) : 0;
    const qrVale =
      evento.status === 'AGUARDANDO_QR' &&
      numero.status === 'AGUARDANDO_QR' &&
      Boolean(evento.qr) &&
      expiraEm > Date.now() &&
      expiraEm >= (this.ultimoQr.get(evento.numeroId) ?? 0);
    if (qrVale) {
      this.ultimoQr.set(evento.numeroId, expiraEm);
    } else if (numero.status !== 'AGUARDANDO_QR') {
      this.ultimoQr.delete(evento.numeroId);
    }
    this.tempoReal.emitir(
      SALAS_DE_QUEM_GERENCIA_CANAIS,
      EVENTOS_DO_SERVIDOR.WHATSAPP_CONEXAO,
      {
        numeroId: evento.numeroId,
        canalId: evento.canalId,
        status: numero.status,
        qr: qrVale ? (evento.qr ?? null) : null,
        qrExpiraEm: qrVale ? (evento.qrExpiraEm ?? null) : null,
        telefone: numero.telefone,
        motivo: numero.motivo,
      },
    );
  }

  private async repassarDigitando(evento: EventoDigitando): Promise<void> {
    const conversa = await this.prisma.conversa.findFirst({
      where: {
        canalId: evento.canalId,
        idExterno: evento.remetenteJid,
        status: { not: 'RESOLVIDA' },
      },
      select: { id: true },
    });
    if (!conversa) {
      return;
    }
    this.tempoReal.emitir(
      salas.conversa(conversa.id),
      EVENTOS_DO_SERVIDOR.DIGITANDO,
      { conversaId: conversa.id, ativo: evento.ativo, contato: true },
    );
  }
}
