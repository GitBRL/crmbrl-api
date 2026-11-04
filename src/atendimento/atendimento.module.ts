import { Module } from '@nestjs/common';
import { ContatosModule } from '../contatos/contatos.module';
import { FunisModule } from '../funis/funis.module';
import { AcessoAtendimentoService } from './acesso-atendimento.service';
import { AtendimentoService } from './atendimento.service';
import { AvisoDeMensagem } from './aviso-de-mensagem.service';
import { CanaisDoAtendimentoService } from './canais-atendimento.service';
import {
  CanaisDoAtendimentoController,
  FilasController,
  MetricasDoAtendimentoController,
  RespostasRapidasController,
} from './configuracao.controller';
import { ContagensDoAtendimento } from './contagens.service';
import { ConversasController } from './conversas.controller';
import { ConversasService } from './conversas.service';
import { DesligamentoNoAtendimento } from './desligamento-atendimento.service';
import { DistribuicaoDaFila } from './distribuicao-fila.service';
import { EnvioDoAtendimento } from './envio.service';
import { FilasService } from './filas.service';
import { GanchosDoAtendimento } from './ganchos-do-atendimento';
import { MensagensService } from './mensagens.service';
import { MetricasDoAtendimentoService } from './metricas-atendimento.service';
import { MotorDoAtendimento } from './motor-do-atendimento.service';
import { RespostasRapidasService } from './respostas-rapidas.service';
import { SlaDoAtendimento } from './sla.service';

/**
 * Atendimento omnichannel (§2.4, R12).
 *
 * - Entrada dos canais: `AtendimentoService.receber(...)`, `atualizarStatus(...)`
 *   e `avaliar(...)` (exportados; os módulos de canal importam este módulo).
 * - Saída: `MotorDoAtendimento.criarSaida` grava a mensagem `PENDENTE` e o job
 *   `atendimento.enviar`; o `EnvioDoAtendimento` entrega ao adaptador do canal
 *   pelo `RegistroCanais`.
 * - Distribuição pela fila (`DistribuicaoDaFila`), SLA com aviso ao líder
 *   (`SlaDoAtendimento`, job a cada minuto), horário de atendimento,
 *   pesquisa de satisfação, desligamento (R7), contagem do menu
 *   (`ContagensDoAtendimento`) e as rotas em `/atendimento/...`.
 * - Visibilidade em `visibilidade.ts`, usada também pelo tempo real e pelos
 *   arquivos (`AcessoAtendimentoService`).
 */
@Module({
  imports: [ContatosModule, FunisModule],
  controllers: [
    ConversasController,
    FilasController,
    RespostasRapidasController,
    CanaisDoAtendimentoController,
    MetricasDoAtendimentoController,
  ],
  providers: [
    AtendimentoService,
    AcessoAtendimentoService,
    GanchosDoAtendimento,
    MotorDoAtendimento,
    DistribuicaoDaFila,
    ConversasService,
    MensagensService,
    EnvioDoAtendimento,
    SlaDoAtendimento,
    ContagensDoAtendimento,
    DesligamentoNoAtendimento,
    AvisoDeMensagem,
    FilasService,
    RespostasRapidasService,
    CanaisDoAtendimentoService,
    MetricasDoAtendimentoService,
  ],
  exports: [
    AtendimentoService,
    AcessoAtendimentoService,
    GanchosDoAtendimento,
    MensagensService,
    ConversasService,
    MotorDoAtendimento,
    DistribuicaoDaFila,
  ],
})
export class AtendimentoModule {}
