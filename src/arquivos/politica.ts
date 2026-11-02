/**
 * Política de arquivos (R11): tipos aceitos e recusados, limites de tamanho por
 * contexto, conferência do conteúdo e cabeçalhos seguros do download. Funções
 * puras, sem Nest, para servir à API e ao gateway de WhatsApp.
 */
import type { ContextoArquivo } from '../generated/prisma/client';

const MB = 1024 * 1024;

/** Limite padrão (imagem, áudio, vídeo): 25 MB. */
export const LIMITE_PADRAO_BYTES = 25 * MB;

/** Limite de documentos (PDF, Office, texto, zip): 100 MB. */
export const LIMITE_DOCUMENTOS_BYTES = 100 * MB;

/** Planilha de importação (CSV/XLSX): 10 MB — o leitor trabalha na memória. */
export const LIMITE_IMPORTACAO_BYTES = 10 * MB;

/** Foto de perfil: 5 MB. */
export const LIMITE_AVATAR_BYTES = 5 * MB;

/** Maior limite de todos — o teto do multer no upload HTTP. */
export const LIMITE_MAXIMO_BYTES = LIMITE_DOCUMENTOS_BYTES;

/** Categoria do tipo de arquivo: define o limite e se o navegador pode exibi-lo. */
export type CategoriaDeArquivo =
  'imagem' | 'audio' | 'video' | 'documento' | 'texto' | 'compactado';

/** Tipos MIME aceitos, por categoria (SVG e HTML ficam de fora de propósito). */
const TIPOS_ACEITOS: Readonly<Record<string, CategoriaDeArquivo>> = {
  // Imagens
  'image/jpeg': 'imagem',
  'image/png': 'imagem',
  'image/gif': 'imagem',
  'image/webp': 'imagem',
  'image/avif': 'imagem',
  'image/heic': 'imagem',
  'image/heif': 'imagem',
  'image/bmp': 'imagem',
  'image/tiff': 'imagem',
  // Áudio (inclui o gravado no navegador e o de voz do WhatsApp)
  'audio/mpeg': 'audio',
  'audio/mp3': 'audio',
  'audio/mp4': 'audio',
  'audio/x-m4a': 'audio',
  'audio/aac': 'audio',
  'audio/ogg': 'audio',
  'audio/opus': 'audio',
  'audio/webm': 'audio',
  'audio/wav': 'audio',
  'audio/x-wav': 'audio',
  'audio/wave': 'audio',
  'audio/flac': 'audio',
  'audio/amr': 'audio',
  'audio/3gpp': 'audio',
  // Vídeo
  'video/mp4': 'video',
  'video/webm': 'video',
  'video/quicktime': 'video',
  'video/3gpp': 'video',
  'video/mpeg': 'video',
  'video/ogg': 'video',
  'video/x-msvideo': 'video',
  'video/x-matroska': 'video',
  // Documentos
  'application/pdf': 'documento',
  'application/msword': 'documento',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    'documento',
  'application/vnd.ms-excel': 'documento',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
    'documento',
  'application/vnd.ms-powerpoint': 'documento',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation':
    'documento',
  'application/vnd.oasis.opendocument.text': 'documento',
  'application/vnd.oasis.opendocument.spreadsheet': 'documento',
  'application/vnd.oasis.opendocument.presentation': 'documento',
  'application/rtf': 'documento',
  // Texto
  'text/plain': 'texto',
  'text/csv': 'texto',
  'text/tab-separated-values': 'texto',
  'text/calendar': 'texto',
  'text/vcard': 'texto',
  'text/x-vcard': 'texto',
  'text/rtf': 'texto',
  // Compactados
  'application/zip': 'compactado',
  'application/x-zip-compressed': 'compactado',
};

/** Recusados sempre, mesmo que alguém os acrescente à lista acima por engano. */
const TIPOS_RECUSADOS = new Set([
  'image/svg+xml',
  'text/html',
  'application/xhtml+xml',
  'text/xml',
  'application/xml',
  'text/javascript',
  'application/javascript',
  'application/x-msdownload',
]);

/** Extensão → tipo, para quando o navegador manda `application/octet-stream`. */
const TIPO_POR_EXTENSAO: Readonly<Record<string, string>> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  heic: 'image/heic',
  heif: 'image/heif',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/opus',
  weba: 'audio/webm',
  wav: 'audio/wav',
  flac: 'audio/flac',
  amr: 'audio/amr',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  '3gp': 'video/3gpp',
  mpeg: 'video/mpeg',
  mpg: 'video/mpeg',
  ogv: 'video/ogg',
  avi: 'video/x-msvideo',
  mkv: 'video/x-matroska',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
  rtf: 'application/rtf',
  txt: 'text/plain',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  ics: 'text/calendar',
  vcf: 'text/vcard',
  zip: 'application/zip',
};

