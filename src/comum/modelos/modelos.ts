/**
 * Renderizador de modelos de mensagem (Onda B, §2.1): funções puras, sem banco.
 *
 * Sintaxe:
 * - variável: `{{contato.nome}}`, `{{contato.primeiro_nome}}`, `{{empresa.nome}}`,
 *   `{{negocio.titulo}}`, `{{responsavel.nome}}`, campos personalizados
 *   `{{contato.campos.cidade}}` e variáveis da execução `{{variaveis.resposta}}`;
 * - valor padrão: `{{contato.primeiro_nome|cliente}}` (usado quando vazio);
 * - variações: `{Olá|Oi|E aí}` — uma opção sorteada por destinatário, de forma
 *   reprodutível pela semente (o id do destinatário). As opções podem ter
 *   variáveis: `{Olá {{contato.primeiro_nome}}|Oi}`. Chaves sem `|` ficam como
 *   texto (`{assim}`).
 *
 * ```ts
 * const { erros } = validarModelo('Oi {{contato.primeiro_nome|tudo bem}}?');
 * const texto = renderizarModelo('{Olá|Oi}, {{contato.primeiro_nome}}!', dados, { semente: destinatario.id });
 * ```
 */

/** Variáveis conhecidas (fora os prefixos dinâmicos), com rótulo e exemplo para o editor. */
export const VARIAVEIS_DE_MODELO = [
  { chave: 'contato.nome', rotulo: 'Nome do contato', exemplo: 'Ana Souza' },
  {
    chave: 'contato.primeiro_nome',
    rotulo: 'Primeiro nome do contato',
    exemplo: 'Ana',
  },
  {
    chave: 'contato.email',
    rotulo: 'E-mail do contato',
    exemplo: 'ana@exemplo.com.br',
  },
  {
    chave: 'contato.telefone',
    rotulo: 'Telefone do contato',
    exemplo: '5511987654321',
  },
  { chave: 'contato.cargo', rotulo: 'Cargo do contato', exemplo: 'Diretora' },
  { chave: 'empresa.nome', rotulo: 'Nome da empresa', exemplo: 'Exemplo Ltda' },
  {
    chave: 'negocio.titulo',
    rotulo: 'Título do negócio',
    exemplo: 'Plano anual',
  },
  {
    chave: 'negocio.valor',
    rotulo: 'Valor do negócio',
    exemplo: 'R$ 1.500,00',
  },
  { chave: 'negocio.etapa', rotulo: 'Etapa do negócio', exemplo: 'Proposta' },
  { chave: 'negocio.funil', rotulo: 'Funil do negócio', exemplo: 'Comercial' },
  {
    chave: 'responsavel.nome',
    rotulo: 'Nome do responsável',
    exemplo: 'Bruno Lima',
  },
  {
    chave: 'responsavel.primeiro_nome',
    rotulo: 'Primeiro nome do responsável',
    exemplo: 'Bruno',
  },
  {
    chave: 'responsavel.email',
    rotulo: 'E-mail do responsável',
    exemplo: 'bruno@brl.com.br',
  },
  {
    chave: 'responsavel.telefone',
    rotulo: 'Telefone do responsável',
    exemplo: '5511912345678',
  },
] as const;

/** Prefixos de variáveis dinâmicas: campos personalizados e variáveis da execução. */
export const PREFIXOS_DE_MODELO = [
  { prefixo: 'contato.campos.', rotulo: 'Campo personalizado do contato' },
  { prefixo: 'empresa.campos.', rotulo: 'Campo personalizado da empresa' },
  { prefixo: 'negocio.campos.', rotulo: 'Campo personalizado do negócio' },
  {
    prefixo: 'variaveis.',
    rotulo: 'Variável do fluxo/automação (respostas do chatbot…)',
  },
] as const;

const CHAVES_CONHECIDAS = new Set<string>(
  VARIAVEIS_DE_MODELO.map((v) => v.chave),
);

