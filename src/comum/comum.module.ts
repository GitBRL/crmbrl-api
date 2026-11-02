import { Global, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { CriptografiaService } from './criptografia/criptografia.service';
import { FiltroDeErros } from './erros/filtro-de-erros';

/**
 * Infraestrutura comum: criptografia (global) e o filtro global de erros. O
 * contexto da requisição é aberto pelos middlewares de `configurarAplicacao`.
 */
@Global()
@Module({
  providers: [
    CriptografiaService,
    { provide: APP_FILTER, useClass: FiltroDeErros },
  ],
  exports: [CriptografiaService],
})
export class ComumModule {}
