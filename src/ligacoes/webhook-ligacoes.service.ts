import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { EntradaWhatsappOficialService } from '../canais/whatsapp-oficial/entrada-whatsapp-oficial.service';
import { FilaService } from '../fila/fila.service';
import type { Canal } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { registrarChaveDeDedupe } from './contexto-da-ligacao';
import {
  CAMPO_DE_CHAMADAS,
  type ChamadaDoWebhook,
  chaveDeDedupe,
  type ClienteDaChamada,
  eventosDeChamadas,
  type EventoDeChamadas,
  falhaDeMidia,
} from './formato-chamadas';
import {
  LigacaoAindaDesconhecida,
  LigacoesFeitasService,
} from './ligacoes-feitas.service';
import { LigacoesRecebidasService } from './ligacoes-recebidas.service';
import {
  AGENDA_DA_LIMPEZA,
  FILA_LIMPAR_DEDUPE,
  VALIDADE_DO_DEDUPE_MS,
} from './ligacoes.constantes';
import { LigacoesService } from './ligacoes.service';
import { PermissoesDeLigacaoService } from './permissoes-de-ligacao.service';

/** Webhook `terminate`/status mais velho que isto, sem ligação conhecida, é descartado (em vez de esperar). */
/** Esperas curtas (ms) antes de devolver ao job um evento de ligação que ainda está sendo criada. */
const ESPERAS_POR_LIGACAO_EM_CRIACAO_MS = [300, 700, 1500];
const ESPERA_POR_LIGACAO_DESCONHECIDA_MS = 5 * 60 * 1000;

/**
 * Webhook de chamadas (R29.2): o campo `calls` do webhook da Meta (E1) chega
 * aqui, e a resposta do cliente ao pedido de permissão (campo `messages`). Cada
 * evento é aplicado numa transação **junto com a chave de dedupe** (a Meta
 * reentrega por até 7 dias): repetido não faz nada; fora de ordem espera a
 * ligação existir (o job tenta de novo); atrasado não regride o estado (a
 * máquina de estados decide).
 */
@Injectable()
export class WebhookDeLigacoesService implements OnModuleInit {
  private readonly logger = new Logger('Ligacoes');

  constructor(
    private readonly prisma: PrismaService,
    private readonly fila: FilaService,
    private readonly entrada: EntradaWhatsappOficialService,
    private readonly nucleo: LigacoesService,
    private readonly recebidas: LigacoesRecebidasService,
    private readonly feitas: LigacoesFeitasService,
    private readonly permissoes: PermissoesDeLigacaoService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.entrada.registrarCampo(CAMPO_DE_CHAMADAS, (canal, valor) =>
      this.tratar(canal, valor),
    );
    this.entrada.registrarPermissaoDeLigacao(
      (canal, remetente, resposta, mensagem) =>
        this.permissoes.registrarResposta(canal, remetente, resposta, mensagem),
    );
    await this.fila.trabalhar(FILA_LIMPAR_DEDUPE, () =>
      this.limparChaves().then(() => undefined),
    );
    await this.fila.agendar(FILA_LIMPAR_DEDUPE, AGENDA_DA_LIMPEZA);
  }

  /** Uma mudança do campo `calls`: processa cada evento em ordem. */
  async tratar(canal: Canal, valor: Record<string, unknown>): Promise<void> {
    for (const evento of eventosDeChamadas(valor)) {
      await this.processar(canal, evento);
    }
  }

  /**
   * Um evento. O status RINGING (ou a resposta SDP) de uma ligação feita pode chegar antes de o
   * POST /ligacoes gravar o id da Meta: espera um instante, fora da transação, antes de entregar
   * ao job (cujo retry leva 10 s ou mais).
   */
  async processar(canal: Canal, evento: EventoDeChamadas): Promise<void> {
    for (let tentativa = 0; ; tentativa++) {
      try {
        await this.processarUm(canal, evento);
        return;
      } catch (erro) {
        const espera = ESPERAS_POR_LIGACAO_EM_CRIACAO_MS[tentativa];
        if (
          !(erro instanceof LigacaoAindaDesconhecida) ||
          espera === undefined
        ) {
          throw erro;
        }
        await new Promise((resolver) => setTimeout(resolver, espera));
      }
    }
  }

