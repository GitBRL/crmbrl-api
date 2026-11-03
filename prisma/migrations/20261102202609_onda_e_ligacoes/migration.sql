-- CreateEnum
CREATE TYPE "direcao_ligacao" AS ENUM ('RECEBIDA', 'FEITA');

-- CreateEnum
CREATE TYPE "estado_ligacao" AS ENUM ('CHAMANDO', 'TOCANDO', 'EM_ANDAMENTO', 'ENCERRADA', 'PERDIDA', 'RECUSADA', 'SEM_RESPOSTA', 'FALHOU');

-- CreateEnum
CREATE TYPE "situacao_permissao_ligacao" AS ENUM ('NENHUMA', 'PEDIDA', 'CONCEDIDA', 'NEGADA', 'REVOGADA');

-- CreateEnum
CREATE TYPE "tipo_permissao_ligacao" AS ENUM ('TEMPORARIA', 'PERMANENTE');

-- CreateEnum
CREATE TYPE "situacao_gravacao_ligacao" AS ENUM ('SEM', 'ENVIANDO', 'PRONTA', 'FALHOU');

-- CreateEnum
CREATE TYPE "situacao_transcricao_ligacao" AS ENUM ('PENDENTE', 'PROCESSANDO', 'PRONTA', 'FALHOU', 'DESATIVADA');

