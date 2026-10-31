import { Injectable } from '@nestjs/common';
import type { UsuarioAutenticado } from '../../auth/usuario-autenticado';
import type { Area, Prisma } from '../../generated/prisma/client';
import { areaDoPapel, ehDiretoria } from '../dominio/papeis';
import { DadosInvalidosException } from '../erros/excecoes';
import { PrismaService, type Tx } from '../../prisma/prisma.service';
import {
  type CondicaoDeSegmento,
  type FiltroDeNegocio,
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

  /**
   * Valida o segmento montado por uma pessoa (R5.9): quem não é Admin nem
   * C-level só filtra por funis, etapas e área que vê (os da própria área);
   * outro funil responde 400. Execuções de automação não passam por aqui.
   */
  async validarParaUsuario(
    entrada: unknown,
    usuario: Pick<UsuarioAutenticado, 'papel'>,
  ): Promise<Segmento> {
    const segmento = validarSegmento(entrada);
    if (ehDiretoria(usuario.papel)) {
      return segmento;
    }
    const area = areaDoPapel(usuario.papel);
    const filtros: FiltroDeNegocio[] = [];
    coletarFiltrosDeNegocio(segmento.condicoes, filtros);
    for (const filtro of filtros) {
      const funilIds = new Set<string>(filtro.funilId ? [filtro.funilId] : []);
      let proibido = filtro.area !== undefined && filtro.area !== area;
      if (funilIds.size > 0 || filtro.etapaIds?.length) {
        const funis = await this.prisma.funil.findMany({
          where: {
            excluidoEm: null,
            OR: [
              { id: { in: [...funilIds] } },
              { etapas: { some: { id: { in: filtro.etapaIds ?? [] } } } },
            ],
          },
          select: { area: true },
        });
        proibido = proibido || funis.some((f) => f.area !== area);
      }
      if (proibido) {
        throw new DadosInvalidosException(
          'O segmento usa um funil que você não vê.',
          {
            regra: 'R5.9',
            campos: [
              {
                campo: 'segmento',
                mensagens: [
                  'funil, etapa ou área de negócio fora do seu acesso',
                ],
              },
            ],
          },
        );
      }
    }
    return segmento;
  }

  /** Opções para contar/listar contatos de um segmento montado por uma pessoa. */
  opcoesDoUsuario(usuario: Pick<UsuarioAutenticado, 'papel'>): {
    areaDosNegocios?: Area;
  } {
    const area = areaDoPapel(usuario.papel);
    return ehDiretoria(usuario.papel) || !area ? {} : { areaDosNegocios: area };
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

function coletarFiltrosDeNegocio(
  condicoes: readonly CondicaoDeSegmento[],
  saida: FiltroDeNegocio[],
): void {
  for (const condicao of condicoes) {
    if ('grupo' in condicao) {
      coletarFiltrosDeNegocio(condicao.grupo.condicoes, saida);
    } else if (condicao.campo === 'negocio' && condicao.valor) {
      saida.push(condicao.valor as FiltroDeNegocio);
    }
  }
}
