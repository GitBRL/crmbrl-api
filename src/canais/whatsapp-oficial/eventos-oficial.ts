/**
 * WhatsApp oficial (Cloud API da Meta, R28): leitura do webhook em funções
 * puras — testadas em `eventos-oficial.spec.ts`.
 *
 * Formato do POST (referência §6.1; `field` = `messages`; o campo `calls` chega
 * na fatia das ligações):
 *
 * ```json
 * { "object": "whatsapp_business_account",
 *   "entry": [{ "id": "<WABA>", "changes": [{ "field": "messages", "value": {
 *     "messaging_product": "whatsapp",
 *     "metadata": { "display_phone_number": "5511...", "phone_number_id": "1000..." },
 *     "contacts": [{ "profile": { "name": "Maria", "username": "maria" },
 *                    "wa_id": "5511...", "user_id": "<BSUID>", "parent_user_id": "<BSUID>" }],
 *     "messages": [{ "from": "5511...", "from_user_id": "<BSUID>", "id": "wamid...",
 *                    "timestamp": "1761230000", "type": "text", "text": { "body": "Oi" },
 *                    "context": { "id": "wamid..." } }],
 *     "statuses": [{ "id": "wamid...", "status": "sent|delivered|read|failed", "timestamp": "…",
 *                    "recipient_id": "5511...", "errors": [{ "code": 131047, "title": "…" }] }]
 *   } }] }] }
 * ```
 *
 * O que a referência NÃO confirma fica marcado com `NAO CONFIRMADO` e isolado
 * aqui: o tipo `button` (resposta de botão de template), `sticker.animated`,
 * `contacts[].name/phones` e o nome exato de `from_user_id` em mensagens
 * (a referência só o mostra nas chamadas; o contrato pede `from_user_id` e
 * `contacts[].user_id`).
 */
import type { TipoMensagem } from '../../generated/prisma/client';
import type { StatusDeEntrega } from '../../atendimento/entrada';
import {
  type RespostaDePermissao,
  respostaDePermissao,
} from '../../ligacoes/formato-chamadas';
import { traduzirErroDaMeta } from './formato-meta';

/** `object` do webhook do WhatsApp Business. */
export const OBJETO_DO_WEBHOOK_WHATSAPP = 'whatsapp_business_account';

type Json = Record<string, unknown>;

const objeto = (valor: unknown): Json =>
  typeof valor === 'object' && valor !== null && !Array.isArray(valor)
    ? (valor as Json)
    : {};

const texto = (valor: unknown): string | null =>
  typeof valor === 'string' && valor.trim() !== ''
    ? valor
    : typeof valor === 'number' && Number.isFinite(valor)
      ? String(valor)
      : null;

const numero = (valor: unknown): number | null => {
  const convertido = typeof valor === 'string' ? Number(valor) : valor;
  return typeof convertido === 'number' && Number.isFinite(convertido)
    ? convertido
    : null;
};

/** `timestamp` da Meta: segundos desde 1970, como texto (ou número). */
function instante(valor: unknown, padrao: Date): Date {
  const segundos = numero(valor);
  return segundos !== null && segundos > 0 ? new Date(segundos * 1000) : padrao;
}

// ---------------------------------------------------------------------------
// Entradas do webhook
// ---------------------------------------------------------------------------

/** Uma mudança (`entry[].changes[]`) de um número, pronta para rotear. */
export interface MudancaDoWebhook {
  /** `metadata.phone_number_id`: acha o canal (`canais.id_externo`). */
  phoneNumberId: string;
  /** `entry[].id`: a WABA. */
  waba: string | null;
  /** `changes[].field` (`messages`, `calls`…). */
  campo: string;
  /** O `value` como veio (vai para o job). */
  valor: Json;
}

