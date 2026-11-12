import { Injectable, Logger } from '@nestjs/common';
import { ArquivoDto } from '../arquivos/arquivos.dto';
import { ArquivosService } from '../arquivos/arquivos.service';
import { AuditoriaService } from '../auditoria/auditoria.service';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import { montarXlsxDeTabelas } from '../bi/exportacao-bi.service';
import { tabelaComoCsv } from '../bi/formatos-bi';
import type { TabelaBi, TipoColunaBi } from '../bi/bi.tipos';
import { CacheBi } from '../bi/cache-bi';
import { setorDaPessoa } from '../comum/dominio/papeis';
import {
  DadosInvalidosException,
  ErroApi,
  NaoEncontradoException,
  SemPermissaoException,
} from '../comum/erros/excecoes';
import { PrismaService } from '../prisma/prisma.service';
import { catalogoPublico } from './catalogo';
import {
  CalculoIndicadoresService,
  ErroDoWidget,
} from './calculo-indicadores.service';
import {
  FiltrosIndicadoresService,
  mesclarFiltros,
} from './filtros-indicadores.service';
import {
  CACHE_INDICADORES_MAXIMO,
  CACHE_INDICADORES_SEGUNDOS,
  REGRA_INDICADORES,
} from './indicadores.constantes';
import {
  type FiltrosDoIndicador,
  GRUPOS,
  ROTULO_DO_GRUPO,
  type ResultadoDoWidget,
  type Unidade,
  type Widget,
} from './indicadores.tipos';
import { MODELOS } from './modelos';
import {
  PaineisIndicadoresService,
  podeCriarPaineis,
} from './paineis-indicadores.service';
import { validarFiltros, validarWidgets } from './validacao-widgets';

export interface PedidoDeCalculo {
  painelId?: string;
  widgets?: unknown;
  filtros?: unknown;
}

export interface RespostaDeCalculo {
  painelId: string | null;
  geradoEm: string;
  periodo: { de: string; ate: string } | null;
  anterior: { de: string; ate: string } | null;
  filtros: Record<string, unknown> | null;
  widgets: ResultadoDoWidget[];
}

const MIME_XLSX =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const TIPO_DA_UNIDADE: Record<Unidade, TipoColunaBi> = {
  NUMERO: 'numero',
  PERCENTUAL: 'percentual',
  MOEDA: 'moeda',
  DURACAO: 'segundos',
};

/**
 * Indicadores configuráveis (R33): catálogo, cálculo por widget (um erro não
 * derruba os outros), cache de 30 s por pessoa e filtros (R20.6) e exportação.
 */
@Injectable()
export class IndicadoresService {
  private readonly logger = new Logger(IndicadoresService.name);
  private readonly cache = new CacheBi<RespostaDeCalculo>(
    CACHE_INDICADORES_SEGUNDOS * 1000,
    CACHE_INDICADORES_MAXIMO,
  );

  constructor(
    private readonly prisma: PrismaService,
    private readonly paineis: PaineisIndicadoresService,
    private readonly filtros: FiltrosIndicadoresService,
    private readonly calculo: CalculoIndicadoresService,
    private readonly arquivos: ArquivosService,
    private readonly auditoria: AuditoriaService,
  ) {}

  catalogo() {
    return {
      grupos: GRUPOS.map((chave) => ({
        chave,
        rotulo: ROTULO_DO_GRUPO[chave],
      })),
      indicadores: catalogoPublico(),
      modelos: MODELOS.map((modelo) => ({
        chave: modelo.chave,
        nome: modelo.nome,
        descricao: modelo.descricao,
        quantidadeDeWidgets: modelo.widgets.length,
      })),
    };
  }

  async calcular(
    usuario: UsuarioAutenticado,
    pedido: PedidoDeCalculo,
    semCache = false,
  ): Promise<RespostaDeCalculo> {
    const entrada = await this.prepararEntrada(usuario, pedido);
    const chave = JSON.stringify([
      usuario.id,
      usuario.papel,
      usuario.area,
      entrada.painelId,
      entrada.versao,
      pedido.widgets === undefined ? null : pedido.widgets,
      entrada.filtrosPedido,
    ]);
    if (!semCache) {
      const guardado = this.cache.obter(chave);
      if (guardado) {
        return guardado;
      }
    }
    const resposta = await this.executar(usuario, entrada);
    this.cache.guardar(chave, resposta);
    return resposta;
  }

