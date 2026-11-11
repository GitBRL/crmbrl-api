import { Injectable } from '@nestjs/common';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import { Prisma, type TipoMovimentoMrr } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  fimDoMes,
  hojeLocal,
  inicioDoMes,
  mesDe,
  mesesEntre,
  paraDataDoBanco,
  somarMeses,
} from './datas';
import { FAIXAS_DE_ATRASO, type FaixaDeAtraso } from './financeiro.constantes';
import { filtroDeContratosVisiveis } from './permissoes-financeiro';
import {
  sqlContratosDasPessoas,
  sqlContratosVisiveis,
  sqlParcelasDasPessoas,
  sqlParcelasVisiveis,
} from './permissoes-financeiro-sql';

type Usuario = Pick<UsuarioAutenticado, 'id' | 'papel' | 'area'>;

/** Restringe aos contratos de certas pessoas de CS (filtro de equipe/pessoa do BI); `null` = todos. */
export type PessoasDoRecorte = readonly string[] | null | undefined;

function contratosDasPessoas(
  pessoas: PessoasDoRecorte,
): Prisma.ContratoWhereInput {
  return pessoas ? { responsavelCsId: { in: [...pessoas] } } : {};
}

export interface MovimentosDoPeriodo {
  novo: number;
  expansao: number;
  contracao: number;
  churn: number;
}

export interface RecebimentosDoPeriodo {
  /** Soma dos títulos que vencem no intervalo (sem cancelados nem renegociados). */
  previsto: number;
  /** Do previsto, o que já foi pago. */
  realizado: number;
  /** Dinheiro que entrou no intervalo (por data de pagamento). */
  recebido: number;
}

export interface PeriodoDeMeses {
  /** `AAAA-MM`. */
  de?: string;
  ate?: string;
}

export interface LinhaDeMrr {
  mes: string;
  /** MRR de contratos novos no mês. */
  novo: string;
  /** Aumento de valor de contratos existentes. */
  expansao: string;
  /** Redução de valor (valor positivo). */
  contracao: string;
  /** MRR perdido por cancelamento ou encerramento (valor positivo). */
  churn: string;
  /** novo + expansão − contração − churn. */
  variacao: string;
  /** MRR no fim do mês. */
  mrr: string;
}

export interface MrrPorMes {
  de: string;
  ate: string;
  meses: LinhaDeMrr[];
  /** MRR hoje (contratos ativos e suspensos) e quantos contratos o compõem. */
  atual: { mrr: string; contratos: number };
}

export interface FaixaDeInadimplencia {
  faixa: FaixaDeAtraso;
  quantidade: number;
  valor: string;
  clientes: number;
}

export interface Inadimplencia {
  referencia: string;
  faixas: FaixaDeInadimplencia[];
  total: { quantidade: number; valor: string; clientes: number };
  /** Valor atrasado ÷ valor a receber (aberto + atrasado), em %. */
  taxa: number;
}

export interface LinhaPrevistoRealizado {
  mes: string;
  /** Soma dos títulos que vencem no mês (sem cancelados nem renegociados). */
  previsto: string;
  /** Do previsto do mês, o que já foi pago. */
  realizado: string;
  /** Do previsto do mês, o que continua sem pagamento. */
  emAberto: string;
  /** Dinheiro que entrou no mês (por data de pagamento), de qualquer vencimento. */
  recebidoNoMes: string;
  /** realizado ÷ previsto, em %. */
  taxaDeRealizacao: number;
}

export interface PrevistoRealizado {
  de: string;
  ate: string;
  meses: LinhaPrevistoRealizado[];
  total: { previsto: string; realizado: string; recebidoNoMes: string };
}

const D = (v: Prisma.Decimal | number | string | null | undefined) =>
  new Prisma.Decimal(v ?? 0);

/**
 * Indicadores do Financeiro (R23, e consumidos pelo BI — R20): MRR por componente,
 * inadimplência por faixa e receita prevista × realizada. Tudo respeita a
 * visibilidade do usuário (R22.1): nenhum número mostra contrato ou título que
 * ele não veria nas listas.
 */
@Injectable()
export class IndicadoresFinanceirosService {
  constructor(private readonly prisma: PrismaService) {}

  private periodo(
    p: PeriodoDeMeses,
    hoje: string,
  ): { de: string; ate: string } {
    const ate = p.ate ?? mesDe(hoje);
    const de = p.de ?? mesDe(somarMeses(`${ate}-01`, -11, 1));
    return de <= ate ? { de, ate } : { de: ate, ate: de };
  }

