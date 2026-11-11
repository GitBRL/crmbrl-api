/**
 * Quem vê o quê nos painéis (R1, R20): os mesmos recortes das listas, em SQL.
 * Cada função espelha uma função de visibilidade existente (citada ao lado) e
 * os testes conferem que o número do BI bate com o da lista.
 */
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import {
  type ComPapel,
  ehDiretoria,
  ehLider,
  setorDaPessoa,
} from '../comum/dominio/papeis';
import { permissoesDoPapel } from '../comum/dominio/permissoes';
import {
  type Area,
  SETOR_COMERCIAL,
  SETOR_CS,
  SETOR_MARKETING,
} from '../comum/dominio/setores';
import { Prisma } from '../generated/prisma/client';
import type { PainelBi } from './bi.tipos';

type Quem = Pick<UsuarioAutenticado, 'id' | 'papel' | 'area'>;

const VERDADEIRO = Prisma.sql`TRUE`;
const FALSO = Prisma.sql`FALSE`;

/**
 * Setor "dono" de cada painel (o Atendimento atende todos menos o Marketing).
 * Os painéis de Marketing, Comercial, CS e Financeiro continuam presos aos
 * setores de base: um setor criado vê só o Atendimento e o SDR (pelo seu setor).
 */
const AREA_DO_PAINEL: Record<PainelBi, Area | null> = {
  marketing: SETOR_MARKETING,
  comercial: SETOR_COMERCIAL,
  cs: SETOR_CS,
  atendimento: null,
  sdr: null,
  financeiro: SETOR_CS,
};

/** A pessoa enxerga o painel? Admin e C-level todos; as pessoas de setor, o do seu (Atendimento e SDR, que olham conversas: não o Marketing). */
export function podeVerPainel(pessoa: ComPapel, painel: PainelBi): boolean {
  if (ehDiretoria(pessoa.papel)) {
    return true;
  }
  const area = setorDaPessoa(pessoa);
  if (!area) {
    return false;
  }
  if (painel === 'atendimento' || painel === 'sdr') {
    return area !== SETOR_MARKETING;
  }
  return AREA_DO_PAINEL[painel] === area;
}

/** Painéis que a pessoa vê, na ordem das abas. */
export function paineisDoPapel(pessoa: ComPapel): PainelBi[] {
  return (
    [
      'marketing',
      'comercial',
      'cs',
      'atendimento',
      'sdr',
      'financeiro',
    ] as const
  ).filter((painel) => podeVerPainel(pessoa, painel));
}

export function areaDoPainel(painel: PainelBi): Area | null {
  return AREA_DO_PAINEL[painel];
}

/**
 * Negócios que o BI conta para a pessoa (R5.9, R20). O BI continua **pelo
 * setor da pessoa**: Admin e C-level, todos; o líder, os dos funis do seu
 * setor (inclusive os `RESTRITA`); o membro, os seus e os sem responsável dos
 * funis `SETOR` do seu setor. Acessos extras (R5.11) **não** ampliam o BI (nem
 * o acesso a um funil restrito do próprio setor). `n` = negocios, `f` = funis.
 */
export function sqlNegociosVisiveis(
  usuario: Quem,
  n = Prisma.raw('n'),
  f = Prisma.raw('f'),
): Prisma.Sql {
  const escopo = permissoesDoPapel(usuario.papel).verNegocios;
  const area = setorDaPessoa(usuario);
  if (escopo === 'TODOS') {
    return VERDADEIRO;
  }
  if (!area || escopo === 'NENHUM') {
    return FALSO;
  }
  if (escopo === 'AREA') {
    return Prisma.sql`${f}.area = ${area}`;
  }
  return Prisma.sql`(${f}.area = ${area} AND ${f}.visibilidade = 'SETOR'::visibilidade_funil
    AND (${n}.responsavel_id = ${usuario.id}::uuid OR ${n}.responsavel_id IS NULL))`;
}

