import { Inject, Injectable } from '@nestjs/common';
import { CriptografiaService } from '../comum/criptografia/criptografia.service';
import { AMBIENTE, type Ambiente } from '../config/ambiente';
import type { Sessao, Usuario } from '../generated/prisma/client';
import { PrismaService, type Tx } from '../prisma/prisma.service';

/** Por que a sessão foi revogada (`sessoes.motivo_revogacao`). */
export type MotivoRevogacao =
  | 'logout'
  | 'novo_login'
  | 'desligamento'
  | 'troca_de_senha'
  | 'redefinicao_de_senha'
  | 'senha_temporaria'
  | 'encerrar_outras'
  | 'usuario_inativo';

export interface SessaoValidada {
  readonly sessao: Sessao;
  /** O usuário com o nome do setor (Líder e Membro; nulo para Admin e C-level). */
  readonly usuario: Usuario & { readonly setor: { nome: string } | null };
}

/** O usuário da sessão vem com o nome do setor (R1.6). */
const USUARIO_COM_SETOR = {
  include: { setor: { select: { nome: true } } },
} as const;

const MS_POR_DIA = 24 * 60 * 60 * 1000;

/**
 * Sessões de login (R2.2, R2.4). O token (32 bytes aleatórios) vai só no cookie;
 * o banco guarda o SHA-256. A sessão expira depois de `SESSAO_INATIVIDADE_DIAS`
 * sem uso e, em qualquer caso, `SESSAO_DURACAO_MAXIMA_DIAS` depois do login; o
 * uso renova a validade, gravando no máximo a cada `SESSAO_RENOVACAO_MINUTOS`.
 *
 * Para o desligamento (R2.4, R7.3): `revogarTodas(tx, usuarioId, 'desligamento')`.
 */
@Injectable()
export class SessoesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cripto: CriptografiaService,
    @Inject(AMBIENTE) private readonly ambiente: Ambiente,
  ) {}

  /** Abre uma sessão e devolve o token (que só existe aqui e no cookie). */
  async criar(
    tx: Tx,
    usuarioId: string,
    meta: { ip?: string; userAgent?: string } = {},
  ): Promise<{ token: string; sessao: Sessao }> {
    const token = this.cripto.gerarToken(32);
    const agora = new Date();
    const sessao = await tx.sessao.create({
      data: {
        usuarioId,
        tokenHash: this.cripto.sha256(token),
        criadoEm: agora,
        ultimoUsoEm: agora,
        expiraEm: this.calcularExpiracao(agora, agora),
        ip: meta.ip,
        userAgent: meta.userAgent,
      },
    });
    return { token, sessao };
  }

  /**
   * A sessão do token, se ainda vale: não revogada, não expirada e de usuário
   * ativo (R2.4 — sessão de quem foi desligado é revogada aqui mesmo). Renova a
   * validade quando passou o intervalo de renovação. `null` = sessão inválida.
   */
  async validar(token: string): Promise<SessaoValidada | null> {
    if (!token || token.length > 200) {
      return null;
    }
    const encontrada = await this.prisma.sessao.findUnique({
      where: { tokenHash: this.cripto.sha256(token) },
      include: { usuario: USUARIO_COM_SETOR },
    });
    if (!encontrada || encontrada.revogadaEm) {
      return null;
    }
    const agora = new Date();
    if (encontrada.expiraEm.getTime() <= agora.getTime()) {
      return null;
    }
    const { usuario, ...sessao } = encontrada;
    if (!usuario.ativo) {
      await this.prisma.sessao.updateMany({
        where: { id: sessao.id, revogadaEm: null },
        data: { revogadaEm: agora, motivoRevogacao: 'usuario_inativo' },
      });
      return null;
    }
    const intervaloDeRenovacaoMs =
      this.ambiente.sessao.renovacaoMinutos * 60 * 1000;
    if (
      agora.getTime() - sessao.ultimoUsoEm.getTime() <
      intervaloDeRenovacaoMs
    ) {
      return { sessao, usuario };
    }
    const expiraEm = this.calcularExpiracao(sessao.criadoEm, agora);
    const [renovada, usuarioAtualizado] = await this.prisma.$transaction([
      this.prisma.sessao.update({
        where: { id: sessao.id },
        data: { ultimoUsoEm: agora, expiraEm },
      }),
      this.prisma.usuario.update({
        where: { id: usuario.id },
        data: { ultimoAcessoEm: agora },
        ...USUARIO_COM_SETOR,
      }),
    ]);
    return { sessao: renovada, usuario: usuarioAtualizado };
  }

  /** Validade depois de um uso: o menor entre (uso + inatividade) e (criação + duração máxima). */
  calcularExpiracao(criadaEm: Date, ultimoUso: Date): Date {
    const { inatividadeDias, duracaoMaximaDias } = this.ambiente.sessao;
    return new Date(
      Math.min(
        ultimoUso.getTime() + inatividadeDias * MS_POR_DIA,
        criadaEm.getTime() + duracaoMaximaDias * MS_POR_DIA,
      ),
    );
  }

  /** Revoga uma sessão (se ainda ativa). */
  async revogar(
    tx: Tx,
    sessaoId: string,
    motivo: MotivoRevogacao,
  ): Promise<void> {
    await tx.sessao.updateMany({
      where: { id: sessaoId, revogadaEm: null },
      data: { revogadaEm: new Date(), motivoRevogacao: motivo },
    });
  }

  /** Revoga a sessão de um token (ex.: o cookie antigo num novo login). */
  async revogarPorToken(
    tx: Tx,
    token: string,
    motivo: MotivoRevogacao,
  ): Promise<void> {
    await tx.sessao.updateMany({
      where: { tokenHash: this.cripto.sha256(token), revogadaEm: null },
      data: { revogadaEm: new Date(), motivoRevogacao: motivo },
    });
  }

  /** Revoga todas as sessões ativas do usuário (menos `exceto`). Devolve quantas. */
  async revogarTodas(
    tx: Tx,
    usuarioId: string,
    motivo: MotivoRevogacao,
    opcoes: { exceto?: string } = {},
  ): Promise<number> {
    const { count } = await tx.sessao.updateMany({
      where: {
        usuarioId,
        revogadaEm: null,
        ...(opcoes.exceto ? { id: { not: opcoes.exceto } } : {}),
      },
      data: { revogadaEm: new Date(), motivoRevogacao: motivo },
    });
    return count;
  }
}
