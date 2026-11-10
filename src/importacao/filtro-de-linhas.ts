/**
 * Filtro da planilha (R16.11): decide, linha a linha, se a linha entra na
 * importação. Funções puras; a regra olha qualquer coluna do arquivo, mesmo
 * as que não estão mapeadas.
 */

export const OPERADORES_DO_FILTRO = [
  'IGUAL',
  'DIFERENTE',
  'CONTEM',
  'NAO_CONTEM',
  'COMECA_COM',
  'TERMINA_COM',
  'UM_DE',
  'VAZIO',
  'PREENCHIDO',
  'MAIOR_QUE',
  'MENOR_QUE',
] as const;
export type OperadorFiltro = (typeof OPERADORES_DO_FILTRO)[number];

export interface RegraDoFiltro {
  coluna: string;
  operador: OperadorFiltro;
  valor?: string | null;
}

export interface FiltroDaPlanilha {
  combinacao: 'TODAS' | 'QUALQUER';
  regras: RegraDoFiltro[];
}

export const MAXIMO_DE_REGRAS_DO_FILTRO = 10;

/** Operadores que dispensam o `valor`. */
export const OPERADORES_SEM_VALOR: readonly OperadorFiltro[] = [
  'VAZIO',
  'PREENCHIDO',
];

/** Aparar, juntar espaços, sem acento e sem caixa. */
export function normalizarTextoDoFiltro(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** `dd/mm/aaaa` ou `aaaa-mm-dd` (data do XLSX) como dia absoluto; `null` se não for data. */
export function lerDataDoFiltro(texto: string): number | null {
  const t = texto.trim();
  let dia: number;
  let mes: number;
  let ano: number;
  let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
  if (m) {
    [dia, mes, ano] = [Number(m[1]), Number(m[2]), Number(m[3])];
  } else {
    m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/.exec(t);
    if (!m) {
      return null;
    }
    [ano, mes, dia] = [Number(m[1]), Number(m[2]), Number(m[3])];
  }
  const data = new Date(Date.UTC(ano, mes - 1, dia));
  if (
    data.getUTCFullYear() !== ano ||
    data.getUTCMonth() !== mes - 1 ||
    data.getUTCDate() !== dia
  ) {
    return null;
  }
  return data.getTime();
}

/**
 * Número em `1.234,56`, `1234.56`, `1234,56`, `R$ 1.234,56`. Com um só tipo de
 * separador e três dígitos depois dele (`1.234`), vale o milhar brasileiro.
 */
export function lerNumeroDoFiltro(texto: string): number | null {
  let t = texto
    .trim()
    .replace(/^R\$\s*/i, '')
    .replace(/\s+/g, '');
  if (!/^-?[\d.,]+$/.test(t) || !/\d/.test(t)) {
    return null;
  }
  const virgula = t.lastIndexOf(',');
  const ponto = t.lastIndexOf('.');
  if (virgula >= 0 && ponto >= 0) {
    const decimal = virgula > ponto ? ',' : '.';
    const milhar = decimal === ',' ? '.' : ',';
    t = t.split(milhar).join('').replace(decimal, '.');
  } else if (virgula >= 0) {
    if (t.split(',').length > 2) {
      return null;
    }
    t = t.replace(',', '.');
  } else if (ponto >= 0) {
    const partes = t.split('.');
    if (
      partes.length > 2 ||
      (/^-?\d{1,3}\.\d{3}$/.test(t) && !/^-?0\./.test(t))
    ) {
      t = partes.join('');
    }
  }
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function comparar(
  celula: string,
  valor: string,
  operador: 'MAIOR_QUE' | 'MENOR_QUE',
): boolean {
  const dc = lerDataDoFiltro(celula);
  const dv = lerDataDoFiltro(valor);
  let a: number | null;
  let b: number | null;
  if (dc !== null && dv !== null) {
    [a, b] = [dc, dv];
  } else {
    [a, b] = [lerNumeroDoFiltro(celula), lerNumeroDoFiltro(valor)];
  }
  if (a === null || b === null) {
    return false;
  }
  return operador === 'MAIOR_QUE' ? a > b : a < b;
}

/** A célula atende à regra? */
export function celulaPassaNaRegra(
  celula: string,
  operador: OperadorFiltro,
  valor: string | null | undefined,
): boolean {
  const vazia = celula.trim() === '';
  if (operador === 'VAZIO') {
    return vazia;
  }
  if (operador === 'PREENCHIDO') {
    return !vazia;
  }
  const alvo = valor ?? '';
  if (operador === 'MAIOR_QUE' || operador === 'MENOR_QUE') {
    return comparar(celula, alvo, operador);
  }
  const texto = normalizarTextoDoFiltro(celula);
  const v = normalizarTextoDoFiltro(alvo);
  switch (operador) {
    case 'IGUAL':
      return texto === v;
    case 'DIFERENTE':
      return texto !== v;
    case 'CONTEM':
      return texto.includes(v);
    case 'NAO_CONTEM':
      return !texto.includes(v);
    case 'COMECA_COM':
      return texto.startsWith(v);
    case 'TERMINA_COM':
      return texto.endsWith(v);
    case 'UM_DE':
      return alvo
        .split(/[,;]/)
        .map(normalizarTextoDoFiltro)
        .filter((item) => item !== '')
        .includes(texto);
  }
}

/**
 * Prepara o filtro para as colunas do arquivo e devolve o teste de uma linha
 * (valores na ordem das colunas). Regra de coluna que não existe é falsa.
 */
export function compilarFiltro(
  filtro: FiltroDaPlanilha | null | undefined,
  colunas: readonly string[],
): (valores: readonly string[]) => boolean {
  if (!filtro || filtro.regras.length === 0) {
    return () => true;
  }
  const regras = filtro.regras.map((r) => ({
    indice: colunas.indexOf(r.coluna),
    operador: r.operador,
    valor: r.valor,
  }));
  return (valores) => {
    const passa = (r: (typeof regras)[number]) =>
      r.indice >= 0 &&
      celulaPassaNaRegra(valores[r.indice] ?? '', r.operador, r.valor);
    return filtro.combinacao === 'QUALQUER'
      ? regras.some(passa)
      : regras.every(passa);
  };
}

/** Valor em reais da planilha (`R$ 1.234,56`) como texto decimal `"1234.56"`; `null` se não for número ≥ 0 com até 12 inteiros. */
export function valorEmReais(texto: string): string | null {
  const n = lerNumeroDoFiltro(texto);
  if (n === null || n < 0 || n >= 1e12) {
    return null;
  }
  return n.toFixed(2);
}
