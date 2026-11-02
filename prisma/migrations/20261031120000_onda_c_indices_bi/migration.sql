-- Índices do BI (R20, Onda C). Cada um foi conferido com EXPLAIN sobre os dados de demonstração:
-- o planejador usa o índice nas consultas de src/bi (leads e negócios por período e funil, ganhos,
-- perdidos, renovações, passagens, eventos de campanha, atividades feitas e conversas por período).

-- negocios
CREATE INDEX "negocios_funil_criado_idx" ON "negocios"("funil_id", "criado_em");
CREATE INDEX "negocios_funil_ganho_idx" ON "negocios"("funil_id", "ganho_em") WHERE ganho_em IS NOT NULL;
CREATE INDEX "negocios_funil_perdido_idx" ON "negocios"("funil_id", "perdido_em") WHERE perdido_em IS NOT NULL;
CREATE INDEX "negocios_previsao_aberto_idx" ON "negocios"("previsao_fechamento") WHERE (status = 'ABERTO'::status_negocio) AND (previsao_fechamento IS NOT NULL);

-- passagem_execucoes
CREATE INDEX "passagem_execucoes_negocio_origem_idx" ON "passagem_execucoes"("negocio_origem_id");
CREATE INDEX "passagem_execucoes_criado_idx" ON "passagem_execucoes"("criado_em");

-- campanha_destinatarios (as consultas filtram por OR destas cinco datas: BitmapOr)
CREATE INDEX "campanha_destinatarios_enviado_idx" ON "campanha_destinatarios"("enviado_em") WHERE enviado_em IS NOT NULL;
CREATE INDEX "campanha_destinatarios_entregue_idx" ON "campanha_destinatarios"("entregue_em") WHERE entregue_em IS NOT NULL;
CREATE INDEX "campanha_destinatarios_lido_idx" ON "campanha_destinatarios"("lido_em") WHERE lido_em IS NOT NULL;
CREATE INDEX "campanha_destinatarios_respondeu_idx" ON "campanha_destinatarios"("respondeu_em") WHERE respondeu_em IS NOT NULL;
CREATE INDEX "campanha_destinatarios_opt_out_idx" ON "campanha_destinatarios"("opt_out_em") WHERE opt_out_em IS NOT NULL;

-- atividades
CREATE INDEX "atividades_concluida_idx" ON "atividades"("concluida_em") WHERE status = 'CONCLUIDA'::status_atividade;

-- conversas (Atendimento e CSAT filtram por OR destas três datas)
CREATE INDEX "conversas_criado_idx" ON "conversas"("criado_em");
CREATE INDEX "conversas_resolvida_idx" ON "conversas"("resolvida_em") WHERE resolvida_em IS NOT NULL;
CREATE INDEX "conversas_csat_idx" ON "conversas"("satisfacao_respondida_em") WHERE satisfacao_respondida_em IS NOT NULL;
