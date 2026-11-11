-- Setores dinâmicos (R1.6–R1.11).
-- 1. Tabela `setores`, com os três de base (MARKETING, COMERCIAL, CS).
-- 2. As colunas `area` (enum `area`) viram texto com FK para `setores(chave)`: mesmos
--    nomes e mesmos valores (nenhum dado dessas colunas é reescrito). Os índices e únicos
--    sobre elas (inclusive os parciais, como `funis_base_area_key`) são refeitos pelo
--    próprio ALTER COLUMN … TYPE.
-- 3. O papel passa a ser só o nível (`ADMIN`, `C_LEVEL`, `LIDER`, `MEMBRO`) e o setor da
--    pessoa vai para `usuarios.area`: LIDER_X → (LIDER, X); X → (MEMBRO, X). O mesmo em
--    `assistente_conversas` (cuja `area` é preenchida quando estava nula).
-- Uma transação só: se algo falhar, nada muda.
BEGIN;

-- 1. Setores ----------------------------------------------------------------
CREATE TABLE "setores" (
    "chave" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "descricao" TEXT,
    "cor" TEXT,
    "base" BOOLEAN NOT NULL DEFAULT false,
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "ordem" INTEGER NOT NULL DEFAULT 0,
    "criado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "setores_pkey" PRIMARY KEY ("chave"),
    -- Chave gerada do nome: maiúsculas, dígitos e `_`, até 40 caracteres (R1.8).
    CONSTRAINT "setores_chave_check" CHECK ("chave" ~ '^[A-Z0-9][A-Z0-9_]{0,39}$'),
    CONSTRAINT "setores_nome_check" CHECK ("nome" = btrim("nome") AND length("nome") BETWEEN 1 AND 60),
    -- Os setores de base nunca são desativados (R1.10).
    CONSTRAINT "setores_base_ativo_check" CHECK (NOT "base" OR "ativo")
);

CREATE INDEX "setores_ativo_ordem_idx" ON "setores"("ativo", "ordem");

INSERT INTO "setores" ("chave", "nome", "base", "ativo", "ordem", "atualizado_em") VALUES
    ('MARKETING', 'Marketing', true, true, 1, CURRENT_TIMESTAMP),
    ('COMERCIAL', 'Comercial', true, true, 2, CURRENT_TIMESTAMP),
    ('CS', 'Customer Success', true, true, 3, CURRENT_TIMESTAMP);

-- 2. Colunas `area`: enum → texto + FK ---------------------------------------
ALTER TABLE "funis" ALTER COLUMN "area" TYPE TEXT USING "area"::text;
ALTER TABLE "regras_distribuicao" ALTER COLUMN "area" TYPE TEXT USING "area"::text;
ALTER TABLE "filas_atendimento" ALTER COLUMN "area" TYPE TEXT USING "area"::text;
ALTER TABLE "respostas_rapidas" ALTER COLUMN "area" TYPE TEXT USING "area"::text;
ALTER TABLE "chat_canais" ALTER COLUMN "area" TYPE TEXT USING "area"::text;
ALTER TABLE "importacoes" ALTER COLUMN "area_rodizio" TYPE TEXT USING "area_rodizio"::text;
ALTER TABLE "modelos_mensagem" ALTER COLUMN "area" TYPE TEXT USING "area"::text;
ALTER TABLE "campanhas" ALTER COLUMN "area" TYPE TEXT USING "area"::text;
ALTER TABLE "fluxos_chatbot" ALTER COLUMN "area" TYPE TEXT USING "area"::text;
ALTER TABLE "automacoes" ALTER COLUMN "area" TYPE TEXT USING "area"::text;
ALTER TABLE "assistente_conversas" ALTER COLUMN "area" TYPE TEXT USING "area"::text;
ALTER TABLE "assistente_perguntas" ALTER COLUMN "area" TYPE TEXT USING "area"::text;

