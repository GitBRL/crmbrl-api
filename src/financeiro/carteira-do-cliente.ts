import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import { NaoEncontradoException } from '../comum/erros/excecoes';
import type { Tx } from '../prisma/prisma.service';
import { ehCsDaCarteira } from './permissoes-financeiro';

/**
 * Contrato ou título só pode ser ligado a um cliente que a pessoa alcança (R22.1): o membro de CS
 * atua nos clientes da própria carteira (responsável = ele) e nos sem responsável; quem gerencia
 * o Financeiro (Admin, C-level, Líder de CS) alcança todos. Empresa e contato existirem é conferido
 * por quem chama; aqui só a carteira. Cliente de outra carteira é 404, como se não existisse.
 */
export async function conferirClienteNaCarteira(
  tx: Tx,
  usuario: Pick<UsuarioAutenticado, 'id' | 'papel' | 'area'>,
  cliente: { empresaId: string | null; contatoId: string | null },
): Promise<void> {
  if (!ehCsDaCarteira(usuario)) {
    return;
  }
  if (cliente.empresaId) {
    const alheia = await tx.empresa.findFirst({
      where: {
        id: cliente.empresaId,
        AND: [
          { responsavelId: { not: null } },
          { responsavelId: { not: usuario.id } },
        ],
      },
      select: { id: true },
    });
    if (alheia) {
      throw new NaoEncontradoException('Empresa não encontrada.');
    }
  }
  if (cliente.contatoId) {
    const contatoAlheio = await tx.contato.findFirst({
      where: {
        id: cliente.contatoId,
        AND: [
          { responsavelId: { not: null } },
          { responsavelId: { not: usuario.id } },
        ],
      },
      select: { id: true },
    });
    if (contatoAlheio) {
      throw new NaoEncontradoException('Contato não encontrado.');
    }
  }
}
