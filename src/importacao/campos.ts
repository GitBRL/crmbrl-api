/**
 * Campos que uma coluna da planilha pode preencher (R16) e a sugestão
 * automática de mapeamento a partir do nome da coluna. Funções puras.
 */
import type { TipoImportacao } from '../generated/prisma/client';
import { CAMPOS_DE_PARCELA } from '../financeiro/campos-de-parcela';

export interface CampoDeImportacao {
  /** Chave gravada no mapeamento (`email`, `campos.cidade`…). */
  readonly chave: string;
  readonly rotulo: string;
  /** Preencher este campo não é opcional para a importação rodar. */
  readonly obrigatorio?: boolean;
  /** Nomes de coluna (já sem acento, minúsculos) que sugerem este campo. */
  readonly sinonimos: readonly string[];
}

export const CAMPOS_DE_CONTATO: readonly CampoDeImportacao[] = [
  {
    chave: 'nome',
    rotulo: 'Nome',
    obrigatorio: true,
    sinonimos: ['nome', 'name', 'nome completo', 'contato', 'cliente', 'lead'],
  },
  {
    chave: 'email',
    rotulo: 'E-mail',
    sinonimos: ['email', 'e mail', 'correio eletronico', 'mail'],
  },
  {
    chave: 'telefone',
    rotulo: 'Telefone',
    sinonimos: [
      'telefone',
      'celular',
      'whatsapp',
      'fone',
      'tel',
      'phone',
      'mobile',
      'telefone celular',
    ],
  },
  {
    chave: 'cargo',
    rotulo: 'Cargo',
    sinonimos: ['cargo', 'funcao', 'job title', 'title'],
  },
  {
    chave: 'empresa',
    rotulo: 'Empresa',
    sinonimos: ['empresa', 'company', 'organizacao', 'razao social'],
  },
  {
    chave: 'etiquetas',
    rotulo: 'Etiquetas',
    sinonimos: ['etiquetas', 'etiqueta', 'tags', 'tag'],
  },
  {
    chave: 'utm.source',
    rotulo: 'UTM source',
    sinonimos: ['utm source', 'utm_source'],
  },
  { chave: 'utm.medium', rotulo: 'UTM medium', sinonimos: ['utm medium'] },
  {
    chave: 'utm.campaign',
    rotulo: 'UTM campaign',
    sinonimos: ['utm campaign'],
  },
  { chave: 'utm.term', rotulo: 'UTM term', sinonimos: ['utm term'] },
  { chave: 'utm.content', rotulo: 'UTM content', sinonimos: ['utm content'] },
];

export const CAMPOS_DE_EMPRESA: readonly CampoDeImportacao[] = [
  {
    chave: 'nome',
    rotulo: 'Nome',
    obrigatorio: true,
    sinonimos: [
      'nome',
      'empresa',
      'razao social',
      'nome fantasia',
      'company',
      'name',
    ],
  },
  { chave: 'cnpj', rotulo: 'CNPJ', sinonimos: ['cnpj'] },
  {
    chave: 'site',
    rotulo: 'Site',
    sinonimos: ['site', 'website', 'url', 'pagina'],
  },
  { chave: 'email', rotulo: 'E-mail', sinonimos: ['email', 'e mail', 'mail'] },
  {
    chave: 'telefone',
    rotulo: 'Telefone',
    sinonimos: ['telefone', 'fone', 'tel', 'phone', 'celular'],
  },
  {
    chave: 'segmento',
    rotulo: 'Segmento',
    sinonimos: ['segmento', 'setor', 'ramo', 'industria'],
  },
  {
    chave: 'cidade',
    rotulo: 'Cidade',
    sinonimos: ['cidade', 'municipio', 'city'],
  },
  { chave: 'uf', rotulo: 'UF', sinonimos: ['uf', 'estado'] },
  {
    chave: 'etiquetas',
    rotulo: 'Etiquetas',
    sinonimos: ['etiquetas', 'etiqueta', 'tags', 'tag'],
  },
];

export function camposDoTipo(
  tipo: TipoImportacao,
): readonly CampoDeImportacao[] {
  if (tipo === 'PARCELAS') {
    return CAMPOS_DE_PARCELA;
  }
  return tipo === 'CONTATOS' ? CAMPOS_DE_CONTATO : CAMPOS_DE_EMPRESA;
}

/** Prefixo dos campos personalizados no mapeamento (`campos.cidade`). */
export const PREFIXO_CAMPO_PERSONALIZADO = 'campos.';

const CHAVE_PERSONALIZADA = /^[a-z][a-z0-9_]{0,39}$/;

