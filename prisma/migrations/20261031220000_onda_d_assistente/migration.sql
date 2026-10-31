-- CreateEnum
CREATE TYPE "CategoriaAssistente" AS ENUM ('duvida_de_uso', 'funcionalidade_inexistente_no_escopo', 'fora_do_escopo', 'erro_do_sistema');

-- CreateEnum
CREATE TYPE "AvaliacaoAssistente" AS ENUM ('UTIL', 'NAO_UTIL');

-- CreateEnum
CREATE TYPE "DestinoChamado" AS ENUM ('TICKETHUB', 'WEBHOOK');

-- CreateEnum
CREATE TYPE "StatusChamado" AS ENUM ('PENDENTE', 'ENVIADO', 'FALHOU');

-- CreateTable
CREATE TABLE "assistente_conversas" (
    "id" UUID NOT NULL,
    "usuario_id" UUID NOT NULL,
    "papel" "papel" NOT NULL,
    "area" "area",
    "titulo" TEXT NOT NULL,
    "criado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "assistente_conversas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assistente_perguntas" (
    "id" UUID NOT NULL,
    "conversa_id" UUID NOT NULL,
    "usuario_id" UUID NOT NULL,
    "area" "area",
    "pergunta" TEXT NOT NULL,
    "tela" TEXT NOT NULL,
    "modulo" TEXT NOT NULL,
    "resposta" TEXT,
    "resolvido" BOOLEAN,
    "categoria" "CategoriaAssistente",
    "resumo_do_pedido" TEXT,
    "status" "StatusAnaliseIa" NOT NULL DEFAULT 'EM_ANDAMENTO',
    "erro" TEXT,
    "modelo" TEXT NOT NULL,
    "tentativas" INTEGER NOT NULL DEFAULT 0,
    "tokens_entrada" INTEGER NOT NULL DEFAULT 0,
    "tokens_saida" INTEGER NOT NULL DEFAULT 0,
    "tokens_cache_leitura" INTEGER NOT NULL DEFAULT 0,
    "tokens_cache_escrita" INTEGER NOT NULL DEFAULT 0,
    "duracao_ms" INTEGER,
    "avaliacao" "AvaliacaoAssistente",
    "avaliado_em" TIMESTAMPTZ(3),
    "criado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "concluido_em" TIMESTAMPTZ(3),

    CONSTRAINT "assistente_perguntas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assistente_chamados" (
    "id" UUID NOT NULL,
    "conversa_id" UUID NOT NULL,
    "pergunta_id" UUID NOT NULL,
    "usuario_id" UUID NOT NULL,
    "titulo" TEXT NOT NULL,
    "descricao" TEXT NOT NULL,
    "tela" TEXT NOT NULL,
    "categoria" "CategoriaAssistente" NOT NULL,
    "destino" "DestinoChamado" NOT NULL,
    "status" "StatusChamado" NOT NULL DEFAULT 'PENDENTE',
    "tentativas" INTEGER NOT NULL DEFAULT 0,
    "proxima_tentativa_em" TIMESTAMPTZ(3),
    "ultimo_erro" TEXT,
    "numero" TEXT,
    "link" TEXT,
    "criado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "enviado_em" TIMESTAMPTZ(3),

    CONSTRAINT "assistente_chamados_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "assistente_conversas_usuario_id_atualizado_em_idx" ON "assistente_conversas"("usuario_id", "atualizado_em");

-- CreateIndex
CREATE INDEX "assistente_conversas_criado_em_idx" ON "assistente_conversas"("criado_em");

-- CreateIndex
CREATE INDEX "assistente_perguntas_conversa_id_criado_em_idx" ON "assistente_perguntas"("conversa_id", "criado_em");

-- CreateIndex
CREATE INDEX "assistente_perguntas_usuario_id_criado_em_idx" ON "assistente_perguntas"("usuario_id", "criado_em");

-- CreateIndex
CREATE INDEX "assistente_perguntas_criado_em_idx" ON "assistente_perguntas"("criado_em");

-- CreateIndex
CREATE UNIQUE INDEX "assistente_chamados_pergunta_id_key" ON "assistente_chamados"("pergunta_id");

-- CreateIndex
CREATE INDEX "assistente_chamados_status_criado_em_idx" ON "assistente_chamados"("status", "criado_em");

-- CreateIndex
CREATE INDEX "assistente_chamados_usuario_id_criado_em_idx" ON "assistente_chamados"("usuario_id", "criado_em");

-- AddForeignKey
ALTER TABLE "assistente_conversas" ADD CONSTRAINT "assistente_conversas_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assistente_perguntas" ADD CONSTRAINT "assistente_perguntas_conversa_id_fkey" FOREIGN KEY ("conversa_id") REFERENCES "assistente_conversas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assistente_chamados" ADD CONSTRAINT "assistente_chamados_conversa_id_fkey" FOREIGN KEY ("conversa_id") REFERENCES "assistente_conversas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assistente_chamados" ADD CONSTRAINT "assistente_chamados_pergunta_id_fkey" FOREIGN KEY ("pergunta_id") REFERENCES "assistente_perguntas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assistente_chamados" ADD CONSTRAINT "assistente_chamados_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

