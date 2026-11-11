-- Importação compatível com o Clint: id do negócio na origem (idempotência) e contador de negócios atualizados.
ALTER TABLE "negocios" ADD COLUMN "id_externo" TEXT;
CREATE UNIQUE INDEX "negocios_id_externo_key" ON "negocios"("id_externo") WHERE ((id_externo IS NOT NULL) AND (excluido_em IS NULL));

ALTER TABLE "importacoes" ADD COLUMN "negocios_atualizados" INTEGER NOT NULL DEFAULT 0;
