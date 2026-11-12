-- U1 (R35.2): RLS como segunda barreira nas tabelas principais.
--
-- A API põe em cada consulta (src/prisma/pool-com-contexto.ts):
--   crm.ator     = '' (nenhum contexto: nega tudo) | 'sistema' (jobs, webhooks, rotas públicas, gateway) | id do usuário
--   crm.escrita  = a tabela de um INSERT/UPDATE/DELETE numa tabela protegida, só durante ele
--   crm.escritos = os ids que a transação corrente gravou (RETURNING), para reler o que acabou de gravar
-- As políticas espelham as regras de visibilidade da API (R5.9/R5.11/R5.12, R6.4, R11.4, R12.5, R29.8):
--   ler      = visível (V) OU (escrita nesta tabela E gravável (W)) OU gravada nesta transação
--              (o UPDATE confere a linha nova contra a leitura; o Prisma relê a linha gravada)
--   inserir  = W
--   alterar  = linha antiga V (ou gravada nesta transação); linha nova W -- passar o negócio a um colega continua possível
--   excluir  = V
-- As funções são STABLE, com search_path fixo, em PL/pgSQL (o plano fica guardado na conexão), e as políticas
-- as chamam dentro de (SELECT …): o PostgreSQL as calcula uma vez por consulta (InitPlan), não por linha.
-- O papel da aplicação (sem superusuário, sem BYPASSRLS) e as permissões dele são criados por
-- src/banco/preparar-banco.ts (o entrypoint roda depois das migrations), não aqui: a senha vem do ambiente.

CREATE SCHEMA IF NOT EXISTS "rls";

-- ---------------------------------------------------------------------------
-- Quem está consultando
-- ---------------------------------------------------------------------------

CREATE FUNCTION rls.ator() RETURNS text
LANGUAGE plpgsql STABLE PARALLEL SAFE SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
BEGIN
  RETURN (
  SELECT coalesce(current_setting('crm.ator', true), '')
  );
END
$$;

CREATE FUNCTION rls.escrita() RETURNS text
LANGUAGE plpgsql STABLE PARALLEL SAFE SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
BEGIN
  RETURN (
  SELECT coalesce(current_setting('crm.escrita', true), '')
  );
END
$$;

-- Os ids gravados pela transação corrente (a API os põe; vazio fora de transação).
CREATE FUNCTION rls.escritos() RETURNS uuid[]
LANGUAGE plpgsql STABLE PARALLEL SAFE SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  texto text := coalesce(current_setting('crm.escritos', true), '');
BEGIN
  IF texto = '' THEN
    RETURN '{}'::uuid[];
  END IF;
  RETURN string_to_array(texto, ',')::uuid[];
EXCEPTION WHEN invalid_text_representation THEN
  RETURN '{}'::uuid[];
END
$$;

CREATE FUNCTION rls.sistema() RETURNS boolean
LANGUAGE plpgsql STABLE PARALLEL SAFE SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
BEGIN
  RETURN (
  SELECT rls.ator() = 'sistema'
  );
END
$$;

-- O usuário do contexto (NULL para sistema ou sem contexto).
CREATE FUNCTION rls.usuario_id() RETURNS uuid
LANGUAGE plpgsql STABLE PARALLEL SAFE SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
BEGIN
  RETURN (
  SELECT CASE WHEN a ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
              THEN a::uuid END
    FROM (SELECT rls.ator() AS a) x
  );
END
$$;

-- Há contexto (sistema ou um usuário que existe)?
CREATE FUNCTION rls.tem_contexto() RETURNS boolean
LANGUAGE plpgsql STABLE PARALLEL SAFE SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
BEGIN
  RETURN (
  SELECT rls.sistema()
      OR EXISTS (SELECT 1 FROM public.usuarios u WHERE u.id = rls.usuario_id())
  );
END
$$;

-- Sistema, Admin ou C-level: veem tudo (menos o chat interno dos outros, R15.3 — veja arquivos).
CREATE FUNCTION rls.ve_tudo() RETURNS boolean
LANGUAGE plpgsql STABLE PARALLEL SAFE SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
BEGIN
  RETURN (
  SELECT rls.sistema()
      OR EXISTS (SELECT 1 FROM public.usuarios u
                  WHERE u.id = rls.usuario_id() AND u.papel IN ('ADMIN', 'C_LEVEL'))
  );
