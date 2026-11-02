/**
 * Configuração inicial do CRM: funis-base e etapas (R5.2), passagens (R5.7) e
 * regras de distribuição. As `chave`s identificam o que foi criado aqui, mesmo
 * que alguém renomeie depois.
 */
import type {
  Area,
  EstrategiaDistribuicao,
  TipoEtapa,
} from '../generated/prisma/client';

export interface EtapaInicial {
  readonly chave: string;
  readonly nome: string;
  readonly tipo: TipoEtapa;
  /** Prazo-alvo em dias; `null` = sem prazo. */
  readonly prazoDias: number | null;
}

export interface FunilInicial {
  readonly area: Area;
  readonly nome: string;
  readonly ordem: number;
  readonly descricao: string;
  readonly etapas: readonly EtapaInicial[];
}

export const FUNIS_BASE: readonly FunilInicial[] = [
  {
    area: 'MARKETING',
    nome: 'Marketing',
    ordem: 1,
    descricao: 'Capta e qualifica leads antes de passá-los ao Comercial.',
    etapas: [
      { chave: 'novo_lead', nome: 'Novo lead', tipo: 'ABERTA', prazoDias: 2 },
      { chave: 'em_contato', nome: 'Em contato', tipo: 'ABERTA', prazoDias: 5 },
      { chave: 'nutricao', nome: 'Nutrição', tipo: 'ABERTA', prazoDias: 15 },
      {
        chave: 'qualificado_mql',
        nome: 'Qualificado (MQL)',
        tipo: 'GANHO',
        prazoDias: null,
      },
      {
        chave: 'descartado',
        nome: 'Descartado',
        tipo: 'PERDIDO',
        prazoDias: null,
      },
    ],
  },
  {
    area: 'COMERCIAL',
    nome: 'Comercial',
    ordem: 2,
    descricao: 'Acompanha cada oportunidade até o fechamento.',
    etapas: [
      { chave: 'novo', nome: 'Novo', tipo: 'ABERTA', prazoDias: 1 },
      {
        chave: 'qualificacao',
        nome: 'Qualificação',
        tipo: 'ABERTA',
        prazoDias: 5,
      },
      {
        chave: 'apresentacao',
        nome: 'Apresentação',
        tipo: 'ABERTA',
        prazoDias: 7,
      },
      { chave: 'proposta', nome: 'Proposta', tipo: 'ABERTA', prazoDias: 7 },
      {
        chave: 'negociacao',
        nome: 'Negociação',
        tipo: 'ABERTA',
        prazoDias: 10,
      },
      { chave: 'ganho', nome: 'Ganho', tipo: 'GANHO', prazoDias: null },
      { chave: 'perdido', nome: 'Perdido', tipo: 'PERDIDO', prazoDias: null },
    ],
  },
  {
    area: 'CS',
    nome: 'Customer Success',
    ordem: 3,
    descricao: 'Garante que cada cliente tenha sucesso depois da venda.',
    etapas: [
      {
        chave: 'boas_vindas',
        nome: 'Boas-vindas',
        tipo: 'ABERTA',
        prazoDias: 2,
      },
      {
        chave: 'onboarding',
        nome: 'Onboarding',
        tipo: 'ABERTA',
        prazoDias: 15,
      },
      {
        chave: 'implantacao',
        nome: 'Implantação',
        tipo: 'ABERTA',
        prazoDias: 30,
      },
      {
        chave: 'acompanhamento',
        nome: 'Acompanhamento',
        tipo: 'ABERTA',
        prazoDias: null,
      },
      { chave: 'renovacao', nome: 'Renovação', tipo: 'ABERTA', prazoDias: 30 },
      { chave: 'renovado', nome: 'Renovado', tipo: 'GANHO', prazoDias: null },
      {
        chave: 'cancelado',
        nome: 'Cancelado (churn)',
        tipo: 'PERDIDO',
        prazoDias: null,
      },
    ],
  },
];

export interface PassagemInicial {
  readonly chave: string;
  readonly nome: string;
  readonly origem: { readonly area: Area; readonly etapa: string };
  readonly destino: { readonly area: Area; readonly etapa: string };
  readonly estrategia: EstrategiaDistribuicao;
}

/** Passagens da tabela R5.7. */
export const PASSAGENS_INICIAIS: readonly PassagemInicial[] = [
  {
    chave: 'marketing_comercial',
    nome: 'Marketing → Comercial',
    origem: { area: 'MARKETING', etapa: 'qualificado_mql' },
    destino: { area: 'COMERCIAL', etapa: 'novo' },
    estrategia: 'RODIZIO',
  },
  {
    chave: 'comercial_cs',
    nome: 'Comercial → Customer Success',
    origem: { area: 'COMERCIAL', etapa: 'ganho' },
    destino: { area: 'CS', etapa: 'boas_vindas' },
    estrategia: 'RODIZIO',
  },
];

/** Uma regra de rodízio por área (R5.8), sem líderes por padrão. */
export const AREAS_COM_RODIZIO: readonly Area[] = [
  'MARKETING',
  'COMERCIAL',
  'CS',
];