/** Tipos que o navegador pode abrir direto (`Content-Disposition: inline`). */
const TIPOS_EXIBIVEIS = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
  'application/pdf',
]);

/** Fotos de perfil: só imagens comuns. */
const TIPOS_DE_AVATAR = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

/** `Image/PNG; charset=…` → `image/png`. Vazio → `application/octet-stream`. */
export function normalizarMime(mime: string | null | undefined): string {
  const tipo = (mime ?? '').split(';')[0].trim().toLowerCase();
  return tipo || 'application/octet-stream';
}

/** Extensão do nome, sem o ponto e em minúsculas (`''` se não houver). */
export function extensaoDe(nome: string): string {
  const indice = nome.lastIndexOf('.');
  return indice > 0 && indice < nome.length - 1
    ? nome.slice(indice + 1).toLowerCase()
    : '';
}

/**
 * O tipo a gravar: o informado, normalizado; se vier genérico
 * (`application/octet-stream`), o da extensão do nome, quando conhecida.
 */
export function resolverMime(mime: string | null | undefined, nome: string) {
  const normalizado = normalizarMime(mime);
  if (normalizado !== 'application/octet-stream') {
    return normalizado;
  }
  return TIPO_POR_EXTENSAO[extensaoDe(nome)] ?? normalizado;
}

export type ResultadoDaPolitica =
  | { aceito: true; categoria: CategoriaDeArquivo; limiteBytes: number }
  | { aceito: false; motivo: string };

/**
 * O tipo é aceito neste contexto? Devolve a categoria e o limite de tamanho:
 * documentos até 100 MB, o resto até 25 MB, fotos de perfil até 5 MB e
 * planilhas de importação até 10 MB.
 */
export function avaliarTipo(
  mime: string,
  contexto: ContextoArquivo,
): ResultadoDaPolitica {
  if (TIPOS_RECUSADOS.has(mime)) {
    return {
      aceito: false,
      motivo:
        'Arquivos SVG, HTML e scripts não são aceitos. Envie uma imagem, um PDF ou um documento.',
    };
  }
  const categoria = TIPOS_ACEITOS[mime];
  if (!categoria) {
    return {
      aceito: false,
      motivo:
        'Este tipo de arquivo não é aceito. Envie imagem, áudio, vídeo, PDF, documento do Office, texto ou zip.',
    };
  }
  if (contexto === 'AVATAR') {
    return TIPOS_DE_AVATAR.has(mime)
      ? { aceito: true, categoria, limiteBytes: LIMITE_AVATAR_BYTES }
      : {
          aceito: false,
          motivo: 'A foto precisa ser uma imagem JPG, PNG, GIF ou WebP.',
        };
  }
  if (contexto === 'IMPORTACAO') {
    return { aceito: true, categoria, limiteBytes: LIMITE_IMPORTACAO_BYTES };
  }
  const documento =
    categoria === 'documento' ||
    categoria === 'texto' ||
    categoria === 'compactado';
  return {
    aceito: true,
    categoria,
    limiteBytes: documento ? LIMITE_DOCUMENTOS_BYTES : LIMITE_PADRAO_BYTES,
  };
}

