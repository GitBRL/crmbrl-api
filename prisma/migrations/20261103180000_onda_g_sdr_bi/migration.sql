-- Onda G (G3): categoria da passagem para a equipe nas decisões do SDR (BI, R31.22).
ALTER TABLE "sdr_decisoes" ADD COLUMN "categoria" TEXT;

-- Passagens e bloqueios já registrados: classifica pelo texto do motivo.
UPDATE "sdr_decisoes" SET "categoria" = CASE
  WHEN "motivo" ILIKE '%orçamento mensal%' THEN 'orcamento'
  WHEN "motivo" ILIKE '%limite de%tokens%' THEN 'limite_conversa'
  WHEN "motivo" ILIKE '%mensagens sem avan%' THEN 'sem_avanco'
  WHEN "motivo" ILIKE '%mensagens da ia%' THEN 'limite_conversa'
  WHEN "motivo" ILIKE '%opt-out%' THEN 'opt_out'
  WHEN "motivo" ILIKE '%janela%' THEN 'janela_24h'
  WHEN "motivo" ILIKE '%fluxo autom%' OR "titulo" ILIKE '%fluxo autom%' THEN 'fluxo'
  WHEN "tipo" = 'FALHA' THEN 'falha_da_ia'
  WHEN "motivo" ILIKE '%humano%' OR "motivo" ILIKE '%atendente%' OR "motivo" ILIKE '%pessoa%' THEN 'pedido_humano'
  WHEN "motivo" ILIKE '%reclam%' OR "motivo" ILIKE '%insatisf%' THEN 'reclamacao'
  WHEN "motivo" ILIKE '%sens%' OR "motivo" ILIKE '%escopo%' THEN 'assunto_sensivel'
  WHEN "motivo" ILIKE '%confian%' THEN 'baixa_confianca'
  ELSE 'outro'
END
WHERE "tipo" IN ('PASSOU_HUMANO', 'BLOQUEIO', 'FALHA')
  AND ("acao" = 'PASSAR_HUMANO' OR "titulo" ILIKE '%fluxo autom%');

CREATE INDEX "sdr_decisoes_tipo_criado_em_idx" ON "sdr_decisoes"("tipo", "criado_em");
