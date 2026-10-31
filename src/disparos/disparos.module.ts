import { Module } from '@nestjs/common';
import { AtendimentoModule } from '../atendimento/atendimento.module';
import { WhatsappCanalModule } from '../canais/whatsapp/whatsapp-canal.module';
import { ContatosModule } from '../contatos/contatos.module';
import { AcessoDisparos } from './acesso-disparos.service';
import { AgendadorDeEnvio } from './agendador-de-envio.service';
import { CampanhasService } from './campanhas.service';
import { CanaisDaCampanha } from './canais-da-campanha.service';
import { CicloDaCampanha } from './ciclo-da-campanha.service';
import { ConfiguracaoDisparosService } from './configuracao-disparos.service';
import { DisparosController } from './disparos.controller';
import { EntregaDeCampanha } from './entrega-de-campanha.service';
import { EnvioDeCampanha } from './envio-de-campanha.service';
import { ModelosMensagemController } from './modelos-mensagem.controller';
import { ModelosMensagemService } from './modelos-mensagem.service';
import { ProgressoDaCampanha } from './progresso-da-campanha.service';
import { PublicoDaCampanha } from './publico.service';
import { RelatorioDeCampanha } from './relatorio-de-campanha.service';
import { RespostasDeCampanha } from './respostas-de-campanha.service';
import { SincronizacaoDaCampanha } from './sincronizacao-da-campanha.service';

/**
 * Disparos (R17, contrato da Onda B §2.3): campanhas com público por segmento
 * (`SegmentosService`) ou lista importada, mensagem por modelo (`ModelosService`,
 * semente = id do destinatário), rodízio de números, ritmo anti-banimento, janela
 * de envio, respostas e opt-out pelos gatilhos (`GatilhosService.registrarDestino`),
 * relatório e exportação. Também o CRUD de `ModeloMensagem` (`/modelos-mensagem`)
 * e a configuração `disparos` (`/disparos/configuracao`).
 *
 * Envio: `EnvioDeCampanha` (fila `disparos.enviar`, uma mensagem por rodada) →
 * `EntregaDeCampanha` (`MotorDoAtendimento.criarSaida`, o mesmo caminho do
 * Atendimento) → adaptador do canal → gateway. Ciclo de vida: `CicloDaCampanha`.
 */
@Module({
  imports: [AtendimentoModule, WhatsappCanalModule, ContatosModule],
  controllers: [DisparosController, ModelosMensagemController],
  providers: [
    AcessoDisparos,
    AgendadorDeEnvio,
    CampanhasService,
    CanaisDaCampanha,
    CicloDaCampanha,
    ConfiguracaoDisparosService,
    EntregaDeCampanha,
    EnvioDeCampanha,
    ModelosMensagemService,
    ProgressoDaCampanha,
    PublicoDaCampanha,
    RelatorioDeCampanha,
    RespostasDeCampanha,
    SincronizacaoDaCampanha,
  ],
  exports: [
    ModelosMensagemService,
    CampanhasService,
    ConfiguracaoDisparosService,
  ],
})
export class DisparosModule {}
