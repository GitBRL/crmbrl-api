-- T4 (Onda T): ligações pelo 3C+ (R34).
-- 1. Ligações do 3C+ na mesma tabela das do WhatsApp: provedor, id externo, negócio, campanha, qualificação.
--    `canal_id` passa a aceitar nulo (a ligação do 3C+ não tem canal do CRM).
-- 2. A regra "uma ligação ativa por atendente" continua só para o WhatsApp (o 3C+ pode ter eventos atrasados).
-- 3. Conexão da empresa, vínculo dos vendedores, deduplicação de eventos e relatório dos envios ao discador.
BEGIN;

CREATE TYPE "provedor_ligacao" AS ENUM ('WHATSAPP', 'TRESC_PLUS');

ALTER TABLE "ligacoes"
  ALTER COLUMN "canal_id" DROP NOT NULL,
  ADD COLUMN "provedor" "provedor_ligacao" NOT NULL DEFAULT 'WHATSAPP',
  ADD COLUMN "id_externo" TEXT,
  ADD COLUMN "negocio_id" UUID,
  ADD COLUMN "campanha_id" INTEGER,
  ADD COLUMN "campanha_nome" TEXT,
  ADD COLUMN "modo_chamada" TEXT,
  ADD COLUMN "qualificacao_id" INTEGER,
  ADD COLUMN "qualificacao_nome" TEXT,
  ADD COLUMN "qualificacao_nota" TEXT,
  ADD COLUMN "qualificacao_conversao" BOOLEAN,
  ADD COLUMN "qualificada_em" TIMESTAMPTZ(3),
  ADD COLUMN "tempo_falado_segundos" INTEGER;

ALTER TABLE "ligacoes"
  ADD CONSTRAINT "ligacoes_negocio_id_fkey" FOREIGN KEY ("negocio_id")
  REFERENCES "negocios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Ligação do WhatsApp sempre tem canal; a do 3C+ nunca.
ALTER TABLE "ligacoes"
  ADD CONSTRAINT "ligacoes_canal_conforme_provedor_check"
  CHECK (("provedor" = 'WHATSAPP' AND "canal_id" IS NOT NULL) OR "provedor" = 'TRESC_PLUS');

DROP INDEX "ligacoes_uma_ativa_por_atendente_key";
CREATE UNIQUE INDEX "ligacoes_uma_ativa_por_atendente_key" ON "ligacoes"("atendente_id")
  WHERE ((atendente_id IS NOT NULL) AND (provedor = 'WHATSAPP'::provedor_ligacao) AND (estado IN ('CHAMANDO'::estado_ligacao, 'TOCANDO'::estado_ligacao, 'EM_ANDAMENTO'::estado_ligacao)));

CREATE UNIQUE INDEX "ligacoes_provedor_id_externo_key" ON "ligacoes"("provedor", "id_externo")
  WHERE (id_externo IS NOT NULL);
CREATE INDEX "ligacoes_negocio_id_criado_em_idx" ON "ligacoes"("negocio_id", "criado_em");

CREATE TABLE "tresc_plus_config" (
  "id" INTEGER NOT NULL DEFAULT 1,
  "ativa" BOOLEAN NOT NULL DEFAULT false,
  "url_api" TEXT NOT NULL DEFAULT 'https://3c.plus/api/v1',
  "url_socket" TEXT,
  "caminho_socket" TEXT NOT NULL DEFAULT '/socket.io',
  "formato_envelope" TEXT NOT NULL DEFAULT 'AUTO',
  "token_cifrado" TEXT,
  "token_final" TEXT,
  "campanha_padrao_id" INTEGER,
  "campanha_padrao_nome" TEXT,
  "testada_em" TIMESTAMPTZ(3),
  "teste_ok" BOOLEAN,
  "teste_mensagem" TEXT,
  "ouvinte_estado" TEXT,
  "ouvinte_em" TIMESTAMPTZ(3),
  "reconciliada_em" TIMESTAMPTZ(3),
  "atualizado_por_id" UUID,
  "criado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "atualizado_em" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "tresc_plus_config_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tresc_plus_config_uma_linha_check" CHECK ("id" = 1)
);

ALTER TABLE "tresc_plus_config"
  ADD CONSTRAINT "tresc_plus_config_atualizado_por_id_fkey" FOREIGN KEY ("atualizado_por_id")
  REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "tresc_plus_vinculos" (
  "id" UUID NOT NULL,
  "usuario_id" UUID NOT NULL,
  "tresc_usuario_id" INTEGER NOT NULL,
  "nome_3c" TEXT,
  "ramal" TEXT,
  "token_cifrado" TEXT NOT NULL,
  "token_final" TEXT NOT NULL,
  "estado" TEXT NOT NULL DEFAULT 'desconectado',
  "estado_desde" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "campanha_id" INTEGER,
  "campanha_nome" TEXT,
  "modo" TEXT,
  "pausa_id" INTEGER,
  "pausa_nome" TEXT,
  "vinculado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "atualizado_em" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "tresc_plus_vinculos_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tresc_plus_vinculos_usuario_id_key" ON "tresc_plus_vinculos"("usuario_id");
CREATE INDEX "tresc_plus_vinculos_tresc_usuario_id_idx" ON "tresc_plus_vinculos"("tresc_usuario_id");

ALTER TABLE "tresc_plus_vinculos"
  ADD CONSTRAINT "tresc_plus_vinculos_usuario_id_fkey" FOREIGN KEY ("usuario_id")
  REFERENCES "usuarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "tresc_plus_eventos" (
  "id" UUID NOT NULL,
  "chave" TEXT NOT NULL,
  "recebido_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "tresc_plus_eventos_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tresc_plus_eventos_chave_key" ON "tresc_plus_eventos"("chave");
CREATE INDEX "tresc_plus_eventos_recebido_em_idx" ON "tresc_plus_eventos"("recebido_em");

CREATE TABLE "tresc_plus_envios" (
  "id" UUID NOT NULL,
  "usuario_id" UUID,
  "campanha_id" INTEGER NOT NULL,
  "campanha_nome" TEXT,
  "lista_id" INTEGER NOT NULL,
  "lista_nome" TEXT,
  "enviados" INTEGER NOT NULL,
  "importados" INTEGER NOT NULL,
  "filtrados" INTEGER NOT NULL,
  "detalhes" JSONB NOT NULL DEFAULT '[]',
  "criado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "tresc_plus_envios_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "tresc_plus_envios_criado_em_idx" ON "tresc_plus_envios"("criado_em");

ALTER TABLE "tresc_plus_envios"
  ADD CONSTRAINT "tresc_plus_envios_usuario_id_fkey" FOREIGN KEY ("usuario_id")
  REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
