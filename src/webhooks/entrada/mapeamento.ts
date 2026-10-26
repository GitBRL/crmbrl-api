/**
 * Mapeamento de campos dos webhooks de entrada (R8.1): caminho no JSON
 * recebido → campo do contato ou do negócio. Funções puras, sem banco: o
 * processamento (R8.5), a prévia e a validação da configuração usam as
 * mesmas regras.
 *
 * Formato gravado em `webhooks_entrada.mapeamento` (modelo `PERSONALIZADO`):
 *
 * ```json
 * {
 *   "campos": [
 *     { "caminho": "lead.nome", "destino": "nome" },
 *     { "caminho": "lead.contatos[0].email", "destino": "email" },
 *     { "caminho": "planilha_*", "destino": "camposPersonalizados.planilha_*" }
 *   ],
 *   "ignorarQuando": [{ "caminho": "teste", "valor": true }]
 * }
 * ```
 *
 * - `caminho`: chaves separadas por ponto, com índice de lista (`itens[0]` ou
 *   `itens.0`). Uma chave com ponto na raiz (`"utm.source"`) também vale. O
 *   último trecho pode ter um `*` (curinga), que casa várias chaves.
 * - `destino`: `nome`, `email`, `telefone`, `empresa`, `cargo`, `titulo`,
 *   `valor`, `valorRecorrente`, `etiquetas`, `utm.<source|medium|campaign|term|content>`
 *   ou `camposPersonalizados.<chave>`. Com curinga no caminho, o destino é
 *   `etiquetas` ou `camposPersonalizados.<…*…>`: o `*` do destino recebe o que
 *   o `*` do caminho casou.
 * - Vários caminhos para o mesmo destino: vale o primeiro que trouxer valor
 *   (no e-mail e no telefone, o primeiro **válido**); etiquetas se somam.
 * - `ignorarQuando`: se o campo vier com o valor indicado, o recebimento é
 *   ignorado (ex.: os envios de teste do sistema de disparos).
 */
import { FORMATO_VALOR } from '../../comum/dominio/dinheiro';
import { ehEmailValido, normalizarEmail } from '../../comum/dominio/email';
import { normalizarEtiquetas } from '../../comum/dominio/etiquetas';
import { normalizarTelefone } from '../../comum/dominio/telefone';
import { CAMPOS_UTM, type CampoUtm, type Utm } from '../../comum/dominio/utm';
import type { ProblemaDeCampo } from '../../comum/validacao/validacao';
import type { ModeloMapeamento, Prisma } from '../../generated/prisma/client';

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

export interface RegraDeCampo {
  readonly caminho: string;
  readonly destino: string;
}

export type ValorDeCondicao = string | number | boolean;

export interface CondicaoParaIgnorar {
  readonly caminho: string;
  readonly valor: ValorDeCondicao;
}

export interface Mapeamento {
  readonly campos: readonly RegraDeCampo[];
  readonly ignorarQuando: readonly CondicaoParaIgnorar[];
}

/** Destinos de um valor só (o primeiro caminho que trouxer valor vence). */
export const DESTINOS_DE_TEXTO = [
  'nome',
  'email',
  'telefone',
  'empresa',
  'cargo',
  'titulo',
  'valor',
  'valorRecorrente',
  ...CAMPOS_UTM.map((campo) => `utm.${campo}` as const),
] as const;

export type DestinoDeTexto = (typeof DESTINOS_DE_TEXTO)[number];

export const DESTINO_ETIQUETAS = 'etiquetas';
export const PREFIXO_CAMPO_PERSONALIZADO = 'camposPersonalizados.';

/** Todos os destinos fixos, para documentação e mensagens. */
export const DESTINOS_FIXOS: readonly string[] = [
  ...DESTINOS_DE_TEXTO,
  DESTINO_ETIQUETAS,
];

export const REGRAS_MAXIMAS = 100;
export const CONDICOES_MAXIMAS = 10;
export const TAMANHO_MAXIMO_CAMINHO = 200;
export const TAMANHO_MAXIMO_CHAVE_PERSONALIZADA = 100;

/** Limites dos textos lidos (os mesmos do cadastro de contatos e negócios). */
const LIMITE_DE_TEXTO: Readonly<Record<string, number>> = {
  nome: 200,
  empresa: 200,
  cargo: 200,
  titulo: 200,
};
const LIMITE_PADRAO_DE_TEXTO = 200;

// ---------------------------------------------------------------------------
// Modelos prontos (R8.1)
// ---------------------------------------------------------------------------

