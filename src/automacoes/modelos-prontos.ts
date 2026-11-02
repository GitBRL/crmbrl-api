/**
 * Modelos prontos de automação (o front oferece como ponto de partida):
 * `POST /automacoes/modelos-prontos/:chave` cria uma automação pausada a partir
 * deles. O que depende da conta (etapa, funil, pessoas) fica em `pendencias`.
 */
import type { Area } from '../generated/prisma/client';

export interface ModeloPronto {
  chave: string;
  nome: string;
  descricao: string;
  /** Áreas que costumam usar (a tela destaca). */
  areas: Area[];
  /** O que a pessoa precisa preencher antes de ativar. */
  aConfigurar: string[];
  automacao: {
    tipoGatilho: 'EVENTO' | 'DATA_RELATIVA' | 'RECORRENCIA';
    evento?: string;
    gatilhoConfig: Record<string, unknown>;
    entidade: 'contato' | 'negocio' | 'atividade' | 'conversa';
    condicoes: Record<string, unknown>;
    definicao: { passos: unknown[] };
    criteriosParada: string[];
    limiteExecucao: 'UMA_VEZ' | 'UMA_VEZ_POR_PERIODO' | 'SEMPRE';
    limitePeriodoDias?: number;
    marketing: boolean;
  };
}

