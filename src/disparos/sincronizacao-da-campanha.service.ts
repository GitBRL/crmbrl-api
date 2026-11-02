import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CicloDaCampanha } from './ciclo-da-campanha.service';
import { PRAZO_SEM_CONFIRMACAO_HORAS } from './disparos.constantes';
import {
  type ContadoresDaCampanha,
  ProgressoDaCampanha,
} from './progresso-da-campanha.service';

export interface ResultadoDaSincronizacao {
  contadores: ContadoresDaCampanha;
  /** A campanha foi pausada por falhas seguidas. */
  pausou: boolean;
}

/**
 * Traz para os destinatários o que aconteceu com as mensagens no Atendimento:
 * enviada (ENVIANDO → ENVIADO), entregue, lida e falha (com o motivo do
 * gateway). Conta as falhas seguidas e pausa a campanha no limite
 * (`pausarAposFalhas`). Idempotente: cada destinatário muda uma vez por etapa.
 */
@Injectable()
export class SincronizacaoDaCampanha {
  constructor(
    private readonly prisma: PrismaService,
    private readonly progresso: ProgressoDaCampanha,
    private readonly ciclo: CicloDaCampanha,
  ) {}

  async sincronizar(campanhaId: string): Promise<ResultadoDaSincronizacao> {
    const resultado = await this.prisma.$transaction(async (tx) => {
      const campanha = await tx.campanha.findUnique({
        where: { id: campanhaId },
      });
      if (!campanha) {
        throw new Error('Campanha não encontrada.');
      }
      const mudados = await tx.$queryRaw<
        Array<{ ordem: number; falhou: boolean }>
      >`
        UPDATE campanha_destinatarios d
           SET status = CASE WHEN m.status = 'FALHOU' THEN 'FALHOU'::status_destinatario
                             ELSE 'ENVIADO'::status_destinatario END,
               enviado_em = CASE WHEN m.status = 'FALHOU' THEN NULL
                                 ELSE COALESCE(m.enviada_em, now()) END,
               entregue_em = CASE WHEN m.status = 'FALHOU' THEN NULL ELSE m.entregue_em END,
               lido_em = CASE WHEN m.status = 'FALHOU' THEN NULL ELSE m.lida_em END,
               falhou_em = CASE WHEN m.status = 'FALHOU' THEN now() ELSE NULL END,
               motivo = CASE WHEN m.status = 'FALHOU'
                             THEN COALESCE(m.erro, 'Não foi possível enviar a mensagem.')
                             ELSE NULL END,
               atualizado_em = now()
          FROM mensagens m
         WHERE d.mensagem_id = m.id
           AND d.campanha_id = ${campanhaId}::uuid
           AND ((d.status = 'ENVIANDO' AND m.status IN ('ENVIADA', 'ENTREGUE', 'LIDA', 'FALHOU'))
             OR (d.status = 'ENVIADO' AND m.status = 'FALHOU'))
        RETURNING d.ordem, (m.status = 'FALHOU') AS falhou`;

      await tx.$executeRaw`
        UPDATE campanha_destinatarios d
           SET entregue_em = COALESCE(d.entregue_em, m.entregue_em),
               lido_em = COALESCE(d.lido_em, m.lida_em),
               atualizado_em = now()
          FROM mensagens m
         WHERE d.mensagem_id = m.id
           AND d.campanha_id = ${campanhaId}::uuid
           AND d.status = 'ENVIADO'
           AND d.enviado_em > now() - interval '14 days'
           AND ((d.entregue_em IS NULL AND m.entregue_em IS NOT NULL)
             OR (d.lido_em IS NULL AND m.lida_em IS NOT NULL))`;

      const semConfirmacao = await tx.$queryRaw<Array<{ ordem: number }>>`
        UPDATE campanha_destinatarios
           SET status = 'FALHOU', falhou_em = now(), atualizado_em = now(),
               motivo = 'O WhatsApp não confirmou o envio a tempo.'
         WHERE campanha_id = ${campanhaId}::uuid
           AND status = 'ENVIANDO'
           AND atualizado_em < now() - make_interval(hours => ${PRAZO_SEM_CONFIRMACAO_HORAS}::int)
        RETURNING ordem`;

      // Falhas seguidas, na ordem dos envios.
      const eventos = [
        ...mudados.map((m) => ({ ordem: m.ordem, falhou: m.falhou })),
        ...semConfirmacao.map((m) => ({ ordem: m.ordem, falhou: true })),
      ].sort((a, b) => a.ordem - b.ordem);
      let seguidas = campanha.falhasSeguidas;
      for (const evento of eventos) {
        seguidas = evento.falhou ? seguidas + 1 : 0;
      }
      if (seguidas !== campanha.falhasSeguidas) {
        await tx.campanha.update({
          where: { id: campanhaId },
          data: { falhasSeguidas: seguidas },
        });
      }
      const contadores = await this.progresso.atualizar(tx, campanhaId);
      return {
        contadores,
        deveriaPausar:
          campanha.status === 'EM_ANDAMENTO' &&
          seguidas >= campanha.pausarAposFalhas,
        seguidas,
      };
    });
    if (!resultado.deveriaPausar) {
      return { contadores: resultado.contadores, pausou: false };
    }
    try {
      await this.ciclo.pausar(
        campanhaId,
        `${resultado.seguidas} falhas seguidas no envio. Confira o número e retome quando estiver tudo certo.`,
        true,
      );
      return { contadores: resultado.contadores, pausou: true };
    } catch {
      // Já mudou de status por outro caminho (pausa manual, cancelamento).
      return { contadores: resultado.contadores, pausou: false };
    }
  }
}
