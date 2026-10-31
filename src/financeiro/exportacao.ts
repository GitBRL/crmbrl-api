/** Gravação de planilhas (XLSX/CSV com `;`) do Financeiro no contexto RELATORIO. */
import ExcelJS from 'exceljs';
import type { ArquivosService } from '../arquivos/arquivos.service';

export type CelulaDeExportacao = string | number | Date | null;

function doisDigitos(n: number): string {
  return String(n).padStart(2, '0');
}

function dataCsv(d: Date): string {
  return `${doisDigitos(d.getUTCDate())}/${doisDigitos(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
}

/** Texto da célula no CSV: vírgula decimal e datas em dd/mm/aaaa (como o Excel em português lê). */
function textoCsv(valor: CelulaDeExportacao, moeda: boolean): string {
  if (valor === null) return '';
  if (valor instanceof Date) return dataCsv(valor);
  if (typeof valor === 'number') {
    return (moeda ? valor.toFixed(2) : String(valor)).replace('.', ',');
  }
  return celulaCsv(valor);
}

function celulaCsv(valor: string): string {
  // Evita que a planilha execute fórmulas vindas de nomes de clientes.
  const seguro = /^[=+\-@\t\r]/.test(valor) ? `'${valor}` : valor;
  return /[";\r\n]/.test(seguro) ? `"${seguro.replace(/"/g, '""')}"` : seguro;
}

export async function escreverExportacao(
  arquivos: ArquivosService,
  opcoes: {
    base: string;
    formato: 'xlsx' | 'csv';
    folha: string;
    cabecalho: string[];
    linhas: CelulaDeExportacao[][];
    /** Índices das colunas de valor em reais (duas casas decimais). */
    colunasDeMoeda?: number[];
    usuarioId: string;
  },
) {
  const moeda = new Set(opcoes.colunasDeMoeda ?? []);
  let conteudo: Buffer;
  let mime: string;
  if (opcoes.formato === 'csv') {
    conteudo = Buffer.from(
      `﻿${[opcoes.cabecalho.map(celulaCsv), ...opcoes.linhas.map((l) => l.map((v, i) => textoCsv(v, moeda.has(i))))].map((l) => l.join(';')).join('\r\n')}\r\n`,
      'utf8',
    );
    mime = 'text/csv';
  } else {
    const livro = new ExcelJS.Workbook();
    const folha = livro.addWorksheet(opcoes.folha);
    folha.addRow(opcoes.cabecalho).font = { bold: true };
    for (const linha of opcoes.linhas) {
      // Texto literal: o XLSX não interpreta como fórmula; números e datas ficam tipados.
      const nova = folha.addRow(
        linha.map((v) =>
          typeof v === 'string' ? { richText: [{ text: v }] } : v,
        ),
      );
      linha.forEach((v, i) => {
        if (v instanceof Date) nova.getCell(i + 1).numFmt = 'dd/mm/yyyy';
        else if (typeof v === 'number') {
          nova.getCell(i + 1).numFmt = moeda.has(i) ? '#,##0.00' : '0';
        }
      });
    }
    folha.columns.forEach((c) => {
      c.width = 22;
    });
    folha.views = [{ state: 'frozen', ySplit: 1 }];
    conteudo = Buffer.from(await livro.xlsx.writeBuffer());
    mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  }
  return arquivos.salvar(conteudo, {
    nome: `${opcoes.base}.${opcoes.formato}`,
    mime,
    contexto: 'RELATORIO',
    criadoPorId: opcoes.usuarioId,
  });
}
