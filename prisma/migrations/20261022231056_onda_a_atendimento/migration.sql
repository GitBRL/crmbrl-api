-- CreateEnum
CREATE TYPE "contexto_arquivo" AS ENUM ('MENSAGEM', 'CHAT', 'IMPORTACAO', 'AVATAR', 'OUTRO');

-- CreateEnum
CREATE TYPE "tipo_canal" AS ENUM ('WHATSAPP', 'WEBCHAT', 'EMAIL', 'INSTAGRAM', 'MESSENGER');

-- CreateEnum
CREATE TYPE "tipo_identificador" AS ENUM ('WHATSAPP', 'WHATSAPP_LID', 'EMAIL', 'INSTAGRAM', 'MESSENGER', 'WEBCHAT');

-- CreateEnum
CREATE TYPE "status_conversa" AS ENUM ('ABERTA', 'PENDENTE', 'RESOLVIDA');

-- CreateEnum
CREATE TYPE "prioridade_conversa" AS ENUM ('BAIXA', 'NORMAL', 'ALTA', 'URGENTE');

-- CreateEnum
CREATE TYPE "direcao_mensagem" AS ENUM ('ENTRADA', 'SAIDA', 'INTERNA', 'SISTEMA');

-- CreateEnum
CREATE TYPE "tipo_mensagem" AS ENUM ('TEXTO', 'IMAGEM', 'AUDIO', 'VIDEO', 'DOCUMENTO', 'LOCALIZACAO', 'CONTATO', 'FIGURINHA', 'REACAO');

-- CreateEnum
CREATE TYPE "status_mensagem" AS ENUM ('PENDENTE', 'ENVIADA', 'ENTREGUE', 'LIDA', 'FALHOU');

-- CreateEnum
CREATE TYPE "estrategia_fila" AS ENUM ('RODIZIO', 'MENOR_CARGA', 'MANUAL');

-- CreateEnum
CREATE TYPE "status_whatsapp" AS ENUM ('DESCONECTADO', 'AGUARDANDO_QR', 'CONECTANDO', 'CONECTADO', 'ERRO', 'BANIDO');

-- CreateEnum
CREATE TYPE "motivo_atribuicao" AS ENUM ('DISTRIBUICAO', 'ASSUMIDA', 'TRANSFERENCIA', 'DESLIGAMENTO', 'REABERTURA', 'MANUAL');

-- CreateEnum
CREATE TYPE "tipo_chat_canal" AS ENUM ('GERAL', 'AREA', 'GRUPO', 'DIRETO');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "origem_contato" ADD VALUE 'EMAIL';
ALTER TYPE "origem_contato" ADD VALUE 'INSTAGRAM';
ALTER TYPE "origem_contato" ADD VALUE 'MESSENGER';

