import { Injectable } from '@nestjs/common';
import ExcelJS from 'exceljs';
import { ArquivosService } from '../arquivos/arquivos.service';
import { ArquivoDto } from '../arquivos/arquivos.dto';
import { AuditoriaService } from '../auditoria/auditoria.service';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import type { Campanha } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AcessoDisparos } from './acesso-disparos.service';
import {
  type ContadoresDaCampanha,
  ProgressoDaCampanha,
} from './progresso-da-campanha.service';

export interface TaxasDaCampanha {
  /** Sobre os enviados, em %. */
  entrega: number;
  leitura: number;
  resposta: number;
  /** Sobre os destinatários que tentaram enviar (enviados + falhas). */
  falha: number;
  optOut: number;
}

export interface RelatorioDaCampanha {
  campanhaId: string;
  nome: string;
  status: string;
  contadores: ContadoresDaCampanha;
  taxas: TaxasDaCampanha;
  porNumero: Array<{
    canalId: string;
    nome: string;
    telefone: string | null;
    enviados: number;
    entregues: number;
    lidos: number;
    respondidos: number;
    falhas: number;
  }>;
  serie: Array<{
    inicio: string;
    enviados: number;
    entregues: number;
    lidos: number;
    respondidos: number;
    falhas: number;
  }>;
  motivosDeFalha: Array<{ motivo: string; quantidade: number }>;
  motivosDeExclusao: Array<{ motivo: string; quantidade: number }>;
}

const ROTULO_DO_STATUS_DO_DESTINATARIO: Record<string, string> = {
  PENDENTE: 'Pendente',
  ENVIANDO: 'Enviando',
  ENVIADO: 'Enviado',
  FALHOU: 'Falhou',
  INVALIDO: 'Número inválido',
  EXCLUIDO: 'Excluído',
};

function percentual(parte: number, total: number): number {
  return total > 0 ? Math.round((parte / total) * 1000) / 10 : 0;
}

/** Relatório da campanha (contadores, taxas, por número, ao longo do tempo) e exportação CSV/XLSX. */
@Injectable()
export class RelatorioDeCampanha {
  constructor(
    private readonly prisma: PrismaService,
    private readonly acesso: AcessoDisparos,
    private readonly progresso: ProgressoDaCampanha,
    private readonly arquivos: ArquivosService,
    private readonly auditoria: AuditoriaService,
  ) {}

