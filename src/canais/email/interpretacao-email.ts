/**
 * Interpretação de um e-mail recebido (R14): o que o Atendimento precisa de
 * uma mensagem já lida pelo `mailparser` — remetente, assunto sem "Re:", o
 * encadeamento (Message-ID, In-Reply-To, References) e o corpo **como texto**
 * (a parte texto ou o texto extraído do HTML, nunca o HTML), sem a citação da
 * mensagem anterior. Funções puras, testadas em `interpretacao-email.spec.ts`.
 */
import {
  type AddressObject,
  type HeaderValue,
  type ParsedMail,
  simpleParser,
} from 'mailparser';

export interface EnderecoDeEmail {
  email: string;
  nome: string | null;
}

export interface EmailInterpretado {
  /** Message-ID sem `<>` (nulo se o e-mail não tiver). */
  messageId: string | null;
  inReplyTo: string | null;
  /** References, da raiz para a mais recente, sem `<>`. */
  references: string[];
  /** Id da conversa no provedor: a raiz do encadeamento (ou o próprio Message-ID). */
  raiz: string | null;
  de: EnderecoDeEmail | null;
  /** Reply-To, se houver (é para onde a resposta vai). */
  responderPara: EnderecoDeEmail | null;
  para: string[];
  cc: string[];
  /** Assunto como veio. */
  assunto: string | null;
  /** Assunto sem os prefixos de resposta/encaminhamento (Re:, RES:, Fwd:, ENC:…). */
  assuntoLimpo: string | null;
  /** O texto novo da mensagem (sem a citação da anterior). */
  texto: string;
  /** O texto inteiro (com a citação), quando a citação foi tirada. */
  textoCompleto: string | null;
  /** Resposta automática (ausência, Auto-Submitted, Precedence: bulk…). */
  automatica: boolean;
  data: Date | null;
}

/** Tamanho máximo do texto guardado na mensagem. */
export const TAMANHO_MAXIMO_TEXTO_EMAIL = 20_000;

const PREFIXO_DE_RESPOSTA =
  /^\s*(re|res|resp|fwd?|enc|encaminhada|tr|aw|wg|rv|sv|antw)\s*(\[\d+\])?\s*:\s*/i;

/** `<abc@x.com>` → `abc@x.com`; vazio ou estranho → `null`. */
export function normalizarIdDeMensagem(
  id: string | null | undefined,
): string | null {
  if (!id) {
    return null;
  }
  const limpo = id
    .trim()
    .replace(/^<+|>+$/g, '')
    .trim();
  return limpo !== '' && limpo.length <= 900 && !/[\s<>]/.test(limpo)
    ? limpo
    : null;
}

/** Os ids de um cabeçalho References/In-Reply-To (texto ou lista). */
export function listaDeIds(valor: string | string[] | undefined): string[] {
  const itens = Array.isArray(valor) ? valor : valor ? valor.split(/\s+/) : [];
  const ids: string[] = [];
  for (const item of itens) {
    for (const parte of item.match(/<[^<>\s]+>|[^\s<>]+@[^\s<>]+/g) ?? []) {
      const id = normalizarIdDeMensagem(parte);
      if (id && !ids.includes(id)) {
        ids.push(id);
      }
    }
  }
  return ids;
}

/** Tira os "Re:", "RES:", "Fwd:", "ENC:"… do começo (quantos houver). */
export function limparAssunto(
  assunto: string | null | undefined,
): string | null {
  if (!assunto) {
    return null;
  }
  let texto = assunto.replace(/\s+/g, ' ').trim();
  let anterior = '';
  while (texto !== anterior) {
    anterior = texto;
    texto = texto.replace(PREFIXO_DE_RESPOSTA, '').trim();
  }
  return texto === '' ? null : texto.slice(0, 300);
}

/** Linha que abre a citação: "Em …, Fulano escreveu:", "On … wrote:". */
const ABERTURA_DA_CITACAO =
  /^(em|on|le|el|am|il)\s.{4,}\s(escreveu|wrote|a écrit|escribió|schrieb|ha scritto)\s*:\s*$/i;
