-- CreateEnum
CREATE TYPE "area" AS ENUM ('MARKETING', 'COMERCIAL', 'CS');

-- CreateEnum
CREATE TYPE "tipo_etapa" AS ENUM ('ABERTA', 'GANHO', 'PERDIDO');

-- CreateEnum
CREATE TYPE "status_negocio" AS ENUM ('ABERTO', 'GANHO', 'PERDIDO');

-- CreateEnum
CREATE TYPE "origem_contato" AS ENUM ('MANUAL', 'WEBHOOK', 'WHATSAPP', 'SITE', 'INDICACAO', 'IMPORTACAO', 'PASSAGEM', 'OUTRO');

-- CreateEnum
CREATE TYPE "tipo_atividade" AS ENUM ('TAREFA', 'LIGACAO', 'REUNIAO', 'EMAIL', 'WHATSAPP', 'NOTA');

-- CreateEnum
CREATE TYPE "status_atividade" AS ENUM ('PENDENTE', 'CONCLUIDA', 'CANCELADA');

-- CreateEnum
CREATE TYPE "prioridade_atividade" AS ENUM ('BAIXA', 'MEDIA', 'ALTA');

-- CreateEnum
CREATE TYPE "tipo_ator" AS ENUM ('USUARIO', 'SISTEMA', 'WEBHOOK', 'AUTOMACAO', 'IA');

-- CreateEnum
CREATE TYPE "estrategia_distribuicao" AS ENUM ('RODIZIO', 'RESPONSAVEL_FIXO', 'LIDER_DA_AREA');

-- CreateEnum
CREATE TYPE "tipo_token_senha" AS ENUM ('CONVITE', 'REDEFINICAO');

-- CreateEnum
CREATE TYPE "status_recebimento" AS ENUM ('RECEBIDO', 'PROCESSADO', 'IGNORADO', 'ERRO');

-- CreateEnum
CREATE TYPE "status_entrega" AS ENUM ('PENDENTE', 'ENTREGUE', 'FALHOU');

-- CreateEnum
CREATE TYPE "nivel_log" AS ENUM ('DEBUG', 'INFO', 'AVISO', 'ERRO');

-- CreateEnum
CREATE TYPE "modelo_mapeamento" AS ENUM ('GENERICO', 'DISPAROS_BRL', 'PERSONALIZADO');

