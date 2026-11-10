/**
 * Setores (áreas) do CRM (R1.7–R1.11). A tabela `setores` é a fonte; aqui ficam
 * o tipo da chave, as chaves dos três setores de base (comportamentos presos a
 * eles — Financeiro, SDR, painéis do BI, passagens, sementes — continuam
 * presos à chave), a geração da chave a partir do nome e um registro em memória
 * dos nomes, para rótulos em mensagens e resumos de auditoria.
 */

/** Chave de um setor (`setores.chave`), gravada em todas as colunas `area`. */
export type Area = string;

export const SETOR_MARKETING = 'MARKETING';
export const SETOR_COMERCIAL = 'COMERCIAL';
export const SETOR_CS = 'CS';

/** Os três setores de base, na ordem em que a migration os cria. */
export const SETORES_BASE = [
  SETOR_MARKETING,
  SETOR_COMERCIAL,
  SETOR_CS,
] as const;

export type SetorBase = (typeof SETORES_BASE)[number];

/** Nomes iniciais dos setores de base (podem ser renomeados; a chave não muda). */
export const NOMES_INICIAIS_DOS_SETORES_BASE: Readonly<
  Record<SetorBase, string>
> = {
  MARKETING: 'Marketing',
  COMERCIAL: 'Comercial',
  CS: 'Customer Success',
};

export function ehSetorBase(area: Area | null | undefined): area is SetorBase {
  return (SETORES_BASE as readonly string[]).includes(area ?? '');
}

/** Tamanho máximo da chave (CHECK `setores_chave_check`). */
export const TAMANHO_MAXIMO_DA_CHAVE = 40;

/** Tamanho máximo do nome (CHECK `setores_nome_check`). */
export const TAMANHO_MAXIMO_DO_NOME = 60;

/**
 * Cores aceitas em `setores.cor`: os tons preenchidos do selo do design system
 * (`app-selo`), que o front usa como cor de categoria do setor.
 */
export const CORES_DE_SETOR = [
  'ciano',
  'menta',
  'lima',
  'coral',
  'neutro',
] as const;

export type CorDeSetor = (typeof CORES_DE_SETOR)[number];

/** Sem acento, em minúsculas, espaços colapsados: base da unicidade do nome (R1.8). */
export function nomeNormalizado(nome: string): string {
  return nome
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Valores que os filtros usam com outro sentido (`GLOBAL` nas respostas
 * rápidas, `SEM_AREA` no histórico do assistente): nunca viram chave de setor.
 */
const CHAVES_RESERVADAS: ReadonlySet<string> = new Set([
  'GLOBAL',
  'SEM_AREA',
  'TODAS',
  'TODOS',
]);

/**
 * Chave de um setor novo, gerada do nome (R1.8): maiúsculas, sem acento, `_` no
 * lugar de espaços e símbolos, até 40 caracteres; se já existir (ou for um valor
 * reservado dos filtros), ganha `_2`, `_3`… Ex.: "Pós-venda" → `POS_VENDA`.
 */
export function gerarChaveDoSetor(
  nome: string,
  existentes: ReadonlySet<string>,
): string {
  const ocupada = (chave: string) =>
    existentes.has(chave) || CHAVES_RESERVADAS.has(chave);
  const raiz =
    nome
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, TAMANHO_MAXIMO_DA_CHAVE)
      .replace(/_+$/, '') || 'SETOR';
  if (!ocupada(raiz)) {
    return raiz;
  }
  for (let n = 2; ; n++) {
    const sufixo = `_${n}`;
    const candidata =
      raiz
        .slice(0, TAMANHO_MAXIMO_DA_CHAVE - sufixo.length)
        .replace(/_+$/, '') + sufixo;
    if (!ocupada(candidata)) {
      return candidata;
    }
  }
}

// ---------------------------------------------------------------------------
// Nomes em memória (rótulos de mensagens e resumos de auditoria)
// ---------------------------------------------------------------------------

const nomesDosSetores = new Map<string, string>(
  Object.entries(NOMES_INICIAIS_DOS_SETORES_BASE),
);

/**
 * Atualiza os nomes conhecidos. Chamado pelo `SetoresService` (na subida, a cada
 * mudança e periodicamente) e pela configuração inicial.
 */
export function registrarNomesDosSetores(
  setores: readonly { readonly chave: string; readonly nome: string }[],
): void {
  for (const { chave, nome } of setores) {
    nomesDosSetores.set(chave, nome);
  }
}

/** Nome do setor (o último conhecido); a própria chave, se ainda não for conhecido. */
export function nomeDoSetor(area: Area): string {
  return nomesDosSetores.get(area) ?? area;
}
