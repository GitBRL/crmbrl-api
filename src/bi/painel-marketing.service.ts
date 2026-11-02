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
  sqlCampanhasVisiveis,
  sqlNegociosVisiveis,
  sqlPessoas,
  VERDADEIRO,
} from './escopo-bi';
import { diasDoIntervalo, percentual } from './periodo';

const CARTOES: readonly DefinicaoDeCartao[] = [
  {
    chave: 'leads',
    rotulo: 'Leads',
    unidade: 'numero',
    melhorQuando: 'maior',
    dica: 'Negócios criados nos funis de Marketing no período.',
  },
  {
    chave: 'passagens',
    rotulo: 'Passagens para o Comercial',
    unidade: 'numero',
    melhorQuando: 'maior',
    dica: 'Passagens executadas no período, de um funil de Marketing para um do Comercial.',
  },
  {
    chave: 'taxaPassagem',
    rotulo: 'Taxa de passagem',
    unidade: 'percentual',
    melhorQuando: 'maior',
    dica: 'Dos leads criados no período, a parcela que já passou para o Comercial.',
  },
  {
    chave: 'tempoAtePassagem',
    rotulo: 'Tempo até a passagem',
    unidade: 'segundos',
    melhorQuando: 'menor',
    dica: 'Tempo médio entre a criação do lead e a primeira passagem para o Comercial, entre os leads criados no período que passaram.',
  },
  {
    chave: 'enviados',
    rotulo: 'Mensagens enviadas',
    unidade: 'numero',
    melhorQuando: 'maior',
    dica: 'Mensagens de campanha enviadas no período.',
  },
  {
    chave: 'entregues',
    rotulo: 'Entregues',
    unidade: 'numero',
    melhorQuando: 'maior',
    dica: 'Mensagens de campanha entregues no período (pela data da entrega).',
  },
  {
    chave: 'lidos',
    rotulo: 'Lidos',
    unidade: 'numero',
    melhorQuando: 'maior',
    dica: 'Mensagens de campanha lidas no período (pela data da leitura).',
  },
  {
    chave: 'respondidos',
    rotulo: 'Respondidos',
    unidade: 'numero',
    melhorQuando: 'maior',
    dica: 'Destinatários que responderam a uma campanha no período.',
  },
  {
    chave: 'optOuts',
    rotulo: 'Opt-outs',
    unidade: 'numero',
    melhorQuando: 'menor',
    dica: 'Destinatários que pediram para sair das mensagens no período.',
  },
];

interface LinhaLeads {
  leads: number;
  com_passagem: number;
  tempo: number | null;
}
interface LinhaPassagens {
  passagens: number;
}
interface LinhaCampanhas {
  enviados: number;
  entregues: number;
  lidos: number;
  respondidos: number;
  opt_outs: number;
}

/**
 * Painel Marketing (R20): leads por origem/UTM e por dia, passagens para o
 * Comercial (quantidade, taxa e tempo) e o desempenho das campanhas.
 * Visibilidade: negócios como no kanban (R5.9) e campanhas como em Disparos (R17).
 */
@Injectable()
export class PainelMarketingService {
  constructor(private readonly prisma: PrismaService) {}

  async calcular(
    usuario: UsuarioAutenticado,
    filtro: FiltroResolvido,
  ): Promise<ConteudoDoPainel> {
    const atual = await this.valores(usuario, filtro, filtro.de, filtro.ate);
    const anterior =
      filtro.anteriorDe && filtro.anteriorAte
        ? await this.valores(
            usuario,
            filtro,
            filtro.anteriorDe,
            filtro.anteriorAte,
          )
        : null;
    const [porOrigem, porUtm, porDia, campanhas] = await Promise.all([
      this.leadsPorOrigem(usuario, filtro),
      this.leadsPorUtm(usuario, filtro),
      this.leadsPorDia(usuario, filtro),
      this.campanhas(usuario, filtro),
    ]);
    return {
      cartoes: montarCartoes(CARTOES, atual, anterior),
      tabelas: {
        leadsPorOrigem: porOrigem,
        leadsPorUtm: porUtm,
        leadsPorDia: porDia,
        campanhas,
      },
      meta: {},
    };
  }

  // ---------------------------------------------------------------------
  // Fragmentos
  // ---------------------------------------------------------------------