  private async prepararEntrada(
    usuario: UsuarioAutenticado,
    pedido: PedidoDeCalculo,
  ) {
    let widgets: Widget[];
    let filtrosDoPainel: FiltrosDoIndicador = {};
    let painelId: string | null = null;
    let versao: string | null = null;
    if (pedido.painelId) {
      const painel = await this.paineis.carregarVisivel(
        usuario,
        pedido.painelId,
      );
      painelId = painel.id;
      versao = painel.atualizadoEm.toISOString();
      filtrosDoPainel = painel.filtrosPadrao as FiltrosDoIndicador;
      widgets =
        pedido.widgets === undefined
          ? (painel.widgets as unknown as Widget[])
          : this.widgetsAvulsos(usuario, pedido.widgets);
    } else {
      if (pedido.widgets === undefined) {
        throw new DadosInvalidosException(
          'Informe o painel ou os indicadores.',
          {
            campos: [
              {
                campo: 'painelId',
                mensagens: ['informe "painelId" ou "widgets"'],
              },
            ],
          },
        );
      }
      widgets = this.widgetsAvulsos(usuario, pedido.widgets);
    }
    const filtrosPedido = validarFiltros(pedido.filtros, 'filtros');
    if (Object.keys(filtrosPedido).length > 0) {
      // O que a própria pessoa escolheu no topo precisa estar ao alcance dela: recusa a chamada inteira (R20.3).
      await this.filtros.resolver(usuario, filtrosPedido);
    }
    return { painelId, versao, widgets, filtrosDoPainel, filtrosPedido };
  }

  /** Indicadores enviados no corpo (prévia do editor): só quem monta painéis. */
  private widgetsAvulsos(
    usuario: UsuarioAutenticado,
    bruto: unknown,
  ): Widget[] {
    if (!podeCriarPaineis(usuario)) {
      throw new SemPermissaoException(
        'Só Admin, C-level e líderes calculam indicadores avulsos.',
        { regra: REGRA_INDICADORES },
      );
    }
    return validarWidgets(bruto);
  }

  private async executar(
    usuario: UsuarioAutenticado,
    entrada: Awaited<ReturnType<IndicadoresService['prepararEntrada']>>,
  ): Promise<RespostaDeCalculo> {
    const resolvidos = new Map<
      string,
      ReturnType<FiltrosIndicadoresService['resolver']>
    >();
    const resolver = (filtros: FiltrosDoIndicador) => {
      const chave = JSON.stringify(filtros);
      let promessa = resolvidos.get(chave);
      if (!promessa) {
        promessa = this.filtros.resolver(usuario, filtros);
        resolvidos.set(chave, promessa);
      }
      return promessa;
    };
    const geral = mesclarFiltros(
      entrada.filtrosDoPainel,
      entrada.filtrosPedido,
    );
    const resultados: ResultadoDoWidget[] = [];
    const calcularUm = async (widget: Widget): Promise<ResultadoDoWidget> => {
      try {
        const filtro = await resolver(mesclarFiltros(geral, widget.filtros));
        return await this.calculo.calcular(usuario, widget, filtro);
      } catch (erro) {
        return this.resultadoComErro(widget, erro);
      }
    };
    for (let i = 0; i < entrada.widgets.length; i += 4) {
      resultados.push(
        ...(await Promise.all(entrada.widgets.slice(i, i + 4).map(calcularUm))),
      );
    }
    let periodo: RespostaDeCalculo['periodo'] = null;
    let anterior: RespostaDeCalculo['anterior'] = null;
    let aplicados: RespostaDeCalculo['filtros'] = null;
    try {
      const filtro = await resolver(geral);
      periodo = { de: filtro.de.toISOString(), ate: filtro.ate.toISOString() };
      anterior =
        filtro.anteriorDe && filtro.anteriorAte
          ? {
              de: filtro.anteriorDe.toISOString(),
              ate: filtro.anteriorAte.toISOString(),
            }
          : null;
      aplicados = filtro.aplicados;
    } catch {
      // Filtro do painel fora do alcance: cada widget já trouxe o próprio erro.
    }
    return {
      painelId: entrada.painelId,
      geradoEm: new Date().toISOString(),
      periodo,
      anterior,
      filtros: aplicados,
      widgets: resultados,
    };
  }