export type ModeloPronto = Exclude<ModeloMapeamento, 'PERSONALIZADO'>;

export interface DefinicaoDeModelo {
  readonly modelo: ModeloPronto;
  readonly nome: string;
  readonly descricao: string;
  readonly mapeamento: Mapeamento;
  /** Corpo de exemplo, para a tela e para a prévia. */
  readonly exemplo: Readonly<Record<string, unknown>>;
}

/** Genérico (R8.1): `name`, `email`, `phone` e `utm_*`. */
export const MAPEAMENTO_GENERICO: Mapeamento = {
  campos: [
    { caminho: 'name', destino: 'nome' },
    { caminho: 'email', destino: 'email' },
    { caminho: 'phone', destino: 'telefone' },
    ...CAMPOS_UTM.map((campo) => ({
      caminho: `utm_${campo}`,
      destino: `utm.${campo}`,
    })),
  ],
  ignorarQuando: [],
};

/**
 * Disparos BRL (R8.1): o corpo que o sistema de disparos envia ao Clint —
 * `name`, `email`, `phone`, `whatsapp`, `faturamento`, `campanha`, `origem` e
 * as colunas da planilha (`planilha_<coluna>`), que viram campos
 * personalizados. O telefone é o `phone` digitado e, sem ele (ou inválido), o
 * `whatsapp` da conversa, que também fica guardado em `whatsapp`. Os envios
 * de teste do sistema (`teste: true`) são ignorados.
 */
export const MAPEAMENTO_DISPAROS_BRL: Mapeamento = {
  campos: [
    { caminho: 'name', destino: 'nome' },
    { caminho: 'email', destino: 'email' },
    { caminho: 'phone', destino: 'telefone' },
    { caminho: 'whatsapp', destino: 'telefone' },
    { caminho: 'whatsapp', destino: 'camposPersonalizados.whatsapp' },
    { caminho: 'faturamento', destino: 'camposPersonalizados.faturamento' },
    { caminho: 'campanha', destino: 'utm.campaign' },
    { caminho: 'origem', destino: 'utm.source' },
    { caminho: 'planilha_*', destino: 'camposPersonalizados.planilha_*' },
  ],
  ignorarQuando: [{ caminho: 'teste', valor: true }],
};

export const MODELOS_PRONTOS: Readonly<
  Record<ModeloPronto, DefinicaoDeModelo>
> = {
  GENERICO: {
    modelo: 'GENERICO',
    nome: 'Genérico',
    descricao:
      'Campos `name`, `email`, `phone` e `utm_source`, `utm_medium`, `utm_campaign`, `utm_term` e `utm_content`.',
    mapeamento: MAPEAMENTO_GENERICO,
    exemplo: {
      name: 'Maria Souza',
      email: 'maria@empresa.com.br',
      phone: '(11) 98765-4321',
      utm_source: 'google',
      utm_medium: 'cpc',
      utm_campaign: 'black-friday',
    },
  },
  DISPAROS_BRL: {
    modelo: 'DISPAROS_BRL',
    nome: 'Disparos BRL',
    descricao:
      'O formato que o sistema de disparos envia ao Clint: `name`, `email`, `phone`, `whatsapp`, `faturamento`, ' +
      '`campanha`, `origem` e as colunas `planilha_*` (viram campos personalizados). Envios de teste ' +
      '(`teste: true`) são ignorados.',
    mapeamento: MAPEAMENTO_DISPAROS_BRL,
    exemplo: {
      name: 'Lead de Teste',
      email: 'teste@exemplo.com.br',
      phone: '(11) 99999-8888',
      faturamento: 'Acima de R$ 80 mil',
      whatsapp: '5511999998888',
      campanha: 'Black Friday',
      origem: 'Disparos WhatsApp',
      planilha_cidade: 'São Paulo',
    },
  },
};

/** O mapeamento que vale para o ponto de entrada: o do modelo pronto ou o gravado. */
export function mapeamentoEfetivo(
  modelo: ModeloMapeamento,
  gravado: Prisma.JsonValue | null | undefined,
): Mapeamento {
  if (modelo === 'PERSONALIZADO') {
    return lerMapeamentoGravado(gravado);
  }
  return MODELOS_PRONTOS[modelo].mapeamento;
}

/**
 * O mapeamento gravado no banco, defensivamente: regras malformadas são
 * descartadas (a gravação sempre passa por `validarMapeamento`).
 */
