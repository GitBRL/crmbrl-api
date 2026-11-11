import { Injectable } from '@nestjs/common';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { FUSO_DO_BI, LIMITE_DE_LINHAS } from './bi.constantes';
import type { ConteudoDoPainel, FiltroResolvido } from './bi.tipos';
import {
  type DefinicaoDeCartao,
  montarCartoes,
  numero,
  tabela,
  type Valores,
} from './cartoes';
import {
  sqlAtividadesVisiveis,
  sqlNegociosVisiveis,
  sqlPessoas,
  VERDADEIRO,
} from './escopo-bi';
import { diasDoIntervalo, percentual } from './periodo';

const CARTOES: readonly DefinicaoDeCartao[] = [
  {
    chave: 'novos',
    rotulo: 'Negócios novos',
    unidade: 'numero',
    melhorQuando: 'maior',
    dica: 'Negócios criados no período nos funis do Comercial.',
  },
  {
    chave: 'ganhos',
    rotulo: 'Negócios ganhos',
    unidade: 'numero',
    melhorQuando: 'maior',
    dica: 'Negócios que chegaram à etapa de ganho no período.',
  },
  {
    chave: 'valorGanho',
    rotulo: 'Valor ganho',
    unidade: 'moeda',
    melhorQuando: 'maior',
    dica: 'Soma do valor dos negócios ganhos no período.',
  },
  {
    chave: 'perdidos',
    rotulo: 'Negócios perdidos',
    unidade: 'numero',
    melhorQuando: 'menor',
    dica: 'Negócios que chegaram à etapa de perda no período.',
  },
  {
    chave: 'taxaGanho',
    rotulo: 'Taxa de ganho',
    unidade: 'percentual',
    melhorQuando: 'maior',
    dica: 'Ganhos ÷ (ganhos + perdidos) entre os negócios fechados no período.',
  },
  {
    chave: 'cicloMedio',
    rotulo: 'Ciclo médio',
    unidade: 'dias',
    melhorQuando: 'menor',
    dica: 'Dias entre a criação e o ganho, na média dos negócios ganhos no período.',
  },
  {
    chave: 'atividadesFeitas',
    rotulo: 'Atividades feitas',
    unidade: 'numero',
    melhorQuando: 'maior',
    dica: 'Atividades do Comercial concluídas no período (sem notas).',
  },
  {
    chave: 'abertos',
    rotulo: 'Negócios abertos',
    unidade: 'numero',
    melhorQuando: null,
    dica: 'Negócios em etapas abertas agora.',
  },
  {
    chave: 'valorAberto',
    rotulo: 'Valor em aberto',
    unidade: 'moeda',
    melhorQuando: null,
    dica: 'Soma do valor dos negócios abertos agora.',
  },
  {
    chave: 'valorPonderado',
    rotulo: 'Valor ponderado',
    unidade: 'moeda',
    melhorQuando: null,
    dica: 'Valor de cada negócio aberto × probabilidade da etapa (etapa sem probabilidade conta zero).',
  },
  {
    chave: 'atividadesAtrasadas',
    rotulo: 'Atividades atrasadas',
    unidade: 'numero',
    melhorQuando: 'menor',
    dica: 'Atividades do Comercial pendentes com o prazo vencido agora (sem notas).',
  },
];

const DE_AGORA: ReadonlySet<string> = new Set([
  'abertos',
  'valorAberto',
  'valorPonderado',
  'atividadesAtrasadas',
]);

interface LinhaFechamento {
  novos: number;
  ganhos: number;
  valor_ganho: number | null;
  perdidos: number;
  ciclo: number | null;
}
interface LinhaAgora {
  abertos: number;
  valor_aberto: number | null;
  ponderado: number | null;
}

/**
 * Painel Comercial (R20): funil por etapa (quantidade e valor), valor
 * ponderado, taxa de ganho, ciclo médio, motivos de perda, ranking por
 * vendedor e atividades feitas e atrasadas. Visibilidade: negócios como no
 * kanban (R5.9) e atividades como na lista (R6.4).
 */
@Injectable()
export class PainelComercialService {
  constructor(private readonly prisma: PrismaService) {}