/** Dados para renderizar. Tudo opcional: o que faltar sai vazio (ou com o padrão). */
export interface DadosDoModelo {
  contato?: {
    nome?: string | null;
    email?: string | null;
    telefone?: string | null;
    cargo?: string | null;
    campos?: Record<string, unknown> | null;
  } | null;
  empresa?: {
    nome?: string | null;
    campos?: Record<string, unknown> | null;
  } | null;
  negocio?: {
    titulo?: string | null;
    /** Já formatado (`R$ 1.500,00`) ou número/decimal em texto (`"1500.00"`). */
    valor?: string | number | null;
    etapa?: string | null;
    funil?: string | null;
    campos?: Record<string, unknown> | null;
  } | null;
  responsavel?: {
    nome?: string | null;
    email?: string | null;
    telefone?: string | null;
  } | null;
  variaveis?: Record<string, unknown> | null;
}

export type PecaDeModelo =
  | { tipo: 'texto'; valor: string }
  | {
      tipo: 'variavel';
      caminho: string;
      padrao?: string;
      inicio: number;
      fim: number;
    }
  | { tipo: 'variacao'; opcoes: PecaDeModelo[][]; inicio: number; fim: number };

export interface ErroDeModelo {
  /** Em português, pronto para mostrar. */
  mensagem: string;
  /** Posição no texto (índice do primeiro caractere e o seguinte ao último). */
  inicio: number;
  fim: number;
  /** A variável problemática, quando for o caso. */
  variavel?: string;
}

export interface ModeloAnalisado {
  pecas: PecaDeModelo[];
  /** Caminhos das variáveis usadas (sem repetição, na ordem). */
  variaveis: string[];
  /** Quantidade de grupos de variação. */
  variacoes: number;
  erros: ErroDeModelo[];
}

export interface OpcoesDeValidacao {
  /** Variáveis extras aceitas (ex.: `campanha.nome`). */
  variaveisExtras?: readonly string[];
  /** Aceitar `variaveis.*` (padrão: sim). */
  permitirVariaveisDaExecucao?: boolean;
}

const CAMINHO = /^[a-z_][a-z0-9_]*(\.[\p{L}\p{N}_-]+)*$/u;

/** Quebra o texto em peças e aponta erros de sintaxe (chaves sem fechar, variável vazia). */
export function analisarModelo(texto: string): ModeloAnalisado {
  const erros: ErroDeModelo[] = [];
  const pecas = analisarTrecho(texto, 0, texto.length, true, erros);
  const variaveis: string[] = [];
  let variacoes = 0;
  const visitar = (lista: PecaDeModelo[]) => {
    for (const peca of lista) {
      if (peca.tipo === 'variavel' && !variaveis.includes(peca.caminho)) {
        variaveis.push(peca.caminho);
      } else if (peca.tipo === 'variacao') {
        variacoes++;
        peca.opcoes.forEach(visitar);
      }
    }
  };
  visitar(pecas);
  return { pecas, variaveis, variacoes, erros };
}

/**
 * Valida o modelo: sintaxe e variáveis desconhecidas (R17/R19). `valido` é
 * falso se houver qualquer erro.
 */
export function validarModelo(
  texto: string,
  opcoes: OpcoesDeValidacao = {},
): ModeloAnalisado & { valido: boolean } {
  const analise = analisarModelo(texto);
  const extras = new Set(opcoes.variaveisExtras ?? []);
  const permitirExecucao = opcoes.permitirVariaveisDaExecucao ?? true;
  const conferir = (lista: PecaDeModelo[]) => {
    for (const peca of lista) {
      if (peca.tipo === 'variacao') {
        peca.opcoes.forEach(conferir);
        continue;
      }
      if (peca.tipo !== 'variavel') {
        continue;
      }
      if (!variavelConhecida(peca.caminho, extras, permitirExecucao)) {
        analise.erros.push({
          mensagem: `Variável desconhecida: {{${peca.caminho}}}.`,
          inicio: peca.inicio,
          fim: peca.fim,
          variavel: peca.caminho,
        });
      }
    }
  };
  conferir(analise.pecas);
  analise.erros.sort((a, b) => a.inicio - b.inicio);
  return { ...analise, valido: analise.erros.length === 0 };
}

export function variavelConhecida(
  caminho: string,
  extras: ReadonlySet<string> = new Set(),
  permitirVariaveisDaExecucao = true,
): boolean {
  if (CHAVES_CONHECIDAS.has(caminho) || extras.has(caminho)) {
    return true;
  }
  return PREFIXOS_DE_MODELO.some(
    ({ prefixo }) =>
      caminho.startsWith(prefixo) &&
      caminho.length > prefixo.length &&
      (permitirVariaveisDaExecucao || prefixo !== 'variaveis.'),
  );
}

