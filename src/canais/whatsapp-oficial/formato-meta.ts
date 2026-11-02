/**
 * WhatsApp oficial (R28): TUDO o que depende do formato da Cloud API da Meta e
 * que a referência (`whatsapp-cloud-chamadas.md`, §6) não confirma por inteiro
 * fica neste arquivo, para ajustar num lugar só quando o primeiro teste contra a
 * Meta real mostrar diferenças:
 *
 * - corpos de envio de texto, mídia e template (referência §6.2: texto e
 *   template confirmados; **mídia parcialmente confirmada**, lacuna 15);
 * - destino por BSUID (`recipient`, visto só nos exemplos de permissão de
 *   chamada, §3.1; lacuna 17);
 * - tradução dos códigos de erro de mensagens para português (a referência só
 *   traz os de chamadas, §5.1; **os de mensagens vêm da documentação geral de
 *   códigos de erro da Cloud API e não foram conferidos** — lacuna 14);
 * - componentes de template (`HEADER`/`BODY`/`FOOTER`/`BUTTONS`, §3.1; os
 *   parâmetros nomeados `{{nome}}` **não estão na referência**).
 */
import type { TipoMensagem } from '../../generated/prisma/client';

/** Janela em que a Meta deixa responder com mensagem livre (§6.4). */
export const JANELA_DE_24_H_MS = 24 * 60 * 60 * 1000;

/** Texto do corpo: até 4096 caracteres (§6.2). */
export const LIMITE_DO_TEXTO = 4096;

/** Mídias de saída até 16 MB (documentos até 100 MB) (§6.3). */
export const LIMITE_DE_MIDIA_BYTES = 16 * 1024 * 1024;
export const LIMITE_DE_DOCUMENTO_BYTES = 100 * 1024 * 1024;
/** Teto do que se baixa de uma mídia recebida. */
export const LIMITE_DE_DOWNLOAD_BYTES = 100 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Configuração e segredos do canal
// ---------------------------------------------------------------------------

/** `canais.configuracao` (sem segredos). */
export interface ConfiguracaoOficial {
  /** `phone_number_id`: também é o `canais.id_externo` (acha o canal no webhook). */
  phoneNumberId: string;
  /** Id da conta do WhatsApp Business (WABA): templates. */
  wabaId: string;
  /** Número exibido, como a Meta mostra (`+55 11 99999-0000`). */
  numeroExibido: string | null;
}

/** `canais.segredos_cifrados`. */
export interface SegredosOficiais {
  /** Token de usuário do sistema (permanente). */
  token: string;
  /** App secret: confere `X-Hub-Signature-256`. */
  appSecret: string;
  /** Verify token do webhook (gerado pelo CRM). */
  tokenVerificacao: string;
}

/** Campos do webhook que o Admin assina no painel do app (a E2 acrescenta `calls`). */
export const CAMPOS_DO_WEBHOOK_OFICIAL = ['messages'] as const;

/** Lê a configuração gravada (tolerante). */
export function lerConfiguracaoOficial(valor: unknown): ConfiguracaoOficial {
  const gravada =
    typeof valor === 'object' && valor !== null && !Array.isArray(valor)
      ? (valor as Record<string, unknown>)
      : {};
  const texto = (campo: unknown) =>
    typeof campo === 'string' && campo.trim() !== '' ? campo.trim() : null;
  return {
    phoneNumberId: texto(gravada.phoneNumberId) ?? '',
    wabaId: texto(gravada.wabaId) ?? '',
    numeroExibido: texto(gravada.numeroExibido),
  };
}

// ---------------------------------------------------------------------------
// Destino e corpos de envio
// ---------------------------------------------------------------------------

/** Para quem enviar: o telefone (E.164 só com dígitos) ou, sem ele, o BSUID. */
export interface DestinoOficial {
  telefone: string | null;
  bsuid: string | null;
}

/**
 * Parte comum do corpo (§6.2). Com telefone vai em `to`; sem ele, o BSUID vai
 * em `recipient` (§3.1 e §3.5: "`to` é obrigatório a menos que `recipient`
 * (BSUID) seja enviado; se ambos, vale `to`").
 */
function base(destino: DestinoOficial): Record<string, unknown> {
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    ...(destino.telefone ? { to: destino.telefone } : {}),
    ...(destino.bsuid && !destino.telefone ? { recipient: destino.bsuid } : {}),
  };
}

export interface CitacaoOficial {
  /** wamid da mensagem citada. */
  idExterno: string;
}

const citar = (citacao?: CitacaoOficial | null) =>
  citacao ? { context: { message_id: citacao.idExterno } } : {};

