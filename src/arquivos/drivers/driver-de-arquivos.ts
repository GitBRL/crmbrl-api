import type { Readable } from 'node:stream';
import type { FaixaDeBytes } from '../faixa';

/** Token de injeção do driver em uso (`ARQUIVOS_DRIVER`). */
export const DRIVER_DE_ARQUIVOS = Symbol('DRIVER_DE_ARQUIVOS');

/**
 * Onde o conteúdo dos arquivos fica guardado. O `ArquivosService` cuida da
 * política (tipos, limites, hash) e do registro no banco; o driver só guarda,
 * lê e apaga bytes por chave.
 *
 * - `DriverS3`: MinIO do compose (ou qualquer S3), envio em partes acima de 8 MB.
 * - `DriverMemoria`: um `Map` no processo, para os testes (sem MinIO).
 */
export interface DriverDeArquivos {
  readonly nome: 's3' | 'memoria';
  /** Garante que o bucket existe. Pode lançar se o serviço estiver fora do ar. */
  preparar(): Promise<void>;
  /**
   * Grava o conteúdo, lido de `partes`. Se a leitura lançar (limite estourado,
   * conteúdo recusado), nada fica gravado.
   */
  gravar(
    chave: string,
    partes: AsyncIterable<Buffer>,
    meta: { mime: string },
  ): Promise<void>;
  /** Abre o conteúdo (ou só a faixa pedida). Lança se a chave não existir. */
  abrir(chave: string, faixa?: FaixaDeBytes): Promise<Readable>;
  /** Apaga o conteúdo (não falha se a chave já não existir). */
  remover(chave: string): Promise<void>;
}

/** O conteúdo não existe mais no armazenamento. */
export class ConteudoNaoEncontradoError extends Error {
  constructor(chave: string) {
    super(`Conteúdo não encontrado no armazenamento: ${chave}`);
    this.name = 'ConteudoNaoEncontradoError';
  }
}
