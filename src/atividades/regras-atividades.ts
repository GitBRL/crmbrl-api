/**
 * Regras das atividades (R6) em funções puras — usadas pelo serviço, pelo job
 * de lembretes e pelos testes de unidade.
 *
 * Convenções do módulo:
 * - **data da atividade** = `venceEm`. Na reunião (R6.1), a API grava em
 *   `venceEm` o próprio início: é o que ordena a agenda, define o grupo
 *   ("hoje", "próximos 7 dias"…) e marca o lembrete de 1 hora antes (R6.5);
 * - **prazo** = o momento a partir do qual a pendente está atrasada (R6.3):
 *   o vencimento; na reunião, o fim (uma reunião em andamento não está
 *   atrasada).
 */
import { ehDiretoria, ehLider } from '../comum/dominio/papeis';
import type { ProblemaDeCampo } from '../comum/validacao/validacao';
import { podeVerNegocio as podeVerNegocioDoFunil } from '../funis/acesso-funis';
import type {
  Area,
  Papel,
  Prisma,
  StatusAtividade,
  TipoAtividade,
} from '../generated/prisma/client';
import { type LimitesDoCalendario, limitesDoCalendario } from './fuso-horario';

// ---------------------------------------------------------------------------
// Textos
// ---------------------------------------------------------------------------

interface DescricaoDoTipo {
  /** Para o começo de frase: `Tarefa`, `E-mail`. */
  readonly rotulo: string;
  /** Para o meio de frase: `tarefa`, `e-mail`. */
  readonly nome: string;
  readonly feminino: boolean;
}

const TIPOS: Readonly<Record<TipoAtividade, DescricaoDoTipo>> = {
  TAREFA: { rotulo: 'Tarefa', nome: 'tarefa', feminino: true },
  LIGACAO: { rotulo: 'Ligação', nome: 'ligação', feminino: true },
  REUNIAO: { rotulo: 'Reunião', nome: 'reunião', feminino: true },
  EMAIL: { rotulo: 'E-mail', nome: 'e-mail', feminino: false },
  WHATSAPP: { rotulo: 'WhatsApp', nome: 'WhatsApp', feminino: false },
  NOTA: { rotulo: 'Nota', nome: 'nota', feminino: true },
};

export function rotuloDoTipo(tipo: TipoAtividade): string {
  return TIPOS[tipo].rotulo;
}

/** `A tarefa`, `O e-mail` — para os textos das notificações. */
export function tipoComArtigo(tipo: TipoAtividade): string {
  const { nome, feminino } = TIPOS[tipo];
  return `${feminino ? 'A' : 'O'} ${nome}`;
}

/** Particípio concordando com o tipo: `flexionar('EMAIL', 'criad')` → `criado`. */
export function flexionar(tipo: TipoAtividade, raiz: string): string {
  return `${raiz}${TIPOS[tipo].feminino ? 'a' : 'o'}`;
}

// ---------------------------------------------------------------------------
// Atraso (R6.3) e agrupamentos
// ---------------------------------------------------------------------------

/** O mínimo de uma atividade para calcular atraso e grupo. */
export interface DatasDaAtividade {
  readonly tipo: TipoAtividade;
  readonly status: StatusAtividade;
  readonly venceEm: Date | null;
  readonly fimEm: Date | null;
}

/** A partir de quando a pendente está atrasada: o vencimento; na reunião, o fim. */
export function prazoDaAtividade(
  atividade: Pick<DatasDaAtividade, 'tipo' | 'venceEm' | 'fimEm'>,
): Date | null {
  if (atividade.tipo === 'REUNIAO') {
    return atividade.fimEm ?? atividade.venceEm;
  }
  return atividade.venceEm;
}

/** R6.3 — "atrasada" é a pendente com o prazo no passado (calculado, nunca gravado). */
export function ehAtrasada(atividade: DatasDaAtividade, agora: Date): boolean {
  if (atividade.status !== 'PENDENTE') {
    return false;
  }
  const prazo = prazoDaAtividade(atividade);
  return prazo !== null && prazo.getTime() < agora.getTime();
}

/**
 * Agrupamentos da agenda, na ordem em que o front os mostra. São exclusivos:
 * cada atividade pendente cai em exatamente um dos cinco primeiros; as
 * concluídas, no último. Canceladas e notas não entram em nenhum.
 */
export const GRUPOS_DE_ATIVIDADES = [
  'ATRASADAS',
  'HOJE',
  'PROXIMOS_7_DIAS',
  'MAIS_TARDE',
  'SEM_DATA',
  'CONCLUIDAS',
] as const;

export type GrupoAtividade = (typeof GRUPOS_DE_ATIVIDADES)[number];