export function lerMapeamentoGravado(
  gravado: Prisma.JsonValue | null | undefined,
): Mapeamento {
  if (!ehObjetoSimples(gravado)) {
    return { campos: [], ignorarQuando: [] };
  }
  const campos = Array.isArray(gravado.campos) ? gravado.campos : [];
  const condicoes = Array.isArray(gravado.ignorarQuando)
    ? gravado.ignorarQuando
    : [];
  return {
    campos: campos.flatMap((regra) =>
      ehObjetoSimples(regra) &&
      typeof regra.caminho === 'string' &&
      typeof regra.destino === 'string'
        ? [{ caminho: regra.caminho, destino: regra.destino }]
        : [],
    ),
    ignorarQuando: condicoes.flatMap((condicao) =>
      ehObjetoSimples(condicao) &&
      typeof condicao.caminho === 'string' &&
      ehValorDeCondicao(condicao.valor)
        ? [{ caminho: condicao.caminho, valor: condicao.valor }]
        : [],
    ),
  };
}

// ---------------------------------------------------------------------------
// Validação da configuração
// ---------------------------------------------------------------------------

export type ResultadoDaValidacao =
  | { readonly valido: true; readonly mapeamento: Mapeamento }
  | { readonly valido: false; readonly problemas: ProblemaDeCampo[] };

/**
 * Confere um mapeamento personalizado (R8.1): caminhos bem formados, destinos
 * conhecidos, curinga só no último trecho e com destino compatível, e pelo
 * menos uma regra para o nome e outra para o e-mail ou o telefone (sem elas,
 * nenhum recebimento viraria contato, R8.5). `prefixo` é o nome do campo nas
 * mensagens (`mapeamento.campos.2.destino`).
 */
export function validarMapeamento(
  entrada: unknown,
  prefixo = 'mapeamento',
): ResultadoDaValidacao {
  const problemas: ProblemaDeCampo[] = [];
  const problema = (campo: string, mensagem: string) =>
    problemas.push({ campo: `${prefixo}${campo}`, mensagens: [mensagem] });

  if (!ehObjetoSimples(entrada)) {
    problema('', 'deve ser um objeto com a lista "campos"');
    return { valido: false, problemas };
  }
  const campos = entrada.campos;
  if (!Array.isArray(campos) || campos.length === 0) {
    problema('.campos', 'deve ser uma lista com pelo menos uma regra');
    return { valido: false, problemas };
  }
  if (campos.length > REGRAS_MAXIMAS) {
    problema('.campos', `deve ter no máximo ${REGRAS_MAXIMAS} regras`);
  }

  const regras: RegraDeCampo[] = [];
  campos.slice(0, REGRAS_MAXIMAS).forEach((regra: unknown, indice) => {
    const base = `.campos.${indice}`;
    if (!ehObjetoSimples(regra)) {
      problema(base, 'deve ser um objeto { caminho, destino }');
      return;
    }
    const caminho =
      typeof regra.caminho === 'string' ? regra.caminho.trim() : '';
    const destino =
      typeof regra.destino === 'string' ? regra.destino.trim() : '';
    const erroDoCaminho = problemaDoCaminho(caminho, { aceitaCuringa: true });
    if (erroDoCaminho) {
      problema(`${base}.caminho`, erroDoCaminho);
    }
    const erroDoDestino = problemaDoDestino(destino, temCuringa(caminho));
    if (erroDoDestino) {
      problema(`${base}.destino`, erroDoDestino);
    }
    if (!erroDoCaminho && !erroDoDestino) {
      regras.push({ caminho, destino });
    }
  });

  const condicoes: CondicaoParaIgnorar[] = [];
  const brutas: unknown = entrada.ignorarQuando;
  if (brutas !== undefined && brutas !== null) {
    if (!Array.isArray(brutas)) {
      problema('.ignorarQuando', 'deve ser uma lista');
    } else if (brutas.length > CONDICOES_MAXIMAS) {
      problema(
        '.ignorarQuando',
        `deve ter no máximo ${CONDICOES_MAXIMAS} condições`,
      );
    } else {
      brutas.forEach((condicao: unknown, indice) => {
        const base = `.ignorarQuando.${indice}`;
        if (!ehObjetoSimples(condicao)) {
          problema(base, 'deve ser um objeto { caminho, valor }');
          return;
        }
        const caminho =
          typeof condicao.caminho === 'string' ? condicao.caminho.trim() : '';
        const erroDoCaminho = problemaDoCaminho(caminho, {
          aceitaCuringa: false,
        });
        if (erroDoCaminho) {
          problema(`${base}.caminho`, erroDoCaminho);
        }
        if (!ehValorDeCondicao(condicao.valor)) {
          problema(`${base}.valor`, 'deve ser um texto, número ou booleano');
        }
        if (!erroDoCaminho && ehValorDeCondicao(condicao.valor)) {
          condicoes.push({ caminho, valor: condicao.valor });
        }
      });
    }
  }

  for (const chave of Object.keys(entrada)) {
    if (chave !== 'campos' && chave !== 'ignorarQuando') {
      problema(`.${chave}`, 'não é um campo aceito');
    }
  }

  if (problemas.length === 0) {
    const destinos = new Set(regras.map(({ destino }) => destino));
    if (!destinos.has('nome')) {
      problema(
        '.campos',
        'precisa de uma regra com destino "nome" (o contato exige nome)',
      );
    }
    if (!destinos.has('email') && !destinos.has('telefone')) {
      problema(
        '.campos',
        'precisa de uma regra com destino "email" ou "telefone"',
      );
    }
  }

  return problemas.length > 0
    ? { valido: false, problemas }
    : {
        valido: true,
        mapeamento: { campos: regras, ignorarQuando: condicoes },
      };
}

