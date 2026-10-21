import { randomUUID } from 'node:crypto';
import { CriptografiaService } from '../../src/comum/criptografia/criptografia.service';
import { normalizarEmail } from '../../src/comum/dominio/email';
import { liderDaArea, membroDaArea } from '../../src/comum/dominio/papeis';
import { normalizarTelefone } from '../../src/comum/dominio/telefone';
import {
  type Area,
  type Atividade,
  type Contato,
  type Empresa,
  type Etapa,
  type Funil,
  type Negocio,
  type OrigemContato,
  type Papel,
  Prisma,
  type PrioridadeAtividade,
  type StatusAtividade,
  type TipoAtividade,
  type Usuario,
} from '../../src/generated/prisma/client';
import type { AppTeste } from './app-teste';

/**
 * Fábricas de dados para os testes. Gravam direto no banco (sem auditoria, sem
 * eventos, sem validar hierarquia), já normalizadas como a API gravaria. Para
 * testar a regra, chame o endpoint; para montar o cenário, use a fábrica.
 */

/** Senha de todo usuário criado pelas fábricas (salvo `senha`). */
export const SENHA_DE_TESTE = 'Senha@Teste123';

let sequencia = 0;
function proximo(): string {
  sequencia += 1;
  return `${sequencia}-${randomUUID().slice(0, 8)}`;
}

/** O hash scrypt é lento (≈ 0,2 s): o da senha padrão é calculado uma vez por arquivo. */
let hashDaSenhaPadrao: Promise<string> | undefined;
function hashDe(t: AppTeste, senha: string): Promise<string> {
  const cripto = t.get(CriptografiaService);
  if (senha === SENHA_DE_TESTE) {
    hashDaSenhaPadrao ??= cripto.hashSenha(SENHA_DE_TESTE);
    return hashDaSenhaPadrao;
  }
  return cripto.hashSenha(senha);
}

function idDe(
  valor: { id: string } | string | null | undefined,
): string | null | undefined {
  return typeof valor === 'object' && valor !== null ? valor.id : valor;
}

export interface DadosDeUsuario {
  papel?: Papel;
  nome?: string;
  email?: string;
  /** `null` = usuário sem senha (convidado). Padrão: `SENHA_DE_TESTE`. */
  senha?: string | null;
  lider?: Usuario | string | null;
  ativo?: boolean;
  deveTrocarSenha?: boolean;
  telefone?: string | null;
}

/** Cria um usuário (padrão: Admin ativo com `SENHA_DE_TESTE`). Não valida a hierarquia. */
export async function criarUsuario(
  t: AppTeste,
  dados: DadosDeUsuario = {},
): Promise<Usuario> {
  const id = proximo();
  const papel = dados.papel ?? 'ADMIN';
  const senha = dados.senha === undefined ? SENHA_DE_TESTE : dados.senha;
  return t.prisma.usuario.create({
    data: {
      nome: dados.nome ?? `${papel} ${id}`,
      email: normalizarEmail(dados.email ?? `usuario-${id}@teste.local`),
      papel,
      liderId: idDe(dados.lider) ?? null,
      ativo: dados.ativo ?? true,
      desligadoEm: dados.ativo === false ? new Date() : null,
      senhaHash: senha === null ? null : await hashDe(t, senha),
      deveTrocarSenha: dados.deveTrocarSenha ?? false,
      telefone: dados.telefone ?? null,
    },
  });
}

export interface Equipe {
  cLevel: Usuario;
  lider: Usuario;
  membros: Usuario[];
}

/** Uma equipe com hierarquia válida (R1.2): C-level → líder da área → membros. */
export async function criarEquipe(
  t: AppTeste,
  area: Area = 'COMERCIAL',
  opcoes: { membros?: number; cLevel?: Usuario } = {},
): Promise<Equipe> {
  const cLevel = opcoes.cLevel ?? (await criarUsuario(t, { papel: 'C_LEVEL' }));
  const lider = await criarUsuario(t, {
    papel: liderDaArea(area),
    lider: cLevel,
  });
  const membros: Usuario[] = [];
  for (let indice = 0; indice < (opcoes.membros ?? 2); indice++) {
    membros.push(await criarUsuario(t, { papel: membroDaArea(area), lider }));
  }
  return { cLevel, lider, membros };
}

