import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  contagemZeradaDeNiveis,
  contagemZeradaDeRecebimentos,
  type ContagemPorAcaoDto,
  type ContagemPorTipoAtorDto,
  LogTecnicoDto,
  type ResumoAdministracaoDto,
} from './administracao.dto';
import {
  ACAO_DA_RETENCAO,
  DIAS_DE_RETENCAO,
  limiteDaRetencao,
} from './retencao.service';

/** Quantos erros recentes o resumo mostra. */
const ERROS_RECENTES = 10;

const MILISSEGUNDOS_POR_HORA = 3_600_000;

/**
 * Resumo para o Admin: o que aconteceu na janela (auditoria por ação e por tipo
 * de ator, logs técnicos por nível e os últimos erros) e a saúde dos processos
 * em segundo plano (outbox de eventos, webhooks e retenção).
 */
@Injectable()
export class ResumoAdministracaoService {
  constructor(private readonly prisma: PrismaService) {}

  async resumir(
    horas: number,
    agora: Date = new Date(),
  ): Promise<ResumoAdministracaoDto> {
    const de = new Date(agora.getTime() - horas * MILISSEGUNDOS_POR_HORA);
    // Sem limite superior: um relógio do banco um pouco adiantado não esconde o recente.
    const naJanela = { gte: de };
    const limite = limiteDaRetencao(agora);
    const [
      porAcao,
      porTipoAtor,
      porNivel,
      errosRecentes,
      eventosPendentes,
      eventosComFalha,
      eventoMaisAntigo,
      recebimentosPorStatus,
      entregasPendentes,
      entregasFalhas,
      logsVencidos,
      recebimentosVencidos,
      ultimaLimpeza,
    ] = await Promise.all([
      this.prisma.eventoAuditoria.groupBy({
        by: ['acao'],
        where: { criadoEm: naJanela },
        _count: { _all: true },
      }),
      this.prisma.eventoAuditoria.groupBy({
        by: ['tipoAtor'],
        where: { criadoEm: naJanela },
        _count: { _all: true },
      }),
      this.prisma.logTecnico.groupBy({
        by: ['nivel'],
        where: { criadoEm: naJanela },
        _count: { _all: true },
      }),
      this.prisma.logTecnico.findMany({
        where: { nivel: 'ERRO', criadoEm: naJanela },
        orderBy: { id: 'desc' },
        take: ERROS_RECENTES,
      }),
      this.prisma.eventoDominio.count({ where: { processadoEm: null } }),
      this.prisma.eventoDominio.count({
        where: { processadoEm: null, erro: { not: null } },
      }),
      this.prisma.eventoDominio.findFirst({
        where: { processadoEm: null },
        orderBy: { criadoEm: 'asc' },
        select: { criadoEm: true },
      }),
      this.prisma.webhookRecebimento.groupBy({
        by: ['status'],
        where: { recebidoEm: naJanela },
        _count: { _all: true },
      }),
      this.prisma.webhookEntrega.count({ where: { status: 'PENDENTE' } }),
      this.prisma.webhookEntrega.count({
        where: { status: 'FALHOU', atualizadoEm: naJanela },
      }),
      this.prisma.logTecnico.count({ where: { criadoEm: { lt: limite } } }),
      this.prisma.webhookRecebimento.count({
        where: { recebidoEm: { lt: limite } },
      }),
      this.prisma.eventoAuditoria.findFirst({
        where: { acao: ACAO_DA_RETENCAO },
        orderBy: { id: 'desc' },
        select: { criadoEm: true },
      }),
    ]);

    const acoes: ContagemPorAcaoDto[] = porAcao
      .map(({ acao, _count }) => ({ acao, quantidade: _count._all }))
      .sort(
        (a, b) => b.quantidade - a.quantidade || a.acao.localeCompare(b.acao),
      );
    const tiposAtor: ContagemPorTipoAtorDto[] = porTipoAtor
      .map(({ tipoAtor, _count }) => ({ tipoAtor, quantidade: _count._all }))
      .sort(
        (a, b) =>
          b.quantidade - a.quantidade || a.tipoAtor.localeCompare(b.tipoAtor),
      );
    const niveis = contagemZeradaDeNiveis();
    for (const { nivel, _count } of porNivel) {
      niveis[nivel] = _count._all;
    }
    const recebimentos = contagemZeradaDeRecebimentos();
    for (const { status, _count } of recebimentosPorStatus) {
      recebimentos[status] = _count._all;
    }

    return {
      periodo: { de: de.toISOString(), ate: agora.toISOString(), horas },
      auditoria: {
        total: acoes.reduce((soma, { quantidade }) => soma + quantidade, 0),
        porAcao: acoes,
        porTipoAtor: tiposAtor,
      },
      logsTecnicos: {
        total: Object.values(niveis).reduce((soma, valor) => soma + valor, 0),
        porNivel: niveis,
        errosRecentes: errosRecentes.map((log) => LogTecnicoDto.de(log)),
      },
      eventosDominio: {
        pendentes: eventosPendentes,
        comFalha: eventosComFalha,
        maisAntigoPendenteEm: eventoMaisAntigo?.criadoEm.toISOString() ?? null,
      },
      webhooks: {
        recebimentos,
        entregasPendentes,
        entregasFalhas,
      },
      retencao: {
        dias: DIAS_DE_RETENCAO,
        limite: limite.toISOString(),
        logsTecnicosVencidos: logsVencidos,
        recebimentosWebhookVencidos: recebimentosVencidos,
        ultimaLimpezaEm: ultimaLimpeza?.criadoEm.toISOString() ?? null,
      },
    };
  }
}
