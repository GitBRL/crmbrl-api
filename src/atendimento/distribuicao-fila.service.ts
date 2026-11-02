import { Injectable } from '@nestjs/common';
import { papeisDaArea } from '../comum/dominio/papeis';
import type { FilaAtendimento } from '../generated/prisma/client';
import { PrismaService, type Tx } from '../prisma/prisma.service';
import {
  escolherNaFila,
  type ParticipantesDaFila,
  participantesDaFila,
  type UsuarioDaFila,
} from './distribuicao-fila';

/** O usuário como a distribuição precisa. */
const SELECAO_DO_USUARIO = {
  id: true,
  nome: true,
  papel: true,
  avatarUrl: true,
  criadoEm: true,
  acessoAtivadoEm: true,
  senhaHash: true,
} as const;

export interface SituacaoDaFila {
  participantes: ParticipantesDaFila<UsuarioDaFila>;
  /** Conversas em aberto de cada pessoa ativa da área. */
  cargas: Map<string, number>;
  /** Quem recebe a próxima (sem mexer no ponteiro). */
  proximo: UsuarioDaFila | null;
}

/**
 * Distribuição das conversas pela fila (R12), com banco: quem participa, a
 * carga de cada um e a escolha do próximo — sob `SELECT … FOR UPDATE` na
 * linha da fila, para duas conversas que chegam juntas não irem para a mesma
 * pessoa por engano do ponteiro.
 */
@Injectable()
export class DistribuicaoDaFila {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Escolhe (e grava no ponteiro) o responsável de uma conversa nova da fila.
   * `null`: fila inativa, estratégia `MANUAL` ou ninguém disponível — a
   * conversa fica na fila, sem responsável, até alguém assumir.
   */
  async escolher(tx: Tx, filaId: string): Promise<UsuarioDaFila | null> {
    await tx.$queryRaw`SELECT id FROM filas_atendimento WHERE id = ${filaId}::uuid FOR UPDATE`;
    const fila = await tx.filaAtendimento.findUnique({ where: { id: filaId } });
    if (
      !fila ||
      !fila.ativa ||
      fila.excluidoEm ||
      fila.estrategia === 'MANUAL'
    ) {
      return null;
    }
    const { proximo } = await this.situacao(tx, fila);
    if (!proximo) {
      return null;
    }
    await tx.filaAtendimento.update({
      where: { id: fila.id },
      data: { ultimoUsuarioId: proximo.id },
    });
    return proximo;
  }

  /** Participantes, cargas e o próximo da vez (para a tela da fila e para escolher). */
  async situacao(
    tx: Tx | PrismaService,
    fila: FilaAtendimento,
  ): Promise<SituacaoDaFila> {
    const [usuarios, linhas, ponteiro] = await Promise.all([
      tx.usuario.findMany({
        where: { ativo: true, papel: { in: [...papeisDaArea(fila.area)] } },
        select: SELECAO_DO_USUARIO,
      }),
      tx.filaParticipante.findMany({
        where: { filaId: fila.id },
        select: { usuarioId: true, participa: true },
      }),
      fila.ultimoUsuarioId
        ? tx.usuario.findUnique({
            where: { id: fila.ultimoUsuarioId },
            select: { id: true, criadoEm: true },
          })
        : Promise.resolve(null),
    ]);
    const participantes = participantesDaFila(fila.area, usuarios, linhas);
    const cargas = await this.cargas(
      tx,
      participantes.pessoas.map((pessoa) => pessoa.usuario.id),
    );
    const proximo =
      fila.ativa && !fila.excluidoEm
        ? escolherNaFila(
            fila.estrategia,
            participantes.elegiveis,
            ponteiro,
            cargas,
          )
        : null;
    return { participantes, cargas, proximo };
  }

  /** Conversas em aberto de cada usuário (quem não tem nenhuma fica com 0). */
  async cargas(
    tx: Tx | PrismaService,
    usuarioIds: readonly string[],
  ): Promise<Map<string, number>> {
    const cargas = new Map<string, number>(usuarioIds.map((id) => [id, 0]));
    if (usuarioIds.length === 0) {
      return cargas;
    }
    const grupos = await tx.conversa.groupBy({
      by: ['responsavelId'],
      where: {
        responsavelId: { in: [...usuarioIds] },
        status: { not: 'RESOLVIDA' },
      },
      _count: { _all: true },
    });
    for (const grupo of grupos) {
      if (grupo.responsavelId) {
        cargas.set(grupo.responsavelId, grupo._count._all);
      }
    }
    return cargas;
  }
}
