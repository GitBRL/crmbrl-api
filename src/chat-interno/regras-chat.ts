/**
 * Regras puras do chat interno da equipe (§2.6, R15): canais do sistema,
 * limites e as marcações de menção e referência dentro do texto.
 *
 * **Marcações** (o front escreve, a API valida e resolve):
 *
 * | No texto                 | Significa                                   |
 * | ------------------------ | ------------------------------------------- |
 * | `<@<usuarioId>>`         | menção a um membro do canal (notifica)      |
 * | `<negocio:<id>>`         | referência a um negócio (vira link)         |
 * | `<contato:<id>>`         | referência a um contato (vira link)         |
 * | `<empresa:<id>>`         | referência a uma empresa (vira link)        |
 *
 * O texto guardado é o que a pessoa escreveu, com as marcações; o DTO devolve
 * também as `partes` já resolvidas (nome de quem foi mencionado, título do
 * negócio…), para a tela montar a bolha sem interpretar nada.
 */
import {
  areaDoPapel,
  ROTULO_DA_AREA,
  TODAS_AS_AREAS,
  TODOS_OS_PAPEIS,
} from '../comum/dominio/papeis';
import type { Area, Papel } from '../generated/prisma/client';

// ---------------------------------------------------------------------------
// Canais do sistema
// ---------------------------------------------------------------------------

/** `chave` do canal "Geral". */
export const CHAVE_DO_GERAL = 'geral';

/** `chave` do canal de uma área: `area:COMERCIAL`. */
export function chaveDaArea(area: Area): string {
  return `area:${area}`;
}

/** `chave` da conversa direta entre duas pessoas (a ordem não importa). */
export function chaveDaDireta(usuarioA: string, usuarioB: string): string {
  const [menor, maior] = [
    usuarioA.toLowerCase(),
    usuarioB.toLowerCase(),
  ].sort();
  return `direto:${menor}:${maior}`;
}

/** Um canal que o sistema cria e mantém (Geral e um por área). */
export interface CanalDoSistema {
  readonly chave: string;
  readonly tipo: 'GERAL' | 'AREA';
  readonly nome: string;
  readonly descricao: string;
  readonly area: Area | null;
}

/** Os canais padrão (R15.1): "Geral" e um por área, nesta ordem. */
export const CANAIS_DO_SISTEMA: readonly CanalDoSistema[] = [
  {
    chave: CHAVE_DO_GERAL,
    tipo: 'GERAL',
    nome: 'Geral',
    descricao: 'Avisos e conversas de toda a equipe.',
    area: null,
  },
  ...TODAS_AS_AREAS.map((area): CanalDoSistema => ({
    chave: chaveDaArea(area),
    tipo: 'AREA',
    nome: ROTULO_DA_AREA[area],
    descricao: `Canal da equipe de ${ROTULO_DA_AREA[area]}.`,
    area,
  })),
];

/**
 * Pares (papel, chave do canal) dos membros automáticos: todo papel no
 * "Geral" e cada papel nos canais das suas áreas (`areasDoChat`). É a base da
 * sincronização (SQL) — mudou aqui, muda a regra.
 */
export function canaisAutomaticosPorPapel(): ReadonlyArray<
  readonly [Papel, string]
> {
  return TODOS_OS_PAPEIS.flatMap((papel) => [
    [papel, CHAVE_DO_GERAL] as const,
    ...areasDoChat(papel).map((area) => [papel, chaveDaArea(area)] as const),
  ]);
}

/**
 * Áreas cujo canal a pessoa integra automaticamente (R15.1): as pessoas da
 * área (líder e membros) e o C-level, que acompanha todas. O Admin fica só no
 * "Geral" (pode criar grupos e diretas como qualquer um).
 */
export function areasDoChat(papel: Papel): readonly Area[] {
  if (papel === 'C_LEVEL') {
    return TODAS_AS_AREAS;
  }
  const area = areaDoPapel(papel);
  return area ? [area] : [];
}

// ---------------------------------------------------------------------------
// Regras (R15), eventos e links
// ---------------------------------------------------------------------------

/**
 * Sub-regras da R15 (vão em `detalhes.regra` dos erros; o texto para a
 * pessoa nunca cita o código).
 */
