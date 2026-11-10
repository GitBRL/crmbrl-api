import { Injectable } from '@nestjs/common';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import { ehDiretoria, ehLider, setorDaPessoa } from '../comum/dominio/papeis';
import {
  DadosInvalidosException,
  SemPermissaoException,
} from '../comum/erros/excecoes';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { REGRA_ATENDIMENTO } from './atendimento.constantes';
import {
  type Campos,
  PessoaDto,
  ResumoCanalDto,
  ResumoFilaDto,
} from './dto/comum.dto';
import type {
  CumprimentoDoSlaDto,
  FiltroMetricasDoAtendimentoDto,
  IndicadoresDaPessoaDto,
  IndicadoresDoAtendimentoDto,
  MetricasDoAtendimentoDto,
  SatisfacaoMetricasDto,
  SituacaoAtualDto,
  TemposDto,
} from './dto/metricas.dto';
import type { Area } from '../comum/dominio/setores';
import { setorUsaAtendimento } from './visibilidade';

const DIA_MS = 24 * 60 * 60 * 1000;
/** Período padrão: os últimos 30 dias. */
const PERIODO_PADRAO_MS = 30 * DIA_MS;
/** Período máximo de uma consulta. */
const PERIODO_MAXIMO_MS = 366 * DIA_MS;

type Recorte = 'geral' | 'fila' | 'canal';

/** `NULL` agrupa tudo numa linha só (o geral). */
const CHAVE: Readonly<Record<Recorte, Prisma.Sql>> = {
  geral: Prisma.sql`NULL::uuid`,
  fila: Prisma.sql`c.fila_id`,
  canal: Prisma.sql`c.canal_id`,
};

interface LinhaNovas {
  chave: string | null;
  conversas: number;
  respondidas: number;
  media: number | null;
  mediana: number | null;
  com_prazo: number;
  cumpridos: number;
  estourados: number;
}

interface LinhaResolvidas {
  chave: string | null;
  resolvidas: number;
  reabertas: number;
  media: number | null;
  mediana: number | null;
  com_prazo: number;
  cumpridos: number;
}

interface LinhaSatisfacao {
  chave: string | null;
  solicitadas: number;
  respondidas: number;
  media: number | null;
  n1: number;
  n2: number;
  n3: number;
  n4: number;
  n5: number;
}

interface LinhaContagem {
  chave: string | null;
  total: number;
}

interface LinhaAgora {
  chave: string | null;
  em_aberto: number;
  sem_responsavel: number;
  aguardando: number;
  sla_estourado: number;
  maior_espera: number | null;
}

interface LinhaTempos {
  chave: string | null;
  total: number;
  media: number | null;
  mediana: number | null;
}

interface LinhaResolvidasDaPessoa extends LinhaTempos {
  com_prazo: number;
  cumpridos: number;
}

interface Filtros {
  de: Date;
  ate: Date;
  /** `AND …` com os filtros de área, fila e canal (sobre `c` e `f`). */
  sql: Prisma.Sql;
}

/**
 * Métricas do Atendimento para o BI (R12, Fase 3): conversas novas, tempo
 * até a primeira resposta, resolução, cumprimento do SLA, satisfação (CSAT) e
 * mensagens enviadas — no geral, por fila, por canal e por pessoa —, mais a
 * situação de agora (em aberto, sem responsável, esperando, SLA estourado).
 *
 * Quem vê: Admin e C-level (tudo); o líder, só a área dele.
 */
@Injectable()
export class MetricasDoAtendimentoService {
  constructor(private readonly prisma: PrismaService) {}