-- AlterTable
ALTER TABLE "usuarios" ADD COLUMN     "avatar_url" TEXT,
ADD COLUMN     "deve_trocar_senha" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "senha_alterada_em" TIMESTAMPTZ(3),
ADD COLUMN     "senha_hash" TEXT,
ADD COLUMN     "telefone" TEXT,
ADD COLUMN     "ultimo_acesso_em" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "sessoes" (
    "id" UUID NOT NULL,
    "usuario_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "criado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ultimo_uso_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expira_em" TIMESTAMPTZ(3) NOT NULL,
    "revogada_em" TIMESTAMPTZ(3),
    "motivo_revogacao" TEXT,
    "ip" TEXT,
    "user_agent" TEXT,

    CONSTRAINT "sessoes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tentativas_login" (
    "id" BIGSERIAL NOT NULL,
    "email" TEXT NOT NULL,
    "ip" TEXT,
    "usuario_id" UUID,
    "sucesso" BOOLEAN NOT NULL,
    "motivo" TEXT NOT NULL,
    "user_agent" TEXT,
    "criado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tentativas_login_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tokens_senha" (
    "id" UUID NOT NULL,
    "usuario_id" UUID NOT NULL,
    "tipo" "tipo_token_senha" NOT NULL,
    "token_hash" TEXT NOT NULL,
    "criado_por_id" UUID,
    "criado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expira_em" TIMESTAMPTZ(3) NOT NULL,
    "usado_em" TIMESTAMPTZ(3),
    "invalidado_em" TIMESTAMPTZ(3),

    CONSTRAINT "tokens_senha_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "empresas" (
    "id" UUID NOT NULL,
    "nome" TEXT NOT NULL,
    "cnpj" TEXT,
    "site" TEXT,
    "email" TEXT,
    "telefone" TEXT,
    "segmento" TEXT,
    "cidade" TEXT,
    "uf" CHAR(2),
    "responsavel_id" UUID,
    "etiquetas" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "campos_personalizados" JSONB NOT NULL DEFAULT '{}',
    "criado_por_id" UUID,
    "criado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMPTZ(3) NOT NULL,
    "excluido_em" TIMESTAMPTZ(3),

    CONSTRAINT "empresas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contatos" (
    "id" UUID NOT NULL,
    "nome" TEXT NOT NULL,
    "email" TEXT,
    "telefone" TEXT,
    "cargo" TEXT,
    "empresa_id" UUID,
    "responsavel_id" UUID,
    "primeira_origem" "origem_contato" NOT NULL DEFAULT 'MANUAL',
    "primeira_origem_detalhe" TEXT,
    "primeira_origem_utm" JSONB,
    "ultima_origem" "origem_contato" NOT NULL DEFAULT 'MANUAL',
    "ultima_origem_detalhe" TEXT,
    "ultima_origem_utm" JSONB,
    "ultima_origem_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "conversoes" INTEGER NOT NULL DEFAULT 1,
    "etiquetas" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "campos_personalizados" JSONB NOT NULL DEFAULT '{}',
    "opt_out_marketing" BOOLEAN NOT NULL DEFAULT false,
    "opt_out_em" TIMESTAMPTZ(3),
    "consentimento_em" TIMESTAMPTZ(3),
    "consentimento_origem" TEXT,
    "criado_por_id" UUID,
    "criado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMPTZ(3) NOT NULL,
    "excluido_em" TIMESTAMPTZ(3),

    CONSTRAINT "contatos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "funis" (
    "id" UUID NOT NULL,
    "nome" TEXT NOT NULL,
    "area" "area" NOT NULL,
    "base" BOOLEAN NOT NULL DEFAULT false,
    "ordem" INTEGER NOT NULL DEFAULT 0,
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "descricao" TEXT,
    "criado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMPTZ(3) NOT NULL,
    "excluido_em" TIMESTAMPTZ(3),

    CONSTRAINT "funis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "etapas" (
    "id" UUID NOT NULL,
    "funil_id" UUID NOT NULL,
    "nome" TEXT NOT NULL,
    "chave" TEXT,
    "ordem" INTEGER NOT NULL,
    "tipo" "tipo_etapa" NOT NULL DEFAULT 'ABERTA',
    "prazo_dias" INTEGER,
    "probabilidade" INTEGER,
    "criado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "etapas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "negocios" (
    "id" UUID NOT NULL,
    "titulo" TEXT NOT NULL,
    "contato_id" UUID NOT NULL,
    "empresa_id" UUID,
    "funil_id" UUID NOT NULL,
    "etapa_id" UUID NOT NULL,
    "responsavel_id" UUID,
    "status" "status_negocio" NOT NULL DEFAULT 'ABERTO',
    "valor" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "valor_recorrente" DECIMAL(14,2),
    "previsao_fechamento" DATE,
    "motivo_perda" TEXT,
    "ganho_em" TIMESTAMPTZ(3),
    "perdido_em" TIMESTAMPTZ(3),
    "etapa_desde" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "posicao" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "negocio_origem_id" UUID,
    "origem" "origem_contato" NOT NULL DEFAULT 'MANUAL',
    "origem_detalhe" TEXT,
    "utm" JSONB,
    "reconversoes" INTEGER NOT NULL DEFAULT 0,
    "ultima_reconversao_em" TIMESTAMPTZ(3),
    "campos_personalizados" JSONB NOT NULL DEFAULT '{}',
    "criado_por_id" UUID,
    "criado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMPTZ(3) NOT NULL,
    "excluido_em" TIMESTAMPTZ(3),

    CONSTRAINT "negocios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "negocio_movimentacoes" (
    "id" UUID NOT NULL,
    "negocio_id" UUID NOT NULL,
    "funil_id" UUID NOT NULL,
    "de_etapa_id" UUID,
    "para_etapa_id" UUID,
    "usuario_id" UUID,
    "tipo_ator" "tipo_ator" NOT NULL,
    "segundos_na_etapa_anterior" INTEGER,
    "criado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "negocio_movimentacoes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "passagens" (
    "id" UUID NOT NULL,
    "chave" TEXT,
    "nome" TEXT NOT NULL,
    "funil_origem_id" UUID NOT NULL,
    "etapa_gatilho_id" UUID NOT NULL,
    "funil_destino_id" UUID NOT NULL,
    "etapa_destino_id" UUID NOT NULL,
    "estrategia" "estrategia_distribuicao" NOT NULL DEFAULT 'RODIZIO',
    "responsavel_fixo_id" UUID,
    "ativa" BOOLEAN NOT NULL DEFAULT true,
    "criado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "passagens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "passagem_execucoes" (
    "id" UUID NOT NULL,
    "passagem_id" UUID NOT NULL,
    "negocio_origem_id" UUID NOT NULL,
    "negocio_destino_id" UUID,
    "reconversao" BOOLEAN NOT NULL DEFAULT false,
    "criado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "passagem_execucoes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "regras_distribuicao" (
    "id" UUID NOT NULL,
    "area" "area" NOT NULL,
    "incluir_lideres" BOOLEAN NOT NULL DEFAULT false,
    "ultimo_usuario_id" UUID,
    "criado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "regras_distribuicao_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "regras_distribuicao_participantes" (
    "id" UUID NOT NULL,
    "regra_id" UUID NOT NULL,
    "usuario_id" UUID NOT NULL,
    "participa" BOOLEAN NOT NULL DEFAULT false,
    "criado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "regras_distribuicao_participantes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "atividades" (
    "id" UUID NOT NULL,
    "tipo" "tipo_atividade" NOT NULL,
    "titulo" TEXT NOT NULL,
    "descricao" TEXT,
    "status" "status_atividade" NOT NULL DEFAULT 'PENDENTE',
    "prioridade" "prioridade_atividade" NOT NULL DEFAULT 'MEDIA',
    "vence_em" TIMESTAMPTZ(3),
    "inicio_em" TIMESTAMPTZ(3),
    "fim_em" TIMESTAMPTZ(3),
    "responsavel_id" UUID NOT NULL,
    "criado_por_id" UUID,
    "concluida_em" TIMESTAMPTZ(3),
    "concluida_por_id" UUID,
    "cancelada_em" TIMESTAMPTZ(3),
    "contato_id" UUID,
    "empresa_id" UUID,
    "negocio_id" UUID,
    "encaminhada_de_id" UUID,
    "encaminhada_em" TIMESTAMPTZ(3),
    "lembrete_enviado_em" TIMESTAMPTZ(3),
    "atraso_notificado_em" TIMESTAMPTZ(3),
    "criado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "atividades_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notificacoes" (
    "id" UUID NOT NULL,
    "usuario_id" UUID NOT NULL,
    "tipo" TEXT NOT NULL,
    "titulo" TEXT NOT NULL,
    "texto" TEXT,
    "link" TEXT,
    "dados" JSONB,
    "lida_em" TIMESTAMPTZ(3),
    "criado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notificacoes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "eventos_auditoria" (
    "id" BIGSERIAL NOT NULL,
    "criado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tipo_ator" "tipo_ator" NOT NULL,
    "usuario_id" UUID,
    "ator_descricao" TEXT,
    "acao" TEXT NOT NULL,
    "entidade" TEXT NOT NULL,
    "entidade_id" TEXT,
    "resumo" TEXT NOT NULL,
    "dados" JSONB,
    "relacionados" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "ip" TEXT,
    "user_agent" TEXT,
    "requisicao_id" TEXT,

    CONSTRAINT "eventos_auditoria_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "logs_tecnicos" (
    "id" BIGSERIAL NOT NULL,
    "criado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "nivel" "nivel_log" NOT NULL,
    "contexto" TEXT NOT NULL,
    "mensagem" TEXT NOT NULL,
    "dados" JSONB,
    "requisicao_id" TEXT,
    "usuario_id" UUID,
    "metodo" TEXT,
    "rota" TEXT,
    "status" INTEGER,
    "duracao_ms" INTEGER,

    CONSTRAINT "logs_tecnicos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "eventos_dominio" (
    "id" UUID NOT NULL,
    "tipo" TEXT NOT NULL,
    "dados" JSONB NOT NULL,
    "criado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tipo_ator" "tipo_ator" NOT NULL DEFAULT 'SISTEMA',
    "usuario_id" UUID,
    "requisicao_id" TEXT,
    "enfileirado_em" TIMESTAMPTZ(3),
    "processado_em" TIMESTAMPTZ(3),
    "tentativas" INTEGER NOT NULL DEFAULT 0,
    "manipuladores_concluidos" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "erro" TEXT,

    CONSTRAINT "eventos_dominio_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhooks_entrada" (
    "id" UUID NOT NULL,
    "nome" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "token_prefixo" TEXT NOT NULL,
    "funil_id" UUID NOT NULL,
    "etapa_id" UUID NOT NULL,
    "estrategia" "estrategia_distribuicao" NOT NULL DEFAULT 'RODIZIO',
    "responsavel_fixo_id" UUID,
    "modelo_mapeamento" "modelo_mapeamento" NOT NULL DEFAULT 'GENERICO',
    "mapeamento" JSONB NOT NULL DEFAULT '{}',
    "etiquetas_fixas" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "segredo_cifrado" TEXT,
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "ultimo_recebimento_em" TIMESTAMPTZ(3),
    "criado_por_id" UUID,
    "criado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMPTZ(3) NOT NULL,
    "excluido_em" TIMESTAMPTZ(3),

    CONSTRAINT "webhooks_entrada_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_recebimentos" (
    "id" UUID NOT NULL,
    "webhook_id" UUID NOT NULL,
    "recebido_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip" TEXT,
    "cabecalhos" JSONB NOT NULL DEFAULT '{}',
    "tipo_conteudo" TEXT,
    "corpo" JSONB,
    "status" "status_recebimento" NOT NULL DEFAULT 'RECEBIDO',
    "mensagem" TEXT,
    "contato_id" UUID,
    "negocio_id" UUID,
    "processado_em" TIMESTAMPTZ(3),
    "tentativas" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "webhook_recebimentos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhooks_saida" (
    "id" UUID NOT NULL,
    "nome" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "eventos" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "segredo_cifrado" TEXT NOT NULL,
    "cabecalhos_cifrados" TEXT,
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "falhas_consecutivas" INTEGER NOT NULL DEFAULT 0,
    "desativado_automaticamente_em" TIMESTAMPTZ(3),
    "criado_por_id" UUID,
    "criado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMPTZ(3) NOT NULL,
    "excluido_em" TIMESTAMPTZ(3),

    CONSTRAINT "webhooks_saida_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_entregas" (
    "id" UUID NOT NULL,
    "webhook_id" UUID NOT NULL,
    "evento_id" UUID NOT NULL,
    "tipo_evento" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "status_entrega" NOT NULL DEFAULT 'PENDENTE',
    "tentativas" INTEGER NOT NULL DEFAULT 0,
    "ultima_tentativa_em" TIMESTAMPTZ(3),
    "proxima_tentativa_em" TIMESTAMPTZ(3),
    "status_http" INTEGER,
    "duracao_ms" INTEGER,
    "trecho_resposta" TEXT,
    "erro" TEXT,
    "entregue_em" TIMESTAMPTZ(3),
    "criado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "webhook_entregas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_entrega_tentativas" (
    "id" UUID NOT NULL,
    "entrega_id" UUID NOT NULL,
    "numero" INTEGER NOT NULL,
    "sucesso" BOOLEAN NOT NULL,
    "status_http" INTEGER,
    "duracao_ms" INTEGER,
    "trecho_resposta" TEXT,
    "erro" TEXT,
    "criado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_entrega_tentativas_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sessoes_token_hash_key" ON "sessoes"("token_hash");

-- CreateIndex
CREATE INDEX "sessoes_usuario_id_idx" ON "sessoes"("usuario_id");

-- CreateIndex
CREATE INDEX "sessoes_expira_em_idx" ON "sessoes"("expira_em");

-- CreateIndex
CREATE INDEX "tentativas_login_email_criado_em_idx" ON "tentativas_login"("email", "criado_em");

-- CreateIndex
CREATE INDEX "tentativas_login_ip_criado_em_idx" ON "tentativas_login"("ip", "criado_em");

-- CreateIndex
CREATE UNIQUE INDEX "tokens_senha_token_hash_key" ON "tokens_senha"("token_hash");

-- CreateIndex
CREATE INDEX "tokens_senha_usuario_id_tipo_idx" ON "tokens_senha"("usuario_id", "tipo");

-- CreateIndex
CREATE INDEX "empresas_responsavel_id_idx" ON "empresas"("responsavel_id");

-- CreateIndex
CREATE INDEX "empresas_nome_idx" ON "empresas"("nome");

-- CreateIndex
CREATE UNIQUE INDEX "empresas_cnpj_ativo_key" ON "empresas"("cnpj") WHERE (cnpj IS NOT NULL) AND (excluido_em IS NULL);

-- CreateIndex
CREATE INDEX "contatos_responsavel_id_idx" ON "contatos"("responsavel_id");

-- CreateIndex
CREATE INDEX "contatos_empresa_id_idx" ON "contatos"("empresa_id");

-- CreateIndex
CREATE INDEX "contatos_criado_em_idx" ON "contatos"("criado_em");

-- CreateIndex
CREATE UNIQUE INDEX "contatos_email_ativo_key" ON "contatos"("email") WHERE (email IS NOT NULL) AND (excluido_em IS NULL);

-- CreateIndex
CREATE UNIQUE INDEX "contatos_telefone_ativo_key" ON "contatos"("telefone") WHERE (telefone IS NOT NULL) AND (excluido_em IS NULL);

-- CreateIndex
CREATE INDEX "funis_area_ordem_idx" ON "funis"("area", "ordem");

-- CreateIndex
CREATE UNIQUE INDEX "funis_base_area_key" ON "funis"("area") WHERE (base);

-- CreateIndex
CREATE INDEX "etapas_funil_id_ordem_idx" ON "etapas"("funil_id", "ordem");

-- CreateIndex
CREATE UNIQUE INDEX "etapas_funil_id_chave_key" ON "etapas"("funil_id", "chave");

-- CreateIndex
CREATE UNIQUE INDEX "etapas_funil_ganho_key" ON "etapas"("funil_id") WHERE (tipo = 'GANHO'::tipo_etapa);

-- CreateIndex
CREATE UNIQUE INDEX "etapas_funil_perdido_key" ON "etapas"("funil_id") WHERE (tipo = 'PERDIDO'::tipo_etapa);

-- CreateIndex
CREATE INDEX "negocios_funil_id_etapa_id_status_idx" ON "negocios"("funil_id", "etapa_id", "status");

-- CreateIndex
CREATE INDEX "negocios_etapa_id_posicao_idx" ON "negocios"("etapa_id", "posicao");

-- CreateIndex
CREATE INDEX "negocios_responsavel_id_status_idx" ON "negocios"("responsavel_id", "status");

-- CreateIndex
CREATE INDEX "negocios_contato_id_idx" ON "negocios"("contato_id");

-- CreateIndex
CREATE INDEX "negocios_empresa_id_idx" ON "negocios"("empresa_id");

-- CreateIndex
CREATE INDEX "negocios_negocio_origem_id_idx" ON "negocios"("negocio_origem_id");

-- CreateIndex
CREATE INDEX "negocio_movimentacoes_negocio_id_criado_em_idx" ON "negocio_movimentacoes"("negocio_id", "criado_em");

-- CreateIndex
CREATE INDEX "negocio_movimentacoes_funil_id_criado_em_idx" ON "negocio_movimentacoes"("funil_id", "criado_em");

-- CreateIndex
CREATE INDEX "negocio_movimentacoes_para_etapa_id_idx" ON "negocio_movimentacoes"("para_etapa_id");

-- CreateIndex
CREATE INDEX "negocio_movimentacoes_de_etapa_id_idx" ON "negocio_movimentacoes"("de_etapa_id");

-- CreateIndex
CREATE UNIQUE INDEX "passagens_chave_key" ON "passagens"("chave");

-- CreateIndex
CREATE INDEX "passagens_etapa_gatilho_id_idx" ON "passagens"("etapa_gatilho_id");

-- CreateIndex
CREATE INDEX "passagem_execucoes_negocio_destino_id_idx" ON "passagem_execucoes"("negocio_destino_id");

-- CreateIndex
CREATE UNIQUE INDEX "passagem_execucoes_passagem_id_negocio_origem_id_key" ON "passagem_execucoes"("passagem_id", "negocio_origem_id");

-- CreateIndex
CREATE UNIQUE INDEX "regras_distribuicao_area_key" ON "regras_distribuicao"("area");

-- CreateIndex
CREATE INDEX "regras_distribuicao_participantes_usuario_id_idx" ON "regras_distribuicao_participantes"("usuario_id");

-- CreateIndex
CREATE UNIQUE INDEX "regras_distribuicao_participantes_regra_id_usuario_id_key" ON "regras_distribuicao_participantes"("regra_id", "usuario_id");

-- CreateIndex
CREATE INDEX "atividades_responsavel_id_status_vence_em_idx" ON "atividades"("responsavel_id", "status", "vence_em");

-- CreateIndex
CREATE INDEX "atividades_status_vence_em_idx" ON "atividades"("status", "vence_em");

-- CreateIndex
CREATE INDEX "atividades_contato_id_idx" ON "atividades"("contato_id");

-- CreateIndex
CREATE INDEX "atividades_empresa_id_idx" ON "atividades"("empresa_id");

-- CreateIndex
CREATE INDEX "atividades_negocio_id_idx" ON "atividades"("negocio_id");

-- CreateIndex
CREATE INDEX "atividades_criado_por_id_idx" ON "atividades"("criado_por_id");

-- CreateIndex
CREATE INDEX "notificacoes_usuario_id_lida_em_criado_em_idx" ON "notificacoes"("usuario_id", "lida_em", "criado_em");

-- CreateIndex
CREATE INDEX "notificacoes_usuario_id_criado_em_idx" ON "notificacoes"("usuario_id", "criado_em");

-- CreateIndex
CREATE INDEX "eventos_auditoria_entidade_entidade_id_criado_em_idx" ON "eventos_auditoria"("entidade", "entidade_id", "criado_em");

-- CreateIndex
CREATE INDEX "eventos_auditoria_usuario_id_criado_em_idx" ON "eventos_auditoria"("usuario_id", "criado_em");

-- CreateIndex
CREATE INDEX "eventos_auditoria_criado_em_idx" ON "eventos_auditoria"("criado_em");

-- CreateIndex
CREATE INDEX "eventos_auditoria_acao_idx" ON "eventos_auditoria"("acao");

-- CreateIndex
CREATE INDEX "eventos_auditoria_relacionados_idx" ON "eventos_auditoria" USING GIN ("relacionados");

-- CreateIndex
CREATE INDEX "logs_tecnicos_criado_em_idx" ON "logs_tecnicos"("criado_em");

-- CreateIndex
CREATE INDEX "logs_tecnicos_nivel_criado_em_idx" ON "logs_tecnicos"("nivel", "criado_em");

-- CreateIndex
CREATE INDEX "logs_tecnicos_requisicao_id_idx" ON "logs_tecnicos"("requisicao_id");

-- CreateIndex
CREATE INDEX "eventos_dominio_a_enfileirar_idx" ON "eventos_dominio"("criado_em") WHERE (enfileirado_em IS NULL);

-- CreateIndex
CREATE INDEX "eventos_dominio_tipo_criado_em_idx" ON "eventos_dominio"("tipo", "criado_em");

-- CreateIndex
CREATE UNIQUE INDEX "webhooks_entrada_token_hash_key" ON "webhooks_entrada"("token_hash");

-- CreateIndex
CREATE INDEX "webhook_recebimentos_webhook_id_recebido_em_idx" ON "webhook_recebimentos"("webhook_id", "recebido_em");

-- CreateIndex
CREATE INDEX "webhook_recebimentos_recebido_em_idx" ON "webhook_recebimentos"("recebido_em");

-- CreateIndex
CREATE INDEX "webhook_recebimentos_status_idx" ON "webhook_recebimentos"("status");

-- CreateIndex
CREATE INDEX "webhook_entregas_status_proxima_tentativa_em_idx" ON "webhook_entregas"("status", "proxima_tentativa_em");

-- CreateIndex
CREATE INDEX "webhook_entregas_webhook_id_criado_em_idx" ON "webhook_entregas"("webhook_id", "criado_em");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_entregas_webhook_id_evento_id_key" ON "webhook_entregas"("webhook_id", "evento_id");

-- CreateIndex
CREATE INDEX "webhook_entrega_tentativas_entrega_id_numero_idx" ON "webhook_entrega_tentativas"("entrega_id", "numero");

-- CreateIndex
CREATE INDEX "usuarios_papel_ativo_idx" ON "usuarios"("papel", "ativo");

-- AddForeignKey
ALTER TABLE "sessoes" ADD CONSTRAINT "sessoes_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tokens_senha" ADD CONSTRAINT "tokens_senha_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "empresas" ADD CONSTRAINT "empresas_responsavel_id_fkey" FOREIGN KEY ("responsavel_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "empresas" ADD CONSTRAINT "empresas_criado_por_id_fkey" FOREIGN KEY ("criado_por_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contatos" ADD CONSTRAINT "contatos_empresa_id_fkey" FOREIGN KEY ("empresa_id") REFERENCES "empresas"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contatos" ADD CONSTRAINT "contatos_responsavel_id_fkey" FOREIGN KEY ("responsavel_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contatos" ADD CONSTRAINT "contatos_criado_por_id_fkey" FOREIGN KEY ("criado_por_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "etapas" ADD CONSTRAINT "etapas_funil_id_fkey" FOREIGN KEY ("funil_id") REFERENCES "funis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "negocios" ADD CONSTRAINT "negocios_contato_id_fkey" FOREIGN KEY ("contato_id") REFERENCES "contatos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "negocios" ADD CONSTRAINT "negocios_empresa_id_fkey" FOREIGN KEY ("empresa_id") REFERENCES "empresas"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "negocios" ADD CONSTRAINT "negocios_funil_id_fkey" FOREIGN KEY ("funil_id") REFERENCES "funis"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "negocios" ADD CONSTRAINT "negocios_etapa_id_fkey" FOREIGN KEY ("etapa_id") REFERENCES "etapas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "negocios" ADD CONSTRAINT "negocios_responsavel_id_fkey" FOREIGN KEY ("responsavel_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "negocios" ADD CONSTRAINT "negocios_negocio_origem_id_fkey" FOREIGN KEY ("negocio_origem_id") REFERENCES "negocios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "negocios" ADD CONSTRAINT "negocios_criado_por_id_fkey" FOREIGN KEY ("criado_por_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "negocio_movimentacoes" ADD CONSTRAINT "negocio_movimentacoes_negocio_id_fkey" FOREIGN KEY ("negocio_id") REFERENCES "negocios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "negocio_movimentacoes" ADD CONSTRAINT "negocio_movimentacoes_funil_id_fkey" FOREIGN KEY ("funil_id") REFERENCES "funis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "negocio_movimentacoes" ADD CONSTRAINT "negocio_movimentacoes_de_etapa_id_fkey" FOREIGN KEY ("de_etapa_id") REFERENCES "etapas"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "negocio_movimentacoes" ADD CONSTRAINT "negocio_movimentacoes_para_etapa_id_fkey" FOREIGN KEY ("para_etapa_id") REFERENCES "etapas"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "negocio_movimentacoes" ADD CONSTRAINT "negocio_movimentacoes_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "passagens" ADD CONSTRAINT "passagens_funil_origem_id_fkey" FOREIGN KEY ("funil_origem_id") REFERENCES "funis"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "passagens" ADD CONSTRAINT "passagens_etapa_gatilho_id_fkey" FOREIGN KEY ("etapa_gatilho_id") REFERENCES "etapas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "passagens" ADD CONSTRAINT "passagens_funil_destino_id_fkey" FOREIGN KEY ("funil_destino_id") REFERENCES "funis"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "passagens" ADD CONSTRAINT "passagens_etapa_destino_id_fkey" FOREIGN KEY ("etapa_destino_id") REFERENCES "etapas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "passagens" ADD CONSTRAINT "passagens_responsavel_fixo_id_fkey" FOREIGN KEY ("responsavel_fixo_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "passagem_execucoes" ADD CONSTRAINT "passagem_execucoes_passagem_id_fkey" FOREIGN KEY ("passagem_id") REFERENCES "passagens"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "passagem_execucoes" ADD CONSTRAINT "passagem_execucoes_negocio_origem_id_fkey" FOREIGN KEY ("negocio_origem_id") REFERENCES "negocios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "passagem_execucoes" ADD CONSTRAINT "passagem_execucoes_negocio_destino_id_fkey" FOREIGN KEY ("negocio_destino_id") REFERENCES "negocios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "regras_distribuicao" ADD CONSTRAINT "regras_distribuicao_ultimo_usuario_id_fkey" FOREIGN KEY ("ultimo_usuario_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "regras_distribuicao_participantes" ADD CONSTRAINT "regras_distribuicao_participantes_regra_id_fkey" FOREIGN KEY ("regra_id") REFERENCES "regras_distribuicao"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "regras_distribuicao_participantes" ADD CONSTRAINT "regras_distribuicao_participantes_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "atividades" ADD CONSTRAINT "atividades_responsavel_id_fkey" FOREIGN KEY ("responsavel_id") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "atividades" ADD CONSTRAINT "atividades_criado_por_id_fkey" FOREIGN KEY ("criado_por_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "atividades" ADD CONSTRAINT "atividades_concluida_por_id_fkey" FOREIGN KEY ("concluida_por_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "atividades" ADD CONSTRAINT "atividades_contato_id_fkey" FOREIGN KEY ("contato_id") REFERENCES "contatos"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "atividades" ADD CONSTRAINT "atividades_empresa_id_fkey" FOREIGN KEY ("empresa_id") REFERENCES "empresas"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "atividades" ADD CONSTRAINT "atividades_negocio_id_fkey" FOREIGN KEY ("negocio_id") REFERENCES "negocios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "atividades" ADD CONSTRAINT "atividades_encaminhada_de_id_fkey" FOREIGN KEY ("encaminhada_de_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notificacoes" ADD CONSTRAINT "notificacoes_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhooks_entrada" ADD CONSTRAINT "webhooks_entrada_funil_id_fkey" FOREIGN KEY ("funil_id") REFERENCES "funis"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhooks_entrada" ADD CONSTRAINT "webhooks_entrada_etapa_id_fkey" FOREIGN KEY ("etapa_id") REFERENCES "etapas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhooks_entrada" ADD CONSTRAINT "webhooks_entrada_responsavel_fixo_id_fkey" FOREIGN KEY ("responsavel_fixo_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhooks_entrada" ADD CONSTRAINT "webhooks_entrada_criado_por_id_fkey" FOREIGN KEY ("criado_por_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_recebimentos" ADD CONSTRAINT "webhook_recebimentos_webhook_id_fkey" FOREIGN KEY ("webhook_id") REFERENCES "webhooks_entrada"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_recebimentos" ADD CONSTRAINT "webhook_recebimentos_contato_id_fkey" FOREIGN KEY ("contato_id") REFERENCES "contatos"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_recebimentos" ADD CONSTRAINT "webhook_recebimentos_negocio_id_fkey" FOREIGN KEY ("negocio_id") REFERENCES "negocios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhooks_saida" ADD CONSTRAINT "webhooks_saida_criado_por_id_fkey" FOREIGN KEY ("criado_por_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_entregas" ADD CONSTRAINT "webhook_entregas_webhook_id_fkey" FOREIGN KEY ("webhook_id") REFERENCES "webhooks_saida"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_entrega_tentativas" ADD CONSTRAINT "webhook_entrega_tentativas_entrega_id_fkey" FOREIGN KEY ("entrega_id") REFERENCES "webhook_entregas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===========================================================================
-- Acréscimos escritos à mão (o Prisma não gera CHECKs nem gatilhos).
-- Os índices únicos parciais acima vêm do schema (preview `partialIndexes`).
-- ===========================================================================

-- R1.1: e-mail do usuário aparado e em minúsculas. Normaliza o que já existir
-- antes de exigir (a tabela vem da migration inicial).
UPDATE "usuarios" SET "email" = lower(btrim("email")) WHERE "email" <> lower(btrim("email"));
ALTER TABLE "usuarios" ADD CONSTRAINT "usuarios_email_normalizado_check" CHECK ("email" = lower(btrim("email")));
-- R1.2: ninguém lidera a si mesmo.
ALTER TABLE "usuarios" ADD CONSTRAINT "usuarios_lider_diferente_check" CHECK ("lider_id" IS NULL OR "lider_id" <> "id");

-- R4.1: e-mail em minúsculas, telefone em E.164 só com dígitos e pelo menos um
-- meio de contato (o contato anonimizado, já excluído, fica sem nenhum: R4.6).
ALTER TABLE "contatos" ADD CONSTRAINT "contatos_email_normalizado_check" CHECK ("email" IS NULL OR "email" = lower(btrim("email")));
ALTER TABLE "contatos" ADD CONSTRAINT "contatos_telefone_e164_check" CHECK ("telefone" IS NULL OR "telefone" ~ '^[1-9][0-9]{7,14}$');
ALTER TABLE "contatos" ADD CONSTRAINT "contatos_meio_de_contato_check" CHECK ("email" IS NOT NULL OR "telefone" IS NOT NULL OR "excluido_em" IS NOT NULL);

-- R4.4: CNPJ normalizado: 12 caracteres (dígitos ou, no CNPJ alfanumérico de 2026,
-- letras maiúsculas) e 2 dígitos verificadores, que a API valida.
ALTER TABLE "empresas" ADD CONSTRAINT "empresas_cnpj_formato_check" CHECK ("cnpj" IS NULL OR "cnpj" ~ '^[0-9A-Z]{12}[0-9]{2}$');
ALTER TABLE "empresas" ADD CONSTRAINT "empresas_uf_check" CHECK ("uf" IS NULL OR "uf" ~ '^[A-Z]{2}$');

-- R5.1: funil-base não é excluído (pode ser só arquivado, ativo = false).
ALTER TABLE "funis" ADD CONSTRAINT "funis_base_nao_excluido_check" CHECK (NOT "base" OR "excluido_em" IS NULL);

-- R5.2: prazo-alvo positivo e probabilidade entre 0 e 100.
ALTER TABLE "etapas" ADD CONSTRAINT "etapas_prazo_dias_check" CHECK ("prazo_dias" IS NULL OR "prazo_dias" > 0);
ALTER TABLE "etapas" ADD CONSTRAINT "etapas_probabilidade_check" CHECK ("probabilidade" IS NULL OR "probabilidade" BETWEEN 0 AND 100);

-- R5.3: valores em reais não negativos.
ALTER TABLE "negocios" ADD CONSTRAINT "negocios_valor_check" CHECK ("valor" >= 0);
ALTER TABLE "negocios" ADD CONSTRAINT "negocios_valor_recorrente_check" CHECK ("valor_recorrente" IS NULL OR "valor_recorrente" >= 0);

-- R5.4/R5.7: mover entre funis é papel da passagem, e ela liga funis diferentes.
ALTER TABLE "passagens" ADD CONSTRAINT "passagens_funis_diferentes_check" CHECK ("funil_origem_id" <> "funil_destino_id");

-- R6.1: a reunião termina depois de começar.
ALTER TABLE "atividades" ADD CONSTRAINT "atividades_periodo_check" CHECK ("fim_em" IS NULL OR "inicio_em" IS NULL OR "fim_em" >= "inicio_em");

-- R3.3: a auditoria é somente inclusão. UPDATE e DELETE (por linha) e TRUNCATE
-- (por comando) são recusados com erro. Para limpar um banco de teste, o dono da
-- tabela desliga os gatilhos na mesma transação (ALTER TABLE … DISABLE TRIGGER).
CREATE FUNCTION "eventos_auditoria_recusar_alteracao"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'A auditoria é somente inclusão (R3.3): % em eventos_auditoria não é permitido.', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER "eventos_auditoria_somente_inclusao"
  BEFORE UPDATE OR DELETE ON "eventos_auditoria"
  FOR EACH ROW EXECUTE FUNCTION "eventos_auditoria_recusar_alteracao"();

CREATE TRIGGER "eventos_auditoria_sem_truncate"
  BEFORE TRUNCATE ON "eventos_auditoria"
  FOR EACH STATEMENT EXECUTE FUNCTION "eventos_auditoria_recusar_alteracao"();

-- R4.3: a primeira origem do contato é imutável. A única exceção é a exclusão
-- com anonimização (R4.6), que pode limpar o detalhe junto com os dados pessoais.
CREATE FUNCTION "contatos_proteger_primeira_origem"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."excluido_em" IS NULL AND (
       NEW."primeira_origem" IS DISTINCT FROM OLD."primeira_origem"
    OR NEW."primeira_origem_detalhe" IS DISTINCT FROM OLD."primeira_origem_detalhe"
    OR NEW."primeira_origem_utm" IS DISTINCT FROM OLD."primeira_origem_utm"
  ) THEN
    RAISE EXCEPTION 'A primeira origem do contato é imutável (R4.3).'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "contatos_primeira_origem_imutavel"
  BEFORE UPDATE ON "contatos"
  FOR EACH ROW EXECUTE FUNCTION "contatos_proteger_primeira_origem"();
