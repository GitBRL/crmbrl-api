import { Injectable } from '@nestjs/common';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import { ehDiretoria, setorDaPessoa } from '../comum/dominio/papeis';
import {
  DadosInvalidosException,
  NaoEncontradoException,
} from '../comum/erros/excecoes';
import { Prisma } from '../generated/prisma/client';
import { FUSO_DO_BI } from '../bi/bi.constantes';
import { variacaoPercentual } from '../bi/periodo';
import { PrismaService } from '../prisma/prisma.service';
import {
  DIMENSOES_DE_BARRAS,
  type IndicadorDoCatalogo,
  indicadorDoCatalogo,
} from './catalogo';
import { arredondar, progressoDaMeta, taxa } from './formulas';
import { FiltrosIndicadoresService } from './filtros-indicadores.service';
import { fonteDe } from './fontes-sql';
import { LIMITE_DE_LINHAS_DO_WIDGET } from './indicadores.constantes';
import type {
  Agrupamento,
  CliqueDoWidget,
  FiltroResolvido,
  LinhaDoWidget,
  Parametros,
  PontoDaSerie,
  ResultadoDoWidget,
  Widget,
} from './indicadores.tipos';
import { baldesDoIntervalo, rotuloDoBalde } from './periodos';

interface Intervalo {
  de: Date;
  ate: Date;
}

interface LinhaSql {
  chave?: string | null;
  id?: string | null;
  rotulo?: string | null;
  etapa_ordem?: number | null;
  tipo?: string | null;
  a: number | null;
  b: number | null;
}

const UNIDADE_DO_TRUNC: Record<Agrupamento, string> = {
  DIA: 'day',
  SEMANA: 'week',
  MES: 'month',
};

const ROTULOS_DE_BARRAS: Record<string, Record<string, string>> = {
  ORIGEM: {
    MANUAL: 'Manual',
    WEBHOOK: 'Webhook',
    WHATSAPP: 'WhatsApp',
    SITE: 'Site',
    INDICACAO: 'Indicação',
    IMPORTACAO: 'Importação',
    PASSAGEM: 'Passagem',
    OUTRO: 'Outro',
    EMAIL: 'E-mail',
    INSTAGRAM: 'Instagram',
    MESSENGER: 'Messenger',
  },
  TIPO: {
    TAREFA: 'Tarefa',
    LIGACAO: 'Ligação',
    REUNIAO: 'Reunião',
    EMAIL: 'E-mail',
    WHATSAPP: 'WhatsApp',
    NOTA: 'Nota',
  },
  RESULTADO: {
    COMPARECEU: 'Compareceu',
    NAO_COMPARECEU: 'Não compareceu',
    REMARCADA: 'Remarcada',
    SEM_RESULTADO: 'Sem resultado',
  },
  CANAL: {
    WHATSAPP: 'WhatsApp',
    WHATSAPP_OFICIAL: 'WhatsApp oficial',
    INSTAGRAM: 'Instagram',
    MESSENGER: 'Messenger',
    EMAIL: 'E-mail',
    WEBCHAT: 'Chat do site',
  },
  DIRECAO: { FEITA: 'Feita', RECEBIDA: 'Recebida' },
  ESTADO: {
    CHAMANDO: 'Chamando',
    TOCANDO: 'Tocando',
    EM_ANDAMENTO: 'Em andamento',
    ENCERRADA: 'Atendida e encerrada',
    PERDIDA: 'Perdida',
    RECUSADA: 'Recusada',
    SEM_RESPOSTA: 'Sem resposta',
    FALHOU: 'Falhou',
  },
};

/** Um erro "de regra" do widget (mensagem e status HTTP) que não derruba os outros. */
export class ErroDoWidget extends Error {
  constructor(
    mensagem: string,
    readonly status: number,
  ) {
    super(mensagem);
  }
}

/**
 * Cálculo de cada visualização de um widget (R33.2), para **quem vê** (R33.4):
 * as linhas vêm de `fontes-sql.ts` com os recortes do BI.
 */
