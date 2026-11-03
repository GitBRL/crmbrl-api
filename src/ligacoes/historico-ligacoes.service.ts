import { Injectable } from '@nestjs/common';
import { exigirAtendimento } from '../atendimento/conversas.service';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { INCLUIR_LIGACAO, paraLigacaoDto } from './ligacao-dto';
import type {
  FiltroDeLigacoesDto,
  LigacaoDoHistoricoDto,
  ListaDeLigacoesDto,
  TrechoEncontradoDto,
} from './ligacoes.dto';
import { sqlLigacoesVisiveis } from '../bi/escopo-bi';
import { filtroDeLigacoesVisiveis } from './visibilidade-ligacoes';

/** Máximo de ligações que a busca no texto considera (as mais recentes que casam). */
export const LIMITE_DA_BUSCA = 5_000;
const TRECHOS_POR_LIGACAO = 3;

const ACENTUADAS = 'áàâãäéèêëíìîïóòôõöúùûüçñÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑ';
const SEM_ACENTO = 'aaaaaeeeeiiiiooooouuuucnAAAAAEEEEIIIIOOOOOUUUUCN';

/** A busca no mesmo molde do gatilho do banco (sem acento, tsvector `portuguese`, `websearch`). */
function consultaDeBusca(texto: string): Prisma.Sql {
  return Prisma.sql`websearch_to_tsquery('portuguese', translate(${texto}, ${ACENTUADAS}, ${SEM_ACENTO}))`;
}

interface TrechoGravado {
  falante?: string;
  inicio?: number;
  texto?: string;
}

/**
 * Histórico de ligações (R29.8, R30.8): lista com filtros (período, direção, situação,
 * atendente, fila, canal, contato) e busca full text no texto das transcrições. Só entra o
 * que o usuário pode ver (R12): o atendente, quem foi chamado a atender e quem vê a conversa.
 * Ordem: da mais recente para a mais antiga, com paginação por cursor.
 */
@Injectable()
export class HistoricoDeLigacoesService {
  constructor(private readonly prisma: PrismaService) {}

  async listar(
    usuario: UsuarioAutenticado,
    filtro: FiltroDeLigacoesDto,
  ): Promise<ListaDeLigacoesDto> {
    exigirAtendimento(usuario);
    const limite = filtro.limite ?? 20;
    const de = filtro.de ? new Date(filtro.de) : null;
    const ate = filtro.ate ? new Date(filtro.ate) : null;
    const condicoes: Prisma.LigacaoWhereInput[] = [
      filtroDeLigacoesVisiveis(usuario),
    ];
    if (filtro.contatoId) condicoes.push({ contatoId: filtro.contatoId });
    if (filtro.conversaId) condicoes.push({ conversaId: filtro.conversaId });
    if (filtro.direcao) condicoes.push({ direcao: filtro.direcao });
    if (filtro.situacao?.length) {
      condicoes.push({ estado: { in: filtro.situacao } });
    }
    if (filtro.atendenteId) {
      condicoes.push({
        atendenteId:
          filtro.atendenteId.toLowerCase() === 'sem'
            ? null
            : filtro.atendenteId,
      });
    }
    if (filtro.canalId) condicoes.push({ canalId: filtro.canalId });
    if (filtro.filaId) condicoes.push({ conversa: { filaId: filtro.filaId } });
    if (de || ate) {
      condicoes.push({
        iniciadaEm: { ...(de ? { gte: de } : {}), ...(ate ? { lt: ate } : {}) },
      });
    }
    const busca = filtro.busca?.trim();
    if (busca) {
      const ids = await this.idsQueCasam(usuario, busca, filtro, de, ate);
      condicoes.push({ id: { in: ids } });
    }
    const onde: Prisma.LigacaoWhereInput = { AND: condicoes };
    const cursor = filtro.cursor ? decodificarCursor(filtro.cursor) : null;
    const [itens, total] = await Promise.all([
      this.prisma.ligacao.findMany({
        where: onde,
        include: INCLUIR_LIGACAO,
        orderBy: [{ iniciadaEm: 'desc' }, { id: 'desc' }],
        take: limite + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      }),
      this.prisma.ligacao.count({ where: onde }),
    ]);
    const haMais = itens.length > limite;
    const pagina = haMais ? itens.slice(0, limite) : itens;
    const trechos = busca
      ? await this.trechosQueCasam(
          busca,
          pagina.map((item) => item.id),
        )
      : new Map<string, TrechoEncontradoDto[]>();
    return {
      itens: pagina.map((item): LigacaoDoHistoricoDto => ({
        ...paraLigacaoDto(item, usuario.id, usuario.papel),
        trechosEncontrados: trechos.get(item.id) ?? [],
      })),
      proximoCursor:
        haMais && pagina.length > 0
          ? codificarCursor(pagina[pagina.length - 1].id)
          : null,
      total,
    };
  }

