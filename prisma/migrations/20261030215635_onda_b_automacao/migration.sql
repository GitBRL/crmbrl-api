-- CreateEnum
CREATE TYPE "tipo_importacao" AS ENUM ('CONTATOS', 'EMPRESAS');

-- CreateEnum
CREATE TYPE "status_importacao" AS ENUM ('RASCUNHO', 'NA_FILA', 'PROCESSANDO', 'CONCLUIDA', 'FALHOU', 'CANCELADA');

-- CreateEnum
CREATE TYPE "acao_duplicado" AS ENUM ('ATUALIZAR_VAZIOS', 'IGNORAR', 'SOBRESCREVER');

-- CreateEnum
CREATE TYPE "resultado_linha_importacao" AS ENUM ('CRIADO', 'ATUALIZADO', 'IGNORADO', 'ERRO');

-- CreateEnum
CREATE TYPE "status_campanha" AS ENUM ('RASCUNHO', 'AGUARDANDO_APROVACAO', 'AGENDADA', 'EM_ANDAMENTO', 'PAUSADA', 'CONCLUIDA', 'CANCELADA');

-- CreateEnum
CREATE TYPE "tipo_publico" AS ENUM ('SEGMENTO', 'IMPORTACAO');

-- CreateEnum
CREATE TYPE "status_destinatario" AS ENUM ('PENDENTE', 'ENVIANDO', 'ENVIADO', 'FALHOU', 'INVALIDO', 'EXCLUIDO');

-- CreateEnum
CREATE TYPE "gatilho_fluxo" AS ENUM ('NOVA_CONVERSA', 'PALAVRA_CHAVE', 'FORA_DO_HORARIO', 'SEMPRE');

-- CreateEnum
CREATE TYPE "tipo_execucao" AS ENUM ('CHATBOT', 'AUTOMACAO');

-- CreateEnum
CREATE TYPE "status_execucao" AS ENUM ('EM_ANDAMENTO', 'AGUARDANDO', 'CONCLUIDA', 'FALHOU', 'CANCELADA');

-- CreateEnum
CREATE TYPE "status_passo" AS ENUM ('EXECUTANDO', 'AGUARDANDO', 'CONCLUIDO', 'ERRO');

-- CreateEnum
CREATE TYPE "tipo_gatilho_automacao" AS ENUM ('EVENTO', 'DATA_RELATIVA', 'RECORRENCIA');

-- CreateEnum
CREATE TYPE "limite_execucao" AS ENUM ('UMA_VEZ', 'UMA_VEZ_POR_PERIODO', 'SEMPRE');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "contexto_arquivo" ADD VALUE 'CAMPANHA';
ALTER TYPE "contexto_arquivo" ADD VALUE 'RELATORIO';

-- AlterEnum
ALTER TYPE "tipo_ator" ADD VALUE 'BOT';

-- AlterTable
ALTER TABLE "eventos_dominio" ADD COLUMN     "cadeia" JSONB;

-- CreateTable
CREATE TABLE "configuracoes" (
    "chave" TEXT NOT NULL,
    "valor" JSONB NOT NULL DEFAULT '{}',
    "atualizado_por_id" UUID,
    "criado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "configuracoes_pkey" PRIMARY KEY ("chave")
);