/** Separa o corpo do webhook em mudanças por número. Corpo estranho → lista vazia. */
export function mudancasDoWebhook(corpo: unknown): MudancaDoWebhook[] {
  const { object, entry } = objeto(corpo);
  if (object !== OBJETO_DO_WEBHOOK_WHATSAPP || !Array.isArray(entry)) {
    return [];
  }
  const mudancas: MudancaDoWebhook[] = [];
  for (const item of entry) {
    const { id, changes } = objeto(item);
    if (!Array.isArray(changes)) {
      continue;
    }
    for (const mudanca of changes) {
      const { field, value } = objeto(mudanca);
      const valor = objeto(value);
      const phoneNumberId = texto(objeto(valor.metadata).phone_number_id);
      const campo = texto(field);
      if (phoneNumberId && campo) {
        mudancas.push({ phoneNumberId, waba: texto(id), campo, valor });
      }
    }
  }
  return mudancas;
}

// ---------------------------------------------------------------------------
// Eventos de `messages`
// ---------------------------------------------------------------------------

/** Quem escreveu: telefone (E.164 só com dígitos) e/ou BSUID. */
export interface RemetenteOficial {
  /** `from` / `wa_id`; `null` quando a Meta omite (usuário com nome de usuário). */
  telefone: string | null;
  /** BSUID (`from_user_id` / `contacts[].user_id`). */
  bsuid: string | null;
  nome: string | null;
}

export type TipoDeMidiaOficial = Extract<
  TipoMensagem,
  'IMAGEM' | 'AUDIO' | 'VIDEO' | 'DOCUMENTO' | 'FIGURINHA'
>;

export type ConteudoOficial =
  | { tipo: 'texto'; corpo: string }
  | {
      tipo: 'midia';
      tipoMensagem: TipoDeMidiaOficial;
      mediaId: string | null;
      mime: string | null;
      legenda: string | null;
      nomeArquivo: string | null;
      /** Áudio gravado na hora (mensagem de voz). */
      voz: boolean;
      animada: boolean;
    }
  | {
      tipo: 'localizacao';
      latitude: number;
      longitude: number;
      nome: string | null;
      endereco: string | null;
    }
  | { tipo: 'contatos'; contatos: ContatoCompartilhado[] }
  | {
      tipo: 'interativo';
      /** `button_reply` ou `list_reply` (e `button`, resposta de botão de template). */
      origem: 'button_reply' | 'list_reply' | 'button';
      id: string | null;
      titulo: string;
      descricao: string | null;
    }
  | { tipo: 'reacao'; mensagemAlvo: string | null; emoji: string }
  /** Resposta ao pedido de permissão para ligar (R29): não vira mensagem da conversa. */
  | ({ tipo: 'permissao_de_ligacao' } & RespostaDePermissao)
  | { tipo: 'nao_suportado'; tipoOriginal: string };

export interface ContatoCompartilhado {
  nome: string | null;
  telefones: string[];
  vcard: string;
}

export type EventoOficial =
  | {
      tipo: 'mensagem';
      id: string;
      remetente: RemetenteOficial;
      em: Date;
      conteudo: ConteudoOficial;
      /** Id da mensagem citada (`context.id`). */
      respondeAId: string | null;
    }
  | {
      tipo: 'status';
      /** wamid da mensagem que NÓS enviamos. */
      id: string;
      status: StatusDeEntrega;
      em: Date;
      /** Motivo em português, só em `FALHOU`. */
      erro: string | null;
      codigoDoErro: number | null;
    };

/** Telefone da Meta (`5511999990000`, às vezes com `+`) em só dígitos; `null` se não parece telefone. */
export function telefoneDaMeta(valor: unknown): string | null {
  const digitos = (texto(valor) ?? '').replace(/\D/g, '');
  return /^[1-9][0-9]{7,14}$/.test(digitos) ? digitos : null;
}

function nomeDoContato(contato: Json | undefined): string | null {
  const perfil = objeto(contato?.profile);
  return texto(perfil.name) ?? texto(perfil.username);
}

