-- CreateEnum
CREATE TYPE "situacao_resumo_ligacao" AS ENUM ('PENDENTE', 'PROCESSANDO', 'PRONTO', 'FALHOU', 'DESATIVADO');

-- AlterEnum
ALTER TYPE "contexto_arquivo" ADD VALUE 'LIGACAO';

-- AlterTable
ALTER TABLE "canais_ligacoes" ADD COLUMN     "aviso_arquivo_id" UUID,
ADD COLUMN     "retencao_dias" INTEGER NOT NULL DEFAULT 365;

-- AlterTable
ALTER TABLE "ligacoes" ADD COLUMN     "gravacao_duracao_segundos" INTEGER,
ADD COLUMN     "gravacao_erro" TEXT,
ADD COLUMN     "gravacao_finalizada_em" TIMESTAMPTZ(3),
ADD COLUMN     "gravacao_original_arquivo_id" UUID,
ADD COLUMN     "gravacao_removida_em" TIMESTAMPTZ(3),
ADD COLUMN     "gravacao_total_partes" INTEGER,
ADD COLUMN     "resumo_erro" TEXT,
ADD COLUMN     "resumo_processado_em" TIMESTAMPTZ(3),
ADD COLUMN     "resumo_situacao" "situacao_resumo_ligacao",
ADD COLUMN     "transcricao_erro" TEXT,
ADD COLUMN     "transcricao_processada_em" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "ligacoes_gravacao_partes" (
    "id" UUID NOT NULL,
    "ligacao_id" UUID NOT NULL,
    "sequencia" INTEGER NOT NULL,
    "chave" TEXT NOT NULL,
    "tamanho" INTEGER NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "recebida_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ligacoes_gravacao_partes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ligacoes_gravacao_partes_ligacao_id_sequencia_key" ON "ligacoes_gravacao_partes"("ligacao_id", "sequencia");

-- AddForeignKey
ALTER TABLE "ligacoes_gravacao_partes" ADD CONSTRAINT "ligacoes_gravacao_partes_ligacao_id_fkey" FOREIGN KEY ("ligacao_id") REFERENCES "ligacoes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
