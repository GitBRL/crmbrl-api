import { Readable } from 'node:stream';
import type { FaixaDeBytes } from '../faixa';
import {
  ConteudoNaoEncontradoError,
  type DriverDeArquivos,
} from './driver-de-arquivos';

interface ObjetoGuardado {
  readonly conteudo: Buffer;
  readonly mime: string;
}

/**
 * Arquivos num `Map` do processo (`ARQUIVOS_DRIVER=memoria`): para os testes,
 * que assim não precisam de MinIO. Some quando o processo para — nunca use em
 * produção (a inicialização avisa).
 *
 * Nos testes de integração: `t.arquivos` (este driver) tem `quantidade`,
 * `conteudoDe(chave)` e `limpar()`.
 */
export class DriverMemoria implements DriverDeArquivos {
  readonly nome = 'memoria' as const;
  private readonly objetos = new Map<string, ObjetoGuardado>();

  preparar(): Promise<void> {
    return Promise.resolve();
  }

  async gravar(
    chave: string,
    partes: AsyncIterable<Buffer>,
    meta: { mime: string },
  ): Promise<void> {
    const pedacos: Buffer[] = [];
    for await (const parte of partes) {
      pedacos.push(parte);
    }
    this.objetos.set(chave, {
      conteudo: Buffer.concat(pedacos),
      mime: meta.mime,
    });
  }

  abrir(chave: string, faixa?: FaixaDeBytes): Promise<Readable> {
    const objeto = this.objetos.get(chave);
    if (!objeto) {
      return Promise.reject(new ConteudoNaoEncontradoError(chave));
    }
    const conteudo = faixa
      ? objeto.conteudo.subarray(faixa.inicio, faixa.fim + 1)
      : objeto.conteudo;
    return Promise.resolve(Readable.from([conteudo]));
  }

  remover(chave: string): Promise<void> {
    this.objetos.delete(chave);
    return Promise.resolve();
  }

  /** Quantos objetos estão guardados (testes). */
  get quantidade(): number {
    return this.objetos.size;
  }

  /** O conteúdo guardado numa chave (testes). */
  conteudoDe(chave: string): Buffer | undefined {
    return this.objetos.get(chave)?.conteudo;
  }

  /** Apaga tudo (testes). */
  limpar(): void {
    this.objetos.clear();
  }
}
