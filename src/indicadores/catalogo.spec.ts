import {
  CATALOGO,
  DIMENSOES_DE_BARRAS,
  catalogoPublico,
  indicadorDoCatalogo,
} from './catalogo';
import { GRUPOS, UNIDADES, VISUALIZACOES } from './indicadores.tipos';
import { MODELOS } from './modelos';
import { validarWidgets } from './validacao-widgets';

const CHAVES_MINIMAS = [
  'leads_recebidos',
  'leads_atendidos',
  'taxa_atendimento',
  'tempo_ate_atendimento',
  'leads_sem_atendimento',
  'reunioes_agendadas',
  'reunioes_realizadas',
  'reunioes_no_show',
  'reunioes_remarcadas',
  'reunioes_sem_resultado',
  'taxa_comparecimento',
  'taxa_no_show',
  'negocios_ganhos',
  'valor_ganho',
  'ticket_medio',
  'negocios_perdidos',
  'perdas_por_motivo',
  'taxa_conversao',
  'taxa_conversao_coorte',
  'conversao_entre_etapas',
  'ciclo_medio',
  'negocios_abertos',
  'valor_em_aberto',
  'ligacoes_feitas',
  'ligacoes_atendidas',
  'taxa_atendimento_ligacoes',
  'duracao_media_ligacao',
  'tempo_falado',
  'atividades_concluidas',
  'atividades_atrasadas',
];

describe('catálogo de indicadores (R33.1)', () => {
  it('R33.1 — traz todos os indicadores do contrato, sem repetir chave', () => {
    const chaves = CATALOGO.map((i) => i.chave);
    expect(new Set(chaves).size).toBe(chaves.length);
    for (const chave of CHAVES_MINIMAS) {
      expect(chaves).toContain(chave);
    }
  });

  it('R33.1 — cada indicador tem nome, descrição, grupo, unidade e visualizações válidos', () => {
    for (const item of CATALOGO) {
      expect(item.nome.length).toBeGreaterThan(2);
      expect(item.descricao.length).toBeGreaterThan(10);
      expect(GRUPOS).toContain(item.grupo);
      expect(UNIDADES).toContain(item.unidade);
      expect(item.visualizacoes.length).toBeGreaterThan(0);
      for (const v of item.visualizacoes) {
        expect(VISUALIZACOES).toContain(v);
      }
    }
  });

  it('R33.2 — retrato de agora não aceita série; barras só com dimensões conhecidas da própria fonte', () => {
    for (const item of CATALOGO) {
      if (item.agora) {
        expect(item.visualizacoes).not.toContain('SERIE');
      }
      expect(item.visualizacoes.includes('BARRAS')).toBe(
        item.barras.length > 0,
      );
      for (const por of item.barras) {
        expect(DIMENSOES_DE_BARRAS[por]?.fonte).toBe(item.calculo.fonte);
      }
    }
  });

  it('R33.2 — POR_ETAPA só em indicadores de negócio; ranking sempre tem uma pessoa para agrupar', () => {
    for (const item of CATALOGO) {
      if (item.visualizacoes.includes('POR_ETAPA')) {
        expect(item.calculo.fonte).toBe('NEGOCIO');
      }
    }
    expect(
      indicadorDoCatalogo('conversao_entre_etapas')?.visualizacoes,
    ).toEqual(['NUMERO', 'FUNIL']);
  });

  it('R33.1 — a lista pública não vaza a parte de cálculo', () => {
    for (const item of catalogoPublico()) {
      expect('calculo' in item).toBe(false);
      expect(JSON.stringify(item)).not.toContain('SELECT');
    }
  });

  it('R33.1 — durações são em segundos e a conversão entre etapas pede as duas etapas', () => {
    expect(indicadorDoCatalogo('tempo_ate_atendimento')?.unidade).toBe(
      'DURACAO',
    );
    const conversao = indicadorDoCatalogo('conversao_entre_etapas')!;
    expect(
      conversao.parametros
        .filter((p) => p.obrigatorioEm?.includes('NUMERO'))
        .map((p) => p.chave),
    ).toEqual(['etapaOrigemId', 'etapaDestinoId']);
  });

  it('R33.6 — o modelo "Time comercial" só usa indicadores e visualizações do catálogo e passa na validação', () => {
    const modelo = MODELOS.find((m) => m.chave === 'time_comercial')!;
    expect(modelo.widgets.length).toBeGreaterThanOrEqual(12);
    const validados = validarWidgets(modelo.widgets);
    expect(validados).toHaveLength(modelo.widgets.length);
    const indicadores = validados.map((w) => w.indicador);
    for (const esperado of [
      'leads_recebidos',
      'leads_atendidos',
      'taxa_atendimento',
      'tempo_ate_atendimento',
      'reunioes_agendadas',
      'reunioes_realizadas',
      'reunioes_no_show',
      'taxa_comparecimento',
      'taxa_no_show',
      'taxa_conversao',
      'negocios_ganhos',
      'valor_ganho',
      'ligacoes_feitas',
    ]) {
      expect(indicadores).toContain(esperado);
    }
    expect(
      validados.some(
        (w) =>
          w.visualizacao === 'RANKING' && w.indicador === 'negocios_ganhos',
      ),
    ).toBe(true);
  });
});
