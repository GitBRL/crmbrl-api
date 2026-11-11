/**
 * Permissões do Financeiro (R22.1): Admin, C-level e Líder de CS gerenciam tudo;
 * membros de CS veem e atuam nos clientes da própria carteira; o Comercial vê
 * (só leitura) os contratos dos negócios que ganhou — o líder, os da área;
 * Marketing não acessa.
 */
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import {
  type ComPapel,
  ehDiretoria,
  ehDoSetor,
  ehLider,
  ehLiderDoSetor,
  ehMembroDoSetor,
} from '../comum/dominio/papeis';
import { SETOR_COMERCIAL, SETOR_CS } from '../comum/dominio/setores';
import type { Prisma } from '../generated/prisma/client';

type Usuario = Pick<UsuarioAutenticado, 'id' | 'papel' | 'area'>;

/** Gerencia tudo: Admin, C-level e Líder de CS (preso ao setor-base CS). */
export function ehGestorFinanceiro(pessoa: ComPapel): boolean {
  return ehDiretoria(pessoa.papel) || ehLiderDoSetor(pessoa, SETOR_CS);
}

/** Membro de CS (atua na própria carteira). */
export function ehCsDaCarteira(pessoa: ComPapel): boolean {
  return ehMembroDoSetor(pessoa, SETOR_CS);
}

/** Comercial (membro ou líder): só leitura dos contratos que ganhou. */
export function ehComercialSomenteLeitura(pessoa: ComPapel): boolean {
  return ehDoSetor(pessoa, SETOR_COMERCIAL);
}

/** Quem entra no módulo. */
export function temAcessoAoFinanceiro(pessoa: ComPapel): boolean {
  return (
    ehGestorFinanceiro(pessoa) ||
    ehCsDaCarteira(pessoa) ||
    ehComercialSomenteLeitura(pessoa)
  );
}

/** Quem altera algo (dentro do que vê). */
export function podeAtuarNoFinanceiro(pessoa: ComPapel): boolean {
  return ehGestorFinanceiro(pessoa) || ehCsDaCarteira(pessoa);
}

/** Régua (etapas, configuração, "Executar agora"), importação e reenvios em massa. */
export function podeGerenciarARegua(pessoa: ComPapel): boolean {
  return ehGestorFinanceiro(pessoa);
}

/** Contratos que o usuário vê. */
export function filtroDeContratosVisiveis(
  usuario: Usuario,
): Prisma.ContratoWhereInput {
  if (ehGestorFinanceiro(usuario)) {
    return {};
  }
  if (ehCsDaCarteira(usuario)) {
    return {
      OR: [
        { responsavelCsId: usuario.id },
        { empresa: { responsavelId: usuario.id } },
        { contato: { responsavelId: usuario.id } },
      ],
    };
  }
  if (ehComercialSomenteLeitura(usuario)) {
    const area = usuario.area;
    return ehLider(usuario.papel) && area
      ? { negocio: { status: 'GANHO', funil: { area } } }
      : { negocio: { status: 'GANHO', responsavelId: usuario.id } };
  }
  return { id: { in: [] } };
}

/** Parcelas que o usuário vê (as do contrato visível, e os títulos avulsos da carteira de CS). */
export function filtroDeParcelasVisiveis(
  usuario: Usuario,
): Prisma.ParcelaWhereInput {
  if (ehGestorFinanceiro(usuario)) {
    return {};
  }
  const doContrato: Prisma.ParcelaWhereInput = {
    contrato: filtroDeContratosVisiveis(usuario),
  };
  if (ehCsDaCarteira(usuario)) {
    return {
      OR: [
        doContrato,
        {
          contratoId: null,
          OR: [
            { contato: { responsavelId: usuario.id } },
            { empresa: { responsavelId: usuario.id } },
          ],
        },
      ],
    };
  }
  return ehComercialSomenteLeitura(usuario) ? doContrato : { id: { in: [] } };
}