-- AlterTable
ALTER TABLE "usuarios" ADD COLUMN     "acesso_ativado_em" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "arquivos" (
    "id" UUID NOT NULL,
    "chave" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "tamanho" INTEGER NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "contexto" "contexto_arquivo" NOT NULL,
    "largura" INTEGER,
    "altura" INTEGER,
    "duracao_segundos" INTEGER,
    "criado_por_id" UUID,
    "criado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMPTZ(3) NOT NULL,
    "removido_em" TIMESTAMPTZ(3),

    CONSTRAINT "arquivos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "canais" (
    "id" UUID NOT NULL,
    "tipo" "tipo_canal" NOT NULL,
    "nome" TEXT NOT NULL,
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "id_externo" TEXT,
    "configuracao" JSONB NOT NULL DEFAULT '{}',
    "segredos_cifrados" TEXT,
    "estado" JSONB NOT NULL DEFAULT '{}',
    "ultimo_erro" TEXT,
    "ultimo_erro_em" TIMESTAMPTZ(3),
    "fila_padrao_id" UUID,
    "horario_atendimento" JSONB,
    "mensagem_fora_horario" TEXT,
    "pesquisa_satisfacao" BOOLEAN NOT NULL DEFAULT false,
    "mensagem_satisfacao" TEXT,
    "criado_por_id" UUID,
    "criado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMPTZ(3) NOT NULL,
    "excluido_em" TIMESTAMPTZ(3),

    CONSTRAINT "canais_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "filas_atendimento" (
    "id" UUID NOT NULL,
    "chave" TEXT,
    "nome" TEXT NOT NULL,
    "area" "area" NOT NULL,
    "descricao" TEXT,
    "sla_primeira_resposta_minutos" INTEGER,
    "sla_resolucao_minutos" INTEGER,
    "estrategia" "estrategia_fila" NOT NULL DEFAULT 'RODIZIO',
    "ultimo_usuario_id" UUID,
    "ativa" BOOLEAN NOT NULL DEFAULT true,
    "criado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMPTZ(3) NOT NULL,
    "excluido_em" TIMESTAMPTZ(3),

    CONSTRAINT "filas_atendimento_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fila_participantes" (
    "id" UUID NOT NULL,
    "fila_id" UUID NOT NULL,
    "usuario_id" UUID NOT NULL,
    "participa" BOOLEAN NOT NULL DEFAULT true,
    "criado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "fila_participantes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contato_identificadores" (
    "id" UUID NOT NULL,
    "contato_id" UUID NOT NULL,
    "tipo" "tipo_identificador" NOT NULL,
    "valor" TEXT NOT NULL,
    "canal_id" UUID,
    "nome_exibicao" TEXT,
    "dados" JSONB,
    "ultimo_uso_em" TIMESTAMPTZ(3),
    "criado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "contato_identificadores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversas" (
    "id" UUID NOT NULL,
    "canal_id" UUID NOT NULL,
    "contato_id" UUID NOT NULL,
    "fila_id" UUID,
    "responsavel_id" UUID,
    "atribuida_em" TIMESTAMPTZ(3),
    "status" "status_conversa" NOT NULL DEFAULT 'ABERTA',
    "prioridade" "prioridade_conversa" NOT NULL DEFAULT 'NORMAL',
    "assunto" TEXT,
    "id_externo" TEXT,
    "etiquetas" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "negocio_id" UUID,
    "ultima_mensagem_id" UUID,
    "ultima_mensagem_em" TIMESTAMPTZ(3),
    "ultima_entrada_em" TIMESTAMPTZ(3),
    "aguardando_desde" TIMESTAMPTZ(3),
    "nao_lidas" INTEGER NOT NULL DEFAULT 0,
    "primeira_resposta_em" TIMESTAMPTZ(3),
    "resolvida_em" TIMESTAMPTZ(3),
    "resolvida_por_id" UUID,
    "reaberturas" INTEGER NOT NULL DEFAULT 0,
    "sla_primeira_resposta_ate" TIMESTAMPTZ(3),
    "sla_resolucao_ate" TIMESTAMPTZ(3),
    "sla_primeira_resposta_avisado_em" TIMESTAMPTZ(3),
    "sla_resolucao_avisado_em" TIMESTAMPTZ(3),
    "fora_horario_respondido_em" TIMESTAMPTZ(3),
    "satisfacao_solicitada_em" TIMESTAMPTZ(3),
    "satisfacao_nota" INTEGER,
    "satisfacao_comentario" TEXT,
    "satisfacao_respondida_em" TIMESTAMPTZ(3),
    "janela_ate" TIMESTAMPTZ(3),
    "criado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "conversas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mensagens" (
    "id" UUID NOT NULL,
    "conversa_id" UUID NOT NULL,
    "canal_id" UUID NOT NULL,
    "direcao" "direcao_mensagem" NOT NULL,
    "tipo" "tipo_mensagem" NOT NULL DEFAULT 'TEXTO',
    "texto" TEXT,
    "arquivo_id" UUID,
    "autor_id" UUID,
    "autor_tipo" "tipo_ator",
    "status" "status_mensagem",
    "erro" TEXT,
    "tentativas" INTEGER NOT NULL DEFAULT 0,
    "id_externo" TEXT,
    "resposta_a_id" UUID,
    "metadados" JSONB,
    "ocorrida_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "enviada_em" TIMESTAMPTZ(3),
    "entregue_em" TIMESTAMPTZ(3),
    "lida_em" TIMESTAMPTZ(3),
    "editada_em" TIMESTAMPTZ(3),
    "excluida_em" TIMESTAMPTZ(3),
    "criado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "mensagens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversa_atribuicoes" (
    "id" UUID NOT NULL,
    "conversa_id" UUID NOT NULL,
    "motivo" "motivo_atribuicao" NOT NULL,
    "de_usuario_id" UUID,
    "para_usuario_id" UUID,
    "de_fila_id" UUID,
    "para_fila_id" UUID,
    "nota" TEXT,
    "por_usuario_id" UUID,
    "tipo_ator" "tipo_ator" NOT NULL,
    "criado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversa_atribuicoes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "respostas_rapidas" (
    "id" UUID NOT NULL,
    "atalho" TEXT NOT NULL,
    "titulo" TEXT NOT NULL,
    "texto" TEXT NOT NULL,
    "area" "area",
    "arquivo_id" UUID,
    "ativa" BOOLEAN NOT NULL DEFAULT true,
    "criado_por_id" UUID,
    "criado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMPTZ(3) NOT NULL,
    "excluido_em" TIMESTAMPTZ(3),

    CONSTRAINT "respostas_rapidas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webchat_visitantes" (
    "id" UUID NOT NULL,
    "canal_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "contato_id" UUID,
    "conversa_id" UUID,
    "consentimento_em" TIMESTAMPTZ(3),
    "ip" TEXT,
    "user_agent" TEXT,
    "pagina" TEXT,
    "ultimo_acesso_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expira_em" TIMESTAMPTZ(3),
    "criado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "webchat_visitantes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_numeros" (
    "id" UUID NOT NULL,
    "canal_id" UUID NOT NULL,
    "nome" TEXT NOT NULL,
    "telefone" TEXT,
    "jid" TEXT,
    "lid" TEXT,
    "status" "status_whatsapp" NOT NULL DEFAULT 'DESCONECTADO',
    "motivo" TEXT,
    "limite_diario" INTEGER NOT NULL DEFAULT 1000,
    "intervalo_minimo_segundos" INTEGER NOT NULL DEFAULT 2,
    "intervalo_maximo_segundos" INTEGER NOT NULL DEFAULT 6,
    "aquecimento_inicio_em" TIMESTAMPTZ(3),
    "aquecimento_dias" INTEGER NOT NULL DEFAULT 14,
    "pausado_em" TIMESTAMPTZ(3),
    "pausa_motivo" TEXT,
    "configuracao" JSONB NOT NULL DEFAULT '{}',
    "tentativas_reconexao" INTEGER NOT NULL DEFAULT 0,
    "conectado_em" TIMESTAMPTZ(3),
    "desconectado_em" TIMESTAMPTZ(3),
    "ultimo_qr_em" TIMESTAMPTZ(3),
    "ultimo_evento_em" TIMESTAMPTZ(3),
    "criado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "whatsapp_numeros_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_chaves" (
    "numero_id" UUID NOT NULL,
    "tipo" TEXT NOT NULL,
    "chave_id" TEXT NOT NULL,
    "valor_cifrado" TEXT NOT NULL,
    "criado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "whatsapp_chaves_pkey" PRIMARY KEY ("numero_id","tipo","chave_id")
);

-- CreateTable
CREATE TABLE "whatsapp_envios_diarios" (
    "numero_id" UUID NOT NULL,
    "dia" DATE NOT NULL,
    "enviados" INTEGER NOT NULL DEFAULT 0,
    "falhas" INTEGER NOT NULL DEFAULT 0,
    "criado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "whatsapp_envios_diarios_pkey" PRIMARY KEY ("numero_id","dia")
);

-- CreateTable
CREATE TABLE "whatsapp_verificacoes" (
    "telefone" TEXT NOT NULL,
    "existe" BOOLEAN NOT NULL,
    "jid" TEXT,
    "lid" TEXT,
    "verificado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "whatsapp_verificacoes_pkey" PRIMARY KEY ("telefone")
);

-- CreateTable
CREATE TABLE "chat_canais" (
    "id" UUID NOT NULL,
    "tipo" "tipo_chat_canal" NOT NULL,
    "chave" TEXT,
    "nome" TEXT,
    "descricao" TEXT,
    "area" "area",
    "criado_por_id" UUID,
    "ultima_mensagem_em" TIMESTAMPTZ(3),
    "arquivado_em" TIMESTAMPTZ(3),
    "criado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "chat_canais_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_membros" (
    "id" UUID NOT NULL,
    "canal_id" UUID NOT NULL,
    "usuario_id" UUID NOT NULL,
    "administrador" BOOLEAN NOT NULL DEFAULT false,
    "automatico" BOOLEAN NOT NULL DEFAULT false,
    "silenciado" BOOLEAN NOT NULL DEFAULT false,
    "ultima_leitura_em" TIMESTAMPTZ(3),
    "criado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "chat_membros_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_mensagens" (
    "id" UUID NOT NULL,
    "canal_id" UUID NOT NULL,
    "autor_id" UUID,
    "texto" TEXT,
    "arquivo_id" UUID,
    "mencoes" UUID[] DEFAULT ARRAY[]::UUID[],
    "referencias" JSONB NOT NULL DEFAULT '[]',
    "resposta_a_id" UUID,
    "editada_em" TIMESTAMPTZ(3),
    "excluida_em" TIMESTAMPTZ(3),
    "criado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "chat_mensagens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "arquivos_chave_key" ON "arquivos"("chave");

-- CreateIndex
CREATE INDEX "arquivos_contexto_criado_em_idx" ON "arquivos"("contexto", "criado_em");

-- CreateIndex
CREATE INDEX "arquivos_criado_por_id_idx" ON "arquivos"("criado_por_id");

-- CreateIndex
CREATE INDEX "arquivos_sha256_idx" ON "arquivos"("sha256");

-- CreateIndex
CREATE INDEX "canais_tipo_ativo_idx" ON "canais"("tipo", "ativo");

-- CreateIndex
CREATE UNIQUE INDEX "canais_tipo_id_externo_ativo_key" ON "canais"("tipo", "id_externo") WHERE ((id_externo IS NOT NULL) AND (excluido_em IS NULL));

-- CreateIndex
CREATE UNIQUE INDEX "filas_atendimento_chave_key" ON "filas_atendimento"("chave");

-- CreateIndex
CREATE INDEX "filas_atendimento_area_ativa_idx" ON "filas_atendimento"("area", "ativa");

-- CreateIndex
CREATE INDEX "fila_participantes_usuario_id_idx" ON "fila_participantes"("usuario_id");

-- CreateIndex
CREATE UNIQUE INDEX "fila_participantes_fila_id_usuario_id_key" ON "fila_participantes"("fila_id", "usuario_id");

-- CreateIndex
CREATE INDEX "contato_identificadores_contato_id_idx" ON "contato_identificadores"("contato_id");

-- CreateIndex
CREATE UNIQUE INDEX "contato_identificadores_tipo_valor_key" ON "contato_identificadores"("tipo", "valor");

-- CreateIndex
CREATE UNIQUE INDEX "conversas_ultima_mensagem_id_key" ON "conversas"("ultima_mensagem_id");

-- CreateIndex
CREATE INDEX "conversas_status_fila_id_idx" ON "conversas"("status", "fila_id");

-- CreateIndex
CREATE INDEX "conversas_responsavel_id_status_idx" ON "conversas"("responsavel_id", "status");

-- CreateIndex
CREATE INDEX "conversas_contato_id_criado_em_idx" ON "conversas"("contato_id", "criado_em");

-- CreateIndex
CREATE INDEX "conversas_canal_id_id_externo_idx" ON "conversas"("canal_id", "id_externo");

-- CreateIndex
CREATE INDEX "conversas_status_ultima_mensagem_em_idx" ON "conversas"("status", "ultima_mensagem_em");

-- CreateIndex
CREATE INDEX "conversas_negocio_id_idx" ON "conversas"("negocio_id");

-- CreateIndex
CREATE UNIQUE INDEX "conversas_uma_em_aberto_key" ON "conversas"("canal_id", "contato_id") WHERE (status <> 'RESOLVIDA'::status_conversa);

-- CreateIndex
CREATE INDEX "mensagens_conversa_id_ocorrida_em_idx" ON "mensagens"("conversa_id", "ocorrida_em");

-- CreateIndex
CREATE INDEX "mensagens_autor_id_criado_em_idx" ON "mensagens"("autor_id", "criado_em");

-- CreateIndex
CREATE INDEX "mensagens_status_criado_em_idx" ON "mensagens"("status", "criado_em");

-- CreateIndex
CREATE UNIQUE INDEX "mensagens_canal_id_id_externo_key" ON "mensagens"("canal_id", "id_externo");

-- CreateIndex
CREATE INDEX "conversa_atribuicoes_conversa_id_criado_em_idx" ON "conversa_atribuicoes"("conversa_id", "criado_em");

-- CreateIndex
CREATE INDEX "conversa_atribuicoes_para_usuario_id_criado_em_idx" ON "conversa_atribuicoes"("para_usuario_id", "criado_em");

-- CreateIndex
CREATE UNIQUE INDEX "respostas_rapidas_atalho_global_key" ON "respostas_rapidas"("atalho") WHERE ((area IS NULL) AND (excluido_em IS NULL));

-- CreateIndex
CREATE UNIQUE INDEX "respostas_rapidas_area_atalho_key" ON "respostas_rapidas"("area", "atalho") WHERE ((area IS NOT NULL) AND (excluido_em IS NULL));

-- CreateIndex
CREATE UNIQUE INDEX "webchat_visitantes_token_hash_key" ON "webchat_visitantes"("token_hash");

-- CreateIndex
CREATE INDEX "webchat_visitantes_canal_id_ultimo_acesso_em_idx" ON "webchat_visitantes"("canal_id", "ultimo_acesso_em");

-- CreateIndex
CREATE INDEX "webchat_visitantes_contato_id_idx" ON "webchat_visitantes"("contato_id");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_numeros_canal_id_key" ON "whatsapp_numeros"("canal_id");

-- CreateIndex
CREATE INDEX "whatsapp_numeros_status_idx" ON "whatsapp_numeros"("status");

-- CreateIndex
CREATE INDEX "whatsapp_verificacoes_verificado_em_idx" ON "whatsapp_verificacoes"("verificado_em");

-- CreateIndex
CREATE UNIQUE INDEX "chat_canais_chave_key" ON "chat_canais"("chave");

-- CreateIndex
CREATE INDEX "chat_canais_tipo_idx" ON "chat_canais"("tipo");

-- CreateIndex
CREATE INDEX "chat_membros_usuario_id_idx" ON "chat_membros"("usuario_id");

-- CreateIndex
CREATE UNIQUE INDEX "chat_membros_canal_id_usuario_id_key" ON "chat_membros"("canal_id", "usuario_id");

-- CreateIndex
CREATE INDEX "chat_mensagens_canal_id_criado_em_idx" ON "chat_mensagens"("canal_id", "criado_em");

-- CreateIndex
CREATE INDEX "chat_mensagens_autor_id_criado_em_idx" ON "chat_mensagens"("autor_id", "criado_em");

-- CreateIndex
CREATE INDEX "chat_mensagens_mencoes_idx" ON "chat_mensagens" USING GIN ("mencoes");

-- AddForeignKey
ALTER TABLE "arquivos" ADD CONSTRAINT "arquivos_criado_por_id_fkey" FOREIGN KEY ("criado_por_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "canais" ADD CONSTRAINT "canais_fila_padrao_id_fkey" FOREIGN KEY ("fila_padrao_id") REFERENCES "filas_atendimento"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "canais" ADD CONSTRAINT "canais_criado_por_id_fkey" FOREIGN KEY ("criado_por_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "filas_atendimento" ADD CONSTRAINT "filas_atendimento_ultimo_usuario_id_fkey" FOREIGN KEY ("ultimo_usuario_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fila_participantes" ADD CONSTRAINT "fila_participantes_fila_id_fkey" FOREIGN KEY ("fila_id") REFERENCES "filas_atendimento"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fila_participantes" ADD CONSTRAINT "fila_participantes_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contato_identificadores" ADD CONSTRAINT "contato_identificadores_contato_id_fkey" FOREIGN KEY ("contato_id") REFERENCES "contatos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contato_identificadores" ADD CONSTRAINT "contato_identificadores_canal_id_fkey" FOREIGN KEY ("canal_id") REFERENCES "canais"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversas" ADD CONSTRAINT "conversas_canal_id_fkey" FOREIGN KEY ("canal_id") REFERENCES "canais"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversas" ADD CONSTRAINT "conversas_contato_id_fkey" FOREIGN KEY ("contato_id") REFERENCES "contatos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversas" ADD CONSTRAINT "conversas_fila_id_fkey" FOREIGN KEY ("fila_id") REFERENCES "filas_atendimento"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversas" ADD CONSTRAINT "conversas_responsavel_id_fkey" FOREIGN KEY ("responsavel_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversas" ADD CONSTRAINT "conversas_negocio_id_fkey" FOREIGN KEY ("negocio_id") REFERENCES "negocios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversas" ADD CONSTRAINT "conversas_ultima_mensagem_id_fkey" FOREIGN KEY ("ultima_mensagem_id") REFERENCES "mensagens"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversas" ADD CONSTRAINT "conversas_resolvida_por_id_fkey" FOREIGN KEY ("resolvida_por_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mensagens" ADD CONSTRAINT "mensagens_conversa_id_fkey" FOREIGN KEY ("conversa_id") REFERENCES "conversas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mensagens" ADD CONSTRAINT "mensagens_canal_id_fkey" FOREIGN KEY ("canal_id") REFERENCES "canais"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mensagens" ADD CONSTRAINT "mensagens_arquivo_id_fkey" FOREIGN KEY ("arquivo_id") REFERENCES "arquivos"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mensagens" ADD CONSTRAINT "mensagens_autor_id_fkey" FOREIGN KEY ("autor_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mensagens" ADD CONSTRAINT "mensagens_resposta_a_id_fkey" FOREIGN KEY ("resposta_a_id") REFERENCES "mensagens"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversa_atribuicoes" ADD CONSTRAINT "conversa_atribuicoes_conversa_id_fkey" FOREIGN KEY ("conversa_id") REFERENCES "conversas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversa_atribuicoes" ADD CONSTRAINT "conversa_atribuicoes_de_usuario_id_fkey" FOREIGN KEY ("de_usuario_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversa_atribuicoes" ADD CONSTRAINT "conversa_atribuicoes_para_usuario_id_fkey" FOREIGN KEY ("para_usuario_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversa_atribuicoes" ADD CONSTRAINT "conversa_atribuicoes_de_fila_id_fkey" FOREIGN KEY ("de_fila_id") REFERENCES "filas_atendimento"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversa_atribuicoes" ADD CONSTRAINT "conversa_atribuicoes_para_fila_id_fkey" FOREIGN KEY ("para_fila_id") REFERENCES "filas_atendimento"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversa_atribuicoes" ADD CONSTRAINT "conversa_atribuicoes_por_usuario_id_fkey" FOREIGN KEY ("por_usuario_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "respostas_rapidas" ADD CONSTRAINT "respostas_rapidas_arquivo_id_fkey" FOREIGN KEY ("arquivo_id") REFERENCES "arquivos"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "respostas_rapidas" ADD CONSTRAINT "respostas_rapidas_criado_por_id_fkey" FOREIGN KEY ("criado_por_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webchat_visitantes" ADD CONSTRAINT "webchat_visitantes_canal_id_fkey" FOREIGN KEY ("canal_id") REFERENCES "canais"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webchat_visitantes" ADD CONSTRAINT "webchat_visitantes_contato_id_fkey" FOREIGN KEY ("contato_id") REFERENCES "contatos"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webchat_visitantes" ADD CONSTRAINT "webchat_visitantes_conversa_id_fkey" FOREIGN KEY ("conversa_id") REFERENCES "conversas"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_numeros" ADD CONSTRAINT "whatsapp_numeros_canal_id_fkey" FOREIGN KEY ("canal_id") REFERENCES "canais"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_chaves" ADD CONSTRAINT "whatsapp_chaves_numero_id_fkey" FOREIGN KEY ("numero_id") REFERENCES "whatsapp_numeros"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_envios_diarios" ADD CONSTRAINT "whatsapp_envios_diarios_numero_id_fkey" FOREIGN KEY ("numero_id") REFERENCES "whatsapp_numeros"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_canais" ADD CONSTRAINT "chat_canais_criado_por_id_fkey" FOREIGN KEY ("criado_por_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_membros" ADD CONSTRAINT "chat_membros_canal_id_fkey" FOREIGN KEY ("canal_id") REFERENCES "chat_canais"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_membros" ADD CONSTRAINT "chat_membros_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_mensagens" ADD CONSTRAINT "chat_mensagens_canal_id_fkey" FOREIGN KEY ("canal_id") REFERENCES "chat_canais"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_mensagens" ADD CONSTRAINT "chat_mensagens_autor_id_fkey" FOREIGN KEY ("autor_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_mensagens" ADD CONSTRAINT "chat_mensagens_arquivo_id_fkey" FOREIGN KEY ("arquivo_id") REFERENCES "arquivos"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_mensagens" ADD CONSTRAINT "chat_mensagens_resposta_a_id_fkey" FOREIGN KEY ("resposta_a_id") REFERENCES "chat_mensagens"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ===========================================================================
-- Acréscimos escritos à mão (o Prisma não gera CHECKs nem gatilhos).
-- Os índices únicos parciais acima vêm do schema (preview `partialIndexes`).
-- ===========================================================================

-- R11: arquivos com tamanho, hash e medidas válidos.
ALTER TABLE "arquivos" ADD CONSTRAINT "arquivos_tamanho_check" CHECK ("tamanho" >= 0);
ALTER TABLE "arquivos" ADD CONSTRAINT "arquivos_sha256_check" CHECK ("sha256" ~ '^[0-9a-f]{64}$');
ALTER TABLE "arquivos" ADD CONSTRAINT "arquivos_medidas_check" CHECK (
  ("largura" IS NULL OR "largura" > 0) AND ("altura" IS NULL OR "altura" > 0)
  AND ("duracao_segundos" IS NULL OR "duracao_segundos" >= 0)
);

-- R12: SLA em minutos positivos; nota de satisfação de 1 a 5; contadores não negativos.
ALTER TABLE "filas_atendimento" ADD CONSTRAINT "filas_atendimento_sla_check" CHECK (
  ("sla_primeira_resposta_minutos" IS NULL OR "sla_primeira_resposta_minutos" > 0)
  AND ("sla_resolucao_minutos" IS NULL OR "sla_resolucao_minutos" > 0)
);
ALTER TABLE "conversas" ADD CONSTRAINT "conversas_satisfacao_nota_check" CHECK ("satisfacao_nota" IS NULL OR "satisfacao_nota" BETWEEN 1 AND 5);
ALTER TABLE "conversas" ADD CONSTRAINT "conversas_contadores_check" CHECK ("nao_lidas" >= 0 AND "reaberturas" >= 0);

-- R12: só a mensagem de saída tem status de entrega.
ALTER TABLE "mensagens" ADD CONSTRAINT "mensagens_status_so_na_saida_check" CHECK ("direcao" = 'SAIDA' OR "status" IS NULL);
ALTER TABLE "mensagens" ADD CONSTRAINT "mensagens_tentativas_check" CHECK ("tentativas" >= 0);

-- Respostas rápidas: atalho sem a barra, em minúsculas, sem espaços, até 40 caracteres.
ALTER TABLE "respostas_rapidas" ADD CONSTRAINT "respostas_rapidas_atalho_check" CHECK (
  "atalho" = lower(btrim("atalho")) AND "atalho" ~ '^[^[:space:]/]{1,40}$'
);

-- Identificadores normalizados como os campos do contato (R4.1): telefone em
-- E.164 só com dígitos, e-mail em minúsculas, nenhum valor vazio.
ALTER TABLE "contato_identificadores" ADD CONSTRAINT "contato_identificadores_valor_check" CHECK (
  btrim("valor") <> ''
  AND ("tipo" <> 'WHATSAPP' OR "valor" ~ '^[1-9][0-9]{7,14}$')
  AND ("tipo" <> 'EMAIL' OR "valor" = lower(btrim("valor")))
);

-- R13: limites e ritmo do gateway coerentes; telefone conectado em E.164.
ALTER TABLE "whatsapp_numeros" ADD CONSTRAINT "whatsapp_numeros_limites_check" CHECK (
  "limite_diario" > 0 AND "intervalo_minimo_segundos" >= 0
  AND "intervalo_maximo_segundos" >= "intervalo_minimo_segundos"
  AND "aquecimento_dias" >= 0 AND "tentativas_reconexao" >= 0
);
ALTER TABLE "whatsapp_numeros" ADD CONSTRAINT "whatsapp_numeros_telefone_check" CHECK ("telefone" IS NULL OR "telefone" ~ '^[1-9][0-9]{7,14}$');
ALTER TABLE "whatsapp_envios_diarios" ADD CONSTRAINT "whatsapp_envios_diarios_contagens_check" CHECK ("enviados" >= 0 AND "falhas" >= 0);
ALTER TABLE "whatsapp_verificacoes" ADD CONSTRAINT "whatsapp_verificacoes_telefone_check" CHECK ("telefone" ~ '^[1-9][0-9]{7,14}$');

-- R15: canal de área tem área (e só ele); grupo e canais do sistema têm nome.
ALTER TABLE "chat_canais" ADD CONSTRAINT "chat_canais_area_check" CHECK (("tipo" = 'AREA') = ("area" IS NOT NULL));
ALTER TABLE "chat_canais" ADD CONSTRAINT "chat_canais_nome_check" CHECK ("tipo" = 'DIRETO' OR "nome" IS NOT NULL);

-- R4.1 (Onda A): o contato precisa de e-mail, telefone OU pelo menos um
-- identificador de canal (quem chega só pelo Instagram, Messenger ou chat do
-- site). O CHECK antigo não enxerga a outra tabela; o gatilho adiável confere no
-- fim da transação, depois que o contato e o identificador foram gravados. O
-- contato excluído (anonimizado, R4.6) continua dispensado.
ALTER TABLE "contatos" DROP CONSTRAINT "contatos_meio_de_contato_check";

CREATE FUNCTION "contatos_exigir_meio_de_contato"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  alvo uuid;
BEGIN
  IF TG_TABLE_NAME = 'contatos' THEN
    alvo := NEW."id";
  ELSE
    alvo := OLD."contato_id";
  END IF;
  IF EXISTS (
    SELECT 1 FROM "contatos" c
     WHERE c."id" = alvo
       AND c."excluido_em" IS NULL
       AND c."email" IS NULL
       AND c."telefone" IS NULL
       AND NOT EXISTS (SELECT 1 FROM "contato_identificadores" i WHERE i."contato_id" = c."id")
  ) THEN
    RAISE EXCEPTION 'O contato precisa de e-mail, telefone ou um identificador de canal (R4.1).'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "contatos_meio_de_contato"
  AFTER INSERT OR UPDATE OF "email", "telefone", "excluido_em" ON "contatos"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "contatos_exigir_meio_de_contato"();

CREATE CONSTRAINT TRIGGER "contato_identificadores_meio_de_contato"
  AFTER DELETE OR UPDATE OF "contato_id" ON "contato_identificadores"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "contatos_exigir_meio_de_contato"();

-- R5.8 (ajuste) e R12: o rodízio só inclui quem já ativou o acesso — definiu a
-- senha do convite ou trocou a temporária/inicial no primeiro login. O banco
-- marca `acesso_ativado_em` na primeira vez em que a pessoa fica com senha
-- própria (senha definida e sem troca pendente) e nunca mais desmarca (uma
-- senha temporária nova não tira ninguém do rodízio).
UPDATE "usuarios"
   SET "acesso_ativado_em" = COALESCE("senha_alterada_em", "ultimo_acesso_em", "criado_em")
 WHERE "senha_hash" IS NOT NULL AND NOT "deve_trocar_senha";

CREATE FUNCTION "usuarios_marcar_acesso_ativado"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."acesso_ativado_em" IS NULL
     AND NEW."senha_hash" IS NOT NULL
     AND NOT NEW."deve_trocar_senha" THEN
    NEW."acesso_ativado_em" := COALESCE(NEW."senha_alterada_em", now());
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "usuarios_acesso_ativado"
  BEFORE INSERT OR UPDATE OF "senha_hash", "deve_trocar_senha" ON "usuarios"
  FOR EACH ROW EXECUTE FUNCTION "usuarios_marcar_acesso_ativado"();

-- R2.4 + tempo real (§2.2): sessão revogada (sair, desligamento, troca de senha…)
-- avisa a API por NOTIFY — entregue só depois do commit —, e o tempo real
-- derruba os sockets daquela sessão na hora. O conteúdo é só o id da sessão.
CREATE FUNCTION "sessoes_avisar_revogacao"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('crmbrl_sessoes_revogadas', NEW."id"::text);
  RETURN NULL;
END;
$$;

CREATE TRIGGER "sessoes_revogacao_avisada"
  AFTER UPDATE OF "revogada_em" ON "sessoes"
  FOR EACH ROW
  WHEN (OLD."revogada_em" IS NULL AND NEW."revogada_em" IS NOT NULL)
  EXECUTE FUNCTION "sessoes_avisar_revogacao"();

-- R10.2 + tempo real (§2.2): notificação nova avisa a API por NOTIFY (entregue só
-- depois do commit); o tempo real emite `notificacao.nova` para o dono. As
-- notificações continuam fora da outbox (gravadas na transação da alteração).
CREATE FUNCTION "notificacoes_avisar_criacao"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify(
    'crmbrl_notificacoes',
    json_build_object('id', NEW."id", 'usuarioId', NEW."usuario_id")::text
  );
  RETURN NULL;
END;
$$;

CREATE TRIGGER "notificacoes_criacao_avisada"
  AFTER INSERT ON "notificacoes"
  FOR EACH ROW EXECUTE FUNCTION "notificacoes_avisar_criacao"();