  /** Condições dos leads (negócios `n` de funis `f` de Marketing). */
  private condicoesDeLeads(
    usuario: UsuarioAutenticado,
    filtro: FiltroResolvido,
  ): Prisma.Sql {
    return Prisma.sql`f.area = 'MARKETING'::area AND n.excluido_em IS NULL
      AND ${sqlNegociosVisiveis(usuario)}
      AND ${sqlPessoas(Prisma.sql`n.responsavel_id`, filtro.pessoas)}
      AND ${filtro.funilId ? Prisma.sql`n.funil_id = ${filtro.funilId}::uuid` : VERDADEIRO}`;
  }

  /** Condições das campanhas `k` (e do destinatário `d`, quando o canal filtra). */
  private condicoesDeCampanhas(
    usuario: UsuarioAutenticado,
    filtro: FiltroResolvido,
  ): Prisma.Sql {
    return Prisma.sql`k.excluido_em IS NULL
      AND ${sqlCampanhasVisiveis(usuario)}
      AND ${sqlPessoas(Prisma.sql`k.criado_por_id`, filtro.pessoas)}
      AND ${filtro.area ? Prisma.sql`k.area = ${filtro.area}::area` : VERDADEIRO}
      AND ${
        filtro.canalId
          ? Prisma.sql`EXISTS (SELECT 1 FROM campanha_canais cc WHERE cc.campanha_id = k.id AND cc.canal_id = ${filtro.canalId}::uuid)`
          : VERDADEIRO
      }`;
  }

  /** Só os destinatários com algum evento no período (deixa o banco usar os índices por data). */
  private eventosNoPeriodo(de: Date, ate: Date): Prisma.Sql {
    return Prisma.sql`(d.enviado_em >= ${de} AND d.enviado_em < ${ate}
      OR d.entregue_em >= ${de} AND d.entregue_em < ${ate}
      OR d.lido_em >= ${de} AND d.lido_em < ${ate}
      OR d.respondeu_em >= ${de} AND d.respondeu_em < ${ate}
      OR d.opt_out_em >= ${de} AND d.opt_out_em < ${ate})`;
  }

  // ---------------------------------------------------------------------
  // Indicadores
  // ---------------------------------------------------------------------

  private async valores(
    usuario: UsuarioAutenticado,
    filtro: FiltroResolvido,
    de: Date,
    ate: Date,
  ): Promise<Valores> {
    const [[leads], [passagens], [campanhas]] = await Promise.all([
      this.prisma.$queryRaw<LinhaLeads[]>(Prisma.sql`
        SELECT count(*)::int AS leads,
          count(p.primeira)::int AS com_passagem,
          avg(extract(epoch FROM p.primeira - n.criado_em))::float AS tempo
        FROM negocios n JOIN funis f ON f.id = n.funil_id
        LEFT JOIN LATERAL (
          SELECT min(pe.criado_em) AS primeira
          FROM passagem_execucoes pe
          JOIN passagens ps ON ps.id = pe.passagem_id
          JOIN funis fd ON fd.id = ps.funil_destino_id
          WHERE pe.negocio_origem_id = n.id AND fd.area = 'COMERCIAL'::area
        ) p ON TRUE
        WHERE n.criado_em >= ${de} AND n.criado_em < ${ate}
          AND ${this.condicoesDeLeads(usuario, filtro)}`),
      this.prisma.$queryRaw<LinhaPassagens[]>(Prisma.sql`
        SELECT count(*)::int AS passagens
        FROM passagem_execucoes pe
        JOIN passagens ps ON ps.id = pe.passagem_id
        JOIN funis fd ON fd.id = ps.funil_destino_id AND fd.area = 'COMERCIAL'::area
        JOIN negocios n ON n.id = pe.negocio_origem_id
        JOIN funis f ON f.id = n.funil_id
        WHERE pe.criado_em >= ${de} AND pe.criado_em < ${ate}
          AND ${this.condicoesDeLeads(usuario, filtro)}`),
      this.prisma.$queryRaw<LinhaCampanhas[]>(Prisma.sql`
        SELECT
          (count(*) FILTER (WHERE d.enviado_em >= ${de} AND d.enviado_em < ${ate}))::int AS enviados,
          (count(*) FILTER (WHERE d.entregue_em >= ${de} AND d.entregue_em < ${ate}))::int AS entregues,
          (count(*) FILTER (WHERE d.lido_em >= ${de} AND d.lido_em < ${ate}))::int AS lidos,
          (count(*) FILTER (WHERE d.respondeu_em >= ${de} AND d.respondeu_em < ${ate}))::int AS respondidos,
          (count(*) FILTER (WHERE d.opt_out_em >= ${de} AND d.opt_out_em < ${ate}))::int AS opt_outs
        FROM campanha_destinatarios d JOIN campanhas k ON k.id = d.campanha_id
        WHERE ${this.eventosNoPeriodo(de, ate)}
          AND ${this.condicoesDeCampanhas(usuario, filtro)}`),
    ]);
    return {
      leads: leads.leads,
      passagens: passagens.passagens,
      taxaPassagem: percentual(leads.com_passagem, leads.leads),
      tempoAtePassagem: numero(leads.tempo, 0),
      enviados: campanhas.enviados,
      entregues: campanhas.entregues,
      lidos: campanhas.lidos,
      respondidos: campanhas.respondidos,
      optOuts: campanhas.opt_outs,
    };
  }