export function corpoDeTexto(
  destino: DestinoOficial,
  texto: string,
  citacao?: CitacaoOficial | null,
): Record<string, unknown> {
  return {
    ...base(destino),
    type: 'text',
    text: { preview_url: true, body: texto.slice(0, LIMITE_DO_TEXTO) },
    ...citar(citacao),
  };
}

/** Tipo de mídia da Meta de cada tipo de mensagem do CRM. */
const TIPO_DA_MIDIA_NA_META: Readonly<
  Partial<
    Record<TipoMensagem, 'image' | 'audio' | 'video' | 'document' | 'sticker'>
  >
> = {
  IMAGEM: 'image',
  AUDIO: 'audio',
  VIDEO: 'video',
  DOCUMENTO: 'document',
  FIGURINHA: 'sticker',
};

export function tipoDaMidiaNaMeta(tipo: TipoMensagem) {
  return TIPO_DA_MIDIA_NA_META[tipo] ?? 'document';
}

/**
 * Mídia por id (upload prévio em `POST /{phone_number_id}/media`).
 * PARCIALMENTE CONFIRMADO (lacuna 15): `{ id }` + `caption` (imagem, vídeo,
 * documento) + `filename` (documento). Áudio e figurinha não levam legenda.
 */
export function corpoDeMidia(
  destino: DestinoOficial,
  tipo: TipoMensagem,
  mediaId: string,
  opcoes: { legenda?: string | null; nomeArquivo?: string | null } = {},
  citacao?: CitacaoOficial | null,
): Record<string, unknown> {
  const tipoNaMeta = tipoDaMidiaNaMeta(tipo);
  const legenda = opcoes.legenda?.trim();
  return {
    ...base(destino),
    type: tipoNaMeta,
    [tipoNaMeta]: {
      id: mediaId,
      ...(legenda && ['image', 'video', 'document'].includes(tipoNaMeta)
        ? { caption: legenda.slice(0, 1024) }
        : {}),
      ...(tipoNaMeta === 'document' && opcoes.nomeArquivo
        ? { filename: opcoes.nomeArquivo }
        : {}),
    },
    ...citar(citacao),
  };
}

/** Parâmetro de componente de template. */
export type ParametroDeTemplate =
  | { type: 'text'; text: string; parameter_name?: string }
  | { type: 'image' | 'video' | 'document'; [campo: string]: unknown };

export interface ComponenteDoEnvio {
  type: 'header' | 'body' | 'button';
  sub_type?: 'url' | 'quick_reply';
  index?: string;
  parameters: ParametroDeTemplate[];
}

