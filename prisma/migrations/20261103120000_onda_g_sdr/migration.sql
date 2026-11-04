-- CreateEnum
CREATE TYPE "modo_sdr" AS ENUM ('DESLIGADO', 'AUTOMATICO', 'SUGESTAO');

-- CreateEnum
CREATE TYPE "situacao_sdr" AS ENUM ('ATIVA', 'HUMANO', 'PASSADA_HUMANO', 'QUALIFICADA', 'DESQUALIFICADA', 'ENCERRADA');

-- CreateEnum
CREATE TYPE "tipo_criterio_sdr" AS ENUM ('TEXTO', 'OPCAO', 'NUMERO', 'DATA', 'SIM_NAO');

-- CreateEnum
CREATE TYPE "alvo_criterio_sdr" AS ENUM ('NENHUM', 'CONTATO', 'NEGOCIO');

-- CreateEnum
CREATE TYPE "temperatura_sdr" AS ENUM ('QUENTE', 'MORNO', 'FRIO');

-- CreateEnum
CREATE TYPE "acao_sdr" AS ENUM ('CONTINUAR', 'QUALIFICADO', 'DESQUALIFICADO', 'PASSAR_HUMANO');

-- CreateEnum
CREATE TYPE "status_sugestao_sdr" AS ENUM ('PENDENTE', 'ENVIADA', 'DESCARTADA', 'OBSOLETA');

-- CreateEnum
CREATE TYPE "tipo_decisao_sdr" AS ENUM ('ASSUMIU', 'TURNO', 'QUALIFICADO', 'DESQUALIFICADO', 'PASSOU_HUMANO', 'HUMANO_ASSUMIU', 'DEVOLVIDA', 'BLOQUEIO', 'FALHA');