  async calcular(
    usuario: UsuarioAutenticado,
    filtro: FiltroResolvido,
  ): Promise<ConteudoDoPainel> {
    const [atual, agora] = await Promise.all([
      this.valoresDoPeriodo(usuario, filtro, filtro.de, filtro.ate),
      this.valoresDeAgora(usuario, filtro),
    ]);
    const anterior =
      filtro.anteriorDe && filtro.anteriorAte
        ? await this.valoresDoPeriodo(
            usuario,
            filtro,
            filtro.anteriorDe,
            filtro.anteriorAte,
          )
        : null;
    const funilBase = await this.funilDaTabela(filtro);
    const [funil, motivos, ranking, evolucao] = await Promise.all([
      this.funil(usuario, filtro, funilBase?.id ?? null),
      this.motivosDePerda(usuario, filtro),
      this.ranking(usuario, filtro),
      this.evolucao(usuario, filtro),
    ]);
    return {
      cartoes: montarCartoes(
        CARTOES,
        { ...atual, ...agora },
        anterior,
        DE_AGORA,
      ),
      tabelas: { funil, motivosDePerda: motivos, ranking, evolucao },
      meta: { funil: funilBase },
    };
  }

  // ---------------------------------------------------------------------
  // Fragmentos
  // ---------------------------------------------------------------------

  /** Negócios `n` de funis `f` do Comercial que o usuário vê, com os filtros. */
  private condicoesDeNegocios(
    usuario: UsuarioAutenticado,
    filtro: FiltroResolvido,
  ): Prisma.Sql {
    return Prisma.sql`f.area = 'COMERCIAL' AND n.excluido_em IS NULL
      AND ${sqlNegociosVisiveis(usuario)}
      AND ${sqlPessoas(Prisma.sql`n.responsavel_id`, filtro.pessoas)}
      AND ${filtro.funilId ? Prisma.sql`n.funil_id = ${filtro.funilId}::uuid` : VERDADEIRO}`;
  }

  /** Atividades `a` (sem notas) de pessoas do Comercial (`r`) que o usuário vê. */
  private condicoesDeAtividades(
    usuario: UsuarioAutenticado,
    filtro: FiltroResolvido,
  ): Prisma.Sql {
    return Prisma.sql`a.tipo <> 'NOTA'::tipo_atividade
      AND r.area = 'COMERCIAL'
      AND ${sqlAtividadesVisiveis(usuario)}
      AND ${sqlPessoas(Prisma.sql`a.responsavel_id`, filtro.pessoas)}`;
  }

  /** Funil da tabela por etapa: o escolhido ou o funil-base do Comercial. */
  private async funilDaTabela(
    filtro: FiltroResolvido,
  ): Promise<{ id: string; nome: string } | null> {
    return this.prisma.funil.findFirst({
      where: filtro.funilId
        ? { id: filtro.funilId }
        : { area: 'COMERCIAL', base: true, excluidoEm: null },
      select: { id: true, nome: true },
    });
  }

  // ---------------------------------------------------------------------
  // Indicadores
  // ---------------------------------------------------------------------

  private async valoresDoPeriodo(
    usuario: UsuarioAutenticado,
    filtro: FiltroResolvido,
    de: Date,
    ate: Date,
  ): Promise<Valores> {
    const [[negocios], [atividades]] = await Promise.all([
      this.prisma.$queryRaw<LinhaFechamento[]>(Prisma.sql`
        SELECT
          (count(*) FILTER (WHERE n.criado_em >= ${de} AND n.criado_em < ${ate}))::int AS novos,
          (count(*) FILTER (WHERE n.status = 'GANHO'::status_negocio AND n.ganho_em >= ${de} AND n.ganho_em < ${ate}))::int AS ganhos,
          (sum(n.valor) FILTER (WHERE n.status = 'GANHO'::status_negocio AND n.ganho_em >= ${de} AND n.ganho_em < ${ate}))::float AS valor_ganho,
          (count(*) FILTER (WHERE n.status = 'PERDIDO'::status_negocio AND n.perdido_em >= ${de} AND n.perdido_em < ${ate}))::int AS perdidos,
          (avg(extract(epoch FROM n.ganho_em - n.criado_em) / 86400.0) FILTER (WHERE n.status = 'GANHO'::status_negocio AND n.ganho_em >= ${de} AND n.ganho_em < ${ate}))::float AS ciclo
        FROM negocios n JOIN funis f ON f.id = n.funil_id
        WHERE ${this.condicoesDeNegocios(usuario, filtro)}`),
      this.prisma.$queryRaw<{ feitas: number }[]>(Prisma.sql`
        SELECT count(*)::int AS feitas
        FROM atividades a JOIN usuarios r ON r.id = a.responsavel_id
        WHERE a.status = 'CONCLUIDA'::status_atividade
          AND a.concluida_em >= ${de} AND a.concluida_em < ${ate}
          AND ${this.condicoesDeAtividades(usuario, filtro)}`),
    ]);
    return {
      novos: negocios.novos,
      ganhos: negocios.ganhos,
      valorGanho: numero(negocios.valor_ganho ?? 0),
      perdidos: negocios.perdidos,
      taxaGanho: percentual(
        negocios.ganhos,
        negocios.ganhos + negocios.perdidos,
      ),
      cicloMedio: numero(negocios.ciclo, 2),
      atividadesFeitas: atividades.feitas,
    };
  }

