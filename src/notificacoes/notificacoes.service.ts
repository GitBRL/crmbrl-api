import { Injectable } from '@nestjs/common';
import { sanitizarObjeto } from '../comum/dados/sanitizar';
import { NaoEncontradoException } from '../comum/erros/excecoes';
import { montarPagina, paraSkipTake } from '../comum/paginacao/paginacao';
import type { Notificacao, Prisma } from '../generated/prisma/client';
import { PrismaService, type Tx } from '../prisma/prisma.service';
import {
  type FiltroNotificacoesDto,
  NotificacaoDto,
  type PaginaNotificacoesDto,
} from './notificacoes.dto';
import { OuvintesDeNotificacao } from './ouvintes-notificacao';
import type { TipoNotificacao } from './tipos-notificacao';

export interface NovaNotificacao {
  /** Um dos `TIPOS_NOTIFICACAO` (R10.2). */
  tipo: TipoNotificacao | (string & {});
  titulo: string;
  texto?: string | null;
  /** Rota do front, ex.: `/funis/comercial?negocio=<id>`. */
  link?: string | null;
  dados?: Record<string, unknown> | null;
}

/**
 * Notificações internas (R10.2). As notificações nascem **na transação** da
 * alteração que as provoca; a listagem e a leitura são do próprio usuário.
 *
 * ```ts
 * await this.notificacoes.notificar(tx, responsavelId, {
 *   tipo: TIPOS_NOTIFICACAO.NEGOCIO_ATRIBUIDO,
 *   titulo: 'Novo lead para você',
 *   texto: `${contato.nome} chegou pelo webhook ${webhook.nome}.`,
 *   link: `/funis/marketing?negocio=${negocio.id}`,
 * });
 * ```
 */
@Injectable()
export class NotificacoesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ouvintes: OuvintesDeNotificacao,
  ) {}

  async notificar(
    tx: Tx,
    usuarioId: string,
    notificacao: NovaNotificacao,
  ): Promise<Notificacao> {
    const criada = await tx.notificacao.create({
      data: this.dadosDe(usuarioId, notificacao),
    });
    await this.ouvintes.avisar(tx, [criada]);
    return criada;
  }

  /** A mesma notificação para várias pessoas (repetidos são ignorados). Devolve quantas criou. */
  async notificarVarios(
    tx: Tx,
    usuarioIds: readonly string[],
    notificacao: NovaNotificacao,
  ): Promise<number> {
    const unicos = [...new Set(usuarioIds)];
    if (unicos.length === 0) {
      return 0;
    }
    const criadas = await tx.notificacao.createManyAndReturn({
      data: unicos.map((usuarioId) => this.dadosDe(usuarioId, notificacao)),
    });
    await this.ouvintes.avisar(tx, criadas);
    return criadas.length;
  }

  /** Para todos os Admins ativos — alertas de sistema (R10.2: webhooks, equipe sem líder). */
  async notificarAdmins(tx: Tx, notificacao: NovaNotificacao): Promise<number> {
    const admins = await tx.usuario.findMany({
      where: { papel: 'ADMIN', ativo: true },
      select: { id: true },
    });
    return this.notificarVarios(
      tx,
      admins.map(({ id }) => id),
      notificacao,
    );
  }

  async listar(
    usuarioId: string,
    filtro: FiltroNotificacoesDto,
  ): Promise<PaginaNotificacoesDto> {
    const where: Prisma.NotificacaoWhereInput = {
      usuarioId,
      ...(filtro.apenasNaoLidas ? { lidaEm: null } : {}),
    };
    const [itens, total, naoLidas] = await Promise.all([
      this.prisma.notificacao.findMany({
        where,
        orderBy: [{ criadoEm: 'desc' }, { id: 'desc' }],
        ...paraSkipTake(filtro),
      }),
      this.prisma.notificacao.count({ where }),
      this.contarNaoLidas(usuarioId),
    ]);
    return {
      ...montarPagina(
        itens.map((item) => NotificacaoDto.de(item)),
        total,
        filtro,
      ),
      naoLidas,
    };
  }

  contarNaoLidas(usuarioId: string): Promise<number> {
    return this.prisma.notificacao.count({
      where: { usuarioId, lidaEm: null },
    });
  }

  /** Marca uma notificação do próprio usuário como lida (404 se for de outro). */
  async marcarComoLida(usuarioId: string, id: string): Promise<NotificacaoDto> {
    const notificacao = await this.prisma.notificacao.findFirst({
      where: { id, usuarioId },
    });
    if (!notificacao) {
      throw new NaoEncontradoException('Notificação não encontrada.');
    }
    if (notificacao.lidaEm) {
      return NotificacaoDto.de(notificacao);
    }
    const atualizada = await this.prisma.notificacao.update({
      where: { id },
      data: { lidaEm: new Date() },
    });
    return NotificacaoDto.de(atualizada);
  }

  async marcarTodasComoLidas(usuarioId: string): Promise<number> {
    const { count } = await this.prisma.notificacao.updateMany({
      where: { usuarioId, lidaEm: null },
      data: { lidaEm: new Date() },
    });
    return count;
  }

  private dadosDe(
    usuarioId: string,
    notificacao: NovaNotificacao,
  ): Prisma.NotificacaoUncheckedCreateInput {
    const dados = sanitizarObjeto(notificacao.dados ?? undefined);
    return {
      usuarioId,
      tipo: notificacao.tipo,
      titulo: notificacao.titulo,
      texto: notificacao.texto ?? null,
      link: notificacao.link ?? null,
      dados: dados ? (dados as Prisma.InputJsonObject) : undefined,
    };
  }
}