export const ROTULO_DO_GRUPO: Readonly<Record<GrupoAtividade, string>> = {
  ATRASADAS: 'Atrasadas',
  HOJE: 'Hoje',
  PROXIMOS_7_DIAS: 'Próximos 7 dias',
  MAIS_TARDE: 'Mais tarde',
  SEM_DATA: 'Sem data',
  CONCLUIDAS: 'Concluídas',
};

/** O "agora" e os limites do calendário no fuso de quem consulta. */
export interface ReferenciaDeTempo extends LimitesDoCalendario {
  readonly agora: Date;
  readonly fusoHorario: string;
}

export function referenciaDeTempo(
  agora: Date,
  fusoHorario: string,
): ReferenciaDeTempo {
  return { agora, fusoHorario, ...limitesDoCalendario(agora, fusoHorario) };
}

/**
 * Grupo da atividade (ou `null` para nota e cancelada):
 * - `ATRASADAS`: pendente com o prazo no passado (R6.3);
 * - `HOJE`: pendente, no prazo, com data até o fim de hoje (inclui a reunião em andamento);
 * - `PROXIMOS_7_DIAS`: data de amanhã até hoje + 7 dias;
 * - `MAIS_TARDE`: data depois disso;
 * - `SEM_DATA`: pendente sem data;
 * - `CONCLUIDAS`: concluída.
 */
export function grupoDaAtividade(
  atividade: DatasDaAtividade,
  referencia: ReferenciaDeTempo,
): GrupoAtividade | null {
  if (atividade.tipo === 'NOTA') {
    return null;
  }
  if (atividade.status === 'CONCLUIDA') {
    return 'CONCLUIDAS';
  }
  if (atividade.status !== 'PENDENTE') {
    return null;
  }
  if (ehAtrasada(atividade, referencia.agora)) {
    return 'ATRASADAS';
  }
  if (!atividade.venceEm) {
    return 'SEM_DATA';
  }
  const data = atividade.venceEm.getTime();
  if (data < referencia.inicioDeAmanha.getTime()) {
    return 'HOJE';
  }
  if (data < referencia.fimDosProximos7Dias.getTime()) {
    return 'PROXIMOS_7_DIAS';
  }
  return 'MAIS_TARDE';
}

/**
 * Filtro Prisma das atrasadas (R6.3) — o mesmo critério de `ehAtrasada`. As
 * condições são escritas sem `NOT`, que no SQL descartaria as linhas com data
 * nula.
 */
export function condicaoAtrasada(agora: Date): Prisma.AtividadeWhereInput {
  return {
    status: 'PENDENTE',
    OR: [
      { tipo: { not: 'REUNIAO' }, venceEm: { lt: agora } },
      { tipo: 'REUNIAO', fimEm: { lt: agora } },
      { tipo: 'REUNIAO', fimEm: null, venceEm: { lt: agora } },
    ],
  };
}

/** Filtro Prisma das que não estão atrasadas (o complemento exato de `condicaoAtrasada`). */
export function condicaoNaoAtrasada(agora: Date): Prisma.AtividadeWhereInput {
  return {
    OR: [
      { status: { not: 'PENDENTE' } },
      { tipo: { not: 'REUNIAO' }, venceEm: null },
      { tipo: { not: 'REUNIAO' }, venceEm: { gte: agora } },
      { tipo: 'REUNIAO', fimEm: { gte: agora } },
      { tipo: 'REUNIAO', fimEm: null, venceEm: null },
      { tipo: 'REUNIAO', fimEm: null, venceEm: { gte: agora } },
    ],
  };
}

/** Filtro Prisma de um grupo — o mesmo critério de `grupoDaAtividade`. */
export function condicaoDoGrupo(
  grupo: GrupoAtividade,
  referencia: ReferenciaDeTempo,
): Prisma.AtividadeWhereInput {
  const { agora, inicioDeAmanha, fimDosProximos7Dias } = referencia;
  const semNotas: Prisma.AtividadeWhereInput = { tipo: { not: 'NOTA' } };
  const pendentes: Prisma.AtividadeWhereInput = {
    ...semNotas,
    status: 'PENDENTE',
  };
  switch (grupo) {
    case 'ATRASADAS':
      return { AND: [semNotas, condicaoAtrasada(agora)] };
    case 'HOJE':
      return {
        AND: [
          pendentes,
          condicaoNaoAtrasada(agora),
          { venceEm: { lt: inicioDeAmanha } },
        ],
      };
    case 'PROXIMOS_7_DIAS':
      return {
        AND: [
          pendentes,
          condicaoNaoAtrasada(agora),
          { venceEm: { gte: inicioDeAmanha, lt: fimDosProximos7Dias } },
        ],
      };
    case 'MAIS_TARDE':
      return {
        AND: [
          pendentes,
          condicaoNaoAtrasada(agora),
          { venceEm: { gte: fimDosProximos7Dias } },
        ],
      };
    case 'SEM_DATA':
      return {
        AND: [pendentes, condicaoNaoAtrasada(agora), { venceEm: null }],
      };
    case 'CONCLUIDAS':
      return { ...semNotas, status: 'CONCLUIDA' };
  }
}

