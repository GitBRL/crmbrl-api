import { Module } from '@nestjs/common';
import { ContatosModule } from '../contatos/contatos.module';
import { FinanceiroModule } from '../financeiro/financeiro.module';
import { FunisModule } from '../funis/funis.module';
import { ImportacaoController } from './importacao.controller';
import { ImportacaoProcessadorService } from './importacao-processador.service';
import { ImportacaoService } from './importacao.service';
import { ModelosDeImportacaoService } from './modelos-de-importacao.service';

/**
 * Importação de contatos e empresas (R16, contrato da Onda B §2.2): CSV/XLSX
 * (`exceljs`) no MinIO (`ArquivosService`, contexto IMPORTACAO), prévia,
 * mapeamento com modelos salvos (`ImportacaoModelo`), processamento na fila
 * `importacao.processar` com progresso ao vivo, relatório XLSX (contexto RELATORIO).
 *
 * Rotas em `/api/v1/importacoes`. Cada linha passa pelos serviços de contatos
 * e empresas (R4.1, R4.2); a importação inteira é auditada em eventos
 * `importacao.*` e publica `importacao.concluida`.
 */
@Module({
  imports: [ContatosModule, FunisModule, FinanceiroModule],
  controllers: [ImportacaoController],
  providers: [
    ImportacaoService,
    ModelosDeImportacaoService,
    ImportacaoProcessadorService,
  ],
  exports: [ImportacaoService],
})
export class ImportacaoModule {}
