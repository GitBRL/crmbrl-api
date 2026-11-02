-- CreateEnum
CREATE TYPE "StatusAnaliseIa" AS ENUM ('EM_ANDAMENTO', 'CONCLUIDA', 'FALHOU');

-- CreateTable
CREATE TABLE "analises_ia" (
    "id" UUID NOT NULL,
    "usuario_id" UUID NOT NULL,
    "painel" TEXT NOT NULL,
    "filtros" JSONB NOT NULL,
    "entrada" JSONB NOT NULL,
    "mensagem_inicial" TEXT NOT NULL,
    "resultado" JSONB,
    "status" "StatusAnaliseIa" NOT NULL DEFAULT 'EM_ANDAMENTO',
    "erro" TEXT,
    "modelo" TEXT NOT NULL,
    "tentativas" INTEGER NOT NULL DEFAULT 0,
    "tokens_entrada" INTEGER NOT NULL DEFAULT 0,
    "tokens_saida" INTEGER NOT NULL DEFAULT 0,
    "tokens_cache_leitura" INTEGER NOT NULL DEFAULT 0,
    "tokens_cache_escrita" INTEGER NOT NULL DEFAULT 0,
    "duracao_ms" INTEGER,
    "criado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "concluido_em" TIMESTAMPTZ(3),

    CONSTRAINT "analises_ia_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "analises_ia_perguntas" (
    "id" UUID NOT NULL,
    "analise_id" UUID NOT NULL,
    "pergunta" TEXT NOT NULL,
    "resposta" JSONB,
    "status" "StatusAnaliseIa" NOT NULL DEFAULT 'EM_ANDAMENTO',
    "erro" TEXT,
    "tentativas" INTEGER NOT NULL DEFAULT 0,
    "tokens_entrada" INTEGER NOT NULL DEFAULT 0,
    "tokens_saida" INTEGER NOT NULL DEFAULT 0,
    "tokens_cache_leitura" INTEGER NOT NULL DEFAULT 0,
    "tokens_cache_escrita" INTEGER NOT NULL DEFAULT 0,
    "duracao_ms" INTEGER,
    "criado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "concluido_em" TIMESTAMPTZ(3),

    CONSTRAINT "analises_ia_perguntas_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "analises_ia_criado_em_idx" ON "analises_ia"("criado_em");

-- CreateIndex
CREATE INDEX "analises_ia_usuario_id_criado_em_idx" ON "analises_ia"("usuario_id", "criado_em");

-- CreateIndex
CREATE INDEX "analises_ia_perguntas_analise_id_criado_em_idx" ON "analises_ia_perguntas"("analise_id", "criado_em");

-- AddForeignKey
ALTER TABLE "analises_ia" ADD CONSTRAINT "analises_ia_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analises_ia_perguntas" ADD CONSTRAINT "analises_ia_perguntas_analise_id_fkey" FOREIGN KEY ("analise_id") REFERENCES "analises_ia"("id") ON DELETE CASCADE ON UPDATE CASCADE;