const SEPARADOR_ORIGINAL =
  /^\s*-{2,}\s*(mensagem original|original message|mensaje original|message d'origine|ursprüngliche nachricht)\s*-{2,}\s*$/i;
const CABECALHO_DE = /^\s*\*?(de|from|von|da)\s*:\*?\s+\S/i;
const CABECALHO_SEGUINTE =
  /^\s*\*?(enviado|enviada|sent|data|date|gesendet|para|to|assunto|subject)\s*:\*?\s/i;

/**
 * O texto novo de uma resposta: corta a citação da mensagem anterior
 * ("Em …, Fulano escreveu:", "-----Mensagem original-----", o bloco
 * "De:/Enviado:" do Outlook) e as linhas finais citadas com `>`. Se só houver
 * citação, devolve o texto inteiro.
 */
export function removerCitacao(texto: string): string {
  const linhas = texto.replace(/\r\n?/g, '\n').split('\n');
  let corte = linhas.length;
  for (let i = 0; i < linhas.length; i++) {
    const linha = linhas[i].trim();
    const comASeguinte = `${linha} ${linhas[i + 1]?.trim() ?? ''}`.trim();
    if (
      ABERTURA_DA_CITACAO.test(linha) ||
      (i + 1 < linhas.length && ABERTURA_DA_CITACAO.test(comASeguinte)) ||
      SEPARADOR_ORIGINAL.test(linha)
    ) {
      corte = i;
      break;
    }
    if (/^_{5,}\s*$/.test(linha) && CABECALHO_DE.test(linhas[i + 1] ?? '')) {
      corte = i;
      break;
    }
    if (
      CABECALHO_DE.test(linha) &&
      linhas
        .slice(i + 1, i + 4)
        .some((seguinte) => CABECALHO_SEGUINTE.test(seguinte)) &&
      i > 0
    ) {
      corte = i;
      break;
    }
  }
  let resto = linhas.slice(0, corte);
  // Linhas citadas com ">" no fim (e as vazias entre elas).
  let fim = resto.length;
  while (
    fim > 0 &&
    (/^\s*>/.test(resto[fim - 1]) || resto[fim - 1].trim() === '')
  ) {
    fim--;
  }
  resto = resto.slice(0, fim);
  const novo = resto.join('\n').trim();
  return novo === '' ? texto.trim() : novo;
}

/** Resposta automática? (RFC 3834 e os cabeçalhos de costume.) */
export function ehAutomatica(cabecalhos: Map<string, HeaderValue>): boolean {
  const valor = (nome: string): string => {
    const lido = cabecalhos.get(nome);
    if (lido === undefined || lido === null) {
      return '';
    }
    if (typeof lido === 'string') {
      return lido.toLowerCase();
    }
    if (
      typeof lido === 'object' &&
      'value' in lido &&
      typeof lido.value === 'string'
    ) {
      return lido.value.toLowerCase();
    }
    return typeof lido === 'number' || typeof lido === 'boolean'
      ? String(lido)
      : '';
  };
  const autoSubmitted = valor('auto-submitted');
  return (
    (autoSubmitted !== '' && autoSubmitted !== 'no') ||
    cabecalhos.has('x-autoreply') ||
    cabecalhos.has('x-autorespond') ||
    ['bulk', 'junk', 'auto_reply'].includes(valor('precedence'))
  );
}

function enderecos(
  objeto: AddressObject | AddressObject[] | undefined,
): EnderecoDeEmail[] {
  const lista = Array.isArray(objeto) ? objeto : objeto ? [objeto] : [];
  const saida: EnderecoDeEmail[] = [];
  for (const grupo of lista) {
    for (const item of grupo.value) {
      const membros = item.group?.length ? item.group : [item];
      for (const membro of membros) {
        const email = membro.address?.trim().toLowerCase();
        if (email && email.includes('@')) {
          saida.push({ email, nome: membro.name?.trim() || null });
        }
      }
    }
  }
  return saida;
}

/**
 * Texto de um HTML com o conversor do próprio `mailparser` (ele só converte
 * sozinho quando o HTML é a mensagem inteira; num multipart com anexo, só
 * entrega o HTML). Sem script, estilo nem marcação.
 */
export async function htmlParaTexto(html: string): Promise<string> {
  const mensagem = Buffer.concat([
    Buffer.from(
      'Content-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n',
    ),
    Buffer.from(
      Buffer.from(html, 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n'),
    ),
  ]);
  return (await simpleParser(mensagem)).text ?? '';
}

/**
 * Lê o e-mail bruto (RFC 822) e garante o corpo em texto: a parte texto ou,
 * sem ela, o texto extraído do HTML.
 */
export async function lerEmail(bruto: Buffer): Promise<ParsedMail> {
  const lido = await simpleParser(bruto);
  if (!lido.text?.trim() && typeof lido.html === 'string' && lido.html.trim()) {
    lido.text = await htmlParaTexto(lido.html);
  }
  return lido;
}

/** Junta o que o Atendimento precisa de um e-mail lido pelo `mailparser`. */
export function interpretarEmail(lido: ParsedMail): EmailInterpretado {
  const messageId = normalizarIdDeMensagem(lido.messageId);
  const inReplyTo = listaDeIds(lido.inReplyTo)[0] ?? null;
  const references = listaDeIds(lido.references);
  const corpo = (lido.text ?? '').replace(/\r\n?/g, '\n').trim();
  const texto = removerCitacao(corpo).slice(0, TAMANHO_MAXIMO_TEXTO_EMAIL);
  return {
    messageId,
    inReplyTo,
    references,
    raiz: references[0] ?? inReplyTo ?? messageId,
    de: enderecos(lido.from)[0] ?? null,
    responderPara: enderecos(lido.replyTo)[0] ?? null,
    para: enderecos(lido.to).map(({ email }) => email),
    cc: enderecos(lido.cc).map(({ email }) => email),
    assunto: lido.subject?.trim() || null,
    assuntoLimpo: limparAssunto(lido.subject),
    texto,
    textoCompleto:
      texto.length < corpo.length
        ? corpo.slice(0, TAMANHO_MAXIMO_TEXTO_EMAIL)
        : null,
    automatica: ehAutomatica(lido.headers),
    data: lido.date && !Number.isNaN(lido.date.getTime()) ? lido.date : null,
  };
}
