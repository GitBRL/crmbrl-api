import { Injectable } from '@nestjs/common';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import { hojeLocal, mesDe, somarMeses } from '../financeiro/datas';
import {
  type Inadimplencia,
  IndicadoresFinanceirosService,
} from '../financeiro/indicadores.service';
import type { ConteudoDoPainel, FiltroResolvido } from './bi.tipos';
import {
  type DefinicaoDeCartao,
  montarCartoes,
  numero,
  tabela,
  type Valores,
} from './cartoes';
import { diaLocal, percentual } from './periodo';

const CARTOES: readonly DefinicaoDeCartao[] = [
  {
    chave: 'mrrAtual',
    rotulo: 'MRR atual',
    unidade: 'moeda',
    melhorQuando: null,
    dica: 'Receita recorrente mensal dos contratos ativos e suspensos agora.',
  },
  {
    chave: 'contratosAtivos',
    rotulo: 'Contratos ativos',
    unidade: 'numero',
    melhorQuando: null,
    dica: 'Contratos ativos e suspensos agora (os que compõem o MRR).',
  },
  {
    chave: 'mrrNovo',
    rotulo: 'MRR novo',
    unidade: 'moeda',
    melhorQuando: 'maior',
    dica: 'MRR de contratos novos criados no período.',
  },
  {
    chave: 'mrrExpansao',
    rotulo: 'Expansão de MRR',
    unidade: 'moeda',
    melhorQuando: 'maior',
    dica: 'Aumento de valor de contratos existentes no período.',
  },
  {
    chave: 'mrrContracao',
    rotulo: 'Contração de MRR',
    unidade: 'moeda',
    melhorQuando: 'menor',
    dica: 'Redução de valor de contratos existentes no período.',
  },
  {
    chave: 'mrrChurn',
    rotulo: 'Churn de MRR',
    unidade: 'moeda',
    melhorQuando: 'menor',
    dica: 'MRR perdido por cancelamento ou encerramento de contratos no período.',
  },
  {
    chave: 'previsto',
    rotulo: 'Previsto no período',
    unidade: 'moeda',
    melhorQuando: 'maior',
    dica: 'Soma dos títulos que vencem no período (sem cancelados nem renegociados).',
  },
  {
    chave: 'realizado',
    rotulo: 'Realizado do previsto',
    unidade: 'moeda',
    melhorQuando: 'maior',
    dica: 'Do previsto do período, o que já foi pago.',
  },
  {
    chave: 'taxaRealizacao',
    rotulo: 'Taxa de realização',
    unidade: 'percentual',
    melhorQuando: 'maior',
    dica: 'Realizado ÷ previsto dos títulos que vencem no período.',
  },
  {
    chave: 'recebido',
    rotulo: 'Recebido no período',
    unidade: 'moeda',
    melhorQuando: 'maior',
    dica: 'Dinheiro que entrou no período (por data de pagamento), de qualquer vencimento.',
  },
  {
    chave: 'valorInadimplente',
    rotulo: 'Valor em atraso',
    unidade: 'moeda',
    melhorQuando: 'menor',
    dica: 'Soma dos títulos vencidos e não pagos agora.',
  },
  {
    chave: 'taxaInadimplencia',
    rotulo: 'Taxa de inadimplência',
    unidade: 'percentual',
    melhorQuando: 'menor',
    dica: 'Valor em atraso ÷ valor a receber (aberto + atrasado) agora.',
  },
  {
    chave: 'clientesInadimplentes',
    rotulo: 'Clientes inadimplentes',
    unidade: 'numero',
    melhorQuando: 'menor',
    dica: 'Clientes com ao menos um título vencido e não pago agora.',
  },
];

const DE_AGORA: ReadonlySet<string> = new Set([
  'mrrAtual',
  'contratosAtivos',
  'valorInadimplente',
  'taxaInadimplencia',
  'clientesInadimplentes',
]);

/** Meses mostrados nas séries mensais (no mínimo, os últimos 12). */
const MESES_MINIMOS = 12;

/**
 * Painel Financeiro (R20, R23): MRR por componente, inadimplência por faixa e
 * previsto × realizado. Lê `src/financeiro`, que já aplica a visibilidade do
 * Financeiro (R22.1) — o BI não mostra contrato nem título que a lista não mostra.
 * O filtro de equipe/pessoa restringe aos contratos do responsável de CS.
 */
@Injectable()
export class PainelFinanceiroService {
  constructor(private readonly financeiro: IndicadoresFinanceirosService) {}

  async calcular(
    usuario: UsuarioAutenticado,
    filtro: FiltroResolvido,
  ): Promise<ConteudoDoPainel> {
    const hoje = hojeLocal();
    const [atual, anterior, agora, mrrMeses, previstoMeses] = await Promise.all(
      [
        this.valoresDoPeriodo(usuario, filtro, filtro.de, filtro.ate),
        filtro.anteriorDe && filtro.anteriorAte
          ? this.valoresDoPeriodo(
              usuario,
              filtro,
              filtro.anteriorDe,
              filtro.anteriorAte,
            )
          : Promise.resolve(null),
        this.valoresDeAgora(usuario, filtro, hoje),
        this.mrrPorMes(usuario, filtro),
        this.previstoRealizado(usuario, filtro),
      ],
    );
    return {
      cartoes: montarCartoes(
        CARTOES,
        { ...atual, ...agora.valores },
        anterior,
        DE_AGORA,
      ),
      tabelas: {
        mrrPorMes: mrrMeses,
        inadimplenciaPorFaixa: tabela(
          'inadimplenciaPorFaixa',
          'Inadimplência por faixa de atraso',
          'Títulos vencidos e não pagos agora, por dias de atraso (0–30, 31–60, 61–90 e 90+).',
          [
            ['faixa', 'Faixa (dias)', 'texto'],
            ['quantidade', 'Títulos', 'numero'],
            ['valor', 'Valor', 'moeda'],
            ['clientes', 'Clientes', 'numero'],
          ],
          agora.inad.faixas.map((f) => ({
            faixa: f.faixa,
            quantidade: f.quantidade,
            valor: Number(f.valor),
            clientes: f.clientes,
          })),
        ),
        previstoRealizado: previstoMeses,
      },
      meta: { referencia: hoje },
    };
  }

