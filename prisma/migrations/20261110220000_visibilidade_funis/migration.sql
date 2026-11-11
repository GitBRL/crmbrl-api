-- Quem vê um funil (R5.9, R5.11–R5.13).
-- 1. `funis.visibilidade` (`SETOR` | `RESTRITA`), padrão `SETOR`: todo funil existente fica
--    como era (o setor dono inteiro vê), sem nenhum acesso extra.
-- 2. Acessos extras com nível (`VER`, `MEMBRO`, `GESTOR`): `acessos_funil` (um funil) e
--    `acessos_setor` (todos os funis de um setor, menos os `RESTRITA`). O alvo é um setor
--    inteiro (`area`) ou uma pessoa (`usuario_id`) — exatamente um (CHECK); único por
--    (dono, alvo). Os acessos somem junto com o funil, o setor ou a pessoa (CASCADE).
-- Nenhum dado existente é reescrito.
BEGIN;

CREATE TYPE "visibilidade_funil" AS ENUM ('SETOR', 'RESTRITA');

CREATE TYPE "nivel_acesso" AS ENUM ('VER', 'MEMBRO', 'GESTOR');

ALTER TABLE "funis" ADD COLUMN "visibilidade" "visibilidade_funil" NOT NULL DEFAULT 'SETOR';

CREATE TABLE "acessos_funil" (
    "id" UUID NOT NULL,
    "funil_id" UUID NOT NULL,
    "area" TEXT,
    "usuario_id" UUID,
    "nivel" "nivel_acesso" NOT NULL,
    "criado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "acessos_funil_pkey" PRIMARY KEY ("id"),
    -- Exatamente um alvo: um setor inteiro ou uma pessoa.
    CONSTRAINT "acessos_funil_alvo_check" CHECK (num_nonnulls("area", "usuario_id") = 1)
);

CREATE TABLE "acessos_setor" (
    "id" UUID NOT NULL,
    "area_dono" TEXT NOT NULL,
    "area" TEXT,
    "usuario_id" UUID,
    "nivel" "nivel_acesso" NOT NULL,
    "criado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "acessos_setor_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "acessos_setor_alvo_check" CHECK (num_nonnulls("area", "usuario_id") = 1),
    -- O próprio setor dono não é alvo (ele já vê os seus funis).
    CONSTRAINT "acessos_setor_dono_check" CHECK ("area" IS NULL OR "area" <> "area_dono")
);

CREATE INDEX "acessos_funil_usuario_id_idx" ON "acessos_funil"("usuario_id");
CREATE INDEX "acessos_funil_area_idx" ON "acessos_funil"("area");
CREATE UNIQUE INDEX "acessos_funil_funil_id_area_key" ON "acessos_funil"("funil_id", "area");
CREATE UNIQUE INDEX "acessos_funil_funil_id_usuario_id_key" ON "acessos_funil"("funil_id", "usuario_id");

CREATE INDEX "acessos_setor_usuario_id_idx" ON "acessos_setor"("usuario_id");
CREATE INDEX "acessos_setor_area_idx" ON "acessos_setor"("area");
CREATE UNIQUE INDEX "acessos_setor_area_dono_area_key" ON "acessos_setor"("area_dono", "area");
CREATE UNIQUE INDEX "acessos_setor_area_dono_usuario_id_key" ON "acessos_setor"("area_dono", "usuario_id");

ALTER TABLE "acessos_funil" ADD CONSTRAINT "acessos_funil_funil_id_fkey" FOREIGN KEY ("funil_id") REFERENCES "funis"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "acessos_funil" ADD CONSTRAINT "acessos_funil_area_fkey" FOREIGN KEY ("area") REFERENCES "setores"("chave") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "acessos_funil" ADD CONSTRAINT "acessos_funil_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "acessos_setor" ADD CONSTRAINT "acessos_setor_area_dono_fkey" FOREIGN KEY ("area_dono") REFERENCES "setores"("chave") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "acessos_setor" ADD CONSTRAINT "acessos_setor_area_fkey" FOREIGN KEY ("area") REFERENCES "setores"("chave") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "acessos_setor" ADD CONSTRAINT "acessos_setor_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
