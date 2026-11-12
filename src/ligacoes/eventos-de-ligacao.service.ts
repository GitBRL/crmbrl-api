import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { EventosDominioService } from '../eventos/eventos-dominio.service';
import { FilaService } from '../fila/fila.service';
import { PrismaService, type Tx } from '../prisma/prisma.service';
import type { ResumoGravado } from '../transcricao/transcricao.constantes';
import { ConfiguracaoDeLigacoesService } from './configuracao-ligacoes.service';
import { canalDaLigacao, resultadoDaLigacao } from './ligacoes.constantes';
import { ESPERA_PARA_FINALIZAR_SOZINHO_S } from './gravacao/gravacao.constantes';
import type { LigacaoCompleta } from './ligacao-dto';
import { INCLUIR_LIGACAO } from './ligacao-dto';

/** Eventos de domínio das ligações (R29.9): gatilhos das automações e webhook de saída. */
export const EVENTOS_DE_LIGACAO = {
  /** Recebida que ninguém atendeu. */
  PERDIDA: 'ligacao.perdida',
  /** Qualquer ligação que terminou (atendida ou não), com o `resultado`. */
  ENCERRADA: 'ligacao.encerrada',
} as const;

/** Job que espera o resumo ficar pronto antes de publicar `ligacao.encerrada` (só com o resumo no webhook). */
export const FILA_PUBLICAR_ENCERRADA = 'ligacoes.publicar-encerrada';

/** Quanto esperar entre as conferências do resumo e o máximo total (depois publica sem ele). */
const ESPERA_ENTRE_CONFERENCIAS_S = 20;
const ESPERA_MAXIMA_S = 20 * 60;

const iso = (data: Date | null): string | null => data?.toISOString() ?? null;

/** O resumo como o webhook o leva (sem as sugestões de atividade nem o modelo). */
function resumoParaWebhook(resumo: ResumoGravado | null): object | null {
  return resumo
    ? {
        assunto: resumo.assunto,
        pontosPrincipais: resumo.pontosPrincipais,
        combinados: resumo.combinados,
        proximosPassos: resumo.proximosPassos,
        sentimento: resumo.sentimento,
      }
    : null;
}

/** O que o evento `ligacao.encerrada` (e o webhook) leva. Sem áudio, sem transcrição; resumo só se `comResumo`. */
export function dadosDoEventoDeLigacao(
  ligacao: LigacaoCompleta,
  comResumo: boolean,
): Record<string, unknown> {
  const dados: Record<string, unknown> = {
    ligacaoId: ligacao.id,
    canalId: ligacao.canalId,
    canalTipo: ligacao.provedor === 'WHATSAPP' ? 'WHATSAPP_OFICIAL' : null,
    provedor: ligacao.provedor,
    negocioId: ligacao.negocioId,
    contatoId: ligacao.contatoId,
    contato: { id: ligacao.contato.id, nome: ligacao.contato.nome },
    conversaId: ligacao.conversaId,
    atividadeId: ligacao.atividadeId,
    direcao: ligacao.direcao,
    estado: ligacao.estado,
    resultado: resultadoDaLigacao(ligacao.estado),
    motivo: ligacao.motivo,
    duracaoSegundos: ligacao.duracaoSegundos ?? 0,
    esperaSegundos:
      ligacao.atendidaEm !== null
        ? Math.max(
            0,
            Math.round(
              (ligacao.atendidaEm.getTime() - ligacao.iniciadaEm.getTime()) /
                1000,
            ),
          )
        : null,
    atendenteId: ligacao.atendenteId,
    atendente: ligacao.atendente
      ? { id: ligacao.atendente.id, nome: ligacao.atendente.nome }
      : null,
    iniciadaEm: ligacao.iniciadaEm.toISOString(),
    atendidaEm: iso(ligacao.atendidaEm),
    encerradaEm: iso(ligacao.encerradaEm),
  };
  if (comResumo) {
    dados.resumo = resumoParaWebhook(ligacao.resumo as ResumoGravado | null);
  }
  return dados;
}

/**
 * Publica `ligacao.perdida` e `ligacao.encerrada` na outbox quando a ligação chega a um estado
 * terminal (na mesma transação do fechamento). O webhook de saída leva ids, direção, resultado,
 * duração, atendente, contato e (só se o Admin marcar no canal) o resumo; nunca o áudio nem a
 * transcrição. Com o resumo marcado, uma ligação gravada espera o resumo ficar pronto (até 20 min).
 */
