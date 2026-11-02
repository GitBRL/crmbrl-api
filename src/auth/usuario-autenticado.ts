import type { Area, Papel } from '../generated/prisma/client';

/** Quem fez a requisição, como o `SessaoGuard` o deixa disponível (`@UsuarioAtual()`). */
export interface UsuarioAutenticado {
  readonly id: string;
  readonly nome: string;
  readonly email: string;
  readonly papel: Papel;
  /** Área do papel; `null` para Admin e C-level. */
  readonly area: Area | null;
  readonly liderId: string | null;
  readonly deveTrocarSenha: boolean;
  /** Sessão em uso nesta requisição. */
  readonly sessaoId: string;
}
