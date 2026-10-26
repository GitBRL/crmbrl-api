/**
 * Cabeçalho `Range` (RFC 9110 §14) do download de arquivos: o player de áudio e
 * vídeo do navegador pede pedaços (o Safari exige 206 para tocar).
 */

/** Faixa de bytes, com início e fim inclusivos. */
export interface FaixaDeBytes {
  readonly inicio: number;
  readonly fim: number;
}

export type ResultadoDaFaixa =
  /** Sem `Range` (ou com um formato que não tratamos): o arquivo inteiro, 200. */
  | { tipo: 'inteiro' }
  /** Uma faixa válida: 206 com `Content-Range`. */
  | { tipo: 'parcial'; faixa: FaixaDeBytes }
  /** Faixa fora do arquivo: 416 com `Content-Range: bytes *\/<tamanho>`. */
  | { tipo: 'invalida' };

/**
 * Interpreta `Range: bytes=…` para um arquivo de `tamanho` bytes. Só uma faixa é
 * atendida; várias faixas (multipart/byteranges) ou outra unidade devolvem o
 * arquivo inteiro, como a norma permite.
 */
export function interpretarFaixa(
  cabecalho: string | undefined,
  tamanho: number,
): ResultadoDaFaixa {
  if (!cabecalho) {
    return { tipo: 'inteiro' };
  }
  const encontrado = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(cabecalho);
  if (!encontrado) {
    return { tipo: 'inteiro' };
  }
  const [, inicioTexto, fimTexto] = encontrado;
  if (!inicioTexto && !fimTexto) {
    return { tipo: 'inteiro' };
  }
  if (tamanho === 0) {
    return { tipo: 'invalida' };
  }
  if (!inicioTexto) {
    // Sufixo: os últimos N bytes.
    const sufixo = Number(fimTexto);
    if (sufixo === 0) {
      return { tipo: 'invalida' };
    }
    return {
      tipo: 'parcial',
      faixa: { inicio: Math.max(0, tamanho - sufixo), fim: tamanho - 1 },
    };
  }
  const inicio = Number(inicioTexto);
  if (inicio >= tamanho) {
    return { tipo: 'invalida' };
  }
  const fim = fimTexto ? Math.min(Number(fimTexto), tamanho - 1) : tamanho - 1;
  if (fim < inicio) {
    return { tipo: 'invalida' };
  }
  return { tipo: 'parcial', faixa: { inicio, fim } };
}