function temCuringa(caminho: string): boolean {
  return caminho.includes('*');
}

/** Mensagem do problema do caminho, ou `null` se ele estiver bom. */
export function problemaDoCaminho(
  caminho: string,
  opcoes: { aceitaCuringa: boolean },
): string | null {
  if (!caminho) {
    return 'é obrigatório';
  }
  if (caminho.length > TAMANHO_MAXIMO_CAMINHO) {
    return `deve ter no máximo ${TAMANHO_MAXIMO_CAMINHO} caracteres`;
  }
  const segmentos = segmentosDoCaminho(caminho);
  if (segmentos.some((segmento) => segmento === '')) {
    return 'tem um trecho vazio (confira os pontos e colchetes)';
  }
  const curingas = (caminho.match(/\*/g) ?? []).length;
  if (curingas > 0) {
    if (!opcoes.aceitaCuringa) {
      return 'não aceita curinga (*)';
    }
    if (curingas > 1 || !segmentos[segmentos.length - 1].includes('*')) {
      return 'aceita um único curinga (*), no último trecho';
    }
  }
  return null;
}

/** Mensagem do problema do destino, ou `null` se ele estiver bom. */
export function problemaDoDestino(
  destino: string,
  caminhoComCuringa: boolean,
): string | null {
  if (!destino) {
    return 'é obrigatório';
  }
  if (destino.startsWith(PREFIXO_CAMPO_PERSONALIZADO)) {
    const chave = destino.slice(PREFIXO_CAMPO_PERSONALIZADO.length);
    if (!chave.trim()) {
      return 'informe a chave do campo personalizado (camposPersonalizados.<chave>)';
    }
    if (chave.length > TAMANHO_MAXIMO_CHAVE_PERSONALIZADA) {
      return `a chave do campo personalizado deve ter no máximo ${TAMANHO_MAXIMO_CHAVE_PERSONALIZADA} caracteres`;
    }
    const curingas = (chave.match(/\*/g) ?? []).length;
    if (caminhoComCuringa && curingas !== 1) {
      return 'com curinga no caminho, a chave precisa de um "*" (ex.: camposPersonalizados.*)';
    }
    if (!caminhoComCuringa && curingas > 0) {
      return 'só use "*" na chave quando o caminho tiver curinga';
    }
    return null;
  }
  if (destino === DESTINO_ETIQUETAS) {
    return null;
  }
  if ((DESTINOS_DE_TEXTO as readonly string[]).includes(destino)) {
    return caminhoComCuringa
      ? 'com curinga no caminho, o destino deve ser "etiquetas" ou "camposPersonalizados.<…*…>"'
      : null;
  }
  return `destino desconhecido: use ${DESTINOS_FIXOS.join(', ')} ou camposPersonalizados.<chave>`;
}

// ---------------------------------------------------------------------------
// Leitura de caminhos
// ---------------------------------------------------------------------------

/** `lead.contatos[0].email` → `['lead', 'contatos', '0', 'email']`. */
export function segmentosDoCaminho(caminho: string): string[] {
  return caminho
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .map((segmento) => segmento.trim());
}

/**
 * O valor no caminho (ou `undefined`). Uma chave com ponto na raiz
 * (`"utm.source"`) é lida antes de descer pelos trechos.
 */
