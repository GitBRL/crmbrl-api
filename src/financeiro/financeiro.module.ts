import { Module } from '@nestjs/common';
import { AtendimentoModule } from '../atendimento/atendimento.module';
import { ContatosModule } from '../contatos/contatos.module';
import { ContratosService } from './contratos.service';
import { FinanceiroController } from './financeiro.controller';
import { ImportacaoDeParcelasService } from './importacao-de-parcelas.service';
import { IndicadoresFinanceirosService } from './indicadores.service';
import { ParcelasService } from './parcelas.service';
import { ReguaConfiguracaoService } from './regua-configuracao.service';
import { ReguaConsultaService } from './regua-consulta.service';
import { ReguaEnvioService } from './regua-envio.service';
import { ReguaLigacoesService } from './regua-ligacoes.service';
import { ReguaService } from './regua.service';
import { RiscoDeChurnService } from './risco-de-churn.service';
import { SugestaoDeContratoService } from './sugestao-de-contrato.service';
import { TempoRealFinanceiro } from './tempo-real-financeiro.service';

/**
 * Financeiro (Onda C, §2.3; R22 contratos e parcelas, R23 MRR e inadimplência,
 * R24 régua de cobrança). Rotas em `/api/v1/financeiro`.
 *
 * - Contratos e parcelas: `ContratosService`, `ParcelasService` (baixa manual,
 *   renegociação, atraso automático) e a importação do tipo `PARCELAS`
 *   (`ImportacaoDeParcelasService`, usada por `src/importacao`).
 * - Régua: cron `financeiro.regua.agenda` (15 min) → execução diária no horário
 *   configurado; envios nas filas próprias `financeiro.regua.whatsapp` e
 *   `financeiro.regua.email`; ligações viram atividades; ator AUTOMACAO "Régua de cobrança".
 * - Para o BI (R20): `IndicadoresFinanceirosService` (mrr, inadimplencia,
 *   previstoRealizado, resumo) e `RiscoDeChurnService` (doContato, doNegocio,
 *   ranking, contagemPorNivel) — ambos respeitam a visibilidade do usuário.
 */
@Module({
  imports: [AtendimentoModule, ContatosModule],
  controllers: [FinanceiroController],
  providers: [
    ContratosService,
    ImportacaoDeParcelasService,
    IndicadoresFinanceirosService,
    ParcelasService,
    ReguaConfiguracaoService,
    ReguaConsultaService,
    ReguaEnvioService,
    ReguaLigacoesService,
    ReguaService,
    RiscoDeChurnService,
    SugestaoDeContratoService,
    TempoRealFinanceiro,
  ],
  exports: [
    ContratosService,
    ImportacaoDeParcelasService,
    IndicadoresFinanceirosService,
    ParcelasService,
    RiscoDeChurnService,
  ],
})
export class FinanceiroModule {}
