-- Importação v2: linhas filtradas e negócios criados/reconvertidos pela importação.
ALTER TABLE "importacoes"
  ADD COLUMN "filtradas" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "negocios_criados" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "negocios_reconvertidos" INTEGER NOT NULL DEFAULT 0;