export const MODELOS_PRONTOS: readonly ModeloPronto[] = [
  {
    chave: 'boas_vindas_lead',
    nome: 'Boas-vindas ao lead',
    descricao:
      'Quando um contato novo chega, manda uma mensagem de boas-vindas no WhatsApp e cria uma tarefa de primeiro contato se ele não responder.',
    areas: ['MARKETING', 'COMERCIAL'],
    aConfigurar: [],
    automacao: {
      tipoGatilho: 'EVENTO',
      evento: 'contato.criado',
      gatilhoConfig: {},
      entidade: 'contato',
      condicoes: {},
      definicao: {
        passos: [
          {
            id: 'boas_vindas',
            tipo: 'acao.whatsapp',
            rotulo: 'Mensagem de boas-vindas',
            config: {
              texto:
                'Olá, {{contato.primeiro_nome|tudo bem}}! {Recebemos seu contato|Obrigado por falar com a gente}. Em instantes nossa equipe retorna por aqui.',
            },
          },
          {
            id: 'espera',
            tipo: 'aguardar',
            config: { quantidade: 1, unidade: 'horas' },
          },
          {
            id: 'tarefa',
            tipo: 'acao.atividade',
            rotulo: 'Primeiro contato',
            config: {
              tipo: 'LIGACAO',
              titulo: 'Primeiro contato com {{contato.nome}}',
              prioridade: 'ALTA',
              prazo: { quantidade: 1, unidade: 'horas' },
            },
          },
        ],
      },
      criteriosParada: ['RESPONDEU'],
      limiteExecucao: 'UMA_VEZ',
      marketing: false,
    },
  },
  {
    chave: 'follow_up_proposta',
    nome: 'Follow-up de proposta',
    descricao:
      'Quando o negócio entra na etapa da proposta, espera 2 dias e lembra o cliente; se nada acontecer, cria uma tarefa para o responsável.',
    areas: ['COMERCIAL'],
    aConfigurar: ['Etapa de proposta (gatilho)'],
    automacao: {
      tipoGatilho: 'EVENTO',
      evento: 'negocio.movido',
      gatilhoConfig: {},
      entidade: 'negocio',
      condicoes: {},
      definicao: {
        passos: [
          {
            id: 'espera_1',
            tipo: 'aguardar',
            config: { quantidade: 2, unidade: 'dias' },
          },
          {
            id: 'lembrete',
            tipo: 'acao.whatsapp',
            rotulo: 'Lembrete da proposta',
            config: {
              texto:
                '{{contato.primeiro_nome|Olá}}, conseguiu avaliar a proposta de {{negocio.titulo}}? Fico à disposição para tirar qualquer dúvida.',
            },
          },
          {
            id: 'espera_2',
            tipo: 'aguardar',
            config: { quantidade: 3, unidade: 'dias' },
          },
          {
            id: 'tarefa',
            tipo: 'acao.atividade',
            rotulo: 'Ligar sobre a proposta',
            config: {
              tipo: 'LIGACAO',
              titulo: 'Ligar para {{contato.nome}} sobre a proposta',
              prioridade: 'ALTA',
              prazo: { quantidade: 1, unidade: 'dias' },
            },
          },
        ],
      },
      criteriosParada: ['RESPONDEU', 'GANHOU', 'PERDEU'],
      limiteExecucao: 'UMA_VEZ',
      marketing: false,
    },
  },
  {
    chave: 'lembrete_renovacao',
    nome: 'Lembrete de renovação',
    descricao:
      '30 dias antes da data de renovação (campo personalizado do contato), avisa o responsável e cria uma tarefa de renovação.',
    areas: ['CS'],
    aConfigurar: ['Campo de data de renovação do contato'],
    automacao: {
      tipoGatilho: 'DATA_RELATIVA',
      gatilhoConfig: {
        campo: 'contato.campos.renovacao_em',
        dias: -30,
        hora: '09:00',
      },
      entidade: 'contato',
      condicoes: {},
      definicao: {
        passos: [
          {
            id: 'aviso',
            tipo: 'acao.notificar',
            config: {
              para: 'responsavel',
              titulo: 'Renovação de {{contato.nome}} em 30 dias',
              texto: 'Combine a renovação com o cliente.',
            },
          },
          {
            id: 'tarefa',
            tipo: 'acao.atividade',
            rotulo: 'Conversar sobre a renovação',
            config: {
              tipo: 'TAREFA',
              titulo: 'Renovação de {{contato.nome}}',
              prazo: { quantidade: 7, unidade: 'dias' },
            },
          },
        ],
      },
      criteriosParada: [],
      limiteExecucao: 'UMA_VEZ_POR_PERIODO',
      limitePeriodoDias: 300,
      marketing: false,
    },
  },
  {
    chave: 'reativacao',
    nome: 'Reativação de contatos parados',
    descricao:
      'Todo mês, chama no WhatsApp quem não conversa com a empresa há mais de 90 dias (respeita quem pediu para não receber).',
    areas: ['MARKETING', 'CS'],
    aConfigurar: [],
    automacao: {
      tipoGatilho: 'RECORRENCIA',
      gatilhoConfig: { frequencia: 'mensal', diaDoMes: 1, hora: '10:00' },
      entidade: 'contato',
      condicoes: {
        segmento: {
          combinacao: 'todas',
          condicoes: [
            {
              campo: 'ultima_interacao_em',
              operador: 'mais_de_dias',
              valor: 90,
            },
          ],
        },
        horario: {
          fusoHorario: 'America/Sao_Paulo',
          dias: {
            '1': [{ inicio: '09:00', fim: '18:00' }],
            '2': [{ inicio: '09:00', fim: '18:00' }],
            '3': [{ inicio: '09:00', fim: '18:00' }],
            '4': [{ inicio: '09:00', fim: '18:00' }],
            '5': [{ inicio: '09:00', fim: '18:00' }],
          },
        },
      },
      definicao: {
        passos: [
          {
            id: 'mensagem',
            tipo: 'acao.whatsapp',
            rotulo: 'Convite para retomar',
            config: {
              texto:
                '{{contato.primeiro_nome|Olá}}, sentimos sua falta! {Temos novidades que podem te interessar|Posso te contar o que mudou por aqui?} Responda esta mensagem para conversarmos.',
            },
          },
        ],
      },
      criteriosParada: ['RESPONDEU'],
      limiteExecucao: 'UMA_VEZ_POR_PERIODO',
      limitePeriodoDias: 90,
      marketing: true,
    },
  },
];

export function modeloPronto(chave: string): ModeloPronto | undefined {
  return MODELOS_PRONTOS.find((m) => m.chave === chave);
}
