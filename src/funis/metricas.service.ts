import { Injectable } from '@nestjs/common';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import { formatarValor } from '../comum/dominio/dinheiro';
import {
  DadosInvalidosException,
  NaoEncontradoException,
} from '../comum/erros/excecoes';
import type { Etapa, Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { filtroDeNegociosVisiveis, podeVerArea } from './acesso-funis';
import type {
  ConversaoEntreEtapasDto,
  FiltroMetricasDto,
  MetricaDaEtapaDto,
  MetricasDoFunilDto,
} from './dto/metricas.dto';
import {
  contarAlcance,
  mediaInteira,
  proporcao,
  segundosEmDias,
} from './metricas-calculo';
import { limiteDeParado } from './negocio-completo';

/** Período padrão das métricas, terminando agora. */
const PERIODO_PADRAO_DIAS = 30;

function resumoDaEtapa(etapa: Etapa) {
  return {
    id: etapa.id,
    nome: etapa.nome,
    tipo: etapa.tipo,
    ordem: etapa.ordem,
  };
}

/**
 * Métricas base de um funil (R5.10), calculadas do histórico de movimentação
 * e respeitando a visibilidade de quem consulta (R5.9):
 *
 * - **por etapa**: negócios e valor agora, parados (acima do prazo-alvo),
 *   entradas e saídas no período e o tempo médio na etapa de quem saiu dela;
 * - **conversão entre etapas** da coorte criada no período: das que alcançaram
 *   uma etapa (ou alguma depois dela), quantas alcançaram a seguinte — a
 *   sequência é a das etapas abertas e, por último, a de ganho;
 * - **ciclo médio**: criação → ganho dos ganhos no período;
 * - **parados**: abertos agora com tempo na etapa maior que o prazo-alvo.
 */
@Injectable()
export class MetricasService {
  constructor(private readonly prisma: PrismaService) {}

  async doFunil(
    usuario: UsuarioAutenticado,
    funilId: string,
    filtro: FiltroMetricasDto,
  ): Promise<MetricasDoFunilDto> {
    const funil = await this.prisma.funil.findFirst({
      where: { id: funilId, excluidoEm: null },
      include: { etapas: { orderBy: [{ ordem: 'asc' }, { criadoEm: 'asc' }] } },
    });
    if (!funil || !podeVerArea(usuario, funil.area)) {
      throw new NaoEncontradoException('Funil não encontrado.');
    }
    const { de, ate } = this.periodo(filtro);
    const agora = new Date();
    const doFunil: Prisma.NegocioWhereInput = {
      AND: [
        { funilId: funil.id },
        { excluidoEm: null },
        filtroDeNegociosVisiveis(usuario),
        ...(filtro.responsavelId
          ? [{ responsavelId: filtro.responsavelId }]
          : []),
      ],
    };
    const noPeriodo = { gte: de, lt: ate };

    const [atuais, entradas, saidas, coorte, ganhos, parados] =
      await Promise.all([
        this.prisma.negocio.groupBy({
          by: ['etapaId'],
          where: doFunil,
          _count: { _all: true },
          _sum: { valor: true },
        }),
        this.prisma.negocioMovimentacao.groupBy({
          by: ['paraEtapaId'],
          where: {
            funilId: funil.id,
            criadoEm: noPeriodo,
            paraEtapaId: { not: null },
            negocio: doFunil,
          },
          _count: { _all: true },
        }),
        this.prisma.negocioMovimentacao.groupBy({
          by: ['deEtapaId'],
          where: {
            funilId: funil.id,
            criadoEm: noPeriodo,
            deEtapaId: { not: null },
            negocio: doFunil,
          },
          _count: { _all: true },
          _avg: { segundosNaEtapaAnterior: true },
        }),
        this.prisma.negocio.findMany({
          where: { AND: [doFunil, { criadoEm: noPeriodo }] },
          select: { id: true, etapaId: true, status: true },
        }),
        this.prisma.negocio.findMany({
          where: {
            AND: [doFunil, { status: 'GANHO', ganhoEm: noPeriodo }],
          },
          select: { criadoEm: true, ganhoEm: true },
        }),
        this.paradosPorEtapa(funil.etapas, doFunil, agora),
      ]);

    const atuaisPorEtapa = new Map(
      atuais.map((linha) => [linha.etapaId, linha]),
    );
    const entradasPorEtapa = new Map(
      entradas.map((linha) => [linha.paraEtapaId, linha._count._all]),
    );
    const saidasPorEtapa = new Map(
      saidas.map((linha) => [linha.deEtapaId, linha]),
    );

    const etapas: MetricaDaEtapaDto[] = funil.etapas.map((etapa) => {
      const atual = atuaisPorEtapa.get(etapa.id);
      const saida = saidasPorEtapa.get(etapa.id);
      const tempoMedio =
        saida?._avg.segundosNaEtapaAnterior === null ||
        saida?._avg.segundosNaEtapaAnterior === undefined
          ? null
          : Math.round(saida._avg.segundosNaEtapaAnterior);
      return {
        etapa: { ...resumoDaEtapa(etapa), prazoDias: etapa.prazoDias },
        negociosAtuais: atual?._count._all ?? 0,
        valorAtual: formatarValor(atual?._sum.valor ?? 0) ?? '0.00',
        parados: parados.get(etapa.id) ?? null,
        entradasNoPeriodo: entradasPorEtapa.get(etapa.id) ?? 0,
        saidasNoPeriodo: saida?._count._all ?? 0,
        tempoMedioSegundos: tempoMedio,
        tempoMedioDias: segundosEmDias(tempoMedio),
      };
    });

    const conversoes = await this.conversoes(funil.etapas, coorte);
    const ciclos = ganhos
      .filter((negocio) => negocio.ganhoEm !== null)
      .map((negocio) =>
        Math.max(
          0,
          Math.round(
            ((negocio.ganhoEm as Date).getTime() - negocio.criadoEm.getTime()) /
              1000,
          ),
        ),
      );
    const cicloMedio = mediaInteira(ciclos);
    const contagem = (status: string) =>
      coorte.filter((negocio) => negocio.status === status).length;

    return {
      funil: { id: funil.id, nome: funil.nome, area: funil.area },
      periodo: { de: de.toISOString(), ate: ate.toISOString() },
      etapas,
      conversoes,
      coorte: {
        criados: coorte.length,
        abertos: contagem('ABERTO'),
        ganhos: contagem('GANHO'),
        perdidos: contagem('PERDIDO'),
        taxaDeGanho: proporcao(contagem('GANHO'), coorte.length),
      },
      cicloMedio: {
        negociosGanhos: ciclos.length,
        segundos: cicloMedio,
        dias: segundosEmDias(cicloMedio),
      },
      parados: [...parados.values()].reduce((soma, valor) => soma + valor, 0),
    };
  }

  private periodo(filtro: FiltroMetricasDto): { de: Date; ate: Date } {
    const ate = filtro.ate ? new Date(filtro.ate) : new Date();
    const de = filtro.de
      ? new Date(filtro.de)
      : new Date(ate.getTime() - PERIODO_PADRAO_DIAS * 86_400_000);
    if (de.getTime() >= ate.getTime()) {
      throw new DadosInvalidosException(
        'O início do período precisa ser anterior ao fim.',
        {
          campos: [{ campo: 'de', mensagens: ['deve ser anterior a `ate`'] }],
        },
      );
    }
    return { de, ate };
  }

  /** Abertos parados agora, por etapa aberta com prazo-alvo (as demais ficam de fora). */
  private async paradosPorEtapa(
    etapas: readonly Etapa[],
    doFunil: Prisma.NegocioWhereInput,
    agora: Date,
  ): Promise<Map<string, number>> {
    const comPrazo = etapas.filter(
      (etapa) => etapa.tipo === 'ABERTA' && etapa.prazoDias !== null,
    );
    const contagens = await Promise.all(
      comPrazo.map((etapa) =>
        this.prisma.negocio.count({
          where: {
            AND: [
              doFunil,
              {
                etapaId: etapa.id,
                status: 'ABERTO',
                etapaDesde: {
                  lt: limiteDeParado(etapa.prazoDias as number, agora),
                },
              },
            ],
          },
        }),
      ),
    );
    return new Map(comPrazo.map((etapa, i) => [etapa.id, contagens[i]]));
  }

  /**
   * Conversão entre etapas consecutivas da sequência (abertas em ordem e a de
   * ganho no fim), para a coorte criada no período.
   */
  private async conversoes(
    etapas: readonly Etapa[],
    coorte: readonly { id: string; etapaId: string }[],
  ): Promise<ConversaoEntreEtapasDto[]> {
    const ganho = etapas.find((etapa) => etapa.tipo === 'GANHO');
    const sequencia = [
      ...etapas.filter((etapa) => etapa.tipo === 'ABERTA'),
      ...(ganho ? [ganho] : []),
    ];
    if (sequencia.length < 2) {
      return [];
    }
    const visitas = new Map<string, Set<string>>(
      coorte.map((negocio) => [negocio.id, new Set([negocio.etapaId])]),
    );
    if (coorte.length > 0) {
      const passagens = await this.prisma.negocioMovimentacao.findMany({
        where: {
          negocioId: { in: coorte.map(({ id }) => id) },
          paraEtapaId: { not: null },
        },
        select: { negocioId: true, paraEtapaId: true },
        distinct: ['negocioId', 'paraEtapaId'],
      });
      for (const { negocioId, paraEtapaId } of passagens) {
        if (paraEtapaId) {
          visitas.get(negocioId)?.add(paraEtapaId);
        }
      }
    }
    const alcance = contarAlcance(
      sequencia.map(({ id }) => id),
      visitas.values(),
    );
    return sequencia.slice(0, -1).map((etapa, i) => ({
      deEtapa: resumoDaEtapa(etapa),
      paraEtapa: resumoDaEtapa(sequencia[i + 1]),
      alcancaramOrigem: alcance[i],
      alcancaramDestino: alcance[i + 1],
      taxa: proporcao(alcance[i + 1], alcance[i]),
    }));
  }
}