function remetenteDaMensagem(
  mensagem: Json,
  contatos: Json[],
): RemetenteOficial {
  const telefone = telefoneDaMeta(mensagem.from);
  const bsuid = texto(mensagem.from_user_id) ?? texto(mensagem.user_id);
  const contato = contatos.find(
    (item) =>
      (telefone !== null && telefoneDaMeta(item.wa_id) === telefone) ||
      (bsuid !== null && texto(item.user_id) === bsuid),
  );
  return {
    telefone: telefone ?? telefoneDaMeta(contato?.wa_id),
    bsuid: bsuid ?? texto(contato?.user_id),
    nome: nomeDoContato(contato ?? contatos[0]),
  };
}

const TIPOS_DE_MIDIA: Readonly<Record<string, TipoDeMidiaOficial>> = {
  image: 'IMAGEM',
  audio: 'AUDIO',
  video: 'VIDEO',
  document: 'DOCUMENTO',
  sticker: 'FIGURINHA',
};

/** vCard mínima (nome e telefones) do contato compartilhado. */
function vcardDe(nome: string | null, telefones: string[]): string {
  return [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `FN:${nome ?? 'Contato'}`,
    ...telefones.map((telefone) => `TEL:${telefone}`),
    'END:VCARD',
  ].join('\n');
}

function contatosCompartilhados(lista: unknown): ContatoCompartilhado[] {
  // NAO CONFIRMADO na referência: `contacts[].name.formatted_name` e
  // `contacts[].phones[].phone|wa_id` (formato da documentação da Cloud API).
  return (Array.isArray(lista) ? lista : []).map((item) => {
    const contato = objeto(item);
    const nome =
      texto(objeto(contato.name).formatted_name) ??
      [
        texto(objeto(contato.name).first_name),
        texto(objeto(contato.name).last_name),
      ]
        .filter(Boolean)
        .join(' ') ??
      null;
    const telefones = (Array.isArray(contato.phones) ? contato.phones : [])
      .map((telefone) => {
        const { phone, wa_id: waId } = objeto(telefone);
        return texto(phone) ?? texto(waId);
      })
      .filter((valor): valor is string => valor !== null);
    return {
      nome: nome || null,
      telefones,
      vcard: vcardDe(nome || null, telefones),
    };
  });
}

/** O conteúdo de uma mensagem recebida (`messages[]`). */
export function conteudoDaMensagem(mensagem: Json): ConteudoOficial {
  const tipo = texto(mensagem.type) ?? 'unknown';
  const tipoDeMidia = TIPOS_DE_MIDIA[tipo];
  if (tipoDeMidia) {
    const midia = objeto(mensagem[tipo]);
    return {
      tipo: 'midia',
      tipoMensagem: tipoDeMidia,
      mediaId: texto(midia.id),
      mime: texto(midia.mime_type),
      legenda: texto(midia.caption),
      nomeArquivo: texto(midia.filename),
      voz: tipo === 'audio' && midia.voice === true,
      // NAO CONFIRMADO: `sticker.animated`.
      animada: midia.animated === true,
    };
  }
  switch (tipo) {
    case 'text':
      return {
        tipo: 'texto',
        corpo: texto(objeto(mensagem.text).body) ?? '',
      };
    case 'location': {
      const local = objeto(mensagem.location);
      const latitude = numero(local.latitude);
      const longitude = numero(local.longitude);
      if (latitude === null || longitude === null) {
        return { tipo: 'nao_suportado', tipoOriginal: 'location' };
      }
      return {
        tipo: 'localizacao',
        latitude,
        longitude,
        nome: texto(local.name),
        endereco: texto(local.address),
      };
    }
    case 'contacts':
      return {
        tipo: 'contatos',
        contatos: contatosCompartilhados(mensagem.contacts),
      };
    case 'interactive': {
      const interativo = objeto(mensagem.interactive);
      const origem = texto(interativo.type);
      if (origem === 'button_reply' || origem === 'list_reply') {
        const resposta = objeto(interativo[origem]);
        return {
          tipo: 'interativo',
          origem,
          id: texto(resposta.id),
          titulo: texto(resposta.title) ?? '',
          descricao: texto(resposta.description),
        };
      }
      if (origem === 'call_permission_reply') {
        const permissao = respostaDePermissao(mensagem);
        if (permissao) {
          return { tipo: 'permissao_de_ligacao', ...permissao };
        }
      }
      return { tipo: 'nao_suportado', tipoOriginal: `interactive:${origem}` };
    }
    case 'button': {
      // NAO CONFIRMADO na referência: botão de resposta rápida de template
      // chega como `type: "button"` com `button: { payload, text }`.
      const botao = objeto(mensagem.button);
      return {
        tipo: 'interativo',
        origem: 'button',
        id: texto(botao.payload),
        titulo: texto(botao.text) ?? '',
        descricao: null,
      };
    }
    case 'reaction': {
      const reacao = objeto(mensagem.reaction);
      return {
        tipo: 'reacao',
        mensagemAlvo: texto(reacao.message_id),
        // Emoji ausente = a pessoa tirou a reação.
        emoji: texto(reacao.emoji) ?? '',
      };
    }
    default:
      return { tipo: 'nao_suportado', tipoOriginal: tipo };
  }
}

