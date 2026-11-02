/**
 * Configuração do chat do site (R14), gravada em `canais.configuracao`: os
 * domínios onde o widget pode rodar (CORS e origem do Socket.IO), a aparência
 * e o formulário inicial. Funções puras — testadas em `configuracao-webchat.spec.ts`.
 */

/** Tema do widget: fixo ou o do sistema do visitante. */
export type TemaDoWidget = 'claro' | 'escuro' | 'automatico';
export const TEMAS_DO_WIDGET: readonly TemaDoWidget[] = [
  'claro',
  'escuro',
  'automatico',
];

/** Canto da página onde o botão do chat fica. */
export type PosicaoDoWidget = 'direita' | 'esquerda';
export const POSICOES_DO_WIDGET: readonly PosicaoDoWidget[] = [
  'direita',
  'esquerda',
];

/** Que meio de contato o formulário inicial pede (além do nome). */
export type ContatoDoFormulario = 'EMAIL' | 'TELEFONE' | 'EMAIL_OU_TELEFONE';
export const CONTATOS_DO_FORMULARIO: readonly ContatoDoFormulario[] = [
  'EMAIL',
  'TELEFONE',
  'EMAIL_OU_TELEFONE',
];

export interface AparenciaDoWidget {
  /** Título do cabeçalho do chat. */
  titulo: string;
  /** Linha abaixo do título (ex.: "Respondemos em poucos minutos"). */
  subtitulo: string | null;
  /** Primeira bolha que o visitante vê, antes de escrever. */
  saudacao: string | null;
  /** Cor principal (botão, cabeçalho, bolhas do visitante), `#RRGGBB`. */
  corPrimaria: string;
  /** Cor do texto sobre a cor principal (padrão: preto ou branco, a de mais contraste). */
  corTextoPrimaria: string;
  tema: TemaDoWidget;
  posicao: PosicaoDoWidget;
}

export interface ConfiguracaoWebchat {
  /**
   * Origens onde o widget roda (`https://www.site.com.br`; `https://*.site.com.br`
   * vale para os subdomínios). O CRM sempre pode (para a prévia na tela).
   */
  dominios: string[];
  aparencia: AparenciaDoWidget;
  /** Meio de contato pedido no formulário inicial. */
  contato: ContatoDoFormulario;
  /** Texto do consentimento (LGPD) que o visitante marca antes de conversar. */
  textoConsentimento: string;
  /** Link da política de privacidade, mostrado junto do consentimento. */
  urlPrivacidade: string | null;
  /** O visitante pode enviar arquivos (imagens, PDF, documentos). */
  permitirAnexos: boolean;
}

export const TEXTO_CONSENTIMENTO_PADRAO =
  'Concordo que meus dados sejam usados para responder a este atendimento, conforme a política de privacidade.';

export const COR_PRIMARIA_PADRAO = '#2563EB';

export const APARENCIA_PADRAO: AparenciaDoWidget = {
  titulo: 'Fale com a gente',
  subtitulo: 'Respondemos o mais rápido possível.',
  saudacao: 'Olá! Como podemos ajudar?',
  corPrimaria: COR_PRIMARIA_PADRAO,
  corTextoPrimaria: '#FFFFFF',
  tema: 'automatico',
  posicao: 'direita',
};

export const CONFIGURACAO_WEBCHAT_PADRAO: ConfiguracaoWebchat = {
  dominios: [],
  aparencia: APARENCIA_PADRAO,
  contato: 'EMAIL_OU_TELEFONE',
  textoConsentimento: TEXTO_CONSENTIMENTO_PADRAO,
  urlPrivacidade: null,
  permitirAnexos: true,
};

/** Máximo de domínios por canal. */
export const DOMINIOS_POR_CANAL = 20;

