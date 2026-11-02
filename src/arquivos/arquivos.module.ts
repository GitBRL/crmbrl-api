import { Global, Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { AMBIENTE, type Ambiente } from '../config/ambiente';
import { ArmazenamentoDaApi } from './armazenamento-multer';
import { ArquivosController } from './arquivos.controller';
import { ArquivosService } from './arquivos.service';
import {
  DRIVER_DE_ARQUIVOS,
  type DriverDeArquivos,
} from './drivers/driver-de-arquivos';
import { DriverMemoria } from './drivers/driver-memoria';
import { DriverS3 } from './drivers/driver-s3';
import { LIMITE_MAXIMO_BYTES } from './politica';

/** Limites do multer no upload HTTP; o limite fino de cada contexto é do `ArquivosService`. */
export const LIMITES_DO_UPLOAD = {
  fileSize: LIMITE_MAXIMO_BYTES,
  files: 1,
  fields: 5,
  fieldSize: 1024,
  parts: 6,
  headerPairs: 50,
} as const;

/** O driver de `ARQUIVOS_DRIVER`: S3/MinIO ou memória (testes). */
export function criarDriverDeArquivos(ambiente: Ambiente): DriverDeArquivos {
  return ambiente.arquivos.driver === 'memoria'
    ? new DriverMemoria()
    : new DriverS3(ambiente.arquivos);
}

/**
 * Arquivos (R11) — núcleo, global: `ArquivosService` e o driver. Serve à API e
 * ao processo do gateway de WhatsApp (que salva a mídia recebida). As rotas
 * HTTP ficam em `ArquivosHttpModule`, só na API.
 */
@Global()
@Module({
  providers: [
    {
      provide: DRIVER_DE_ARQUIVOS,
      inject: [AMBIENTE],
      useFactory: criarDriverDeArquivos,
    },
    ArquivosService,
  ],
  exports: [ArquivosService, DRIVER_DE_ARQUIVOS],
})
export class ArquivosModule {}

/**
 * Rotas de arquivos da API: `POST /api/v1/arquivos` (multipart, em streaming
 * para o bucket) e `GET /api/v1/arquivos/:id` (com permissão, `Range` e
 * cabeçalhos seguros).
 */
@Module({
  imports: [
    MulterModule.registerAsync({
      inject: [ArquivosService],
      useFactory: (arquivos: ArquivosService) => ({
        storage: new ArmazenamentoDaApi(arquivos),
        limits: LIMITES_DO_UPLOAD,
      }),
    }),
  ],
  controllers: [ArquivosController],
})
export class ArquivosHttpModule {}