@Injectable()
export class EventosDeLigacaoService implements OnModuleInit {
  private readonly logger = new Logger('EventosDeLigacao');

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventos: EventosDominioService,
    private readonly fila: FilaService,
    private readonly config: ConfiguracaoDeLigacoesService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.fila.trabalhar<{ ligacaoId: string; desde: string }>(
      FILA_PUBLICAR_ENCERRADA,
      (trabalho) =>
        this.publicarQuandoPronto(
          trabalho.dados.ligacaoId,
          new Date(trabalho.dados.desde),
        ),
    );
  }

  /** Chamado por `LigacoesService.finalizar`, dentro da transação. */
  async aoEncerrar(tx: Tx, ligacao: LigacaoCompleta): Promise<void> {
    if (ligacao.estado === 'PERDIDA') {
      await this.eventos.publicar(
        tx,
        EVENTOS_DE_LIGACAO.PERDIDA,
        this.dados(ligacao, false),
      );
    }
    const config = await this.config.ler(canalDaLigacao(ligacao));
    const aguardaResumo =
      config.webhookIncluiResumo &&
      ligacao.gravar &&
      ligacao.atendidaEm !== null;
    if (aguardaResumo) {
      await this.fila.enviar(
        FILA_PUBLICAR_ENCERRADA,
        { ligacaoId: ligacao.id, desde: new Date().toISOString() },
        {
          tx,
          atrasoSegundos: ESPERA_PARA_FINALIZAR_SOZINHO_S + 10,
          chaveUnica: `publicar-encerrada:${ligacao.id}`,
        },
      );
      return;
    }
    await this.eventos.publicar(
      tx,
      EVENTOS_DE_LIGACAO.ENCERRADA,
      this.dados(ligacao, config.webhookIncluiResumo),
    );
  }

  /** Job: publica quando o resumo terminou (pronto, falhou ou desativado) ou o prazo acabou. */
  async publicarQuandoPronto(ligacaoId: string, desde: Date): Promise<void> {
    const ligacao = await this.prisma.ligacao.findUnique({
      where: { id: ligacaoId },
      include: INCLUIR_LIGACAO,
    });
    if (!ligacao) return;
    const esperouMuito = Date.now() - desde.getTime() > ESPERA_MAXIMA_S * 1000;
    if (!esperouMuito && !this.processamentoTerminou(ligacao)) {
      await this.fila.enviar(
        FILA_PUBLICAR_ENCERRADA,
        { ligacaoId, desde: desde.toISOString() },
        { atrasoSegundos: ESPERA_ENTRE_CONFERENCIAS_S },
      );
      return;
    }
    const config = await this.config.ler(canalDaLigacao(ligacao));
    await this.prisma.$transaction(async (tx) => {
      await this.eventos.publicar(
        tx,
        EVENTOS_DE_LIGACAO.ENCERRADA,
        this.dados(ligacao, config.webhookIncluiResumo),
      );
    });
    if (esperouMuito) {
      this.logger.warn(
        `ligacao.encerrada ${ligacaoId} publicada sem esperar o resumo (passou de ${ESPERA_MAXIMA_S / 60} min).`,
      );
    }
  }

  private processamentoTerminou(ligacao: LigacaoCompleta): boolean {
    if (
      ligacao.resumoSituacao === 'PRONTO' ||
      ligacao.resumoSituacao === 'FALHOU' ||
      ligacao.resumoSituacao === 'DESATIVADO' ||
      ligacao.transcricaoSituacao === 'FALHOU' ||
      ligacao.transcricaoSituacao === 'DESATIVADA' ||
      ligacao.gravacaoSituacao === 'FALHOU' ||
      ligacao.gravacaoRemovidaEm !== null
    ) {
      return true;
    }
    // Nada subiu do navegador: a gravação nunca começa.
    return (
      ligacao.gravacaoSituacao === 'SEM' &&
      ligacao.transcricaoSituacao === null &&
      ligacao.encerradaEm !== null &&
      Date.now() - ligacao.encerradaEm.getTime() >
        (ESPERA_PARA_FINALIZAR_SOZINHO_S + 60) * 1000
    );
  }

  /** O que o evento (e o webhook) leva. Sem áudio, sem transcrição; resumo só se `comResumo`. */
  dados(ligacao: LigacaoCompleta, comResumo: boolean): Record<string, unknown> {
    return dadosDoEventoDeLigacao(ligacao, comResumo);
  }
}
