import { Readable } from 'node:stream';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import type { ConfiguracaoArquivos } from '../../config/ambiente';
import type { FaixaDeBytes } from '../faixa';
import {
  ConteudoNaoEncontradoError,
  type DriverDeArquivos,
} from './driver-de-arquivos';

/** Tamanho de cada parte do envio em partes (o mínimo do S3 é 5 MB). */
export const TAMANHO_DA_PARTE = 8 * 1024 * 1024;

/**
 * Arquivos no MinIO do compose (ou em qualquer serviço compatível com S3), com
 * `@aws-sdk/client-s3`:
 *
 * - até 8 MB, um `PutObject`; acima disso, envio em partes de 8 MB — a memória
 *   usada por envio fica em uma parte, qualquer que seja o tamanho do arquivo;
 * - se a leitura falhar no meio (limite estourado, conteúdo recusado), o envio
 *   em partes é abortado e nada fica no bucket;
 * - `forcePathStyle` (o MinIO não usa subdomínio por bucket) e checksums só
 *   quando o serviço exige (`WHEN_REQUIRED`), para funcionar com o MinIO.
 */
export class DriverS3 implements DriverDeArquivos {
  readonly nome = 's3' as const;
  private readonly cliente: S3Client;
  private readonly bucket: string;

  constructor(configuracao: ConfiguracaoArquivos) {
    this.bucket = configuracao.bucket;
    this.cliente = new S3Client({
      region: configuracao.regiao,
      ...(configuracao.endpoint ? { endpoint: configuracao.endpoint } : {}),
      forcePathStyle: true,
      ...(configuracao.chave && configuracao.segredo
        ? {
            credentials: {
              accessKeyId: configuracao.chave,
              secretAccessKey: configuracao.segredo,
            },
          }
        : {}),
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      maxAttempts: 3,
    });
  }

  async preparar(): Promise<void> {
    try {
      await this.cliente.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch (erro) {
      if (!ehNaoEncontrado(erro)) {
        throw erro;
      }
      try {
        await this.cliente.send(
          new CreateBucketCommand({ Bucket: this.bucket }),
        );
      } catch (erroAoCriar) {
        // Outra réplica (ou o gateway) pode ter criado ao mesmo tempo.
        const nome = (erroAoCriar as { name?: string }).name;
        if (
          nome !== 'BucketAlreadyOwnedByYou' &&
          nome !== 'BucketAlreadyExists'
        ) {
          throw erroAoCriar;
        }
      }
    }
  }

  async gravar(
    chave: string,
    partes: AsyncIterable<Buffer>,
    meta: { mime: string },
  ): Promise<void> {
    const iterador = juntarEmPartes(partes, TAMANHO_DA_PARTE)[
      Symbol.asyncIterator
    ]();
    const primeira = await iterador.next();
    const conteudoInicial = primeira.done ? Buffer.alloc(0) : primeira.value;
    const segunda = primeira.done ? primeira : await iterador.next();
    if (segunda.done) {
      await this.cliente.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: chave,
          Body: conteudoInicial,
          ContentLength: conteudoInicial.length,
          ContentType: meta.mime,
        }),
      );
      return;
    }
    const { UploadId } = await this.cliente.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: chave,
        ContentType: meta.mime,
      }),
    );
    const enviadas: { ETag: string; PartNumber: number }[] = [];
    try {
      let numero = 1;
      let atual: IteratorResult<Buffer> = segunda;
      enviadas.push(
        await this.enviarParte(chave, UploadId, numero, conteudoInicial),
      );
      while (!atual.done) {
        numero += 1;
        enviadas.push(
          await this.enviarParte(chave, UploadId, numero, atual.value),
        );
        atual = await iterador.next();
      }
      await this.cliente.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.bucket,
          Key: chave,
          UploadId,
          MultipartUpload: { Parts: enviadas },
        }),
      );
    } catch (erro) {
      await this.cliente
        .send(
          new AbortMultipartUploadCommand({
            Bucket: this.bucket,
            Key: chave,
            UploadId,
          }),
        )
        .catch(() => undefined);
      throw erro;
    }
  }

  async abrir(chave: string, faixa?: FaixaDeBytes): Promise<Readable> {
    try {
      const resposta = await this.cliente.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: chave,
          ...(faixa ? { Range: `bytes=${faixa.inicio}-${faixa.fim}` } : {}),
        }),
      );
      const corpo = resposta.Body;
      if (corpo instanceof Readable) {
        return corpo;
      }
      if (!corpo) {
        return Readable.from([]);
      }
      return Readable.from([Buffer.from(await corpo.transformToByteArray())]);
    } catch (erro) {
      if (ehNaoEncontrado(erro)) {
        throw new ConteudoNaoEncontradoError(chave);
      }
      throw erro;
    }
  }

  async remover(chave: string): Promise<void> {
    await this.cliente.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: chave }),
    );
  }

  private async enviarParte(
    chave: string,
    uploadId: string | undefined,
    numero: number,
    conteudo: Buffer,
  ): Promise<{ ETag: string; PartNumber: number }> {
    const { ETag } = await this.cliente.send(
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: chave,
        UploadId: uploadId,
        PartNumber: numero,
        Body: conteudo,
        ContentLength: conteudo.length,
      }),
    );
    return { ETag: ETag ?? '', PartNumber: numero };
  }
}

/** Reagrupa os pedaços lidos em blocos de `tamanho` bytes (o último pode ser menor). */
async function* juntarEmPartes(
  pedacos: AsyncIterable<Buffer>,
  tamanho: number,
): AsyncGenerator<Buffer> {
  let acumulado: Buffer[] = [];
  let bytes = 0;
  for await (const pedaco of pedacos) {
    let resto = pedaco;
    while (bytes + resto.length >= tamanho) {
      const falta = tamanho - bytes;
      acumulado.push(resto.subarray(0, falta));
      yield Buffer.concat(acumulado);
      acumulado = [];
      bytes = 0;
      resto = resto.subarray(falta);
    }
    if (resto.length > 0) {
      acumulado.push(resto);
      bytes += resto.length;
    }
  }
  if (bytes > 0) {
    yield Buffer.concat(acumulado);
  }
}

function ehNaoEncontrado(erro: unknown): boolean {
  const nome = (erro as { name?: string } | null)?.name;
  const status = (erro as { $metadata?: { httpStatusCode?: number } } | null)
    ?.$metadata?.httpStatusCode;
  return (
    nome === 'NotFound' ||
    nome === 'NoSuchKey' ||
    nome === 'NoSuchBucket' ||
    status === 404
  );
}