  // ---------------------------------------------------------------------
  // Tabelas
  // ---------------------------------------------------------------------

  private async leadsPorOrigem(
    usuario: UsuarioAutenticado,
    filtro: FiltroResolvido,
  ) {
    const linhas = await this.prisma.$queryRaw<
      { origem: string; leads: number; com_passagem: number }[]
    >(Prisma.sql`
      SELECT n.origem::text AS origem, count(*)::int AS leads,
        (count(*) FILTER (WHERE EXISTS (
          SELECT 1 FROM passagem_execucoes pe
          JOIN passagens ps ON ps.id = pe.passagem_id
          JOIN funis fd ON fd.id = ps.funil_destino_id
          WHERE pe.negocio_origem_id = n.id AND fd.area = 'COMERCIAL'::area)))::int AS com_passagem
      FROM negocios n JOIN funis f ON f.id = n.funil_id
      WHERE n.criado_em >= ${filtro.de} AND n.criado_em < ${filtro.ate}
        AND ${this.condicoesDeLeads(usuario, filtro)}
      GROUP BY n.origem ORDER BY count(*) DESC, n.origem`);
    return tabela(
      'leadsPorOrigem',
      'Leads por origem',
      'Origem do negócio no momento em que foi criado; "com passagem" são os que já foram para o Comercial.',
      [
        ['origem', 'Origem', 'texto'],
        ['leads', 'Leads', 'numero'],
        ['comPassagem', 'Com passagem', 'numero'],
        ['taxaPassagem', 'Taxa de passagem', 'percentual'],
      ],
      linhas.map((l) => ({
        origem: l.origem,
        leads: l.leads,
        comPassagem: l.com_passagem,
        taxaPassagem: percentual(l.com_passagem, l.leads),
      })),
    );
  }

  private async leadsPorUtm(
    usuario: UsuarioAutenticado,
    filtro: FiltroResolvido,
  ) {
    const linhas = await this.prisma.$queryRaw<
      { fonte: string; meio: string; campanha: string; leads: number }[]
    >(Prisma.sql`
      SELECT coalesce(nullif(n.utm->>'source', ''), '(sem UTM)') AS fonte,
        coalesce(nullif(n.utm->>'medium', ''), '(sem UTM)') AS meio,
        coalesce(nullif(n.utm->>'campaign', ''), '(sem UTM)') AS campanha,
        count(*)::int AS leads
      FROM negocios n JOIN funis f ON f.id = n.funil_id
      WHERE n.criado_em >= ${filtro.de} AND n.criado_em < ${filtro.ate}
        AND ${this.condicoesDeLeads(usuario, filtro)}
      GROUP BY 1, 2, 3 ORDER BY count(*) DESC, 1, 2, 3
      LIMIT ${LIMITE_DE_LINHAS}`);
    return tabela(
      'leadsPorUtm',
      'Leads por UTM',
      'Fonte, meio e campanha das UTMs gravadas no negócio (as 50 combinações com mais leads).',
      [
        ['fonte', 'Fonte (source)', 'texto'],
        ['meio', 'Meio (medium)', 'texto'],
        ['campanha', 'Campanha', 'texto'],
        ['leads', 'Leads', 'numero'],
      ],
      linhas,
    );
  }