/** Conversas que o usuário vê (`filtroDeConversasVisiveis`, R12). `c` = conversas, `f` = filas. */
export function sqlConversasVisiveis(
  usuario: Quem,
  c = Prisma.raw('c'),
  f = Prisma.raw('f'),
): Prisma.Sql {
  if (ehDiretoria(usuario.papel)) {
    return VERDADEIRO;
  }
  const area = setorDaPessoa(usuario);
  if (!area || area === SETOR_MARKETING) {
    return FALSO;
  }
  return ehLider(usuario.papel)
    ? Prisma.sql`(${c}.responsavel_id = ${usuario.id}::uuid OR ${f}.area = ${area})`
    : Prisma.sql`(${c}.responsavel_id = ${usuario.id}::uuid OR (${c}.responsavel_id IS NULL AND ${f}.area = ${area}))`;
}

/**
 * Ligações que o usuário vê (`filtroDeLigacoesVisiveis`, R12/R29.8/R30.9): atendente, quem foi
 * chamado, quem vê a conversa ou quem tem o contato no alcance (responsável e líder dele). `l` = ligacoes, `c` = conversas, `f` = filas (ambas com LEFT JOIN).
 */
export function sqlLigacoesVisiveis(
  usuario: Quem,
  l = Prisma.raw('l'),
  c = Prisma.raw('c'),
  f = Prisma.raw('f'),
): Prisma.Sql {
  if (ehDiretoria(usuario.papel)) {
    return VERDADEIRO;
  }
  const area = setorDaPessoa(usuario);
  if (!area || area === SETOR_MARKETING) {
    return FALSO;
  }
  const liderDoResponsavel =
    permissoesDoPapel(usuario.papel).editarContatos === 'EQUIPE'
      ? Prisma.sql` OR ct_a.responsavel_id IN (SELECT u_a.id FROM usuarios u_a WHERE u_a.lider_id = ${usuario.id}::uuid)`
      : Prisma.empty;
  return Prisma.sql`(${l}.atendente_id = ${usuario.id}::uuid
    OR ${usuario.id}::text = ANY(${l}.tocou_para)
    OR (${c}.id IS NOT NULL AND ${sqlConversasVisiveis(usuario, c, f)})
    OR EXISTS (SELECT 1 FROM contatos ct_a
                WHERE ct_a.id = ${l}.contato_id
                  AND (ct_a.responsavel_id = ${usuario.id}::uuid${liderDoResponsavel})))`;
}

/** Campanhas que o usuário vê (`filtroDeCampanhasVisiveis`, R17). `k` = campanhas. */
export function sqlCampanhasVisiveis(
  usuario: Quem,
  k = Prisma.raw('k'),
): Prisma.Sql {
  if (ehDiretoria(usuario.papel)) {
    return VERDADEIRO;
  }
  const area = setorDaPessoa(usuario);
  if (ehLider(usuario.papel) && area) {
    return Prisma.sql`(${k}.area = ${area} OR ${k}.criado_por_id = ${usuario.id}::uuid)`;
  }
  return Prisma.sql`${k}.criado_por_id = ${usuario.id}::uuid`;
}

/** Atividades que o usuário vê (`filtroDeVisibilidade`, R6.4). `a` = atividades, `r` = responsável. */
export function sqlAtividadesVisiveis(
  usuario: Quem,
  a = Prisma.raw('a'),
  r = Prisma.raw('r'),
): Prisma.Sql {
  if (ehDiretoria(usuario.papel)) {
    return VERDADEIRO;
  }
  const lider = ehLider(usuario.papel)
    ? Prisma.sql` OR ${r}.lider_id = ${usuario.id}::uuid`
    : Prisma.empty;
  return Prisma.sql`(${a}.responsavel_id = ${usuario.id}::uuid OR ${a}.criado_por_id = ${usuario.id}::uuid${lider})`;
}

/** `coluna = ANY(ids)` quando há filtro de pessoa; senão, verdadeiro. */
export function sqlPessoas(
  coluna: Prisma.Sql,
  pessoas: readonly string[] | null,
): Prisma.Sql {
  return pessoas === null
    ? VERDADEIRO
    : Prisma.sql`${coluna} = ANY(${[...pessoas]}::uuid[])`;
}

export { VERDADEIRO, FALSO };