export interface OpcoesDeRenderizacao {
  /**
   * Semente das variações (ex.: id do destinatário): a mesma semente sorteia
   * sempre as mesmas opções. Sem semente, o sorteio é aleatório.
   */
  semente?: string;
  /** Valores extras por caminho (ex.: `{ 'campanha.nome': 'Black Friday' }`). */
  extras?: Readonly<Record<string, unknown>>;
}

/** Renderiza o modelo. Erros de sintaxe não impedem: o trecho inválido sai como texto. */
export function renderizarModelo(
  texto: string,
  dados: DadosDoModelo,
  opcoes: OpcoesDeRenderizacao = {},
): string {
  const { pecas } = analisarModelo(texto);
  const sortear =
    opcoes.semente === undefined
      ? Math.random
      : geradorComSemente(opcoes.semente);
  const montar = (lista: PecaDeModelo[]): string =>
    lista
      .map((peca) => {
        if (peca.tipo === 'texto') {
          return peca.valor;
        }
        if (peca.tipo === 'variavel') {
          const valor = resolverVariavel(peca.caminho, dados, opcoes.extras);
          return valor === '' ? (peca.padrao ?? '') : valor;
        }
        const indice = Math.min(
          peca.opcoes.length - 1,
          Math.floor(sortear() * peca.opcoes.length),
        );
        return montar(peca.opcoes[indice]);
      })
      .join('');
  return montar(pecas);
}

/** Valor de uma variável como texto ('' quando não há). */
export function resolverVariavel(
  caminho: string,
  dados: DadosDoModelo,
  extras?: Readonly<Record<string, unknown>>,
): string {
  if (extras && caminho in extras) {
    return comoTexto(extras[caminho]);
  }
  const [raiz, campo, ...resto] = caminho.split('.');
  switch (raiz) {
    case 'contato': {
      const contato = dados.contato;
      if (campo === 'primeiro_nome') {
        return primeiroNome(contato?.nome);
      }
      if (campo === 'campos') {
        return comoTexto(lerCaminho(contato?.campos, resto));
      }
      return comoTexto(lerCaminho(contato, [campo]));
    }
    case 'empresa':
      return campo === 'campos'
        ? comoTexto(lerCaminho(dados.empresa?.campos, resto))
        : comoTexto(lerCaminho(dados.empresa, [campo]));
    case 'negocio': {
      if (campo === 'campos') {
        return comoTexto(lerCaminho(dados.negocio?.campos, resto));
      }
      if (campo === 'valor') {
        return formatarValor(dados.negocio?.valor);
      }
      return comoTexto(lerCaminho(dados.negocio, [campo]));
    }
    case 'responsavel':
      return campo === 'primeiro_nome'
        ? primeiroNome(dados.responsavel?.nome)
        : comoTexto(lerCaminho(dados.responsavel, [campo]));
    case 'variaveis':
      return comoTexto(lerCaminho(dados.variaveis, [campo, ...resto]));
    default:
      return '';
  }
}

/** "Ana Maria Souza" → "Ana". */
export function primeiroNome(nome: string | null | undefined): string {
  return (nome ?? '').trim().split(/\s+/)[0] ?? '';
}

/**
 * Gerador pseudoaleatório reprodutível (mulberry32 sobre um hash da semente):
 * devolve uma função como `Math.random`.
 */
