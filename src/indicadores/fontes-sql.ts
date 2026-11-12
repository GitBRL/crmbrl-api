/**
 * Fontes de linhas dos indicadores (R33.4): o FROM de cada uma, com os recortes de
 * visibilidade **iguais aos do BI** (`bi/escopo-bi.ts`, R20.2) e os filtros do painel
 * (R33.3) como condições SQL. Aliases fixos: negócios `n`, funis `f`, etapas `e`,
 * responsável `r`; atividades `a`; ligações `l` (+ conversas `c` e filas `fl`).
 */
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import {
  FALSO,
  sqlAtividadesVisiveis,
  sqlLigacoesVisiveis,
  sqlNegociosVisiveis,
  sqlPessoas,
  VERDADEIRO,
} from '../bi/escopo-bi';
import { Prisma } from '../generated/prisma/client';
import type { Fonte } from './catalogo';
import type { FiltroResolvido } from './indicadores.tipos';

export interface FonteSql {
  /** `FROM … JOIN …` (sem o `FROM`). */
  from: Prisma.Sql;
  /** Condições (todas em `AND`): linhas existentes, visibilidade e filtros. */
  onde: Prisma.Sql;
  /** Coluna da pessoa para o ranking (id) e o nome dela (`r.nome`). */
  pessoa: Prisma.Sql;
}

const lista = (valores: readonly string[]) => [...valores];

/** Filtros que se aplicam a um negócio `n` do funil `f` (sem pessoa nem setor). */
function condicoesDoNegocio(
  filtro: FiltroResolvido,
  n: Prisma.Sql,
  comEtiquetas: boolean,
): Prisma.Sql[] {
  const c: Prisma.Sql[] = [];
  if (filtro.funilIds) {
    c.push(Prisma.sql`${n}.funil_id = ANY(${lista(filtro.funilIds)}::uuid[])`);
  }
  if (filtro.etapaIds) {
    c.push(Prisma.sql`${n}.etapa_id = ANY(${lista(filtro.etapaIds)}::uuid[])`);
  }
  if (filtro.origens) {
    c.push(
      Prisma.sql`${n}.origem = ANY(${lista(filtro.origens)}::origem_contato[])`,
    );
  }
  if (filtro.utmSource) {
    c.push(
      Prisma.sql`lower(${n}.utm->>'source') = ANY(${lista(filtro.utmSource)}::text[])`,
    );
  }
  if (filtro.utmCampaign) {
    c.push(
      Prisma.sql`lower(${n}.utm->>'campaign') = ANY(${lista(filtro.utmCampaign)}::text[])`,
    );
  }
  if (comEtiquetas && filtro.etiquetas) {
    c.push(Prisma.sql`EXISTS (SELECT 1 FROM contatos ct_e
      WHERE ct_e.id = ${n}.contato_id AND ct_e.etiquetas && ${lista(filtro.etiquetas)}::text[])`);
  }
  return c;
}

function junta(condicoes: readonly Prisma.Sql[]): Prisma.Sql {
  return condicoes.length === 0
    ? VERDADEIRO
    : Prisma.join(
        condicoes.map((c) => Prisma.sql`(${c})`),
        ' AND ',
      );
}

/** Há filtro que só um negócio resolve (funil, etapa, origem, UTM)? */
function temFiltroDeNegocio(filtro: FiltroResolvido): boolean {
  return !!(
    filtro.funilIds ||
    filtro.etapaIds ||
    filtro.origens ||
    filtro.utmSource ||
    filtro.utmCampaign
  );
}

export function fonteDeNegocios(
  usuario: UsuarioAutenticado,
  filtro: FiltroResolvido,
): FonteSql {
  const n = Prisma.raw('n');
  const condicoes: Prisma.Sql[] = [
    Prisma.sql`n.excluido_em IS NULL AND f.excluido_em IS NULL`,
    sqlNegociosVisiveis(usuario),
    sqlPessoas(Prisma.sql`n.responsavel_id`, filtro.pessoas),
    ...condicoesDoNegocio(filtro, n, true),
  ];
  if (filtro.setor) {
    condicoes.push(Prisma.sql`f.area = ${filtro.setor}`);
  }
  return {
    from: Prisma.sql`negocios n
      JOIN funis f ON f.id = n.funil_id
      JOIN etapas e ON e.id = n.etapa_id
      LEFT JOIN usuarios r ON r.id = n.responsavel_id`,
    onde: junta(condicoes),
    pessoa: Prisma.sql`n.responsavel_id`,
  };
}