  /** Dia inicial e final (inclusive) de um intervalo `[de, ate)` no fuso do BI. */
  private dias(de: Date, ate: Date): [string, string] {
    return [diaLocal(de), diaLocal(new Date(ate.getTime() - 1))];
  }

  private async valoresDoPeriodo(
    usuario: UsuarioAutenticado,
    filtro: FiltroResolvido,
    de: Date,
    ate: Date,
  ): Promise<Valores> {
    const [deDia, ateDia] = this.dias(de, ate);
    const [mov, rec] = await Promise.all([
      this.financeiro.movimentosDoPeriodo(
        usuario,
        deDia,
        ateDia,
        filtro.pessoas,
      ),
      this.financeiro.recebimentosDoPeriodo(
        usuario,
        deDia,
        ateDia,
        filtro.pessoas,
      ),
    ]);
    return {
      mrrNovo: numero(mov.novo),
      mrrExpansao: numero(mov.expansao),
      mrrContracao: numero(mov.contracao),
      mrrChurn: numero(mov.churn),
      previsto: numero(rec.previsto),
      realizado: numero(rec.realizado),
      taxaRealizacao: percentual(rec.realizado, rec.previsto),
      recebido: numero(rec.recebido),
    };
  }

  private async valoresDeAgora(
    usuario: UsuarioAutenticado,
    filtro: FiltroResolvido,
    hoje: string,
  ): Promise<{ valores: Valores; inad: Inadimplencia }> {
    const mes = mesDe(hoje);
    const [mrr, inad] = await Promise.all([
      this.financeiro.mrr(usuario, { de: mes, ate: mes }, filtro.pessoas),
      this.financeiro.inadimplencia(usuario, hoje, filtro.pessoas),
    ]);
    return {
      inad,
      valores: {
        mrrAtual: numero(Number(mrr.atual.mrr)),
        contratosAtivos: mrr.atual.contratos,
        valorInadimplente: numero(Number(inad.total.valor)),
        taxaInadimplencia: inad.taxa,
        clientesInadimplentes: inad.total.clientes,
      },
    };
  }

  /** Série mensal: do mês do início do período (ou 12 meses antes do fim) até o mês do fim. */
  private intervaloDeMeses(filtro: FiltroResolvido): {
    de: string;
    ate: string;
  } {
    const ate = mesDe(diaLocal(new Date(filtro.ate.getTime() - 1)));
    const doPeriodo = mesDe(diaLocal(filtro.de));
    const minimo = mesDe(somarMeses(`${ate}-01`, -(MESES_MINIMOS - 1), 1));
    return { de: doPeriodo < minimo ? doPeriodo : minimo, ate };
  }

  private async mrrPorMes(
    usuario: UsuarioAutenticado,
    filtro: FiltroResolvido,
  ) {
    const r = await this.financeiro.mrr(
      usuario,
      this.intervaloDeMeses(filtro),
      filtro.pessoas,
    );
    return tabela(
      'mrrPorMes',
      'MRR por mês',
      'MRR novo, expansão, contração e churn de cada mês, e o MRR no fim do mês.',
      [
        ['mes', 'Mês', 'texto'],
        ['novo', 'Novo', 'moeda'],
        ['expansao', 'Expansão', 'moeda'],
        ['contracao', 'Contração', 'moeda'],
        ['churn', 'Churn', 'moeda'],
        ['mrr', 'MRR no fim do mês', 'moeda'],
      ],
      r.meses.map((m) => ({
        mes: m.mes,
        novo: Number(m.novo),
        expansao: Number(m.expansao),
        contracao: Number(m.contracao),
        churn: Number(m.churn),
        mrr: Number(m.mrr),
      })),
    );
  }

  private async previstoRealizado(
    usuario: UsuarioAutenticado,
    filtro: FiltroResolvido,
  ) {
    const r = await this.financeiro.previstoRealizado(
      usuario,
      this.intervaloDeMeses(filtro),
      filtro.pessoas,
    );
    return tabela(
      'previstoRealizado',
      'Receita prevista × realizada',
      'Por mês de vencimento: o previsto, o que já foi pago, o que segue em aberto e o dinheiro que entrou no mês.',
      [
        ['mes', 'Mês', 'texto'],
        ['previsto', 'Previsto', 'moeda'],
        ['realizado', 'Realizado', 'moeda'],
        ['emAberto', 'Em aberto', 'moeda'],
        ['recebidoNoMes', 'Recebido no mês', 'moeda'],
        ['taxaDeRealizacao', 'Realização', 'percentual'],
      ],
      r.meses.map((m) => ({
        mes: m.mes,
        previsto: Number(m.previsto),
        realizado: Number(m.realizado),
        emAberto: Number(m.emAberto),
        recebidoNoMes: Number(m.recebidoNoMes),
        taxaDeRealizacao: m.taxaDeRealizacao,
      })),
    );
  }
}