  async calcular(
    usuario: UsuarioAutenticado,
    filtro: FiltroMetricasDoAtendimentoDto,
  ): Promise<MetricasDoAtendimentoDto> {
    const area = this.areaPermitida(usuario, filtro.area ?? null);
    const ate = filtro.ate ? new Date(filtro.ate) : new Date();
    const de = filtro.de
      ? new Date(filtro.de)
      : new Date(ate.getTime() - PERIODO_PADRAO_MS);
    if (de >= ate) {
      throw new DadosInvalidosException('O início precisa ser antes do fim.', {
        campos: [{ campo: 'de', mensagens: ['deve ser antes de "ate"'] }],
      });
    }
    if (ate.getTime() - de.getTime() > PERIODO_MAXIMO_MS) {
      throw new DadosInvalidosException('O período pode ter no máximo 1 ano.', {
        campos: [{ campo: 'de', mensagens: ['período maior que 1 ano'] }],
      });
    }
    const condicoes: Prisma.Sql[] = [];
    if (area) {
      condicoes.push(Prisma.sql`f.area = ${area}`);
    }
    if (filtro.filaId) {
      condicoes.push(Prisma.sql`c.fila_id = ${filtro.filaId}::uuid`);
    }
    if (filtro.canalId) {
      condicoes.push(Prisma.sql`c.canal_id = ${filtro.canalId}::uuid`);
    }
    const filtros: Filtros = {
      de,
      ate,
      sql:
        condicoes.length > 0
          ? Prisma.sql`AND ${Prisma.join(condicoes, ' AND ')}`
          : Prisma.empty,
    };

    const [geral, porFila, porCanal, agoraGeral, agoraPorFila, porPessoa] =
      await Promise.all([
        this.indicadores('geral', filtros),
        this.indicadores('fila', filtros),
        this.indicadores('canal', filtros),
        this.agora('geral', filtros),
        this.agora('fila', filtros),
        this.porPessoa(filtros),
      ]);

    const filaIds = [
      ...new Set([...porFila.keys(), ...agoraPorFila.keys()]),
    ].filter((id): id is string => id !== null);
    const canalIds = [...porCanal.keys()].filter(
      (id): id is string => id !== null,
    );
    const [filas, canais] = await Promise.all([
      this.prisma.filaAtendimento.findMany({
        where: { id: { in: filaIds } },
        select: { id: true, nome: true, area: true },
      }),
      this.prisma.canal.findMany({
        where: { id: { in: canalIds } },
        select: { id: true, tipo: true, nome: true, ativo: true },
      }),
    ]);
    const filaPorId = new Map(filas.map((fila) => [fila.id, fila]));
    const canalPorId = new Map(canais.map((canal) => [canal.id, canal]));
    const chavesDeFila = [
      ...new Set([...porFila.keys(), ...agoraPorFila.keys()]),
    ];

    return {
      periodo: { de: de.toISOString(), ate: ate.toISOString() },
      geral: geral.get(null) ?? indicadoresVazios(),
      agora: agoraGeral.get(null) ?? situacaoVazia(),
      porFila: chavesDeFila
        .map((chave) => ({
          ...(porFila.get(chave) ?? indicadoresVazios()),
          fila: chave
            ? ResumoFilaDto.ouNulo(filaPorId.get(chave) ?? null)
            : null,
          agora: agoraPorFila.get(chave) ?? situacaoVazia(),
        }))
        // As conversas sem fila vêm por último.
        .sort((a, b) =>
          a.fila && b.fila
            ? a.fila.nome.localeCompare(b.fila.nome, 'pt-BR')
            : Number(a.fila === null) - Number(b.fila === null),
        ),
      porCanal: canalIds
        .filter((id) => canalPorId.has(id))
        .map((id) => ({
          ...(porCanal.get(id) ?? indicadoresVazios()),
          canal: ResumoCanalDto.de(canalPorId.get(id)!),
        }))
        .sort((a, b) => a.canal.nome.localeCompare(b.canal.nome, 'pt-BR')),
      porPessoa,
    };
  }

  /** Admin/C-level: o setor pedido (ou todos); líder: o dele; os demais: 403. */
  private areaPermitida(
    usuario: UsuarioAutenticado,
    pedida: Area | null,
  ): Area | null {
    if (ehDiretoria(usuario.papel)) {
      return pedida;
    }
    const area = setorDaPessoa(usuario);
    if (ehLider(usuario.papel) && area && setorUsaAtendimento(area)) {
      return area;
    }
    throw new SemPermissaoException(
      'As métricas do Atendimento são para Admin, C-level e os líderes das áreas que atendem.',
      { regra: REGRA_ATENDIMENTO },
    );
  }

  // -------------------------------------------------------------------------
  // Recortes
  // -------------------------------------------------------------------------

