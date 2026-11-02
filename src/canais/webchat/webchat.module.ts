import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { ArquivosService } from '../../arquivos/arquivos.service';
import { AtendimentoModule } from '../../atendimento/atendimento.module';
import { ContatosModule } from '../../contatos/contatos.module';
import { CanaisComumModule } from '../comum/canais-comum.module';
import { ArmazenamentoDoVisitante } from './acesso-do-widget';
import { AdaptadorWebchat } from './adaptador-webchat';
import { WebchatCanaisController } from './webchat-canais.controller';
import { WebchatCanaisService } from './webchat-canais.service';
import { WebchatPublicoController } from './webchat-publico.controller';
import { WebchatTempoReal } from './webchat-tempo-real';
import { WebchatGateway } from './webchat.gateway';
import {
  TAMANHO_MAXIMO_ANEXO_VISITANTE,
  WebchatService,
} from './webchat.service';
import { WidgetDoSite } from './widget.service';

/** Núcleo do chat do site: o serviço do visitante e o namespace `/webchat` (também usados pelo upload). */
@Module({
  imports: [AtendimentoModule, ContatosModule, CanaisComumModule],
  providers: [WebchatService, WebchatTempoReal],
  exports: [WebchatService, WebchatTempoReal, CanaisComumModule],
})
export class WebchatNucleoModule {}

/**
 * Chat do site (§2.5, R14):
 *
 * - rotas públicas do widget em `/api/v1/publico/webchat/...` (token anônimo
 *   do visitante, limite de requisições, CORS pelos domínios do canal) e o
 *   próprio widget em `/api/v1/publico/webchat/widget.js`;
 * - namespace Socket.IO `/webchat` dos visitantes (mensagens, "digitando",
 *   lidas);
 * - `AdaptadorWebchat` (envio da equipe ao visitante) e a configuração dos
 *   canais pelo Admin em `/api/v1/webchat/canais`.
 */
@Module({
  imports: [
    AtendimentoModule,
    WebchatNucleoModule,
    MulterModule.registerAsync({
      imports: [WebchatNucleoModule],
      inject: [ArquivosService, WebchatService],
      useFactory: (arquivos: ArquivosService, webchat: WebchatService) => ({
        storage: new ArmazenamentoDoVisitante(arquivos, webchat),
        limits: {
          fileSize: TAMANHO_MAXIMO_ANEXO_VISITANTE,
          files: 1,
          fields: 4,
          fieldSize: 8 * 1024,
          parts: 5,
          headerPairs: 50,
        },
      }),
    }),
  ],
  controllers: [WebchatPublicoController, WebchatCanaisController],
  providers: [
    AdaptadorWebchat,
    WebchatGateway,
    WebchatCanaisService,
    WidgetDoSite,
  ],
  exports: [WebchatNucleoModule],
})
export class WebchatModule {}