const COR = /^#[0-9a-f]{6}$/i;
const HOST =
  /^(\*\.)?([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/**
 * Normaliza um domínio digitado na tela para a origem que o navegador manda:
 * sem caminho, sem barra no fim, em minúsculas; sem esquema, assume `https://`.
 * `*.` no começo do host vale para qualquer subdomínio. Devolve `null` se não
 * serve.
 *
 * `www.site.com.br/contato` → `https://www.site.com.br`;
 * `http://localhost:8080/` → `http://localhost:8080`.
 */
export function normalizarDominio(entrada: string): string | null {
  let texto = entrada.trim().toLowerCase();
  if (texto === '') {
    return null;
  }
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(texto)) {
    texto = `https://${texto}`;
  }
  const curinga = /^(https?:\/\/)\*\./.exec(texto);
  const semCuringa = curinga ? texto.replace('*.', '') : texto;
  if (!URL.canParse(semCuringa)) {
    return null;
  }
  const url = new URL(semCuringa);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return null;
  }
  if (url.username || url.password) {
    return null;
  }
  const host = `${curinga ? '*.' : ''}${url.hostname}`;
  if (!HOST.test(host) && !/^\[[0-9a-f:.]+\]$/.test(url.hostname)) {
    return null;
  }
  return `${url.protocol}//${host}${url.port ? `:${url.port}` : ''}`;
}

/** A origem (`https://www.site.com.br`) casa com algum dos domínios do canal? */
export function origemPermitida(
  origem: string,
  dominios: readonly string[],
): boolean {
  const normalizada = origem.trim().toLowerCase();
  if (!URL.canParse(normalizada)) {
    return false;
  }
  const url = new URL(normalizada);
  const porta = url.port ? `:${url.port}` : '';
  for (const dominio of dominios) {
    if (dominio === `${url.protocol}//${url.hostname}${porta}`) {
      return true;
    }
    const curinga = /^(https?:)\/\/\*\.([^:/]+)(:\d+)?$/.exec(dominio);
    if (
      curinga &&
      curinga[1] === url.protocol &&
      (curinga[3] ?? '') === porta &&
      url.hostname.endsWith(`.${curinga[2]}`)
    ) {
      return true;
    }
  }
  return false;
}

