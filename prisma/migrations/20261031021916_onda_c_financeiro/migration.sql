-- CreateEnum
CREATE TYPE "status_contrato" AS ENUM ('ATIVO', 'SUSPENSO', 'CANCELADO', 'ENCERRADO');

-- CreateEnum
CREATE TYPE "periodicidade_contrato" AS ENUM ('MENSAL', 'BIMESTRAL', 'TRIMESTRAL', 'SEMESTRAL', 'ANUAL', 'UNICO');

-- CreateEnum
CREATE TYPE "status_parcela" AS ENUM ('ABERTO', 'PAGO', 'ATRASADO', 'CANCELADO', 'RENEGOCIADO');

-- CreateEnum
CREATE TYPE "forma_pagamento" AS ENUM ('PIX', 'BOLETO', 'CARTAO', 'TRANSFERENCIA', 'DINHEIRO', 'OUTRO');

-- CreateEnum
CREATE TYPE "origem_parcela" AS ENUM ('MANUAL', 'CONTRATO', 'IMPORTACAO', 'RENEGOCIACAO');

-- CreateEnum
CREATE TYPE "tipo_movimento_mrr" AS ENUM ('NOVO', 'EXPANSAO', 'CONTRACAO', 'CHURN');

-- CreateEnum
CREATE TYPE "canal_da_regua" AS ENUM ('WHATSAPP', 'EMAIL', 'LIGACAO');

-- CreateEnum
CREATE TYPE "situacao_envio_regua" AS ENUM ('RETIDO', 'AGENDADO', 'ENVIADO', 'FALHOU', 'CANCELADO', 'PULADO', 'AGUARDANDO_LIGACAO', 'LIGACAO_REGISTRADA');

-- CreateEnum
CREATE TYPE "resultado_ligacao" AS ENUM ('PROMESSA', 'SEM_ACORDO', 'NAO_ATENDEU', 'JA_PAGOU', 'EXPIRADA');

-- CreateEnum
CREATE TYPE "tipo_execucao_regua" AS ENUM ('AUTOMATICA', 'MANUAL');

-- CreateEnum
CREATE TYPE "status_execucao_regua" AS ENUM ('EM_ANDAMENTO', 'CONCLUIDA', 'FALHOU');

-- AlterEnum
ALTER TYPE "tipo_importacao" ADD VALUE 'PARCELAS';