/** `campos.<chave>` com chave válida (minúsculas, números e `_`). */
export function ehCampoPersonalizado(campo: string): boolean {
  return (
    campo.startsWith(PREFIXO_CAMPO_PERSONALIZADO) &&
    CHAVE_PERSONALIZADA.test(campo.slice(PREFIXO_CAMPO_PERSONALIZADO.length))
  );
}

/** O campo existe para o tipo (fixo ou personalizado)? */
export function campoValido(tipo: TipoImportacao, campo: string): boolean {
  return (
    camposDoTipo(tipo).some((c) => c.chave === campo) ||
    ehCampoPersonalizado(campo)
  );
}

/** Nome de coluna comparável: sem acento, minúsculo, pontuação vira espaço. */
export function normalizarColuna(coluna: string): string {
  return coluna
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Chave de campo personalizado a partir do nome da coluna (`Data de nascimento` → `data_de_nascimento`). */
export function chaveDeCampoPersonalizado(coluna: string): string {
  const base = normalizarColuna(coluna).replace(/ /g, '_').slice(0, 40);
  return /^[a-z]/.test(base) ? base : `c_${base}`.slice(0, 40);
}

export type Mapeamento = Record<string, string>;

/**
 * Sugere o mapeamento pelos nomes das colunas. Cada campo fixo é usado uma vez
 * (a primeira coluna que combina); colunas sem correspondência ficam de fora.
 */
export function sugerirMapeamento(
  tipo: TipoImportacao,
  colunas: readonly string[],
): Mapeamento {
  const campos = camposDoTipo(tipo);
  const mapeamento: Mapeamento = {};
  const usados = new Set<string>();
  for (const coluna of colunas) {
    const nome = normalizarColuna(coluna);
    const campo = campos.find(
      (c) => !usados.has(c.chave) && c.sinonimos.includes(nome),
    );
    if (campo) {
      usados.add(campo.chave);
      mapeamento[coluna] = campo.chave;
    }
  }
  return mapeamento;
}

/**
 * Aplica um mapeamento salvo (modelo) às colunas do arquivo, comparando os
 * nomes sem acento nem caixa. Colunas que o modelo não conhece ficam de fora.
 */
export function aplicarModeloDeMapeamento(
  modelo: Readonly<Record<string, unknown>>,
  colunas: readonly string[],
): Mapeamento {
  const porNome = new Map<string, string>();
  for (const [coluna, campo] of Object.entries(modelo)) {
    if (typeof campo === 'string') {
      porNome.set(normalizarColuna(coluna), campo);
    }
  }
  const mapeamento: Mapeamento = {};
  const usados = new Set<string>();
  for (const coluna of colunas) {
    const campo = porNome.get(normalizarColuna(coluna));
    if (campo && !usados.has(campo)) {
      usados.add(campo);
      mapeamento[coluna] = campo;
    }
  }
  return mapeamento;
}

export interface ProblemaDeMapeamento {
  campo: string;
  mensagem: string;
}

/**
 * Confere o mapeamento contra as colunas e o tipo: coluna existe, campo
 * existe, nenhum campo em duas colunas. Com `completo`, exige também o mínimo
 * para importar (nome; contatos também precisam de e-mail ou telefone).
 */
export function validarMapeamento(
  tipo: TipoImportacao,
  colunas: readonly string[],
  mapeamento: Readonly<Record<string, unknown>>,
  completo: boolean,
): ProblemaDeMapeamento[] {
  const problemas: ProblemaDeMapeamento[] = [];
  const usados = new Map<string, string>();
  for (const [coluna, campo] of Object.entries(mapeamento)) {
    if (!colunas.includes(coluna)) {
      problemas.push({
        campo: coluna,
        mensagem: 'coluna não existe no arquivo',
      });
      continue;
    }
    if (typeof campo !== 'string' || !campoValido(tipo, campo)) {
      problemas.push({ campo: coluna, mensagem: 'campo de destino inválido' });
      continue;
    }
    const outra = usados.get(campo);
    if (outra) {
      problemas.push({
        campo: coluna,
        mensagem: `o campo "${campo}" já está ligado à coluna "${outra}"`,
      });
      continue;
    }
    usados.set(campo, coluna);
  }
  if (completo && tipo === 'PARCELAS') {
    if (!usados.has('numero')) {
      problemas.push({
        campo: 'mapeamento',
        mensagem: 'ligue uma coluna ao campo Número do título',
      });
    }
  } else if (completo) {
    if (!usados.has('nome')) {
      problemas.push({
        campo: 'mapeamento',
        mensagem: 'ligue uma coluna ao campo Nome',
      });
    }
    if (
      tipo === 'CONTATOS' &&
      !usados.has('email') &&
      !usados.has('telefone')
    ) {
      problemas.push({
        campo: 'mapeamento',
        mensagem: 'ligue uma coluna ao campo E-mail ou ao Telefone',
      });
    }
  }
  return problemas;
}
