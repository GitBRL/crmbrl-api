/**
 * Permissões do Financeiro (R22.1): Admin, C-level e Líder de CS gerenciam tudo;
 * membros de CS veem e atuam nos clientes da própria carteira; o Comercial vê
 * (só leitura) os contratos dos negócios que ganhou — o líder, os da área;
 * Marketing não acessa.
 */
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import { areaDoPapel, ehDiretoria, ehLider } from '../comum/dominio/papeis';
import type { Papel, Prisma } from '../generated/prisma/client';

type Usuario = Pick<UsuarioAutenticado, 'id' | 'papel'>;

/** Gerencia tudo: Admin, C-level e Líder de CS. */
export function ehGestorFinanceiro(papel: Papel): boolean {
  return ehDiretoria(papel) || papel === 'LIDER_CS';
}

/** Membro de CS (atua na própria carteira). */
export function ehCsDaCarteira(papel: Papel): boolean {
  return papel === 'CS';
}

/** Comercial (membro ou líder): só leitura dos contratos que ganhou. */
export function ehComercialSomenteLeitura(papel: Papel): boolean {
  return papel === 'COMERCIAL' || papel === 'LIDER_COMERCIAL';
}

/** Quem entra no módulo. */
export function temAcessoAoFinanceiro(papel: Papel): boolean {
  return (
    ehGestorFinanceiro(papel) ||
    ehCsDaCarteira(papel) ||
    ehComercialSomenteLeitura(papel)
  );
}

/** Quem altera algo (dentro do que vê). */
export function podeAtuarNoFinanceiro(papel: Papel): boolean {
  return ehGestorFinanceiro(papel) || ehCsDaCarteira(papel);
}

/** Régua (etapas, configuração, "Executar agora"), importação e reenvios em massa. */
export function podeGerenciarARegua(papel: Papel): boolean {
  return ehGestorFinanceiro(papel);
}

/** Contratos que o usuário vê. */
export function filtroDeContratosVisiveis(
  usuario: Usuario,
): Prisma.ContratoWhereInput {
  if (ehGestorFinanceiro(usuario.papel)) {
    return {};
  }
  if (ehCsDaCarteira(usuario.papel)) {
    return {
      OR: [
        { responsavelCsId: usuario.id },
        { empresa: { responsavelId: usuario.id } },
        { contato: { responsavelId: usuario.id } },
      ],
    };
  }
  if (ehComercialSomenteLeitura(usuario.papel)) {
    const area = areaDoPapel(usuario.papel);
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
  if (ehGestorFinanceiro(usuario.papel)) {
    return {};
  }
  const doContrato: Prisma.ParcelaWhereInput = {
    contrato: filtroDeContratosVisiveis(usuario),
  };
  if (ehCsDaCarteira(usuario.papel)) {
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
  return ehComercialSomenteLeitura(usuario.papel)
    ? doContrato
    : { id: { in: [] } };
}
