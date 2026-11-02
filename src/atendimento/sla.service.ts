import { Injectable, type OnModuleInit } from '@nestjs/common';
import { FilaService } from '../fila/fila.service';
import { NotificacoesService } from '../notificacoes/notificacoes.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  FILA_SLA_ATENDIMENTO,
  linkDaConversa,
  TIPOS_NOTIFICACAO_ATENDIMENTO,
} from './atendimento.constantes';
import { lideresParaAvisar } from './lideres';
import { descreverMinutos } from './sla';

/** Conversas avisadas por rodada (o resto fica para o minuto seguinte). */
const LOTE_DO_SLA = 200;

type Prazo = 'primeiraResposta' | 'resolucao';

export interface ResultadoDaVarredura {
  primeiraResposta: number;
  resolucao: number;
}

/**
 * Aviso de SLA estourado (R12): a cada minuto (`atendimento.sla`), procura as
 * conversas em aberto cujo prazo de primeira resposta ou de resolução passou
 * e avisa o líder — uma vez por prazo. O líder é o do responsável (líder
 * direto, ativo); sem responsável (ou sem esse líder), os líderes ativos da
 * área da fila.
 */
@Injectable()
export class SlaDoAtendimento implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly fila: FilaService,
    private readonly notificacoes: NotificacoesService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.fila.trabalhar(FILA_SLA_ATENDIMENTO, () =>
      this.varrer().then(() => undefined),
    );
    await this.fila.agendar(FILA_SLA_ATENDIMENTO, '* * * * *');
  }

  /** Uma rodada: avisa os estouros ainda não avisados. */
  async varrer(agora: Date = new Date()): Promise<ResultadoDaVarredura> {
    return {
      primeiraResposta: await this.avisar('primeiraResposta', agora),
      resolucao: await this.avisar('resolucao', agora),
    };
  }

  private async avisar(prazo: Prazo, agora: Date): Promise<number> {
    const conversas = await this.prisma.conversa.findMany({
      where:
        prazo === 'primeiraResposta'
          ? {
              status: { not: 'RESOLVIDA' },
              primeiraRespostaEm: null,
              slaPrimeiraRespostaAte: { lte: agora },
              slaPrimeiraRespostaAvisadoEm: null,
            }
          : {
              status: { not: 'RESOLVIDA' },
              slaResolucaoAte: { lte: agora },
              slaResolucaoAvisadoEm: null,
            },
      orderBy:
        prazo === 'primeiraResposta'
          ? { slaPrimeiraRespostaAte: 'asc' }
          : { slaResolucaoAte: 'asc' },
      take: LOTE_DO_SLA,
      include: {
        contato: { select: { nome: true } },
        canal: { select: { nome: true } },
        fila: {
          select: {
            nome: true,
            area: true,
            slaPrimeiraRespostaMinutos: true,
            slaResolucaoMinutos: true,
          },
        },
        responsavel: {
          select: { nome: true, liderId: true },
        },
      },
    });
    let avisadas = 0;
    for (const conversa of conversas) {
      const marcada = await this.prisma.$transaction(async (tx) => {
        const { count } = await tx.conversa.updateMany({
          where:
            prazo === 'primeiraResposta'
              ? {
                  id: conversa.id,
                  slaPrimeiraRespostaAvisadoEm: null,
                  primeiraRespostaEm: null,
                  status: { not: 'RESOLVIDA' },
                }
              : {
                  id: conversa.id,
                  slaResolucaoAvisadoEm: null,
                  status: { not: 'RESOLVIDA' },
                },
          data:
            prazo === 'primeiraResposta'
              ? { slaPrimeiraRespostaAvisadoEm: agora }
              : { slaResolucaoAvisadoEm: agora },
        });
        if (count === 0) {
          return false;
        }
        const lideres = await lideresParaAvisar(
          tx,
          conversa.responsavel?.liderId ?? null,
          conversa.fila?.area ?? null,
        );
        const minutos =
          prazo === 'primeiraResposta'
            ? conversa.fila?.slaPrimeiraRespostaMinutos
            : conversa.fila?.slaResolucaoMinutos;
        const comQuem = conversa.responsavel
          ? `com ${conversa.responsavel.nome}`
          : 'sem responsável';
        await this.notificacoes.notificarVarios(tx, lideres, {
          tipo:
            prazo === 'primeiraResposta'
              ? TIPOS_NOTIFICACAO_ATENDIMENTO.SLA_PRIMEIRA_RESPOSTA
              : TIPOS_NOTIFICACAO_ATENDIMENTO.SLA_RESOLUCAO,
          titulo:
            prazo === 'primeiraResposta'
              ? 'Conversa sem primeira resposta no prazo'
              : 'Conversa passou do prazo de resolução',
          texto: `${conversa.contato.nome} (${conversa.canal.nome}), ${comQuem}${conversa.fila ? ` na fila ${conversa.fila.nome}` : ''}${minutos ? ` — prazo de ${descreverMinutos(minutos)}` : ''}.`,
          link: linkDaConversa(conversa.id),
          dados: { conversaId: conversa.id, prazo },
        });
        return true;
      });
      if (marcada) {
        avisadas++;
      }
    }
    return avisadas;
  }
}