  async gerar(
    usuario: UsuarioAutenticado,
    id: string,
    agrupar: 'hora' | 'dia' = 'hora',
  ): Promise<RelatorioDaCampanha> {
    const campanha = await this.acesso.obter(usuario, id);
    const contadores = await this.progresso.contar(this.prisma, id);

    const porNumero = await this.prisma.$queryRaw<
      Array<{
        canal_id: string;
        nome: string;
        telefone: string | null;
        enviados: number;
        entregues: number;
        lidos: number;
        respondidos: number;
        falhas: number;
      }>
    >`
      SELECT d.canal_id, c.nome, n.telefone,
             COUNT(*) FILTER (WHERE d.enviado_em IS NOT NULL)::int AS enviados,
             COUNT(*) FILTER (WHERE d.entregue_em IS NOT NULL)::int AS entregues,
             COUNT(*) FILTER (WHERE d.lido_em IS NOT NULL)::int AS lidos,
             COUNT(*) FILTER (WHERE d.respondeu_em IS NOT NULL)::int AS respondidos,
             COUNT(*) FILTER (WHERE d.status = 'FALHOU')::int AS falhas
        FROM campanha_destinatarios d
        JOIN canais c ON c.id = d.canal_id
        LEFT JOIN whatsapp_numeros n ON n.canal_id = c.id
       WHERE d.campanha_id = ${id}::uuid AND d.canal_id IS NOT NULL
       GROUP BY d.canal_id, c.nome, n.telefone
       ORDER BY c.nome`;

    const serie =
      agrupar === 'dia'
        ? await this.prisma.$queryRaw<SerieBruta[]>`
            SELECT to_char(date_trunc('day', enviado_em AT TIME ZONE 'America/Sao_Paulo'), 'YYYY-MM-DD') AS inicio,
                   COUNT(*)::int AS enviados,
                   COUNT(*) FILTER (WHERE entregue_em IS NOT NULL)::int AS entregues,
                   COUNT(*) FILTER (WHERE lido_em IS NOT NULL)::int AS lidos,
                   COUNT(*) FILTER (WHERE respondeu_em IS NOT NULL)::int AS respondidos,
                   0::int AS falhas
              FROM campanha_destinatarios
             WHERE campanha_id = ${id}::uuid AND enviado_em IS NOT NULL
             GROUP BY 1 ORDER BY 1`
        : await this.prisma.$queryRaw<SerieBruta[]>`
            SELECT to_char(date_trunc('hour', enviado_em AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS inicio,
                   COUNT(*)::int AS enviados,
                   COUNT(*) FILTER (WHERE entregue_em IS NOT NULL)::int AS entregues,
                   COUNT(*) FILTER (WHERE lido_em IS NOT NULL)::int AS lidos,
                   COUNT(*) FILTER (WHERE respondeu_em IS NOT NULL)::int AS respondidos,
                   0::int AS falhas
              FROM campanha_destinatarios
             WHERE campanha_id = ${id}::uuid AND enviado_em IS NOT NULL
             GROUP BY 1 ORDER BY 1`;

    const motivos = await this.prisma.campanhaDestinatario.groupBy({
      by: ['status', 'motivo'],
      where: {
        campanhaId: id,
        status: { in: ['FALHOU', 'INVALIDO', 'EXCLUIDO'] },
      },
      _count: { _all: true },
    });
    const lista = (status: string[]) =>
      motivos
        .filter((m) => status.includes(m.status))
        .map((m) => ({
          motivo: m.motivo ?? 'Sem motivo informado',
          quantidade: m._count._all,
        }))
        .sort((a, b) => b.quantidade - a.quantidade);

    return {
      campanhaId: id,
      nome: campanha.nome,
      status: campanha.status,
      contadores,
      taxas: {
        entrega: percentual(contadores.entregues, contadores.enviados),
        leitura: percentual(contadores.lidos, contadores.enviados),
        resposta: percentual(contadores.respondidos, contadores.enviados),
        falha: percentual(
          contadores.falhas,
          contadores.enviados + contadores.falhas,
        ),
        optOut: percentual(contadores.optOuts, contadores.enviados),
      },
      porNumero: porNumero.map((n) => ({
        canalId: n.canal_id,
        nome: n.nome,
        telefone: n.telefone,
        enviados: n.enviados,
        entregues: n.entregues,
        lidos: n.lidos,
        respondidos: n.respondidos,
        falhas: n.falhas,
      })),
      serie,
      motivosDeFalha: lista(['FALHOU', 'INVALIDO']),
      motivosDeExclusao: lista(['EXCLUIDO']),
    };
  }

  /** Gera o arquivo (contexto `RELATORIO`) e devolve o registro com o endereço do download. */
  async exportar(
    usuario: UsuarioAutenticado,
    id: string,
    formato: 'xlsx' | 'csv' = 'xlsx',
  ): Promise<ArquivoDto> {
    const campanha = await this.acesso.obter(usuario, id);
    const relatorio = await this.gerar(usuario, id);
    const linhas: string[][] = [];
    let cursor: string | undefined;
    for (;;) {
      const lote = await this.prisma.campanhaDestinatario.findMany({
        where: { campanhaId: id },
        orderBy: { id: 'asc' },
        take: 2000,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        include: {
          contato: { select: { nome: true, email: true, telefone: true } },
          canal: { select: { nome: true } },
        },
      });
      if (lote.length === 0) {
        break;
      }
      cursor = lote.at(-1)?.id;
      for (const d of lote) {
        linhas.push([
          d.contato.nome,
          d.destino,
          ROTULO_DO_STATUS_DO_DESTINATARIO[d.status] ?? d.status,
          d.motivo ?? '',
          d.canal?.nome ?? '',
          formatarData(d.enviadoEm),
          formatarData(d.entregueEm),
          formatarData(d.lidoEm),
          formatarData(d.respondeuEm),
          formatarData(d.optOutEm),
        ]);
      }
    }
    const cabecalho = [
      'Contato',
      campanha.canal === 'WHATSAPP' ? 'Telefone' : 'E-mail',
      'Situação',
      'Motivo',
      'Enviado por',
      'Enviado em',
      'Entregue em',
      'Lido em',
      'Respondeu em',
      'Opt-out em',
    ];
    const base = `campanha-${slug(campanha.nome)}-${new Date().toISOString().slice(0, 10)}`;
    let conteudo: Buffer;
    let mime: string;
    if (formato === 'csv') {
      conteudo = Buffer.from(
        `﻿${[cabecalho, ...linhas].map((l) => l.map(celulaCsv).join(';')).join('\r\n')}\r\n`,
        'utf8',
      );
      mime = 'text/csv';
    } else {
      conteudo = await montarXlsx(relatorio, cabecalho, linhas);
      mime =
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    }
    const arquivo = await this.arquivos.salvar(conteudo, {
      nome: `${base}.${formato}`,
      mime,
      contexto: 'RELATORIO',
      criadoPorId: usuario.id,
    });
    await this.prisma.$transaction((tx) =>
      this.auditoria.registrar(tx, {
        acao: 'campanha.exportada',
        entidade: 'campanha',
        entidadeId: id,
        resumo: `${usuario.nome} exportou o relatório da campanha "${campanha.nome}" (${formato.toUpperCase()})`,
        dados: {
          arquivoId: arquivo.id,
          formato,
          linhas: linhas.length,
          regra: 'R17',
        },
      }),
    );
    return ArquivoDto.de(arquivo);
  }
}