  private resultadoComErro(widget: Widget, erro: unknown): ResultadoDoWidget {
    let mensagem = 'Não foi possível calcular este indicador agora.';
    let status = 500;
    if (erro instanceof ErroDoWidget || erro instanceof ErroApi) {
      mensagem = erro.message;
      status = erro instanceof ErroDoWidget ? erro.status : erro.getStatus();
    } else {
      this.logger.error(
        `Falha ao calcular o indicador ${widget.indicador}: ${erro instanceof Error ? erro.message : String(erro)}`,
      );
    }
    const definicao = catalogoPublico().find(
      (i) => i.chave === widget.indicador,
    );
    return {
      id: widget.id,
      indicador: widget.indicador,
      nome: definicao?.nome ?? widget.indicador,
      visualizacao: widget.visualizacao,
      titulo: widget.titulo?.trim() || definicao?.nome || widget.indicador,
      unidade: definicao?.unidade ?? 'NUMERO',
      melhorQuando: definicao?.melhorQuando ?? null,
      largura: widget.largura,
      ordem: widget.ordem,
      periodo: null,
      anterior: null,
      ok: false,
      erro: { mensagem, status },
    };
  }

  // -------------------------------------------------------------------------
  // Exportação (R33.7)
  // -------------------------------------------------------------------------

  async exportar(
    usuario: UsuarioAutenticado,
    pedido: PedidoDeCalculo,
    formato: 'xlsx' | 'csv',
    widgetId?: string,
  ): Promise<ArquivoDto> {
    const entrada = await this.prepararEntrada(usuario, pedido);
    const calculado = await this.executar(usuario, entrada);
    const tabelas = this.tabelasDe(calculado);
    let escolhidas: TabelaBi[];
    let conteudo: Buffer;
    if (widgetId) {
      const tabela = tabelas.porWidget.get(widgetId);
      if (!tabela) {
        throw widgetId && calculado.widgets.some((w) => w.id === widgetId)
          ? new DadosInvalidosException(
              'Este indicador é um número só: ele já está no resumo do painel.',
            )
          : new NaoEncontradoException('Indicador não encontrado no painel.');
      }
      escolhidas = [tabela];
    } else {
      escolhidas =
        formato === 'csv'
          ? [tabelas.resumo]
          : [tabelas.resumo, ...tabelas.porWidget.values()];
    }
    if (formato === 'csv') {
      conteudo = Buffer.from(tabelaComoCsv(escolhidas[0]), 'utf8');
    } else {
      conteudo = await montarXlsxDeTabelas(escolhidas, [
        ['Painel', entrada.painelId ?? 'Indicadores avulsos'],
        ['De', calculado.periodo?.de ?? ''],
        ['Até (exclusivo)', calculado.periodo?.ate ?? ''],
        ['Gerado em', calculado.geradoEm],
      ]);
    }
    const linhas = escolhidas.reduce((soma, t) => soma + t.linhas.length, 0);
    const hoje = new Date().toISOString().slice(0, 10);
    const arquivo = await this.arquivos.salvar(conteudo, {
      nome: `indicadores-${hoje}.${formato}`,
      mime: formato === 'csv' ? 'text/csv' : MIME_XLSX,
      contexto: 'RELATORIO',
      criadoPorId: usuario.id,
    });
    await this.prisma.$transaction((tx) =>
      this.auditoria.registrar(tx, {
        acao: 'indicadores.exportado',
        entidade: 'painel_indicadores',
        entidadeId: entrada.painelId ?? undefined,
        resumo: `${usuario.nome} exportou indicadores (${formato.toUpperCase()}${widgetId ? ', um indicador' : ''})`,
        dados: {
          painelId: entrada.painelId,
          formato,
          widgetId: widgetId ?? null,
          linhas,
          arquivoId: arquivo.id,
          periodo: calculado.periodo,
          setor: setorDaPessoa(usuario),
          regra: REGRA_INDICADORES,
        },
      }),
    );
    return ArquivoDto.de(arquivo);
  }

