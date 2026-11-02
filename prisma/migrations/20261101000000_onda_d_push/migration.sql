-- CreateTable
CREATE TABLE "push_inscricoes" (
    "id" UUID NOT NULL,
    "usuario_id" UUID NOT NULL,
    "endpoint" TEXT NOT NULL,
    "chaves_cifradas" TEXT NOT NULL,
    "aparelho" TEXT NOT NULL,
    "criado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ultimo_envio_em" TIMESTAMPTZ(3),
    "ultimo_erro" TEXT,

    CONSTRAINT "push_inscricoes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "push_preferencias" (
    "usuario_id" UUID NOT NULL,
    "tipos" JSONB NOT NULL,
    "atualizado_em" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "push_preferencias_pkey" PRIMARY KEY ("usuario_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "push_inscricoes_endpoint_key" ON "push_inscricoes"("endpoint");

-- CreateIndex
CREATE INDEX "push_inscricoes_usuario_id_idx" ON "push_inscricoes"("usuario_id");

-- AddForeignKey
ALTER TABLE "push_inscricoes" ADD CONSTRAINT "push_inscricoes_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "push_preferencias" ADD CONSTRAINT "push_preferencias_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