/** "25 MB", "100 MB", "512 KB". */
export function descreverTamanho(bytes: number): string {
  if (bytes >= MB) {
    const valor = bytes / MB;
    return `${Number.isInteger(valor) ? valor : valor.toFixed(1).replace('.', ',')} MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Assinaturas (bytes iniciais) que o conteúdo precisa ter para o tipo declarado. */
const ASSINATURAS: Readonly<Record<string, readonly (readonly number[])[]>> = {
  'image/png': [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  'image/jpeg': [[0xff, 0xd8, 0xff]],
  'image/gif': [
    [0x47, 0x49, 0x46, 0x38, 0x37, 0x61],
    [0x47, 0x49, 0x46, 0x38, 0x39, 0x61],
  ],
  'application/pdf': [[0x25, 0x50, 0x44, 0x46, 0x2d]],
  'application/zip': [
    [0x50, 0x4b, 0x03, 0x04],
    [0x50, 0x4b, 0x05, 0x06],
  ],
};

/** Os formatos do Office atual e do OpenDocument são arquivos zip. */
const TIPOS_ZIP = new Set([
  'application/zip',
  'application/x-zip-compressed',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.presentation',
]);

function comecaCom(conteudo: Buffer, assinatura: readonly number[]): boolean {
  return (
    conteudo.length >= assinatura.length &&
    assinatura.every((byte, indice) => conteudo[indice] === byte)
  );
}

/** Início de marcação que o navegador poderia interpretar (HTML, SVG, script). */
const MARCACAO_PERIGOSA =
  /^<(?:!doctype\s+html|html[\s>]|svg[\s>]|script[\s>]|\?xml[^>]*>\s*<svg)/i;

/**
 * Confere os primeiros bytes (até 512) contra o tipo declarado. Devolve o
 * motivo da recusa, ou `null` se estiver tudo certo.
 *
 * - Conteúdo que começa como HTML, SVG ou script é sempre recusado.
 * - PNG, JPEG, GIF, WebP, PDF e os formatos zip (Office, OpenDocument) precisam
 *   ter a assinatura do formato. Os demais tipos não são conferidos.
 */
export function conferirConteudo(
  cabecalho: Buffer,
  mime: string,
): string | null {
  const texto = cabecalho
    .subarray(0, 512)
    .toString('utf8')
    .replace(/^\uFEFF/, '')
    .trimStart();
  if (MARCACAO_PERIGOSA.test(texto)) {
    return 'O conteúdo do arquivo parece uma página ou um SVG, e esses não são aceitos.';
  }
  if (cabecalho.length === 0) {
    return null;
  }
  const assinaturas = TIPOS_ZIP.has(mime)
    ? ASSINATURAS['application/zip']
    : mime === 'image/webp'
      ? null
      : ASSINATURAS[mime];
  if (mime === 'image/webp') {
    const riff = comecaCom(cabecalho, [0x52, 0x49, 0x46, 0x46]);
    const webp =
      cabecalho.length >= 12 &&
      cabecalho.subarray(8, 12).toString('latin1') === 'WEBP';
    return riff && webp ? null : motivoDeAssinatura();
  }
  if (!assinaturas) {
    return null;
  }
  return assinaturas.some((assinatura) => comecaCom(cabecalho, assinatura))
    ? null
    : motivoDeAssinatura();
}

function motivoDeAssinatura(): string {
  return 'O conteúdo do arquivo não corresponde ao tipo informado.';
}

const TAMANHO_MAXIMO_DO_NOME = 200;

/** Marcas de direção e de formatação invisíveis (zero-width, RLO/LRO, BOM…). */
const FORMATACAO_INVISIVEL = /[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

/** Tira os controles C0/C1 e o DEL (códigos 0–31 e 127–159) e a formatação invisível. */
function semControles(texto: string): string {
  let resultado = '';
  for (const caractere of texto) {
    const codigo = caractere.codePointAt(0) ?? 0;
    if (codigo > 0x1f && (codigo < 0x7f || codigo > 0x9f)) {
      resultado += caractere;
    }
  }
  return resultado.replace(FORMATACAO_INVISIVEL, '');
}

/**
 * Nome seguro para guardar e mostrar: sem caminho, sem caracteres de controle
 * nem de formatação invisível, espaços colapsados, até 200 caracteres
 * (preservando a extensão). Vazio vira `arquivo`.
 */
export function sanitizarNomeDeArquivo(
  nome: string | null | undefined,
): string {
  const semCaminho = (nome ?? '').split(/[\\/]/).pop() ?? '';
  const limpo = semControles(semCaminho.normalize('NFC'))
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '');
  if (!limpo) {
    return 'arquivo';
  }
  if (limpo.length <= TAMANHO_MAXIMO_DO_NOME) {
    return limpo;
  }
  const extensao = extensaoDe(limpo);
  const sufixo = extensao && extensao.length <= 10 ? `.${extensao}` : '';
  return `${limpo.slice(0, TAMANHO_MAXIMO_DO_NOME - sufixo.length).trimEnd()}${sufixo}`;
}

/**
 * `Content-Disposition` seguro (RFC 6266/5987): `filename` em ASCII (sem aspas,
 * barras nem `;`) e `filename*` com o nome completo em UTF-8.
 */
export function cabecalhoContentDisposition(
  nome: string,
  modo: 'inline' | 'attachment',
): string {
  const ascii =
    nome
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^\x20-\x7e]/g, '_')
      .replace(/["\\;%]/g, '_')
      .trim() || 'arquivo';
  const codificado = encodeURIComponent(nome).replace(
    /['()*]/g,
    (caractere) => `%${caractere.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${modo}; filename="${ascii}"; filename*=UTF-8''${codificado}`;
}

/** O navegador pode abrir este tipo direto (imagem comum, áudio, vídeo, PDF)? */
export function podeExibirNoNavegador(mime: string): boolean {
  return (
    TIPOS_EXIBIVEIS.has(mime) ||
    TIPOS_ACEITOS[mime] === 'audio' ||
    TIPOS_ACEITOS[mime] === 'video'
  );
}