/** Ordem de cada grupo na agenda (com o id para desempatar de forma estável). */
export function ordemDoGrupo(
  grupo: GrupoAtividade,
): Prisma.AtividadeOrderByWithRelationInput[] {
  switch (grupo) {
    case 'SEM_DATA':
      return [{ prioridade: 'desc' }, { criadoEm: 'desc' }, { id: 'asc' }];
    case 'CONCLUIDAS':
      return [{ concluidaEm: { sort: 'desc', nulls: 'last' } }, { id: 'asc' }];
    default:
      return [
        { venceEm: { sort: 'asc', nulls: 'last' } },
        { criadoEm: 'asc' },
        { id: 'asc' },
      ];
  }
}

// ---------------------------------------------------------------------------
// Visibilidade (R6.4)
// ---------------------------------------------------------------------------

export interface QuemConsulta {
  readonly id: string;
  readonly papel: Papel;
}

/**
 * R6.4 — veem a atividade: o responsável, quem criou, o líder do responsável
 * (o líder da área responde pela própria equipe, como na matriz da seção 12:
 * "da equipe"), o C-level e o Admin.
 */
export function filtroDeVisibilidade(
  usuario: QuemConsulta,
): Prisma.AtividadeWhereInput {
  if (ehDiretoria(usuario.papel)) {
    return {};
  }
  const condicoes: Prisma.AtividadeWhereInput[] = [
    { responsavelId: usuario.id },
    { criadoPorId: usuario.id },
  ];
  if (ehLider(usuario.papel)) {
    condicoes.push({ responsavel: { liderId: usuario.id } });
  }
  return { OR: condicoes };
}

/** A mesma regra de `filtroDeVisibilidade`, para uma atividade já carregada. */
export function podeVerAtividade(
  usuario: QuemConsulta,
  atividade: {
    readonly responsavelId: string;
    readonly criadoPorId: string | null;
    /** `liderId` do responsável. */
    readonly liderDoResponsavelId: string | null;
  },
): boolean {
  if (ehDiretoria(usuario.papel)) {
    return true;
  }
  if (
    atividade.responsavelId === usuario.id ||
    atividade.criadoPorId === usuario.id
  ) {
    return true;
  }
  return (
    ehLider(usuario.papel) && atividade.liderDoResponsavelId === usuario.id
  );
}

/**
 * Pode ver o negócio ao qual quer ligar a atividade? É a visibilidade dos
 * negócios do módulo de funis (R5.9, matriz da seção 12) — uma regra só:
 * Admin e C-level, todos; o líder, os da sua área; o membro, os da sua área em
 * que é o responsável e os sem responsável.
 */
export function podeVerNegocio(
  usuario: QuemConsulta,
  negocio: { readonly responsavelId: string | null; readonly area: Area },
): boolean {
  return podeVerNegocioDoFunil(usuario, {
    responsavelId: negocio.responsavelId,
    funil: { area: negocio.area },
  });
}

// ---------------------------------------------------------------------------
// Datas por tipo (R6.1)
// ---------------------------------------------------------------------------

/** Datas pedidas: `undefined` = não informada (mantém a atual); `null` = limpar. */
export interface DatasPedidas {
  readonly venceEm?: Date | null;
  readonly inicioEm?: Date | null;
  readonly fimEm?: Date | null;
}

export interface DatasGravadas {
  readonly venceEm: Date | null;
  readonly inicioEm: Date | null;
  readonly fimEm: Date | null;
}

/**
 * R6.1 — datas conforme o tipo:
 * - reunião: início e fim obrigatórios, fim igual ou depois do início; o
 *   vencimento acompanha o início (só se aceita `venceEm` igual ao início, para
 *   quem reenvia a atividade inteira);
 * - nota: sem datas (nasce concluída, R6.2);
 * - demais tipos: só o vencimento, opcional.
 *
 * Em uma alteração, `atuais` traz as datas gravadas: o que não foi pedido fica
 * como está. Ao deixar de ser reunião, início e fim são limpos; o vencimento
 * (que era o início) continua, salvo se pedido outro.
 */
