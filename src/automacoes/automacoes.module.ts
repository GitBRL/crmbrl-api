import { Module } from '@nestjs/common';

/**
 * Automações e cadências (R19, contrato da Onda B §2.5): `Automacao` com
 * gatilho (evento da outbox via `GatilhosService.registrarDestino`, ou agenda
 * via `registrarAgenda`), condições (`SegmentosService.contem`), ações em passos
 * (`PassosService.registrarTipo` com execuções AUTOMACAO, esperas = cadência),
 * critérios de parada, limite por entidade (`chaveDeLimite`), proteção contra
 * laços (`permiteEncadear`), histórico (`Execucao`/`ExecucaoPasso`) e modo teste.
 *
 * Esqueleto da base (`base-api-b`): o `automacoes-api` preenche.
 */
@Module({
  controllers: [],
  providers: [],
  exports: [],
})
export class AutomacoesModule {}
