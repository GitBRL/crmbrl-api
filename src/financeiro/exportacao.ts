/** Gravação de planilhas (XLSX/CSV com `;`) do Financeiro no contexto RELATORIO. */
import ExcelJS from 'exceljs';
import type { ArquivosService } from '../arquivos/arquivos.service';

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
    linhas: string[][];
    usuarioId: string;
  },
) {
  let conteudo: Buffer;
  let mime: string;
  if (opcoes.formato === 'csv') {
    conteudo = Buffer.from(
      `﻿${[opcoes.cabecalho, ...opcoes.linhas].map((l) => l.map(celulaCsv).join(';')).join('\r\n')}\r\n`,
      'utf8',
    );
    mime = 'text/csv';
  } else {
    const livro = new ExcelJS.Workbook();
    const folha = livro.addWorksheet(opcoes.folha);
    folha.addRow(opcoes.cabecalho).font = { bold: true };
    for (const linha of opcoes.linhas) {
      // Texto literal: o XLSX não interpreta como fórmula.
      folha.addRow(linha.map((v) => ({ richText: [{ text: v }] })));
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
