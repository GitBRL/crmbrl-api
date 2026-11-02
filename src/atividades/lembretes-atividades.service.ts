import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { FilaService } from '../fila/fila.service';
import type { TipoAtividade } from '../generated/prisma/client';
import {
  type NovaNotificacao,
  NotificacoesService,
} from '../notificacoes/notificacoes.service';
import { TIPOS_NOTIFICACAO } from '../notificacoes/tipos-notificacao';
import { PrismaService, type Tx } from '../prisma/prisma.service';
import { descreverMomento, FUSO_HORARIO_DAS_ATIVIDADES } from './fuso-horario';
import { prazoDaAtividade, tipoComArtigo } from './regras-atividades';

/** Fila do job de lembretes (R6.5). */
export const FILA_LEMBRETES_DE_ATIVIDADES = 'atividades.lembretes';

/** R6.5 — a cada 15 minutos (no fuso de São Paulo, o padrão da fila). */
export const AGENDA_DOS_LEMBRETES = '*/15 * * * *';

/** R6.5 — o lembrete sai 1 hora antes do vencimento (na reunião, do início). */
export const ANTECEDENCIA_DO_LEMBRETE_MS = 60 * 60 * 1_000;

/** Atividades marcadas e notificadas por transação. */
const LOTE = 200;

/** Teto de lotes por execução (a próxima, 15 min depois, continua de onde parou). */
const LOTES_POR_EXECUCAO = 50;

export interface ResultadoDosLembretes {
  /** Lembretes "vence em breve" enviados. */
  vencendo: number;
  /** Avisos "atrasada" enviados. */
  atrasadas: number;
}

/** Linha devolvida pelo `UPDATE … RETURNING` que marca as atividades. */
interface AtividadeDoLembrete {
  id: string;
  tipo: TipoAtividade;
  titulo: string;
  responsavelId: string;
  venceEm: Date | null;
  inicioEm: Date | null;
  fimEm: Date | null;
}

export function linkDaAtividade(id: string): string {
  return `/atividades?atividade=${id}`;
}

/** Texto do lembrete de 1 hora antes (R6.5). */
export function notificacaoDeVencimento(
  atividade: AtividadeDoLembrete,
  agora: Date,
  fuso: string = FUSO_HORARIO_DAS_ATIVIDADES,
): NovaNotificacao {
  const data = atividade.venceEm ?? atividade.inicioEm ?? agora;
  const quando = descreverMomento(data, agora, fuso);
  const reuniao = atividade.tipo === 'REUNIAO';
  return {
    tipo: TIPOS_NOTIFICACAO.ATIVIDADE_VENCENDO,
    titulo: reuniao ? 'Reunião em breve' : 'Atividade vencendo',
    texto: reuniao
      ? `A reunião "${atividade.titulo}" começa ${quando}.`
      : `${tipoComArtigo(atividade.tipo)} "${atividade.titulo}" vence ${quando}.`,
    link: linkDaAtividade(atividade.id),
    dados: dadosDaNotificacao(atividade),
  };
}

/** Texto do aviso de atraso, enviado uma única vez (R6.5). */
export function notificacaoDeAtraso(
  atividade: AtividadeDoLembrete,
  agora: Date,
  fuso: string = FUSO_HORARIO_DAS_ATIVIDADES,
): NovaNotificacao {
  const prazo = prazoDaAtividade(atividade) ?? agora;
  const quando = descreverMomento(prazo, agora, fuso);
  const reuniao = atividade.tipo === 'REUNIAO';
  return {
    tipo: TIPOS_NOTIFICACAO.ATIVIDADE_ATRASADA,
    titulo: 'Atividade atrasada',
    texto: reuniao
      ? `A reunião "${atividade.titulo}" terminou ${quando} e continua pendente.`
      : `${tipoComArtigo(atividade.tipo)} "${atividade.titulo}" venceu ${quando} e continua pendente.`,
    link: linkDaAtividade(atividade.id),
    dados: dadosDaNotificacao(atividade),
  };
}

function dadosDaNotificacao(
  atividade: AtividadeDoLembrete,
): Record<string, unknown> {
  return {
    atividadeId: atividade.id,
    tipo: atividade.tipo,
    venceEm: atividade.venceEm,
    inicioEm: atividade.inicioEm,
    fimEm: atividade.fimEm,
  };
}

/**
 * Job de lembretes (R6.5), a cada 15 minutos pela fila (`atividades.lembretes`):
 *
 * 1. **vencendo** — pendentes cuja data (vencimento; na reunião, o início) cai
 *    na próxima 1 hora: notifica o responsável e grava `lembreteEnviadoEm`;
 * 2. **atrasada** — pendentes com o prazo no passado (R6.3): notifica uma única
 *    vez e grava `atrasoNotificadoEm`.
 *
 * A marcação e a notificação acontecem na mesma transação, com as linhas
 * travadas (`FOR UPDATE SKIP LOCKED`): duas execuções ao mesmo tempo (réplicas,
 * reentrega da fila) nunca notificam a mesma atividade duas vezes. Notas,
 * concluídas, canceladas e as de responsável desligado ficam de fora. Quem
 * recebe uma atividade por desligamento (R7.3) depois do lembrete recebe o seu
 * (o marcador anterior ao encaminhamento não vale para ele).
 *
 * Os marcadores não passam pela auditoria nem mudam `atualizadoEm`: são
 * controle do job, como a leitura de uma notificação.
 */
