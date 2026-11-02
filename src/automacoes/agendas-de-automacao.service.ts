import { Injectable } from '@nestjs/common';
import {
  alvoDaDataRelativa,
  type DataRelativa,
  proximaOcorrencia,
  proximaVarreduraDaDataRelativa,
  type Recorrencia,
} from '../comum/gatilhos/agenda';
import { SegmentosService } from '../comum/segmentos/segmentos.service';
import type { Automacao, Prisma } from '../generated/prisma/client';
import { LogsTecnicosService } from '../logs/logs-tecnicos.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  LOTE_DA_VARREDURA,
  SOBREPOSICAO_DA_VARREDURA_MS,
} from './automacoes.constantes';
import { lerCondicoes } from './condicoes';
import { IniciadorDeExecucao } from './iniciador-de-execucao.service';

/** Ocorrências atrasadas que a varredura recupera de uma vez (queda longa não vira enxurrada). */
const OCORRENCIAS_DE_RECUPERACAO = 3;

function comoLista(valor: unknown): string[] {
  if (valor === undefined || valor === null || valor === '') {
    return [];
  }
  return (Array.isArray(valor) ? valor : [valor]) as string[];
}

/**
 * Gatilhos de agenda (R19), varridos a cada 5 minutos:
 * - `DATA_RELATIVA`: "N dias antes/depois de" um campo de data, na hora
 *   configurada (`proximaExecucaoEm` guarda a próxima ocorrência);
 * - `RECORRENCIA`: diária, semanal ou mensal, para os contatos do segmento;
 * - `negocio.parado` (etapa acima do prazo, R5.10) e `atividade.atrasada`: quem
 *   passou a satisfazer a condição desde a última varredura (`ultimaExecucaoEm`).
 *
 * Tudo é idempotente pela `chaveUnica` das execuções: repetir uma varredura
 * (queda no meio, janelas sobrepostas) não duplica nada.
 */
@Injectable()
export class AgendasDeAutomacao {
  constructor(
    private readonly prisma: PrismaService,
    private readonly iniciador: IniciadorDeExecucao,
    private readonly segmentos: SegmentosService,
    private readonly logs: LogsTecnicosService,
  ) {}

  async varrer(agora: Date): Promise<void> {
    const automacoes = await this.prisma.automacao.findMany({
      where: {
        ativa: true,
        excluidoEm: null,
        OR: [
          { tipoGatilho: { in: ['DATA_RELATIVA', 'RECORRENCIA'] } },
          { evento: { in: ['negocio.parado', 'atividade.atrasada'] } },
        ],
      },
      orderBy: { criadoEm: 'asc' },
    });
    for (const automacao of automacoes) {
      try {
        await this.varrerUma(automacao, agora);
      } catch (erro) {
        await this.logs.erro(
          'Automacoes',
          `Falha na agenda da automação "${automacao.nome}"`,
          erro,
          { automacaoId: automacao.id },
        );
      }
    }
  }

  /** Próxima ocorrência da agenda da automação depois de `apos` (nula se não é de agenda). */
  proximaOcorrenciaDa(
    automacao: Pick<Automacao, 'tipoGatilho' | 'gatilhoConfig'>,
    apos: Date,
  ): Date | null {
    if (automacao.tipoGatilho === 'DATA_RELATIVA') {
      return proximaVarreduraDaDataRelativa(
        automacao.gatilhoConfig as unknown as DataRelativa,
        apos,
      );
    }
    if (automacao.tipoGatilho === 'RECORRENCIA') {
      return proximaOcorrencia(
        automacao.gatilhoConfig as unknown as Recorrencia,
        apos,
      );
    }
    return null;
  }

  async varrerUma(automacao: Automacao, agora: Date): Promise<void> {
    if (automacao.tipoGatilho === 'EVENTO') {
      if (automacao.evento === 'negocio.parado') {
        await this.varrerParados(automacao, agora);
      } else if (automacao.evento === 'atividade.atrasada') {
        await this.varrerAtrasadas(automacao, agora);
      }
      return;
    }
    if (!automacao.proximaExecucaoEm) {
      await this.prisma.automacao.update({
        where: { id: automacao.id },
        data: { proximaExecucaoEm: this.proximaOcorrenciaDa(automacao, agora) },
      });
      return;
    }
    let ocorrencia = automacao.proximaExecucaoEm;
    for (
      let i = 0;
      i < OCORRENCIAS_DE_RECUPERACAO && ocorrencia.getTime() <= agora.getTime();
      i += 1
    ) {
      if (automacao.tipoGatilho === 'DATA_RELATIVA') {
        await this.executarDataRelativa(automacao, ocorrencia);
      } else {
        await this.executarRecorrencia(automacao, ocorrencia);
      }
      const proxima = this.proximaOcorrenciaDa(automacao, ocorrencia);
      if (!proxima) {
        return;
      }
      ocorrencia = proxima;
      await this.prisma.automacao.update({
        where: { id: automacao.id },
        data: { proximaExecucaoEm: ocorrencia, ultimaExecucaoEm: agora },
      });
    }
    if (ocorrencia.getTime() <= agora.getTime()) {
      // Ocorrências além do limite de recuperação: pula para a próxima futura.
      const futura = this.proximaOcorrenciaDa(automacao, agora);
      await this.prisma.automacao.update({
        where: { id: automacao.id },
        data: { proximaExecucaoEm: futura },
      });
    }
  }

