/**
 * R35.2 — o contexto que a API põe em cada consulta para a RLS do banco.
 *
 * O banco lê dois parâmetros da sessão (`crm.ator` e `crm.escrita`), postos
 * pelo `pool-com-contexto.ts` antes de cada consulta, a partir do contexto
 * assíncrono da requisição ou do job (`contexto-requisicao.ts`):
 *
 * - `crm.ator`: o id do usuário autenticado; `sistema` para jobs, webhooks,
 *   automações, rotas públicas e o gateway do WhatsApp; vazio quando não há
 *   contexto — e aí o banco não devolve nem aceita linha nenhuma das tabelas
 *   protegidas (falha segura).
 * - `crm.escrita` (a tabela de um INSERT, UPDATE ou DELETE numa tabela
 *   protegida, só durante ele) e `crm.escritos` (os ids que a transação
 *   corrente gravou): folgas de leitura para quem grava uma linha que deixa de
 *   ver — o PostgreSQL confere a linha nova de um UPDATE também contra a
 *   política de leitura, e o Prisma relê a linha gravada. A linha antiga
 *   continua tendo de ser visível para a pessoa. Postas pelo
 *   `pool-com-contexto.ts`.
 */
import { contextoSeHouver } from '../comum/contexto/contexto-requisicao';

/** Valor de `crm.ator` para jobs, webhooks, rotas públicas e o gateway. */
export const ATOR_SISTEMA = 'sistema';

/** Tabelas com RLS (R35.2), como no banco. */
export const TABELAS_PROTEGIDAS = [
  'negocios',
  'contatos',
  'empresas',
  'atividades',
  'conversas',
  'mensagens',
  'ligacoes',
  'arquivos',
] as const;

/**
 * O `crm.ator` da consulta que vai rodar agora: o usuário da requisição, o
 * sistema, ou vazio (nega). Requisição HTTP sem usuário (antes do login ou
 * numa rota pública que não se marcou como sistema) não tem contexto.
 */
export function atorDoBanco(): string {
  const contexto = contextoSeHouver();
  if (!contexto) {
    return '';
  }
  if (contexto.bancoComoSistema || contexto.tipoAtor !== 'USUARIO') {
    return ATOR_SISTEMA;
  }
  return contexto.usuario?.id ?? '';
}
