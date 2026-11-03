import { Module } from '@nestjs/common';
import { AtendimentoModule } from '../atendimento/atendimento.module';
import { CanaisComumModule } from '../canais/comum/canais-comum.module';
import { GraphApi } from '../canais/meta/graph-api';
import { WhatsappOficialModule } from '../canais/whatsapp-oficial/whatsapp-oficial.module';
import { ConfiguracaoDeLigacoesService } from './configuracao-ligacoes.service';
import { EventosDeLigacaoService } from './eventos-de-ligacao.service';
import { GraphLigacoes } from './graph-ligacoes';
import {
  ConfiguracaoLigacoesController,
  LigacoesController,
} from './ligacoes.controller';
import { HistoricoDeLigacoesService } from './historico-ligacoes.service';
import { LigacoesFeitasService } from './ligacoes-feitas.service';
import { LigacoesRecebidasService } from './ligacoes-recebidas.service';
import { LigacoesService } from './ligacoes.service';
import { PermissoesDeLigacaoService } from './permissoes-de-ligacao.service';
import { WebhookDeLigacoesService } from './webhook-ligacoes.service';

/**
 * Ligações pelo WhatsApp oficial (Onda E, R29): Calling API da Meta com o
 * navegador do atendente como ponto WebRTC (a API só sinaliza).
 *
 * - webhook `calls` (e a resposta de permissão, em `messages`) pelo roteamento
 *   por campo do canal oficial (E1): `WebhookDeLigacoesService`;
 * - máquina de estados e fechamento: `LigacoesService`;
 * - recebida (toque, atender, tempo esgotado): `LigacoesRecebidasService`;
 * - feita (permissão, connect, resposta SDP): `LigacoesFeitasService` e
 *   `PermissoesDeLigacaoService`;
 * - configuração por canal e liga/desliga na Meta: `ConfiguracaoDeLigacoesService`.
 */
@Module({
  imports: [AtendimentoModule, CanaisComumModule, WhatsappOficialModule],
  controllers: [LigacoesController, ConfiguracaoLigacoesController],
  providers: [
    GraphApi,
    GraphLigacoes,
    ConfiguracaoDeLigacoesService,
    PermissoesDeLigacaoService,
    LigacoesService,
    HistoricoDeLigacoesService,
    EventosDeLigacaoService,
    LigacoesRecebidasService,
    LigacoesFeitasService,
    WebhookDeLigacoesService,
  ],
  exports: [LigacoesService, ConfiguracaoDeLigacoesService],
})
export class LigacoesModule {}