  private async indicadores(
    recorte: Recorte,
    filtros: Filtros,
  ): Promise<Map<string | null, Campos<IndicadoresDoAtendimentoDto>>> {
    const chave = CHAVE[recorte];
    const { de, ate, sql } = filtros;
    const [novas, resolvidas, satisfacao, mensagens] = await Promise.all([
      this.prisma.$queryRaw<LinhaNovas[]>(Prisma.sql`
        SELECT ${chave} AS chave,
          count(*)::int AS conversas,
          count(c.primeira_resposta_em)::int AS respondidas,
          avg(extract(epoch FROM c.primeira_resposta_em - c.criado_em))::float AS media,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM c.primeira_resposta_em - c.criado_em))::float AS mediana,
          count(c.sla_primeira_resposta_ate)::int AS com_prazo,
          (count(*) FILTER (WHERE c.sla_primeira_resposta_ate IS NOT NULL AND c.primeira_resposta_em IS NOT NULL AND c.primeira_resposta_em <= c.sla_primeira_resposta_ate))::int AS cumpridos,
          (count(*) FILTER (WHERE c.sla_primeira_resposta_ate IS NOT NULL AND (
            (c.primeira_resposta_em IS NOT NULL AND c.primeira_resposta_em > c.sla_primeira_resposta_ate)
            OR (c.primeira_resposta_em IS NULL AND c.sla_primeira_resposta_ate <= now()))))::int AS estourados
        FROM conversas c LEFT JOIN filas_atendimento f ON f.id = c.fila_id
        WHERE c.criado_em >= ${de} AND c.criado_em < ${ate} ${sql}
        GROUP BY 1`),
      this.prisma.$queryRaw<LinhaResolvidas[]>(Prisma.sql`
        SELECT ${chave} AS chave,
          count(*)::int AS resolvidas,
          (count(*) FILTER (WHERE c.reaberturas > 0))::int AS reabertas,
          avg(extract(epoch FROM c.resolvida_em - c.criado_em))::float AS media,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM c.resolvida_em - c.criado_em))::float AS mediana,
          count(c.sla_resolucao_ate)::int AS com_prazo,
          (count(*) FILTER (WHERE c.sla_resolucao_ate IS NOT NULL AND c.resolvida_em <= c.sla_resolucao_ate))::int AS cumpridos
        FROM conversas c LEFT JOIN filas_atendimento f ON f.id = c.fila_id
        WHERE c.status = 'RESOLVIDA' AND c.resolvida_em >= ${de} AND c.resolvida_em < ${ate} ${sql}
        GROUP BY 1`),
      this.prisma.$queryRaw<LinhaSatisfacao[]>(Prisma.sql`
        SELECT ${chave} AS chave, ${colunasDeSatisfacao(de, ate)}
        FROM conversas c LEFT JOIN filas_atendimento f ON f.id = c.fila_id
        WHERE ((c.satisfacao_solicitada_em >= ${de} AND c.satisfacao_solicitada_em < ${ate})
          OR (c.satisfacao_respondida_em >= ${de} AND c.satisfacao_respondida_em < ${ate})) ${sql}
        GROUP BY 1`),
      this.prisma.$queryRaw<LinhaContagem[]>(Prisma.sql`
        SELECT ${chave} AS chave, count(*)::int AS total
        FROM mensagens m
          JOIN conversas c ON c.id = m.conversa_id
          LEFT JOIN filas_atendimento f ON f.id = c.fila_id
        WHERE m.direcao = 'SAIDA' AND m.autor_id IS NOT NULL
          AND m.ocorrida_em >= ${de} AND m.ocorrida_em < ${ate} ${sql}
        GROUP BY 1`),
    ]);
    const resultado = new Map<
      string | null,
      Campos<IndicadoresDoAtendimentoDto>
    >();
    const obter = (
      chaveDaLinha: string | null,
    ): Campos<IndicadoresDoAtendimentoDto> => {
      let item = resultado.get(chaveDaLinha);
      if (!item) {
        item = indicadoresVazios();
        resultado.set(chaveDaLinha, item);
      }
      return item;
    };
    for (const linha of novas) {
      const item = obter(linha.chave);
      item.conversas = linha.conversas;
      item.respondidas = linha.respondidas;
      item.primeiraResposta = tempos(linha.media, linha.mediana);
      item.slaPrimeiraResposta = cumprimento(
        linha.com_prazo,
        linha.cumpridos,
        linha.estourados,
      );
    }
    for (const linha of resolvidas) {
      const item = obter(linha.chave);
      item.resolvidas = linha.resolvidas;
      item.reabertas = linha.reabertas;
      item.resolucao = tempos(linha.media, linha.mediana);
      item.slaResolucao = cumprimento(
        linha.com_prazo,
        linha.cumpridos,
        linha.com_prazo - linha.cumpridos,
      );
    }
    for (const linha of satisfacao) {
      obter(linha.chave).satisfacao = satisfacaoDe(linha);
    }
    for (const linha of mensagens) {
      obter(linha.chave).mensagensEnviadas = linha.total;
    }
    return resultado;
  }

