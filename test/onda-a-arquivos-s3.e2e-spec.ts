import { randomBytes } from 'node:crypto';
import type request from 'supertest';
import {
  ArquivosService,
  FILA_APAGAR_CONTEUDO,
} from '../src/arquivos/arquivos.service';
import { TAMANHO_DA_PARTE } from '../src/arquivos/drivers/driver-s3';
import {
  type AppTeste,
  criarAppTeste,
  criarUsuario,
  drenarFilas,
  entrarComo,
  PDF_DE_TESTE,
} from './utils';

/**
 * Driver S3 contra um MinIO de verdade (R11). Só roda com
 * `ARQUIVOS_TESTE_S3_ENDPOINT` (e, se preciso, `ARQUIVOS_TESTE_S3_CHAVE`,
 * `ARQUIVOS_TESTE_S3_SEGREDO`) — por exemplo, com um MinIO descartável:
 *
 * ```bash
 * docker run -d --rm --name minio-teste -p 127.0.0.1:55463:9000 \
 *   -e MINIO_ROOT_USER=teste -e MINIO_ROOT_PASSWORD=teste-minio-123 \
 *   bitnamilegacy/minio:2025.7.23-debian-12-r5
 * ARQUIVOS_TESTE_S3_ENDPOINT=http://127.0.0.1:55463 ARQUIVOS_TESTE_S3_CHAVE=teste \
 *   ARQUIVOS_TESTE_S3_SEGREDO=teste-minio-123 bun run test:e2e test/onda-a-arquivos-s3
 * ```
 */
const endpoint = process.env.ARQUIVOS_TESTE_S3_ENDPOINT;

function binario(
  resposta: request.Response,
  callback: (erro: Error | null, corpo: Buffer) => void,
): void {
  const pedacos: Buffer[] = [];
  resposta.on('data', (pedaco: Buffer) => pedacos.push(pedaco));
  resposta.on('end', () => callback(null, Buffer.concat(pedacos)));
}

(endpoint ? describe : describe.skip)(
  'Arquivos no MinIO (e2e, driver s3)',
  () => {
    let t: AppTeste;

    beforeAll(async () => {
      t = await criarAppTeste({
        variaveis: {
          ARQUIVOS_DRIVER: 's3',
          ARQUIVOS_ENDPOINT: endpoint,
          ARQUIVOS_CHAVE: process.env.ARQUIVOS_TESTE_S3_CHAVE ?? 'teste',
          ARQUIVOS_SEGREDO:
            process.env.ARQUIVOS_TESTE_S3_SEGREDO ?? 'teste-minio-123',
          ARQUIVOS_BUCKET: `crmbrl-teste-${Date.now()}`,
        },
      });
    });
    beforeEach(() => t.limparBanco());
    afterAll(() => t?.fechar());

    it('cria o bucket ao subir, guarda (inclusive em partes acima de 8 MB), lê faixas e apaga', async () => {
      expect(t.get(ArquivosService).armazenamentoPronto).toBe(true);
      const usuario = await criarUsuario(t);
      const cliente = await entrarComo(t, usuario);

      const pequeno = await cliente
        .post('/api/v1/arquivos?contexto=OUTRO')
        .attach('arquivo', PDF_DE_TESTE, {
          filename: 'a.pdf',
          contentType: 'application/pdf',
        })
        .expect(201);
      const baixado = await cliente
        .get(pequeno.body.url as string)
        .buffer(true)
        .parse(binario)
        .expect(200);
      expect(baixado.body).toEqual(PDF_DE_TESTE);

      // Acima de uma parte: envio em partes (multipart upload).
      const grande = Buffer.concat([
        Buffer.from('%PDF-1.4\n'),
        randomBytes(TAMANHO_DA_PARTE + 1024 * 1024),
      ]);
      const enviado = await cliente
        .post('/api/v1/arquivos?contexto=OUTRO')
        .attach('arquivo', grande, {
          filename: 'grande.pdf',
          contentType: 'application/pdf',
        })
        .expect(201);
      expect(enviado.body.tamanho).toBe(grande.length);
      const faixa = await cliente
        .get(enviado.body.url as string)
        .set('Range', `bytes=${TAMANHO_DA_PARTE - 2}-${TAMANHO_DA_PARTE + 1}`)
        .buffer(true)
        .parse(binario)
        .expect(206);
      expect(faixa.body).toEqual(
        grande.subarray(TAMANHO_DA_PARTE - 2, TAMANHO_DA_PARTE + 2),
      );

      // Conteúdo recusado no meio do envio não deixa nada no bucket.
      await cliente
        .post('/api/v1/arquivos?contexto=AVATAR')
        .attach('arquivo', Buffer.alloc(6 * 1024 * 1024), {
          filename: 'grande.png',
          contentType: 'image/png',
        })
        .expect(415);

      const arquivos = t.get(ArquivosService);
      await arquivos.remover(enviado.body.id as string);
      expect(await drenarFilas(t, FILA_APAGAR_CONTEUDO)).toBe(1);
      const registro = await t.prisma.arquivo.findUniqueOrThrow({
        where: { id: enviado.body.id as string },
      });
      await expect(arquivos.abrirConteudo(registro)).rejects.toMatchObject({
        status: 404,
      });
    });
  },
);
