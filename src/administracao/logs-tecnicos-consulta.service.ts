import { Injectable } from '@nestjs/common';
import {
  clausulaWhere,
  condicoesDeBusca,
  condicoesDoPeriodo,
  escaparLike,
  lerCursor,
  lerPeriodo,
  montarPaginaPorCursor,
  termosDaBusca,
} from '../auditoria/consulta/consulta-comum';
import { NaoEncontradoException } from '../comum/erros/excecoes';
import type { PaginaPorCursor } from '../comum/paginacao/paginacao';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  type FiltroLogsTecnicosDto,
  type LinhaLogTecnico,
  LogTecnicoDetalheDto,
  LogTecnicoDto,
} from './administracao.dto';

/** Colunas em que a busca por texto procura. */
const COLUNAS_DA_BUSCA = ['mensagem', 'contexto', 'rota'] as const;

/**
 * Consulta dos logs técnicos gravados no banco (R3.6: erros 5xx, avisos e
 * falhas de jobs), só para o Admin: filtros por nível, período, origem,
 * usuário, id da requisição e texto, com paginação por cursor.
 */
@Injectable()
export class LogsTecnicosConsultaService {
  constructor(private readonly prisma: PrismaService) {}

  async listar(
    filtro: FiltroLogsTecnicosDto,
  ): Promise<PaginaPorCursor<LogTecnicoDto>> {
    const linhas = await this.prisma.$queryRaw<LinhaLogTecnico[]>`
      SELECT id, criado_em, nivel::text AS nivel, contexto, mensagem,
             requisicao_id, usuario_id::text AS usuario_id, metodo, rota,
             status, duracao_ms
        FROM logs_tecnicos
        ${clausulaWhere(this.condicoes(filtro))}
       ORDER BY id DESC
       LIMIT ${filtro.limite + 1}`;
    return montarPaginaPorCursor('logs', linhas, filtro.limite, (linha) =>
      LogTecnicoDto.daLinha(linha),
    );
  }

  async detalhar(id: bigint): Promise<LogTecnicoDetalheDto> {
    const log = await this.prisma.logTecnico.findUnique({ where: { id } });
    if (!log) {
      throw new NaoEncontradoException('Log técnico não encontrado.');
    }
    return LogTecnicoDetalheDto.detalhe(log);
  }

  private condicoes(filtro: FiltroLogsTecnicosDto): Prisma.Sql[] {
    const condicoes: Prisma.Sql[] = [];
    const cursor = lerCursor('logs', filtro.cursor);
    if (cursor !== undefined) {
      condicoes.push(Prisma.sql`id < ${cursor}`);
    }
    condicoes.push(
      ...condicoesDoPeriodo('criado_em', lerPeriodo(filtro.de, filtro.ate)),
    );
    if (filtro.nivel && filtro.nivel.length > 0) {
      const niveis = filtro.nivel.map(
        (nivel) => Prisma.sql`${nivel}::nivel_log`,
      );
      condicoes.push(Prisma.sql`nivel IN (${Prisma.join(niveis)})`);
    }
    if (filtro.contexto) {
      condicoes.push(
        Prisma.sql`contexto ILIKE ${`${escaparLike(filtro.contexto)}%`}`,
      );
    }
    if (filtro.usuarioId) {
      condicoes.push(Prisma.sql`usuario_id = ${filtro.usuarioId}::uuid`);
    }
    if (filtro.requisicaoId) {
      condicoes.push(Prisma.sql`requisicao_id = ${filtro.requisicaoId}`);
    }
    condicoes.push(
      ...condicoesDeBusca(COLUNAS_DA_BUSCA, termosDaBusca(filtro.texto)),
    );
    return condicoes;
  }
}