@Injectable()
export class LembretesAtividadesService implements OnModuleInit {
  private readonly logger = new Logger(LembretesAtividadesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly fila: FilaService,
    private readonly notificacoes: NotificacoesService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.fila.trabalhar(
      FILA_LEMBRETES_DE_ATIVIDADES,
      async () => {
        await this.executar();
      },
      {
        // Sem retentativa: a execução seguinte, 15 minutos depois, refaz o
        // que faltou (nada é marcado sem a notificação junto).
        tentativas: 0,
        prazoDeExecucaoSegundos: 10 * 60,
        guardarConcluidosPorSegundos: 24 * 60 * 60,
      },
    );
    await this.fila.agendar(FILA_LEMBRETES_DE_ATIVIDADES, AGENDA_DOS_LEMBRETES);
  }

  /** Uma execução do job. `agora` só muda nos testes. */
  async executar(agora: Date = new Date()): Promise<ResultadoDosLembretes> {
    const vencendo = await this.emLotes(() => this.lembrarVencimentos(agora));
    const atrasadas = await this.emLotes(() => this.avisarAtrasos(agora));
    if (vencendo + atrasadas > 0) {
      this.logger.log(
        `Lembretes de atividades: ${vencendo} vencendo, ${atrasadas} atrasada(s).`,
      );
    }
    return { vencendo, atrasadas };
  }

  private async emLotes(lote: () => Promise<number>): Promise<number> {
    let total = 0;
    for (let rodada = 0; rodada < LOTES_POR_EXECUCAO; rodada++) {
      const quantidade = await lote();
      total += quantidade;
      if (quantidade < LOTE) {
        break;
      }
    }
    return total;
  }

  private lembrarVencimentos(agora: Date): Promise<number> {
    const limite = new Date(agora.getTime() + ANTECEDENCIA_DO_LEMBRETE_MS);
    return this.prisma.$transaction(async (tx) => {
      // O marcador nunca fica antes do encaminhamento: assim a mesma linha não
      // volta a ser escolhida na execução seguinte.
      const marcadas = await tx.$queryRaw<AtividadeDoLembrete[]>`
        WITH escolhidas AS (
          SELECT a.id
            FROM atividades a
            JOIN usuarios u ON u.id = a.responsavel_id
           WHERE a.status = 'PENDENTE'
             AND a.tipo <> 'NOTA'
             AND u.ativo
             AND a.vence_em > ${agora}::timestamptz
             AND a.vence_em <= ${limite}::timestamptz
             AND (a.lembrete_enviado_em IS NULL
                  OR a.lembrete_enviado_em < a.encaminhada_em)
           ORDER BY a.vence_em, a.id
           LIMIT ${LOTE}
           FOR UPDATE OF a SKIP LOCKED
        )
        UPDATE atividades AS alvo
           SET lembrete_enviado_em = GREATEST(now(), COALESCE(alvo.encaminhada_em, now()))
          FROM escolhidas
         WHERE alvo.id = escolhidas.id
        RETURNING alvo.id,
                  alvo.tipo::text AS tipo,
                  alvo.titulo,
                  alvo.responsavel_id AS "responsavelId",
                  alvo.vence_em AS "venceEm",
                  alvo.inicio_em AS "inicioEm",
                  alvo.fim_em AS "fimEm"`;
      await this.notificarTodas(tx, marcadas, (atividade) =>
        notificacaoDeVencimento(atividade, agora),
      );
      return marcadas.length;
    });
  }

  private avisarAtrasos(agora: Date): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      // Prazo: o vencimento; na reunião, o fim (R6.3) — o mesmo de `prazoDaAtividade`.
      const marcadas = await tx.$queryRaw<AtividadeDoLembrete[]>`
        WITH escolhidas AS (
          SELECT a.id
            FROM atividades a
            JOIN usuarios u ON u.id = a.responsavel_id
           WHERE a.status = 'PENDENTE'
             AND a.tipo <> 'NOTA'
             AND u.ativo
             AND a.atraso_notificado_em IS NULL
             AND (CASE WHEN a.tipo = 'REUNIAO'
                       THEN COALESCE(a.fim_em, a.vence_em)
                       ELSE a.vence_em END) < ${agora}::timestamptz
           ORDER BY a.vence_em, a.id
           LIMIT ${LOTE}
           FOR UPDATE OF a SKIP LOCKED
        )
        UPDATE atividades AS alvo
           SET atraso_notificado_em = now()
          FROM escolhidas
         WHERE alvo.id = escolhidas.id
        RETURNING alvo.id,
                  alvo.tipo::text AS tipo,
                  alvo.titulo,
                  alvo.responsavel_id AS "responsavelId",
                  alvo.vence_em AS "venceEm",
                  alvo.inicio_em AS "inicioEm",
                  alvo.fim_em AS "fimEm"`;
      await this.notificarTodas(tx, marcadas, (atividade) =>
        notificacaoDeAtraso(atividade, agora),
      );
      return marcadas.length;
    });
  }

  private async notificarTodas(
    tx: Tx,
    atividades: readonly AtividadeDoLembrete[],
    montar: (atividade: AtividadeDoLembrete) => NovaNotificacao,
  ): Promise<void> {
    for (const atividade of atividades) {
      await this.notificacoes.notificar(
        tx,
        atividade.responsavelId,
        montar(atividade),
      );
    }
  }
}