  private async valoresDeAgora(
    usuario: UsuarioAutenticado,
    filtro: FiltroResolvido,
  ): Promise<Valores> {
    const [[negocios], [atividades]] = await Promise.all([
      this.prisma.$queryRaw<LinhaAgora[]>(Prisma.sql`
        SELECT count(*)::int AS abertos,
          sum(n.valor)::float AS valor_aberto,
          sum(n.valor * coalesce(e.probabilidade, 0) / 100.0)::float AS ponderado
        FROM negocios n JOIN funis f ON f.id = n.funil_id JOIN etapas e ON e.id = n.etapa_id
        WHERE n.status = 'ABERTO'::status_negocio
          AND ${this.condicoesDeNegocios(usuario, filtro)}`),
      this.prisma.$queryRaw<{ atrasadas: number }[]>(Prisma.sql`
        SELECT count(*)::int AS atrasadas
        FROM atividades a JOIN usuarios r ON r.id = a.responsavel_id
        WHERE a.status = 'PENDENTE'::status_atividade AND a.vence_em < now()
          AND ${this.condicoesDeAtividades(usuario, filtro)}`),
    ]);
    return {
      abertos: negocios.abertos,
      valorAberto: numero(negocios.valor_aberto ?? 0),
      valorPonderado: numero(negocios.ponderado ?? 0),
      atividadesAtrasadas: atividades.atrasadas,
    };
  }

  // ---------------------------------------------------------------------
  // Tabelas
  // ---------------------------------------------------------------------

  private async funil(
    usuario: UsuarioAutenticado,
    filtro: FiltroResolvido,
    funilId: string | null,
  ) {
    const linhas = funilId
      ? await this.prisma.$queryRaw<
          {
            etapa_id: string;
            etapa: string;
            ordem: number;
            tipo: string;
            probabilidade: number | null;
            quantidade: number;
            valor: number;
          }[]
        >(Prisma.sql`
          SELECT e.id::text AS etapa_id, e.nome AS etapa, e.ordem, e.tipo::text AS tipo, e.probabilidade,
            count(n.id)::int AS quantidade, coalesce(sum(n.valor), 0)::float AS valor
          FROM etapas e
          LEFT JOIN (
            SELECT n.* FROM negocios n JOIN funis f ON f.id = n.funil_id
            WHERE ${this.condicoesDeNegocios(usuario, filtro)}
          ) n ON n.etapa_id = e.id
          WHERE e.funil_id = ${funilId}::uuid
          GROUP BY e.id ORDER BY e.ordem, e.criado_em`)
      : [];
    return tabela(
      'funil',
      'Funil por etapa',
      'Negócios em cada etapa agora (quantidade e valor); o ponderado só conta etapas abertas, com a probabilidade da etapa.',
      [
        ['etapaId', 'Etapa', 'id'],
        ['etapa', 'Etapa', 'texto'],
        ['tipo', 'Tipo', 'texto'],
        ['probabilidade', 'Probabilidade (%)', 'numero'],
        ['quantidade', 'Negócios', 'numero'],
        ['valor', 'Valor', 'moeda'],
        ['valorPonderado', 'Valor ponderado', 'moeda'],
      ],
      linhas.map((l) => ({
        etapaId: l.etapa_id,
        etapa: l.etapa,
        tipo: l.tipo,
        probabilidade: l.probabilidade,
        quantidade: l.quantidade,
        valor: numero(l.valor) ?? 0,
        valorPonderado:
          l.tipo === 'ABERTA'
            ? (numero((l.valor * (l.probabilidade ?? 0)) / 100) ?? 0)
            : 0,
      })),
    );
  }