  // -------------------------------------------------------------------------
  // Data relativa
  // -------------------------------------------------------------------------

  private async executarDataRelativa(
    automacao: Automacao,
    ocorrencia: Date,
  ): Promise<void> {
    const regra = automacao.gatilhoConfig as unknown as DataRelativa;
    const alvo = alvoDaDataRelativa(regra, ocorrencia);
    const intervalo = { gte: alvo.inicio, lt: alvo.fim };
    const campo = regra.campo;
    const dia = new Date(`${alvo.diaDoCampo}T00:00:00.000Z`);

    const buscar = (
      depoisDe: string | undefined,
    ): Promise<Array<{ id: string }>> => {
      const cursor = depoisDe ? { id: { gt: depoisDe } } : {};
      const paginacao = {
        select: { id: true },
        orderBy: { id: 'asc' as const },
        take: LOTE_DA_VARREDURA,
      };
      if (campo.startsWith('contato.campos.')) {
        return this.prisma.contato.findMany({
          where: {
            excluidoEm: null,
            camposPersonalizados: {
              path: [campo.slice('contato.campos.'.length)],
              equals: alvo.diaDoCampo,
            },
            ...cursor,
          },
          ...paginacao,
        });
      }
      switch (campo) {
        case 'contato.criadoEm':
          return this.prisma.contato.findMany({
            where: { excluidoEm: null, criadoEm: intervalo, ...cursor },
            ...paginacao,
          });
        case 'negocio.criadoEm':
          return this.prisma.negocio.findMany({
            where: {
              excluidoEm: null,
              status: 'ABERTO',
              criadoEm: intervalo,
              ...cursor,
            },
            ...paginacao,
          });
        case 'negocio.previsaoFechamento':
          return this.prisma.negocio.findMany({
            where: {
              excluidoEm: null,
              status: 'ABERTO',
              previsaoFechamento: dia,
              ...cursor,
            },
            ...paginacao,
          });
        case 'negocio.ganhoEm':
          return this.prisma.negocio.findMany({
            where: {
              excluidoEm: null,
              status: 'GANHO',
              ganhoEm: intervalo,
              ...cursor,
            },
            ...paginacao,
          });
        case 'atividade.venceEm':
          return this.prisma.atividade.findMany({
            where: { status: 'PENDENTE', venceEm: intervalo, ...cursor },
            ...paginacao,
          });
        default:
          return Promise.resolve([]);
      }
    };

    let depoisDe: string | undefined;
    for (;;) {
      const lote = await buscar(depoisDe);
      for (const { id } of lote) {
        await this.iniciador.iniciar({
          automacao,
          entidadeId: id,
          chaveDaOrigem: `data:${id}:${alvo.diaDoCampo}`,
          agora: ocorrencia,
          contexto: {
            gatilho: {
              tipo: 'DATA_RELATIVA',
              campo,
              dias: regra.dias,
              diaDoCampo: alvo.diaDoCampo,
            },
          },
        });
      }
      if (lote.length < LOTE_DA_VARREDURA) {
        break;
      }
      depoisDe = lote[lote.length - 1].id;
    }
  }

  // -------------------------------------------------------------------------
  // Recorrência
  // -------------------------------------------------------------------------

