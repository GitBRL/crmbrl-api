/**
 * Custo do SDR (R31): tokens por conversa (no estado da conversa), tokens por
 * mês (soma do registro de decisões, simulador incluído), orçamento mensal com
 * corte e aviso ao Admin a 80% e a 100% (uma vez por mês cada).
 */
import { Injectable } from '@nestjs/common';
import { dataLocal, inicioDoDia } from '../atividades/fuso-horario';
import { NotificacoesService } from '../notificacoes/notificacoes.service';
import { PrismaService, type Tx } from '../prisma/prisma.service';
import { travarChave } from '../prisma/travas';
import { ConfiguracaoSdrService } from './configuracao-sdr.service';
import { PERCENTUAIS_DE_AVISO, TIPOS_NOTIFICACAO_SDR } from './sdr.constantes';

const FUSO = 'America/Sao_Paulo';

export interface UsoDeTokensSdr {
  entrada: number;
  saida: number;
  cacheLeitura: number;
  cacheEscrita: number;
}

export interface SituacaoDoOrcamento {
  /** `AAAA-MM` (São Paulo). */
  mes: string;
  /** Entrada + saída + cache, no mês. */
  usados: number;
  /** Nulo = sem orçamento. */
  orcamento: number | null;
  /** 0 a 100 (ou mais, se passou); nulo sem orçamento. */
  percentual: number | null;
  esgotado: boolean;
}

export interface UsoDoMes {
  mes: string;
  tokens: UsoDeTokensSdr & { total: number };
  simulador: { tokens: number };
  turnos: number;
  conversasAtendidas: number;
  orcamento: number | null;
  percentual: number | null;
  esgotado: boolean;
}

export function totalDeTokens(u: UsoDeTokensSdr): number {
  return u.entrada + u.saida + u.cacheLeitura + u.cacheEscrita;
}

export function inicioDoMesSdr(agora = new Date()): Date {
  const hoje = dataLocal(agora, FUSO);
  return inicioDoDia(hoje.ano, hoje.mes, 1, FUSO);
}

export function rotuloDoMes(agora = new Date()): string {
  const hoje = dataLocal(agora, FUSO);
  return `${hoje.ano}-${String(hoje.mes).padStart(2, '0')}`;
}

