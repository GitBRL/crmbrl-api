-- Indicadores do Financeiro agregam no banco (receita recebida por data de pagamento).
-- Índice parcial escrito à mão: o Prisma não declara índices com WHERE.
CREATE INDEX IF NOT EXISTS "parcelas_pago_em_pago_idx" ON "parcelas" ("pago_em") WHERE "status" = 'PAGO';