export const REGRAS_DO_CHAT = {
  /** Canais padrão: mantidos pelo sistema (não dá para sair, renomear nem arquivar). */
  CANAIS_PADRAO: 'R15.1',
  /** Grupos: administradores, limite de pessoas, arquivado só para leitura. */
  GRUPOS: 'R15.2',
  /** Diretas: uma por par, privadas, só leitura com pessoa desligada. */
  DIRETAS: 'R15.3',
  /** Mensagens: texto e/ou anexo; editar e excluir só as próprias. */
  MENSAGENS: 'R15.4',
  /** Menções: só membros do canal; notificam. */
  MENCOES: 'R15.5',
  /** Referências: negócio que a pessoa vê, contato, empresa. */
  REFERENCIAS: 'R15.6',
} as const;

/** Eventos de domínio (outbox) do chat — consumidos pelo tempo real. */
export const EVENTOS_DO_CHAT = {
  MENSAGEM_CRIADA: 'chat_mensagem.criada',
  MENSAGEM_EDITADA: 'chat_mensagem.editada',
  MENSAGEM_EXCLUIDA: 'chat_mensagem.excluida',
  /** Nome, descrição, arquivamento, membros ou administradores mudaram. */
  CANAL_ATUALIZADO: 'chat_canal.atualizado',
} as const;

/** Dados de `chat_mensagem.*` na outbox (só ids: nada de conteúdo). */
export interface DadosDoEventoDeMensagem {
  canalId: string;
  mensagemId: string;
}

/** Dados de `chat_canal.atualizado` na outbox. */
export interface DadosDoEventoDeCanal {
  canalId: string;
  /** Quem entrou (recebe o canal na lista). */
  entraram?: string[];
  /** Quem saiu ou foi tirado (o canal some da lista dele). */
  sairam?: string[];
}

/** Tipo da notificação de menção (`notificacoes.tipo`). */
export const NOTIFICACAO_DE_MENCAO = 'chat.mencao';

/** "no canal Geral", "no grupo Lançamento", "numa conversa direta" (títulos de notificação). */
export function lugarDoCanal(canal: {
  tipo: 'GERAL' | 'AREA' | 'GRUPO' | 'DIRETO';
  nome: string | null;
}): string {
  if (canal.tipo === 'DIRETO') {
    return 'numa conversa direta';
  }
  return `${canal.tipo === 'GRUPO' ? 'no grupo' : 'no canal'} ${canal.nome ?? ''}`.trimEnd();
}

/** Rota do front de um canal. */
export function linkDoCanal(canalId: string): string {
  return `/chat/${canalId}`;
}

/** Rota do front que abre o canal já na mensagem. */
export function linkDaMensagem(canalId: string, mensagemId: string): string {
  return `/chat/${canalId}?mensagem=${mensagemId}`;
}

// ---------------------------------------------------------------------------
// Limites
// ---------------------------------------------------------------------------

/** Caracteres de uma mensagem (com as marcações). */
export const TAMANHO_MAXIMO_DO_TEXTO = 4_000;
/** Nome de um grupo. */
export const TAMANHO_MAXIMO_DO_NOME = 80;
/** Descrição de um grupo. */
export const TAMANHO_MAXIMO_DA_DESCRICAO = 500;
/** Pessoas num grupo (contando quem criou). */
export const MAXIMO_DE_MEMBROS_DO_GRUPO = 200;
/** Menções diferentes numa mensagem. */
export const MAXIMO_DE_MENCOES = 20;
/** Referências diferentes numa mensagem. */
export const MAXIMO_DE_REFERENCIAS = 10;
/** Tamanho dos resumos (prévia na lista de canais, texto da notificação). */
export const TAMANHO_DO_RESUMO = 140;

// ---------------------------------------------------------------------------
// Marcações no texto
// ---------------------------------------------------------------------------

export const TIPOS_DE_REFERENCIA = ['negocio', 'contato', 'empresa'] as const;
export type TipoReferencia = (typeof TIPOS_DE_REFERENCIA)[number];

/** Item citado numa mensagem (guardado em `chat_mensagens.referencias`). */
export interface ReferenciaGuardada {
  tipo: TipoReferencia;
  id: string;
}

/** Um pedaço do texto: texto puro, menção ou referência. */
export type Pedaco =
  | { readonly tipo: 'texto'; readonly texto: string }
  | { readonly tipo: 'mencao'; readonly usuarioId: string }
  | { readonly tipo: 'referencia'; readonly referencia: ReferenciaGuardada };

const UUID =
  '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';