  private async agora(
    recorte: Recorte,
    filtros: Filtros,
  ): Promise<Map<string | null, SituacaoAtualDto>> {
    const linhas = await this.prisma.$queryRaw<LinhaAgora[]>(Prisma.sql`
      SELECT ${CHAVE[recorte]} AS chave,
        count(*)::int AS em_aberto,
        (count(*) FILTER (WHERE c.responsavel_id IS NULL))::int AS sem_responsavel,
        (count(*) FILTER (WHERE c.aguardando_desde IS NOT NULL))::int AS aguardando,
        (count(*) FILTER (WHERE (c.primeira_resposta_em IS NULL AND c.sla_primeira_resposta_ate <= now())
          OR c.sla_resolucao_ate <= now()))::int AS sla_estourado,
        max(extract(epoch FROM now() - c.aguardando_desde))::float AS maior_espera
      FROM conversas c LEFT JOIN filas_atendimento f ON f.id = c.fila_id
      WHERE c.status <> 'RESOLVIDA' ${filtros.sql}
      GROUP BY 1`);
    return new Map(
      linhas.map((linha) => [
        linha.chave,
        {
          emAberto: linha.em_aberto,
          semResponsavel: linha.sem_responsavel,
          aguardandoResposta: linha.aguardando,
          slaEstourado: linha.sla_estourado,
          maiorEsperaSegundos:
            linha.maior_espera === null ? null : Math.round(linha.maior_espera),
        },
      ]),
    );
  }