END
$$;

CREATE FUNCTION rls.eh_admin() RETURNS boolean
LANGUAGE plpgsql STABLE PARALLEL SAFE SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
BEGIN
  RETURN (
  SELECT EXISTS (SELECT 1 FROM public.usuarios u WHERE u.id = rls.usuario_id() AND u.papel = 'ADMIN')
  );
END
$$;

-- A equipe direta (R6.4, R29.8: o líder vê o que é dos liderados).
CREATE FUNCTION rls.liderados() RETURNS uuid[]
LANGUAGE plpgsql STABLE PARALLEL SAFE SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
BEGIN
  RETURN (
  SELECT coalesce(array_agg(u.id), '{}') FROM public.usuarios u WHERE u.lider_id = rls.usuario_id()
  );
END
$$;

-- ---------------------------------------------------------------------------
-- Funis (R5.9, R5.11, R5.12) — o mesmo cálculo de funisAcessiveis/alcanceEfetivo
-- ---------------------------------------------------------------------------

-- Cada funil que a pessoa (líder ou membro) vê e se ela vê todos os negócios dele (veTodos).
CREATE FUNCTION rls.alcance_nos_funis() RETURNS TABLE (funil_id uuid, ve_todos boolean)
LANGUAGE plpgsql STABLE PARALLEL SAFE SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
BEGIN
  RETURN QUERY
  WITH eu AS (
    SELECT u.id, u.papel, u.area, coalesce(s.ativo, false) AS setor_ativo
      FROM public.usuarios u
      LEFT JOIN public.setores s ON s.chave = u.area
     WHERE u.id = rls.usuario_id() AND u.papel IN ('LIDER', 'MEMBRO') AND u.area IS NOT NULL
  ), niveis AS (
    -- O papel no setor dono: líder → CONFIGURAR (vê todos); membro → MEMBRO, só no funil SETOR.
    SELECT f.id AS funil_id, (eu.papel = 'LIDER') AS ve_todos
      FROM public.funis f JOIN eu ON f.area = eu.area
     WHERE eu.papel = 'LIDER' OR f.visibilidade = 'SETOR'
    UNION ALL
    -- Acessos do funil, pela pessoa ou pelo setor dela (setor ativo).
    SELECT a.funil_id, a.nivel <> 'MEMBRO'
      FROM public.acessos_funil a
      JOIN eu ON a.usuario_id = eu.id OR (eu.setor_ativo AND a.area = eu.area)
    UNION ALL
    -- Acessos do setor dono: valem para os funis SETOR dele (não para os RESTRITA).
    SELECT f.id, a.nivel <> 'MEMBRO'
      FROM public.acessos_setor a
      JOIN eu ON a.usuario_id = eu.id OR (eu.setor_ativo AND a.area = eu.area)
      JOIN public.funis f ON f.area = a.area_dono AND f.visibilidade = 'SETOR'
  )
  SELECT n.funil_id, bool_or(n.ve_todos) FROM niveis n GROUP BY n.funil_id;
END
$$;

-- Funis em que vê todos os negócios (VER, GESTOR ou CONFIGURAR por algum caminho).
CREATE FUNCTION rls.funis_completos() RETURNS uuid[]
LANGUAGE plpgsql STABLE PARALLEL SAFE SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
BEGIN
  RETURN (
  SELECT coalesce(array_agg(a.funil_id), '{}') FROM rls.alcance_nos_funis() a WHERE a.ve_todos
  );
END
$$;

-- Funis em que vê só os seus negócios e os sem responsável (só MEMBRO).
CREATE FUNCTION rls.funis_de_membro() RETURNS uuid[]
LANGUAGE plpgsql STABLE PARALLEL SAFE SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
BEGIN
  RETURN (
  SELECT coalesce(array_agg(a.funil_id), '{}') FROM rls.alcance_nos_funis() a WHERE NOT a.ve_todos
  );
END
$$;