  /** Um resumo (um indicador por linha) e uma tabela por widget que não é um número só. */
  private tabelasDe(calculado: RespostaDeCalculo): {
    resumo: TabelaBi;
    porWidget: Map<string, TabelaBi>;
  } {
    const coluna = (chave: string, rotulo: string, tipo: TipoColunaBi) => ({
      chave,
      rotulo,
      tipo,
      visivel: true,
    });
    const resumo: TabelaBi = {
      chave: 'resumo',
      titulo: 'Indicadores',
      dica: 'Valor de cada indicador do painel.',
      colunas: [
        coluna('indicador', 'Indicador', 'texto'),
        coluna('valor', 'Valor', 'numero'),
        coluna('anterior', 'Período anterior', 'numero'),
        coluna('variacao', 'Variação (%)', 'numero'),
        coluna('unidade', 'Unidade', 'texto'),
        coluna('meta', 'Meta', 'numero'),
        coluna('progresso', 'Progresso da meta (%)', 'numero'),
        coluna('observacao', 'Observação', 'texto'),
      ],
      linhas: calculado.widgets.map((w) => ({
        indicador: w.titulo,
        valor: w.visualizacao === 'NUMERO' ? (w.valor ?? null) : null,
        anterior: w.valorAnterior ?? null,
        variacao: w.variacao ?? null,
        unidade: w.unidade,
        meta: w.meta?.alvo ?? null,
        progresso: w.meta?.progresso ?? null,
        observacao: w.ok
          ? w.visualizacao === 'NUMERO'
            ? null
            : 'Veja a aba deste indicador'
          : `Não calculado: ${w.erro?.mensagem ?? 'erro'}`,
      })),
    };
    const porWidget = new Map<string, TabelaBi>();
    for (const w of calculado.widgets) {
      if (!w.ok || w.visualizacao === 'NUMERO') {
        continue;
      }
      const tipo = TIPO_DA_UNIDADE[w.unidade];
      const titulo = w.titulo;
      if (w.visualizacao === 'SERIE') {
        porWidget.set(w.id, {
          chave: w.id,
          titulo,
          dica: titulo,
          colunas: [
            coluna('periodo', 'Período', 'texto'),
            coluna('valor', 'Valor', tipo),
          ],
          linhas: (w.pontos ?? []).map((p) => ({
            periodo: p.chave,
            valor: p.valor,
          })),
        });
      } else if (w.visualizacao === 'FUNIL') {
        porWidget.set(w.id, {
          chave: w.id,
          titulo,
          dica: titulo,
          colunas: [
            coluna('etapa', 'Etapa', 'texto'),
            coluna('valor', 'Negócios', 'numero'),
            coluna(
              'conversao',
              'Conversão sobre a etapa anterior (%)',
              'numero',
            ),
            coluna('total', 'Conversão sobre a primeira etapa (%)', 'numero'),
          ],
          linhas: (w.linhas ?? []).map((l) => ({
            etapa: l.rotulo,
            valor: l.valor,
            conversao: l.conversao ?? null,
            total: l.conversaoTotal ?? null,
          })),
        });
      } else {
        const rotulo =
          w.visualizacao === 'RANKING'
            ? 'Pessoa'
            : w.visualizacao === 'POR_ETAPA'
              ? 'Etapa'
              : 'Categoria';
        const comMeta = (w.linhas ?? []).some((l) => l.meta);
        porWidget.set(w.id, {
          chave: w.id,
          titulo,
          dica: titulo,
          colunas: [
            coluna('rotulo', rotulo, 'texto'),
            coluna('valor', 'Valor', tipo),
            ...(comMeta
              ? [
                  coluna('meta', 'Meta', tipo),
                  coluna('progresso', 'Progresso da meta (%)', 'numero'),
                ]
              : []),
          ],
          linhas: (w.linhas ?? []).map((l) => ({
            rotulo: l.rotulo,
            valor: l.valor,
            meta: l.meta?.alvo ?? null,
            progresso: l.meta?.progresso ?? null,
          })),
        });
      }
    }
    return { resumo, porWidget };
  }
}