  /** R23.1 — MRR novo, expansão, contração e churn por mês, e o MRR no fim de cada mês. */
  async mrr(
    usuario: Usuario,
    p: PeriodoDeMeses = {},
    pessoas?: PessoasDoRecorte,
  ): Promise<MrrPorMes> {
    const hoje = hojeLocal();
    const { de, ate } = this.periodo(p, hoje);
    const contratoVisivel: Prisma.ContratoWhereInput = {
      AND: [filtroDeContratosVisiveis(usuario), contratosDasPessoas(pessoas)],
    };
    const onde = { contrato: contratoVisivel };
    const [anteriores, movimentos, ativos] = await Promise.all([
      this.prisma.movimentoMrr.aggregate({
        where: { ...onde, dia: { lt: paraDataDoBanco(`${de}-01`) } },
        _sum: { delta: true },
      }),
      this.prisma.$queryRaw<
        { mes: string; tipo: TipoMovimentoMrr; delta: Prisma.Decimal }[]
      >`SELECT to_char(m.dia, 'YYYY-MM') AS mes, m.tipo::text AS tipo, SUM(m.delta) AS delta
        FROM movimentos_mrr m JOIN contratos c ON c.id = m.contrato_id
        WHERE m.dia >= ${paraDataDoBanco(`${de}-01`)}::date
          AND m.dia <= ${paraDataDoBanco(fimDoMes(ate))}::date
          AND ${sqlContratosVisiveis(usuario)} AND ${sqlContratosDasPessoas(pessoas)}
        GROUP BY 1, 2`,
      this.prisma.contrato.aggregate({
        where: {
          AND: [{ status: { in: ['ATIVO', 'SUSPENSO'] } }, contratoVisivel],
        },
        _sum: { mrr: true },
        _count: { _all: true },
      }),
    ]);
    const porMes = new Map<string, Record<TipoMovimentoMrr, Prisma.Decimal>>();
    for (const m of movimentos) {
      const mes = m.mes;
      const atual = porMes.get(mes) ?? {
        NOVO: D(0),
        EXPANSAO: D(0),
        CONTRACAO: D(0),
        CHURN: D(0),
      };
      atual[m.tipo] = atual[m.tipo].plus(D(m.delta));
      porMes.set(mes, atual);
    }
    let acumulado = D(anteriores._sum.delta);
    const meses = mesesEntre(de, ate).map((mes): LinhaDeMrr => {
      const v = porMes.get(mes) ?? {
        NOVO: D(0),
        EXPANSAO: D(0),
        CONTRACAO: D(0),
        CHURN: D(0),
      };
      const variacao = v.NOVO.plus(v.EXPANSAO).plus(v.CONTRACAO).plus(v.CHURN);
      acumulado = acumulado.plus(variacao);
      return {
        mes,
        novo: v.NOVO.toFixed(2),
        expansao: v.EXPANSAO.toFixed(2),
        contracao: v.CONTRACAO.abs().toFixed(2),
        churn: v.CHURN.abs().toFixed(2),
        variacao: variacao.toFixed(2),
        mrr: acumulado.toFixed(2),
      };
    });
    return {
      de,
      ate,
      meses,
      atual: {
        mrr: D(ativos._sum.mrr).toFixed(2),
        contratos: ativos._count._all,
      },
    };
  }