export interface DadosDeEmpresa {
  nome?: string;
  cnpj?: string | null;
  responsavel?: Usuario | string | null;
  etiquetas?: string[];
}

export function criarEmpresa(
  t: AppTeste,
  dados: DadosDeEmpresa = {},
): Promise<Empresa> {
  return t.prisma.empresa.create({
    data: {
      nome: dados.nome ?? `Empresa ${proximo()}`,
      cnpj: dados.cnpj ?? null,
      responsavelId: idDe(dados.responsavel) ?? null,
      etiquetas: dados.etiquetas ?? [],
    },
  });
}

export interface DadosDeContato {
  nome?: string;
  /** Padrão: um e-mail único. `null` = sem e-mail (aí informe o telefone). */
  email?: string | null;
  telefone?: string | null;
  responsavel?: Usuario | string | null;
  empresa?: Empresa | string | null;
  origem?: OrigemContato;
  etiquetas?: string[];
}

/** Cria um contato com e-mail único (salvo `email`); telefone normalizado para E.164. */
export function criarContato(
  t: AppTeste,
  dados: DadosDeContato = {},
): Promise<Contato> {
  const id = proximo();
  const email =
    dados.email === undefined ? `contato-${id}@teste.local` : dados.email;
  let telefone: string | null = null;
  if (dados.telefone) {
    const normalizado = normalizarTelefone(dados.telefone);
    if (!normalizado.valido) {
      throw new Error(`Telefone de teste inválido: ${normalizado.motivo}`);
    }
    telefone = normalizado.telefone;
  }
  const origem = dados.origem ?? 'MANUAL';
  return t.prisma.contato.create({
    data: {
      nome: dados.nome ?? `Contato ${id}`,
      email: email === null ? null : normalizarEmail(email),
      telefone,
      responsavelId: idDe(dados.responsavel) ?? null,
      empresaId: idDe(dados.empresa) ?? null,
      primeiraOrigem: origem,
      ultimaOrigem: origem,
      etiquetas: dados.etiquetas ?? [],
    },
  });
}

export type FunilComEtapas = Funil & { etapas: Etapa[] };

/** O funil-base da área, com as etapas em ordem. */
export async function funilBase(
  t: AppTeste,
  area: Area,
): Promise<FunilComEtapas> {
  return t.prisma.funil.findFirstOrThrow({
    where: { area, base: true },
    include: { etapas: { orderBy: { ordem: 'asc' } } },
  });
}

/** Uma etapa do funil-base pela `chave` (ex.: `('MARKETING', 'qualificado_mql')`). */
export async function etapaDoFunilBase(
  t: AppTeste,
  area: Area,
  chave: string,
): Promise<Etapa> {
  const funil = await funilBase(t, area);
  const etapa = funil.etapas.find((candidata) => candidata.chave === chave);
  if (!etapa) {
    throw new Error(`Etapa "${chave}" não existe no funil-base de ${area}.`);
  }
  return etapa;
}

export interface DadosDeNegocio {
  contato?: Contato | string;
  empresa?: Empresa | string | null;
  /** Área do funil-base (padrão `COMERCIAL`). */
  area?: Area;
  /** `chave` da etapa no funil-base (padrão: a primeira etapa aberta). */
  etapa?: string;
  responsavel?: Usuario | string | null;
  titulo?: string;
  /** Texto decimal, ex.: `'1500.00'`. */
  valor?: string;
  valorRecorrente?: string | null;
  origem?: OrigemContato;
  negocioOrigem?: Negocio | string | null;
}

/**
 * Cria um negócio num funil-base, com `status` derivado da etapa, data de
 * ganho/perda quando for o caso e a movimentação de entrada no funil.
 */