@Injectable()
export class OrcamentoSdrService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configuracao: ConfiguracaoSdrService,
    private readonly notificacoes: NotificacoesService,
  ) {}

  async tokensDoMes(
    agora = new Date(),
    cliente: Tx | PrismaService = this.prisma,
  ): Promise<UsoDeTokensSdr> {
    const soma = await cliente.sdrDecisao.aggregate({
      where: { criadoEm: { gte: inicioDoMesSdr(agora) } },
      _sum: {
        tokensEntrada: true,
        tokensSaida: true,
        tokensCacheLeitura: true,
        tokensCacheEscrita: true,
      },
    });
    return {
      entrada: soma._sum.tokensEntrada ?? 0,
      saida: soma._sum.tokensSaida ?? 0,
      cacheLeitura: soma._sum.tokensCacheLeitura ?? 0,
      cacheEscrita: soma._sum.tokensCacheEscrita ?? 0,
    };
  }

  async situacao(agora = new Date()): Promise<SituacaoDoOrcamento> {
    const config = await this.configuracao.garantir();
    const usados = totalDeTokens(await this.tokensDoMes(agora));
    return situacaoDe(agora, usados, config.orcamentoMensalTokens);
  }

  /** O orçamento do mês já foi usado todo? (O corte: a IA não é chamada.) */
  async esgotado(agora = new Date()): Promise<boolean> {
    return (await this.situacao(agora)).esgotado;
  }

  /**
   * Depois de gravar o uso de um turno: avisa o Admin nos 80% e nos 100% do
   * orçamento (uma vez por mês cada), na transação de quem chama.
   */
  async avisarSeNecessario(tx: Tx, agora = new Date()): Promise<void> {
    const config = await tx.sdrConfiguracao.findUniqueOrThrow({
      where: { chave: 'padrao' },
    });
    if (!config.orcamentoMensalTokens) {
      return;
    }
    const usados = totalDeTokens(await this.tokensDoMes(agora, tx));
    const percentual = (usados / config.orcamentoMensalTokens) * 100;
    const mes = rotuloDoMes(agora);
    const avisos = (config.avisosDeOrcamento ?? {}) as Record<
      string,
      Record<string, boolean>
    >;
    const pendentes = PERCENTUAIS_DE_AVISO.filter(
      (p) => percentual >= p && !avisos[mes]?.[String(p)],
    );
    if (pendentes.length === 0) {
      return;
    }
    await travarChave(tx, 'sdr-orcamento-aviso', mes);
    const novo: Record<string, Record<string, boolean>> = {
      [mes]: { ...avisos[mes] },
    };
    for (const p of pendentes) {
      novo[mes][String(p)] = true;
    }
    await tx.sdrConfiguracao.update({
      where: { id: config.id },
      data: { avisosDeOrcamento: novo },
    });
    const maior = Math.max(...pendentes);
    const esgotou = maior >= 100;
    await this.notificacoes.notificarAdmins(tx, {
      tipo: TIPOS_NOTIFICACAO_SDR.ORCAMENTO,
      titulo: esgotou
        ? 'O orçamento de tokens do SDR com IA acabou'
        : `O SDR com IA usou ${maior}% do orçamento de tokens do mês`,
      texto: esgotou
        ? 'A IA parou de responder: as conversas novas e as que estavam com ela passam para a equipe até o mês virar ou até o orçamento ser aumentado (Configurações → SDR com IA).'
        : `Foram usados ${usados.toLocaleString('pt-BR')} de ${config.orcamentoMensalTokens.toLocaleString('pt-BR')} tokens. Ao chegar a 100% a IA para de responder.`,
      link: '/configuracoes/sdr',
      dados: {
        mes,
        usados,
        orcamento: config.orcamentoMensalTokens,
        percentual: maior,
      },
    });
  }

  async uso(agora = new Date()): Promise<UsoDoMes> {
    const config = await this.configuracao.garantir();
    const desde = inicioDoMesSdr(agora);
    const [tokens, simulador, turnos, conversas] = await Promise.all([
      this.tokensDoMes(agora),
      this.prisma.sdrDecisao.aggregate({
        where: { criadoEm: { gte: desde }, simulador: true },
        _sum: {
          tokensEntrada: true,
          tokensSaida: true,
          tokensCacheLeitura: true,
          tokensCacheEscrita: true,
        },
      }),
      this.prisma.sdrDecisao.count({
        where: { criadoEm: { gte: desde }, tipo: 'TURNO', simulador: false },
      }),
      this.prisma.sdrConversa.count({ where: { criadoEm: { gte: desde } } }),
    ]);
    const total = totalDeTokens(tokens);
    const s = situacaoDe(agora, total, config.orcamentoMensalTokens);
    return {
      mes: s.mes,
      tokens: { ...tokens, total },
      simulador: {
        tokens:
          (simulador._sum.tokensEntrada ?? 0) +
          (simulador._sum.tokensSaida ?? 0) +
          (simulador._sum.tokensCacheLeitura ?? 0) +
          (simulador._sum.tokensCacheEscrita ?? 0),
      },
      turnos,
      conversasAtendidas: conversas,
      orcamento: s.orcamento,
      percentual: s.percentual,
      esgotado: s.esgotado,
    };
  }
}

function situacaoDe(
  agora: Date,
  usados: number,
  orcamento: number | null,
): SituacaoDoOrcamento {
  return {
    mes: rotuloDoMes(agora),
    usados,
    orcamento,
    percentual: orcamento ? Math.round((usados / orcamento) * 1000) / 10 : null,
    esgotado: orcamento !== null && usados >= orcamento,
  };
}
