/**
 * Leitura de planilhas CSV e XLSX (R16). Devolve cabeçalho e linhas de dados
 * como texto, com o número da linha no arquivo (o cabeçalho é a linha 1).
 * Linhas totalmente vazias são descartadas.
 */
import ExcelJS from 'exceljs';
import { Readable } from 'node:stream';
import { LIMITE_DE_LINHAS_DA_IMPORTACAO } from './importacao.constantes';

export interface OpcoesDeLeitura {
  /** CSV: `,` `;` tab ou `|`; ausente = detecta. */
  separador?: string;
  /** CSV: `utf-8` ou `latin1`; ausente = detecta. */
  codificacao?: 'utf-8' | 'latin1';
  /** XLSX: nome da aba; ausente = a primeira. */
  aba?: string;
  /** Linha do cabeçalho (padrão 1). */
  linhaCabecalho?: number;
  /** A planilha não tem cabeçalho: colunas "Coluna 1"…"Coluna N" e a linha 1 é dado (R16.13). */
  semCabecalho?: boolean;
}

/** Linhas olhadas para saber quantas colunas tem uma planilha sem cabeçalho. */
const LINHAS_PARA_LARGURA = 50;

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
    {
      separador,
      codificacao,
      linhaCabecalho: opcoes.linhaCabecalho ?? 1,
      ...(opcoes.semCabecalho ? { semCabecalho: true } : {}),
    },
    opcoes.semCabecalho === true,
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
    const iso = valor.toISOString();
    // Com hora (data e hora do Excel), mantém a hora "de parede".
    return iso.slice(11, 19) === '00:00:00'
      ? iso.slice(0, 10)
      : iso.slice(0, 19);
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

/** Colunas aceitas no cabeçalho de um XLSX. */
export const LIMITE_DE_COLUNAS_DA_IMPORTACAO = 200;

const MENSAGEM_ILEGIVEL_XLSX = 'Não foi possível ler a planilha XLSX.';

/**
 * Lê o XLSX em fluxo (nada de montar o livro inteiro na memória): para ao passar
 * do limite de linhas e só guarda as células até a largura do cabeçalho — uma
 * célula perdida lá na coluna XFD não multiplica linhas por 16 mil colunas.
 */
async function lerXlsx(
  conteudo: Buffer,
  opcoes: OpcoesDeLeitura,
): Promise<PlanilhaLida> {
  const semCabecalho = opcoes.semCabecalho === true;
  const linhaCabecalho = semCabecalho ? 1 : (opcoes.linhaCabecalho ?? 1);
  const entrada = Readable.from([conteudo]);
  const leitor = new ExcelJS.stream.xlsx.WorkbookReader(entrada, {
    worksheets: 'emit',
    sharedStrings: 'cache',
    styles: 'cache',
    hyperlinks: 'ignore',
    entries: 'ignore',
  });
  const registros: LinhaLida[] = [];
  let abas: string[] = [];
  let nomeDaAba: string | null = null;
  let largura = 0;
  try {
    for await (const aba of leitor) {
      const modelo = (leitor.model as { sheets?: { name: string }[] }) ?? {};
      abas = (modelo.sheets ?? []).map((a) => a.name);
      const nome = (aba as unknown as { name?: string }).name ?? '';
      const escolhida = opcoes.aba ? nome === opcoes.aba : nome === abas[0];
      if (!escolhida) {
        continue;
      }
      nomeDaAba = nome;
      let lidas = 0;
      for await (const linha of aba) {
        lidas++;
        if (lidas > LIMITE_DE_LINHAS_DA_IMPORTACAO + linhaCabecalho) {
          throw new PlanilhaIlegivelError(
            `A planilha tem mais de ${LIMITE_DE_LINHAS_DA_IMPORTACAO.toLocaleString('pt-BR')} linhas de dados. Divida o arquivo.`,
          );
        }
        if (linha.number < linhaCabecalho) {
          continue;
        }
        const celulas = linha.values as ExcelJS.CellValue[];
        if (semCabecalho) {
          // Sem cabeçalho não há largura de referência: vale a última célula com texto da linha.
          largura = Math.min(
            larguraDoCabecalho(celulas, false),
            LIMITE_DE_COLUNAS_DA_IMPORTACAO,
          );
        } else if (linha.number === linhaCabecalho) {
          largura = larguraDoCabecalho(celulas);
        }
        const valores: string[] = [];
        for (let c = 1; c <= largura; c++) {
          valores.push(textoDaCelula(celulas[c]));
        }
        registros.push({ numero: linha.number, valores });
      }
      break;
    }
  } catch (erro) {
    if (erro instanceof PlanilhaIlegivelError) {
      throw erro;
    }
    throw new PlanilhaIlegivelError(MENSAGEM_ILEGIVEL_XLSX);
  } finally {
    entrada.destroy();
  }
  if (nomeDaAba === null) {
    throw new PlanilhaIlegivelError(
      opcoes.aba
        ? `A aba "${opcoes.aba}" não existe.`
        : abas.length === 0
          ? MENSAGEM_ILEGIVEL_XLSX
          : 'A planilha não tem abas.',
    );
  }
  return montar(
    registros,
    linhaCabecalho,
    {
      aba: nomeDaAba,
      abas,
      linhaCabecalho,
      ...(semCabecalho ? { semCabecalho: true } : {}),
    },
    semCabecalho,
  );
}

/** Última coluna com texto no cabeçalho (as células vêm num array esparso). */
function larguraDoCabecalho(
  celulas: readonly ExcelJS.CellValue[],
  limitar = true,
): number {
  let ultima = 0;
  celulas.forEach((valor, indice) => {
    if (textoDaCelula(valor).trim() !== '') {
      ultima = Math.max(ultima, indice);
    }
  });
  if (limitar && ultima > LIMITE_DE_COLUNAS_DA_IMPORTACAO) {
    throw new PlanilhaIlegivelError(
      `A planilha tem mais de ${LIMITE_DE_COLUNAS_DA_IMPORTACAO} colunas no cabeçalho.`,
    );
  }
  return ultima;
}

// ---------------------------------------------------------------------------

function montar(
  registros: LinhaLida[],
  linhaCabecalho: number,
  leitura: PlanilhaLida['leitura'],
  semCabecalho = false,
): PlanilhaLida {
  if (semCabecalho) {
    return montarSemCabecalho(registros, leitura);
  }
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

/** Sem cabeçalho: "Coluna 1"…"Coluna N" (N = maior largura entre as primeiras linhas) e a linha 1 é dado. */
function montarSemCabecalho(
  registros: LinhaLida[],
  leitura: PlanilhaLida['leitura'],
): PlanilhaLida {
  const comDados = registros.filter((r) =>
    r.valores.some((v) => v.trim() !== ''),
  );
  if (comDados.length === 0) {
    throw new PlanilhaIlegivelError('A planilha está vazia.');
  }
  let largura = 0;
  for (const r of comDados.slice(0, LINHAS_PARA_LARGURA)) {
    let ultimo = r.valores.length;
    while (ultimo > 0 && r.valores[ultimo - 1].trim() === '') {
      ultimo--;
    }
    largura = Math.max(largura, ultimo);
  }
  const colunas = Array.from({ length: largura }, (_, i) => `Coluna ${i + 1}`);
  const linhas = comDados.map((r) => ({
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
