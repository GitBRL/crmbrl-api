/**
 * Permissões derivadas do papel — a matriz de acesso da Fase 1 (seção 12 das
 * regras). Vão no `GET /api/v1/auth/eu` para o front mostrar só o que cabe a
 * cada um; a API continua conferindo cada operação nos serviços.
 */
import type { Area, Papel } from '../../generated/prisma/client';
import { areaDoPapel, ehDiretoria, ehLider, TODAS_AS_AREAS } from './papeis';

/**
 * Alcance de uma permissão:
 * - `TODOS`: sem restrição;
 * - `AREA`: o que é da área do usuário;
 * - `EQUIPE`: o próprio usuário e os liderados dele;
 * - `PROPRIOS`: só o que é do próprio usuário (em negócios, também os sem
 *   responsável da área, R5.9);
 * - `NENHUM`: não pode.
 */
export type Escopo = 'TODOS' | 'AREA' | 'EQUIPE' | 'PROPRIOS' | 'NENHUM';

export interface Permissoes {
  /** Criar, editar, desligar, reativar e redefinir senha de usuários (R1.5). */
  readonly gerenciarUsuarios: boolean;
  /** Ver usuários: todos, a própria equipe ou a si mesmo (R1.5). */
  readonly verUsuarios: Escopo;
  /** Configurar funis e etapas (R5.1). */
  readonly configurarFunis: Escopo;
  /** Ver e mover negócios (R5.9). `PROPRIOS` = os seus e os sem responsável da área. */
  readonly verNegocios: Escopo;
  /** Reabrir negócio ganho ou perdido (R5.5). */
  readonly reabrirNegocios: Escopo;
  /** Ver contatos e empresas. */
  readonly verContatos: boolean;
  /** Editar contato/empresa: todos, os da equipe (pelo responsável) ou os seus. */
  readonly editarContatos: Escopo;
  /** Excluir com anonimização (R4.6). */
  readonly anonimizarContatos: boolean;
  /** Ver atividades (R6.4): todas, as da equipe ou as suas (responsável ou criador). */
  readonly verAtividades: Escopo;
  /** Configurar passagens entre funis (R5.7). */
  readonly configurarPassagens: boolean;
  /** Configurar o rodízio (R5.8). */
  readonly configurarRodizio: Escopo;
  /** Webhooks de entrada e saída (R8, R9). */
  readonly gerenciarWebhooks: boolean;
  /** Consultar a auditoria (R3.4). */
  readonly verAuditoria: boolean;
  /** Consultar os logs técnicos (R3.6). */
  readonly verLogsTecnicos: boolean;
  /** Documentação da API em produção (`/api/docs`). */
  readonly verDocumentacaoApi: boolean;
  /** Áreas cujos funis o usuário vê (Admin e C-level: todas). */
  readonly areasVisiveis: readonly Area[];
}

export function permissoesDoPapel(papel: Papel): Permissoes {
  const admin = papel === 'ADMIN';
  const diretoria = ehDiretoria(papel);
  const lider = ehLider(papel);
  const area = areaDoPapel(papel);
  return {
    gerenciarUsuarios: admin,
    verUsuarios: diretoria ? 'TODOS' : lider ? 'EQUIPE' : 'PROPRIOS',
    configurarFunis: diretoria ? 'TODOS' : lider ? 'AREA' : 'NENHUM',
    verNegocios: diretoria ? 'TODOS' : lider ? 'AREA' : 'PROPRIOS',
    reabrirNegocios: diretoria ? 'TODOS' : lider ? 'AREA' : 'NENHUM',
    verContatos: true,
    editarContatos: diretoria ? 'TODOS' : lider ? 'EQUIPE' : 'PROPRIOS',
    anonimizarContatos: admin,
    verAtividades: diretoria ? 'TODOS' : lider ? 'EQUIPE' : 'PROPRIOS',
    configurarPassagens: diretoria,
    configurarRodizio: diretoria ? 'TODOS' : lider ? 'AREA' : 'NENHUM',
    gerenciarWebhooks: admin,
    verAuditoria: diretoria,
    verLogsTecnicos: admin,
    verDocumentacaoApi: admin,
    areasVisiveis: diretoria ? TODAS_AS_AREAS : area ? [area] : [],
  };
}