-- CreateTable
CREATE TABLE "importacoes" (
    "id" UUID NOT NULL,
    "tipo" "tipo_importacao" NOT NULL DEFAULT 'CONTATOS',
    "status" "status_importacao" NOT NULL DEFAULT 'RASCUNHO',
    "nome" TEXT NOT NULL,
    "arquivo_id" UUID NOT NULL,
    "formato" TEXT NOT NULL,
    "leitura" JSONB NOT NULL DEFAULT '{}',
    "colunas" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "total_linhas" INTEGER,
    "mapeamento" JSONB NOT NULL DEFAULT '{}',
    "modelo_id" UUID,
    "duplicados" "acao_duplicado" NOT NULL DEFAULT 'ATUALIZAR_VAZIOS',
    "etiquetas" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "estrategia_responsavel" "estrategia_distribuicao",
    "responsavel_id" UUID,
    "area_rodizio" "area",
    "origem_detalhe" TEXT,
    "opcoes" JSONB NOT NULL DEFAULT '{}',
    "processadas" INTEGER NOT NULL DEFAULT 0,
    "criados" INTEGER NOT NULL DEFAULT 0,
    "atualizados" INTEGER NOT NULL DEFAULT 0,
    "ignorados" INTEGER NOT NULL DEFAULT 0,
    "erros" INTEGER NOT NULL DEFAULT 0,
    "relatorio_id" UUID,
    "erro" TEXT,
    "iniciada_em" TIMESTAMPTZ(3),
    "concluida_em" TIMESTAMPTZ(3),
    "criado_por_id" UUID,
    "criado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "importacoes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "importacao_linhas" (
    "id" UUID NOT NULL,
    "importacao_id" UUID NOT NULL,
    "numero" INTEGER NOT NULL,
    "resultado" "resultado_linha_importacao" NOT NULL,
    "entidade_id" UUID,
    "motivo" TEXT,
    "dados" JSONB,
    "criado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "importacao_linhas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "importacao_modelos" (
    "id" UUID NOT NULL,
    "nome" TEXT NOT NULL,
    "tipo" "tipo_importacao" NOT NULL DEFAULT 'CONTATOS',
    "mapeamento" JSONB NOT NULL DEFAULT '{}',
    "opcoes" JSONB NOT NULL DEFAULT '{}',
    "criado_por_id" UUID,
    "criado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "importacao_modelos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "modelos_mensagem" (
    "id" UUID NOT NULL,
    "nome" TEXT NOT NULL,
    "canal" "tipo_canal",
    "assunto" TEXT,
    "texto" TEXT NOT NULL,
    "arquivo_id" UUID,
    "area" "area",
    "criado_por_id" UUID,
    "criado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMPTZ(3) NOT NULL,
    "excluido_em" TIMESTAMPTZ(3),

    CONSTRAINT "modelos_mensagem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campanhas" (
    "id" UUID NOT NULL,
    "nome" TEXT NOT NULL,
    "descricao" TEXT,
    "area" "area",
    "canal" "tipo_canal" NOT NULL,
    "status" "status_campanha" NOT NULL DEFAULT 'RASCUNHO',
    "tipo_publico" "tipo_publico" NOT NULL DEFAULT 'SEGMENTO',
    "segmento" JSONB,
    "importacao_id" UUID,
    "modelo_id" UUID,
    "assunto" TEXT,
    "texto" TEXT NOT NULL DEFAULT '',
    "arquivo_id" UUID,
    "intervalo_minimo_segundos" INTEGER NOT NULL DEFAULT 20,
    "intervalo_maximo_segundos" INTEGER NOT NULL DEFAULT 60,
    "lote_tamanho" INTEGER,
    "lote_pausa_segundos" INTEGER,
    "simular_digitando" BOOLEAN NOT NULL DEFAULT true,
    "janela_envio" JSONB,
    "pausar_apos_falhas" INTEGER NOT NULL DEFAULT 5,
    "agendada_para" TIMESTAMPTZ(3),
    "iniciada_em" TIMESTAMPTZ(3),
    "pausada_em" TIMESTAMPTZ(3),
    "pausa_motivo" TEXT,
    "concluida_em" TIMESTAMPTZ(3),
    "cancelada_em" TIMESTAMPTZ(3),
    "aprovacao_solicitada_em" TIMESTAMPTZ(3),
    "aprovada_por_id" UUID,
    "aprovada_em" TIMESTAMPTZ(3),
    "reprovacao_motivo" TEXT,
    "proximo_envio_em" TIMESTAMPTZ(3),
    "enviados_no_lote" INTEGER NOT NULL DEFAULT 0,
    "falhas_seguidas" INTEGER NOT NULL DEFAULT 0,
    "ultimo_canal_id" UUID,
    "total_destinatarios" INTEGER NOT NULL DEFAULT 0,
    "enviados" INTEGER NOT NULL DEFAULT 0,
    "entregues" INTEGER NOT NULL DEFAULT 0,
    "lidos" INTEGER NOT NULL DEFAULT 0,
    "respondidos" INTEGER NOT NULL DEFAULT 0,
    "falhas" INTEGER NOT NULL DEFAULT 0,
    "invalidos" INTEGER NOT NULL DEFAULT 0,
    "opt_outs" INTEGER NOT NULL DEFAULT 0,
    "campanha_origem_id" UUID,
    "criado_por_id" UUID,
    "criado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMPTZ(3) NOT NULL,
    "excluido_em" TIMESTAMPTZ(3),

    CONSTRAINT "campanhas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campanha_canais" (
    "id" UUID NOT NULL,
    "campanha_id" UUID NOT NULL,
    "canal_id" UUID NOT NULL,
    "ordem" INTEGER NOT NULL DEFAULT 0,
    "criado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "campanha_canais_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campanha_destinatarios" (
    "id" UUID NOT NULL,
    "campanha_id" UUID NOT NULL,
    "contato_id" UUID NOT NULL,
    "destino" TEXT NOT NULL,
    "ordem" INTEGER NOT NULL,
    "status" "status_destinatario" NOT NULL DEFAULT 'PENDENTE',
    "motivo" TEXT,
    "tentativas" INTEGER NOT NULL DEFAULT 0,
    "canal_id" UUID,
    "mensagem_id" UUID,
    "enviado_em" TIMESTAMPTZ(3),
    "entregue_em" TIMESTAMPTZ(3),
    "lido_em" TIMESTAMPTZ(3),
    "respondeu_em" TIMESTAMPTZ(3),
    "opt_out_em" TIMESTAMPTZ(3),
    "falhou_em" TIMESTAMPTZ(3),
    "criado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "campanha_destinatarios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fluxos_chatbot" (
    "id" UUID NOT NULL,
    "nome" TEXT NOT NULL,
    "descricao" TEXT,
    "area" "area",
    "canal_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "gatilho" "gatilho_fluxo" NOT NULL,
    "palavras_chave" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "prioridade" INTEGER NOT NULL DEFAULT 0,
    "ativo" BOOLEAN NOT NULL DEFAULT false,
    "rascunho" JSONB NOT NULL DEFAULT '{"passos": []}',
    "rascunho_alterado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "versao_publicada_id" UUID,
    "criado_por_id" UUID,
    "criado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMPTZ(3) NOT NULL,
    "excluido_em" TIMESTAMPTZ(3),

    CONSTRAINT "fluxos_chatbot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fluxos_chatbot_versoes" (
    "id" UUID NOT NULL,
    "fluxo_id" UUID NOT NULL,
    "numero" INTEGER NOT NULL,
    "definicao" JSONB NOT NULL,
    "publicada_por_id" UUID,
    "criado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fluxos_chatbot_versoes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automacoes" (
    "id" UUID NOT NULL,
    "nome" TEXT NOT NULL,
    "descricao" TEXT,
    "area" "area",
    "ativa" BOOLEAN NOT NULL DEFAULT false,
    "tipo_gatilho" "tipo_gatilho_automacao" NOT NULL,
    "evento" TEXT,
    "gatilho_config" JSONB NOT NULL DEFAULT '{}',
    "entidade" TEXT NOT NULL,
    "condicoes" JSONB NOT NULL DEFAULT '{}',
    "definicao" JSONB NOT NULL DEFAULT '{"passos": []}',
    "criterios_parada" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "limite_execucao" "limite_execucao" NOT NULL DEFAULT 'UMA_VEZ',
    "limite_periodo_dias" INTEGER,
    "marketing" BOOLEAN NOT NULL DEFAULT false,
    "modelo" TEXT,
    "versao" INTEGER NOT NULL DEFAULT 1,
    "proxima_execucao_em" TIMESTAMPTZ(3),
    "ultima_execucao_em" TIMESTAMPTZ(3),
    "criado_por_id" UUID,
    "criado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMPTZ(3) NOT NULL,
    "excluido_em" TIMESTAMPTZ(3),

    CONSTRAINT "automacoes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "execucoes" (
    "id" UUID NOT NULL,
    "tipo" "tipo_execucao" NOT NULL,
    "nome" TEXT NOT NULL,
    "automacao_id" UUID,
    "automacao_versao" INTEGER,
    "fluxo_id" UUID,
    "fluxo_versao_id" UUID,
    "definicao" JSONB NOT NULL,
    "status" "status_execucao" NOT NULL DEFAULT 'EM_ANDAMENTO',
    "passo_atual_id" TEXT,
    "visita_atual" INTEGER NOT NULL DEFAULT 1,
    "visitas" JSONB NOT NULL DEFAULT '{}',
    "variaveis" JSONB NOT NULL DEFAULT '{}',
    "contexto" JSONB NOT NULL DEFAULT '{}',
    "entidade" TEXT,
    "entidade_id" UUID,
    "contato_id" UUID,
    "negocio_id" UUID,
    "conversa_id" UUID,
    "evento_id" UUID,
    "chave_unica" TEXT,
    "cadeia" JSONB NOT NULL DEFAULT '{}',
    "teste" BOOLEAN NOT NULL DEFAULT false,
    "aguardando_ate" TIMESTAMPTZ(3),
    "aguardando_entrada" BOOLEAN NOT NULL DEFAULT false,
    "espera_token" TEXT,
    "travada_ate" TIMESTAMPTZ(3),
    "trava" TEXT,
    "passos_executados" INTEGER NOT NULL DEFAULT 0,
    "erro" TEXT,
    "motivo_fim" TEXT,
    "iniciada_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "concluida_em" TIMESTAMPTZ(3),
    "criado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "execucoes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "execucao_passos" (
    "id" UUID NOT NULL,
    "execucao_id" UUID NOT NULL,
    "passo_id" TEXT NOT NULL,
    "tipo" TEXT NOT NULL,
    "visita" INTEGER NOT NULL,
    "chave" TEXT NOT NULL,
    "ordem" INTEGER NOT NULL,
    "status" "status_passo" NOT NULL DEFAULT 'EXECUTANDO',
    "tentativas" INTEGER NOT NULL DEFAULT 1,
    "resultado" JSONB,
    "erro" TEXT,
    "iniciado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "concluido_em" TIMESTAMPTZ(3),
    "criado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "execucao_passos_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "importacoes_criado_por_id_criado_em_idx" ON "importacoes"("criado_por_id", "criado_em");

-- CreateIndex
CREATE INDEX "importacoes_status_idx" ON "importacoes"("status");

-- CreateIndex
CREATE INDEX "importacao_linhas_importacao_id_resultado_idx" ON "importacao_linhas"("importacao_id", "resultado");

-- CreateIndex
CREATE INDEX "importacao_linhas_entidade_id_idx" ON "importacao_linhas"("entidade_id");

-- CreateIndex
CREATE UNIQUE INDEX "importacao_linhas_importacao_id_numero_key" ON "importacao_linhas"("importacao_id", "numero");

-- CreateIndex
CREATE UNIQUE INDEX "importacao_modelos_tipo_nome_key" ON "importacao_modelos"("tipo", "nome");

-- CreateIndex
CREATE INDEX "modelos_mensagem_area_idx" ON "modelos_mensagem"("area");

-- CreateIndex
CREATE INDEX "campanhas_status_agendada_para_idx" ON "campanhas"("status", "agendada_para");

-- CreateIndex
CREATE INDEX "campanhas_criado_por_id_criado_em_idx" ON "campanhas"("criado_por_id", "criado_em");

-- CreateIndex
CREATE INDEX "campanhas_area_criado_em_idx" ON "campanhas"("area", "criado_em");

-- CreateIndex
CREATE INDEX "campanha_canais_canal_id_idx" ON "campanha_canais"("canal_id");

-- CreateIndex
CREATE UNIQUE INDEX "campanha_canais_campanha_id_canal_id_key" ON "campanha_canais"("campanha_id", "canal_id");

-- CreateIndex
CREATE UNIQUE INDEX "campanha_destinatarios_mensagem_id_key" ON "campanha_destinatarios"("mensagem_id");

-- CreateIndex
CREATE INDEX "campanha_destinatarios_campanha_id_status_ordem_idx" ON "campanha_destinatarios"("campanha_id", "status", "ordem");

-- CreateIndex
CREATE INDEX "campanha_destinatarios_contato_id_enviado_em_idx" ON "campanha_destinatarios"("contato_id", "enviado_em");

-- CreateIndex
CREATE INDEX "campanha_destinatarios_canal_id_enviado_em_idx" ON "campanha_destinatarios"("canal_id", "enviado_em");

-- CreateIndex
CREATE UNIQUE INDEX "campanha_destinatarios_campanha_id_contato_id_key" ON "campanha_destinatarios"("campanha_id", "contato_id");

-- CreateIndex
CREATE UNIQUE INDEX "fluxos_chatbot_versao_publicada_id_key" ON "fluxos_chatbot"("versao_publicada_id");

-- CreateIndex
CREATE INDEX "fluxos_chatbot_ativo_gatilho_prioridade_idx" ON "fluxos_chatbot"("ativo", "gatilho", "prioridade");

-- CreateIndex
CREATE UNIQUE INDEX "fluxos_chatbot_versoes_fluxo_id_numero_key" ON "fluxos_chatbot_versoes"("fluxo_id", "numero");

-- CreateIndex
CREATE INDEX "automacoes_ativa_tipo_gatilho_evento_idx" ON "automacoes"("ativa", "tipo_gatilho", "evento");

-- CreateIndex
CREATE INDEX "automacoes_ativa_proxima_execucao_em_idx" ON "automacoes"("ativa", "proxima_execucao_em");

-- CreateIndex
CREATE UNIQUE INDEX "execucoes_chave_unica_key" ON "execucoes"("chave_unica");

-- CreateIndex
CREATE INDEX "execucoes_status_aguardando_ate_idx" ON "execucoes"("status", "aguardando_ate");

-- CreateIndex
CREATE INDEX "execucoes_automacao_id_entidade_id_criado_em_idx" ON "execucoes"("automacao_id", "entidade_id", "criado_em");

-- CreateIndex
CREATE INDEX "execucoes_fluxo_id_criado_em_idx" ON "execucoes"("fluxo_id", "criado_em");

-- CreateIndex
CREATE INDEX "execucoes_conversa_id_status_idx" ON "execucoes"("conversa_id", "status");

-- CreateIndex
CREATE INDEX "execucoes_contato_id_criado_em_idx" ON "execucoes"("contato_id", "criado_em");

-- CreateIndex
CREATE INDEX "execucoes_negocio_id_idx" ON "execucoes"("negocio_id");

-- CreateIndex
CREATE INDEX "execucao_passos_execucao_id_ordem_idx" ON "execucao_passos"("execucao_id", "ordem");

-- CreateIndex
CREATE UNIQUE INDEX "execucao_passos_execucao_id_chave_key" ON "execucao_passos"("execucao_id", "chave");

-- AddForeignKey
ALTER TABLE "configuracoes" ADD CONSTRAINT "configuracoes_atualizado_por_id_fkey" FOREIGN KEY ("atualizado_por_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "importacoes" ADD CONSTRAINT "importacoes_arquivo_id_fkey" FOREIGN KEY ("arquivo_id") REFERENCES "arquivos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "importacoes" ADD CONSTRAINT "importacoes_modelo_id_fkey" FOREIGN KEY ("modelo_id") REFERENCES "importacao_modelos"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "importacoes" ADD CONSTRAINT "importacoes_responsavel_id_fkey" FOREIGN KEY ("responsavel_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "importacoes" ADD CONSTRAINT "importacoes_relatorio_id_fkey" FOREIGN KEY ("relatorio_id") REFERENCES "arquivos"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "importacoes" ADD CONSTRAINT "importacoes_criado_por_id_fkey" FOREIGN KEY ("criado_por_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "importacao_linhas" ADD CONSTRAINT "importacao_linhas_importacao_id_fkey" FOREIGN KEY ("importacao_id") REFERENCES "importacoes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "importacao_modelos" ADD CONSTRAINT "importacao_modelos_criado_por_id_fkey" FOREIGN KEY ("criado_por_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "modelos_mensagem" ADD CONSTRAINT "modelos_mensagem_arquivo_id_fkey" FOREIGN KEY ("arquivo_id") REFERENCES "arquivos"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "modelos_mensagem" ADD CONSTRAINT "modelos_mensagem_criado_por_id_fkey" FOREIGN KEY ("criado_por_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campanhas" ADD CONSTRAINT "campanhas_importacao_id_fkey" FOREIGN KEY ("importacao_id") REFERENCES "importacoes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campanhas" ADD CONSTRAINT "campanhas_modelo_id_fkey" FOREIGN KEY ("modelo_id") REFERENCES "modelos_mensagem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campanhas" ADD CONSTRAINT "campanhas_arquivo_id_fkey" FOREIGN KEY ("arquivo_id") REFERENCES "arquivos"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campanhas" ADD CONSTRAINT "campanhas_aprovada_por_id_fkey" FOREIGN KEY ("aprovada_por_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campanhas" ADD CONSTRAINT "campanhas_campanha_origem_id_fkey" FOREIGN KEY ("campanha_origem_id") REFERENCES "campanhas"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campanhas" ADD CONSTRAINT "campanhas_criado_por_id_fkey" FOREIGN KEY ("criado_por_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campanha_canais" ADD CONSTRAINT "campanha_canais_campanha_id_fkey" FOREIGN KEY ("campanha_id") REFERENCES "campanhas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campanha_canais" ADD CONSTRAINT "campanha_canais_canal_id_fkey" FOREIGN KEY ("canal_id") REFERENCES "canais"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campanha_destinatarios" ADD CONSTRAINT "campanha_destinatarios_campanha_id_fkey" FOREIGN KEY ("campanha_id") REFERENCES "campanhas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campanha_destinatarios" ADD CONSTRAINT "campanha_destinatarios_contato_id_fkey" FOREIGN KEY ("contato_id") REFERENCES "contatos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campanha_destinatarios" ADD CONSTRAINT "campanha_destinatarios_canal_id_fkey" FOREIGN KEY ("canal_id") REFERENCES "canais"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campanha_destinatarios" ADD CONSTRAINT "campanha_destinatarios_mensagem_id_fkey" FOREIGN KEY ("mensagem_id") REFERENCES "mensagens"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fluxos_chatbot" ADD CONSTRAINT "fluxos_chatbot_versao_publicada_id_fkey" FOREIGN KEY ("versao_publicada_id") REFERENCES "fluxos_chatbot_versoes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fluxos_chatbot" ADD CONSTRAINT "fluxos_chatbot_criado_por_id_fkey" FOREIGN KEY ("criado_por_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fluxos_chatbot_versoes" ADD CONSTRAINT "fluxos_chatbot_versoes_fluxo_id_fkey" FOREIGN KEY ("fluxo_id") REFERENCES "fluxos_chatbot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fluxos_chatbot_versoes" ADD CONSTRAINT "fluxos_chatbot_versoes_publicada_por_id_fkey" FOREIGN KEY ("publicada_por_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automacoes" ADD CONSTRAINT "automacoes_criado_por_id_fkey" FOREIGN KEY ("criado_por_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "execucoes" ADD CONSTRAINT "execucoes_automacao_id_fkey" FOREIGN KEY ("automacao_id") REFERENCES "automacoes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "execucoes" ADD CONSTRAINT "execucoes_fluxo_id_fkey" FOREIGN KEY ("fluxo_id") REFERENCES "fluxos_chatbot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "execucoes" ADD CONSTRAINT "execucoes_fluxo_versao_id_fkey" FOREIGN KEY ("fluxo_versao_id") REFERENCES "fluxos_chatbot_versoes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "execucoes" ADD CONSTRAINT "execucoes_contato_id_fkey" FOREIGN KEY ("contato_id") REFERENCES "contatos"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "execucoes" ADD CONSTRAINT "execucoes_negocio_id_fkey" FOREIGN KEY ("negocio_id") REFERENCES "negocios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "execucoes" ADD CONSTRAINT "execucoes_conversa_id_fkey" FOREIGN KEY ("conversa_id") REFERENCES "conversas"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "execucao_passos" ADD CONSTRAINT "execucao_passos_execucao_id_fkey" FOREIGN KEY ("execucao_id") REFERENCES "execucoes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Acréscimos escritos à mão (o Prisma não gera CHECKs).
-- ---------------------------------------------------------------------------

-- Importação (R16): até 50 mil linhas; contagens nunca negativas.
ALTER TABLE "importacoes" ADD CONSTRAINT "importacoes_formato_check" CHECK ("formato" IN ('csv', 'xlsx'));
ALTER TABLE "importacoes" ADD CONSTRAINT "importacoes_total_linhas_check" CHECK ("total_linhas" IS NULL OR "total_linhas" BETWEEN 0 AND 50000);
ALTER TABLE "importacoes" ADD CONSTRAINT "importacoes_contagens_check" CHECK (
  "processadas" >= 0 AND "criados" >= 0 AND "atualizados" >= 0 AND "ignorados" >= 0 AND "erros" >= 0
);
ALTER TABLE "importacoes" ADD CONSTRAINT "importacoes_responsavel_check" CHECK (
  ("estrategia_responsavel" IS DISTINCT FROM 'RESPONSAVEL_FIXO' OR "responsavel_id" IS NOT NULL)
  AND ("estrategia_responsavel" IS DISTINCT FROM 'RODIZIO' OR "area_rodizio" IS NOT NULL)
);
ALTER TABLE "importacao_linhas" ADD CONSTRAINT "importacao_linhas_numero_check" CHECK ("numero" >= 1);

-- Modelos de mensagem e campanhas: só WhatsApp e e-mail.
ALTER TABLE "modelos_mensagem" ADD CONSTRAINT "modelos_mensagem_canal_check" CHECK ("canal" IS NULL OR "canal" IN ('WHATSAPP', 'EMAIL'));
ALTER TABLE "campanhas" ADD CONSTRAINT "campanhas_canal_check" CHECK ("canal" IN ('WHATSAPP', 'EMAIL'));

-- Disparos (R17): ritmo coerente e contadores nunca negativos.
ALTER TABLE "campanhas" ADD CONSTRAINT "campanhas_ritmo_check" CHECK (
  "intervalo_minimo_segundos" >= 1
  AND "intervalo_maximo_segundos" >= "intervalo_minimo_segundos"
  AND ("lote_tamanho" IS NULL OR "lote_tamanho" >= 1)
  AND ("lote_pausa_segundos" IS NULL OR "lote_pausa_segundos" >= 0)
  AND "pausar_apos_falhas" >= 1
);
ALTER TABLE "campanhas" ADD CONSTRAINT "campanhas_contadores_check" CHECK (
  "total_destinatarios" >= 0 AND "enviados" >= 0 AND "entregues" >= 0 AND "lidos" >= 0
  AND "respondidos" >= 0 AND "falhas" >= 0 AND "invalidos" >= 0 AND "opt_outs" >= 0
  AND "enviados_no_lote" >= 0 AND "falhas_seguidas" >= 0
);
ALTER TABLE "campanha_destinatarios" ADD CONSTRAINT "campanha_destinatarios_tentativas_check" CHECK ("tentativas" >= 0);

-- Chatbot (R18): versões numeradas a partir de 1.
ALTER TABLE "fluxos_chatbot_versoes" ADD CONSTRAINT "fluxos_chatbot_versoes_numero_check" CHECK ("numero" >= 1);

-- Automações (R19): gatilho de evento com o tipo do evento; limite por período com os dias.
ALTER TABLE "automacoes" ADD CONSTRAINT "automacoes_evento_check" CHECK (("tipo_gatilho" = 'EVENTO') = ("evento" IS NOT NULL));
ALTER TABLE "automacoes" ADD CONSTRAINT "automacoes_entidade_check" CHECK ("entidade" IN ('contato', 'negocio', 'atividade', 'conversa'));
ALTER TABLE "automacoes" ADD CONSTRAINT "automacoes_limite_check" CHECK (
  ("limite_execucao" = 'UMA_VEZ_POR_PERIODO') = ("limite_periodo_dias" IS NOT NULL)
  AND ("limite_periodo_dias" IS NULL OR "limite_periodo_dias" >= 1)
);

-- Executor de passos.
ALTER TABLE "execucoes" ADD CONSTRAINT "execucoes_contadores_check" CHECK ("visita_atual" >= 1 AND "passos_executados" >= 0);
ALTER TABLE "execucoes" ADD CONSTRAINT "execucoes_espera_check" CHECK (
  "status" = 'AGUARDANDO' OR ("aguardando_ate" IS NULL AND NOT "aguardando_entrada")
);
ALTER TABLE "execucao_passos" ADD CONSTRAINT "execucao_passos_numeros_check" CHECK ("visita" >= 1 AND "ordem" >= 1 AND "tentativas" >= 1);
