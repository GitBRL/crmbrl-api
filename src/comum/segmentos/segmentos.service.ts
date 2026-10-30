import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { PrismaService, type Tx } from '../../prisma/prisma.service';
import {
  type OpcoesDoSegmento,
  type Segmento,
  validarSegmento,
  whereDoSegmento,
} from './segmentos';

/** Contato da amostra do segmento. */
export interface ContatoDaAmostra {
  id: string;
  nome: string;
  email: string | null;
  telefone: string | null;
  etiquetas: string[];
  optOutMarketing: boolean;
}

/**
 * Segmentos de contatos (Onda B, §2.1): contagem prévia, amostra, pertinência
 * e iteração em lotes. O formato e a tradução para o Prisma ficam em `./segmentos`.
 *
 * ```ts
 * const segmento = validarSegmento(dto.segmento);            // 400 com detalhes.problemas
 * const total = await this.segmentos.contar(segmento);       // opt-out fora por padrão
 * for await (const ids of this.segmentos.iterarIds(segmento, { lote: 500 })) { … }
 * if (await this.segmentos.contem(segmento, contatoId, { excluirOptOut: false, negocioId })) { … }
 * ```
 */
@Injectable()
export class SegmentosService {
  constructor(private readonly prisma: PrismaService) {}

  /** Valida (aceita JSON vindo do banco ou da requisição). Lança 400. */
  validar(entrada: unknown): Segmento {
    return validarSegmento(entrada);
  }

  where(
    segmento: Segmento,
    opcoes?: OpcoesDoSegmento,
  ): Prisma.ContatoWhereInput {
    return whereDoSegmento(segmento, opcoes);
  }

  contar(
    segmento: Segmento,
    opcoes?: OpcoesDoSegmento,
    tx?: Tx,
  ): Promise<number> {
    return (tx ?? this.prisma).contato.count({
      where: whereDoSegmento(segmento, opcoes),
    });
  }

  /** Primeiros contatos do segmento (mais recentes primeiro). */
  amostra(
    segmento: Segmento,
    opcoes: OpcoesDoSegmento & { limite?: number } = {},
  ): Promise<ContatoDaAmostra[]> {
    return this.prisma.contato.findMany({
      where: whereDoSegmento(segmento, opcoes),
      select: {
        id: true,
        nome: true,
        email: true,
        telefone: true,
        etiquetas: true,
        optOutMarketing: true,
      },
      orderBy: [{ criadoEm: 'desc' }, { id: 'asc' }],
      take: Math.min(Math.max(opcoes.limite ?? 10, 1), 100),
    });
  }

  /** O contato está no segmento? (condições de automação, critério "saiu do segmento"). */
  async contem(
    segmento: Segmento,
    contatoId: string,
    opcoes?: OpcoesDoSegmento,
    tx?: Tx,
  ): Promise<boolean> {
    const encontrado = await (tx ?? this.prisma).contato.findFirst({
      where: { AND: [{ id: contatoId }, whereDoSegmento(segmento, opcoes)] },
      select: { id: true },
    });
    return encontrado !== null;
  }

  /** Ids do segmento em lotes, por ordem de id (cursor estável para públicos grandes). */
  async *iterarIds(
    segmento: Segmento,
    opcoes: OpcoesDoSegmento & { lote?: number } = {},
  ): AsyncGenerator<string[]> {
    const where = whereDoSegmento(segmento, opcoes);
    const lote = Math.min(Math.max(opcoes.lote ?? 500, 1), 5_000);
    let depoisDe: string | undefined;
    for (;;) {
      const linhas = await this.prisma.contato.findMany({
        where: depoisDe ? { AND: [where, { id: { gt: depoisDe } }] } : where,
        select: { id: true },
        orderBy: { id: 'asc' },
        take: lote,
      });
      if (linhas.length === 0) {
        return;
      }
      yield linhas.map(({ id }) => id);
      if (linhas.length < lote) {
        return;
      }
      depoisDe = linhas[linhas.length - 1].id;
    }
  }
}
