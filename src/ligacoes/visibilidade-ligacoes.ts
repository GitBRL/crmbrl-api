/**
 * Quem vê cada ligação (R12, R29.8, R30.9): o atendente, quem foi chamado a atender, quem vê a
 * conversa e quem tem o contato no alcance (o responsável e o líder dele; a diretoria vê todas).
 * É o mesmo critério do player e da transcrição (`LeituraDaGravacaoService.podeVer`), do detalhe
 * (`LigacoesService.exigirAcesso`), da lista, da busca na transcrição e da linha do tempo; a
 * versão em SQL fica em `src/bi/escopo-bi.ts` (`sqlLigacoesVisiveis`).
 */
import { filtroDeConversasVisiveis } from '../atendimento/visibilidade';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import { ehDiretoria } from '../comum/dominio/papeis';
import { permissoesDoPapel } from '../comum/dominio/permissoes';
import type { Prisma } from '../generated/prisma/client';

/**
 * Contatos no alcance do usuário (os mesmos de `PermissoesContatosService.alcance`): o líder, os
 * que têm ele ou um liderado como responsável; o membro, os que têm ele como responsável.
 */
export function filtroDeContatosNoAlcance(
  usuario: Pick<UsuarioAutenticado, 'id' | 'papel' | 'area'>,
): Prisma.ContatoWhereInput {
  return permissoesDoPapel(usuario.papel).editarContatos === 'EQUIPE'
    ? {
        OR: [
          { responsavelId: usuario.id },
          { responsavel: { liderId: usuario.id } },
        ],
      }
    : { responsavelId: usuario.id };
}

/** Filtro das ligações que o usuário vê (`{}` = todas). Quem não usa o Atendimento nunca chega aqui. */
export function filtroDeLigacoesVisiveis(
  usuario: Pick<UsuarioAutenticado, 'id' | 'papel' | 'area'>,
): Prisma.LigacaoWhereInput {
  if (ehDiretoria(usuario.papel)) {
    return {};
  }
  const conversas = filtroDeConversasVisiveis(usuario);
  return {
    OR: [
      { atendenteId: usuario.id },
      { tocouPara: { has: usuario.id } },
      ...(conversas ? [{ conversa: conversas }] : []),
      { contato: filtroDeContatosNoAlcance(usuario) },
    ],
  };
}
