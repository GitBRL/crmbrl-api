-- CreateEnum
CREATE TYPE "papel" AS ENUM ('ADMIN', 'C_LEVEL', 'LIDER_COMERCIAL', 'COMERCIAL', 'LIDER_MARKETING', 'MARKETING', 'LIDER_CS', 'CS');

-- CreateTable
CREATE TABLE "usuarios" (
    "id" UUID NOT NULL,
    "nome" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "papel" "papel" NOT NULL,
    "lider_id" UUID,
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "desligado_em" TIMESTAMPTZ(3),
    "criado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "usuarios_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "usuarios_email_key" ON "usuarios"("email");

-- CreateIndex
CREATE INDEX "usuarios_lider_id_idx" ON "usuarios"("lider_id");

-- AddForeignKey
ALTER TABLE "usuarios" ADD CONSTRAINT "usuarios_lider_id_fkey" FOREIGN KEY ("lider_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;
