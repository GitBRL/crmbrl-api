import { Module } from '@nestjs/common';
import { AtendimentoModule } from '../atendimento/atendimento.module';
import { AtividadesModule } from '../atividades/atividades.module';
import { ContatosModule } from '../contatos/contatos.module';
import { EmailModule } from '../email/email.module';
import { FunisModule } from '../funis/funis.module';
import { NotificacoesModule } from '../notificacoes/notificacoes.module';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { AcoesDeAutomacao } from './acoes-de-automacao.service';
import { AgendasDeAutomacao } from './agendas-de-automacao.service';
import { AutomacoesController } from './automacoes.controller';
import { AutomacoesService } from './automacoes.service';
import { EnvioDeMensagemDaAutomacao } from './envio-de-mensagem-da-automacao.service';
import { ExecucoesDeAutomacao } from './execucoes-de-automacao.service';
import { GatilhosDeAutomacao } from './gatilhos-de-automacao.service';
import { IniciadorDeExecucao } from './iniciador-de-execucao.service';

/**
 * Automações e cadências (R19, contrato da Onda B §2.5): `Automacao` com
 * gatilho (evento da outbox via `GatilhosService.registrarDestino`, ou agenda
 * via `registrarAgenda`), condições (`SegmentosService.contem`), ações em passos
 * (`PassosService.registrarTipo` com execuções AUTOMACAO, esperas = cadência),
 * critérios de parada, limite por entidade (`chaveDeLimite`), proteção contra
 * laços (`permiteEncadear`), histórico (`Execucao`/`ExecucaoPasso`) e modo teste.
 *
 * Rotas em `/api/v1/automacoes`. As ações passam pelos serviços de domínio
 * (contatos, funis, atividades, atendimento, notificações, webhooks de saída)
 * com o ator AUTOMACAO.
 */
@Module({
  imports: [
    AtendimentoModule,
    AtividadesModule,
    ContatosModule,
    EmailModule,
    FunisModule,
    NotificacoesModule,
    WebhooksModule,
  ],
  controllers: [AutomacoesController],
  providers: [
    AcoesDeAutomacao,
    AgendasDeAutomacao,
    AutomacoesService,
    EnvioDeMensagemDaAutomacao,
    ExecucoesDeAutomacao,
    GatilhosDeAutomacao,
    IniciadorDeExecucao,
  ],
  exports: [AutomacoesService],
})
export class AutomacoesModule {}
