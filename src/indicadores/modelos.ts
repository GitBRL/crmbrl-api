/**
 * Modelos prontos de painel (R33.6). Hoje só "Time comercial": os indicadores que o
 * time comercial acompanha, criados com um clique e depois editáveis como qualquer painel.
 */
import type { Visualizacao, Widget } from './indicadores.tipos';

export interface ModeloDePainel {
  chave: string;
  nome: string;
  descricao: string;
  /** Painel criado: nome e descrição padrão. */
  widgets: (Omit<Widget, 'id' | 'ordem' | 'largura'> & {
    largura?: 1 | 2 | 3;
  })[];
}

function numero(
  indicador: string,
  titulo?: string,
  parametros: Record<string, string> = {},
): ModeloDePainel['widgets'][number] {
  return {
    indicador,
    visualizacao: 'NUMERO',
    parametros,
    ...(titulo ? { titulo } : {}),
    largura: 1,
  };
}

function grafico(
  indicador: string,
  visualizacao: Visualizacao,
  titulo: string,
  largura: 1 | 2 | 3,
  parametros: Record<string, string> = {},
): ModeloDePainel['widgets'][number] {
  return { indicador, visualizacao, parametros, titulo, largura };
}

export const MODELO_TIME_COMERCIAL: ModeloDePainel = {
  chave: 'time_comercial',
  nome: 'Time comercial',
  descricao:
    'Leads, atendimento, reuniões, no-show, conversão, ganhos, ligações e mensagens do time comercial.',
  widgets: [
    numero('leads_recebidos'),
    numero('leads_atendidos'),
    numero('taxa_atendimento'),
    numero('tempo_ate_atendimento', undefined, { estatistica: 'MEDIANA' }),
    numero('reunioes_agendadas'),
    numero('reunioes_realizadas'),
    numero('reunioes_no_show'),
    numero('taxa_comparecimento'),
    numero('taxa_no_show'),
    numero('taxa_conversao'),
    numero('negocios_ganhos'),
    numero('valor_ganho'),
    grafico('leads_recebidos', 'SERIE', 'Leads recebidos por dia', 2, {
      agrupamento: 'DIA',
    }),
    grafico('negocios_ganhos', 'RANKING', 'Ganhos por vendedor', 1),
    grafico('valor_ganho', 'RANKING', 'Valor ganho por vendedor', 1),
    grafico('leads_recebidos', 'RANKING', 'Leads por vendedor', 1),
    grafico('negocios_abertos', 'POR_ETAPA', 'Leads por etapa', 1),
    numero('ligacoes_feitas'),
    grafico('ligacoes_feitas', 'RANKING', 'Ligações por vendedor', 1),
    numero('taxa_atendimento_ligacoes'),
    numero('duracao_media_ligacao'),
    numero('mensagens_enviadas'),
    grafico('mensagens_enviadas', 'RANKING', 'Mensagens por vendedor', 1),
  ],
};

export const MODELOS: readonly ModeloDePainel[] = [MODELO_TIME_COMERCIAL];

export function modeloDePainel(chave: string): ModeloDePainel | undefined {
  return MODELOS.find((modelo) => modelo.chave === chave);
}