-- ---------------------------------------------------------------------------
-- Atendimento (R12.5): o Marketing não usa; o líder vê as filas do setor; o membro, as sem responsável delas
-- ---------------------------------------------------------------------------

CREATE FUNCTION rls.usa_atendimento() RETURNS boolean
LANGUAGE plpgsql STABLE PARALLEL SAFE SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
BEGIN
  RETURN (
  SELECT EXISTS (SELECT 1 FROM public.usuarios u
                  WHERE u.id = rls.usuario_id()
                    AND (u.papel IN ('ADMIN', 'C_LEVEL') OR (u.area IS NOT NULL AND u.area <> 'MARKETING')))
  );
END
$$;

-- Filas do setor em que a pessoa vê todas as conversas (líder).
CREATE FUNCTION rls.filas_do_lider() RETURNS uuid[]
LANGUAGE plpgsql STABLE PARALLEL SAFE SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
BEGIN
  RETURN (
  SELECT coalesce(array_agg(f.id), '{}')
    FROM public.filas_atendimento f
    JOIN public.usuarios u ON u.area = f.area
   WHERE u.id = rls.usuario_id() AND u.papel = 'LIDER' AND u.area <> 'MARKETING'
  );
END
$$;

-- Filas do setor em que a pessoa vê as conversas sem responsável (membro).
CREATE FUNCTION rls.filas_do_membro() RETURNS uuid[]
LANGUAGE plpgsql STABLE PARALLEL SAFE SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
BEGIN
  RETURN (
  SELECT coalesce(array_agg(f.id), '{}')
    FROM public.filas_atendimento f
    JOIN public.usuarios u ON u.area = f.area
   WHERE u.id = rls.usuario_id() AND u.papel = 'MEMBRO' AND u.area <> 'MARKETING'
  );
END
$$;

-- ---------------------------------------------------------------------------
-- Índices para as conferências por linha dos arquivos (R11.4)
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS "mensagens_arquivo_idx" ON "mensagens"("arquivo_id") WHERE "arquivo_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "chat_mensagens_arquivo_idx" ON "chat_mensagens"("arquivo_id") WHERE "arquivo_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "respostas_rapidas_arquivo_idx" ON "respostas_rapidas"("arquivo_id") WHERE "arquivo_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "importacoes_arquivo_idx" ON "importacoes"("arquivo_id") WHERE "arquivo_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "ligacoes_gravacao_arquivo_idx" ON "ligacoes"("gravacao_arquivo_id") WHERE "gravacao_arquivo_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "ligacoes_gravacao_original_idx" ON "ligacoes"("gravacao_original_arquivo_id") WHERE "gravacao_original_arquivo_id" IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Contatos e empresas: todo usuário vê (matriz §12); sem contexto, nada
-- ---------------------------------------------------------------------------

ALTER TABLE "contatos" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "contatos" FORCE ROW LEVEL SECURITY;
CREATE POLICY "contatos_ler" ON "contatos" FOR SELECT USING ((SELECT rls.tem_contexto()));
CREATE POLICY "contatos_inserir" ON "contatos" FOR INSERT WITH CHECK ((SELECT rls.tem_contexto()));
CREATE POLICY "contatos_alterar" ON "contatos" FOR UPDATE
  USING ((SELECT rls.tem_contexto())) WITH CHECK ((SELECT rls.tem_contexto()));
CREATE POLICY "contatos_excluir" ON "contatos" FOR DELETE USING ((SELECT rls.tem_contexto()));

ALTER TABLE "empresas" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "empresas" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresas_ler" ON "empresas" FOR SELECT USING ((SELECT rls.tem_contexto()));
CREATE POLICY "empresas_inserir" ON "empresas" FOR INSERT WITH CHECK ((SELECT rls.tem_contexto()));
CREATE POLICY "empresas_alterar" ON "empresas" FOR UPDATE
  USING ((SELECT rls.tem_contexto())) WITH CHECK ((SELECT rls.tem_contexto()));
CREATE POLICY "empresas_excluir" ON "empresas" FOR DELETE USING ((SELECT rls.tem_contexto()));

-- ---------------------------------------------------------------------------
-- Negócios (R5.9, R5.12): funis que vê; no funil de membro, os seus e os sem responsável.
-- Gravável: qualquer negócio de funil que a pessoa vê (o nível de ação é conferido pela API).
-- ---------------------------------------------------------------------------

