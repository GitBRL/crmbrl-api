import { Module } from '@nestjs/common';
import { ContatosController } from './contatos.controller';
import { ContatosService } from './contatos.service';
import { EmpresasController } from './empresas.controller';
import { EmpresasService } from './empresas.service';
import { LinhaDoTempoService } from './linha-do-tempo.service';
import { PermissoesContatosService } from './permissoes-contatos.service';

/**
 * Contatos e empresas (R4), linha do tempo (R3.5) e
 * `ContatosService.encontrarOuCriar` (deduplicação R4.2, usada por webhooks e
 * passagens — contrato §5).
 *
 * Exporta `ContatosService` (com `encontrarOuCriar` e
 * `definirResponsavelSeVazio`), `EmpresasService` e `LinhaDoTempoService` (a
 * linha do tempo do negócio, no módulo de funis, usa a mesma); quem consome
 * importa este módulo.
 */
@Module({
  controllers: [ContatosController, EmpresasController],
  providers: [
    ContatosService,
    EmpresasService,
    LinhaDoTempoService,
    PermissoesContatosService,
  ],
  exports: [
    ContatosService,
    EmpresasService,
    LinhaDoTempoService,
    PermissoesContatosService,
  ],
})
export class ContatosModule {}
