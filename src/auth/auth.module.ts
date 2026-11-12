import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { LimitadorDeRequisicoes } from '../canais/comum/limitador';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { DoisFatoresController } from './dois-fatores/dois-fatores.controller';
import { DoisFatoresService } from './dois-fatores/dois-fatores.service';
import { ForcaBrutaService } from './forca-bruta.service';
import { OrigemGuard } from './guards/origem.guard';
import { PapeisGuard } from './guards/papeis.guard';
import { SessaoGuard } from './guards/sessao.guard';
import { SenhasService } from './senhas.service';
import { SessoesService } from './sessoes.service';

/**
 * Autenticação (R2). Registra os guards globais, nesta ordem:
 * `OrigemGuard` (CSRF, R2.9) → `SessaoGuard` (sessão, R2.2/R2.4/R2.7) →
 * `PapeisGuard` (`@Papeis`).
 *
 * Global: `SessoesService` (revogar sessões no desligamento), `SenhasService`
 * (convite e senha temporária) e `AuthService` podem ser injetados em qualquer
 * módulo sem importar este.
 */
@Global()
@Module({
  controllers: [AuthController, DoisFatoresController],
  providers: [
    AuthService,
    SessoesService,
    ForcaBrutaService,
    SenhasService,
    DoisFatoresService,
    // Limite das rotas públicas de senha (instância própria: contagem separada dos canais).
    LimitadorDeRequisicoes,
    { provide: APP_GUARD, useClass: OrigemGuard },
    { provide: APP_GUARD, useClass: SessaoGuard },
    { provide: APP_GUARD, useClass: PapeisGuard },
  ],
  exports: [AuthService, SessoesService, SenhasService, DoisFatoresService],
})
export class AuthModule {}
