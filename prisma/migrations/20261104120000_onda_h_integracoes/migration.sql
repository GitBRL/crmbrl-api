-- Onda H (H1): integrações por aplicativo (R32). Os webhooks de entrada existentes viram o aplicativo
-- WEBHOOK no modo CRIAR_OU_ATUALIZAR (os valores padrão das colunas novas), com o mesmo endereço.

CREATE TYPE "aplicativo_integracao" AS ENUM ('WEBHOOK', 'ELEMENTOR', 'RD_STATION', 'ACTIVE_CAMPAIGN', 'GREAT_PAGES', 'LEAD_LOVERS', 'MANYCHAT', 'TYPEFORM', 'FACEBOOK_LEAD_ADS', 'HOTMART', 'KIWIFY', 'EDUZZ');
CREATE TYPE "alvo_integracao" AS ENUM ('CONTATO', 'NEGOCIO');
CREATE TYPE "modo_integracao" AS ENUM ('CRIAR', 'ATUALIZAR', 'CRIAR_OU_ATUALIZAR');
CREATE TYPE "formato_webhook_saida" AS ENUM ('ENVELOPE_CRM', 'CLINT');
CREATE TYPE "metodo_webhook_saida" AS ENUM ('POST', 'GET');

ALTER TYPE "modelo_mapeamento" ADD VALUE 'DO_APLICATIVO';

ALTER TABLE "usuarios" ADD COLUMN "identificador_integracao" TEXT;

ALTER TABLE "webhook_recebimentos" ADD COLUMN "avisos" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN "resultados" JSONB;

ALTER TABLE "webhooks_entrada" ADD COLUMN "alvo" "alvo_integracao" NOT NULL DEFAULT 'NEGOCIO',
ADD COLUMN "aplicativo" "aplicativo_integracao" NOT NULL DEFAULT 'WEBHOOK',
ADD COLUMN "atencao_em" TIMESTAMPTZ(3),
ADD COLUMN "atencao_motivo" TEXT,
ADD COLUMN "configuracao" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN "credencial_cifrada" TEXT,
ADD COLUMN "modo" "modo_integracao" NOT NULL DEFAULT 'CRIAR_OU_ATUALIZAR',
ADD COLUMN "motivo_perda_padrao" TEXT,
ADD COLUMN "precisa_atencao" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "status_inicial" "status_negocio" NOT NULL DEFAULT 'ABERTO',
ADD COLUMN "token_cifrado" TEXT;

ALTER TABLE "webhooks_saida" ADD COLUMN "campos" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN "formato" "formato_webhook_saida" NOT NULL DEFAULT 'ENVELOPE_CRM',
ADD COLUMN "gatilhos" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN "metodo" "metodo_webhook_saida" NOT NULL DEFAULT 'POST';

CREATE UNIQUE INDEX "usuarios_identificador_integracao_key" ON "usuarios"("identificador_integracao");
-- Único também sem diferenciar maiúsculas (R32.4).
CREATE UNIQUE INDEX "usuarios_identificador_integracao_lower_key" ON "usuarios"(lower("identificador_integracao"));
CREATE INDEX "webhooks_entrada_aplicativo_idx" ON "webhooks_entrada"("aplicativo");