export function lerCaminho(corpo: unknown, caminho: string): unknown {
  if (ehObjetoSimples(corpo) && Object.hasOwn(corpo, caminho)) {
    return corpo[caminho];
  }
  return lerSegmentos(corpo, segmentosDoCaminho(caminho));
}

function lerSegmentos(corpo: unknown, segmentos: readonly string[]): unknown {
  let atual: unknown = corpo;
  for (const segmento of segmentos) {
    if (Array.isArray(atual)) {
      if (!/^\d+$/.test(segmento)) {
        return undefined;
      }
      atual = atual[Number(segmento)];
    } else if (ehObjetoSimples(atual)) {
      if (!Object.hasOwn(atual, segmento)) {
        return undefined;
      }
      atual = atual[segmento];
    } else {
      return undefined;
    }
  }
  return atual;
}

export interface ChaveCasada {
  /** A chave completa no corpo (`planilha_cidade`). */
  readonly chave: string;
  /** O que o `*` casou (`cidade`). */
  readonly parte: string;
  readonly valor: unknown;
}

/** As chaves que o curinga do último trecho casa (`planilha_*`, `campos.*`), na ordem do corpo. */
export function expandirCuringa(
  corpo: unknown,
  caminho: string,
): ChaveCasada[] {
  const segmentos = segmentosDoCaminho(caminho);
  const ultimo = segmentos.pop() ?? '';
  const pai = segmentos.length > 0 ? lerSegmentos(corpo, segmentos) : corpo;
  if (!ehObjetoSimples(pai)) {
    return [];
  }
  const [antes, depois = ''] = ultimo.split('*');
  return Object.entries(pai)
    .filter(
      ([chave]) =>
        chave.length >= antes.length + depois.length &&
        chave.startsWith(antes) &&
        chave.endsWith(depois),
    )
    .map(([chave, valor]) => ({
      chave,
      parte: chave.slice(antes.length, chave.length - depois.length),
      valor,
    }));
}

// ---------------------------------------------------------------------------
// Aplicação (R8.5: "aplica o mapeamento → valida")
// ---------------------------------------------------------------------------

export interface CampoEncontrado {
  readonly destino: string;
  readonly caminho: string;
}

/** O lead lido do corpo, já normalizado como o CRM grava. */
export interface LeadMapeado {
  /** Motivo para ignorar o recebimento (corpo vazio, envio de teste…), ou `null`. */
  readonly ignorado: string | null;
  /** Problemas que impedem criar o contato (sem nome, sem meio de contato…). */
  readonly problemas: readonly string[];
  /** Valores descartados que não impedem o processamento. */
  readonly avisos: readonly string[];
  readonly contato: {
    readonly nome: string | null;
    readonly email: string | null;
    readonly telefone: string | null;
    readonly empresa: string | null;
    readonly cargo: string | null;
  };
  readonly negocio: {
    readonly titulo: string | null;
    readonly valor: string | null;
    readonly valorRecorrente: string | null;
  };
  readonly utm: Utm | null;
  readonly etiquetas: string[];
  readonly camposPersonalizados: Record<string, unknown>;
  /** Que caminho preencheu cada destino (para a prévia e o diagnóstico). */
  readonly encontrados: readonly CampoEncontrado[];
}

interface Candidato {
  readonly caminho: string;
  readonly texto: string;
}

/**
 * Aplica o mapeamento ao corpo recebido. Nunca lança erro: o que impede o
 * processamento vai para `problemas` e o que foi descartado, para `avisos`.
 */