export async function criarNegocio(
  t: AppTeste,
  dados: DadosDeNegocio = {},
): Promise<Negocio> {
  const funil = await funilBase(t, dados.area ?? 'COMERCIAL');
  const etapa = dados.etapa
    ? funil.etapas.find((candidata) => candidata.chave === dados.etapa)
    : funil.etapas.find((candidata) => candidata.tipo === 'ABERTA');
  if (!etapa) {
    throw new Error(
      `Etapa "${dados.etapa ?? 'aberta'}" não existe no funil ${funil.nome}.`,
    );
  }
  const contatoId = idDe(dados.contato) ?? (await criarContato(t)).id;
  const agora = new Date();
  const status =
    etapa.tipo === 'ABERTA'
      ? 'ABERTO'
      : etapa.tipo === 'GANHO'
        ? 'GANHO'
        : 'PERDIDO';
  return t.prisma.negocio.create({
    data: {
      titulo: dados.titulo ?? `Negócio ${proximo()}`,
      contatoId,
      empresaId: idDe(dados.empresa) ?? null,
      funilId: funil.id,
      etapaId: etapa.id,
      responsavelId: idDe(dados.responsavel) ?? null,
      status,
      valor: new Prisma.Decimal(dados.valor ?? '0'),
      valorRecorrente:
        dados.valorRecorrente === undefined || dados.valorRecorrente === null
          ? null
          : new Prisma.Decimal(dados.valorRecorrente),
      ganhoEm: status === 'GANHO' ? agora : null,
      perdidoEm: status === 'PERDIDO' ? agora : null,
      motivoPerda:
        status === 'PERDIDO' ? 'Criado perdido pela fábrica de teste' : null,
      etapaDesde: agora,
      origem: dados.origem ?? 'MANUAL',
      negocioOrigemId: idDe(dados.negocioOrigem) ?? null,
      movimentacoes: {
        create: {
          funilId: funil.id,
          paraEtapaId: etapa.id,
          tipoAtor: 'SISTEMA',
          criadoEm: agora,
        },
      },
    },
  });
}

export interface DadosDeAtividade {
  responsavel: Usuario | string;
  tipo?: TipoAtividade;
  titulo?: string;
  status?: StatusAtividade;
  prioridade?: PrioridadeAtividade;
  venceEm?: Date | null;
  inicioEm?: Date | null;
  fimEm?: Date | null;
  criadoPor?: Usuario | string | null;
  contato?: Contato | string | null;
  empresa?: Empresa | string | null;
  negocio?: Negocio | string | null;
}

/**
 * Cria uma atividade como a API gravaria: nota já concluída (R6.2) e, na
 * reunião, `venceEm` = início quando não informado (é o que ordena a agenda e
 * dispara o lembrete, R6.5).
 */
export function criarAtividade(
  t: AppTeste,
  dados: DadosDeAtividade,
): Promise<Atividade> {
  const status =
    dados.status ?? (dados.tipo === 'NOTA' ? 'CONCLUIDA' : 'PENDENTE');
  const responsavelId = idDe(dados.responsavel) as string;
  const venceEm =
    dados.venceEm !== undefined
      ? dados.venceEm
      : dados.tipo === 'REUNIAO'
        ? (dados.inicioEm ?? null)
        : null;
  return t.prisma.atividade.create({
    data: {
      tipo: dados.tipo ?? 'TAREFA',
      titulo: dados.titulo ?? `Atividade ${proximo()}`,
      status,
      prioridade: dados.prioridade ?? 'MEDIA',
      venceEm,
      inicioEm: dados.inicioEm ?? null,
      fimEm: dados.fimEm ?? null,
      responsavelId,
      criadoPorId: idDe(dados.criadoPor) ?? responsavelId,
      concluidaEm: status === 'CONCLUIDA' ? new Date() : null,
      concluidaPorId: status === 'CONCLUIDA' ? responsavelId : null,
      canceladaEm: status === 'CANCELADA' ? new Date() : null,
      contatoId: idDe(dados.contato) ?? null,
      empresaId: idDe(dados.empresa) ?? null,
      negocioId: idDe(dados.negocio) ?? null,
    },
  });
}