/** Cor de texto (preto ou branco) de mais contraste sobre a cor de fundo. */
export function corDeTextoPara(fundo: string): string {
  const valor = COR.test(fundo) ? fundo.slice(1) : COR_PRIMARIA_PADRAO.slice(1);
  const canais = [0, 2, 4].map((inicio) => {
    const c = Number.parseInt(valor.slice(inicio, inicio + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const luminancia =
    0.2126 * canais[0] + 0.7152 * canais[1] + 0.0722 * canais[2];
  // Contraste com branco (1.05 / (L + 0.05)) contra preto ((L + 0.05) / 0.05).
  return 1.05 / (luminancia + 0.05) >= (luminancia + 0.05) / 0.05
    ? '#FFFFFF'
    : '#111827';
}

/** Problema encontrado na configuração, com o campo (para `detalhes.campos`). */
export interface ProblemaDaConfiguracao {
  campo: string;
  mensagem: string;
}

/** O que a tela pode mandar (todos os campos opcionais: vale o atual/padrão). */
export interface EntradaDaConfiguracaoWebchat {
  dominios?: readonly string[];
  aparencia?: Partial<Record<keyof AparenciaDoWidget, string | null>>;
  contato?: string;
  textoConsentimento?: string | null;
  urlPrivacidade?: string | null;
  permitirAnexos?: boolean;
}

/**
 * Junta a entrada da tela com a configuração atual (ou a padrão) e confere:
 * domínios válidos (sem repetir), cores `#RRGGBB`, tema, posição, meio de
 * contato e o link da política (http/https). Devolve a configuração pronta
 * para gravar ou os problemas.
 */
export function montarConfiguracaoWebchat(
  entrada: EntradaDaConfiguracaoWebchat,
  atual: ConfiguracaoWebchat = CONFIGURACAO_WEBCHAT_PADRAO,
):
  | { configuracao: ConfiguracaoWebchat; problemas?: never }
  | { configuracao?: never; problemas: ProblemaDaConfiguracao[] } {
  const problemas: ProblemaDaConfiguracao[] = [];

  let dominios = atual.dominios;
  if (entrada.dominios !== undefined) {
    const vistos = new Set<string>();
    entrada.dominios.forEach((dominio, indice) => {
      const normalizado = normalizarDominio(dominio);
      if (!normalizado) {
        problemas.push({
          campo: `dominios.${indice}`,
          mensagem: `"${dominio}" não é um endereço de site válido (ex.: https://www.seusite.com.br).`,
        });
        return;
      }
      vistos.add(normalizado);
    });
    if (vistos.size > DOMINIOS_POR_CANAL) {
      problemas.push({
        campo: 'dominios',
        mensagem: `Informe no máximo ${DOMINIOS_POR_CANAL} domínios.`,
      });
    }
    dominios = [...vistos];
  }

  const aparencia: AparenciaDoWidget = { ...atual.aparencia };
  const pedida = entrada.aparencia ?? {};
  if (pedida.titulo !== undefined) {
    const titulo = pedida.titulo?.trim() ?? '';
    if (titulo === '') {
      problemas.push({
        campo: 'aparencia.titulo',
        mensagem: 'O título do chat é obrigatório.',
      });
    } else {
      aparencia.titulo = titulo;
    }
  }
  for (const campo of ['subtitulo', 'saudacao'] as const) {
    if (pedida[campo] !== undefined) {
      aparencia[campo] = pedida[campo]?.trim() || null;
    }
  }
  let corPrimariaMudou = false;
  for (const campo of ['corPrimaria', 'corTextoPrimaria'] as const) {
    const valor = pedida[campo];
    if (valor === undefined) {
      continue;
    }
    if (valor === null && campo === 'corTextoPrimaria') {
      aparencia.corTextoPrimaria = corDeTextoPara(aparencia.corPrimaria);
      continue;
    }
    if (typeof valor !== 'string' || !COR.test(valor.trim())) {
      problemas.push({
        campo: `aparencia.${campo}`,
        mensagem: 'Use uma cor no formato #RRGGBB (ex.: #2563EB).',
      });
      continue;
    }
    aparencia[campo] = valor.trim().toUpperCase();
    corPrimariaMudou ||= campo === 'corPrimaria';
  }
  if (corPrimariaMudou && pedida.corTextoPrimaria === undefined) {
    aparencia.corTextoPrimaria = corDeTextoPara(aparencia.corPrimaria);
  }
  if (pedida.tema !== undefined) {
    if (TEMAS_DO_WIDGET.includes(pedida.tema as TemaDoWidget)) {
      aparencia.tema = pedida.tema as TemaDoWidget;
    } else {
      problemas.push({
        campo: 'aparencia.tema',
        mensagem: `Tema inválido: use ${TEMAS_DO_WIDGET.join(', ')}.`,
      });
    }
  }
  if (pedida.posicao !== undefined) {
    if (POSICOES_DO_WIDGET.includes(pedida.posicao as PosicaoDoWidget)) {
      aparencia.posicao = pedida.posicao as PosicaoDoWidget;
    } else {
      problemas.push({
        campo: 'aparencia.posicao',
        mensagem: `Posição inválida: use ${POSICOES_DO_WIDGET.join(' ou ')}.`,
      });
    }
  }

  let contato = atual.contato;
  if (entrada.contato !== undefined) {
    if (
      CONTATOS_DO_FORMULARIO.includes(entrada.contato as ContatoDoFormulario)
    ) {
      contato = entrada.contato as ContatoDoFormulario;
    } else {
      problemas.push({
        campo: 'contato',
        mensagem: `Use ${CONTATOS_DO_FORMULARIO.join(', ')}.`,
      });
    }
  }

  let textoConsentimento = atual.textoConsentimento;
  if (entrada.textoConsentimento !== undefined) {
    textoConsentimento =
      entrada.textoConsentimento?.trim() || TEXTO_CONSENTIMENTO_PADRAO;
  }

  let urlPrivacidade = atual.urlPrivacidade;
  if (entrada.urlPrivacidade !== undefined) {
    const url = entrada.urlPrivacidade?.trim() || null;
    if (url && !ehUrlHttp(url)) {
      problemas.push({
        campo: 'urlPrivacidade',
        mensagem: 'Informe o endereço completo da política (https://…).',
      });
    } else {
      urlPrivacidade = url;
    }
  }

  const permitirAnexos = entrada.permitirAnexos ?? atual.permitirAnexos;

  if (problemas.length > 0) {
    return { problemas };
  }
  return {
    configuracao: {
      dominios,
      aparencia,
      contato,
      textoConsentimento,
      urlPrivacidade,
      permitirAnexos,
    },
  };
}

/**
 * Lê a configuração gravada no canal, completando o que faltar com o padrão
 * (um JSON quebrado gravado à mão não derruba o widget).
 */
export function lerConfiguracaoWebchat(valor: unknown): ConfiguracaoWebchat {
  const gravada =
    typeof valor === 'object' && valor !== null && !Array.isArray(valor)
      ? (valor as Partial<ConfiguracaoWebchat>)
      : {};
  const aparenciaGravada =
    typeof gravada.aparencia === 'object' && gravada.aparencia !== null
      ? gravada.aparencia
      : {};
  const aparencia: AparenciaDoWidget = {
    ...APARENCIA_PADRAO,
    ...Object.fromEntries(
      Object.entries(aparenciaGravada).filter(
        ([, item]) => item === null || typeof item === 'string',
      ),
    ),
  };
  if (!COR.test(aparencia.corPrimaria)) {
    aparencia.corPrimaria = COR_PRIMARIA_PADRAO;
  }
  if (!COR.test(aparencia.corTextoPrimaria)) {
    aparencia.corTextoPrimaria = corDeTextoPara(aparencia.corPrimaria);
  }
  if (!TEMAS_DO_WIDGET.includes(aparencia.tema)) {
    aparencia.tema = APARENCIA_PADRAO.tema;
  }
  if (!POSICOES_DO_WIDGET.includes(aparencia.posicao)) {
    aparencia.posicao = APARENCIA_PADRAO.posicao;
  }
  if (typeof aparencia.titulo !== 'string' || aparencia.titulo.trim() === '') {
    aparencia.titulo = APARENCIA_PADRAO.titulo;
  }
  return {
    dominios: Array.isArray(gravada.dominios)
      ? gravada.dominios.filter(
          (dominio): dominio is string => typeof dominio === 'string',
        )
      : [],
    aparencia,
    contato: CONTATOS_DO_FORMULARIO.includes(
      gravada.contato as ContatoDoFormulario,
    )
      ? (gravada.contato as ContatoDoFormulario)
      : CONFIGURACAO_WEBCHAT_PADRAO.contato,
    textoConsentimento:
      typeof gravada.textoConsentimento === 'string' &&
      gravada.textoConsentimento.trim() !== ''
        ? gravada.textoConsentimento
        : TEXTO_CONSENTIMENTO_PADRAO,
    urlPrivacidade:
      typeof gravada.urlPrivacidade === 'string' &&
      ehUrlHttp(gravada.urlPrivacidade)
        ? gravada.urlPrivacidade
        : null,
    permitirAnexos:
      typeof gravada.permitirAnexos === 'boolean'
        ? gravada.permitirAnexos
        : CONFIGURACAO_WEBCHAT_PADRAO.permitirAnexos,
  };
}

function ehUrlHttp(texto: string): boolean {
  if (!URL.canParse(texto)) {
    return false;
  }
  const protocolo = new URL(texto).protocol;
  return protocolo === 'https:' || protocolo === 'http:';
}

/**
 * Trecho de instalação mostrado na tela do canal: o site cola antes de
 * `</body>`. O widget lê a chave do `data-chave` e o endereço da API do `src`.
 */
export function trechoDeInstalacao(urlDoWidget: string, chave: string): string {
  return `<script src="${urlDoWidget}" data-chave="${chave}" async></script>`;
}
