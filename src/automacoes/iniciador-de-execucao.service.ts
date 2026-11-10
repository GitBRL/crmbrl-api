import { Injectable } from '@nestjs/common';
import { setorDaPessoa } from '../comum/dominio/papeis';
import { permiteEncadear } from '../comum/gatilhos/catalogo';
import {
  chaveDeLimite,
  GatilhosService,
} from '../comum/gatilhos/gatilhos.service';
import type { CadeiaDeAutomacao } from '../comum/contexto/contexto-requisicao';
import type { DefinicaoDePassos } from '../comum/passos/definicao';
import { PassosService } from '../comum/passos/passos.service';
import { SegmentosService } from '../comum/segmentos/segmentos.service';
import type { Automacao, Execucao } from '../generated/prisma/client';
import { LogsTecnicosService } from '../logs/logs-tecnicos.service';
import { PrismaService } from '../prisma/prisma.service';
import { lerCondicoes } from './condicoes';
import type { Area } from '../comum/dominio/setores';

export type EntidadeDeAutomacao =
  'contato' | 'negocio' | 'atividade' | 'conversa';

/** A entidade do gatilho resolvida: ids relacionados e o que serve para o escopo. */
export interface AlvoResolvido {
  entidade: EntidadeDeAutomacao;
  entidadeId: string;
  contatoId: string;
  negocioId: string | null;
  conversaId: string | null;
  /** Área da entidade (funil, fila ou responsável); nula se não tem. */
  area: Area | null;
  optOut: boolean;
}

export type MotivoDeNaoIniciar =
  | 'alvo_inexistente'
  | 'fora_da_area'
  | 'opt_out'
  | 'fora_do_segmento'
  | 'limite'
  | 'encadeamento';

export type ResultadoDoInicio =
  | { iniciada: true; execucao: Execucao; criada: boolean }
  | { iniciada: false; motivo: MotivoDeNaoIniciar };

export interface PedidoDeInicio {
  automacao: Automacao;
  entidadeId: string;
  /** Identifica a origem para a `chaveUnica` quando o limite é SEMPRE. */
  chaveDaOrigem: string;
  eventoId?: string | null;
  cadeia?: CadeiaDeAutomacao | null;
  contexto?: Record<string, unknown>;
  /** Para os gatilhos de agenda (a hora do gatilho). */
  agora?: Date;
}

/**
 * Início das execuções (R19): resolve a entidade do gatilho, aplica o escopo de
 * área, o opt-out de marketing (R4.6), as condições (segmento), o limite por
 * entidade e a proteção contra laços, e inicia a execução no executor de passos
 * com `chaveUnica` (a entrega "pelo menos uma vez" não duplica).
 */
