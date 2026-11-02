import { Injectable } from '@nestjs/common';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import { SemPermissaoException } from '../comum/erros/excecoes';
import {
  montarPagina,
  type Pagina,
  paraSkipTake,
} from '../comum/paginacao/paginacao';
import { Prisma, type SituacaoEnvioRegua } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { deDataDoBanco, hojeLocal, paraDataDoBanco } from './datas';
import type { FiltroEnviosDto } from './financeiro.dto';
import {
  filtroDeParcelasVisiveis,
  podeAtuarNoFinanceiro,
  podeGerenciarARegua,
} from './permissoes-financeiro';
import { ReguaConfiguracaoService } from './regua-configuracao.service';
import { ReguaEnvioService } from './regua-envio.service';

/** Envios do dia, execuções e o andamento da régua (R24.4, R24.9). */
@Injectable()
export class ReguaConsultaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configuracao: ReguaConfiguracaoService,
    private readonly envios: ReguaEnvioService,
  ) {}

  private exigir(usuario: UsuarioAutenticado): void {
    if (!podeAtuarNoFinanceiro(usuario.papel)) {
      throw new SemPermissaoException(
        'Você não tem acesso à régua de cobrança.',
        { regra: 'R22.1' },
      );
    }
  }

  async execucoes(usuario: UsuarioAutenticado, limite = 30) {
    this.exigir(usuario);
    const itens = await this.prisma.reguaExecucao.findMany({
      orderBy: { iniciadaEm: 'desc' },
      take: Math.min(Math.max(limite, 1), 100),
    });
    return itens.map((e) => ({
      id: e.id,
      tipo: e.tipo,
      dia: deDataDoBanco(e.dia),
      status: e.status,
      resumo: e.resumo as Record<string, number>,
      erro: e.erro,
      disparadaPorId: e.disparadaPorId,
      iniciadaEm: e.iniciadaEm.toISOString(),
      concluidaEm: e.concluidaEm?.toISOString() ?? null,
    }));
  }

  async listarEnvios(
    usuario: UsuarioAutenticado,
    f: FiltroEnviosDto,
  ): Promise<Pagina<unknown>> {
    this.exigir(usuario);
    const dia = f.dia ?? hojeLocal();
    const where: Prisma.ReguaEnvioWhereInput = {
      parcela: filtroDeParcelasVisiveis(usuario),
      ...(f.parcelaId
        ? { parcelaId: f.parcelaId }
        : { dia: paraDataDoBanco(dia) }),
      ...(f.canal ? { canal: f.canal } : {}),
      ...(f.situacao ? { situacao: f.situacao as SituacaoEnvioRegua } : {}),
    };
    const [itens, total] = await Promise.all([
      this.prisma.reguaEnvio.findMany({
        where,
        orderBy: [{ criadoEm: 'desc' }],
        include: {
          parcela: {
            select: {
              id: true,
              numero: true,
              status: true,
              contato: { select: { id: true, nome: true } },
              empresa: { select: { id: true, nome: true } },
            },
          },
        },
        ...paraSkipTake(f),
      }),
      this.prisma.reguaEnvio.count({ where }),
    ]);
    const mensagens = await this.prisma.mensagem.findMany({
      where: {
        id: { in: itens.flatMap((e) => (e.mensagemId ? [e.mensagemId] : [])) },
      },
      select: { id: true, status: true },
    });
    const statusDe = new Map(mensagens.map((m) => [m.id, m.status]));
    return montarPagina(
      itens.map((e) => ({
        id: e.id,
        dia: deDataDoBanco(e.dia),
        parcela: e.parcela,
        etapa: e.etapaNome,
        marco: e.marco,
        tipo: e.tipo,
        canal: e.canal,
        situacao: e.situacao,
        destino: e.destino,
        agendadoPara: e.agendadoPara?.toISOString() ?? null,
        enviadoEm: e.enviadoEm?.toISOString() ?? null,
        motivo: e.motivo,
        erro: e.erro,
        /** Situação da mensagem no Atendimento (enviada, entregue, lida, falha). */
        statusDaMensagem: e.mensagemId
          ? (statusDe.get(e.mensagemId) ?? null)
          : null,
      })),
      total,
      f,
    );
  }

  /** Acompanhamento do dia: progresso do WhatsApp, e-mails, ligações e o próximo envio. */
  async resumoDoDia(usuario: UsuarioAutenticado, diaPedido?: string) {
    this.exigir(usuario);
    const dia = diaPedido ?? hojeLocal();
    const base: Prisma.ReguaEnvioWhereInput = {
      parcela: filtroDeParcelasVisiveis(usuario),
      dia: paraDataDoBanco(dia),
    };
    const grupos = await this.prisma.reguaEnvio.groupBy({
      by: ['canal', 'situacao'],
      where: { ...base, canal: { not: null } },
      _count: { _all: true },
    });
    const contagem = (canal: string) => {
      const r: Record<string, number> = {};
      for (const g of grupos) {
        if (g.canal === canal) r[g.situacao] = g._count._all;
      }
      return r;
    };
    const proximo = await this.prisma.reguaEnvio.findFirst({
      where: { ...base, canal: 'WHATSAPP', situacao: 'AGENDADO' },
      orderBy: { agendadoPara: 'asc' },
      select: { agendadoPara: true },
    });
    const pendentes = await this.prisma.reguaEnvio.count({
      where: {
        canal: 'LIGACAO',
        situacao: 'AGUARDANDO_LIGACAO',
        parcela: filtroDeParcelasVisiveis(usuario),
      },
    });
    const config = await this.configuracao.configuracao();
    const ultima = await this.prisma.reguaExecucao.findFirst({
      orderBy: { iniciadaEm: 'desc' },
    });
    return {
      dia,
      whatsapp: contagem('WHATSAPP'),
      email: contagem('EMAIL'),
      ligacoes: contagem('LIGACAO'),
      ligacoesPendentes: pendentes,
      proximoEnvioWhatsapp: proximo?.agendadoPara?.toISOString() ?? null,
      pausada: config.pausada,
      ativa: config.ativa,
      horario: config.horario,
      ultimaExecucao: ultima
        ? {
            id: ultima.id,
            tipo: ultima.tipo,
            status: ultima.status,
            iniciadaEm: ultima.iniciadaEm.toISOString(),
            resumo: ultima.resumo as Record<string, number>,
          }
        : null,
      podeGerenciar: podeGerenciarARegua(usuario.papel),
    };
  }

  async reenviarFalhas(
    usuario: UsuarioAutenticado,
    opcoes: { canal?: 'WHATSAPP' | 'EMAIL'; dia?: string },
  ) {
    if (!podeGerenciarARegua(usuario.papel)) {
      throw new SemPermissaoException(
        'Só Admin, C-level e Líder de CS reenviam em massa.',
        { regra: 'R22.1' },
      );
    }
    const reenviados = await this.envios.reenviarFalhas({
      canal: opcoes.canal,
      dia: opcoes.dia ?? hojeLocal(),
    });
    return { reenviados };
  }
}
