import { Injectable } from '@nestjs/common';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import { type Escopo, permissoesDoPapel } from '../comum/dominio/permissoes';
import {
  RegraVioladaException,
  SemPermissaoException,
} from '../comum/erros/excecoes';
import { PrismaService, type Tx } from '../prisma/prisma.service';

export type EntidadeDoAlcance = 'contato' | 'empresa';

/**
 * Até onde alguém edita contatos e empresas (matriz §12): Admin e C-level,
 * todos; líder, os que têm responsável na equipe (ele e os liderados); membro,
 * os seus. Ver, todos veem.
 */
export class AlcanceDeEdicao {
  constructor(
    readonly escopo: Escopo,
    /** Responsáveis permitidos quando o escopo não é `TODOS`. */
    readonly responsaveis: ReadonlySet<string>,
  ) {}

  get todos(): boolean {
    return this.escopo === 'TODOS';
  }

  /** Pode editar um registro com este responsável? Sem responsável, só Admin e C-level. */
  permite(responsavelId: string | null | undefined): boolean {
    return (
      this.todos ||
      (responsavelId !== null &&
        responsavelId !== undefined &&
        this.responsaveis.has(responsavelId))
    );
  }
}

@Injectable()
export class PermissoesContatosService {
  constructor(private readonly prisma: PrismaService) {}

  /** O alcance de edição de quem está logado (os liderados vêm do banco). */
  async alcance(usuario: UsuarioAutenticado): Promise<AlcanceDeEdicao> {
    const escopo = permissoesDoPapel(usuario.papel).editarContatos;
    switch (escopo) {
      case 'TODOS':
        return new AlcanceDeEdicao(escopo, new Set());
      case 'EQUIPE': {
        const liderados = await this.prisma.usuario.findMany({
          where: { liderId: usuario.id },
          select: { id: true },
        });
        return new AlcanceDeEdicao(
          escopo,
          new Set([usuario.id, ...liderados.map(({ id }) => id)]),
        );
      }
      case 'PROPRIOS':
        return new AlcanceDeEdicao(escopo, new Set([usuario.id]));
      default:
        return new AlcanceDeEdicao(escopo, new Set());
    }
  }

  /** 403 se o registro está fora do alcance (§12). */
  garantirPodeEditar(
    alcance: AlcanceDeEdicao,
    responsavelId: string | null,
    entidade: EntidadeDoAlcance,
  ): void {
    if (alcance.permite(responsavelId)) {
      return;
    }
    const [plural, dosQuais] =
      entidade === 'contato'
        ? ['contatos', 'dos quais']
        : ['empresas', 'das quais'];
    throw new SemPermissaoException(
      alcance.escopo === 'EQUIPE'
        ? `Você só edita ${plural} cujo responsável é você ou alguém da sua equipe.`
        : alcance.escopo === 'PROPRIOS'
          ? `Você só edita ${plural} ${dosQuais} é o responsável.`
          : `Você não pode editar ${plural}.`,
    );
  }

  /**
   * Quem pode receber o registro (R4.5 e §12): um usuário ativo e, para líder
   * e membro, alguém do próprio alcance — o líder distribui na equipe, o membro
   * fica com o que é seu.
   */
  async garantirPodeAtribuir(
    tx: Tx,
    alcance: AlcanceDeEdicao,
    responsavelId: string,
    entidade: EntidadeDoAlcance,
  ): Promise<{ id: string; nome: string }> {
    const responsavel = await this.garantirResponsavelAtivo(tx, responsavelId);
    if (!alcance.permite(responsavelId)) {
      const artigo = entidade === 'contato' ? 'o contato' : 'a empresa';
      throw new SemPermissaoException(
        alcance.escopo === 'EQUIPE'
          ? `Você só pode atribuir ${artigo} a você ou a alguém da sua equipe.`
          : `Você só pode atribuir ${artigo} a você mesmo.`,
        { responsavelId },
      );
    }
    return responsavel;
  }

  /** R4.5: o responsável é um usuário ativo (422 se não for). */
  async garantirResponsavelAtivo(
    tx: Tx,
    responsavelId: string,
  ): Promise<{ id: string; nome: string }> {
    const responsavel = await tx.usuario.findFirst({
      where: { id: responsavelId, ativo: true },
      select: { id: true, nome: true },
    });
    if (!responsavel) {
      throw new RegraVioladaException(
        'R4.5',
        'O responsável precisa ser um usuário ativo.',
        { responsavelId },
      );
    }
    return responsavel;
  }
}
