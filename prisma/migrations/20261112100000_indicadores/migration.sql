-- T3 (Onda T): indicadores configuráveis (R33). Só a tabela dos painéis; os números saem das tabelas existentes.
BEGIN;

CREATE TABLE "paineis_indicadores" (
    "id" UUID NOT NULL,
    "nome" TEXT NOT NULL,
    "descricao" TEXT,
    "dono_id" UUID NOT NULL,
    "filtros_padrao" JSONB NOT NULL DEFAULT '{}',
    "widgets" JSONB NOT NULL DEFAULT '[]',
    "compartilhado_setores" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "compartilhado_pessoas" UUID[] DEFAULT ARRAY[]::UUID[],
    "compartilhado_papeis" "papel"[] DEFAULT ARRAY[]::"papel"[],
    "modelo" TEXT,
    "criado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMPTZ(3) NOT NULL,
    "excluido_em" TIMESTAMPTZ(3),

    CONSTRAINT "paineis_indicadores_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "paineis_indicadores_dono_id_idx" ON "paineis_indicadores"("dono_id");
CREATE INDEX "paineis_indicadores_excluido_em_idx" ON "paineis_indicadores"("excluido_em");

ALTER TABLE "paineis_indicadores"
  ADD CONSTRAINT "paineis_indicadores_dono_id_fkey" FOREIGN KEY ("dono_id")
  REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
