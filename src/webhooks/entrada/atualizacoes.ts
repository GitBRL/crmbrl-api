/**
 * Leitura dos valores das atualizações pelo recebimento (R32.4): etapa por nome
 * ou posição, status em português ou inglês e a busca do dono. Funções puras.
 */
import type { StatusNegocio, TipoEtapa } from '../../generated/prisma/client';

/** Sem acentos, em minúsculas e com espaços colapsados: `"  Proposta  Enviada "` e `"proposta enviada"` se igualam. */
export function normalizarNome(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

const STATUS: Readonly<Record<string, StatusNegocio>> = {
  aberto: 'ABERTO',
  aberta: 'ABERTO',
  open: 'ABERTO',
  ganho: 'GANHO',
  ganha: 'GANHO',
  won: 'GANHO',
  perdido: 'PERDIDO',
  perdida: 'PERDIDO',
  lost: 'PERDIDO',
};

/** `aberto`, `ganho`, `perdido` (e `open`, `won`, `lost`), sem diferenciar maiúsculas; `null` se não reconhecer. */
export function lerStatus(texto: string): StatusNegocio | null {
  const chave = normalizarNome(texto);
  return Object.hasOwn(STATUS, chave) ? STATUS[chave] : null;
}

export interface EtapaParaBusca {
  readonly id: string;
  readonly nome: string;
  readonly tipo: TipoEtapa;
}

/**
 * A etapa pelo nome (sem diferenciar maiúsculas e acentos) ou pela posição de 1
 * a n (na ordem do funil). O nome vale antes da posição: uma etapa chamada
 * "2" é achada pelo nome.
 */
export function acharEtapa<E extends EtapaParaBusca>(
  etapasEmOrdem: readonly E[],
  texto: string,
): E | null {
  const procurado = normalizarNome(texto);
  if (!procurado) {
    return null;
  }
  const porNome = etapasEmOrdem.find(
    (etapa) => normalizarNome(etapa.nome) === procurado,
  );
  if (porNome) {
    return porNome;
  }
  if (/^\d{1,3}$/.test(procurado)) {
    const posicao = Number(procurado);
    return posicao >= 1 ? (etapasEmOrdem[posicao - 1] ?? null) : null;
  }
  return null;
}

/** O status que a etapa define (R5.3). */
export function statusDoTipo(tipo: TipoEtapa): StatusNegocio {
  return tipo === 'GANHO' ? 'GANHO' : tipo === 'PERDIDO' ? 'PERDIDO' : 'ABERTO';
}

export const ROTULO_DO_STATUS: Readonly<Record<StatusNegocio, string>> = {
  ABERTO: 'aberto',
  GANHO: 'ganho',
  PERDIDO: 'perdido',
};

/** A etapa cujo nome (sem diferenciar maiúsculas e acentos) é o de uma variável do Typeform com valor "ligado". */
export function etapaPelaVariavel<E extends { nome: string }>(
  etapas: readonly E[],
  variaveis: Record<string, unknown>,
): E | null {
  for (const [nome, valor] of Object.entries(variaveis)) {
    const ligada =
      valor !== null &&
      valor !== undefined &&
      valor !== '' &&
      valor !== 0 &&
      valor !== '0' &&
      valor !== false;
    if (!ligada) {
      continue;
    }
    const alvo = normalizarNome(nome);
    const etapa = etapas.find((e) => normalizarNome(e.nome) === alvo);
    if (etapa) {
      return etapa;
    }
  }
  return null;
}