export function corpoDeTemplate(
  destino: DestinoOficial,
  nome: string,
  idioma: string,
  componentes: ComponenteDoEnvio[],
): Record<string, unknown> {
  return {
    ...base(destino),
    type: 'template',
    template: {
      name: nome,
      language: { code: idioma },
      ...(componentes.length > 0 ? { components: componentes } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

const objeto = (valor: unknown): Json =>
  typeof valor === 'object' && valor !== null && !Array.isArray(valor)
    ? (valor as Json)
    : {};
const texto = (valor: unknown): string | null =>
  typeof valor === 'string' && valor !== '' ? valor : null;

const PADRAO_DE_VARIAVEL = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

/** Nomes das variáveis de um texto, na ordem e sem repetir (`{{1}}`, `{{nome}}`). */
export function variaveisDoTexto(valor: string | null): string[] {
  const nomes: string[] = [];
  for (const [, nome] of (valor ?? '').matchAll(PADRAO_DE_VARIAVEL)) {
    if (nome && !nomes.includes(nome)) {
      nomes.push(nome);
    }
  }
  return nomes;
}

export type FormatoDoCabecalho =
  'TEXT' | 'IMAGE' | 'VIDEO' | 'DOCUMENT' | 'LOCATION';

export interface BotaoDoTemplate {
  tipo: string;
  texto: string;
  url: string | null;
  /** Nomes das variáveis (só o botão de URL aceita uma). */
  variaveis: string[];
}

/** O template como o CRM entende (lido de `componentes`). */
export interface EstruturaDoTemplate {
  cabecalho: {
    formato: FormatoDoCabecalho;
    texto: string | null;
    variaveis: string[];
  } | null;
  corpo: { texto: string; variaveis: string[] };
  rodape: string | null;
  botoes: BotaoDoTemplate[];
}

/** Lê os `components` da Meta (`GET /{waba}/message_templates`). */
export function estruturaDoTemplate(componentes: unknown): EstruturaDoTemplate {
  const lista = (Array.isArray(componentes) ? componentes : []).map(objeto);
  const por = (tipo: string) =>
    lista.find((item) => texto(item.type)?.toUpperCase() === tipo);
  const cabecalho = por('HEADER');
  const corpo = por('BODY');
  const rodape = por('FOOTER');
  const botoes = por('BUTTONS');
  const formato = (texto(cabecalho?.format) ?? 'TEXT').toUpperCase();
  const textoDoCabecalho = texto(cabecalho?.text);
  return {
    cabecalho: cabecalho
      ? {
          formato: formato as FormatoDoCabecalho,
          texto: textoDoCabecalho,
          variaveis: variaveisDoTexto(textoDoCabecalho),
        }
      : null,
    corpo: {
      texto: texto(corpo?.text) ?? '',
      variaveis: variaveisDoTexto(texto(corpo?.text)),
    },
    rodape: texto(rodape?.text),
    botoes: (Array.isArray(botoes?.buttons) ? botoes.buttons : [])
      .map(objeto)
      .map((botao) => ({
        tipo: (texto(botao.type) ?? 'QUICK_REPLY').toUpperCase(),
        texto: texto(botao.text) ?? '',
        url: texto(botao.url),
        variaveis: variaveisDoTexto(texto(botao.url)),
      })),
  };
}

/** Valores das variáveis, por componente, na ordem em que aparecem. */
export interface ValoresDoTemplate {
  cabecalho?: string[];
  corpo?: string[];
  /** Um valor por botão (`null` nos que não têm variável). */
  botoes?: Array<string | null>;
}

/** Troca `{{n}}` pelos valores (na ordem das variáveis); falta de valor = vazio. */
export function preencher(
  modelo: string,
  nomes: string[],
  valores: string[] = [],
): string {
  return modelo.replace(PADRAO_DE_VARIAVEL, (_, nome: string) => {
    const indice = nomes.indexOf(nome);
    return (indice >= 0 ? valores[indice] : undefined)?.trim() ?? '';
  });
}

/** Texto da mensagem como o contato a vê (cabeçalho, corpo e rodapé preenchidos). */
export function textoDoTemplate(
  estrutura: EstruturaDoTemplate,
  valores: ValoresDoTemplate,
): string {
  const { cabecalho, corpo, rodape } = estrutura;
  return [
    cabecalho?.formato === 'TEXT' && cabecalho.texto
      ? preencher(cabecalho.texto, cabecalho.variaveis, valores.cabecalho)
      : null,
    preencher(corpo.texto, corpo.variaveis, valores.corpo),
    rodape,
  ]
    .filter((parte): parte is string => !!parte)
    .join('\n\n');
}

const ehPosicional = (nomes: string[]) =>
  nomes.every((nome) => /^[0-9]+$/.test(nome));

function parametrosDeTexto(
  nomes: string[],
  valores: string[] = [],
): ParametroDeTemplate[] {
  const posicional = ehPosicional(nomes);
  return nomes.map((nome, indice) => ({
    type: 'text',
    text: (valores[indice] ?? '').trim(),
    // NAO CONFIRMADO: parâmetros nomeados (`{{nome}}`) levam `parameter_name`.
    ...(posicional ? {} : { parameter_name: nome }),
  }));
}

/**
 * `components` do envio (§3.1: `body` com `parameters[{ type: 'text', text }]`);
 * cabeçalho com mídia usa `mediaIdDoCabecalho` (upload prévio).
 */
export function componentesDoEnvio(
  estrutura: EstruturaDoTemplate,
  valores: ValoresDoTemplate,
  mediaIdDoCabecalho?: string | null,
): ComponenteDoEnvio[] {
  const componentes: ComponenteDoEnvio[] = [];
  const { cabecalho } = estrutura;
  if (cabecalho?.formato === 'TEXT' && cabecalho.variaveis.length > 0) {
    componentes.push({
      type: 'header',
      parameters: parametrosDeTexto(cabecalho.variaveis, valores.cabecalho),
    });
  } else if (
    cabecalho &&
    ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(cabecalho.formato) &&
    mediaIdDoCabecalho
  ) {
    const tipo = cabecalho.formato.toLowerCase() as
      'image' | 'video' | 'document';
    componentes.push({
      type: 'header',
      parameters: [{ type: tipo, [tipo]: { id: mediaIdDoCabecalho } }],
    });
  }
  if (estrutura.corpo.variaveis.length > 0) {
    componentes.push({
      type: 'body',
      parameters: parametrosDeTexto(estrutura.corpo.variaveis, valores.corpo),
    });
  }
  estrutura.botoes.forEach((botao, indice) => {
    const valor = valores.botoes?.[indice];
    if (botao.tipo === 'URL' && botao.variaveis.length > 0) {
      componentes.push({
        type: 'button',
        sub_type: 'url',
        index: String(indice),
        parameters: [{ type: 'text', text: (valor ?? '').trim() }],
      });
    }
  });
  return componentes;
}

/** Quantos valores o template pede (para conferir antes de enviar). */
export function valoresQueFaltam(
  estrutura: EstruturaDoTemplate,
  valores: ValoresDoTemplate,
): string[] {
  const faltas: string[] = [];
  const conferir = (rotulo: string, nomes: string[], dados?: string[]) => {
    nomes.forEach((nome, indice) => {
      if (!dados?.[indice]?.trim()) {
        faltas.push(`${rotulo} {{${nome}}}`);
      }
    });
  };
  conferir(
    'cabeçalho',
    estrutura.cabecalho?.variaveis ?? [],
    valores.cabecalho,
  );
  conferir('corpo', estrutura.corpo.variaveis, valores.corpo);
  estrutura.botoes.forEach((botao, indice) => {
    if (botao.variaveis.length > 0 && !valores.botoes?.[indice]?.trim()) {
      faltas.push(`botão "${botao.texto}"`);
    }
  });
  return faltas;
}

// ---------------------------------------------------------------------------
// Erros
// ---------------------------------------------------------------------------

/**
 * Motivo em português de um erro de mensagem da Cloud API (webhook de status
 * `failed` e resposta do envio). NAO CONFIRMADO NA REFERÊNCIA (lacuna 14): os
 * códigos abaixo são da documentação geral de erros da Cloud API; o que não
 * está na tabela cai no `title` da Meta.
 */
const ERROS_DE_MENSAGEM: Readonly<Record<number, string>> = {
  130429:
    'A Meta limitou a velocidade de envio deste número. Tente de novo em instantes.',
  130472:
    'O contato faz parte de um experimento da Meta e não recebe esta mensagem.',
  131000: 'A Meta teve um problema ao processar a mensagem. Tente de novo.',
  131005: 'O token do canal não tem permissão para enviar mensagens.',
  131008: 'A mensagem enviada está com algum campo ausente ou inválido.',
  131009: 'A mensagem tem um parâmetro com valor inválido.',
  131016:
    'O serviço do WhatsApp está sobrecarregado. Tente de novo em instantes.',
  131021: 'O destinatário é o próprio número do canal.',
  131026:
    'A mensagem não pôde ser entregue: o número não tem WhatsApp ou não aceitou os termos de uso.',
  131030:
    'O número do contato não está na lista de destinatários permitidos deste canal (modo de teste).',
  131031: 'A conta do WhatsApp Business foi bloqueada pela Meta.',
  131042:
    'Há um problema de pagamento na conta do WhatsApp Business (forma de pagamento da Meta).',
  131045: 'O número do canal não está registrado na Cloud API.',
  131047:
    'Passaram mais de 24 horas desde a última mensagem do contato: só é possível enviar um template aprovado.',
  131048:
    'A Meta bloqueou o envio por excesso de denúncias de spam neste número.',
  131049:
    'A Meta não entregou a mensagem para manter a qualidade do WhatsApp (o contato recebeu muitas mensagens de empresas).',
  131050:
    'O contato pediu para não receber mensagens de marketing desta empresa.',
  131051: 'O tipo de mensagem não é suportado pelo WhatsApp.',
  131052: 'Não foi possível baixar a mídia enviada pelo contato.',
  131053:
    'A mídia enviada não pôde ser carregada: formato ou tamanho não aceitos.',
  131056:
    'Há mensagens demais para este contato em pouco tempo. Aguarde um pouco.',
  131057:
    'A conta do WhatsApp Business está em manutenção. Tente de novo mais tarde.',
  132000:
    'O template foi enviado com um número de variáveis diferente do aprovado.',
  132001:
    'O template não existe (ou não existe neste idioma) na conta do WhatsApp Business.',
  132005: 'O texto do template, depois de preenchido, ficou grande demais.',
  132007: 'O conteúdo do template violou uma política do WhatsApp.',
  132012: 'Uma variável do template está em formato inválido.',
  132015: 'O template está pausado pela Meta por baixa qualidade.',
  132016: 'O template foi desativado pela Meta.',
  133010: 'O número do canal não está registrado no WhatsApp.',
  190: 'O token do canal é inválido ou expirou: o Admin precisa gerar outro e salvar no canal.',
};

/** Motivo em português: pela tabela de códigos; senão o título da Meta; senão genérico. */
export function traduzirErroDaMeta(
  codigo: number | null,
  titulo?: string | null,
  detalhe?: string | null,
): string {
  const conhecido = codigo !== null ? ERROS_DE_MENSAGEM[codigo] : undefined;
  if (conhecido) {
    return conhecido;
  }
  const original = [titulo, detalhe].filter(Boolean).join(': ');
  return original
    ? `A Meta não entregou a mensagem: ${original}`
    : 'A Meta não conseguiu entregar a mensagem.';
}

/** Fora da janela de 24 h: só template (código 131047, "re-engagement message"). */
export function ehJanelaFechada(codigo: number | null): boolean {
  return codigo === 131047;
}
