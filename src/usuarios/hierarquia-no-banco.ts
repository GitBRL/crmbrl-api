/**
 * Checagens de hierarquia que leem o banco, usadas dentro das transações dos
 * serviços de usuários (criar, editar, desligar, reativar).
 */
import { type ComPapel, papelTemSetor } from '../comum/dominio/papeis';
import type { Area } from '../comum/dominio/setores';
import { normalizarTelefoneOpcional } from '../comum/dominio/telefone';
import {
  ConflitoException,
  DadosInvalidosException,
  RegraVioladaException,
} from '../comum/erros/excecoes';
import type { Papel } from '../generated/prisma/client';
import type { Tx } from '../prisma/prisma.service';
import { travarChave } from '../prisma/travas';
import { garantirSetorAtivo } from '../setores/setores-no-banco';
import {
  type Liderado,
  type ProblemaDeRegra,
  problemaDeLideranca,
} from './dominio/hierarquia';

/**
 * Serializa as mudanças de hierarquia (criar, mudar papel ou líder, desligar,
 * reativar): a decisão de cada uma depende do estado das outras — o último
 * Admin (R1.4), a cadeia de liderança do desligamento (R7.2).
 */
export function travarHierarquia(tx: Tx): Promise<void> {
  return travarChave(tx, 'usuarios', 'hierarquia');
}

/** `422 regra_violada` a partir de um problema das regras puras. */
export function excecaoDaRegra(
  problema: ProblemaDeRegra,
): RegraVioladaException {
  return new RegraVioladaException(
    problema.regra,
    problema.mensagem,
    problema.detalhes,
  );
}

/**
 * Setor a gravar para quem tem `papel` (R1.2, R1.9): Líder e Membro precisam de
 * um setor (ativo, quando `conferirAtivo`); Admin e C-level não têm setor (o
 * pedido é ignorado e a área fica nula).
 */
export async function exigirSetorDoPapel(
  tx: Tx,
  papel: Papel,
  area: Area | null | undefined,
  conferirAtivo = true,
): Promise<Area | null> {
  if (!papelTemSetor(papel)) {
    return null;
  }
  if (!area) {
    throw new DadosInvalidosException(
      'Dados inválidos — area: é obrigatória para Líder e Membro.',
      {
        campos: [
          { campo: 'area', mensagens: ['é obrigatória para Líder e Membro'] },
        ],
      },
    );
  }
  if (conferirAtivo) {
    await garantirSetorAtivo(tx, area);
  }
  return area;
}

/**
 * Confere o líder pedido para quem tem o papel e o setor de `pessoa` (R1.2) e
 * devolve o id a gravar (`null` para Admin e C-level).
 */
export async function exigirLiderValido(
  tx: Tx,
  pessoa: ComPapel,
  liderId: string | null,
  usuarioId?: string,
): Promise<string | null> {
  const lider = liderId
    ? await tx.usuario.findUnique({
        where: { id: liderId },
        select: { id: true, nome: true, papel: true, area: true, ativo: true },
      })
    : null;
  if (liderId && !lider) {
    throw new RegraVioladaException('R1.2', 'O líder informado não existe.', {
      liderId,
    });
  }
  const problema = problemaDeLideranca(pessoa, lider, usuarioId);
  if (problema) {
    throw excecaoDaRegra(problema);
  }
  return lider?.id ?? null;
}

/**
 * R1.4: sempre existe pelo menos um Admin ativo — o último não é desligado nem
 * rebaixado.
 */
export async function exigirOutroAdminAtivo(
  tx: Tx,
  usuario: { readonly id: string; readonly nome: string },
  acao: 'desligar' | 'rebaixar',
): Promise<void> {
  const outros = await tx.usuario.count({
    where: { papel: 'ADMIN', ativo: true, id: { not: usuario.id } },
  });
  if (outros === 0) {
    throw new RegraVioladaException(
      'R1.4',
      `O último Admin ativo (${usuario.nome}) não pode ser ${acao === 'desligar' ? 'desligado' : 'rebaixado'}: ` +
        'promova outra pessoa a Admin antes.',
    );
  }
}

/** Liderados ativos de um usuário (R1.3, R7.3). */
export function lideradosAtivos(tx: Tx, liderId: string): Promise<Liderado[]> {
  return tx.usuario.findMany({
    where: { liderId, ativo: true },
    select: { id: true, nome: true, papel: true, area: true },
    orderBy: [{ nome: 'asc' }, { id: 'asc' }],
  });
}

/**
 * R1.1: e-mail único (já normalizado). O de um desligado também conta: a
 * resposta sugere reativar em vez de criar outro.
 */
export async function exigirEmailLivre(
  tx: Tx,
  email: string,
  exceto?: string,
): Promise<void> {
  const existente = await tx.usuario.findUnique({
    where: { email },
    select: { id: true, ativo: true },
  });
  if (!existente || existente.id === exceto) {
    return;
  }
  throw new ConflitoException(
    existente.ativo
      ? 'Já existe um usuário com este e-mail.'
      : 'Já existe um usuário desligado com este e-mail: reative-o em vez de criar outro.',
    { regra: 'R1.1', campos: ['email'], usuarioId: existente.id },
  );
}

/**
 * R32.4: o identificador nas integrações é único, sem diferenciar maiúsculas
 * (o de um desligado também conta). Vazio vira `null`.
 */
export async function lerIdentificadorDeIntegracao(
  tx: Tx,
  valor: string | null | undefined,
  exceto?: string,
): Promise<string | null | undefined> {
  if (valor === undefined) {
    return undefined;
  }
  const texto = valor?.trim() ?? '';
  if (!texto) {
    return null;
  }
  const existente = await tx.usuario.findFirst({
    where: {
      identificadorIntegracao: { equals: texto, mode: 'insensitive' },
      ...(exceto ? { NOT: { id: exceto } } : {}),
    },
    select: { id: true },
  });
  if (existente) {
    throw new ConflitoException(
      'Já existe um usuário com este identificador nas integrações.',
      {
        regra: 'R32.4',
        campos: ['identificadorIntegracao'],
        usuarioId: existente.id,
      },
    );
  }
  return texto;
}

/** Telefone do usuário em E.164 só com dígitos; vazio → `null`; inválido → 400. */
export function lerTelefone(telefone: string | null): string | null {
  try {
    return normalizarTelefoneOpcional(telefone);
  } catch (erro) {
    const motivo = erro instanceof Error ? erro.message : 'Telefone inválido.';
    throw new DadosInvalidosException(`Dados inválidos — telefone: ${motivo}`, {
      campos: [{ campo: 'telefone', mensagens: [motivo] }],
    });
  }
}
