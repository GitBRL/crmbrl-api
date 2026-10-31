/**
 * Modelo do corpo do webhook de chamados (R25): um JSON escrito pelo Admin com
 * variáveis `{{…}}` dentro dos textos. Cada texto tem as variáveis trocadas
 * pelo valor; um texto que é exatamente `"{{conversa}}"` vira a lista de
 * mensagens (`[{autor, texto}]`). Funções puras.
 */

/** Variáveis aceitas no modelo. */
export const VARIAVEIS_DO_CORPO = [
  'chamadoId',
  'conversaId',
  'titulo',
  'descricao',
  'categoria',
  'tela',
  'criadoEm',
  'usuario.nome',
  'usuario.email',
  'usuario.papel',
  'usuario.area',
  'conversa',
  'conversaTexto',
] as const;
export type VariavelDoCorpo = (typeof VARIAVEIS_DO_CORPO)[number];

export interface MensagemDaConversa {
  autor: 'pessoa' | 'assistente';
  texto: string;
}

export type DadosDoCorpo = Record<
  Exclude<VariavelDoCorpo, 'conversa'>,
  string
> & { conversa: MensagemDaConversa[] };

/** O corpo quando o Admin não escreve um modelo. */
export const MODELO_CORPO_PADRAO = JSON.stringify(
  {
    evento: 'assistente.chamado',
    chamado: {
      id: '{{chamadoId}}',
      titulo: '{{titulo}}',
      descricao: '{{descricao}}',
      categoria: '{{categoria}}',
      tela: '{{tela}}',
      criadoEm: '{{criadoEm}}',
    },
    usuario: {
      nome: '{{usuario.nome}}',
      email: '{{usuario.email}}',
      papel: '{{usuario.papel}}',
      area: '{{usuario.area}}',
    },
    conversa: '{{conversa}}',
  },
  null,
  2,
);

const VARIAVEL = /\{\{\s*([\w.]+)\s*\}\}/g;

/** `null` se o modelo é válido; senão, a mensagem do problema. */
export function validarModeloCorpo(modelo: string): string | null {
  let json: unknown;
  try {
    json = JSON.parse(modelo);
  } catch {
    return 'O modelo do corpo precisa ser um JSON válido.';
  }
  if (typeof json !== 'object' || json === null) {
    return 'O modelo do corpo precisa ser um objeto ou uma lista JSON.';
  }
  const desconhecidas = new Set<string>();
  for (const [, nome] of modelo.matchAll(VARIAVEL)) {
    if (!(VARIAVEIS_DO_CORPO as readonly string[]).includes(nome)) {
      desconhecidas.add(nome);
    }
  }
  if (desconhecidas.size) {
    return `Variáveis desconhecidas no modelo: ${[...desconhecidas].join(', ')}. Use ${VARIAVEIS_DO_CORPO.map((v) => `{{${v}}}`).join(', ')}.`;
  }
  return null;
}

function trocar(valor: unknown, dados: DadosDoCorpo): unknown {
  if (typeof valor === 'string') {
    if (/^\{\{\s*conversa\s*\}\}$/.test(valor)) {
      return dados.conversa;
    }
    return valor.replace(VARIAVEL, (inteiro, nome: string) => {
      if (nome === 'conversa') {
        return dados.conversaTexto;
      }
      const v = (dados as unknown as Record<string, unknown>)[nome];
      return typeof v === 'string' ? v : inteiro;
    });
  }
  if (Array.isArray(valor)) {
    return valor.map((v) => trocar(v, dados));
  }
  if (typeof valor === 'object' && valor !== null) {
    return Object.fromEntries(
      Object.entries(valor).map(([k, v]) => [k, trocar(v, dados)]),
    );
  }
  return valor;
}

/** O corpo JSON (texto) a enviar. O modelo já foi validado ao ser salvo. */
export function renderizarCorpo(
  modelo: string | null,
  dados: DadosDoCorpo,
): string {
  const base = JSON.parse(modelo ?? MODELO_CORPO_PADRAO) as unknown;
  return JSON.stringify(trocar(base, dados));
}

function textoOuNumero(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) {
    return String(v);
  }
  if (typeof v === 'string' && v.trim()) {
    return v.trim().slice(0, 100);
  }
  return null;
}

function urlHttp(v: unknown): string | null {
  if (typeof v !== 'string' || !URL.canParse(v)) {
    return null;
  }
  const url = new URL(v);
  return /^https?:$/.test(url.protocol) ? url.toString().slice(0, 500) : null;
}

/**
 * Número e link do chamado na resposta do destino: `numero`, `protocolo` ou
 * `id` (também dentro de `chamado`, `ticket` ou `data`); `link` ou `url`.
 */
export function numeroELinkDaResposta(corpo: unknown): {
  numero: string | null;
  link: string | null;
} {
  if (typeof corpo !== 'object' || corpo === null) {
    return { numero: null, link: null };
  }
  const raiz = corpo as Record<string, unknown>;
  const candidatos = [raiz];
  for (const chave of ['chamado', 'ticket', 'data']) {
    const v = raiz[chave];
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      candidatos.push(v as Record<string, unknown>);
    }
  }
  let numero: string | null = null;
  let link: string | null = null;
  for (const c of candidatos) {
    numero ??=
      textoOuNumero(c.numero) ??
      textoOuNumero(c.protocolo) ??
      textoOuNumero(c.id);
    link ??= urlHttp(c.link) ?? urlHttp(c.url);
  }
  return { numero, link };
}