export function geradorComSemente(semente: string): () => number {
  let estado = hashDeTexto(semente);
  return () => {
    estado = (estado + 0x6d2b79f5) | 0;
    let t = estado;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashDeTexto(texto: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < texto.length; i++) {
    h ^= texto.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function lerCaminho(objeto: unknown, partes: readonly string[]): unknown {
  let atual: unknown = objeto;
  for (const parte of partes) {
    if (atual === null || typeof atual !== 'object' || Array.isArray(atual)) {
      return undefined;
    }
    atual = (atual as Record<string, unknown>)[parte];
  }
  return atual;
}

function comoTexto(valor: unknown): string {
  if (valor === null || valor === undefined) {
    return '';
  }
  if (typeof valor === 'string') {
    return valor.trim();
  }
  if (typeof valor === 'number' || typeof valor === 'bigint') {
    return String(valor);
  }
  if (typeof valor === 'boolean') {
    return valor ? 'sim' : 'não';
  }
  if (valor instanceof Date) {
    return valor.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  }
  if (Array.isArray(valor)) {
    return valor.map(comoTexto).filter(Boolean).join(', ');
  }
  return '';
}

const FORMATO_REAL = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
});

function formatarValor(valor: string | number | null | undefined): string {
  if (valor === null || valor === undefined || valor === '') {
    return '';
  }
  if (typeof valor === 'string' && !/^-?\d+(\.\d+)?$/.test(valor.trim())) {
    return valor.trim();
  }
  const numero = Number(valor);
  return Number.isFinite(numero)
    ? FORMATO_REAL.format(numero).replace(/ /g, ' ')
    : '';
}

/**
 * Analisa `texto[inicio, fim)`. `permitirVariacao` é falso dentro das opções
 * de uma variação (não há variação dentro de variação).
 */
function analisarTrecho(
  texto: string,
  inicio: number,
  fim: number,
  permitirVariacao: boolean,
  erros: ErroDeModelo[],
): PecaDeModelo[] {
  const pecas: PecaDeModelo[] = [];
  let literal = '';
  const fecharLiteral = () => {
    if (literal) {
      pecas.push({ tipo: 'texto', valor: literal });
      literal = '';
    }
  };
  let i = inicio;
  while (i < fim) {
    if (texto.startsWith('{{', i)) {
      const fecha = texto.indexOf('}}', i + 2);
      if (fecha === -1 || fecha + 2 > fim) {
        erros.push({
          mensagem: 'Variável sem fechar: falta "}}".',
          inicio: i,
          fim: Math.min(fim, i + 2),
        });
        literal += texto.slice(i, fim);
        i = fim;
        continue;
      }
      const conteudo = texto.slice(i + 2, fecha);
      const barra = conteudo.indexOf('|');
      const caminho = (
        barra === -1 ? conteudo : conteudo.slice(0, barra)
      ).trim();
      const padrao =
        barra === -1 ? undefined : conteudo.slice(barra + 1).trim();
      if (!caminho || !CAMINHO.test(caminho)) {
        erros.push({
          mensagem: caminho
            ? `Variável inválida: {{${caminho}}}.`
            : 'Variável vazia: {{}}.',
          inicio: i,
          fim: fecha + 2,
          variavel: caminho || undefined,
        });
        literal += texto.slice(i, fecha + 2);
      } else {
        fecharLiteral();
        pecas.push({
          tipo: 'variavel',
          caminho,
          ...(padrao !== undefined ? { padrao } : {}),
          inicio: i,
          fim: fecha + 2,
        });
      }
      i = fecha + 2;
      continue;
    }
    if (texto[i] === '{' && permitirVariacao) {
      const grupo = lerGrupo(texto, i, fim);
      if (grupo && grupo.separadores.length > 0) {
        fecharLiteral();
        const limites = [i, ...grupo.separadores, grupo.fecha];
        const opcoes: PecaDeModelo[][] = [];
        for (let k = 0; k < limites.length - 1; k++) {
          opcoes.push(
            analisarTrecho(texto, limites[k] + 1, limites[k + 1], false, erros),
          );
        }
        pecas.push({
          tipo: 'variacao',
          opcoes,
          inicio: i,
          fim: grupo.fecha + 1,
        });
        i = grupo.fecha + 1;
        continue;
      }
    }
    literal += texto[i];
    i++;
  }
  fecharLiteral();
  return pecas;
}

/**
 * Lê um grupo `{…}` a partir de `abre`, pulando variáveis `{{…}}` internas.
 * Devolve a posição do `}` e as dos `|` de primeiro nível; nulo se não fechar
 * (ou se houver outro `{` simples dentro: aí não é variação).
 */
function lerGrupo(
  texto: string,
  abre: number,
  fim: number,
): { fecha: number; separadores: number[] } | null {
  const separadores: number[] = [];
  let i = abre + 1;
  while (i < fim) {
    if (texto.startsWith('{{', i)) {
      const fecha = texto.indexOf('}}', i + 2);
      if (fecha === -1 || fecha + 2 > fim) {
        return null;
      }
      i = fecha + 2;
      continue;
    }
    const caractere = texto[i];
    if (caractere === '{') {
      return null;
    }
    if (caractere === '}') {
      return { fecha: i, separadores };
    }
    if (caractere === '|') {
      separadores.push(i);
    }
    i++;
  }
  return null;
}
