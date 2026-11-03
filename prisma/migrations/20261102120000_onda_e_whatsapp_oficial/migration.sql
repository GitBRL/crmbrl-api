-- AlterEnum
ALTER TYPE "tipo_canal" ADD VALUE 'WHATSAPP_OFICIAL';

-- AlterEnum
ALTER TYPE "tipo_identificador" ADD VALUE 'WHATSAPP_BSUID';

-- CreateTable
CREATE TABLE "whatsapp_oficial_templates" (
    "id" UUID NOT NULL,
    "canal_id" UUID NOT NULL,
    "id_meta" TEXT,
    "nome" TEXT NOT NULL,
    "idioma" TEXT NOT NULL,
    "categoria" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "componentes" JSONB NOT NULL DEFAULT '[]',
    "sincronizado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "criado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "whatsapp_oficial_templates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "whatsapp_oficial_templates_canal_id_status_idx" ON "whatsapp_oficial_templates"("canal_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_oficial_templates_canal_id_nome_idioma_key" ON "whatsapp_oficial_templates"("canal_id", "nome", "idioma");

-- AddForeignKey
ALTER TABLE "whatsapp_oficial_templates" ADD CONSTRAINT "whatsapp_oficial_templates_canal_id_fkey" FOREIGN KEY ("canal_id") REFERENCES "canais"("id") ON DELETE CASCADE ON UPDATE CASCADE;