export function aplicarMapeamento(
  mapeamento: Mapeamento,
  corpo: unknown,
  etiquetasFixas: readonly string[] = [],
): LeadMapeado {
  const vazio = leadVazio(etiquetasFixas);
  if (Array.isArray(corpo)) {
    return {
      ...vazio,
      problemas: [
        'O corpo é uma lista: envie um objeto JSON (ou um formulário) por lead.',
      ],
    };
  }
  if (!ehObjetoSimples(corpo)) {
    return {
      ...vazio,
      problemas: ['O corpo precisa ser um objeto JSON ou um formulário.'],
    };
  }
  if (Object.keys(corpo).length === 0) {
    return { ...vazio, ignorado: 'Corpo vazio: nada a processar.' };
  }
  for (const condicao of mapeamento.ignorarQuando) {
    const recebido = lerCaminho(corpo, condicao.caminho);
    if (valorIgual(recebido, condicao.valor)) {
      return {
        ...vazio,
        ignorado: `Ignorado pela regra do mapeamento: o campo "${condicao.caminho}" veio igual a ${JSON.stringify(condicao.valor)} (ex.: envio de teste). Nada foi criado.`,
      };
    }
  }

  const textos = new Map<DestinoDeTexto, string>();
  const candidatosDeEmail: Candidato[] = [];
  const candidatosDeTelefone: Candidato[] = [];
  const valores = new Map<'valor' | 'valorRecorrente', string>();
  const etiquetas: string[] = [];
  const camposPersonalizados: Record<string, unknown> = {};
  const encontrados: CampoEncontrado[] = [];
  const avisos: string[] = [];
  const caminhosPorDestino = new Map<string, string[]>();
  let algumValorLido = false;

  const registrar = (destino: string, caminho: string) =>
    encontrados.push({ destino, caminho });

  for (const regra of mapeamento.campos) {
    const lista = caminhosPorDestino.get(regra.destino) ?? [];
    lista.push(regra.caminho);
    caminhosPorDestino.set(regra.destino, lista);

    if (temCuringa(regra.caminho)) {
      for (const casada of expandirCuringa(corpo, regra.caminho)) {
        if (ehVazio(casada.valor)) {
          continue;
        }
        algumValorLido = true;
        if (regra.destino === DESTINO_ETIQUETAS) {
          etiquetas.push(...comoEtiquetas(casada.valor));
        } else {
          const chave = regra.destino
            .slice(PREFIXO_CAMPO_PERSONALIZADO.length)
            .replace('*', casada.parte)
            .trim();
          if (chave && !(chave in camposPersonalizados)) {
            camposPersonalizados[chave] = comoValorPersonalizado(casada.valor);
          }
        }
        registrar(regra.destino, casada.chave);
      }
      continue;
    }

    const valor = lerCaminho(corpo, regra.caminho);
    if (ehVazio(valor)) {
      continue;
    }
    algumValorLido = true;
    if (regra.destino === DESTINO_ETIQUETAS) {
      const lidas = comoEtiquetas(valor);
      if (lidas.length > 0) {
        etiquetas.push(...lidas);
        registrar(regra.destino, regra.caminho);
      }
      continue;
    }
    if (regra.destino.startsWith(PREFIXO_CAMPO_PERSONALIZADO)) {
      const chave = regra.destino
        .slice(PREFIXO_CAMPO_PERSONALIZADO.length)
        .trim();
      if (!(chave in camposPersonalizados)) {
        camposPersonalizados[chave] = comoValorPersonalizado(valor);
        registrar(regra.destino, regra.caminho);
      }
      continue;
    }
    const destino = regra.destino as DestinoDeTexto;
    const texto = comoTexto(valor, LIMITE_DE_TEXTO[destino]);
    if (texto === null) {
      continue;
    }
    if (destino === 'email') {
      candidatosDeEmail.push({ caminho: regra.caminho, texto });
      continue;
    }
    if (destino === 'telefone') {
      candidatosDeTelefone.push({ caminho: regra.caminho, texto });
      continue;
    }
    if (destino === 'valor' || destino === 'valorRecorrente') {
      if (valores.has(destino)) {
        continue;
      }
      const lido = lerValorMonetario(typeof valor === 'number' ? valor : texto);
      if (lido === null) {
        avisos.push(
          `${destino === 'valor' ? 'Valor' : 'Valor recorrente'} "${texto}" (${regra.caminho}) ignorado: formato inválido.`,
        );
      } else {
        valores.set(destino, lido);
        registrar(destino, regra.caminho);
      }
      continue;
    }
    if (!textos.has(destino)) {
      textos.set(destino, texto);
      registrar(destino, regra.caminho);
    }
  }

  const email = escolherEmail(candidatosDeEmail);
  const telefone = escolherTelefone(candidatosDeTelefone);
  if (email.escolhido) {
    registrar('email', email.escolhido.caminho);
  }
  if (telefone.escolhido) {
    registrar('telefone', telefone.escolhido.caminho);
  }

  const problemas: string[] = [];
  const nome = textos.get('nome') ?? null;
  if (!algumValorLido) {
    const esperados = [...new Set(mapeamento.campos.map((r) => r.caminho))]
      .slice(0, 8)
      .join(', ');
    problemas.push(
      `Nenhum dos caminhos do mapeamento foi encontrado no corpo (procurados: ${esperados}).`,
    );
  } else {
    if (!nome) {
      problemas.push(
        `Sem nome: ${semValorEm(caminhosPorDestino.get('nome'))}.`,
      );
    }
    if (!email.escolhido && !telefone.escolhido) {
      const invalidos = [...email.invalidos, ...telefone.invalidos];
      problemas.push(
        invalidos.length > 0
          ? `Sem e-mail nem telefone válidos: ${invalidos.join('; ')}.`
          : `Sem e-mail nem telefone: ${semValorEm([
              ...(caminhosPorDestino.get('email') ?? []),
              ...(caminhosPorDestino.get('telefone') ?? []),
            ])}.`,
      );
    } else {
      avisos.push(
        ...email.invalidos.map((motivo) => `${motivo}: ignorado.`),
        ...telefone.invalidos.map((motivo) => `${motivo}: ignorado.`),
      );
    }
  }

  const utm: Utm = {};
  for (const campo of CAMPOS_UTM) {
    const texto = textos.get(`utm.${campo}` as DestinoDeTexto);
    if (texto) {
      utm[campo as CampoUtm] = texto;
    }
  }

  return {
    ignorado: null,
    problemas,
    avisos,
    contato: {
      nome,
      email: email.escolhido?.valor ?? null,
      telefone: telefone.escolhido?.valor ?? null,
      empresa: textos.get('empresa') ?? null,
      cargo: textos.get('cargo') ?? null,
    },
    negocio: {
      titulo: textos.get('titulo') ?? null,
      valor: valores.get('valor') ?? null,
      valorRecorrente: valores.get('valorRecorrente') ?? null,
    },
    utm: Object.keys(utm).length > 0 ? utm : null,
    etiquetas: normalizarEtiquetas([...etiquetasFixas, ...etiquetas]),
    camposPersonalizados,
    encontrados,
  };
}