  private async porPessoa(filtros: Filtros): Promise<IndicadoresDaPessoaDto[]> {
    const { de, ate, sql } = filtros;
    const [recebidas, primeiras, resolvidas, satisfacao, mensagens, emAberto] =
      await Promise.all([
        this.prisma.$queryRaw<LinhaContagem[]>(Prisma.sql`
          SELECT a.para_usuario_id AS chave, count(DISTINCT a.conversa_id)::int AS total
          FROM conversa_atribuicoes a
            JOIN conversas c ON c.id = a.conversa_id
            LEFT JOIN filas_atendimento f ON f.id = c.fila_id
          WHERE a.para_usuario_id IS NOT NULL AND a.criado_em >= ${de} AND a.criado_em < ${ate} ${sql}
          GROUP BY 1`),
        this.prisma.$queryRaw<LinhaTempos[]>(Prisma.sql`
          WITH primeiras AS (
            SELECT DISTINCT ON (c.id) c.id, m.autor_id,
              extract(epoch FROM c.primeira_resposta_em - c.criado_em) AS segundos
            FROM conversas c
              JOIN mensagens m ON m.conversa_id = c.id AND m.direcao = 'SAIDA'
                AND m.autor_id IS NOT NULL AND m.ocorrida_em = c.primeira_resposta_em
              LEFT JOIN filas_atendimento f ON f.id = c.fila_id
            WHERE c.primeira_resposta_em >= ${de} AND c.primeira_resposta_em < ${ate} ${sql}
            ORDER BY c.id, m.id
          )
          SELECT autor_id AS chave, count(*)::int AS total,
            avg(segundos)::float AS media,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY segundos)::float AS mediana
          FROM primeiras GROUP BY 1`),
        this.prisma.$queryRaw<LinhaResolvidasDaPessoa[]>(Prisma.sql`
          SELECT c.resolvida_por_id AS chave, count(*)::int AS total,
            avg(extract(epoch FROM c.resolvida_em - c.criado_em))::float AS media,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM c.resolvida_em - c.criado_em))::float AS mediana,
            count(c.sla_resolucao_ate)::int AS com_prazo,
            (count(*) FILTER (WHERE c.sla_resolucao_ate IS NOT NULL AND c.resolvida_em <= c.sla_resolucao_ate))::int AS cumpridos
          FROM conversas c LEFT JOIN filas_atendimento f ON f.id = c.fila_id
          WHERE c.status = 'RESOLVIDA' AND c.resolvida_por_id IS NOT NULL
            AND c.resolvida_em >= ${de} AND c.resolvida_em < ${ate} ${sql}
          GROUP BY 1`),
        this.prisma.$queryRaw<LinhaSatisfacao[]>(Prisma.sql`
          SELECT c.resolvida_por_id AS chave, ${colunasDeSatisfacao(de, ate)}
          FROM conversas c LEFT JOIN filas_atendimento f ON f.id = c.fila_id
          WHERE c.resolvida_por_id IS NOT NULL
            AND ((c.satisfacao_solicitada_em >= ${de} AND c.satisfacao_solicitada_em < ${ate})
              OR (c.satisfacao_respondida_em >= ${de} AND c.satisfacao_respondida_em < ${ate})) ${sql}
          GROUP BY 1`),
        this.prisma.$queryRaw<LinhaContagem[]>(Prisma.sql`
          SELECT m.autor_id AS chave, count(*)::int AS total
          FROM mensagens m
            JOIN conversas c ON c.id = m.conversa_id
            LEFT JOIN filas_atendimento f ON f.id = c.fila_id
          WHERE m.direcao = 'SAIDA' AND m.autor_id IS NOT NULL
            AND m.ocorrida_em >= ${de} AND m.ocorrida_em < ${ate} ${sql}
          GROUP BY 1`),
        this.prisma.$queryRaw<LinhaContagem[]>(Prisma.sql`
          SELECT c.responsavel_id AS chave, count(*)::int AS total
          FROM conversas c LEFT JOIN filas_atendimento f ON f.id = c.fila_id
          WHERE c.status <> 'RESOLVIDA' AND c.responsavel_id IS NOT NULL ${sql}
          GROUP BY 1`),
      ]);
    const ids = new Set<string>();
    for (const linhas of [
      recebidas,
      primeiras,
      resolvidas,
      satisfacao,
      mensagens,
      emAberto,
    ]) {
      for (const linha of linhas) {
        if (linha.chave) {
          ids.add(linha.chave);
        }
      }
    }
    if (ids.size === 0) {
      return [];
    }
    const pessoas = await this.prisma.usuario.findMany({
      where: { id: { in: [...ids] } },
      select: { id: true, nome: true, avatarUrl: true },
      orderBy: [{ nome: 'asc' }, { id: 'asc' }],
    });
    const indice = <T extends { chave: string | null }>(linhas: T[]) =>
      new Map(linhas.map((linha) => [linha.chave, linha]));
    const porRecebidas = indice(recebidas);
    const porPrimeiras = indice(primeiras);
    const porResolvidas = indice(resolvidas);
    const porSatisfacao = indice(satisfacao);
    const porMensagens = indice(mensagens);
    const porEmAberto = indice(emAberto);
    return pessoas.map((pessoa) => {
      const primeira = porPrimeiras.get(pessoa.id);
      const resolvida = porResolvidas.get(pessoa.id);
      const nota = porSatisfacao.get(pessoa.id);
      return {
        pessoa: PessoaDto.de(pessoa),
        recebidas: porRecebidas.get(pessoa.id)?.total ?? 0,
        primeirasRespostas: primeira?.total ?? 0,
        primeiraResposta: tempos(
          primeira?.media ?? null,
          primeira?.mediana ?? null,
        ),
        resolvidas: resolvida?.total ?? 0,
        resolucao: tempos(resolvida?.media ?? null, resolvida?.mediana ?? null),
        slaResolucao: cumprimento(
          resolvida?.com_prazo ?? 0,
          resolvida?.cumpridos ?? 0,
          (resolvida?.com_prazo ?? 0) - (resolvida?.cumpridos ?? 0),
        ),
        satisfacao: nota ? satisfacaoDe(nota) : satisfacaoVazia(),
        mensagensEnviadas: porMensagens.get(pessoa.id)?.total ?? 0,
        emAberto: porEmAberto.get(pessoa.id)?.total ?? 0,
      };
    });
  }
}

