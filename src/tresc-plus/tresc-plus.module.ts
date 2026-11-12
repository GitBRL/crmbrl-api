import { Module } from '@nestjs/common';
import { TranscricaoModule } from '../transcricao/transcricao.module';
import { AgenteTrescPlusService } from './agente.service';
import { ConexaoTrescPlusService } from './conexao.service';
import { DiscadorTrescPlusService } from './discador.service';
import { LigacoesTrescService } from './ligacoes-tresc.service';
import {
  FABRICA_DE_SOCKET_TRESC_PLUS,
  FABRICA_REAL,
  OuvinteDeEventosTrescPlus,
} from './ouvinte-eventos.service';
import { ReconciliacaoTrescPlusService } from './reconciliacao.service';
import {
  AgenteTrescPlusController,
  ConexaoTrescPlusController,
  DiscadorTrescPlusController,
  VinculoTrescPlusController,
} from './tresc-plus.controller';
import { VinculosTrescPlusService } from './vinculos.service';

/**
 * Ligações pelo 3C+ (Onda T, R34): conexão da empresa, vínculo dos vendedores, cliente HTTP, ouvinte
 * de eventos (socket.io-client), reconciliação por `GET /calls`, registro das ligações na mesma
 * tabela do WhatsApp, agente/ligar/qualificar e envio ao discador.
 *
 * Não importa `FunisModule` (o envio ao discador é chamado pelo `NegociosEmMassaService`).
 */
@Module({
  imports: [TranscricaoModule],
  controllers: [
    ConexaoTrescPlusController,
    VinculoTrescPlusController,
    AgenteTrescPlusController,
    DiscadorTrescPlusController,
  ],
  providers: [
    ConexaoTrescPlusService,
    VinculosTrescPlusService,
    LigacoesTrescService,
    AgenteTrescPlusService,
    DiscadorTrescPlusService,
    ReconciliacaoTrescPlusService,
    OuvinteDeEventosTrescPlus,
    { provide: FABRICA_DE_SOCKET_TRESC_PLUS, useValue: FABRICA_REAL },
  ],
  exports: [DiscadorTrescPlusService, ConexaoTrescPlusService],
})
export class TrescPlusModule {}
