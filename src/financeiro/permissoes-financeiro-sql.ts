/**
 * Os mesmos filtros de visibilidade de `permissoes-financeiro.ts` (R22.1), em SQL, para as
 * agregações feitas no banco (`$queryRaw`). Cada fragmento aponta para o alias da tabela
 * `contratos` ou `parcelas` da consulta; mudou a regra lá, mude aqui (o teste de
 * equivalência cobre os dois caminhos).
 */
import { Prisma } from '../generated/prisma/client';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import { ehLider } from '../comum/dominio/papeis';
import {
  ehComercialSomenteLeitura,
  ehCsDaCarteira,
  ehGestorFinanceiro,
} from './permissoes-financeiro';

type Usuario = Pick<UsuarioAutenticado, 'id' | 'papel' | 'area'>;

const VERDADEIRO = Prisma.sql`TRUE`;
const FALSO = Prisma.sql`FALSE`;

/** Contratos que o usuário vê; `c` é o alias de `contratos`. */
export function sqlContratosVisiveis(
  usuario: Usuario,
  c: Prisma.Sql = Prisma.raw('c'),
): Prisma.Sql {
  if (ehGestorFinanceiro(usuario)) return VERDADEIRO;
  if (ehCsDaCarteira(usuario)) {
    return Prisma.sql`(${c}.responsavel_cs_id = ${usuario.id}::uuid
      OR EXISTS (SELECT 1 FROM empresas e WHERE e.id = ${c}.empresa_id AND e.responsavel_id = ${usuario.id}::uuid)
      OR EXISTS (SELECT 1 FROM contatos t WHERE t.id = ${c}.contato_id AND t.responsavel_id = ${usuario.id}::uuid))`;
  }
  if (ehComercialSomenteLeitura(usuario)) {
    const area = usuario.area;
    return ehLider(usuario.papel) && area
      ? Prisma.sql`EXISTS (SELECT 1 FROM negocios n JOIN funis f ON f.id = n.funil_id
          WHERE n.id = ${c}.negocio_id AND n.status::text = 'GANHO' AND f.area::text = ${area})`
      : Prisma.sql`EXISTS (SELECT 1 FROM negocios n
          WHERE n.id = ${c}.negocio_id AND n.status::text = 'GANHO' AND n.responsavel_id = ${usuario.id}::uuid)`;
  }
  return FALSO;
}

/** Parcelas que o usuário vê; `p` é o alias de `parcelas`. */
export function sqlParcelasVisiveis(
  usuario: Usuario,
  p: Prisma.Sql = Prisma.raw('p'),
): Prisma.Sql {
  if (ehGestorFinanceiro(usuario)) return VERDADEIRO;
  const doContrato = Prisma.sql`EXISTS (SELECT 1 FROM contratos c WHERE c.id = ${p}.contrato_id AND ${sqlContratosVisiveis(usuario)})`;
  if (ehCsDaCarteira(usuario)) {
    return Prisma.sql`(${doContrato}
      OR (${p}.contrato_id IS NULL AND (
        EXISTS (SELECT 1 FROM contatos t WHERE t.id = ${p}.contato_id AND t.responsavel_id = ${usuario.id}::uuid)
        OR EXISTS (SELECT 1 FROM empresas e WHERE e.id = ${p}.empresa_id AND e.responsavel_id = ${usuario.id}::uuid))))`;
  }
  return ehComercialSomenteLeitura(usuario) ? doContrato : FALSO;
}

/** Filtro por pessoas de CS (BI) sobre `parcelas`; `null` = todas. */
export function sqlParcelasDasPessoas(
  pessoas: readonly string[] | null | undefined,
  p: Prisma.Sql = Prisma.raw('p'),
): Prisma.Sql {
  if (!pessoas) return VERDADEIRO;
  if (pessoas.length === 0) return FALSO;
  return Prisma.sql`EXISTS (SELECT 1 FROM contratos cp WHERE cp.id = ${p}.contrato_id
    AND cp.responsavel_cs_id IN (${Prisma.join(pessoas.map((x) => Prisma.sql`${x}::uuid`))}))`;
}

/** Filtro por pessoas de CS sobre `contratos`. */
export function sqlContratosDasPessoas(
  pessoas: readonly string[] | null | undefined,
  c: Prisma.Sql = Prisma.raw('c'),
): Prisma.Sql {
  if (!pessoas) return VERDADEIRO;
  if (pessoas.length === 0) return FALSO;
  return Prisma.sql`${c}.responsavel_cs_id IN (${Prisma.join(pessoas.map((x) => Prisma.sql`${x}::uuid`))})`;
}