-- CreateTable
CREATE TABLE "sdr_configuracoes" (
    "id" UUID NOT NULL,
    "chave" TEXT NOT NULL DEFAULT 'padrao',
    "nome_assistente" TEXT NOT NULL DEFAULT 'Bia',
    "tom" TEXT NOT NULL DEFAULT 'Simpático, claro e objetivo, sem gírias.',
    "apresentacao" TEXT NOT NULL DEFAULT 'Sou a Bia, assistente virtual da BRL.',
    "mensagem_passagem" TEXT NOT NULL DEFAULT 'Vou chamar uma pessoa da nossa equipe para continuar com você. Já passei o que conversamos, não precisa repetir.',
    "modelo" TEXT NOT NULL DEFAULT 'claude-sonnet-5-5',
    "esforco" TEXT NOT NULL DEFAULT 'low',
    "espera_agrupamento_segundos" INTEGER NOT NULL DEFAULT 8,
    "max_mensagens_por_conversa" INTEGER NOT NULL DEFAULT 30,
    "max_mensagens_sem_avanco" INTEGER NOT NULL DEFAULT 8,
    "max_tokens_por_conversa" INTEGER NOT NULL DEFAULT 200000,
    "orcamento_mensal_tokens" INTEGER DEFAULT 5000000,
    "nota_minima_qualificado" INTEGER NOT NULL DEFAULT 60,
    "faixa_quente" INTEGER NOT NULL DEFAULT 70,
    "faixa_morno" INTEGER NOT NULL DEFAULT 40,
    "regras_passagem" JSONB NOT NULL DEFAULT '{"pedidoHumano": true, "assuntoSensivel": true, "baixaConfianca": true, "confiancaMinima": 0.4, "semAvanco": true, "reclamacao": true}',
    "base_versao" INTEGER NOT NULL DEFAULT 1,
    "avisos_de_orcamento" JSONB NOT NULL DEFAULT '{}',
    "modelo_captacao_aplicado_em" TIMESTAMPTZ(3),
    "atualizado_por_id" UUID,
    "criado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "sdr_configuracoes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sdr_canais" (
    "id" UUID NOT NULL,
    "canal_id" UUID NOT NULL,
    "modo" "modo_sdr" NOT NULL DEFAULT 'DESLIGADO',
    "atualizado_por_id" UUID,
    "criado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "sdr_canais_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sdr_artigos" (
    "id" UUID NOT NULL,
    "titulo" TEXT NOT NULL,
    "conteudo" TEXT NOT NULL,
    "ordem" INTEGER NOT NULL DEFAULT 0,
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "versao_atual" INTEGER NOT NULL DEFAULT 1,
    "criado_por_id" UUID,
    "atualizado_por_id" UUID,
    "criado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMPTZ(3) NOT NULL,
    "excluido_em" TIMESTAMPTZ(3),

    CONSTRAINT "sdr_artigos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sdr_artigos_versoes" (
    "id" UUID NOT NULL,
    "artigo_id" UUID NOT NULL,
    "numero" INTEGER NOT NULL,
    "titulo" TEXT NOT NULL,
    "conteudo" TEXT NOT NULL,
    "ativo" BOOLEAN NOT NULL,
    "excluido" BOOLEAN NOT NULL DEFAULT false,
    "autor_id" UUID,
    "criado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sdr_artigos_versoes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sdr_criterios" (
    "id" UUID NOT NULL,
    "chave" TEXT NOT NULL,
    "rotulo" TEXT NOT NULL,
    "instrucao" TEXT NOT NULL,
    "tipo" "tipo_criterio_sdr" NOT NULL DEFAULT 'TEXTO',
    "opcoes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "alvo" "alvo_criterio_sdr" NOT NULL DEFAULT 'NENHUM',
    "campo" TEXT,
    "peso" INTEGER NOT NULL DEFAULT 10,
    "obrigatorio" BOOLEAN NOT NULL DEFAULT false,
    "ordem" INTEGER NOT NULL DEFAULT 0,
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "criado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMPTZ(3) NOT NULL,
    "excluido_em" TIMESTAMPTZ(3),

    CONSTRAINT "sdr_criterios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sdr_conversas" (
    "id" UUID NOT NULL,
    "conversa_id" UUID NOT NULL,
    "situacao" "situacao_sdr" NOT NULL DEFAULT 'ATIVA',
    "modo" "modo_sdr" NOT NULL,
    "origem" TEXT NOT NULL DEFAULT 'novo',
    "nota" INTEGER,
    "temperatura" "temperatura_sdr",
    "resumo" TEXT,
    "motivo" TEXT,
    "mensagens_ia" INTEGER NOT NULL DEFAULT 0,
    "mensagens_sem_avanco" INTEGER NOT NULL DEFAULT 0,
    "tokens_entrada" INTEGER NOT NULL DEFAULT 0,
    "tokens_saida" INTEGER NOT NULL DEFAULT 0,
    "tokens_cache_leitura" INTEGER NOT NULL DEFAULT 0,
    "tokens_cache_escrita" INTEGER NOT NULL DEFAULT 0,
    "processado_ate" TIMESTAMPTZ(3),
    "execucao_desde" TIMESTAMPTZ(3),
    "humano_id" UUID,
    "situacao_desde" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "negocio_id" UUID,
    "qualificada_em" TIMESTAMPTZ(3),
    "primeira_resposta_em" TIMESTAMPTZ(3),
    "criado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "sdr_conversas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sdr_valores" (
    "id" UUID NOT NULL,
    "sdr_conversa_id" UUID NOT NULL,
    "chave" TEXT NOT NULL,
    "rotulo" TEXT NOT NULL,
    "valor" JSONB NOT NULL,
    "confianca" DECIMAL(3,2) NOT NULL,
    "origem" TEXT NOT NULL DEFAULT 'IA',
    "destino" TEXT,
    "mensagem_id" UUID,
    "criado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "sdr_valores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sdr_decisoes" (
    "id" UUID NOT NULL,
    "conversa_id" UUID,
    "tipo" "tipo_decisao_sdr" NOT NULL,
    "acao" "acao_sdr",
    "titulo" TEXT NOT NULL,
    "motivo" TEXT,
    "resumo" TEXT,
    "resposta" TEXT,
    "criterios" JSONB,
    "nota" INTEGER,
    "temperatura" "temperatura_sdr",
    "modo" "modo_sdr",
    "modelo" TEXT,
    "base_versao" INTEGER,
    "mensagem_id" UUID,
    "usuario_id" UUID,
    "tokens_entrada" INTEGER NOT NULL DEFAULT 0,
    "tokens_saida" INTEGER NOT NULL DEFAULT 0,
    "tokens_cache_leitura" INTEGER NOT NULL DEFAULT 0,
    "tokens_cache_escrita" INTEGER NOT NULL DEFAULT 0,
    "tentativas" INTEGER NOT NULL DEFAULT 1,
    "simulador" BOOLEAN NOT NULL DEFAULT false,
    "criado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sdr_decisoes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sdr_sugestoes" (
    "id" UUID NOT NULL,
    "conversa_id" UUID NOT NULL,
    "decisao_id" UUID,
    "texto" TEXT NOT NULL,
    "acao" "acao_sdr" NOT NULL,
    "motivo" TEXT,
    "resumo" TEXT,
    "criterios" JSONB,
    "status" "status_sugestao_sdr" NOT NULL DEFAULT 'PENDENTE',
    "resolvida_em" TIMESTAMPTZ(3),
    "resolvida_por_id" UUID,
    "mensagem_enviada_id" UUID,
    "texto_enviado" TEXT,
    "criado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sdr_sugestoes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sdr_configuracoes_chave_key" ON "sdr_configuracoes"("chave");

-- CreateIndex
CREATE UNIQUE INDEX "sdr_canais_canal_id_key" ON "sdr_canais"("canal_id");

-- CreateIndex
CREATE INDEX "sdr_artigos_ativo_ordem_idx" ON "sdr_artigos"("ativo", "ordem");

-- CreateIndex
CREATE UNIQUE INDEX "sdr_artigos_versoes_artigo_id_numero_key" ON "sdr_artigos_versoes"("artigo_id", "numero");

-- CreateIndex
CREATE INDEX "sdr_criterios_ativo_ordem_idx" ON "sdr_criterios"("ativo", "ordem");

-- CreateIndex
CREATE UNIQUE INDEX "sdr_criterios_chave_ativa_key" ON "sdr_criterios"("chave") WHERE (excluido_em IS NULL);

-- CreateIndex
CREATE UNIQUE INDEX "sdr_conversas_conversa_id_key" ON "sdr_conversas"("conversa_id");

-- CreateIndex
CREATE INDEX "sdr_conversas_situacao_idx" ON "sdr_conversas"("situacao");

-- CreateIndex
CREATE INDEX "sdr_conversas_criado_em_idx" ON "sdr_conversas"("criado_em");

-- CreateIndex
CREATE UNIQUE INDEX "sdr_valores_sdr_conversa_id_chave_key" ON "sdr_valores"("sdr_conversa_id", "chave");

-- CreateIndex
CREATE INDEX "sdr_decisoes_conversa_id_criado_em_idx" ON "sdr_decisoes"("conversa_id", "criado_em");

-- CreateIndex
CREATE INDEX "sdr_decisoes_criado_em_idx" ON "sdr_decisoes"("criado_em");

-- CreateIndex
CREATE INDEX "sdr_sugestoes_conversa_id_status_idx" ON "sdr_sugestoes"("conversa_id", "status");

-- AddForeignKey
ALTER TABLE "sdr_canais" ADD CONSTRAINT "sdr_canais_canal_id_fkey" FOREIGN KEY ("canal_id") REFERENCES "canais"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sdr_artigos_versoes" ADD CONSTRAINT "sdr_artigos_versoes_artigo_id_fkey" FOREIGN KEY ("artigo_id") REFERENCES "sdr_artigos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sdr_conversas" ADD CONSTRAINT "sdr_conversas_conversa_id_fkey" FOREIGN KEY ("conversa_id") REFERENCES "conversas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sdr_valores" ADD CONSTRAINT "sdr_valores_sdr_conversa_id_fkey" FOREIGN KEY ("sdr_conversa_id") REFERENCES "sdr_conversas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sdr_decisoes" ADD CONSTRAINT "sdr_decisoes_conversa_id_fkey" FOREIGN KEY ("conversa_id") REFERENCES "conversas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sdr_sugestoes" ADD CONSTRAINT "sdr_sugestoes_conversa_id_fkey" FOREIGN KEY ("conversa_id") REFERENCES "conversas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

