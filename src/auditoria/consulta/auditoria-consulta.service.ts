import { Injectable } from '@nestjs/common';
import {
  DadosInvalidosException,
  NaoEncontradoException,
} from '../../comum/erros/excecoes';
import type { PaginaPorCursor } from '../../comum/paginacao/paginacao';
import { Prisma, TipoAtor } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { referenciaDeAuditoria } from '../auditoria.service';
import {
  EventoAuditoriaDetalheDto,
  EventoAuditoriaDto,
  type FiltroAuditoriaDto,
  type FiltrosDaAuditoriaDto,
  type LinhaEventoAuditoria,
} from './auditoria-consulta.dto';
import {
  clausulaWhere,
  condicoesDeBusca,
  condicoesDoPeriodo,
  lerCursor,
  lerPeriodo,
  montarPaginaPorCursor,
  termosDaBusca,
} from './consulta-comum';

/** Colunas em que a busca por texto procura (R3.4). */
const COLUNAS_DA_BUSCA = [
  'resumo',
  'ator_descricao',
  'acao',
  'entidade_id',
] as const;

/**
 * Consulta da auditoria (R3.4), para Admin e C-level: filtros por período,
 * usuário, ação, entidade, id da entidade, tipo de ator, id da requisição e
 * texto, com paginação por cursor (do mais novo para o mais antigo), detalhe
 * com o diff e os valores para montar os filtros.
 *
 * Só leitura: a auditoria é somente inclusão (R3.3) e quem grava é o
 * `AuditoriaService`.
 */
@Injectable()
export class AuditoriaConsultaService {
  constructor(private readonly prisma: PrismaService) {}

  async listar(
    filtro: FiltroAuditoriaDto,
  ): Promise<PaginaPorCursor<EventoAuditoriaDto>> {
    const condicoes = this.condicoes(filtro);
    const linhas = await this.prisma.$queryRaw<LinhaEventoAuditoria[]>`
      SELECT id, criado_em, tipo_ator::text AS tipo_ator,
             usuario_id::text AS usuario_id, ator_descricao, acao, entidade,
             entidade_id, resumo, requisicao_id,
             dados -> 'alteracoes' AS alteracoes
        FROM eventos_auditoria
        ${clausulaWhere(condicoes)}
       ORDER BY id DESC
       LIMIT ${filtro.limite + 1}`;
    return montarPaginaPorCursor('auditoria', linhas, filtro.limite, (linha) =>
      EventoAuditoriaDto.daLinha(linha),
    );
  }

  async detalhar(id: bigint): Promise<EventoAuditoriaDetalheDto> {
    const evento = await this.prisma.eventoAuditoria.findUnique({
      where: { id },
    });
    if (!evento) {
      throw new NaoEncontradoException('Evento de auditoria não encontrado.');
    }
    // Sem chave estrangeira de propósito (R3.3): o usuário pode nem existir mais.
    const usuario = evento.usuarioId
      ? await this.prisma.usuario.findUnique({
          where: { id: evento.usuarioId },
          select: {
            id: true,
            nome: true,
            email: true,
            papel: true,
            ativo: true,
          },
        })
      : null;
    return EventoAuditoriaDetalheDto.de(evento, usuario);
  }

  async filtrosDisponiveis(): Promise<FiltrosDaAuditoriaDto> {
    const [acoes, entidades] = await Promise.all([
      this.valoresDistintos('acao'),
      this.valoresDistintos('entidade'),
    ]);
    // BOT só identifica o autor de mensagens do chatbot; as ações dele são
    // auditadas como AUTOMACAO, então não serve de filtro (Onda B).
    const tiposAtor = Object.values(TipoAtor).filter((tipo) => tipo !== 'BOT');
    return { acoes, entidades, tiposAtor };
  }

  private condicoes(filtro: FiltroAuditoriaDto): Prisma.Sql[] {
    const condicoes: Prisma.Sql[] = [];
    const cursor = lerCursor('auditoria', filtro.cursor);
    if (cursor !== undefined) {
      condicoes.push(Prisma.sql`id < ${cursor}`);
    }
    condicoes.push(
      ...condicoesDoPeriodo('criado_em', lerPeriodo(filtro.de, filtro.ate)),
    );
    if (filtro.usuarioId) {
      condicoes.push(Prisma.sql`usuario_id = ${filtro.usuarioId}::uuid`);
    }
    if (filtro.acao && filtro.acao.length > 0) {
      condicoes.push(Prisma.sql`acao IN (${Prisma.join(filtro.acao)})`);
    }
    if (filtro.incluirRelacionados) {
      if (!filtro.entidade || !filtro.entidadeId) {
        throw new DadosInvalidosException(
          'Use incluirRelacionados junto com entidade e entidadeId.',
          {
            campos: [
              {
                campo: 'incluirRelacionados',
                mensagens: ['exige entidade e entidadeId'],
              },
            ],
          },
        );
      }
      // O índice GIN de `relacionados` atende; a própria entidade também está lá.
      const referencia = referenciaDeAuditoria(
        filtro.entidade,
        filtro.entidadeId,
      );
      condicoes.push(Prisma.sql`relacionados @> ARRAY[${referencia}]::text[]`);
    } else {
      if (filtro.entidade) {
        condicoes.push(Prisma.sql`entidade = ${filtro.entidade}`);
      }
      if (filtro.entidadeId) {
        condicoes.push(Prisma.sql`entidade_id = ${filtro.entidadeId}`);
      }
    }
    if (filtro.tipoAtor && filtro.tipoAtor.length > 0) {
      const tipos = filtro.tipoAtor.map(
        (tipo) => Prisma.sql`${tipo}::tipo_ator`,
      );
      condicoes.push(Prisma.sql`tipo_ator IN (${Prisma.join(tipos)})`);
    }
    if (filtro.requisicaoId) {
      condicoes.push(Prisma.sql`requisicao_id = ${filtro.requisicaoId}`);
    }
    condicoes.push(
      ...condicoesDeBusca(COLUNAS_DA_BUSCA, termosDaBusca(filtro.texto)),
    );
    return condicoes;
  }

  /**
   * Valores distintos de uma coluna indexada, em ordem alfabética, saltando
   * pelo índice (um passo por valor) em vez de ler a tabela inteira — a
   * auditoria só cresce.
   */
  private async valoresDistintos(
    coluna: 'acao' | 'entidade',
  ): Promise<string[]> {
    const nome = Prisma.raw(coluna);
    const linhas = await this.prisma.$queryRaw<{ valor: string }[]>`
      WITH RECURSIVE distintos(valor) AS (
        SELECT min(${nome}) FROM eventos_auditoria
        UNION ALL
        SELECT (SELECT min(e.${nome}) FROM eventos_auditoria e WHERE e.${nome} > d.valor)
          FROM distintos d
         WHERE d.valor IS NOT NULL
      )
      SELECT valor FROM distintos WHERE valor IS NOT NULL ORDER BY valor`;
    return linhas.map(({ valor }) => valor);
  }
}