ALTER TABLE "negocios" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "negocios" FORCE ROW LEVEL SECURITY;
CREATE POLICY "negocios_ler" ON "negocios" FOR SELECT USING (
  (SELECT rls.ve_tudo())
  OR "funil_id" = ANY ((SELECT rls.funis_completos())::uuid[])
  OR ("funil_id" = ANY ((SELECT rls.funis_de_membro())::uuid[])
      AND ((SELECT rls.escrita()) = 'negocios' OR "responsavel_id" IS NULL OR "responsavel_id" = (SELECT rls.usuario_id())))
  OR "id" = ANY ((SELECT rls.escritos())::uuid[])
);
CREATE POLICY "negocios_inserir" ON "negocios" FOR INSERT WITH CHECK (
  (SELECT rls.ve_tudo())
  OR "funil_id" = ANY ((SELECT rls.funis_completos())::uuid[])
  OR "funil_id" = ANY ((SELECT rls.funis_de_membro())::uuid[])
);
CREATE POLICY "negocios_alterar" ON "negocios" FOR UPDATE USING (
  (SELECT rls.ve_tudo())
  OR "funil_id" = ANY ((SELECT rls.funis_completos())::uuid[])
  OR ("funil_id" = ANY ((SELECT rls.funis_de_membro())::uuid[])
      AND ("responsavel_id" IS NULL OR "responsavel_id" = (SELECT rls.usuario_id())))
  OR "id" = ANY ((SELECT rls.escritos())::uuid[])
) WITH CHECK (
  (SELECT rls.ve_tudo())
  OR "funil_id" = ANY ((SELECT rls.funis_completos())::uuid[])
  OR "funil_id" = ANY ((SELECT rls.funis_de_membro())::uuid[])
);
CREATE POLICY "negocios_excluir" ON "negocios" FOR DELETE USING (
  (SELECT rls.ve_tudo())
  OR "funil_id" = ANY ((SELECT rls.funis_completos())::uuid[])
  OR ("funil_id" = ANY ((SELECT rls.funis_de_membro())::uuid[])
      AND ("responsavel_id" IS NULL OR "responsavel_id" = (SELECT rls.usuario_id())))
);

-- ---------------------------------------------------------------------------
-- Atividades (R6.4): responsável, quem criou, o líder direto do responsável, C-level e Admin.
-- Gravável: qualquer contexto (criar ou passar a atividade a outra pessoa é permitido pela regra).
-- ---------------------------------------------------------------------------

ALTER TABLE "atividades" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "atividades" FORCE ROW LEVEL SECURITY;
CREATE POLICY "atividades_ler" ON "atividades" FOR SELECT USING (
  (SELECT rls.ve_tudo())
  OR ((SELECT rls.escrita()) = 'atividades' AND (SELECT rls.tem_contexto()))
  OR "id" = ANY ((SELECT rls.escritos())::uuid[])
  OR "responsavel_id" = (SELECT rls.usuario_id())
  OR "criado_por_id" = (SELECT rls.usuario_id())
  OR "responsavel_id" = ANY ((SELECT rls.liderados())::uuid[])
);
CREATE POLICY "atividades_inserir" ON "atividades" FOR INSERT WITH CHECK ((SELECT rls.tem_contexto()));
CREATE POLICY "atividades_alterar" ON "atividades" FOR UPDATE USING (
  (SELECT rls.ve_tudo())
  OR "responsavel_id" = (SELECT rls.usuario_id())
  OR "criado_por_id" = (SELECT rls.usuario_id())
  OR "responsavel_id" = ANY ((SELECT rls.liderados())::uuid[])
  OR "id" = ANY ((SELECT rls.escritos())::uuid[])
) WITH CHECK ((SELECT rls.tem_contexto()));
CREATE POLICY "atividades_excluir" ON "atividades" FOR DELETE USING (
  (SELECT rls.ve_tudo())
  OR "responsavel_id" = (SELECT rls.usuario_id())
  OR "criado_por_id" = (SELECT rls.usuario_id())
  OR "responsavel_id" = ANY ((SELECT rls.liderados())::uuid[])
);

