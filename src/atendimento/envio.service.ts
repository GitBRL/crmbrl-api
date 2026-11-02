import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { FalhaDefinitivaDeEnvio } from '../canais/adaptador-canal';
import {
  ROTULO_DO_TIPO_DE_CANAL,
  RegistroCanais,
} from '../canais/registro-canais';
import { EventosDominioService } from '../eventos/eventos-dominio.service';
import { FilaService, type Trabalho } from '../fila/fila.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  ESPERA_ENTRE_ENVIOS_SEGUNDOS,
  EVENTOS_DO_ATENDIMENTO,
  FILA_ENVIO_ATENDIMENTO,
  RETENTATIVAS_DE_ENVIO,
} from './atendimento.constantes';
import {
  MotorDoAtendimento,
  type PedidoDeEnvioDoAtendimento,
} from './motor-do-atendimento.service';

/** Mensagem mostrada na bolha quando as tentativas acabam. */
export const FALHA_DEPOIS_DAS_TENTATIVAS =
  'Não foi possível enviar a mensagem depois de várias tentativas. Tente de novo.';

/**
 * Envio das mensagens de saída (§2.4, fluxo de saída): consome a fila
 * `atendimento.enviar` (um job por mensagem, criado na transação que gravou a
 * mensagem `PENDENTE`) e entrega ao adaptador do canal pelo `RegistroCanais`.
 *
 * - Envio síncrono (e-mail, Meta): grava o `idExterno` e marca `ENVIADA`.
 * - Envio enfileirado (WhatsApp): grava o `idExterno` e fica `PENDENTE` até o
 *   evento do canal (`AtendimentoService.atualizarStatus`).
 * - `FalhaDefinitivaDeEnvio`: `FALHOU` com o motivo (a bolha mostra "tentar
 *   de novo"). Outro erro é passageiro: o pg-boss tenta de novo (até
 *   `RETENTATIVAS_DE_ENVIO` vezes, com espera crescente) e, na última, `FALHOU`.
 */
@Injectable()
export class EnvioDoAtendimento implements OnModuleInit {
  private readonly logger = new Logger(EnvioDoAtendimento.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly fila: FilaService,
    private readonly registro: RegistroCanais,
    private readonly motor: MotorDoAtendimento,
    private readonly eventos: EventosDominioService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.fila.trabalhar<PedidoDeEnvioDoAtendimento>(
      FILA_ENVIO_ATENDIMENTO,
      (trabalho) => this.enviar(trabalho),
      {
        concorrencia: 4,
        intervaloDeConsultaSegundos: 1,
        tentativas: RETENTATIVAS_DE_ENVIO,
        intervaloEntreTentativasSegundos: ESPERA_ENTRE_ENVIOS_SEGUNDOS,
        esperaExponencial: true,
        prazoDeExecucaoSegundos: 120,
      },
    );
  }

  /** Um envio (o manipulador do job). */
  async enviar(trabalho: Trabalho<PedidoDeEnvioDoAtendimento>): Promise<void> {
    const mensagem = await this.prisma.mensagem.findUnique({
      where: { id: trabalho.dados.mensagemId },
      include: { conversa: true, canal: true },
    });
    if (
      !mensagem ||
      mensagem.direcao !== 'SAIDA' ||
      mensagem.status !== 'PENDENTE' ||
      mensagem.excluidaEm
    ) {
      return;
    }
    const { conversa, canal } = mensagem;
    if (!canal.ativo || canal.excluidoEm) {
      await this.falhar(mensagem.id, 'O canal desta conversa está desativado.');
      return;
    }
    const adaptador = this.registro.buscar(canal.tipo);
    if (!adaptador) {
      await this.falhar(
        mensagem.id,
        `O canal ${ROTULO_DO_TIPO_DE_CANAL[canal.tipo]} não está disponível nesta instalação.`,
      );
      return;
    }
    try {
      const resultado = await adaptador.enviar(mensagem, conversa, canal);
      await this.prisma.$transaction(async (tx) => {
        const idExterno = resultado.idExterno?.trim() || mensagem.idExterno;
        await tx.mensagem.update({
          where: { id: mensagem.id },
          data: {
            tentativas: { increment: 1 },
            ...(idExterno && idExterno !== mensagem.idExterno
              ? { idExterno }
              : {}),
          },
        });
        if (resultado.enfileirado) {
          return;
        }
        const enviadaEm = resultado.enviadaEm ?? new Date();
        const alteradas = await tx.mensagem.updateMany({
          where: { id: mensagem.id, status: 'PENDENTE' },
          data: { status: 'ENVIADA', enviadaEm, erro: null },
        });
        if (alteradas.count > 0) {
          await this.motor.emitirStatus(
            tx,
            {
              id: mensagem.id,
              conversaId: mensagem.conversaId,
              status: 'ENVIADA',
              erro: null,
            },
            enviadaEm,
          );
          await this.eventos.publicar(
            tx,
            EVENTOS_DO_ATENDIMENTO.MENSAGEM_ENVIADA,
            {
              mensagemId: mensagem.id,
              conversaId: mensagem.conversaId,
              canalId: canal.id,
              canalTipo: canal.tipo,
              idExterno,
            },
          );
        }
      });
    } catch (erro) {
      if (erro instanceof FalhaDefinitivaDeEnvio) {
        await this.falhar(mensagem.id, erro.message, true);
        return;
      }
      if (trabalho.tentativa > RETENTATIVAS_DE_ENVIO) {
        this.logger.warn(
          `Envio da mensagem ${mensagem.id} falhou de vez: ${mensagemDe(erro)}`,
        );
        await this.falhar(mensagem.id, FALHA_DEPOIS_DAS_TENTATIVAS, true);
        return;
      }
      await this.prisma.mensagem.update({
        where: { id: mensagem.id },
        data: { tentativas: { increment: 1 } },
      });
      throw erro;
    }
  }

  /** `FALHOU` com o motivo (só se ainda estava `PENDENTE`) e avisa a conversa. */
  private async falhar(
    mensagemId: string,
    motivo: string,
    contarTentativa = false,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const mensagem = await tx.mensagem.findUniqueOrThrow({
        where: { id: mensagemId },
      });
      const alteradas = await tx.mensagem.updateMany({
        where: { id: mensagemId, status: 'PENDENTE' },
        data: {
          status: 'FALHOU',
          erro: motivo,
          ...(contarTentativa ? { tentativas: { increment: 1 } } : {}),
        },
      });
      if (alteradas.count > 0) {
        await this.motor.emitirStatus(tx, {
          id: mensagemId,
          conversaId: mensagem.conversaId,
          status: 'FALHOU',
          erro: motivo,
        });
      }
    });
  }
}

function mensagemDe(erro: unknown): string {
  return erro instanceof Error ? erro.message : String(erro);
}
