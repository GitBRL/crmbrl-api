-- Onda H (H4): login facilitado. Apps de login (R32.22) e conexões de aplicativo por login (R32.25, R32.26).

CREATE TYPE "aplicativo_de_login" AS ENUM ('META', 'TYPEFORM', 'RD_STATION');

ALTER TABLE "conexoes_facebook" ADD COLUMN "app_das_configuracoes" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "apps_de_login" (
    "id" UUID NOT NULL,
    "aplicativo" "aplicativo_de_login" NOT NULL,
    "client_id" TEXT NOT NULL,
    "segredo_cifrado" TEXT NOT NULL,
    "token_verificacao_cifrado" TEXT,
    "atualizado_por_id" UUID,
    "criado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "apps_de_login_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "conexoes_aplicativo" (
    "id" UUID NOT NULL,
    "aplicativo" "aplicativo_de_login" NOT NULL,
    "nome" TEXT NOT NULL,
    "conta" TEXT,
    "tokens_cifrados" TEXT,
    "expira_em" TIMESTAMPTZ(3),
    "estado_hash" TEXT,
    "estado_expira_em" TIMESTAMPTZ(3),
    "conectada_em" TIMESTAMPTZ(3),
    "precisa_atencao" BOOLEAN NOT NULL DEFAULT false,
    "atencao_motivo" TEXT,
    "atencao_em" TIMESTAMPTZ(3),
    "criado_por_id" UUID,
    "criado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMPTZ(3) NOT NULL,
    "excluido_em" TIMESTAMPTZ(3),

    CONSTRAINT "conexoes_aplicativo_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "apps_de_login_aplicativo_key" ON "apps_de_login"("aplicativo");
CREATE INDEX "conexoes_aplicativo_aplicativo_excluido_em_idx" ON "conexoes_aplicativo"("aplicativo", "excluido_em");