-- ---------------------------------------------------------------------------
-- Conversas (R12.5): Admin e C-level todas; quem usa o Atendimento, as que estão com ele; o líder, as
-- das filas do setor; o membro, as sem responsável das filas do setor. Gravável: qualquer contexto
-- (transferir para outra pessoa ou fila é permitido pela regra, R12.7).
-- ---------------------------------------------------------------------------

ALTER TABLE "conversas" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "conversas" FORCE ROW LEVEL SECURITY;
CREATE POLICY "conversas_ler" ON "conversas" FOR SELECT USING (
  (SELECT rls.ve_tudo())
  OR ((SELECT rls.escrita()) = 'conversas' AND (SELECT rls.tem_contexto()))
  OR "id" = ANY ((SELECT rls.escritos())::uuid[])
  OR ("responsavel_id" = (SELECT rls.usuario_id()) AND (SELECT rls.usa_atendimento()))
  OR "fila_id" = ANY ((SELECT rls.filas_do_lider())::uuid[])
  OR ("responsavel_id" IS NULL AND "fila_id" = ANY ((SELECT rls.filas_do_membro())::uuid[]))
);
CREATE POLICY "conversas_inserir" ON "conversas" FOR INSERT WITH CHECK ((SELECT rls.tem_contexto()));
CREATE POLICY "conversas_alterar" ON "conversas" FOR UPDATE USING (
  (SELECT rls.ve_tudo())
  OR ("responsavel_id" = (SELECT rls.usuario_id()) AND (SELECT rls.usa_atendimento()))
  OR "fila_id" = ANY ((SELECT rls.filas_do_lider())::uuid[])
  OR ("responsavel_id" IS NULL AND "fila_id" = ANY ((SELECT rls.filas_do_membro())::uuid[]))
  OR "id" = ANY ((SELECT rls.escritos())::uuid[])
) WITH CHECK ((SELECT rls.tem_contexto()));
CREATE POLICY "conversas_excluir" ON "conversas" FOR DELETE USING (
  (SELECT rls.ve_tudo())
  OR ("responsavel_id" = (SELECT rls.usuario_id()) AND (SELECT rls.usa_atendimento()))
  OR "fila_id" = ANY ((SELECT rls.filas_do_lider())::uuid[])
  OR ("responsavel_id" IS NULL AND "fila_id" = ANY ((SELECT rls.filas_do_membro())::uuid[]))
);

-- ---------------------------------------------------------------------------
-- Mensagens: as das conversas que a pessoa vê (a subconsulta passa pela RLS das conversas).
-- ---------------------------------------------------------------------------

ALTER TABLE "mensagens" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mensagens" FORCE ROW LEVEL SECURITY;
CREATE POLICY "mensagens_ler" ON "mensagens" FOR SELECT USING (
  (SELECT rls.ve_tudo())
  OR ((SELECT rls.escrita()) = 'mensagens' AND (SELECT rls.tem_contexto()))
  OR "id" = ANY ((SELECT rls.escritos())::uuid[])
  OR EXISTS (SELECT 1 FROM "conversas" c WHERE c."id" = "mensagens"."conversa_id")
);
CREATE POLICY "mensagens_inserir" ON "mensagens" FOR INSERT WITH CHECK ((SELECT rls.tem_contexto()));
CREATE POLICY "mensagens_alterar" ON "mensagens" FOR UPDATE USING (
  (SELECT rls.ve_tudo())
  OR EXISTS (SELECT 1 FROM "conversas" c WHERE c."id" = "mensagens"."conversa_id")
  OR "id" = ANY ((SELECT rls.escritos())::uuid[])
) WITH CHECK ((SELECT rls.tem_contexto()));
CREATE POLICY "mensagens_excluir" ON "mensagens" FOR DELETE USING (
  (SELECT rls.ve_tudo())
  OR EXISTS (SELECT 1 FROM "conversas" c WHERE c."id" = "mensagens"."conversa_id")
);

-- ---------------------------------------------------------------------------
-- Ligações (R29.8, R30.9): quem atendeu, quem foi chamado, quem vê a conversa e quem tem o contato no
-- alcance (o responsável e o líder dele); Admin e C-level todas.
-- ---------------------------------------------------------------------------

