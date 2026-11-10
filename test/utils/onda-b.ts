import { randomUUID } from 'node:crypto';
import type { DefinicaoDePassos } from '../../src/comum/passos/definicao';
import {
  FILA_AVANCAR_PASSOS,
  PassosService,
} from '../../src/comum/passos/passos.service';
import type {
  ContextoDoPasso,
  ResultadoDoPasso,
} from '../../src/comum/passos/tipos';
import type {
  Arquivo,
  Automacao,
  Campanha,
  Canal,
  ExecucaoPasso,
  FluxoChatbot,
  FluxoChatbotVersao,
  GatilhoFluxo,
  Importacao,
  LimiteExecucao,
  Prisma,
  StatusCampanha,
  StatusImportacao,
  TipoExecucao,
  TipoGatilhoAutomacao,
  Usuario,
} from '../../src/generated/prisma/client';
import type { AppTeste } from './app-teste';
import { criarArquivo, criarCanalWhatsapp } from './fabricas';
import type { Area } from '../../src/comum/dominio/setores';

/**
 * Utilitários da Onda B: fábricas (automação, fluxo do chatbot, campanha,
 * importação), passos de teste no executor e o avanço das execuções.
 *
 * ```ts
 * passoDeTeste(t, 'teste.marcar', async (ctx) => seguir({ saida: { ok: true } }));
 * const { execucao } = await t.get(PassosService).iniciar({ tipo: 'AUTOMACAO', nome: 'X',
 *   definicao: { passos: [{ id: 'p1', tipo: 'teste.marcar' }] } });
 * await avancarPassos(t);                              // roda o que está na fila
 * await avancarPassos(t, { incluirAgendados: true });  // e as esperas (pula o tempo)
 * const historico = await historicoDaExecucao(t, execucao.id);
 * ```
 */

let sequencia = 0;
function proximo(): string {
  sequencia += 1;
  return `${sequencia}-${randomUUID().slice(0, 8)}`;
}

function idDe(
  valor: { id: string } | string | null | undefined,
): string | null | undefined {
  return typeof valor === 'object' && valor !== null ? valor.id : valor;
}

type ExecutarPassoDeTeste = (
  contexto: ContextoDoPasso,
) => Promise<ResultadoDoPasso>;

const implementacoes = new WeakMap<
  AppTeste,
  Map<string, ExecutarPassoDeTeste>
>();

/**
 * Registra (ou troca) um tipo de passo só para o teste. O tipo é registrado no
 * `PassosService` uma vez por app; chamadas seguintes só trocam a implementação.
 */
export function passoDeTeste(
  t: AppTeste,
  tipo: string,
  executar: ExecutarPassoDeTeste,
  execucoes?: readonly TipoExecucao[],
): void {
  let mapa = implementacoes.get(t);
  if (!mapa) {
    mapa = new Map();
    implementacoes.set(t, mapa);
  }
  const jaRegistrado = mapa.has(tipo);
  mapa.set(tipo, executar);
  if (!jaRegistrado) {
    t.get(PassosService).registrarTipo<Record<string, unknown>>({
      tipo,
      execucoes,
      executar: (contexto) => {
        const atual = implementacoes.get(t)?.get(tipo);
        if (!atual) {
          throw new Error(`Passo de teste sem implementação: ${tipo}`);
        }
        return atual(contexto);
      },
    });
  }
}

/** Roda os avanços na fila `passos.avancar` (com `incluirAgendados`, também as esperas). */
export function avancarPassos(
  t: AppTeste,
  opcoes: { incluirAgendados?: boolean } = {},
): Promise<number> {
  return t.fila.drenar(FILA_AVANCAR_PASSOS, opcoes);
}

/** Histórico por passo, na ordem. */
export function historicoDaExecucao(
  t: AppTeste,
  execucaoId: string,
): Promise<ExecucaoPasso[]> {
  return t.prisma.execucaoPasso.findMany({
    where: { execucaoId },
    orderBy: { ordem: 'asc' },
  });
}