ALTER TABLE "funis" ADD CONSTRAINT "funis_area_fkey" FOREIGN KEY ("area") REFERENCES "setores"("chave") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "regras_distribuicao" ADD CONSTRAINT "regras_distribuicao_area_fkey" FOREIGN KEY ("area") REFERENCES "setores"("chave") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "filas_atendimento" ADD CONSTRAINT "filas_atendimento_area_fkey" FOREIGN KEY ("area") REFERENCES "setores"("chave") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "respostas_rapidas" ADD CONSTRAINT "respostas_rapidas_area_fkey" FOREIGN KEY ("area") REFERENCES "setores"("chave") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "chat_canais" ADD CONSTRAINT "chat_canais_area_fkey" FOREIGN KEY ("area") REFERENCES "setores"("chave") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "importacoes" ADD CONSTRAINT "importacoes_area_rodizio_fkey" FOREIGN KEY ("area_rodizio") REFERENCES "setores"("chave") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "modelos_mensagem" ADD CONSTRAINT "modelos_mensagem_area_fkey" FOREIGN KEY ("area") REFERENCES "setores"("chave") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "campanhas" ADD CONSTRAINT "campanhas_area_fkey" FOREIGN KEY ("area") REFERENCES "setores"("chave") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "fluxos_chatbot" ADD CONSTRAINT "fluxos_chatbot_area_fkey" FOREIGN KEY ("area") REFERENCES "setores"("chave") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "automacoes" ADD CONSTRAINT "automacoes_area_fkey" FOREIGN KEY ("area") REFERENCES "setores"("chave") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "assistente_conversas" ADD CONSTRAINT "assistente_conversas_area_fkey" FOREIGN KEY ("area") REFERENCES "setores"("chave") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "assistente_perguntas" ADD CONSTRAINT "assistente_perguntas_area_fkey" FOREIGN KEY ("area") REFERENCES "setores"("chave") ON DELETE RESTRICT ON UPDATE CASCADE;

DROP TYPE "area";

-- 3. Papel = nível; setor da pessoa em `usuarios.area` ------------------------
ALTER TYPE "papel" RENAME TO "papel_antigo";
CREATE TYPE "papel" AS ENUM ('ADMIN', 'C_LEVEL', 'LIDER', 'MEMBRO');

ALTER TABLE "usuarios" ADD COLUMN "area" TEXT;
UPDATE "usuarios" SET "area" = CASE "papel"::text
    WHEN 'LIDER_MARKETING' THEN 'MARKETING' WHEN 'MARKETING' THEN 'MARKETING'
    WHEN 'LIDER_COMERCIAL' THEN 'COMERCIAL' WHEN 'COMERCIAL' THEN 'COMERCIAL'
    WHEN 'LIDER_CS' THEN 'CS' WHEN 'CS' THEN 'CS'
  END
 WHERE "papel"::text NOT IN ('ADMIN', 'C_LEVEL');
ALTER TABLE "usuarios" ALTER COLUMN "papel" TYPE "papel" USING (CASE
    WHEN "papel"::text IN ('ADMIN', 'C_LEVEL') THEN "papel"::text
    WHEN "papel"::text LIKE 'LIDER\_%' THEN 'LIDER'
    ELSE 'MEMBRO'
  END)::"papel";
ALTER TABLE "usuarios" ADD CONSTRAINT "usuarios_area_fkey" FOREIGN KEY ("area") REFERENCES "setores"("chave") ON DELETE RESTRICT ON UPDATE CASCADE;
-- Líder e Membro têm setor; Admin e C-level não (R1.2).
ALTER TABLE "usuarios" ADD CONSTRAINT "usuarios_area_check" CHECK (("papel" IN ('LIDER', 'MEMBRO')) = ("area" IS NOT NULL));
CREATE INDEX "usuarios_area_papel_ativo_idx" ON "usuarios"("area", "papel", "ativo");

UPDATE "assistente_conversas" SET "area" = CASE "papel"::text
    WHEN 'LIDER_MARKETING' THEN 'MARKETING' WHEN 'MARKETING' THEN 'MARKETING'
    WHEN 'LIDER_COMERCIAL' THEN 'COMERCIAL' WHEN 'COMERCIAL' THEN 'COMERCIAL'
    WHEN 'LIDER_CS' THEN 'CS' WHEN 'CS' THEN 'CS'
  END
 WHERE "area" IS NULL AND "papel"::text NOT IN ('ADMIN', 'C_LEVEL');
ALTER TABLE "assistente_conversas" ALTER COLUMN "papel" TYPE "papel" USING (CASE
    WHEN "papel"::text IN ('ADMIN', 'C_LEVEL') THEN "papel"::text
    WHEN "papel"::text LIKE 'LIDER\_%' THEN 'LIDER'
    ELSE 'MEMBRO'
  END)::"papel";

DROP TYPE "papel_antigo";

COMMIT;