/** Colunas da satisfação: pedidas e respondidas no período, média e distribuição das notas. */
function colunasDeSatisfacao(de: Date, ate: Date): Prisma.Sql {
  const respondida = Prisma.sql`c.satisfacao_respondida_em >= ${de} AND c.satisfacao_respondida_em < ${ate}`;
  return Prisma.sql`
    (count(*) FILTER (WHERE c.satisfacao_solicitada_em >= ${de} AND c.satisfacao_solicitada_em < ${ate}))::int AS solicitadas,
    (count(*) FILTER (WHERE ${respondida} AND c.satisfacao_nota IS NOT NULL))::int AS respondidas,
    (avg(c.satisfacao_nota) FILTER (WHERE ${respondida}))::float AS media,
    (count(*) FILTER (WHERE ${respondida} AND c.satisfacao_nota = 1))::int AS n1,
    (count(*) FILTER (WHERE ${respondida} AND c.satisfacao_nota = 2))::int AS n2,
    (count(*) FILTER (WHERE ${respondida} AND c.satisfacao_nota = 3))::int AS n3,
    (count(*) FILTER (WHERE ${respondida} AND c.satisfacao_nota = 4))::int AS n4,
    (count(*) FILTER (WHERE ${respondida} AND c.satisfacao_nota = 5))::int AS n5`;
}

function arredondar(valor: number | null, casas = 0): number | null {
  if (valor === null || Number.isNaN(valor)) {
    return null;
  }
  const fator = 10 ** casas;
  return Math.round(valor * fator) / fator;
}

function tempos(media: number | null, mediana: number | null): TemposDto {
  return {
    mediaSegundos: arredondar(media),
    medianaSegundos: arredondar(mediana),
  };
}

function cumprimento(
  comPrazo: number,
  cumpridos: number,
  estourados: number,
): CumprimentoDoSlaDto {
  const avaliados = cumpridos + estourados;
  return {
    comPrazo,
    cumpridos,
    estourados,
    percentualCumprido:
      avaliados > 0 ? arredondar((cumpridos / avaliados) * 100, 1) : null,
  };
}

function satisfacaoDe(linha: LinhaSatisfacao): SatisfacaoMetricasDto {
  const distribuicao = [linha.n1, linha.n2, linha.n3, linha.n4, linha.n5];
  return {
    solicitadas: linha.solicitadas,
    respondidas: linha.respondidas,
    media: arredondar(linha.media, 2),
    distribuicao,
    csat:
      linha.respondidas > 0
        ? arredondar(((linha.n4 + linha.n5) / linha.respondidas) * 100, 1)
        : null,
  };
}

function satisfacaoVazia(): SatisfacaoMetricasDto {
  return {
    solicitadas: 0,
    respondidas: 0,
    media: null,
    distribuicao: [0, 0, 0, 0, 0],
    csat: null,
  };
}

function indicadoresVazios(): Campos<IndicadoresDoAtendimentoDto> {
  return {
    conversas: 0,
    respondidas: 0,
    primeiraResposta: tempos(null, null),
    resolvidas: 0,
    reabertas: 0,
    resolucao: tempos(null, null),
    slaPrimeiraResposta: cumprimento(0, 0, 0),
    slaResolucao: cumprimento(0, 0, 0),
    satisfacao: satisfacaoVazia(),
    mensagensEnviadas: 0,
  };
}

function situacaoVazia(): SituacaoAtualDto {
  return {
    emAberto: 0,
    semResponsavel: 0,
    aguardandoResposta: 0,
    slaEstourado: 0,
    maiorEsperaSegundos: null,
  };
}