/** Definição linear a partir dos tipos: `definicaoLinear('a', 'b')` → passos p1 (a), p2 (b). */
export function definicaoLinear(
  ...tipos: Array<string | { tipo: string; config?: Record<string, unknown> }>
): DefinicaoDePassos {
  return {
    passos: tipos.map((tipo, indice) =>
      typeof tipo === 'string'
        ? { id: `p${indice + 1}`, tipo }
        : { id: `p${indice + 1}`, tipo: tipo.tipo, config: tipo.config },
    ),
  };
}

// ---------------------------------------------------------------------------
// Fábricas (gravam direto no banco, sem auditoria nem eventos)
// ---------------------------------------------------------------------------

export interface DadosDeAutomacao {
  nome?: string;
  area?: Area | null;
  /** Padrão `true`. */
  ativa?: boolean;
  /** Padrão `EVENTO`. */
  tipoGatilho?: TipoGatilhoAutomacao;
  /** Padrão `contato.criado` (só com `EVENTO`). */
  evento?: string;
  gatilhoConfig?: Prisma.InputJsonObject;
  /** Padrão `contato`. */
  entidade?: 'contato' | 'negocio' | 'atividade' | 'conversa';
  condicoes?: Prisma.InputJsonObject;
  definicao?: DefinicaoDePassos;
  criteriosParada?: string[];
  limiteExecucao?: LimiteExecucao;
  limitePeriodoDias?: number | null;
  marketing?: boolean;
  proximaExecucaoEm?: Date | null;
  criadoPor?: Usuario | string | null;
}

export function criarAutomacao(
  t: AppTeste,
  dados: DadosDeAutomacao = {},
): Promise<Automacao> {
  const tipoGatilho = dados.tipoGatilho ?? 'EVENTO';
  const limite = dados.limiteExecucao ?? 'UMA_VEZ';
  return t.prisma.automacao.create({
    data: {
      nome: dados.nome ?? `Automação ${proximo()}`,
      area: dados.area ?? null,
      ativa: dados.ativa ?? true,
      tipoGatilho,
      evento:
        tipoGatilho === 'EVENTO' ? (dados.evento ?? 'contato.criado') : null,
      gatilhoConfig: dados.gatilhoConfig ?? {},
      entidade: dados.entidade ?? 'contato',
      condicoes: dados.condicoes ?? {},
      definicao: (dados.definicao ?? {
        passos: [],
      }) as unknown as Prisma.InputJsonObject,
      criteriosParada: dados.criteriosParada ?? [],
      limiteExecucao: limite,
      limitePeriodoDias:
        limite === 'UMA_VEZ_POR_PERIODO'
          ? (dados.limitePeriodoDias ?? 7)
          : null,
      marketing: dados.marketing ?? false,
      proximaExecucaoEm: dados.proximaExecucaoEm ?? null,
      criadoPorId: idDe(dados.criadoPor) ?? null,
    },
  });
}

export interface DadosDeFluxoChatbot {
  nome?: string;
  /** Padrão `NOVA_CONVERSA`. */
  gatilho?: GatilhoFluxo;
  palavrasChave?: string[];
  canais?: Array<Canal | string>;
  prioridade?: number;
  /** Padrão `true`. */
  ativo?: boolean;
  /** Rascunho (padrão: sem passos). */
  definicao?: DefinicaoDePassos;
  /** Publica o rascunho como versão 1 (padrão `true`). */
  publicar?: boolean;
  area?: Area | null;
}

/** Cria um fluxo (e, por padrão, a versão 1 publicada com o mesmo conteúdo do rascunho). */
export async function criarFluxoChatbot(
  t: AppTeste,
  dados: DadosDeFluxoChatbot = {},
): Promise<FluxoChatbot & { versaoPublicada: FluxoChatbotVersao | null }> {
  const definicao = (dados.definicao ?? {
    passos: [],
  }) as unknown as Prisma.InputJsonObject;
  const fluxo = await t.prisma.fluxoChatbot.create({
    data: {
      nome: dados.nome ?? `Fluxo ${proximo()}`,
      gatilho: dados.gatilho ?? 'NOVA_CONVERSA',
      palavrasChave: dados.palavrasChave ?? [],
      canalIds: (dados.canais ?? []).map((canal) => idDe(canal) as string),
      prioridade: dados.prioridade ?? 0,
      ativo: dados.ativo ?? true,
      area: dados.area ?? null,
      rascunho: definicao,
    },
  });
  if (dados.publicar === false) {
    return { ...fluxo, versaoPublicada: null };
  }
  const versao = await t.prisma.fluxoChatbotVersao.create({
    data: { fluxoId: fluxo.id, numero: 1, definicao },
  });
  const atualizado = await t.prisma.fluxoChatbot.update({
    where: { id: fluxo.id },
    data: { versaoPublicadaId: versao.id },
  });
  return { ...atualizado, versaoPublicada: versao };
}