  /** R23.2 — títulos vencidos e não pagos por faixa de atraso (0–30, 31–60, 61–90, 90+). */
  async inadimplencia(
    usuario: Usuario,
    hoje: string = hojeLocal(),
    pessoas?: PessoasDoRecorte,
  ): Promise<Inadimplencia> {
    const linhas = await this.prisma.$queryRaw<
      {
        faixa: FaixaDeAtraso | null;
        quantidade: bigint;
        valor: Prisma.Decimal;
        clientes: bigint;
      }[]
    >`SELECT CASE WHEN d < 1 THEN NULL WHEN d <= 30 THEN '0-30' WHEN d <= 60 THEN '31-60'
                  WHEN d <= 90 THEN '61-90' ELSE '90+' END AS faixa,
             COUNT(*) AS quantidade, SUM(valor) AS valor,
             COUNT(DISTINCT COALESCE(contato_id, empresa_id, id)) AS clientes
      FROM (SELECT p.id, p.valor, p.contato_id, p.empresa_id, (${hoje}::date - p.vencimento) AS d
            FROM parcelas p
            WHERE p.status::text IN ('ABERTO', 'ATRASADO')
              AND ${sqlParcelasVisiveis(usuario)} AND ${sqlParcelasDasPessoas(pessoas)}) x
      GROUP BY 1`;
    const [{ clientes: totalClientes }] = await this.prisma.$queryRaw<
      { clientes: bigint }[]
    >`SELECT COUNT(DISTINCT COALESCE(p.contato_id, p.empresa_id, p.id)) AS clientes
      FROM parcelas p
      WHERE p.status::text IN ('ABERTO', 'ATRASADO')
        AND (${hoje}::date - p.vencimento) >= 1
        AND ${sqlParcelasVisiveis(usuario)} AND ${sqlParcelasDasPessoas(pessoas)}`;
    const acc = new Map(
      FAIXAS_DE_ATRASO.map((f) => [f, { q: 0, v: D(0), c: 0 }]),
    );
    let aReceber = D(0);
    let atrasado = D(0);
    let quantidade = 0;
    for (const l of linhas) {
      aReceber = aReceber.plus(D(l.valor));
      if (!l.faixa) continue;
      acc.set(l.faixa, {
        q: Number(l.quantidade),
        v: D(l.valor),
        c: Number(l.clientes),
      });
      atrasado = atrasado.plus(D(l.valor));
      quantidade += Number(l.quantidade);
    }
    return {
      referencia: hoje,
      faixas: FAIXAS_DE_ATRASO.map((faixa) => {
        const a = acc.get(faixa)!;
        return {
          faixa,
          quantidade: a.q,
          valor: a.v.toFixed(2),
          clientes: a.c,
        };
      }),
      total: {
        quantidade,
        valor: atrasado.toFixed(2),
        clientes: Number(totalClientes),
      },
      taxa: aReceber.isZero()
        ? 0
        : Number(atrasado.div(aReceber).mul(100).toFixed(1)),
    };
  }

  /** R23.3 — receita prevista (vencimentos do mês) × realizada (paga), por mês. */
  async previstoRealizado(
    usuario: Usuario,
    p: PeriodoDeMeses = {},
    pessoas?: PessoasDoRecorte,
  ): Promise<PrevistoRealizado> {
    const { de, ate } = this.periodo(p, hojeLocal());
    const inicio = paraDataDoBanco(`${de}-01`);
    const fim = paraDataDoBanco(fimDoMes(ate));
    const [devidas, pagas] = await Promise.all([
      this.prisma.$queryRaw<
        { mes: string; previsto: Prisma.Decimal; realizado: Prisma.Decimal }[]
      >`SELECT to_char(p.vencimento, 'YYYY-MM') AS mes, SUM(p.valor) AS previsto,
               COALESCE(SUM(CASE WHEN p.status::text = 'PAGO' THEN COALESCE(p.valor_pago, p.valor) END), 0) AS realizado
        FROM parcelas p
        WHERE p.status::text NOT IN ('CANCELADO', 'RENEGOCIADO')
          AND p.vencimento BETWEEN ${inicio}::date AND ${fim}::date
          AND ${sqlParcelasVisiveis(usuario)} AND ${sqlParcelasDasPessoas(pessoas)}
        GROUP BY 1`,
      this.prisma.$queryRaw<{ mes: string; recebido: Prisma.Decimal }[]>`
        SELECT to_char(p.pago_em, 'YYYY-MM') AS mes, SUM(COALESCE(p.valor_pago, p.valor)) AS recebido
        FROM parcelas p
        WHERE p.status = 'PAGO' AND p.pago_em BETWEEN ${inicio}::date AND ${fim}::date
          AND ${sqlParcelasVisiveis(usuario)} AND ${sqlParcelasDasPessoas(pessoas)}
        GROUP BY 1`,
    ]);
    const linhas = new Map(
      mesesEntre(de, ate).map((mes) => [
        mes,
        { previsto: D(0), realizado: D(0), recebido: D(0) },
      ]),
    );
    for (const x of devidas) {
      const l = linhas.get(x.mes);
      if (!l) continue;
      l.previsto = D(x.previsto);
      l.realizado = D(x.realizado);
    }
    for (const x of pagas) {
      const l = linhas.get(x.mes);
      if (l) l.recebido = D(x.recebido);
    }
    let tp = D(0);
    let tr = D(0);
    let tc = D(0);
    const meses = [...linhas.entries()].map(
      ([mes, l]): LinhaPrevistoRealizado => {
        tp = tp.plus(l.previsto);
        tr = tr.plus(l.realizado);
        tc = tc.plus(l.recebido);
        return {
          mes,
          previsto: l.previsto.toFixed(2),
          realizado: l.realizado.toFixed(2),
          emAberto: l.previsto.minus(l.realizado).toFixed(2),
          recebidoNoMes: l.recebido.toFixed(2),
          taxaDeRealizacao: l.previsto.isZero()
            ? 0
            : Number(l.realizado.div(l.previsto).mul(100).toFixed(1)),
        };
      },
    );
    return {
      de,
      ate,
      meses,
      total: {
        previsto: tp.toFixed(2),
        realizado: tr.toFixed(2),
        recebidoNoMes: tc.toFixed(2),
      },
    };
  }

