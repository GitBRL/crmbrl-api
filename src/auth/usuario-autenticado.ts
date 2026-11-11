import type { Papel } from '../generated/prisma/client';
import type { Area } from '../comum/dominio/setores';

/** Quem fez a requisição, como o `SessaoGuard` o deixa disponível (`@UsuarioAtual()`). */
export interface UsuarioAutenticado {
  readonly id: string;
  readonly nome: string;
  readonly email: string;
  readonly papel: Papel;
  /** Setor (chave) de Líder e Membro; `null` para Admin e C-level. */
  readonly area: Area | null;
  /** Nome do setor; `null` para Admin e C-level. */
  readonly nomeSetor: string | null;
  readonly liderId: string | null;
  readonly deveTrocarSenha: boolean;
  /** Sessão em uso nesta requisição. */
  readonly sessaoId: string;
}