export interface DadosDeCampanha {
  nome?: string;
  area?: Area | null;
  /** Padrão `WHATSAPP`. */
  canal?: 'WHATSAPP' | 'EMAIL';
  status?: StatusCampanha;
  /** Padrão: segmento vazio (todos os contatos sem opt-out). */
  segmento?: Prisma.InputJsonObject;
  importacao?: Importacao | string | null;
  texto?: string;
  assunto?: string | null;
  /** Canais da campanha (padrão: um número de WhatsApp CONECTADO novo, quando WHATSAPP). */
  canais?: Array<Canal | string>;
  intervaloMinimoSegundos?: number;
  intervaloMaximoSegundos?: number;
  agendadaPara?: Date | null;
  criadoPor?: Usuario | string | null;
}

export async function criarCampanha(
  t: AppTeste,
  dados: DadosDeCampanha = {},
): Promise<Campanha> {
  const canal = dados.canal ?? 'WHATSAPP';
  const canais =
    dados.canais ??
    (canal === 'WHATSAPP'
      ? [
          (
            await criarCanalWhatsapp(t, {
              status: 'CONECTADO',
              telefone: '5511900000000',
            })
          ).canal,
        ]
      : []);
  return t.prisma.campanha.create({
    data: {
      nome: dados.nome ?? `Campanha ${proximo()}`,
      area: dados.area ?? null,
      canal,
      status: dados.status ?? 'RASCUNHO',
      tipoPublico: dados.importacao ? 'IMPORTACAO' : 'SEGMENTO',
      segmento: dados.importacao
        ? undefined
        : (dados.segmento ?? { combinacao: 'todas', condicoes: [] }),
      importacaoId: idDe(dados.importacao) ?? null,
      texto: dados.texto ?? '{Olá|Oi} {{contato.primeiro_nome|tudo bem}}!',
      assunto: dados.assunto ?? null,
      intervaloMinimoSegundos: dados.intervaloMinimoSegundos ?? 20,
      intervaloMaximoSegundos: dados.intervaloMaximoSegundos ?? 60,
      agendadaPara: dados.agendadaPara ?? null,
      criadoPorId: idDe(dados.criadoPor) ?? null,
      canais: {
        create: canais.map((c, ordem) => ({
          canalId: idDe(c) as string,
          ordem,
        })),
      },
    },
  });
}

export interface DadosDeImportacao {
  /** Conteúdo CSV (padrão: cabeçalho `Nome,E-mail,Telefone` e duas linhas). */
  csv?: string;
  /** Arquivo já salvo (em vez do CSV). */
  arquivo?: Arquivo;
  status?: StatusImportacao;
  mapeamento?: Prisma.InputJsonObject;
  criadoPor?: Usuario | string | null;
}

/** Cria uma importação com o arquivo CSV salvo (contexto IMPORTACAO). */
export async function criarImportacao(
  t: AppTeste,
  dados: DadosDeImportacao = {},
): Promise<Importacao> {
  const csv =
    dados.csv ??
    'Nome,E-mail,Telefone\nAna Souza,ana@teste.local,11987654321\nBruno Lima,bruno@teste.local,\n';
  const arquivo =
    dados.arquivo ??
    (await criarArquivo(t, {
      contexto: 'IMPORTACAO',
      nome: 'contatos.csv',
      mime: 'text/csv',
      conteudo: csv,
      criadoPor: dados.criadoPor ?? null,
    }));
  return t.prisma.importacao.create({
    data: {
      nome: arquivo.nome,
      arquivoId: arquivo.id,
      formato: arquivo.nome.toLowerCase().endsWith('.xlsx') ? 'xlsx' : 'csv',
      status: dados.status ?? 'RASCUNHO',
      mapeamento: dados.mapeamento ?? {},
      criadoPorId: idDe(dados.criadoPor) ?? null,
    },
  });
}
