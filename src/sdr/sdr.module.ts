import { Module } from '@nestjs/common';
import { AtendimentoModule } from '../atendimento/atendimento.module';
import {
  ChamadaClaudeService,
  OPCOES_CHAMADA_CLAUDE,
} from '../bi/analise/chamada-claude.service';
import { PROVIDER_CLIENTE_ANTHROPIC } from '../bi/analise/cliente-anthropic';
import { ContatosModule } from '../contatos/contatos.module';
import { FunisModule } from '../funis/funis.module';
import { ConfiguracaoSdrService } from './configuracao-sdr.service';
import { ConversasSdrService } from './conversas-sdr.service';
import { EfeitosSdrService } from './efeitos-sdr.service';
import { MotorSdr } from './motor-sdr.service';
import {
  OPCOES_CHAMADA_SDR,
  OPCOES_SDR,
  OPCOES_SDR_PADRAO,
} from './opcoes-sdr';
import { OrcamentoSdrService } from './orcamento-sdr.service';
import { QualificacaoSdrService } from './qualificacao-sdr.service';
import {
  SdrConfiguracaoController,
  SdrConversasController,
} from './sdr.controller';
import { SimuladorSdrService } from './simulador-sdr.service';
import { TransicoesSdrService } from './transicoes-sdr.service';

/**
 * SDR com IA (Onda G, R31): a IA responde os leads novos nos canais de
 * atendimento, descobre os critérios de qualificação do Admin, dá nota e
 * temperatura e passa o lead qualificado para o Comercial.
 *
 * - `MotorSdr`: quando a IA assume (gancho do Atendimento), jobs `sdr.turno`
 *   com agrupamento e trava por conversa, chamada ao Claude (`@anthropic-ai/sdk`,
 *   saída estruturada `turno_sdr`, o mesmo cliente e a mesma chamada do
 *   assistente), e aplicação do resultado;
 * - `QualificacaoSdrService` e `EfeitosSdrService`: valores nos campos, passagem
 *   Marketing → Comercial pelo rodízio, passagem para uma pessoa, desqualificação;
 * - `ConfiguracaoSdrService`, `OrcamentoSdrService`: configuração do Admin,
 *   base de conhecimento versionada, tokens e orçamento;
 * - `ConversasSdrService`, `SimuladorSdrService` e os controllers em `/sdr/**`.
 *
 * Nos testes: `CLIENTE_ANTHROPIC` falso (como no assistente) e `OPCOES_SDR`
 * sem a pausa de "digitando".
 */
@Module({
  imports: [AtendimentoModule, ContatosModule, FunisModule],
  controllers: [SdrConfiguracaoController, SdrConversasController],
  providers: [
    MotorSdr,
    ConfiguracaoSdrService,
    OrcamentoSdrService,
    QualificacaoSdrService,
    EfeitosSdrService,
    TransicoesSdrService,
    ConversasSdrService,
    SimuladorSdrService,
    ChamadaClaudeService,
    PROVIDER_CLIENTE_ANTHROPIC,
    { provide: OPCOES_CHAMADA_CLAUDE, useValue: OPCOES_CHAMADA_SDR },
    { provide: OPCOES_SDR, useValue: OPCOES_SDR_PADRAO },
  ],
  exports: [MotorSdr],
})
export class SdrModule {}