  /**
   * Ids das ligações (as mais recentes) cuja transcrição casa com a busca. A visibilidade e os
   * filtros entram aqui, antes do `LIMIT`: senão as 5 000 mais recentes de todos os usuários
   * escondem as mais antigas de quem busca.
   */
  private async idsQueCasam(
    usuario: UsuarioAutenticado,
    busca: string,
    filtro: FiltroDeLigacoesDto,
    de: Date | null,
    ate: Date | null,
  ): Promise<string[]> {
    const e = (condicao: Prisma.Sql | false | 0 | '' | undefined | null) =>
      condicao ? Prisma.sql`AND ${condicao}` : Prisma.empty;
    const linhas = await this.prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT l.id
        FROM ligacoes l
        LEFT JOIN conversas c ON c.id = l.conversa_id
        LEFT JOIN filas_atendimento f ON f.id = c.fila_id
       WHERE l.transcricao_busca @@ ${consultaDeBusca(busca)}
         AND ${sqlLigacoesVisiveis(usuario)}
         ${e(filtro.contatoId && Prisma.sql`l.contato_id = ${filtro.contatoId}::uuid`)}
         ${e(filtro.conversaId && Prisma.sql`l.conversa_id = ${filtro.conversaId}::uuid`)}
         ${e(filtro.direcao && Prisma.sql`l.direcao = ${filtro.direcao}::direcao_ligacao`)}
         ${e(filtro.situacao?.length && Prisma.sql`l.estado = ANY(${filtro.situacao}::estado_ligacao[])`)}
         ${e(
           filtro.atendenteId &&
             (filtro.atendenteId.toLowerCase() === 'sem'
               ? Prisma.sql`l.atendente_id IS NULL`
               : Prisma.sql`l.atendente_id = ${filtro.atendenteId}::uuid`),
         )}
         ${e(filtro.canalId && Prisma.sql`l.canal_id = ${filtro.canalId}::uuid`)}
         ${e(filtro.filaId && Prisma.sql`c.fila_id = ${filtro.filaId}::uuid`)}
         ${de ? Prisma.sql`AND l.iniciada_em >= ${de}` : Prisma.empty}
         ${ate ? Prisma.sql`AND l.iniciada_em < ${ate}` : Prisma.empty}
       ORDER BY l.iniciada_em DESC
       LIMIT ${LIMITE_DA_BUSCA}`);
    return linhas.map((linha) => linha.id);
  }

  /** Os trechos (falas) de cada ligação que casam com a busca, para o clique tocar naquele ponto. */
  private async trechosQueCasam(
    busca: string,
    ids: string[],
  ): Promise<Map<string, TrechoEncontradoDto[]>> {
    const resultado = new Map<string, TrechoEncontradoDto[]>();
    if (ids.length === 0) return resultado;
    const linhas = await this.prisma.$queryRaw<
      { id: string; trecho: TrechoGravado }[]
    >(Prisma.sql`
      SELECT l.id, t.valor AS trecho
        FROM ligacoes l
        CROSS JOIN LATERAL jsonb_array_elements(l.transcricao->'trechos') WITH ORDINALITY AS t(valor, ordem)
       WHERE l.id = ANY(${ids}::uuid[])
         AND to_tsvector('portuguese', translate(t.valor->>'texto', ${ACENTUADAS}, ${SEM_ACENTO}))
             @@ ${consultaDeBusca(busca)}
       ORDER BY l.id, t.ordem`);
    for (const { id, trecho } of linhas) {
      const lista = resultado.get(id) ?? [];
      if (lista.length < TRECHOS_POR_LIGACAO && trecho.texto) {
        lista.push({
          falante: trecho.falante ?? 'participante',
          inicio: Math.max(0, Math.round((trecho.inicio ?? 0) * 10) / 10),
          texto: trecho.texto,
        });
      }
      resultado.set(id, lista);
    }
    return resultado;
  }
}

function codificarCursor(id: string): string {
  return Buffer.from(id, 'utf8').toString('base64url');
}

function decodificarCursor(cursor: string): string | null {
  try {
    const id = Buffer.from(cursor, 'base64url').toString('utf8');
    return /^[0-9a-f-]{36}$/i.test(id) ? id : null;
  } catch {
    return null;
  }
}
