-- T2 (Onda T): resultado da reunião (R6.6) e primeira interação do negócio (R6.7).
-- 1. `atividades.resultado_reuniao` (nulo = sem resultado) e `atividades.remarcada_de_id` (reunião de origem).
-- 2. `negocios.primeira_interacao_em|tipo|por_id`, gravados uma única vez por quem registra a interação.
-- 3. Preenchimento retroativo da primeira interação a partir do que já existe (atividades concluídas
--    que não são nota, mensagens de saída escritas por pessoas e ligações feitas ou atendidas por
--    pessoas), sempre depois da criação do negócio. São UPDATEs que varrem atividades, mensagens e
--    ligações e travam as linhas dos negócios atualizados, dentro de uma única transação: aceitável com as
--    tabelas pequenas desta fase; em bases grandes, rode o preenchimento em lotes fora da migration.
BEGIN;

CREATE TYPE "resultado_reuniao" AS ENUM ('COMPARECEU', 'NAO_COMPARECEU', 'REMARCADA');

CREATE TYPE "tipo_primeira_interacao" AS ENUM ('LIGACAO', 'MENSAGEM', 'EMAIL', 'ATIVIDADE');

ALTER TABLE "atividades"
  ADD COLUMN "resultado_reuniao" "resultado_reuniao",
  ADD COLUMN "remarcada_de_id" UUID;

ALTER TABLE "atividades"
  ADD CONSTRAINT "atividades_remarcada_de_id_fkey" FOREIGN KEY ("remarcada_de_id")
  REFERENCES "atividades"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "atividades_remarcada_de_id_idx" ON "atividades"("remarcada_de_id");

ALTER TABLE "negocios"
  ADD COLUMN "primeira_interacao_em" TIMESTAMPTZ(3),
  ADD COLUMN "primeira_interacao_tipo" "tipo_primeira_interacao",
  ADD COLUMN "primeira_interacao_por_id" UUID;

ALTER TABLE "negocios"
  ADD CONSTRAINT "negocios_primeira_interacao_por_id_fkey" FOREIGN KEY ("primeira_interacao_por_id")
  REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "negocios_primeira_interacao_idx" ON "negocios"("primeira_interacao_em")
  WHERE primeira_interacao_em IS NOT NULL;

-- Preenchimento retroativo.
UPDATE "negocios" AS n
   SET "primeira_interacao_em" = p.quando,
       "primeira_interacao_tipo" = p.tipo,
       "primeira_interacao_por_id" = p.por
  FROM (
    SELECT DISTINCT ON (c.negocio_id) c.negocio_id, c.quando, c.tipo, c.por
      FROM (
        -- Atividades concluídas (menos nota), ligadas ao contato ou ao negócio.
        SELECT n2.id AS negocio_id, a.concluida_em AS quando,
               'ATIVIDADE'::tipo_primeira_interacao AS tipo, a.concluida_por_id AS por
          FROM atividades a
          JOIN negocios n2 ON n2.id = a.negocio_id OR n2.contato_id = a.contato_id
         WHERE a.status = 'CONCLUIDA' AND a.tipo <> 'NOTA' AND a.concluida_em IS NOT NULL
        UNION ALL
        -- Mensagens de saída escritas por uma pessoa (e-mail ou outro canal).
        SELECT n2.id, m.ocorrida_em,
               CASE WHEN ca.tipo = 'EMAIL' THEN 'EMAIL' ELSE 'MENSAGEM' END::tipo_primeira_interacao,
               m.autor_id
          FROM mensagens m
          JOIN conversas cv ON cv.id = m.conversa_id
          JOIN canais ca ON ca.id = m.canal_id
          JOIN negocios n2 ON n2.contato_id = cv.contato_id
         WHERE m.direcao = 'SAIDA' AND m.autor_id IS NOT NULL
        UNION ALL
        -- Ligações feitas por uma pessoa, ou recebidas e atendidas por ela.
        SELECT n2.id, CASE WHEN l.direcao = 'FEITA' THEN l.iniciada_em ELSE l.atendida_em END,
               'LIGACAO'::tipo_primeira_interacao, l.atendente_id
          FROM ligacoes l
          JOIN negocios n2 ON n2.contato_id = l.contato_id
         WHERE l.atendente_id IS NOT NULL
           AND (l.direcao = 'FEITA' OR l.atendida_em IS NOT NULL)
      ) c
      JOIN negocios nn ON nn.id = c.negocio_id
     WHERE c.quando >= nn.criado_em
     ORDER BY c.negocio_id, c.quando ASC
  ) p
 WHERE n.id = p.negocio_id AND n.excluido_em IS NULL AND n.primeira_interacao_em IS NULL;

COMMIT;
