/**
 * Leitura de planilhas CSV e XLSX (R16). Devolve cabeçalho e linhas de dados
 * como texto, com o número da linha no arquivo (o cabeçalho é a linha 1).
 * Linhas totalmente vazias são descartadas.
 */
import ExcelJS from 'exceljs';

export interface OpcoesDeLeitura {
  /** CSV: `,` `;` tab ou `|`; ausente = detecta. */
  separador?: string;
  /** CSV: `utf-8` ou `latin1`; ausente = detecta. */
  codificacao?: 'utf-8' | 'latin1';
  /** XLSX: nome da aba; ausente = a primeira. */
  aba?: string;
  /** Linha do cabeçalho (padrão 1). */
  linhaCabecalho?: number;
}

export interface LinhaLida {
  /** Número da linha no arquivo (CSV: ordem do registro, cabeçalho = 1). */
  numero: number;
  valores: string[];
}

export interface PlanilhaLida {
  colunas: string[];
  linhas: LinhaLida[];
  /** Leitura efetivamente usada (detecções incluídas), para gravar em `leitura`. */
  leitura: OpcoesDeLeitura & { abas?: string[] };
}

export class PlanilhaIlegivelError extends Error {}

const SEPARADORES = [',', ';', '\t', '|'];

export async function lerPlanilha(
  conteudo: Buffer,
  formato: 'csv' | 'xlsx',
  opcoes: OpcoesDeLeitura = {},
): Promise<PlanilhaLida> {
  return formato === 'csv'
    ? lerCsv(conteudo, opcoes)
    : lerXlsx(conteudo, opcoes);
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

function decodificar(
  conteudo: Buffer,
  codificacao?: 'utf-8' | 'latin1',
): {
  texto: string;
  codificacao: 'utf-8' | 'latin1';
} {
  if (codificacao === 'latin1') {
    return { texto: conteudo.toString('latin1'), codificacao };
  }
  try {
    const texto = new TextDecoder('utf-8', { fatal: true }).decode(conteudo);
    return { texto: texto.replace(/^﻿/, ''), codificacao: 'utf-8' };
  } catch {
    if (codificacao === 'utf-8') {
      throw new PlanilhaIlegivelError('O arquivo não está em UTF-8.');
    }
    return { texto: conteudo.toString('latin1'), codificacao: 'latin1' };
  }
}

/** Separador mais frequente na primeira linha com conteúdo, fora de aspas. */
export function detectarSeparador(texto: string): string {
  const contagem = new Map<string, number>(SEPARADORES.map((s) => [s, 0]));
  let aspas = false;
  for (let i = 0; i < texto.length && i < 20_000; i++) {
    const c = texto[i];
    if (c === '"') {
      aspas = !aspas;
    } else if (!aspas && (c === '\n' || c === '\r')) {
      if ([...contagem.values()].some((n) => n > 0)) {
        break;
      }
    } else if (!aspas && contagem.has(c)) {
      contagem.set(c, (contagem.get(c) ?? 0) + 1);
    }
  }
  let melhor = ',';
  let maior = 0;
  for (const [separador, n] of contagem) {
    if (n > maior) {
      maior = n;
      melhor = separador;
    }
  }
  return melhor;
}

/** Divide o texto CSV (RFC 4180) em registros. */
export function dividirCsv(texto: string, separador: string): string[][] {
  const registros: string[][] = [];
  let registro: string[] = [];
  let campo = '';
  let aspas = false;
  let haConteudo = false;
  const fecharCampo = () => {
    registro.push(campo);
    campo = '';
  };
  const fecharRegistro = () => {
    fecharCampo();
    registros.push(registro);
    registro = [];
    haConteudo = false;
  };
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (aspas) {
      if (c === '"') {
        if (texto[i + 1] === '"') {
          campo += '"';
          i++;
        } else {
          aspas = false;
        }
      } else {
        campo += c;
      }
    } else if (c === '"' && campo === '') {
      aspas = true;
      haConteudo = true;
    } else if (c === separador) {
      fecharCampo();
      haConteudo = true;
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && texto[i + 1] === '\n') {
        i++;
      }
      fecharRegistro();
    } else {
      campo += c;
      haConteudo = true;
    }
  }
  if (haConteudo || campo !== '' || registro.length > 0) {
    fecharRegistro();
  }
  return registros;
}