  /** R20 — MRR novo, expansão, contração e churn dos movimentos entre dois dias (inclusive, `AAAA-MM-DD`). */
  async movimentosDoPeriodo(
    usuario: Usuario,
    deDia: string,
    ateDia: string,
    pessoas?: PessoasDoRecorte,
  ): Promise<MovimentosDoPeriodo> {
    const grupos = await this.prisma.movimentoMrr.groupBy({
      by: ['tipo'],
      where: {
        dia: { gte: paraDataDoBanco(deDia), lte: paraDataDoBanco(ateDia) },
        contrato: {
          AND: [
            filtroDeContratosVisiveis(usuario),
            contratosDasPessoas(pessoas),
          ],
        },
      },
      _sum: { delta: true },
    });
    const soma = (tipo: TipoMovimentoMrr) =>
      Number(
        D(grupos.find((g) => g.tipo === tipo)?._sum.delta)
          .abs()
          .toFixed(2),
      );
    return {
      novo: soma('NOVO'),
      expansao: soma('EXPANSAO'),
      contracao: soma('CONTRACAO'),
      churn: soma('CHURN'),
    };
  }

  /** R20 — previsto (vencimentos), realizado (pagos entre os vencimentos) e recebido (por data de pagamento) entre dois dias. */
  async recebimentosDoPeriodo(
    usuario: Usuario,
    deDia: string,
    ateDia: string,
    pessoas?: PessoasDoRecorte,
  ): Promise<RecebimentosDoPeriodo> {
    const de = paraDataDoBanco(deDia);
    const ate = paraDataDoBanco(ateDia);
    const [[devidas], [pagas]] = await Promise.all([
      this.prisma.$queryRaw<
        { previsto: Prisma.Decimal; realizado: Prisma.Decimal }[]
      >`SELECT COALESCE(SUM(p.valor), 0) AS previsto,
               COALESCE(SUM(CASE WHEN p.status::text = 'PAGO' THEN COALESCE(p.valor_pago, p.valor) END), 0) AS realizado
        FROM parcelas p
        WHERE p.status::text NOT IN ('CANCELADO', 'RENEGOCIADO')
          AND p.vencimento BETWEEN ${de}::date AND ${ate}::date
          AND ${sqlParcelasVisiveis(usuario)} AND ${sqlParcelasDasPessoas(pessoas)}`,
      this.prisma.$queryRaw<{ recebido: Prisma.Decimal }[]>`
        SELECT COALESCE(SUM(COALESCE(p.valor_pago, p.valor)), 0) AS recebido
        FROM parcelas p
        WHERE p.status = 'PAGO' AND p.pago_em BETWEEN ${de}::date AND ${ate}::date
          AND ${sqlParcelasVisiveis(usuario)} AND ${sqlParcelasDasPessoas(pessoas)}`,
    ]);
    return {
      previsto: Number(D(devidas.previsto).toFixed(2)),
      realizado: Number(D(devidas.realizado).toFixed(2)),
      recebido: Number(D(pagas.recebido).toFixed(2)),
    };
  }

  /** Painel resumido (cartões do topo da tela de indicadores). */
  async resumo(usuario: Usuario) {
    const hoje = hojeLocal();
    const mes = mesDe(hoje);
    const [mrr, inad, pr] = await Promise.all([
      this.mrr(usuario, { de: mes, ate: mes }),
      this.inadimplencia(usuario, hoje),
      this.previstoRealizado(usuario, { de: mes, ate: mes }),
    ]);
    return {
      mes,
      inicioDoMes: inicioDoMes(hoje),
      mrr: mrr.atual,
      mrrDoMes: mrr.meses[0],
      inadimplencia: inad.total,
      taxaDeInadimplencia: inad.taxa,
      previstoRealizado: pr.meses[0],
    };
  }
}