  private async motivosDePerda(
    usuario: UsuarioAutenticado,
    filtro: FiltroResolvido,
  ) {
    const linhas = await this.prisma.$queryRaw<
      { motivo: string; perdidos: number; valor: number }[]
    >(Prisma.sql`
      SELECT coalesce(nullif(btrim(n.motivo_perda), ''), '(sem motivo)') AS motivo,
        count(*)::int AS perdidos, coalesce(sum(n.valor), 0)::float AS valor
      FROM negocios n JOIN funis f ON f.id = n.funil_id
      WHERE n.status = 'PERDIDO'::status_negocio
        AND n.perdido_em >= ${filtro.de} AND n.perdido_em < ${filtro.ate}
        AND ${this.condicoesDeNegocios(usuario, filtro)}
      GROUP BY 1 ORDER BY count(*) DESC, 1
      LIMIT ${LIMITE_DE_LINHAS}`);
    return tabela(
      'motivosDePerda',
      'Motivos de perda',
      'Motivo informado ao perder os negócios fechados como perdidos no período.',
      [
        ['motivo', 'Motivo', 'texto'],
        ['perdidos', 'Negócios', 'numero'],
        ['valor', 'Valor', 'moeda'],
      ],
      linhas.map((l) => ({
        motivo: l.motivo,
        perdidos: l.perdidos,
        valor: numero(l.valor) ?? 0,
      })),
    );
  }

  private async ranking(usuario: UsuarioAutenticado, filtro: FiltroResolvido) {
    const { de, ate } = filtro;
    const [negocios, atividades] = await Promise.all([
      this.prisma.$queryRaw<
        {
          usuario_id: string | null;
          nome: string | null;
          abertos: number;
          valor_aberto: number;
          ganhos: number;
          valor_ganho: number;
          perdidos: number;
        }[]
      >(Prisma.sql`
        SELECT n.responsavel_id::text AS usuario_id, u.nome,
          (count(*) FILTER (WHERE n.status = 'ABERTO'::status_negocio))::int AS abertos,
          coalesce(sum(n.valor) FILTER (WHERE n.status = 'ABERTO'::status_negocio), 0)::float AS valor_aberto,
          (count(*) FILTER (WHERE n.status = 'GANHO'::status_negocio AND n.ganho_em >= ${de} AND n.ganho_em < ${ate}))::int AS ganhos,
          coalesce(sum(n.valor) FILTER (WHERE n.status = 'GANHO'::status_negocio AND n.ganho_em >= ${de} AND n.ganho_em < ${ate}), 0)::float AS valor_ganho,
          (count(*) FILTER (WHERE n.status = 'PERDIDO'::status_negocio AND n.perdido_em >= ${de} AND n.perdido_em < ${ate}))::int AS perdidos
        FROM negocios n JOIN funis f ON f.id = n.funil_id
        LEFT JOIN usuarios u ON u.id = n.responsavel_id
        WHERE ${this.condicoesDeNegocios(usuario, filtro)}
        GROUP BY n.responsavel_id, u.nome`),
      this.prisma.$queryRaw<
        { usuario_id: string; feitas: number; atrasadas: number }[]
      >(Prisma.sql`
        SELECT a.responsavel_id::text AS usuario_id,
          (count(*) FILTER (WHERE a.status = 'CONCLUIDA'::status_atividade AND a.concluida_em >= ${de} AND a.concluida_em < ${ate}))::int AS feitas,
          (count(*) FILTER (WHERE a.status = 'PENDENTE'::status_atividade AND a.vence_em < now()))::int AS atrasadas
        FROM atividades a JOIN usuarios r ON r.id = a.responsavel_id
        WHERE ${this.condicoesDeAtividades(usuario, filtro)}
        GROUP BY a.responsavel_id`),
    ]);
    const deAtividades = new Map(atividades.map((l) => [l.usuario_id, l]));
    const nomes = await this.nomesDosUsuarios(
      atividades
        .map((l) => l.usuario_id)
        .filter((id) => !negocios.some((n) => n.usuario_id === id)),
    );
    const linhas = negocios.map((l) => ({
      usuarioId: l.usuario_id,
      nome: l.nome ?? 'Sem responsável',
      abertos: l.abertos,
      valorAberto: numero(l.valor_aberto) ?? 0,
      ganhos: l.ganhos,
      valorGanho: numero(l.valor_ganho) ?? 0,
      perdidos: l.perdidos,
      taxaGanho: percentual(l.ganhos, l.ganhos + l.perdidos),
      atividadesFeitas: deAtividades.get(l.usuario_id ?? '')?.feitas ?? 0,
      atividadesAtrasadas: deAtividades.get(l.usuario_id ?? '')?.atrasadas ?? 0,
    }));
    for (const l of atividades) {
      if (!negocios.some((n) => n.usuario_id === l.usuario_id)) {
        linhas.push({
          usuarioId: l.usuario_id,
          nome: nomes.get(l.usuario_id) ?? 'Desconhecido',
          abertos: 0,
          valorAberto: 0,
          ganhos: 0,
          valorGanho: 0,
          perdidos: 0,
          taxaGanho: null,
          atividadesFeitas: l.feitas,
          atividadesAtrasadas: l.atrasadas,
        });
      }
    }
    linhas.sort(
      (a, b) =>
        b.valorGanho - a.valorGanho ||
        b.ganhos - a.ganhos ||
        a.nome.localeCompare(b.nome, 'pt-BR'),
    );
    return tabela(
      'ranking',
      'Ranking por vendedor',
      'Por responsável: abertos agora, ganhos e perdidos no período e atividades (feitas no período, atrasadas agora). Ordenado pelo valor ganho.',
      [
        ['usuarioId', 'Vendedor', 'id'],
        ['nome', 'Vendedor', 'texto'],
        ['abertos', 'Abertos', 'numero'],
        ['valorAberto', 'Valor em aberto', 'moeda'],
        ['ganhos', 'Ganhos', 'numero'],
        ['valorGanho', 'Valor ganho', 'moeda'],
        ['perdidos', 'Perdidos', 'numero'],
        ['taxaGanho', 'Taxa de ganho', 'percentual'],
        ['atividadesFeitas', 'Atividades feitas', 'numero'],
        ['atividadesAtrasadas', 'Atividades atrasadas', 'numero'],
      ],
      linhas,
    );
  }

