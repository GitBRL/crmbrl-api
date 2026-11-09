/**
 * Instagram e Messenger (Graph API da Meta, R14): configuração do canal e a
 * leitura dos eventos do webhook (Messenger Platform), em funções puras —
 * testadas em `eventos-meta.spec.ts`.
 *
 * Formato do POST do webhook:
 *
 * ```json
 * { "object": "page" | "instagram",
 *   "entry": [{ "id": "<id da página ou da conta>", "time": 1761230000000,
 *     "messaging": [{ "sender": { "id": "<PSID/IGSID>" }, "recipient": { "id": "<página>" },
 *       "timestamp": 1761230000000,
 *       "message": { "mid": "m_…", "text": "Oi", "attachments": [{ "type": "image", "payload": { "url": "…" } }],
 *                    "reply_to": { "mid": "m_…" }, "is_echo": false },
 *       "delivery": { "mids": ["m_…"], "watermark": 1761230000000 },
 *       "read": { "watermark": 1761230000000, "mid": "m_…" },
 *       "reaction": { "mid": "m_…", "action": "react", "emoji": "❤" },
 *       "postback": { "mid": "m_…", "title": "Quero saber mais", "payload": "…" } }] }] }
 * ```
 */
import type { TipoCanal } from '../../generated/prisma/client';

export type TipoCanalMeta = Extract<TipoCanal, 'INSTAGRAM' | 'MESSENGER'>;
export const TIPOS_META: readonly TipoCanalMeta[] = ['INSTAGRAM', 'MESSENGER'];

/** Configuração sem segredos (`canais.configuracao`). */
export interface ConfiguracaoMeta {
  /** Id do app da Meta. */
  appId: string;
  /** Id da página do Facebook (Messenger; e a página ligada ao Instagram). */
  pageId: string;
  /** Id da conta profissional do Instagram (só no Instagram). */
  instagramId: string | null;
  /** O ID e o segredo do app são cópia do app da Meta de Configurações > Apps de login (R32.22, R32.24). */
  appDasConfiguracoes?: boolean;
}

/** Segredos (`canais.segredos_cifrados`). */
export interface SegredosMeta {
  /** App secret: confere a assinatura `X-Hub-Signature-256` do webhook. */
  appSecret: string;
  /** Token de acesso da página: envia as mensagens pela Graph API. */
  tokenPagina: string;
  /** Token de verificação do webhook (gerado pelo CRM, colado no painel da Meta). */
  tokenVerificacao: string;
}

/** Campos do webhook que o canal precisa assinar no painel da Meta. */
export const CAMPOS_DO_WEBHOOK = [
  'messages',
  'messaging_postbacks',
  'message_deliveries',
  'message_reads',
  'message_reactions',
] as const;

/** Lê a configuração gravada (tolerante). */
export function lerConfiguracaoMeta(valor: unknown): ConfiguracaoMeta {
  const gravada =
    typeof valor === 'object' && valor !== null && !Array.isArray(valor)
      ? (valor as Record<string, unknown>)
      : {};
  const texto = (campo: unknown) =>
    typeof campo === 'string' && campo.trim() !== '' ? campo.trim() : null;
  return {
    appId: texto(gravada.appId) ?? '',
    pageId: texto(gravada.pageId) ?? '',
    instagramId: texto(gravada.instagramId),
    ...(gravada.appDasConfiguracoes === true
      ? { appDasConfiguracoes: true }
      : {}),
  };
}

/** O id que o webhook manda em `entry.id` para o canal (o `idExterno`). */
export function idDoCanalNaMeta(
  tipo: TipoCanalMeta,
  config: Pick<ConfiguracaoMeta, 'pageId' | 'instagramId'>,
): string {
  return tipo === 'INSTAGRAM' ? (config.instagramId ?? '') : config.pageId;
}