/** Condições "existe um negócio do `ref` com estes filtros" para atividades e ligações. */
function existeNegocio(
  filtro: FiltroResolvido,
  ligacao: Prisma.Sql,
): Prisma.Sql | null {
  if (!temFiltroDeNegocio(filtro)) {
    return null;
  }
  const nf = Prisma.raw('nf');
  const condicoes = condicoesDoNegocio(filtro, nf, false);
  return Prisma.sql`EXISTS (SELECT 1 FROM negocios nf JOIN funis ff ON ff.id = nf.funil_id
    WHERE nf.excluido_em IS NULL AND ff.excluido_em IS NULL AND ${ligacao} AND ${junta(condicoes)})`;
}

export function fonteDeAtividades(
  usuario: UsuarioAutenticado,
  filtro: FiltroResolvido,
): FonteSql {
  const condicoes: Prisma.Sql[] = [
    sqlAtividadesVisiveis(usuario),
    sqlPessoas(Prisma.sql`a.responsavel_id`, filtro.pessoas),
  ];
  if (filtro.setor) {
    condicoes.push(Prisma.sql`r.area = ${filtro.setor}`);
  }
  const negocio = existeNegocio(filtro, Prisma.sql`nf.id = a.negocio_id`);
  if (negocio) {
    condicoes.push(negocio);
  }
  if (filtro.etiquetas) {
    condicoes.push(Prisma.sql`EXISTS (SELECT 1 FROM contatos ct_e
      WHERE ct_e.etiquetas && ${lista(filtro.etiquetas)}::text[]
        AND ct_e.id = coalesce(a.contato_id, (SELECT x.contato_id FROM negocios x WHERE x.id = a.negocio_id)))`);
  }
  return {
    from: Prisma.sql`atividades a JOIN usuarios r ON r.id = a.responsavel_id`,
    onde: junta(condicoes),
    pessoa: Prisma.sql`a.responsavel_id`,
  };
}

export function fonteDeLigacoes(
  usuario: UsuarioAutenticado,
  filtro: FiltroResolvido,
): FonteSql {
  const condicoes: Prisma.Sql[] = [
    sqlLigacoesVisiveis(
      usuario,
      Prisma.raw('l'),
      Prisma.raw('c'),
      Prisma.raw('fl'),
    ),
    sqlPessoas(Prisma.sql`l.atendente_id`, filtro.pessoas),
  ];
  if (filtro.setor) {
    condicoes.push(Prisma.sql`r.area = ${filtro.setor}`);
  }
  const negocio = existeNegocio(
    filtro,
    Prisma.sql`nf.contato_id = l.contato_id`,
  );
  if (negocio) {
    condicoes.push(negocio);
  }
  if (filtro.etiquetas) {
    condicoes.push(Prisma.sql`EXISTS (SELECT 1 FROM contatos ct_e
      WHERE ct_e.id = l.contato_id AND ct_e.etiquetas && ${lista(filtro.etiquetas)}::text[])`);
  }
  return {
    from: Prisma.sql`ligacoes l
      LEFT JOIN conversas c ON c.id = l.conversa_id
      LEFT JOIN filas_atendimento fl ON fl.id = c.fila_id
      LEFT JOIN usuarios r ON r.id = l.atendente_id`,
    onde: junta(condicoes),
    pessoa: Prisma.sql`l.atendente_id`,
  };
}

export function fonteDe(
  fonte: Fonte,
  usuario: UsuarioAutenticado,
  filtro: FiltroResolvido,
): FonteSql {
  switch (fonte) {
    case 'NEGOCIO':
      return fonteDeNegocios(usuario, filtro);
    case 'ATIVIDADE':
      return fonteDeAtividades(usuario, filtro);
    case 'LIGACAO':
      return fonteDeLigacoes(usuario, filtro);
  }
}

/** Para a conversão entre etapas: os negócios `n` (com `f`) visíveis e filtrados. */
export function condicoesDeNegociosParaMovimentacao(
  usuario: UsuarioAutenticado,
  filtro: FiltroResolvido,
): Prisma.Sql {
  return fonteDeNegocios(usuario, filtro).onde;
}

export { FALSO, VERDADEIRO };