  private async nomesDosUsuarios(ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0) {
      return new Map();
    }
    const usuarios = await this.prisma.usuario.findMany({
      where: { id: { in: ids } },
      select: { id: true, nome: true },
    });
    return new Map(usuarios.map((u) => [u.id, u.nome]));
  }

  private async evolucao(usuario: UsuarioAutenticado, filtro: FiltroResolvido) {
    const { de, ate } = filtro;
    const linhas = await this.prisma.$queryRaw<
      { dia: string; tipo: string; total: number; valor: number }[]
    >(Prisma.sql`
      SELECT to_char(x.quando AT TIME ZONE ${FUSO_DO_BI}, 'YYYY-MM-DD') AS dia, x.tipo,
        count(*)::int AS total, coalesce(sum(x.valor), 0)::float AS valor
      FROM (
        SELECT n.criado_em AS quando, 'novos' AS tipo, n.valor
          FROM negocios n JOIN funis f ON f.id = n.funil_id
          WHERE n.criado_em >= ${de} AND n.criado_em < ${ate} AND ${this.condicoesDeNegocios(usuario, filtro)}
        UNION ALL
        SELECT n.ganho_em, 'ganhos', n.valor
          FROM negocios n JOIN funis f ON f.id = n.funil_id
          WHERE n.status = 'GANHO'::status_negocio AND n.ganho_em >= ${de} AND n.ganho_em < ${ate} AND ${this.condicoesDeNegocios(usuario, filtro)}
        UNION ALL
        SELECT n.perdido_em, 'perdidos', n.valor
          FROM negocios n JOIN funis f ON f.id = n.funil_id
          WHERE n.status = 'PERDIDO'::status_negocio AND n.perdido_em >= ${de} AND n.perdido_em < ${ate} AND ${this.condicoesDeNegocios(usuario, filtro)}
      ) x GROUP BY 1, 2`);
    const por = new Map(linhas.map((l) => [`${l.dia}|${l.tipo}`, l]));
    return tabela(
      'evolucao',
      'Evolução por dia',
      'Negócios criados, ganhos e perdidos por dia (fuso de Brasília), com o valor ganho.',
      [
        ['dia', 'Dia', 'data'],
        ['novos', 'Novos', 'numero'],
        ['ganhos', 'Ganhos', 'numero'],
        ['perdidos', 'Perdidos', 'numero'],
        ['valorGanho', 'Valor ganho', 'moeda'],
      ],
      diasDoIntervalo(de, ate).map((dia) => ({
        dia,
        novos: por.get(`${dia}|novos`)?.total ?? 0,
        ganhos: por.get(`${dia}|ganhos`)?.total ?? 0,
        perdidos: por.get(`${dia}|perdidos`)?.total ?? 0,
        valorGanho: numero(por.get(`${dia}|ganhos`)?.valor ?? 0) ?? 0,
      })),
    );
  }
}