ALTER TABLE "ligacoes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ligacoes" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ligacoes_ler" ON "ligacoes" FOR SELECT USING (
  (SELECT rls.ve_tudo())
  OR ((SELECT rls.escrita()) = 'ligacoes' AND (SELECT rls.tem_contexto()))
  OR "id" = ANY ((SELECT rls.escritos())::uuid[])
  OR "atendente_id" = (SELECT rls.usuario_id())
  OR (SELECT rls.usuario_id())::text = ANY ("tocou_para")
  OR ("conversa_id" IS NOT NULL AND EXISTS (SELECT 1 FROM "conversas" c WHERE c."id" = "ligacoes"."conversa_id"))
  OR EXISTS (SELECT 1 FROM "contatos" ct
              WHERE ct."id" = "ligacoes"."contato_id"
                AND (ct."responsavel_id" = (SELECT rls.usuario_id())
                     OR ct."responsavel_id" = ANY ((SELECT rls.liderados())::uuid[])))
);
CREATE POLICY "ligacoes_inserir" ON "ligacoes" FOR INSERT WITH CHECK ((SELECT rls.tem_contexto()));
CREATE POLICY "ligacoes_alterar" ON "ligacoes" FOR UPDATE USING (
  (SELECT rls.ve_tudo())
  OR "atendente_id" = (SELECT rls.usuario_id())
  OR (SELECT rls.usuario_id())::text = ANY ("tocou_para")
  OR ("conversa_id" IS NOT NULL AND EXISTS (SELECT 1 FROM "conversas" c WHERE c."id" = "ligacoes"."conversa_id"))
  OR EXISTS (SELECT 1 FROM "contatos" ct
              WHERE ct."id" = "ligacoes"."contato_id"
                AND (ct."responsavel_id" = (SELECT rls.usuario_id())
                     OR ct."responsavel_id" = ANY ((SELECT rls.liderados())::uuid[])))
  OR "id" = ANY ((SELECT rls.escritos())::uuid[])
) WITH CHECK ((SELECT rls.tem_contexto()));
CREATE POLICY "ligacoes_excluir" ON "ligacoes" FOR DELETE USING (
  (SELECT rls.ve_tudo())
  OR "atendente_id" = (SELECT rls.usuario_id())
  OR (SELECT rls.usuario_id())::text = ANY ("tocou_para")
  OR ("conversa_id" IS NOT NULL AND EXISTS (SELECT 1 FROM "conversas" c WHERE c."id" = "ligacoes"."conversa_id"))
  OR EXISTS (SELECT 1 FROM "contatos" ct
              WHERE ct."id" = "ligacoes"."contato_id"
                AND (ct."responsavel_id" = (SELECT rls.usuario_id())
                     OR ct."responsavel_id" = ANY ((SELECT rls.liderados())::uuid[])))
);

-- ---------------------------------------------------------------------------
-- Arquivos (R11.4, por contexto): quem enviou sempre; foto de perfil, mídia de campanha e relatórios,
-- qualquer usuário; mídia de mensagem, quem vê a conversa (ou o anexo de resposta rápida, quem usa o
-- Atendimento); gravação de ligação, quem vê a ligação (o áudio de aviso do canal, quem usa o Atendimento);
-- anexo do chat interno, só os membros do canal
-- (nem o Admin, R15.3); planilha de importação, Admin, C-level e quem importou; OUTRO, só o Admin.
-- ---------------------------------------------------------------------------