  private async leadsPorDia(
    usuario: UsuarioAutenticado,
    filtro: FiltroResolvido,
  ) {
    const [leads, passagens] = await Promise.all([
      this.prisma.$queryRaw<{ dia: string; total: number }[]>(Prisma.sql`
        SELECT to_char(n.criado_em AT TIME ZONE ${FUSO_DO_BI}, 'YYYY-MM-DD') AS dia, count(*)::int AS total
        FROM negocios n JOIN funis f ON f.id = n.funil_id
        WHERE n.criado_em >= ${filtro.de} AND n.criado_em < ${filtro.ate}
          AND ${this.condicoesDeLeads(usuario, filtro)}
        GROUP BY 1`),
      this.prisma.$queryRaw<{ dia: string; total: number }[]>(Prisma.sql`
        SELECT to_char(pe.criado_em AT TIME ZONE ${FUSO_DO_BI}, 'YYYY-MM-DD') AS dia, count(*)::int AS total
        FROM passagem_execucoes pe
        JOIN passagens ps ON ps.id = pe.passagem_id
        JOIN funis fd ON fd.id = ps.funil_destino_id AND fd.area = 'COMERCIAL'::area
        JOIN negocios n ON n.id = pe.negocio_origem_id
        JOIN funis f ON f.id = n.funil_id
        WHERE pe.criado_em >= ${filtro.de} AND pe.criado_em < ${filtro.ate}
          AND ${this.condicoesDeLeads(usuario, filtro)}
        GROUP BY 1`),
    ]);
    const deLeads = new Map(leads.map((l) => [l.dia, l.total]));
    const dePassagens = new Map(passagens.map((l) => [l.dia, l.total]));
    return tabela(
      'leadsPorDia',
      'Leads por dia',
      'Leads criados e passagens para o Comercial por dia (fuso de Brasília).',
      [
        ['dia', 'Dia', 'data'],
        ['leads', 'Leads', 'numero'],
        ['passagens', 'Passagens', 'numero'],
      ],
      diasDoIntervalo(filtro.de, filtro.ate).map((dia) => ({
        dia,
        leads: deLeads.get(dia) ?? 0,
        passagens: dePassagens.get(dia) ?? 0,
      })),
    );
  }

  private async campanhas(
    usuario: UsuarioAutenticado,
    filtro: FiltroResolvido,
  ) {
    const { de, ate } = filtro;
    const linhas = await this.prisma.$queryRaw<
      {
        id: string;
        nome: string;
        canal: string;
        status: string;
        enviados: number;
        entregues: number;
        lidos: number;
        respondidos: number;
        opt_outs: number;
      }[]
    >(Prisma.sql`
      SELECT k.id::text AS id, k.nome, k.canal::text AS canal, k.status::text AS status,
        (count(*) FILTER (WHERE d.enviado_em >= ${de} AND d.enviado_em < ${ate}))::int AS enviados,
        (count(*) FILTER (WHERE d.entregue_em >= ${de} AND d.entregue_em < ${ate}))::int AS entregues,
        (count(*) FILTER (WHERE d.lido_em >= ${de} AND d.lido_em < ${ate}))::int AS lidos,
        (count(*) FILTER (WHERE d.respondeu_em >= ${de} AND d.respondeu_em < ${ate}))::int AS respondidos,
        (count(*) FILTER (WHERE d.opt_out_em >= ${de} AND d.opt_out_em < ${ate}))::int AS opt_outs
      FROM campanha_destinatarios d JOIN campanhas k ON k.id = d.campanha_id
      WHERE ${this.eventosNoPeriodo(de, ate)}
        AND ${this.condicoesDeCampanhas(usuario, filtro)}
      GROUP BY k.id
      ORDER BY 5 DESC, k.nome, k.id
      LIMIT ${LIMITE_DE_LINHAS}`);
    return tabela(
      'campanhas',
      'Campanhas',
      'Atividade de cada campanha no período: cada contagem usa a data do próprio evento (as 50 com mais envios).',
      [
        ['id', 'Campanha', 'id'],
        ['nome', 'Campanha', 'texto'],
        ['canal', 'Canal', 'texto'],
        ['status', 'Situação', 'texto'],
        ['enviados', 'Enviados', 'numero'],
        ['entregues', 'Entregues', 'numero'],
        ['lidos', 'Lidos', 'numero'],
        ['respondidos', 'Respondidos', 'numero'],
        ['optOuts', 'Opt-outs', 'numero'],
        ['taxaEntrega', 'Taxa de entrega', 'percentual'],
        ['taxaLeitura', 'Taxa de leitura', 'percentual'],
        ['taxaResposta', 'Taxa de resposta', 'percentual'],
      ],
      linhas.map((l) => ({
        id: l.id,
        nome: l.nome,
        canal: l.canal,
        status: l.status,
        enviados: l.enviados,
        entregues: l.entregues,
        lidos: l.lidos,
        respondidos: l.respondidos,
        optOuts: l.opt_outs,
        taxaEntrega: percentual(l.entregues, l.enviados),
        taxaLeitura: percentual(l.lidos, l.enviados),
        taxaResposta: percentual(l.respondidos, l.enviados),
      })),
    );
  }
}
