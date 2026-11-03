-- Onda E4 (R30.8, R30.9): busca no texto das transcrições e resumo no webhook de saída.

-- AlterTable
ALTER TABLE "canais_ligacoes" ADD COLUMN "webhook_inclui_resumo" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "ligacoes" ADD COLUMN "transcricao_busca" tsvector,
ADD COLUMN "recusada_por" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- Texto da transcrição sem acento, em tsvector português. Mantido pelo banco: todo
-- caminho que grava ou apaga `transcricao` (transcrição, reprocesso, guarda, LGPD) atualiza a busca.
CREATE FUNCTION ligacoes_atualizar_busca_transcricao() RETURNS trigger AS $$
BEGIN
  IF NEW.transcricao IS NULL OR jsonb_typeof(NEW.transcricao->'trechos') IS DISTINCT FROM 'array' THEN
    NEW.transcricao_busca := NULL;
  ELSE
    NEW.transcricao_busca := to_tsvector(
      'portuguese',
      translate(
        coalesce((SELECT string_agg(t->>'texto', ' ') FROM jsonb_array_elements(NEW.transcricao->'trechos') AS t), ''),
        'áàâãäéèêëíìîïóòôõöúùûüçñÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑ',
        'aaaaaeeeeiiiiooooouuuucnAAAAAEEEEIIIIOOOOOUUUUCN'
      )
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ligacoes_busca_transcricao
  BEFORE INSERT OR UPDATE OF transcricao ON "ligacoes"
  FOR EACH ROW EXECUTE FUNCTION ligacoes_atualizar_busca_transcricao();

-- Transcrições que já existiam.
UPDATE "ligacoes" SET "transcricao" = "transcricao" WHERE "transcricao" IS NOT NULL;

-- CreateIndex
CREATE INDEX "ligacoes_transcricao_busca_idx" ON "ligacoes" USING GIN ("transcricao_busca");

-- CreateIndex
CREATE INDEX "ligacoes_iniciada_em_idx" ON "ligacoes"("iniciada_em");
