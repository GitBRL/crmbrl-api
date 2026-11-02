import { Injectable } from '@nestjs/common';
import ExcelJS from 'exceljs';
import { ArquivoDto } from '../arquivos/arquivos.dto';
import { ArquivosService } from '../arquivos/arquivos.service';
import { AuditoriaService } from '../auditoria/auditoria.service';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import { DadosInvalidosException } from '../comum/erros/excecoes';
import { PrismaService } from '../prisma/prisma.service';
import type { PainelBi, PainelCalculado, TabelaBi } from './bi.tipos';
import type { ExportarBiDto } from './dto/filtro-bi.dto';
import {
  cabecalhoDaColuna,
  cartoesComoTabela,
  nomeDeAba,
  tabelaComoCsv,
} from './formatos-bi';

const MIME_XLSX =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * Exportação de um painel (CSV ou XLSX): sempre recalcula (sem cache), com os
 * mesmos filtros e a mesma visibilidade do painel, salva o arquivo no contexto
 * `RELATORIO` e audita (`bi.exportado`).
 */
@Injectable()
export class ExportacaoBiService {
  constructor(
    private readonly arquivos: ArquivosService,
    private readonly auditoria: AuditoriaService,
    private readonly prisma: PrismaService,
  ) {}

  async exportar(
    usuario: UsuarioAutenticado,
    painel: PainelBi,
    dto: ExportarBiDto,
    calculado: PainelCalculado,
  ): Promise<ArquivoDto> {
    const formato = dto.formato ?? 'xlsx';
    const todas: Record<string, TabelaBi> = {
      cartoes: cartoesComoTabela(calculado.cartoes),
      ...calculado.tabelas,
    };
    let escolhida: TabelaBi | null = null;
    if (dto.tabela) {
      escolhida = todas[dto.tabela] ?? null;
      if (!escolhida) {
        throw new DadosInvalidosException('Tabela desconhecida neste painel.', {
          campos: [
            {
              campo: 'tabela',
              mensagens: [`use uma de: ${Object.keys(todas).join(', ')}`],
            },
          ],
        });
      }
    }
    let conteudo: Buffer;
    let linhas: number;
    if (formato === 'csv') {
      const tabela = escolhida ?? todas.cartoes;
      conteudo = Buffer.from(tabelaComoCsv(tabela), 'utf8');
      linhas = tabela.linhas.length;
    } else {
      const tabelas = escolhida ? [escolhida] : Object.values(todas);
      conteudo = await montarXlsx(painel, calculado, tabelas);
      linhas = tabelas.reduce((soma, t) => soma + t.linhas.length, 0);
    }
    const hoje = new Date().toISOString().slice(0, 10);
    const sufixo =
      escolhida && escolhida.chave !== 'cartoes' ? `-${escolhida.chave}` : '';
    const arquivo = await this.arquivos.salvar(conteudo, {
      nome: `bi-${painel}${sufixo}-${hoje}.${formato}`,
      mime: formato === 'csv' ? 'text/csv' : MIME_XLSX,
      contexto: 'RELATORIO',
      criadoPorId: usuario.id,
    });
    await this.prisma.$transaction((tx) =>
      this.auditoria.registrar(tx, {
        acao: 'bi.exportado',
        entidade: 'painel_bi',
        resumo: `${usuario.nome} exportou o painel ${painel} do BI (${formato.toUpperCase()}${escolhida ? `, tabela ${escolhida.chave}` : ''})`,
        dados: {
          painel,
          formato,
          tabela: escolhida?.chave ?? null,
          linhas,
          arquivoId: arquivo.id,
          periodo: calculado.periodo,
          filtros: calculado.filtros,
          regra: 'R20',
        },
      }),
    );
    return ArquivoDto.de(arquivo);
  }
}

async function montarXlsx(
  painel: PainelBi,
  calculado: PainelCalculado,
  tabelas: TabelaBi[],
): Promise<Buffer> {
  const livro = new ExcelJS.Workbook();
  livro.creator = 'BRL CRM';
  for (const tabela of tabelas) {
    const folha = livro.addWorksheet(nomeDeAba(tabela.titulo));
    const colunas = tabela.colunas.filter((c) => c.visivel);
    folha.addRow(colunas.map(cabecalhoDaColuna)).font = { bold: true };
    for (const linha of tabela.linhas) {
      // Texto literal: a planilha não interpreta nome de contato como fórmula.
      folha.addRow(
        colunas.map((c) => {
          const valor = linha[c.chave] ?? null;
          return typeof valor === 'string'
            ? { richText: [{ text: valor }] }
            : valor;
        }),
      );
    }
    folha.columns.forEach((coluna) => {
      coluna.width = 24;
    });
    folha.views = [{ state: 'frozen', ySplit: 1 }];
  }
  const resumo = livro.addWorksheet('Período', { state: 'visible' });
  resumo.addRows([
    ['Painel', painel],
    ['De', calculado.periodo.de],
    ['Até (exclusivo)', calculado.periodo.ate],
    ['Gerado em', calculado.geradoEm],
  ]);
  resumo.getColumn(1).font = { bold: true };
  resumo.getColumn(1).width = 20;
  resumo.getColumn(2).width = 40;
  return Buffer.from(await livro.xlsx.writeBuffer());
}
