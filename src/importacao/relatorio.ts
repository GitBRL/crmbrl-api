/** Relatório XLSX da importação (R16): resumo e as linhas que não entraram. */
import ExcelJS from 'exceljs';
import type { Importacao } from '../generated/prisma/client';

export interface LinhaDoRelatorio {
  numero: number;
  resultado: string;
  motivo: string | null;
  dados: Record<string, unknown> | null;
}

const ROTULO_DO_STATUS: Record<string, string> = {
  CONCLUIDA: 'Concluída',
  FALHOU: 'Falhou',
  CANCELADA: 'Cancelada',
};
const ROTULO_DO_RESULTADO: Record<string, string> = {
  CRIADO: 'Criado',
  ATUALIZADO: 'Atualizado',
  IGNORADO: 'Ignorado',
  ERRO: 'Erro',
};

export async function gerarRelatorio(
  importacao: Importacao,
  linhas: readonly LinhaDoRelatorio[],
): Promise<Buffer> {
  const livro = new ExcelJS.Workbook();
  livro.created = new Date();

  const resumo = livro.addWorksheet('Resumo');
  resumo.columns = [
    { header: 'Item', key: 'item', width: 28 },
    { header: 'Valor', key: 'valor', width: 48 },
  ];
  const duracao =
    importacao.iniciadaEm && importacao.concluidaEm
      ? Math.max(
          0,
          Math.round(
            (importacao.concluidaEm.getTime() -
              importacao.iniciadaEm.getTime()) /
              1000,
          ),
        )
      : null;
  resumo.addRows([
    { item: 'Arquivo', valor: importacao.nome },
    {
      item: 'Tipo',
      valor:
        importacao.tipo === 'CONTATOS'
          ? 'Contatos'
          : importacao.tipo === 'PARCELAS'
            ? 'Parcelas'
            : 'Empresas',
    },
    {
      item: 'Situação',
      valor: ROTULO_DO_STATUS[importacao.status] ?? importacao.status,
    },
    { item: 'Linhas no arquivo', valor: importacao.totalLinhas ?? 0 },
    { item: 'Linhas processadas', valor: importacao.processadas },
    { item: 'Criados', valor: importacao.criados },
    { item: 'Atualizados', valor: importacao.atualizados },
    { item: 'Ignorados', valor: importacao.ignorados },
    { item: 'Erros', valor: importacao.erros },
    { item: 'Fora do filtro', valor: importacao.filtradas },
    { item: 'Negócios criados', valor: importacao.negociosCriados },
    {
      item: 'Negócios reconvertidos',
      valor: importacao.negociosReconvertidos,
    },
    { item: 'Negócios atualizados', valor: importacao.negociosAtualizados },
    { item: 'Duração (segundos)', valor: duracao ?? '' },
  ]);
  resumo.getRow(1).font = { bold: true };

  const colunasDoArquivo = importacao.colunas;
  const problemas = livro.addWorksheet('Erros e ignoradas');
  problemas.columns = [
    { header: 'Linha', key: 'linha', width: 8 },
    { header: 'Resultado', key: 'resultado', width: 12 },
    { header: 'Motivo', key: 'motivo', width: 60 },
    ...colunasDoArquivo.map((coluna, i) => ({
      header: coluna,
      key: `c${i}`,
      width: 24,
    })),
  ];
  problemas.getRow(1).font = { bold: true };
  problemas.views = [{ state: 'frozen', ySplit: 1 }];
  for (const linha of linhas) {
    const registro: Record<string, unknown> = {
      linha: linha.numero,
      resultado: ROTULO_DO_RESULTADO[linha.resultado] ?? linha.resultado,
      motivo: linha.motivo ?? '',
    };
    colunasDoArquivo.forEach((coluna, i) => {
      registro[`c${i}`] = textoSeguro(linha.dados?.[coluna]);
    });
    problemas.addRow(registro);
  }
  return Buffer.from(await livro.xlsx.writeBuffer());
}

/** Evita que o Excel trate texto da planilha como fórmula (`=`, `+`, `-`, `@`). */
function textoSeguro(valor: unknown): string {
  const texto = typeof valor === 'string' ? valor : '';
  return /^[=+\-@]/.test(texto) ? `'${texto}` : texto;
}