export function resolverDatas(
  tipo: TipoAtividade,
  pedidas: DatasPedidas,
  atuais?: DatasGravadas,
): { datas: DatasGravadas; problemas: ProblemaDeCampo[] } {
  const problemas: ProblemaDeCampo[] = [];
  const problema = (campo: string, mensagem: string) =>
    problemas.push({ campo, mensagens: [mensagem] });
  const escolher = (
    pedida: Date | null | undefined,
    atual: Date | null | undefined,
  ): Date | null => (pedida === undefined ? (atual ?? null) : pedida);

  if (tipo === 'REUNIAO') {
    const inicioEm = escolher(pedidas.inicioEm, atuais?.inicioEm);
    const fimEm = escolher(pedidas.fimEm, atuais?.fimEm);
    if (!inicioEm) {
      problema('inicioEm', 'é obrigatório na reunião');
    }
    if (!fimEm) {
      problema('fimEm', 'é obrigatório na reunião');
    }
    if (inicioEm && fimEm && fimEm.getTime() < inicioEm.getTime()) {
      problema('fimEm', 'deve ser igual ou posterior ao início');
    }
    if (
      pedidas.venceEm &&
      (!inicioEm || pedidas.venceEm.getTime() !== inicioEm.getTime())
    ) {
      problema(
        'venceEm',
        'não se aplica à reunião: informe o início e o fim (o vencimento acompanha o início)',
      );
    }
    return { datas: { venceEm: inicioEm, inicioEm, fimEm }, problemas };
  }

  if (pedidas.inicioEm) {
    problema('inicioEm', 'só se aplica à reunião');
  }
  if (pedidas.fimEm) {
    problema('fimEm', 'só se aplica à reunião');
  }
  if (tipo === 'NOTA') {
    if (pedidas.venceEm) {
      problema('venceEm', 'não se aplica à nota');
    }
    return {
      datas: { venceEm: null, inicioEm: null, fimEm: null },
      problemas,
    };
  }
  return {
    datas: {
      venceEm: escolher(pedidas.venceEm, atuais?.venceEm),
      inicioEm: null,
      fimEm: null,
    },
    problemas,
  };
}

// ---------------------------------------------------------------------------
// Marcadores dos lembretes (R6.5)
// ---------------------------------------------------------------------------

export interface EstadoDosLembretes {
  readonly tipo: TipoAtividade;
  readonly responsavelId: string;
  readonly venceEm: Date | null;
  readonly fimEm: Date | null;
  readonly lembreteEnviadoEm: Date | null;
  readonly atrasoNotificadoEm: Date | null;
}

function mesmoInstante(a: Date | null, b: Date | null): boolean {
  return (a?.getTime() ?? null) === (b?.getTime() ?? null);
}

/**
 * Quais marcadores de lembrete "rearmar" (voltar a `null`) depois de uma
 * alteração, para que o job (R6.5) avise de novo quando fizer sentido:
 * - lembrete de vencimento: se a data mudou ou o responsável mudou, e a nova
 *   data ainda está no futuro;
 * - aviso de atraso: se o responsável mudou (o novo recebe o aviso uma vez),
 *   ou se o prazo mudou e deixou de estar no passado.
 *
 * `reaberta` vale para quem volta de concluída/cancelada para pendente: rearma
 * o que estiver no futuro.
 */
export function marcadoresParaRearmar(
  antes: EstadoDosLembretes,
  depois: Omit<EstadoDosLembretes, 'lembreteEnviadoEm' | 'atrasoNotificadoEm'>,
  agora: Date,
  reaberta = false,
): { lembreteEnviadoEm?: null; atrasoNotificadoEm?: null } {
  const resultado: { lembreteEnviadoEm?: null; atrasoNotificadoEm?: null } = {};
  const trocouResponsavel = antes.responsavelId !== depois.responsavelId;
  const mudouData = !mesmoInstante(antes.venceEm, depois.venceEm);
  const prazoDepois = prazoDaAtividade(depois);
  const mudouPrazo = !mesmoInstante(prazoDaAtividade(antes), prazoDepois);
  const dataNoFuturo =
    depois.venceEm !== null && depois.venceEm.getTime() > agora.getTime();
  const prazoNoFuturo =
    prazoDepois === null || prazoDepois.getTime() > agora.getTime();

  if (
    antes.lembreteEnviadoEm &&
    dataNoFuturo &&
    (trocouResponsavel || mudouData || reaberta)
  ) {
    resultado.lembreteEnviadoEm = null;
  }
  if (
    antes.atrasoNotificadoEm &&
    (trocouResponsavel || ((mudouPrazo || reaberta) && prazoNoFuturo))
  ) {
    resultado.atrasoNotificadoEm = null;
  }
  return resultado;
}
