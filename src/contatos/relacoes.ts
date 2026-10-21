import type { Prisma } from '../generated/prisma/client';

/** Campos do usuário que acompanham contatos e empresas (responsável, quem criou). */
export const SELECIONAR_USUARIO_VINCULADO = {
  id: true,
  nome: true,
  papel: true,
  ativo: true,
} as const satisfies Prisma.UsuarioSelect;

/** Relações carregadas com o contato para montar o `ContatoDto`. */
export const INCLUIR_NO_CONTATO = {
  empresa: { select: { id: true, nome: true } },
  responsavel: { select: SELECIONAR_USUARIO_VINCULADO },
  criadoPor: { select: SELECIONAR_USUARIO_VINCULADO },
} as const satisfies Prisma.ContatoInclude;

export type ContatoComRelacoes = Prisma.ContatoGetPayload<{
  include: typeof INCLUIR_NO_CONTATO;
}>;

/** Relações carregadas com a empresa para montar o `EmpresaDto` (com a contagem de contatos ativos). */
export const INCLUIR_NA_EMPRESA = {
  responsavel: { select: SELECIONAR_USUARIO_VINCULADO },
  criadoPor: { select: SELECIONAR_USUARIO_VINCULADO },
  _count: { select: { contatos: { where: { excluidoEm: null } } } },
} as const satisfies Prisma.EmpresaInclude;

export type EmpresaComRelacoes = Prisma.EmpresaGetPayload<{
  include: typeof INCLUIR_NA_EMPRESA;
}>;