  private async executarRecorrencia(
    automacao: Automacao,
    ocorrencia: Date,
  ): Promise<void> {
    const { segmento } = lerCondicoes(automacao.condicoes);
    if (!segmento) {
      return;
    }
    for await (const ids of this.segmentos.iterarIds(segmento, {
      excluirOptOut: automacao.marketing,
      lote: LOTE_DA_VARREDURA,
    })) {
      for (const id of ids) {
        await this.iniciador.iniciar({
          automacao,
          entidadeId: id,
          chaveDaOrigem: `recorrencia:${ocorrencia.toISOString()}:${id}`,
          agora: ocorrencia,
          contexto: {
            gatilho: {
              tipo: 'RECORRENCIA',
              ocorrencia: ocorrencia.toISOString(),
            },
          },
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Negócio parado e atividade atrasada
  // -------------------------------------------------------------------------

  /** Janela de varredura: do marco anterior (com sobreposição) até agora; atualiza o marco. */
  private async janela(
    automacao: Automacao,
    agora: Date,
  ): Promise<{ de: Date; ate: Date } | null> {
    if (!automacao.ultimaExecucaoEm) {
      // Recém-ativada sem marco: só marca (não age sobre o passado).
      await this.prisma.automacao.update({
        where: { id: automacao.id },
        data: { ultimaExecucaoEm: agora },
      });
      return null;
    }
    return {
      de: new Date(
        automacao.ultimaExecucaoEm.getTime() - SOBREPOSICAO_DA_VARREDURA_MS,
      ),
      ate: agora,
    };
  }

  private async varrerParados(
    automacao: Automacao,
    agora: Date,
  ): Promise<void> {
    const janela = await this.janela(automacao, agora);
    if (!janela) {
      return;
    }
    const filtros = automacao.gatilhoConfig as Record<string, unknown>;
    const extra = Number(filtros.diasAlemDoPrazo ?? 0);
    const funis = comoLista(filtros.funilId);
    const etapasFiltradas = comoLista(filtros.etapaId);
    const etapas = await this.prisma.etapa.findMany({
      where: {
        prazoDias: { not: null },
        tipo: 'ABERTA',
        funil: { excluidoEm: null, ativo: true },
        ...(funis.length > 0 ? { funilId: { in: funis } } : {}),
        ...(etapasFiltradas.length > 0 ? { id: { in: etapasFiltradas } } : {}),
      },
      select: { id: true, prazoDias: true },
    });
    const dia = 86_400_000;
    const ou: Prisma.NegocioWhereInput[] = etapas.map((e) => {
      const espera = ((e.prazoDias ?? 0) + extra) * dia;
      return {
        etapaId: e.id,
        etapaDesde: {
          gt: new Date(janela.de.getTime() - espera),
          lte: new Date(janela.ate.getTime() - espera),
        },
      };
    });
    if (ou.length > 0) {
      let depoisDe: string | undefined;
      for (;;) {
        const lote = await this.prisma.negocio.findMany({
          where: {
            excluidoEm: null,
            status: 'ABERTO',
            OR: ou,
            ...(depoisDe ? { id: { gt: depoisDe } } : {}),
          },
          select: { id: true, etapaDesde: true, etapaId: true },
          orderBy: { id: 'asc' },
          take: LOTE_DA_VARREDURA,
        });
        for (const n of lote) {
          await this.iniciador.iniciar({
            automacao,
            entidadeId: n.id,
            chaveDaOrigem: `parado:${n.id}:${n.etapaDesde.toISOString()}`,
            agora,
            contexto: {
              gatilho: {
                tipo: 'AGENDA',
                evento: 'negocio.parado',
                etapaId: n.etapaId,
                etapaDesde: n.etapaDesde.toISOString(),
              },
            },
          });
        }
        if (lote.length < LOTE_DA_VARREDURA) {
          break;
        }
        depoisDe = lote[lote.length - 1].id;
      }
    }
    await this.prisma.automacao.update({
      where: { id: automacao.id },
      data: { ultimaExecucaoEm: agora },
    });
  }

  private async varrerAtrasadas(
    automacao: Automacao,
    agora: Date,
  ): Promise<void> {
    const janela = await this.janela(automacao, agora);
    if (!janela) {
      return;
    }
    const filtros = automacao.gatilhoConfig as Record<string, unknown>;
    const espera = Number(filtros.horasAlemDoVencimento ?? 0) * 3_600_000;
    const tipos = comoLista(filtros.tipo);
    let depoisDe: string | undefined;
    for (;;) {
      const lote = await this.prisma.atividade.findMany({
        where: {
          status: 'PENDENTE',
          tipo: tipos.length > 0 ? { in: tipos as never[] } : { not: 'NOTA' },
          venceEm: {
            gt: new Date(janela.de.getTime() - espera),
            lte: new Date(janela.ate.getTime() - espera),
          },
          ...(depoisDe ? { id: { gt: depoisDe } } : {}),
        },
        select: { id: true, venceEm: true },
        orderBy: { id: 'asc' },
        take: LOTE_DA_VARREDURA,
      });
      for (const a of lote) {
        await this.iniciador.iniciar({
          automacao,
          entidadeId: a.id,
          chaveDaOrigem: `atrasada:${a.id}:${a.venceEm?.toISOString() ?? ''}`,
          agora,
          contexto: {
            gatilho: {
              tipo: 'AGENDA',
              evento: 'atividade.atrasada',
              venceEm: a.venceEm?.toISOString() ?? null,
            },
          },
        });
      }
      if (lote.length < LOTE_DA_VARREDURA) {
        break;
      }
      depoisDe = lote[lote.length - 1].id;
    }
    await this.prisma.automacao.update({
      where: { id: automacao.id },
      data: { ultimaExecucaoEm: agora },
    });
  }
}