-- CreateTable
CREATE TABLE "ligacoes" (
    "id" UUID NOT NULL,
    "canal_id" UUID NOT NULL,
    "contato_id" UUID NOT NULL,
    "conversa_id" UUID,
    "direcao" "direcao_ligacao" NOT NULL,
    "estado" "estado_ligacao" NOT NULL,
    "atendente_id" UUID,
    "id_meta" TEXT,
    "telefone" TEXT,
    "bsuid" TEXT,
    "oferta_sdp" TEXT,
    "resposta_sdp" TEXT,
    "expira_em" TIMESTAMPTZ(3),
    "iniciada_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tocou_em" TIMESTAMPTZ(3),
    "atendida_em" TIMESTAMPTZ(3),
    "encerrada_em" TIMESTAMPTZ(3),
    "duracao_segundos" INTEGER,
    "motivo" TEXT,
    "erro_codigo" INTEGER,
    "erro_mensagem" TEXT,
    "atividade_id" UUID,
    "anotacao" TEXT,
    "tocou_para" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "encerramento_solicitado_em" TIMESTAMPTZ(3),
    "desconectado_em" TIMESTAMPTZ(3),
    "gravar" BOOLEAN NOT NULL DEFAULT false,
    "gravacao_situacao" "situacao_gravacao_ligacao" NOT NULL DEFAULT 'SEM',
    "gravacao_arquivo_id" UUID,
    "transcricao_situacao" "situacao_transcricao_ligacao",
    "transcricao" JSONB,
    "resumo" JSONB,
    "criado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ligacoes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permissoes_de_ligacao" (
    "id" UUID NOT NULL,
    "canal_id" UUID NOT NULL,
    "contato_id" UUID NOT NULL,
    "situacao" "situacao_permissao_ligacao" NOT NULL DEFAULT 'NENHUMA',
    "tipo" "tipo_permissao_ligacao",
    "valida_ate" TIMESTAMPTZ(3),
    "pedidos_em" TIMESTAMPTZ(3)[] DEFAULT ARRAY[]::TIMESTAMPTZ(3)[],
    "ultimo_pedido_mensagem_id" TEXT,
    "respondida_em" TIMESTAMPTZ(3),
    "sem_resposta_seguidas" INTEGER NOT NULL DEFAULT 0,
    "consultada_em" TIMESTAMPTZ(3),
    "limites_da_meta" JSONB,
    "criado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "permissoes_de_ligacao_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "canais_ligacoes" (
    "id" UUID NOT NULL,
    "canal_id" UUID NOT NULL,
    "ativa" BOOLEAN NOT NULL DEFAULT false,
    "botao_visivel" BOOLEAN NOT NULL DEFAULT true,
    "horario" JSONB,
    "fila_id" UUID,
    "gravar" BOOLEAN NOT NULL DEFAULT true,
    "tempo_de_toque_segundos" INTEGER NOT NULL DEFAULT 25,
    "mensagem_perdida_ativa" BOOLEAN NOT NULL DEFAULT false,
    "mensagem_perdida" TEXT,
    "sincronizada_em" TIMESTAMPTZ(3),
    "ultimo_erro_meta" TEXT,
    "atualizado_por_id" UUID,
    "criado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "canais_ligacoes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ligacoes_webhook_eventos" (
    "id" UUID NOT NULL,
    "chave" TEXT NOT NULL,
    "recebido_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ligacoes_webhook_eventos_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ligacoes_estado_criado_em_idx" ON "ligacoes"("estado", "criado_em");

-- CreateIndex
CREATE INDEX "ligacoes_contato_id_criado_em_idx" ON "ligacoes"("contato_id", "criado_em");

-- CreateIndex
CREATE INDEX "ligacoes_atendente_id_criado_em_idx" ON "ligacoes"("atendente_id", "criado_em");

-- CreateIndex
CREATE INDEX "ligacoes_canal_id_criado_em_idx" ON "ligacoes"("canal_id", "criado_em");

-- CreateIndex
CREATE INDEX "ligacoes_conversa_id_idx" ON "ligacoes"("conversa_id");

-- CreateIndex
CREATE UNIQUE INDEX "ligacoes_canal_id_meta_key" ON "ligacoes"("canal_id", "id_meta") WHERE (id_meta IS NOT NULL);

-- CreateIndex
CREATE UNIQUE INDEX "ligacoes_uma_ativa_por_atendente_key" ON "ligacoes"("atendente_id") WHERE ((atendente_id IS NOT NULL) AND (estado IN ('CHAMANDO'::estado_ligacao, 'TOCANDO'::estado_ligacao, 'EM_ANDAMENTO'::estado_ligacao)));

-- CreateIndex
CREATE INDEX "permissoes_de_ligacao_contato_id_idx" ON "permissoes_de_ligacao"("contato_id");

-- CreateIndex
CREATE UNIQUE INDEX "permissoes_de_ligacao_canal_id_contato_id_key" ON "permissoes_de_ligacao"("canal_id", "contato_id");

-- CreateIndex
CREATE UNIQUE INDEX "canais_ligacoes_canal_id_key" ON "canais_ligacoes"("canal_id");

-- CreateIndex
CREATE UNIQUE INDEX "ligacoes_webhook_eventos_chave_key" ON "ligacoes_webhook_eventos"("chave");

-- CreateIndex
CREATE INDEX "ligacoes_webhook_eventos_recebido_em_idx" ON "ligacoes_webhook_eventos"("recebido_em");

-- AddForeignKey
ALTER TABLE "ligacoes" ADD CONSTRAINT "ligacoes_canal_id_fkey" FOREIGN KEY ("canal_id") REFERENCES "canais"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ligacoes" ADD CONSTRAINT "ligacoes_contato_id_fkey" FOREIGN KEY ("contato_id") REFERENCES "contatos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ligacoes" ADD CONSTRAINT "ligacoes_conversa_id_fkey" FOREIGN KEY ("conversa_id") REFERENCES "conversas"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ligacoes" ADD CONSTRAINT "ligacoes_atendente_id_fkey" FOREIGN KEY ("atendente_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ligacoes" ADD CONSTRAINT "ligacoes_atividade_id_fkey" FOREIGN KEY ("atividade_id") REFERENCES "atividades"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "permissoes_de_ligacao" ADD CONSTRAINT "permissoes_de_ligacao_canal_id_fkey" FOREIGN KEY ("canal_id") REFERENCES "canais"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "permissoes_de_ligacao" ADD CONSTRAINT "permissoes_de_ligacao_contato_id_fkey" FOREIGN KEY ("contato_id") REFERENCES "contatos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "canais_ligacoes" ADD CONSTRAINT "canais_ligacoes_canal_id_fkey" FOREIGN KEY ("canal_id") REFERENCES "canais"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "canais_ligacoes" ADD CONSTRAINT "canais_ligacoes_fila_id_fkey" FOREIGN KEY ("fila_id") REFERENCES "filas_atendimento"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "canais_ligacoes" ADD CONSTRAINT "canais_ligacoes_atualizado_por_id_fkey" FOREIGN KEY ("atualizado_por_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;