function lerCsv(conteudo: Buffer, opcoes: OpcoesDeLeitura): PlanilhaLida {
  const { texto, codificacao } = decodificar(conteudo, opcoes.codificacao);
  const separador = opcoes.separador ?? detectarSeparador(texto);
  const registros = dividirCsv(texto, separador);
  return montar(
    registros.map((valores, i) => ({ numero: i + 1, valores })),
    opcoes.linhaCabecalho ?? 1,
    { separador, codificacao, linhaCabecalho: opcoes.linhaCabecalho ?? 1 },
  );
}

// ---------------------------------------------------------------------------
// XLSX
// ---------------------------------------------------------------------------

function textoDaCelula(valor: ExcelJS.CellValue): string {
  if (valor === null || valor === undefined) {
    return '';
  }
  if (typeof valor === 'number') {
    return Number.isInteger(valor) ? valor.toFixed(0) : String(valor);
  }
  if (typeof valor === 'string') {
    return valor;
  }
  if (typeof valor === 'boolean') {
    return valor ? 'sim' : 'não';
  }
  if (valor instanceof Date) {
    return valor.toISOString().slice(0, 10);
  }
  if (typeof valor === 'object') {
    if ('richText' in valor) {
      return valor.richText.map((parte) => parte.text).join('');
    }
    if ('result' in valor) {
      return textoDaCelula(valor.result as ExcelJS.CellValue);
    }
    if ('text' in valor) {
      return textoDaCelula(valor.text as ExcelJS.CellValue);
    }
    if ('error' in valor) {
      return '';
    }
  }
  return '';
}

async function lerXlsx(
  conteudo: Buffer,
  opcoes: OpcoesDeLeitura,
): Promise<PlanilhaLida> {
  const livro = new ExcelJS.Workbook();
  try {
    await livro.xlsx.load(conteudo as unknown as ArrayBuffer);
  } catch {
    throw new PlanilhaIlegivelError('Não foi possível ler a planilha XLSX.');
  }
  const abas = livro.worksheets.map((aba) => aba.name);
  const aba = opcoes.aba ? livro.getWorksheet(opcoes.aba) : livro.worksheets[0];
  if (!aba) {
    throw new PlanilhaIlegivelError(
      opcoes.aba
        ? `A aba "${opcoes.aba}" não existe.`
        : 'A planilha não tem abas.',
    );
  }
  const registros: LinhaLida[] = [];
  const colunasTotais = aba.columnCount;
  aba.eachRow({ includeEmpty: false }, (linha, numero) => {
    const valores: string[] = [];
    for (let c = 1; c <= colunasTotais; c++) {
      valores.push(textoDaCelula(linha.getCell(c).value));
    }
    registros.push({ numero, valores });
  });
  return montar(registros, opcoes.linhaCabecalho ?? 1, {
    aba: aba.name,
    abas,
    linhaCabecalho: opcoes.linhaCabecalho ?? 1,
  });
}

// ---------------------------------------------------------------------------

function montar(
  registros: LinhaLida[],
  linhaCabecalho: number,
  leitura: PlanilhaLida['leitura'],
): PlanilhaLida {
  const cabecalho = registros.find((r) => r.numero === linhaCabecalho);
  if (!cabecalho || cabecalho.valores.every((v) => v.trim() === '')) {
    throw new PlanilhaIlegivelError(
      `A linha ${linhaCabecalho} (cabeçalho) está vazia.`,
    );
  }
  const colunas = nomesDeColuna(cabecalho.valores);
  const linhas = registros
    .filter(
      (r) =>
        r.numero > linhaCabecalho && r.valores.some((v) => v.trim() !== ''),
    )
    .map((r) => ({
      numero: r.numero,
      valores: colunas.map((_, i) => (r.valores[i] ?? '').trim()),
    }));
  return { colunas, linhas, leitura };
}

/** Cabeçalhos sem vazios nem repetidos: `Coluna 3`, `Nome (2)`. */
function nomesDeColuna(valores: readonly string[]): string[] {
  let ultimo = valores.length;
  while (ultimo > 0 && valores[ultimo - 1].trim() === '') {
    ultimo--;
  }
  const vistos = new Map<string, number>();
  return valores.slice(0, ultimo).map((valor, i) => {
    const base = valor.trim() || `Coluna ${i + 1}`;
    const vezes = (vistos.get(base.toLowerCase()) ?? 0) + 1;
    vistos.set(base.toLowerCase(), vezes);
    return vezes === 1 ? base : `${base} (${vezes})`;
  });
}