  private async processarUm(
    canal: Canal,
    evento: EventoDeChamadas,
  ): Promise<void> {
    if (
      evento.tipo === 'chamada' &&
      evento.chamada.evento === 'connect' &&
      evento.chamada.direcao === 'RECEBIDA'
    ) {
      // Liga o BSUID e a outra forma do celular brasileiro ao contato que já existe (E1).
      await this.entrada.prepararContato(
        evento.cliente.telefone,
        evento.cliente.bsuid,
      );
    }
    await this.nucleo.executar(async (tx, ctx) => {
      if (
        !(await registrarChaveDeDedupe(tx, chaveDeDedupe(canal.id, evento)))
      ) {
        return;
      }
      try {
        if (evento.tipo === 'status') {
          await this.feitas.aplicarStatus(tx, ctx, canal, evento.status);
          return;
        }
        const { chamada, cliente } = evento;
        if (chamada.evento === 'connect') {
          if (chamada.direcao === 'RECEBIDA') {
            await this.recebidas.receber(tx, ctx, canal, chamada, cliente);
          } else if (chamada.direcao === 'FEITA') {
            await this.feitas.aplicarRespostaSdp(tx, ctx, canal, chamada);
          }
          return;
        }
        if (chamada.evento === 'terminate') {
          await this.aplicarTerminate(tx, ctx, canal, chamada, cliente);
          return;
        }
        this.logger.debug?.(`Evento de chamada "${chamada.evento}" ignorado.`);
      } catch (erro) {
        if (erro instanceof LigacaoAindaDesconhecida) {
          const quando =
            evento.tipo === 'status'
              ? evento.status.quando
              : evento.chamada.quando;
          if (
            quando &&
            Date.now() - quando.getTime() > ESPERA_POR_LIGACAO_DESCONHECIDA_MS
          ) {
            this.logger.warn(`${erro.message} Evento antigo descartado.`);
            return;
          }
        }
        throw erro;
      }
    });
    if (
      evento.tipo === 'chamada' &&
      evento.chamada.evento === 'connect' &&
      evento.chamada.direcao === 'RECEBIDA' &&
      evento.cliente.telefone &&
      evento.cliente.bsuid
    ) {
      await this.guardarBsuid(canal, evento.chamada.id, evento.cliente.bsuid);
    }
  }

  private async aplicarTerminate(
    tx: Parameters<LigacoesFeitasService['acharPorWebhook']>[0],
    ctx: Parameters<LigacoesFeitasService['aplicarRespostaSdp']>[1],
    canal: Canal,
    chamada: ChamadaDoWebhook,
    _cliente: ClienteDaChamada,
  ): Promise<void> {
    const achada = await this.feitas.acharPorWebhook(
      tx,
      canal.id,
      chamada.id,
      chamada.dadosOpacos,
    );
    if (!achada) {
      throw new LigacaoAindaDesconhecida(chamada.id);
    }
    const ligacao = await this.nucleo.carregar(tx, achada.id);
    const atendida =
      chamada.duracaoSegundos !== null || chamada.iniciadaEm !== null;
    const codigoDoErro = chamada.erros[0]?.codigo ?? null;
    const mensagemDoErro = chamada.erros[0]?.mensagem ?? null;
    const rejeitada = chamada.status === 'REJECTED' && !atendida;
    const extra = {
      quando: chamada.quando ?? undefined,
      duracaoSegundos: chamada.duracaoSegundos,
      inicioNaMeta: chamada.iniciadaEm,
      fimNaMeta: chamada.encerradaEm,
      ...(codigoDoErro !== null || mensagemDoErro
        ? { erroCodigo: codigoDoErro, erroMensagem: mensagemDoErro }
        : {}),
    };
    if (rejeitada && ligacao.direcao === 'FEITA') {
      // Algumas fontes mandam REJECTED no terminate da ligação feita (LACUNA 7).
      await this.nucleo.transicionar(
        tx,
        ctx,
        ligacao.id,
        { tipo: 'cliente_recusou' },
        extra,
      );
      return;
    }
    await this.nucleo.transicionar(
      tx,
      ctx,
      ligacao.id,
      {
        tipo: 'encerrada_pela_meta',
        atendida,
        falhou: chamada.status === 'FAILED',
        canceladaPorNos: ligacao.encerramentoSolicitadoEm !== null,
        toqueVencido:
          ligacao.direcao === 'RECEBIDA' &&
          !!ligacao.expiraEm &&
          Date.now() >= ligacao.expiraEm.getTime(),
        motivoDaFalha: falhaDeMidia(codigoDoErro)
          ? 'falha_de_midia'
          : ligacao.direcao === 'RECEBIDA'
            ? 'falha_na_meta'
            : 'falha_ao_ligar',
      },
      extra,
    );
  }

  /** Depois de a ligação existir: o contato da conversa passa a ter também o BSUID (E1). */
  private async guardarBsuid(
    canal: Canal,
    idMeta: string,
    bsuid: string,
  ): Promise<void> {
    const ligacao = await this.prisma.ligacao.findUnique({
      where: { canalId_idMeta: { canalId: canal.id, idMeta } },
      select: { conversaId: true },
    });
    if (ligacao?.conversaId) {
      await this.entrada.registrarBsuid(ligacao.conversaId, bsuid);
    }
  }

  /** Remove as chaves de dedupe mais velhas que a validade (7 dias). */
  async limparChaves(agora: Date = new Date()): Promise<number> {
    const { count } = await this.prisma.ligacaoWebhookEvento.deleteMany({
      where: {
        recebidoEm: { lt: new Date(agora.getTime() - VALIDADE_DO_DEDUPE_MS) },
      },
    });
    return count;
  }
}