/** O tipo de canal pelo `object` do webhook. */
export function tipoPeloObjeto(objeto: unknown): TipoCanalMeta | null {
  if (objeto === 'page') {
    return 'MESSENGER';
  }
  if (objeto === 'instagram') {
    return 'INSTAGRAM';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Eventos
// ---------------------------------------------------------------------------

/**
 * Tipo do anexo na Meta: `image`, `video`, `audio`, `file`, `sticker`,
 * `share`, `story_mention`, `ig_reel`, `reel`, `location`, `fallback`… (a
 * Meta acrescenta tipos novos: qualquer texto é aceito).
 */
export type TipoDeAnexoMeta = string;

export interface AnexoMeta {
  tipo: TipoDeAnexoMeta;
  url: string | null;
  titulo: string | null;
}

export type EventoMeta =
  | {
      tipo: 'mensagem';
      remetente: string;
      mid: string;
      texto: string | null;
      anexos: AnexoMeta[];
      respondeA: string | null;
      em: Date;
    }
  | { tipo: 'entrega'; remetente: string; mids: string[]; em: Date }
  | { tipo: 'leitura'; remetente: string; ate: Date; mid: string | null }
  | {
      tipo: 'reacao';
      remetente: string;
      mid: string;
      emoji: string;
      em: Date;
    };

/** Uma entrada do webhook já separada por canal (`entry.id`). */
export interface EntradaMeta {
  tipo: TipoCanalMeta;
  /** `entry.id`: a página (Messenger) ou a conta do Instagram. */
  idDoCanal: string;
  /** O corpo da entrada como veio (vai para o job). */
  bruta: Record<string, unknown>;
}

/** Separa o corpo do webhook em entradas por canal. Corpo estranho → lista vazia. */
export function entradasDoWebhook(corpo: unknown): EntradaMeta[] {
  if (typeof corpo !== 'object' || corpo === null) {
    return [];
  }
  const { object, entry } = corpo as { object?: unknown; entry?: unknown };
  const tipo = tipoPeloObjeto(object);
  if (!tipo || !Array.isArray(entry)) {
    return [];
  }
  return entry
    .filter(
      (item): item is Record<string, unknown> =>
        typeof item === 'object' &&
        item !== null &&
        (typeof (item as { id?: unknown }).id === 'string' ||
          typeof (item as { id?: unknown }).id === 'number'),
    )
    .map((item) => ({ tipo, idDoCanal: String(item.id), bruta: item }));
}

const texto = (valor: unknown): string | null =>
  typeof valor === 'string' && valor.trim() !== '' ? valor : null;

function instante(valor: unknown, padrao: Date): Date {
  const numero = typeof valor === 'string' ? Number(valor) : valor;
  return typeof numero === 'number' && Number.isFinite(numero) && numero > 0
    ? new Date(numero)
    : padrao;
}

/**
 * Os eventos de uma entrada (`entry.messaging`) que o Atendimento usa:
 * mensagens (texto, anexos, citação, botões), entregas, leituras e reações.
 * Ignora os ecos (mensagens que a própria página mandou, inclusive pelo CRM),
 * mensagens apagadas e o que não for reconhecido.
 */
export function eventosDaEntrada(
  bruta: Record<string, unknown>,
  agora: Date = new Date(),
): EventoMeta[] {
  const lista = Array.isArray(bruta.messaging) ? bruta.messaging : [];
  const eventos: EventoMeta[] = [];
  for (const item of lista as Array<Record<string, unknown>>) {
    if (typeof item !== 'object' || item === null) {
      continue;
    }
    const remetente = texto((item.sender as { id?: unknown } | undefined)?.id);
    if (!remetente) {
      continue;
    }
    const em = instante(item.timestamp, agora);
    const mensagem = item.message as Record<string, unknown> | undefined;
    if (mensagem && typeof mensagem === 'object') {
      const mid = texto(mensagem.mid);
      if (!mid || mensagem.is_echo === true || mensagem.is_deleted === true) {
        continue;
      }
      const anexos = (
        Array.isArray(mensagem.attachments) ? mensagem.attachments : []
      )
        .filter(
          (anexo): anexo is Record<string, unknown> =>
            typeof anexo === 'object' && anexo !== null,
        )
        .map((anexo) => {
          const payload = (anexo.payload ?? {}) as Record<string, unknown>;
          return {
            tipo: texto(anexo.type) ?? 'fallback',
            url: texto(payload.url),
            titulo: texto(payload.title) ?? texto(anexo.title),
          };
        });
      eventos.push({
        tipo: 'mensagem',
        remetente,
        mid,
        texto: texto(mensagem.text),
        anexos,
        respondeA: texto(
          (mensagem.reply_to as { mid?: unknown } | undefined)?.mid,
        ),
        em,
      });
      continue;
    }
    const postback = item.postback as Record<string, unknown> | undefined;
    if (postback && typeof postback === 'object') {
      const titulo = texto(postback.title) ?? texto(postback.payload);
      if (titulo) {
        eventos.push({
          tipo: 'mensagem',
          remetente,
          mid: texto(postback.mid) ?? `postback:${remetente}:${em.getTime()}`,
          texto: titulo,
          anexos: [],
          respondeA: null,
          em,
        });
      }
      continue;
    }
    const entrega = item.delivery as Record<string, unknown> | undefined;
    if (entrega && typeof entrega === 'object') {
      const mids = (Array.isArray(entrega.mids) ? entrega.mids : []).filter(
        (mid): mid is string => typeof mid === 'string' && mid !== '',
      );
      eventos.push({
        tipo: 'entrega',
        remetente,
        mids,
        em: instante(entrega.watermark, em),
      });
      continue;
    }
    const leitura = item.read as Record<string, unknown> | undefined;
    if (leitura && typeof leitura === 'object') {
      eventos.push({
        tipo: 'leitura',
        remetente,
        ate: instante(leitura.watermark, em),
        mid: texto(leitura.mid),
      });
      continue;
    }
    const reacao = item.reaction as Record<string, unknown> | undefined;
    if (reacao && typeof reacao === 'object' && reacao.action !== 'unreact') {
      const mid = texto(reacao.mid);
      const emoji = texto(reacao.emoji) ?? texto(reacao.reaction);
      if (mid && emoji) {
        eventos.push({ tipo: 'reacao', remetente, mid, emoji, em });
      }
    }
  }
  return eventos;
}

/** Tipo da mensagem do Atendimento para o anexo da Meta. */
export function tipoDaMensagemDoAnexo(
  tipo: TipoDeAnexoMeta,
): 'IMAGEM' | 'VIDEO' | 'AUDIO' | 'DOCUMENTO' | 'FIGURINHA' | null {
  switch (tipo) {
    case 'image':
      return 'IMAGEM';
    case 'sticker':
      return 'FIGURINHA';
    case 'video':
    case 'ig_reel':
    case 'reel':
      return 'VIDEO';
    case 'audio':
      return 'AUDIO';
    case 'file':
      return 'DOCUMENTO';
    default:
      return null;
  }
}

/** Tipo de anexo da Graph API para enviar um arquivo pelo MIME. */
export function tipoDoAnexoParaEnvio(
  mime: string,
): 'image' | 'video' | 'audio' | 'file' {
  if (mime.startsWith('image/')) {
    return 'image';
  }
  if (mime.startsWith('video/')) {
    return 'video';
  }
  if (mime.startsWith('audio/')) {
    return 'audio';
  }
  return 'file';
}