const STATUS_DA_META: Readonly<Record<string, StatusDeEntrega>> = {
  sent: 'ENVIADA',
  delivered: 'ENTREGUE',
  read: 'LIDA',
  failed: 'FALHOU',
};

/**
 * Os eventos de um `value` do campo `messages`: mensagens do contato e status
 * das nossas. Ignora o que não tem id ou tipo conhecido (ex.: status
 * `played`/`deleted`).
 */
export function eventosDoValor(
  valor: Json,
  agora: Date = new Date(),
): EventoOficial[] {
  const eventos: EventoOficial[] = [];
  const contatos = (Array.isArray(valor.contacts) ? valor.contacts : []).map(
    objeto,
  );
  for (const item of Array.isArray(valor.messages) ? valor.messages : []) {
    const mensagem = objeto(item);
    const id = texto(mensagem.id);
    if (!id) {
      continue;
    }
    eventos.push({
      tipo: 'mensagem',
      id,
      remetente: remetenteDaMensagem(mensagem, contatos),
      em: instante(mensagem.timestamp, agora),
      conteudo: conteudoDaMensagem(mensagem),
      respondeAId: texto(objeto(mensagem.context).id),
    });
  }
  for (const item of Array.isArray(valor.statuses) ? valor.statuses : []) {
    const status = objeto(item);
    const id = texto(status.id);
    const traduzido = STATUS_DA_META[texto(status.status) ?? ''];
    if (!id || !traduzido) {
      continue;
    }
    const erro = objeto(Array.isArray(status.errors) ? status.errors[0] : null);
    const codigo = numero(erro.code);
    eventos.push({
      tipo: 'status',
      id,
      status: traduzido,
      em: instante(status.timestamp, agora),
      codigoDoErro: codigo,
      erro:
        traduzido === 'FALHOU'
          ? traduzirErroDaMeta(
              codigo,
              texto(erro.title) ?? texto(erro.message),
              texto(objeto(erro.error_data).details),
            )
          : null,
    });
  }
  return eventos;
}

/** Texto que a conversa mostra para o conteúdo (o que não é texto puro). */
export function textoDoConteudo(conteudo: ConteudoOficial): string | null {
  switch (conteudo.tipo) {
    case 'texto':
      return conteudo.corpo;
    case 'midia':
      return conteudo.legenda;
    case 'localizacao':
      return (
        [conteudo.nome, conteudo.endereco].filter(Boolean).join(' — ') ||
        'Localização'
      );
    case 'contatos':
      return conteudo.contatos.length === 1
        ? (conteudo.contatos[0]?.nome ?? 'Contato')
        : `${conteudo.contatos.length} contatos`;
    case 'interativo':
      return conteudo.titulo || null;
    case 'reacao':
      return conteudo.emoji;
    case 'permissao_de_ligacao':
      return 'Resposta ao pedido de permissão para ligar';
    case 'nao_suportado':
      return '(mensagem não suportada pelo CRM)';
  }
}