@Injectable()
export class CalculoIndicadoresService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly filtros: FiltrosIndicadoresService,
  ) {}

  async calcular(
    usuario: UsuarioAutenticado,
    widget: Widget,
    filtro: FiltroResolvido,
  ): Promise<ResultadoDoWidget> {
    const def = indicadorDoCatalogo(widget.indicador);
    if (!def) {
      throw new ErroDoWidget('Indicador desconhecido.', 400);
    }
    const base: ResultadoDoWidget = {
      id: widget.id,
      indicador: def.chave,
      nome: def.nome,
      visualizacao: widget.visualizacao,
      titulo: widget.titulo?.trim() || def.nome,
      unidade: def.unidade,
      melhorQuando: def.melhorQuando,
      largura: widget.largura,
      ordem: widget.ordem,
      periodo: def.agora
        ? null
        : { de: filtro.de.toISOString(), ate: filtro.ate.toISOString() },
      anterior:
        !def.agora && filtro.anteriorDe && filtro.anteriorAte
          ? {
              de: filtro.anteriorDe.toISOString(),
              ate: filtro.anteriorAte.toISOString(),
            }
          : null,
      ok: true,
    };
    const parametros = widget.parametros;
    switch (widget.visualizacao) {
      case 'NUMERO':
        return {
          ...base,
          ...(await this.numero(usuario, def, widget, filtro)),
        };
      case 'SERIE':
        return {
          ...base,
          ...(await this.serie(usuario, def, parametros, filtro)),
        };
      case 'RANKING':
        return {
          ...base,
          ...(await this.ranking(usuario, def, widget, filtro)),
        };
      case 'POR_ETAPA':
        return {
          ...base,
          ...(await this.porEtapa(usuario, def, parametros, filtro)),
        };
      case 'BARRAS':
        return {
          ...base,
          ...(await this.barras(usuario, def, parametros, filtro)),
        };
      case 'FUNIL':
        return { ...base, ...(await this.funil(usuario, parametros, filtro)) };
    }
  }

  // -------------------------------------------------------------------------
  // Consulta genérica
  // -------------------------------------------------------------------------

  private async consultar(
    usuario: UsuarioAutenticado,
    def: IndicadorDoCatalogo,
    parametros: Parametros,
    filtro: FiltroResolvido,
    intervalo: Intervalo | null,
    agrupamento?: {
      selecao: Prisma.Sql;
      colunas: number;
      extraOnde?: Prisma.Sql;
    },
  ): Promise<LinhaSql[]> {
    const calculo = def.calculo;
    const fonte = fonteDe(calculo.fonte, usuario, filtro);
    const periodo =
      calculo.tempo && intervalo
        ? Prisma.sql`${Prisma.raw(calculo.tempo)} >= ${intervalo.de} AND ${Prisma.raw(calculo.tempo)} < ${intervalo.ate}`
        : Prisma.sql`TRUE`;
    const grupo = agrupamento
      ? Prisma.raw(
          ` GROUP BY ${Array.from({ length: agrupamento.colunas }, (_, i) => i + 1).join(', ')}`,
        )
      : Prisma.empty;
    return this.prisma.$queryRaw<LinhaSql[]>(Prisma.sql`
      SELECT ${agrupamento ? Prisma.sql`${agrupamento.selecao},` : Prisma.empty}
             ${calculo.a(parametros)} AS a,
             ${calculo.b ? calculo.b(parametros) : Prisma.sql`NULL::float8`} AS b
        FROM ${fonte.from}
       WHERE ${fonte.onde}
         AND ${calculo.onde(parametros)}
         AND ${periodo}
         AND ${agrupamento?.extraOnde ?? Prisma.sql`TRUE`}
       ${grupo}`);
  }

  private valorDe(
    def: IndicadorDoCatalogo,
    linha: LinhaSql | undefined,
  ): number | null {
    if (!linha) {
      return this.valorVazio(def);
    }
    const valor = def.calculo.formula(linha.a, linha.b);
    return valor === null ? null : arredondar(valor, 2);
  }

  private valorVazio(def: IndicadorDoCatalogo): number | null {
    if (def.calculo.semAmostra === 'NULO') {
      return null;
    }
    const valor = def.calculo.formula(0, def.calculo.b ? 0 : null);
    return valor === null ? null : arredondar(valor, 2);
  }

  // -------------------------------------------------------------------------
  // NUMERO
  // -------------------------------------------------------------------------

  private async valorUnico(
    usuario: UsuarioAutenticado,
    def: IndicadorDoCatalogo,
    parametros: Parametros,
    filtro: FiltroResolvido,
    intervalo: Intervalo | null,
  ): Promise<number | null> {
    if (def.calculo.especial === 'CONVERSAO_ENTRE_ETAPAS') {
      return this.conversaoEntreEtapas(
        usuario,
        parametros,
        filtro,
        intervalo ?? { de: filtro.de, ate: filtro.ate },
      );
    }
    const [linha] = await this.consultar(
      usuario,
      def,
      parametros,
      filtro,
      intervalo,
    );
    return this.valorDe(def, linha);
  }

  private async numero(
    usuario: UsuarioAutenticado,
    def: IndicadorDoCatalogo,
    widget: Widget,
    filtro: FiltroResolvido,
  ): Promise<Partial<ResultadoDoWidget>> {
    const atual: Intervalo | null = def.agora
      ? null
      : { de: filtro.de, ate: filtro.ate };
    const anterior: Intervalo | null =
      !def.agora && filtro.anteriorDe && filtro.anteriorAte
        ? { de: filtro.anteriorDe, ate: filtro.anteriorAte }
        : null;
    const [valor, valorAnterior] = await Promise.all([
      this.valorUnico(usuario, def, widget.parametros, filtro, atual),
      anterior
        ? this.valorUnico(usuario, def, widget.parametros, filtro, anterior)
        : Promise.resolve(null),
    ]);
    return {
      valor,
      valorAnterior,
      variacao: variacaoPercentual(valor, valorAnterior),
      meta: progressoDaMeta(valor, widget.meta?.geral, def.melhorQuando),
      clique: this.clique(def, widget.parametros, filtro),
    };
  }

  // -------------------------------------------------------------------------
  // SERIE
  // -------------------------------------------------------------------------

  private async serie(
    usuario: UsuarioAutenticado,
    def: IndicadorDoCatalogo,
    parametros: Parametros,
    filtro: FiltroResolvido,
  ): Promise<Partial<ResultadoDoWidget>> {
    const agrupamento = (parametros['agrupamento'] ?? 'DIA') as Agrupamento;
    const tempo = Prisma.raw(def.calculo.tempo ?? 'now()');
    const unidade = UNIDADE_DO_TRUNC[agrupamento];
    const linhas = await this.consultar(
      usuario,
      def,
      parametros,
      filtro,
      { de: filtro.de, ate: filtro.ate },
      {
        selecao: Prisma.sql`to_char(date_trunc(${Prisma.raw(`'${unidade}'`)}, (${tempo}) AT TIME ZONE ${Prisma.raw(`'${FUSO_DO_BI}'`)}), 'YYYY-MM-DD') AS chave`,
        colunas: 1,
      },
    );
    const porBalde = new Map(linhas.map((l) => [l.chave ?? '', l]));
    const pontos: PontoDaSerie[] = baldesDoIntervalo(
      filtro.de,
      filtro.ate,
      agrupamento,
    ).map((chave) => ({
      chave,
      rotulo: rotuloDoBalde(chave, agrupamento),
      valor: this.valorDe(def, porBalde.get(chave)),
    }));
    return {
      agrupamento,
      pontos,
      clique: this.clique(def, parametros, filtro),
    };
  }

  // -------------------------------------------------------------------------
  // RANKING
  // -------------------------------------------------------------------------

  private async ranking(
    usuario: UsuarioAutenticado,
    def: IndicadorDoCatalogo,
    widget: Widget,
    filtro: FiltroResolvido,
  ): Promise<Partial<ResultadoDoWidget>> {
    const fonte = fonteDe(def.calculo.fonte, usuario, filtro);
    const intervalo: Intervalo | null = def.agora
      ? null
      : { de: filtro.de, ate: filtro.ate };
    const linhas = await this.consultar(
      usuario,
      def,
      widget.parametros,
      filtro,
      intervalo,
      {
        selecao: Prisma.sql`${fonte.pessoa}::text AS id, r.nome AS rotulo`,
        colunas: 2,
      },
    );
    const menorEhMelhor = def.melhorQuando === 'menor';
    const itens: LinhaDoWidget[] = linhas
      .map((linha): LinhaDoWidget => {
        const valor = this.valorDe(def, linha);
        return {
          id: linha.id ?? null,
          rotulo: linha.rotulo ?? 'Sem responsável',
          valor,
          meta: progressoDaMeta(
            valor,
            widget.meta?.porPessoa,
            def.melhorQuando,
          ),
        };
      })
      .sort((x, y) => {
        if (x.valor === null || y.valor === null) {
          return x.valor === y.valor ? 0 : x.valor === null ? 1 : -1;
        }
        return menorEhMelhor ? x.valor - y.valor : y.valor - x.valor;
      })
      .slice(0, LIMITE_DE_LINHAS_DO_WIDGET);
    const resultado: Partial<ResultadoDoWidget> = {
      linhas: itens,
      clique: this.clique(def, widget.parametros, filtro),
    };
    if (widget.meta?.geral !== undefined && widget.meta.geral !== null) {
      const total = await this.valorUnico(
        usuario,
        def,
        widget.parametros,
        filtro,
        intervalo,
      );
      resultado.valor = total;
      resultado.meta = progressoDaMeta(
        total,
        widget.meta.geral,
        def.melhorQuando,
      );
    }
    return resultado;
  }

  // -------------------------------------------------------------------------
  // POR_ETAPA e FUNIL
  // -------------------------------------------------------------------------

  /** O funil do widget: o do parâmetro, o único do filtro ou o funil-base do setor (Comercial para a diretoria). */
  private async funilDoWidget(
    usuario: UsuarioAutenticado,
    parametros: Parametros,
    filtro: FiltroResolvido,
  ): Promise<{ id: string; nome: string; area: string }> {
    const escolhido =
      parametros['funilId'] ??
      (filtro.funilIds?.length === 1 ? filtro.funilIds[0] : undefined);
    if (escolhido) {
      return this.filtros.exigirFunilVisivel(usuario, escolhido);
    }
    const area = ehDiretoria(usuario.papel)
      ? 'COMERCIAL'
      : setorDaPessoa(usuario);
    const base = area
      ? await this.prisma.funil.findFirst({
          where: { area, base: true, excluidoEm: null },
          select: { id: true, nome: true, area: true },
        })
      : null;
    if (!base) {
      throw new ErroDoWidget('Escolha um funil para este indicador.', 400);
    }
    return this.filtros.exigirFunilVisivel(usuario, base.id);
  }

  private async porEtapa(
    usuario: UsuarioAutenticado,
    def: IndicadorDoCatalogo,
    parametros: Parametros,
    filtro: FiltroResolvido,
  ): Promise<Partial<ResultadoDoWidget>> {
    const funil = await this.funilDoWidget(usuario, parametros, filtro);
    const intervalo: Intervalo | null = def.agora
      ? null
      : { de: filtro.de, ate: filtro.ate };
    const [linhas, etapas] = await Promise.all([
      this.consultar(usuario, def, parametros, filtro, intervalo, {
        selecao: Prisma.sql`e.id::text AS id`,
        colunas: 1,
        extraOnde: Prisma.sql`n.funil_id = ${funil.id}::uuid`,
      }),
      this.prisma.etapa.findMany({
        where: { funilId: funil.id },
        orderBy: [{ ordem: 'asc' }, { criadoEm: 'asc' }],
        select: { id: true, nome: true, tipo: true },
      }),
    ]);
    const porId = new Map(linhas.map((l) => [l.id ?? '', l]));
    return {
      funil,
      linhas: etapas.map((etapa) => ({
        id: etapa.id,
        rotulo: etapa.nome,
        tipo: etapa.tipo,
        valor: this.valorDe(def, porId.get(etapa.id)),
      })),
      clique: null,
    };
  }

  private async funil(
    usuario: UsuarioAutenticado,
    parametros: Parametros,
    filtro: FiltroResolvido,
  ): Promise<Partial<ResultadoDoWidget>> {
    const funil = await this.funilDoWidget(usuario, parametros, filtro);
    const fonte = fonteDe('NEGOCIO', usuario, filtro);
    const [linhas, etapas] = await Promise.all([
      // "Chegou à etapa N" = alcançou a etapa N ou qualquer uma depois dela (ordem maior): assim a
      // conversão entre etapas nunca passa de 100%, mesmo quando o negócio pulou etapas. A etapa de perda
      // não conta como "ter avançado". Cada negócio entra uma vez, na maior ordem que alcançou.
      this.prisma.$queryRaw<{ ordem: number; negocios: number }[]>(Prisma.sql`
        WITH coorte AS (
          SELECT DISTINCT m.negocio_id
            FROM negocio_movimentacoes m
            JOIN negocios n ON n.id = m.negocio_id
            JOIN funis f ON f.id = n.funil_id
            JOIN etapas e ON e.id = n.etapa_id
            LEFT JOIN usuarios r ON r.id = n.responsavel_id
           WHERE m.de_etapa_id IS NULL AND m.funil_id = ${funil.id}::uuid
             AND m.criado_em >= ${filtro.de} AND m.criado_em < ${filtro.ate}
             AND ${fonte.onde})
        SELECT max(et.ordem)::int AS ordem, count(*)::float8 AS negocios
          FROM (
            SELECT m2.negocio_id, max(e2.ordem) AS ordem
              FROM negocio_movimentacoes m2
              JOIN coorte c ON c.negocio_id = m2.negocio_id
              JOIN etapas e2 ON e2.id = m2.para_etapa_id
             WHERE m2.funil_id = ${funil.id}::uuid AND e2.tipo <> 'PERDIDO'::tipo_etapa
             GROUP BY m2.negocio_id) et
         GROUP BY et.ordem`),
      this.prisma.etapa.findMany({
        where: { funilId: funil.id, tipo: { not: 'PERDIDO' } },
        orderBy: [{ ordem: 'asc' }, { criadoEm: 'asc' }],
        select: { id: true, nome: true, tipo: true, ordem: true },
      }),
    ]);
    let anterior: number | null = null;
    let primeiro: number | null = null;
    const itens = etapas.map((etapa): LinhaDoWidget => {
      const valor = linhas
        .filter((linha) => linha.ordem >= etapa.ordem)
        .reduce((soma, linha) => soma + linha.negocios, 0);
      const linha: LinhaDoWidget = {
        id: etapa.id,
        rotulo: etapa.nome,
        tipo: etapa.tipo,
        valor,
        conversao: anterior === null ? null : taxa(valor, anterior),
        conversaoTotal: primeiro === null ? null : taxa(valor, primeiro),
      };
      anterior = valor;
      primeiro ??= valor;
      return linha;
    });
    return { funil, linhas: itens, clique: null };
  }

  // -------------------------------------------------------------------------
  // BARRAS
  // -------------------------------------------------------------------------

  private async barras(
    usuario: UsuarioAutenticado,
    def: IndicadorDoCatalogo,
    parametros: Parametros,
    filtro: FiltroResolvido,
  ): Promise<Partial<ResultadoDoWidget>> {
    const por = parametros['por'] ?? def.barras[0];
    if (!por || !def.barras.includes(por)) {
      throw new DadosInvalidosException('Escolha como dividir as barras.', {
        campos: [{ campo: 'parametros.por', mensagens: ['obrigatório'] }],
      });
    }
    const dimensao = DIMENSOES_DE_BARRAS[por];
    const intervalo: Intervalo | null = def.agora
      ? null
      : { de: filtro.de, ate: filtro.ate };
    const linhas = await this.consultar(
      usuario,
      def,
      parametros,
      filtro,
      intervalo,
      {
        selecao: Prisma.sql`${Prisma.raw(dimensao.sql)} AS id`,
        colunas: 1,
      },
    );
    const dicionario = ROTULOS_DE_BARRAS[por] ?? {};
    const itens = linhas
      .map((linha): LinhaDoWidget => ({
        id: linha.id ?? null,
        rotulo:
          linha.id === null || linha.id === undefined
            ? 'Não informado'
            : (dicionario[linha.id] ?? linha.id),
        valor: this.valorDe(def, linha),
      }))
      .sort((x, y) => (y.valor ?? 0) - (x.valor ?? 0))
      .slice(0, LIMITE_DE_LINHAS_DO_WIDGET);
    return { por, linhas: itens, clique: null };
  }

  // -------------------------------------------------------------------------
  // Conversão entre etapas (número)
  // -------------------------------------------------------------------------

  private async conversaoEntreEtapas(
    usuario: UsuarioAutenticado,
    parametros: Parametros,
    filtro: FiltroResolvido,
    intervalo: Intervalo,
  ): Promise<number | null> {
    const origem = parametros['etapaOrigemId'];
    const destino = parametros['etapaDestinoId'];
    if (!origem || !destino) {
      throw new ErroDoWidget('Escolha as etapas de origem e de destino.', 400);
    }
    try {
      await this.filtros.exigirEtapaVisivel(usuario, origem);
      await this.filtros.exigirEtapaVisivel(usuario, destino);
    } catch (erro) {
      if (erro instanceof NaoEncontradoException) {
        throw new ErroDoWidget('Etapa não encontrada.', 404);
      }
      throw erro;
    }
    const fonte = fonteDe('NEGOCIO', usuario, filtro);
    const [linha] = await this.prisma.$queryRaw<{ a: number; b: number }[]>(
      Prisma.sql`
        WITH entradas AS (
          SELECT m.negocio_id, min(m.criado_em) AS entrou
            FROM negocio_movimentacoes m
            JOIN negocios n ON n.id = m.negocio_id
            JOIN funis f ON f.id = n.funil_id
            JOIN etapas e ON e.id = n.etapa_id
            LEFT JOIN usuarios r ON r.id = n.responsavel_id
           WHERE m.para_etapa_id = ${origem}::uuid
             AND m.criado_em >= ${intervalo.de} AND m.criado_em < ${intervalo.ate}
             AND ${fonte.onde}
           GROUP BY m.negocio_id)
        SELECT count(*)::float8 AS b,
               (count(*) FILTER (WHERE EXISTS (
                  SELECT 1 FROM negocio_movimentacoes m2
                   WHERE m2.negocio_id = en.negocio_id
                     AND m2.para_etapa_id = ${destino}::uuid
                     AND m2.criado_em >= en.entrou)))::float8 AS a
          FROM entradas en`,
    );
    return taxa(linha?.a ?? 0, linha?.b ?? 0);
  }

  // -------------------------------------------------------------------------
  // Clique (R20.8): a lista que sustenta o número, quando existe
  // -------------------------------------------------------------------------

  private clique(
    def: IndicadorDoCatalogo,
    parametros: Parametros,
    filtro: FiltroResolvido,
  ): CliqueDoWidget | null {
    const semFiltroDeNegocio =
      !filtro.etapaIds &&
      !filtro.origens &&
      !filtro.utmSource &&
      !filtro.utmCampaign;
    const simples =
      !filtro.setor &&
      !filtro.etiquetas &&
      semFiltroDeNegocio &&
      (!filtro.pessoas || filtro.pessoas.length === 1);
    if (!simples) {
      return null;
    }
    const responsavelId = filtro.pessoas?.[0];
    const comPessoa = responsavelId ? { responsavelId } : {};
    const periodo = {
      de: filtro.de.toISOString(),
      ate: filtro.ate.toISOString(),
    };
    switch (def.chave) {
      case 'negocios_abertos':
      case 'valor_em_aberto':
      case 'leads_sem_atendimento': {
        if (filtro.funilIds && filtro.funilIds.length > 1) {
          return null;
        }
        return {
          lista: 'NEGOCIOS',
          filtros: {
            status: 'ABERTO',
            ...(def.chave === 'leads_sem_atendimento'
              ? { atendido: false }
              : {}),
            ...(filtro.funilIds?.[0] ? { funilId: filtro.funilIds[0] } : {}),
            ...comPessoa,
          },
        };
      }
      case 'atividades_atrasadas':
        return filtro.funilIds
          ? null
          : {
              lista: 'ATIVIDADES',
              filtros: { atrasadas: true, status: ['PENDENTE'], ...comPessoa },
            };
      case 'reunioes_agendadas':
      case 'reunioes_realizadas':
      case 'reunioes_no_show':
      case 'reunioes_remarcadas':
      case 'reunioes_sem_resultado': {
        if (filtro.funilIds) {
          return null;
        }
        const resultado: Record<string, string[]> = {
          reunioes_realizadas: ['COMPARECEU'],
          reunioes_no_show: ['NAO_COMPARECEU'],
          reunioes_remarcadas: ['REMARCADA'],
          reunioes_sem_resultado: ['SEM_RESULTADO'],
        };
        const agora = Date.now();
        const ate =
          def.chave === 'reunioes_sem_resultado'
            ? new Date(Math.min(filtro.ate.getTime(), agora)).toISOString()
            : periodo.ate;
        return {
          lista: 'ATIVIDADES',
          filtros: {
            tipo: ['REUNIAO'],
            status: ['PENDENTE', 'CONCLUIDA'],
            ...(resultado[def.chave]
              ? { resultadoReuniao: resultado[def.chave] }
              : {}),
            de: periodo.de,
            ate,
            ...comPessoa,
          },
        };
      }
      default:
        void parametros;
        return null;
    }
  }
}