-- CreateTable
CREATE TABLE "contratos" (
    "id" UUID NOT NULL,
    "numero" SERIAL NOT NULL,
    "empresa_id" UUID,
    "contato_id" UUID,
    "negocio_id" UUID,
    "produto" TEXT NOT NULL,
    "descricao" TEXT,
    "valor" DECIMAL(14,2) NOT NULL,
    "periodicidade" "periodicidade_contrato" NOT NULL DEFAULT 'MENSAL',
    "mrr" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "inicio_em" DATE NOT NULL,
    "fim_em" DATE,
    "renovacao_em" DATE,
    "renovacao_automatica" BOOLEAN NOT NULL DEFAULT false,
    "dia_vencimento" INTEGER,
    "status" "status_contrato" NOT NULL DEFAULT 'ATIVO',
    "responsavel_cs_id" UUID,
    "cancelado_em" TIMESTAMPTZ(3),
    "motivo_cancelamento" TEXT,
    "encerrado_em" TIMESTAMPTZ(3),
    "criado_por_id" UUID,
    "criado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "contratos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "parcelas" (
    "id" UUID NOT NULL,
    "numero" TEXT NOT NULL,
    "sequencia" INTEGER,
    "contrato_id" UUID,
    "contato_id" UUID,
    "empresa_id" UUID,
    "origem" "origem_parcela" NOT NULL DEFAULT 'MANUAL',
    "descricao" TEXT,
    "vencimento" DATE NOT NULL,
    "vencimento_original" DATE NOT NULL,
    "valor" DECIMAL(14,2) NOT NULL,
    "valor_pago" DECIMAL(14,2),
    "status" "status_parcela" NOT NULL DEFAULT 'ABERTO',
    "link_boleto" TEXT,
    "link_pagamento" TEXT,
    "pix" TEXT,
    "pago_em" DATE,
    "forma_pagamento" "forma_pagamento",
    "baixa_origem" TEXT,
    "baixa_por_id" UUID,
    "renegociada_para_id" UUID,
    "promessa_ate" DATE,
    "promessa_registrada_em" TIMESTAMPTZ(3),
    "ciclo_regua" INTEGER NOT NULL DEFAULT 1,
    "atrasada_em" TIMESTAMPTZ(3),
    "criado_por_id" UUID,
    "criado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "parcelas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "movimentos_mrr" (
    "id" UUID NOT NULL,
    "contrato_id" UUID NOT NULL,
    "tipo" "tipo_movimento_mrr" NOT NULL,
    "valor_anterior" DECIMAL(14,2) NOT NULL,
    "valor_novo" DECIMAL(14,2) NOT NULL,
    "delta" DECIMAL(14,2) NOT NULL,
    "dia" DATE NOT NULL,
    "ocorrido_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "motivo" TEXT,
    "criado_por_id" UUID,

    CONSTRAINT "movimentos_mrr_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "regua_etapas" (
    "id" UUID NOT NULL,
    "nome" TEXT NOT NULL,
    "marco" INTEGER NOT NULL,
    "ativa" BOOLEAN NOT NULL DEFAULT true,
    "whatsapp" BOOLEAN NOT NULL DEFAULT true,
    "email" BOOLEAN NOT NULL DEFAULT false,
    "ligacao" BOOLEAN NOT NULL DEFAULT false,
    "modelo_whatsapp_id" UUID,
    "texto_whatsapp" TEXT,
    "modelo_email_id" UUID,
    "assunto_email" TEXT,
    "texto_email" TEXT,
    "roteiro_ligacao" TEXT,
    "criado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "regua_etapas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "regua_execucoes" (
    "id" UUID NOT NULL,
    "tipo" "tipo_execucao_regua" NOT NULL,
    "dia" DATE NOT NULL,
    "status" "status_execucao_regua" NOT NULL DEFAULT 'EM_ANDAMENTO',
    "disparada_por_id" UUID,
    "resumo" JSONB NOT NULL DEFAULT '{}',
    "erro" TEXT,
    "iniciada_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "concluida_em" TIMESTAMPTZ(3),

    CONSTRAINT "regua_execucoes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "regua_envios" (
    "id" UUID NOT NULL,
    "parcela_id" UUID NOT NULL,
    "ciclo" INTEGER NOT NULL DEFAULT 1,
    "etapa_id" UUID,
    "marco" INTEGER,
    "etapa_nome" TEXT NOT NULL,
    "tipo" TEXT NOT NULL DEFAULT 'ETAPA',
    "canal" "canal_da_regua",
    "situacao" "situacao_envio_regua" NOT NULL,
    "dia" DATE NOT NULL,
    "execucao_id" UUID,
    "destino" TEXT,
    "assunto" TEXT,
    "texto" TEXT,
    "agendado_para" TIMESTAMPTZ(3),
    "enviado_em" TIMESTAMPTZ(3),
    "mensagem_id" UUID,
    "atividade_id" UUID,
    "ligacao_id" UUID,
    "prazo_em" TIMESTAMPTZ(3),
    "motivo" TEXT,
    "erro" TEXT,
    "tentativas" INTEGER NOT NULL DEFAULT 0,
    "resultado" "resultado_ligacao",
    "resultado_em" TIMESTAMPTZ(3),
    "resultado_por_id" UUID,
    "observacao" TEXT,
    "promessa_ate" DATE,
    "criado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "regua_envios_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "contratos_numero_key" ON "contratos"("numero");

-- CreateIndex
CREATE INDEX "contratos_status_idx" ON "contratos"("status");

-- CreateIndex
CREATE INDEX "contratos_empresa_id_idx" ON "contratos"("empresa_id");

-- CreateIndex
CREATE INDEX "contratos_contato_id_idx" ON "contratos"("contato_id");

-- CreateIndex
CREATE INDEX "contratos_negocio_id_idx" ON "contratos"("negocio_id");

-- CreateIndex
CREATE INDEX "contratos_responsavel_cs_id_status_idx" ON "contratos"("responsavel_cs_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "parcelas_numero_key" ON "parcelas"("numero");

-- CreateIndex
CREATE INDEX "parcelas_contrato_id_sequencia_idx" ON "parcelas"("contrato_id", "sequencia");

-- CreateIndex
CREATE INDEX "parcelas_status_vencimento_idx" ON "parcelas"("status", "vencimento");

-- CreateIndex
CREATE INDEX "parcelas_contato_id_idx" ON "parcelas"("contato_id");

-- CreateIndex
CREATE INDEX "parcelas_empresa_id_idx" ON "parcelas"("empresa_id");

-- CreateIndex
CREATE INDEX "movimentos_mrr_dia_idx" ON "movimentos_mrr"("dia");

-- CreateIndex
CREATE INDEX "movimentos_mrr_contrato_id_ocorrido_em_idx" ON "movimentos_mrr"("contrato_id", "ocorrido_em");

-- CreateIndex
CREATE UNIQUE INDEX "regua_etapas_marco_key" ON "regua_etapas"("marco");

-- CreateIndex
CREATE INDEX "regua_execucoes_dia_tipo_idx" ON "regua_execucoes"("dia", "tipo");

-- CreateIndex
CREATE INDEX "regua_execucoes_iniciada_em_idx" ON "regua_execucoes"("iniciada_em");

-- CreateIndex
CREATE UNIQUE INDEX "regua_execucoes_automatica_dia_key" ON "regua_execucoes"("dia") WHERE (tipo = 'AUTOMATICA');

-- CreateIndex
CREATE INDEX "regua_envios_parcela_id_ciclo_marco_idx" ON "regua_envios"("parcela_id", "ciclo", "marco");

-- CreateIndex
CREATE INDEX "regua_envios_dia_canal_situacao_idx" ON "regua_envios"("dia", "canal", "situacao");

-- CreateIndex
CREATE INDEX "regua_envios_situacao_prazo_em_idx" ON "regua_envios"("situacao", "prazo_em");

-- CreateIndex
CREATE INDEX "regua_envios_execucao_id_idx" ON "regua_envios"("execucao_id");

-- CreateIndex
CREATE INDEX "regua_envios_ligacao_id_idx" ON "regua_envios"("ligacao_id");

-- AddForeignKey
ALTER TABLE "contratos" ADD CONSTRAINT "contratos_empresa_id_fkey" FOREIGN KEY ("empresa_id") REFERENCES "empresas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contratos" ADD CONSTRAINT "contratos_contato_id_fkey" FOREIGN KEY ("contato_id") REFERENCES "contatos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contratos" ADD CONSTRAINT "contratos_negocio_id_fkey" FOREIGN KEY ("negocio_id") REFERENCES "negocios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contratos" ADD CONSTRAINT "contratos_responsavel_cs_id_fkey" FOREIGN KEY ("responsavel_cs_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "parcelas" ADD CONSTRAINT "parcelas_contrato_id_fkey" FOREIGN KEY ("contrato_id") REFERENCES "contratos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "parcelas" ADD CONSTRAINT "parcelas_contato_id_fkey" FOREIGN KEY ("contato_id") REFERENCES "contatos"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "parcelas" ADD CONSTRAINT "parcelas_empresa_id_fkey" FOREIGN KEY ("empresa_id") REFERENCES "empresas"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "parcelas" ADD CONSTRAINT "parcelas_renegociada_para_id_fkey" FOREIGN KEY ("renegociada_para_id") REFERENCES "parcelas"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "movimentos_mrr" ADD CONSTRAINT "movimentos_mrr_contrato_id_fkey" FOREIGN KEY ("contrato_id") REFERENCES "contratos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "regua_envios" ADD CONSTRAINT "regua_envios_parcela_id_fkey" FOREIGN KEY ("parcela_id") REFERENCES "parcelas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "regua_envios" ADD CONSTRAINT "regua_envios_etapa_id_fkey" FOREIGN KEY ("etapa_id") REFERENCES "regua_etapas"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "regua_envios" ADD CONSTRAINT "regua_envios_execucao_id_fkey" FOREIGN KEY ("execucao_id") REFERENCES "regua_execucoes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Regras de integridade que o Prisma não declara (R22, R24).
ALTER TABLE "contratos"
  ADD CONSTRAINT "contratos_cliente_ck" CHECK ("empresa_id" IS NOT NULL OR "contato_id" IS NOT NULL),
  ADD CONSTRAINT "contratos_valor_ck" CHECK ("valor" >= 0 AND "mrr" >= 0),
  ADD CONSTRAINT "contratos_dia_vencimento_ck" CHECK ("dia_vencimento" IS NULL OR ("dia_vencimento" BETWEEN 1 AND 31)),
  ADD CONSTRAINT "contratos_periodo_ck" CHECK ("fim_em" IS NULL OR "fim_em" >= "inicio_em");

ALTER TABLE "parcelas"
  ADD CONSTRAINT "parcelas_valor_ck" CHECK ("valor" >= 0 AND ("valor_pago" IS NULL OR "valor_pago" >= 0));

ALTER TABLE "regua_etapas"
  ADD CONSTRAINT "regua_etapas_marco_ck" CHECK ("marco" BETWEEN -365 AND 365);
