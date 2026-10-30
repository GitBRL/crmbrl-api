import { Module } from '@nestjs/common';

/**
 * Importação de contatos e empresas (R16, contrato da Onda B §2.2): CSV/XLSX
 * (`exceljs`) no MinIO (`ArquivosService`, contexto IMPORTACAO), prévia,
 * mapeamento com modelos salvos (`ImportacaoModelo`), processamento na fila
 * `importacao.processar` com progresso ao vivo, relatório XLSX (contexto RELATORIO).
 *
 * Esqueleto da base (`base-api-b`): o `importacao-api` preenche controllers e
 * providers. O schema (`Importacao`, `ImportacaoLinha`, `ImportacaoModelo`) já existe.
 */
@Module({
  controllers: [],
  providers: [],
  exports: [],
})
export class ImportacaoModule {}