function leadVazio(etiquetasFixas: readonly string[]): LeadMapeado {
  return {
    ignorado: null,
    problemas: [],
    avisos: [],
    contato: {
      nome: null,
      email: null,
      telefone: null,
      empresa: null,
      cargo: null,
    },
    negocio: { titulo: null, valor: null, valorRecorrente: null },
    utm: null,
    etiquetas: normalizarEtiquetas(etiquetasFixas),
    camposPersonalizados: {},
    encontrados: [],
  };
}

/** "o caminho "name" não trouxe valor", "os caminhos "email", "phone" não trouxeram valor". */
function semValorEm(caminhos: readonly string[] | undefined): string {
  if (!caminhos || caminhos.length === 0) {
    return 'nenhuma regra do mapeamento trouxe valor';
  }
  const lista = caminhos.map((caminho) => `"${caminho}"`).join(', ');
  return caminhos.length === 1
    ? `o caminho ${lista} não trouxe valor`
    : `os caminhos ${lista} não trouxeram valor`;
}

interface Escolha {
  readonly escolhido: {
    readonly caminho: string;
    readonly valor: string;
  } | null;
  /** Descrição dos valores inválidos encontrados (`E-mail "x" (email) inválido`). */
  readonly invalidos: string[];
}

function escolherEmail(candidatos: readonly Candidato[]): Escolha {
  const invalidos: string[] = [];
  for (const candidato of candidatos) {
    if (ehEmailValido(candidato.texto)) {
      return {
        escolhido: {
          caminho: candidato.caminho,
          valor: normalizarEmail(candidato.texto),
        },
        invalidos,
      };
    }
    invalidos.push(
      `E-mail "${candidato.texto}" (${candidato.caminho}) inválido`,
    );
  }
  return { escolhido: null, invalidos };
}

function escolherTelefone(candidatos: readonly Candidato[]): Escolha {
  const invalidos: string[] = [];
  for (const candidato of candidatos) {
    const resultado = normalizarTelefone(candidato.texto);
    if (resultado.valido) {
      return {
        escolhido: { caminho: candidato.caminho, valor: resultado.telefone },
        invalidos,
      };
    }
    invalidos.push(
      `Telefone "${candidato.texto}" (${candidato.caminho}) inválido — ${resultado.motivo.replace(/\.$/, '')}`,
    );
  }
  return { escolhido: null, invalidos };
}

// ---------------------------------------------------------------------------
// Conversão de valores
// ---------------------------------------------------------------------------

/** Vazio: ausente, nulo, texto em branco, lista vazia ou só com vazios. */
function ehVazio(valor: unknown): boolean {
  if (valor === undefined || valor === null) {
    return true;
  }
  if (typeof valor === 'string') {
    return valor.trim() === '';
  }
  if (Array.isArray(valor)) {
    return valor.every(ehVazio);
  }
  return false;
}

