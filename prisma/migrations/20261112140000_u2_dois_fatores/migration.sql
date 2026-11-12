-- U2 (Onda U): verificação em duas etapas opcional (TOTP), R2.11.
BEGIN;

ALTER TABLE "usuarios"
  ADD COLUMN "dois_fatores_segredo" TEXT,
  ADD COLUMN "dois_fatores_ativado_em" TIMESTAMPTZ(3),
  ADD COLUMN "dois_fatores_ultimo_passo" INTEGER;

CREATE TABLE "codigos_recuperacao" (
  "id" UUID NOT NULL,
  "usuario_id" UUID NOT NULL,
  "codigo_hash" TEXT NOT NULL,
  "criado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "usado_em" TIMESTAMPTZ(3),
  CONSTRAINT "codigos_recuperacao_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "codigos_recuperacao_usuario_id_codigo_hash_key" ON "codigos_recuperacao"("usuario_id", "codigo_hash");
ALTER TABLE "codigos_recuperacao"
  ADD CONSTRAINT "codigos_recuperacao_usuario_id_fkey" FOREIGN KEY ("usuario_id")
  REFERENCES "usuarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "desafios_dois_fatores" (
  "id" UUID NOT NULL,
  "usuario_id" UUID NOT NULL,
  "token_hash" TEXT NOT NULL,
  "criado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expira_em" TIMESTAMPTZ(3) NOT NULL,
  "tentativas" INTEGER NOT NULL DEFAULT 0,
  "usado_em" TIMESTAMPTZ(3),
  CONSTRAINT "desafios_dois_fatores_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "desafios_dois_fatores_token_hash_key" ON "desafios_dois_fatores"("token_hash");
CREATE INDEX "desafios_dois_fatores_usuario_id_idx" ON "desafios_dois_fatores"("usuario_id");
CREATE INDEX "desafios_dois_fatores_expira_em_idx" ON "desafios_dois_fatores"("expira_em");
ALTER TABLE "desafios_dois_fatores"
  ADD CONSTRAINT "desafios_dois_fatores_usuario_id_fkey" FOREIGN KEY ("usuario_id")
  REFERENCES "usuarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
