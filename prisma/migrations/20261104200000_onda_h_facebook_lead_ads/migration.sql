-- Onda H (H2): Facebook Lead Ads (R32.14). Conexões com o app da Meta e o registro dos leads já recebidos.

CREATE TYPE "tipo_conexao_facebook" AS ENUM ('USUARIO', 'PAGINA');
CREATE TYPE "origem_lead_facebook" AS ENUM ('WEBHOOK', 'RECONCILIACAO');

CREATE TABLE "conexoes_facebook" (
    "id" UUID NOT NULL,
    "nome" TEXT NOT NULL,
    "tipo" "tipo_conexao_facebook" NOT NULL,
    "app_id" TEXT NOT NULL,
    "app_secret_cifrado" TEXT NOT NULL,
    "token_cifrado" TEXT,
    "paginas_cifradas" TEXT,
    "usuario_facebook_id" TEXT,
    "usuario_facebook_nome" TEXT,
    "expira_em" TIMESTAMPTZ(3),
    "canal_origem_id" UUID,
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

    CONSTRAINT "conexoes_facebook_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "leads_facebook" (
    "id" UUID NOT NULL,
    "webhook_id" UUID NOT NULL,
    "leadgen_id" TEXT NOT NULL,
    "formulario_id" TEXT NOT NULL,
    "criado_na_meta_em" TIMESTAMPTZ(3),
    "origem" "origem_lead_facebook" NOT NULL,
    "recebimento_id" UUID,
    "recebido_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "leads_facebook_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "conexoes_facebook_excluido_em_idx" ON "conexoes_facebook"("excluido_em");
CREATE INDEX "leads_facebook_webhook_id_criado_na_meta_em_idx" ON "leads_facebook"("webhook_id", "criado_na_meta_em");
CREATE UNIQUE INDEX "leads_facebook_webhook_id_leadgen_id_key" ON "leads_facebook"("webhook_id", "leadgen_id");

ALTER TABLE "leads_facebook" ADD CONSTRAINT "leads_facebook_webhook_id_fkey" FOREIGN KEY ("webhook_id") REFERENCES "webhooks_entrada"("id") ON DELETE CASCADE ON UPDATE CASCADE;