@Injectable()
export class IniciadorDeExecucao {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passos: PassosService,
    private readonly gatilhos: GatilhosService,
    private readonly segmentos: SegmentosService,
    private readonly logs: LogsTecnicosService,
  ) {}

  /** Entidade do gatilho com os ids relacionados (nula se não existe mais). */
  async resolverAlvo(
    entidade: EntidadeDeAutomacao,
    entidadeId: string,
  ): Promise<AlvoResolvido | null> {
    const optOutDe = (c: { optOutMarketing: boolean }) => c.optOutMarketing;
    switch (entidade) {
      case 'contato': {
        const contato = await this.prisma.contato.findFirst({
          where: { id: entidadeId, excluidoEm: null },
          select: { id: true, optOutMarketing: true },
        });
        return contato
          ? {
              entidade,
              entidadeId,
              contatoId: contato.id,
              negocioId: null,
              conversaId: null,
              area: null,
              optOut: optOutDe(contato),
            }
          : null;
      }
      case 'negocio': {
        const negocio = await this.prisma.negocio.findFirst({
          where: { id: entidadeId, excluidoEm: null },
          select: {
            id: true,
            contatoId: true,
            funil: { select: { area: true } },
            contato: { select: { optOutMarketing: true, excluidoEm: true } },
          },
        });
        return negocio && !negocio.contato.excluidoEm
          ? {
              entidade,
              entidadeId,
              contatoId: negocio.contatoId,
              negocioId: negocio.id,
              conversaId: null,
              area: negocio.funil.area,
              optOut: optOutDe(negocio.contato),
            }
          : null;
      }
      case 'atividade': {
        const atividade = await this.prisma.atividade.findFirst({
          where: { id: entidadeId },
          select: {
            contatoId: true,
            negocioId: true,
            responsavel: { select: { papel: true, area: true } },
            contato: { select: { optOutMarketing: true, excluidoEm: true } },
            negocio: { select: { contatoId: true } },
          },
        });
        const contatoId = atividade?.contatoId ?? atividade?.negocio?.contatoId;
        if (!atividade || !contatoId) {
          return null;
        }
        const contato =
          atividade.contato ??
          (await this.prisma.contato.findFirst({
            where: { id: contatoId },
            select: { optOutMarketing: true, excluidoEm: true },
          }));
        return contato && !contato.excluidoEm
          ? {
              entidade,
              entidadeId,
              contatoId,
              negocioId: atividade.negocioId,
              conversaId: null,
              area: setorDaPessoa(atividade.responsavel),
              optOut: optOutDe(contato),
            }
          : null;
      }
      case 'conversa': {
        const conversa = await this.prisma.conversa.findFirst({
          where: { id: entidadeId },
          select: {
            id: true,
            contatoId: true,
            fila: { select: { area: true } },
            contato: { select: { optOutMarketing: true, excluidoEm: true } },
          },
        });
        return conversa && !conversa.contato.excluidoEm
          ? {
              entidade,
              entidadeId,
              contatoId: conversa.contatoId,
              negocioId: null,
              conversaId: conversa.id,
              area: conversa.fila?.area ?? null,
              optOut: optOutDe(conversa.contato),
            }
          : null;
      }
    }
  }

  /** O alvo está no escopo da automação? Sem área = todas; com área, só a entidade dessa área. */
  noEscopo(automacao: Pick<Automacao, 'area'>, alvo: AlvoResolvido): boolean {
    return (
      automacao.area === null ||
      alvo.entidade === 'contato' ||
      alvo.area === null ||
      alvo.area === automacao.area
    );
  }

  /** Confere o alvo e as condições (sem iniciar nada). Para o modo teste e para o gatilho. */
  async conferir(
    automacao: Automacao,
    alvo: AlvoResolvido,
  ): Promise<Exclude<
    MotivoDeNaoIniciar,
    'limite' | 'encadeamento' | 'alvo_inexistente'
  > | null> {
    if (!this.noEscopo(automacao, alvo)) {
      return 'fora_da_area';
    }
    if (automacao.marketing && alvo.optOut) {
      return 'opt_out';
    }
    const { segmento } = lerCondicoes(automacao.condicoes);
    if (segmento) {
      const dentro = await this.segmentos.contem(segmento, alvo.contatoId, {
        excluirOptOut: automacao.marketing,
        ...(alvo.negocioId ? { negocioId: alvo.negocioId } : {}),
      });
      if (!dentro) {
        return 'fora_do_segmento';
      }
    }
    return null;
  }

  async iniciar(pedido: PedidoDeInicio): Promise<ResultadoDoInicio> {
    const { automacao } = pedido;
    const entidade = automacao.entidade as EntidadeDeAutomacao;
    const alvo = await this.resolverAlvo(entidade, pedido.entidadeId);
    if (!alvo) {
      return { iniciada: false, motivo: 'alvo_inexistente' };
    }
    const motivo = await this.conferir(automacao, alvo);
    if (motivo) {
      return { iniciada: false, motivo };
    }
    const permissao = permiteEncadear(pedido.cadeia ?? null, automacao.id);
    if (!permissao.permitido) {
      await this.logs.aviso(
        'Automacoes',
        `Automação "${automacao.nome}" não iniciada para ${entidade} ${alvo.entidadeId}: ${permissao.motivo}`,
        { automacaoId: automacao.id, cadeia: pedido.cadeia },
      );
      return { iniciada: false, motivo: 'encadeamento' };
    }
    const agora = pedido.agora ?? new Date();
    const podeExecutar = await this.gatilhos.podeExecutarParaEntidade({
      automacaoId: automacao.id,
      entidadeId: alvo.entidadeId,
      limite: automacao.limiteExecucao,
      periodoDias: automacao.limitePeriodoDias,
      agora,
    });
    const chaveUnica = chaveDeLimite(
      automacao.id,
      alvo.entidadeId,
      automacao.limiteExecucao,
      {
        extra: pedido.chaveDaOrigem,
        eventoId: pedido.eventoId ?? undefined,
        periodoDias: automacao.limitePeriodoDias,
        agora,
      },
    );
    if (!podeExecutar) {
      // Reentrega do mesmo evento: a execução que já existe é a desta origem.
      const existente = await this.prisma.execucao.findUnique({
        where: { chaveUnica },
      });
      return existente
        ? { iniciada: true, execucao: existente, criada: false }
        : { iniciada: false, motivo: 'limite' };
    }
    const { execucao, criada } = await this.passos.iniciar({
      tipo: 'AUTOMACAO',
      nome: automacao.nome,
      definicao: automacao.definicao as unknown as DefinicaoDePassos,
      automacaoId: automacao.id,
      automacaoVersao: automacao.versao,
      entidade,
      entidadeId: alvo.entidadeId,
      contatoId: alvo.contatoId,
      negocioId: alvo.negocioId,
      conversaId: alvo.conversaId,
      eventoId: pedido.eventoId ?? null,
      chaveUnica,
      cadeiaDeOrigem: pedido.cadeia ?? null,
      contexto: pedido.contexto ?? {},
    });
    // "Última vez" da lista: toda execução nova a atualiza. Nos gatilhos de varredura
    // (negócio parado, atividade atrasada) `ultimaExecucaoEm` é o marco da janela e quem o
    // move é a própria varredura.
    if (criada && !EVENTOS_DE_VARREDURA.has(automacao.evento ?? '')) {
      await this.prisma.automacao.update({
        where: { id: automacao.id },
        data: { ultimaExecucaoEm: agora },
      });
    }
    return { iniciada: true, execucao, criada };
  }
}

const EVENTOS_DE_VARREDURA: ReadonlySet<string> = new Set([
  'negocio.parado',
  'atividade.atrasada',
]);