-- Os valores do contexto chegam prontos (calculados uma vez por consulta, nas políticas): por linha, só as
-- conferências do contexto do arquivo, por índice.
CREATE FUNCTION rls.arquivo_visivel(
  p_id uuid, p_contexto public.contexto_arquivo, p_criado_por uuid,
  p_usuario uuid, p_ve_tudo boolean, p_tem_contexto boolean, p_admin boolean, p_atendimento boolean
) RETURNS boolean
LANGUAGE plpgsql STABLE PARALLEL SAFE SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
BEGIN
  RETURN (
  SELECT (p_criado_por IS NOT NULL AND p_criado_por = p_usuario)
      OR CASE p_contexto
           WHEN 'AVATAR' THEN p_tem_contexto
           WHEN 'CAMPANHA' THEN p_tem_contexto
           WHEN 'RELATORIO' THEN p_tem_contexto
           WHEN 'OUTRO' THEN p_admin
           WHEN 'IMPORTACAO' THEN p_ve_tudo
             OR EXISTS (SELECT 1 FROM public.importacoes i
                         WHERE i.arquivo_id = p_id AND i.criado_por_id = p_usuario)
           WHEN 'MENSAGEM' THEN p_ve_tudo
             OR EXISTS (SELECT 1 FROM public.mensagens m WHERE m.arquivo_id = p_id)
             OR (p_atendimento
                 AND EXISTS (SELECT 1 FROM public.respostas_rapidas r
                              WHERE r.arquivo_id = p_id AND r.excluido_em IS NULL))
           WHEN 'LIGACAO' THEN p_ve_tudo
             OR EXISTS (SELECT 1 FROM public.ligacoes l WHERE l.gravacao_arquivo_id = p_id)
             OR EXISTS (SELECT 1 FROM public.ligacoes l WHERE l.gravacao_original_arquivo_id = p_id)
             -- O áudio de aviso do canal: quem usa o Atendimento o toca ao atender (R30.14).
             OR (p_atendimento
                 AND EXISTS (SELECT 1 FROM public.canais_ligacoes cl WHERE cl.aviso_arquivo_id = p_id))
           WHEN 'CHAT' THEN EXISTS (
             SELECT 1 FROM public.chat_mensagens cm
               JOIN public.chat_membros mb ON mb.canal_id = cm.canal_id AND mb.usuario_id = p_usuario
              WHERE cm.arquivo_id = p_id AND cm.excluida_em IS NULL)
           ELSE false
         END
  );
END
$$;

ALTER TABLE "arquivos" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "arquivos" FORCE ROW LEVEL SECURITY;
CREATE POLICY "arquivos_ler" ON "arquivos" FOR SELECT USING (
  (SELECT rls.sistema())
  OR ((SELECT rls.escrita()) = 'arquivos' AND (SELECT rls.tem_contexto()))
  OR "id" = ANY ((SELECT rls.escritos())::uuid[])
  OR rls.arquivo_visivel("id", "contexto", "criado_por_id",
       (SELECT rls.usuario_id()), (SELECT rls.ve_tudo()), (SELECT rls.tem_contexto()),
       (SELECT rls.eh_admin()), (SELECT rls.usa_atendimento()))
);
CREATE POLICY "arquivos_inserir" ON "arquivos" FOR INSERT WITH CHECK ((SELECT rls.tem_contexto()));
CREATE POLICY "arquivos_alterar" ON "arquivos" FOR UPDATE USING (
  (SELECT rls.sistema())
  OR rls.arquivo_visivel("id", "contexto", "criado_por_id",
       (SELECT rls.usuario_id()), (SELECT rls.ve_tudo()), (SELECT rls.tem_contexto()),
       (SELECT rls.eh_admin()), (SELECT rls.usa_atendimento()))
  OR "id" = ANY ((SELECT rls.escritos())::uuid[])
) WITH CHECK ((SELECT rls.tem_contexto()));
CREATE POLICY "arquivos_excluir" ON "arquivos" FOR DELETE USING (
  (SELECT rls.sistema())
  OR rls.arquivo_visivel("id", "contexto", "criado_por_id",
       (SELECT rls.usuario_id()), (SELECT rls.ve_tudo()), (SELECT rls.tem_contexto()),
       (SELECT rls.eh_admin()), (SELECT rls.usa_atendimento()))
);

-- ---------------------------------------------------------------------------
-- O dono (quem roda as migrations) entra como sistema por padrão: se ele não for superusuário, o
-- FORCE ROW LEVEL SECURITY também vale para ele, e uma migration de dados não pode enxergar zero linhas.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  EXECUTE format('ALTER ROLE %I SET crm.ator = %L', current_user, 'sistema');
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'Sem permissão para definir crm.ator do papel %: defina-o à mão se ele não for superusuário.', current_user;
END
$$;
