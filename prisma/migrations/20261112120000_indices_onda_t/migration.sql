-- Correções da revisão da Onda T: índices dos indicadores de reunião e de leads, e vínculo 3C+ único por usuário do 3C+.
-- Só cria índices (as tabelas são pequenas nesta fase; CREATE INDEX comum basta).

-- Indicadores de reunião (R33): reuniões por início.
CREATE INDEX "atividades_reuniao_inicio_idx" ON "atividades"("inicio_em") WHERE tipo = 'REUNIAO'::tipo_atividade;

-- Indicadores de leads/negócios criados no período (R33).
CREATE INDEX "negocios_criado_idx" ON "negocios"("criado_em");

-- R34.2: um usuário do 3C+ só pode estar conectado a uma pessoa do CRM. Antes, desfaz duplicidades
-- antigas (mantém o vínculo mais recente de cada usuário do 3C+).
DELETE FROM "tresc_plus_vinculos" v
USING "tresc_plus_vinculos" outro
WHERE v."tresc_usuario_id" = outro."tresc_usuario_id"
  AND (v."vinculado_em", v."id") < (outro."vinculado_em", outro."id");

DROP INDEX "tresc_plus_vinculos_tresc_usuario_id_idx";
CREATE UNIQUE INDEX "tresc_plus_vinculos_tresc_usuario_id_key" ON "tresc_plus_vinculos"("tresc_usuario_id");