/**
 * Texto de uma linha (espaços colapsados, aparado, cortado no limite). Número
 * vira texto; de uma lista vale o primeiro item com texto; objeto e booleano
 * não viram texto.
 */
export function comoTexto(
  valor: unknown,
  limite: number = LIMITE_PADRAO_DE_TEXTO,
): string | null {
  if (Array.isArray(valor)) {
    for (const item of valor) {
      const texto = comoTexto(item, limite);
      if (texto !== null) {
        return texto;
      }
    }
    return null;
  }
  if (typeof valor === 'number') {
    return Number.isFinite(valor) ? String(valor) : null;
  }
  if (typeof valor !== 'string') {
    return null;
  }
  const texto = valor.replace(/\s+/g, ' ').trim().slice(0, limite).trim();
  return texto || null;
}

/** Etiquetas de um valor: lista de textos, ou texto separado por vírgula ou ponto e vírgula. */
function comoEtiquetas(valor: unknown): string[] {
  if (Array.isArray(valor)) {
    return valor.flatMap((item) =>
      typeof item === 'string' || typeof item === 'number'
        ? comoEtiquetas(item)
        : [],
    );
  }
  if (typeof valor === 'number' && Number.isFinite(valor)) {
    return [String(valor)];
  }
  if (typeof valor !== 'string') {
    return [];
  }
  return valor
    .split(/[,;]/)
    .map((parte) => parte.trim())
    .filter(Boolean);
}

/** Campos personalizados guardam o valor JSON como veio (textos aparados). */
function comoValorPersonalizado(valor: unknown): unknown {
  return typeof valor === 'string' ? valor.trim() : valor;
}

/**
 * Valor em reais vindo de fora → texto decimal com duas casas (`"1500.00"`),
 * ou `null` se não der para ler. Aceita número, `"1500"`, `"1500.5"`,
 * `"1.500,00"`, `"1500,5"`, `"1,500.00"` e `"R$ 1.500,00"`. Negativo não vale.
 */
export function lerValorMonetario(valor: unknown): string | null {
  if (typeof valor === 'number') {
    return Number.isFinite(valor) && valor >= 0
      ? formatarDuasCasas(valor.toFixed(2))
      : null;
  }
  if (typeof valor !== 'string') {
    return null;
  }
  const texto = valor.replace(/^\s*R\$\s*/i, '').replace(/[\s ]/g, '');
  let normalizado: string | null = null;
  if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(texto)) {
    // pt-BR com milhar: 1.500,00
    normalizado = texto.replace(/\./g, '').replace(',', '.');
  } else if (/^\d+,\d{1,2}$/.test(texto)) {
    // pt-BR sem milhar: 1500,5
    normalizado = texto.replace(',', '.');
  } else if (/^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(texto)) {
    // en com milhar: 1,500.00
    normalizado = texto.replace(/,/g, '');
  } else if (/^\d+(\.\d{1,2})?$/.test(texto)) {
    normalizado = texto;
  }
  if (normalizado === null) {
    return null;
  }
  return formatarDuasCasas(normalizado);
}

function formatarDuasCasas(texto: string): string | null {
  const [inteiro, decimais = ''] = texto.split('.');
  const semZeros = inteiro.replace(/^0+(?=\d)/, '');
  const resultado = `${semZeros}.${decimais.padEnd(2, '0').slice(0, 2)}`;
  return FORMATO_VALOR.test(resultado) ? resultado : null;
}

/** Comparação tolerante das condições: `true`, `"true"` e `"TRUE"` se equivalem. */
function valorIgual(recebido: unknown, esperado: ValorDeCondicao): boolean {
  if (
    recebido === undefined ||
    recebido === null ||
    typeof recebido === 'object'
  ) {
    return false;
  }
  return (
    String(recebido as string | number | boolean)
      .trim()
      .toLowerCase() === String(esperado).trim().toLowerCase()
  );
}

function ehValorDeCondicao(valor: unknown): valor is ValorDeCondicao {
  return (
    typeof valor === 'string' ||
    typeof valor === 'boolean' ||
    (typeof valor === 'number' && Number.isFinite(valor))
  );
}

/** Objeto literal (`{ … }`), sem listas, datas nem instâncias de classes. */
export function ehObjetoSimples(
  valor: unknown,
): valor is Record<string, unknown> {
  return Object.prototype.toString.call(valor) === '[object Object]';
}