/** `<@id>`, `<negocio:id>`, `<contato:id>` ou `<empresa:id>`. */
function padraoDeMarcacao(): RegExp {
  return new RegExp(`<(@|negocio:|contato:|empresa:)(${UUID})>`, 'g');
}

/**
 * Expressão SQL (PostgreSQL) que tira as marcações da coluna de texto, para a
 * busca não achar "negocio" em toda mensagem com uma referência. `coluna` é um
 * nome fixo do código — nunca venha da requisição.
 */
export function sqlTextoSemMarcacoes(coluna: string): string {
  return `regexp_replace(coalesce(${coluna}, ''), '<(@|negocio:|contato:|empresa:)[0-9a-fA-F-]{36}>', ' ', 'g')`;
}

/** Divide o texto em pedaços (texto, menção, referência), na ordem. */
export function dividirTexto(texto: string | null | undefined): Pedaco[] {
  if (!texto) {
    return [];
  }
  const pedacos: Pedaco[] = [];
  let inicio = 0;
  for (const achado of texto.matchAll(padraoDeMarcacao())) {
    const posicao = achado.index;
    if (posicao > inicio) {
      pedacos.push({ tipo: 'texto', texto: texto.slice(inicio, posicao) });
    }
    const prefixo = achado[1];
    const id = achado[2].toLowerCase();
    if (prefixo === '@') {
      pedacos.push({ tipo: 'mencao', usuarioId: id });
    } else {
      pedacos.push({
        tipo: 'referencia',
        referencia: { tipo: prefixo.slice(0, -1) as TipoReferencia, id },
      });
    }
    inicio = posicao + achado[0].length;
  }
  if (inicio < texto.length) {
    pedacos.push({ tipo: 'texto', texto: texto.slice(inicio) });
  }
  return pedacos;
}

/** Menções e referências do texto, sem repetidos e na ordem em que aparecem. */
export interface Marcacoes {
  readonly mencoes: string[];
  readonly referencias: ReferenciaGuardada[];
}

export function extrairMarcacoes(texto: string | null | undefined): Marcacoes {
  const mencoes = new Set<string>();
  const referencias = new Map<string, ReferenciaGuardada>();
  for (const pedaco of dividirTexto(texto)) {
    if (pedaco.tipo === 'mencao') {
      mencoes.add(pedaco.usuarioId);
    } else if (pedaco.tipo === 'referencia') {
      const { tipo, id } = pedaco.referencia;
      referencias.set(`${tipo}:${id}`, { tipo, id });
    }
  }
  return { mencoes: [...mencoes], referencias: [...referencias.values()] };
}

/** Marcação de menção (para avisos do sistema e testes). */
export function marcarMencao(usuarioId: string): string {
  return `<@${usuarioId}>`;
}

/** Marcação de referência. */
export function marcarReferencia(tipo: TipoReferencia, id: string): string {
  return `<${tipo}:${id}>`;
}

/**
 * O texto como é guardado: quebras de linha `\n`, sem espaços nas pontas.
 * Vazio (ou só espaços) vira `null` — a mensagem então precisa de um anexo.
 */
export function normalizarTextoDaMensagem(
  texto: string | null | undefined,
): string | null {
  if (texto === null || texto === undefined) {
    return null;
  }
  const normalizado = texto.replace(/\r\n?/g, '\n').trim();
  return normalizado === '' ? null : normalizado;
}

/** Espaços seguidos (inclusive quebras de linha) viram um; corta com reticências. */
export function resumir(
  texto: string,
  tamanho: number = TAMANHO_DO_RESUMO,
): string {
  const corrido = texto.replace(/\s+/g, ' ').trim();
  if (corrido.length <= tamanho) {
    return corrido;
  }
  return `${corrido.slice(0, tamanho - 1).trimEnd()}…`;
}

/** Referência guardada no JSON da mensagem? (lê `referencias` com segurança.) */
export function lerReferencias(valor: unknown): ReferenciaGuardada[] {
  if (!Array.isArray(valor)) {
    return [];
  }
  return valor.filter(
    (item): item is ReferenciaGuardada =>
      typeof item === 'object' &&
      item !== null &&
      (TIPOS_DE_REFERENCIA as readonly string[]).includes(
        (item as { tipo?: unknown }).tipo as string,
      ) &&
      typeof (item as { id?: unknown }).id === 'string',
  );
}
