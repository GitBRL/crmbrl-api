import { Module } from '@nestjs/common';
import {
  ChamadaClaudeService,
  OPCOES_CHAMADA_CLAUDE,
  OPCOES_CHAMADA_PADRAO,
} from '../bi/analise/chamada-claude.service';
import { PROVIDER_CLIENTE_ANTHROPIC } from '../bi/analise/cliente-anthropic';
import { AssistenteAdminController } from './assistente-admin.controller';
import { AssistenteController } from './assistente.controller';
import { AssistenteService } from './assistente.service';
import {
  BaseDeConhecimentoService,
  OPCOES_ASSISTENTE,
  OPCOES_ASSISTENTE_PADRAO,
} from './base-de-conhecimento';
import { ChamadosAssistenteService } from './chamados/chamados-assistente.service';
import { ConectorChamadosService } from './chamados/conector-chamados.service';
import { ConfiguracaoAssistenteService } from './configuracao-assistente.service';
import { HistoricoAssistenteService } from './historico-assistente.service';

/**
 * Assistente de ajuda por IA e chamados (R25): Claude (`@anthropic-ai/sdk`,
 * o mesmo cliente e a mesma chamada em streaming da análise do BI) sobre a
 * base de conhecimento `docs/ajuda/*.md`; chamados no TicketHub ou num
 * webhook, pela fila. Nos testes: `CLIENTE_ANTHROPIC` falso e
 * `OPCOES_ASSISTENTE` com a pasta de artigos de exemplo.
 */
@Module({
  controllers: [AssistenteController, AssistenteAdminController],
  providers: [
    AssistenteService,
    BaseDeConhecimentoService,
    ConfiguracaoAssistenteService,
    ChamadosAssistenteService,
    ConectorChamadosService,
    HistoricoAssistenteService,
    ChamadaClaudeService,
    PROVIDER_CLIENTE_ANTHROPIC,
    { provide: OPCOES_CHAMADA_CLAUDE, useValue: OPCOES_CHAMADA_PADRAO },
    { provide: OPCOES_ASSISTENTE, useValue: OPCOES_ASSISTENTE_PADRAO },
  ],
})
export class AssistenteModule {}