interface SerieBruta {
  inicio: string;
  enviados: number;
  entregues: number;
  lidos: number;
  respondidos: number;
  falhas: number;
}

function formatarData(data: Date | null): string {
  if (!data) {
    return '';
  }
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(data);
}

function celulaCsv(valor: string): string {
  // Evita que a planilha execute fórmulas vindas de nomes de contatos.
  const seguro = /^[=+\-@\t\r]/.test(valor) ? `'${valor}` : valor;
  return /[";\r\n]/.test(seguro) ? `"${seguro.replace(/"/g, '""')}"` : seguro;
}

function slug(texto: string): string {
  return (
    texto
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'relatorio'
  );
}

async function montarXlsx(
  relatorio: RelatorioDaCampanha,
  cabecalho: string[],
  linhas: string[][],
): Promise<Buffer> {
  const livro = new ExcelJS.Workbook();
  const resumo = livro.addWorksheet('Resumo');
  const c = relatorio.contadores;
  resumo.addRows([
    ['Campanha', relatorio.nome],
    ['Situação', relatorio.status],
    ['Destinatários', c.total],
    ['Enviados', c.enviados],
    ['Entregues', c.entregues],
    ['Lidos', c.lidos],
    ['Responderam', c.respondidos],
    ['Falhas', c.falhas],
    ['Números inválidos', c.invalidos],
    ['Excluídos', c.excluidos],
    ['Opt-outs', c.optOuts],
    ['Taxa de entrega (%)', relatorio.taxas.entrega],
    ['Taxa de leitura (%)', relatorio.taxas.leitura],
    ['Taxa de resposta (%)', relatorio.taxas.resposta],
  ]);
  resumo.getColumn(1).font = { bold: true };
  resumo.getColumn(1).width = 24;
  resumo.getColumn(2).width = 40;
  const folha = livro.addWorksheet('Destinatários');
  folha.addRow(cabecalho).font = { bold: true };
  for (const linha of linhas) {
    // Texto literal: o XLSX não interpreta como fórmula.
    folha.addRow(
      linha.map((v) =>
        typeof v === 'string' ? { richText: [{ text: v }] } : v,
      ),
    );
  }
  folha.columns.forEach((coluna) => {
    coluna.width = 24;
  });
  folha.views = [{ state: 'frozen', ySplit: 1 }];
  const numeros = livro.addWorksheet('Por número');
  numeros.addRow([
    'Número',
    'Telefone',
    'Enviados',
    'Entregues',
    'Lidos',
    'Responderam',
    'Falhas',
  ]).font = { bold: true };
  for (const n of relatorio.porNumero) {
    numeros.addRow([
      n.nome,
      n.telefone ?? '',
      n.enviados,
      n.entregues,
      n.lidos,
      n.respondidos,
      n.falhas,
    ]);
  }
  return Buffer.from(await livro.xlsx.writeBuffer());
}

export type { Campanha };
