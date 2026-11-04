/** Utilidades dos adaptadores: leitura defensiva do corpo, modelos de mapeamento e textos comuns. */
import { CAMPOS_UTM } from '../../comum/dominio/utm';
import {
  ehObjetoSimples,
  type Mapeamento,
  type RegraDeCampo,
} from '../entrada/mapeamento';
import { cabecalho, iguaisEmTempoConstante } from './seguranca';
import type {
  EntradaDeAutenticidade,
  ItemRecebido,
  ResultadoDeAutenticidade,
} from './tipos';

export function ehObjeto(valor: unknown): valor is Record<string, unknown> {
  return ehObjetoSimples(valor);
}

/** Um item só, com o corpo como veio. */
export function itemUnico(corpo: unknown): ItemRecebido[] {
  return [{ corpo, rotulo: null }];
}

/** `nome` com variações comuns de ferramentas brasileiras, na ordem de preferência. */
export function regras(
  destino: string,
  ...caminhos: readonly string[]
): RegraDeCampo[] {
  return caminhos.map((caminho) => ({ caminho, destino }));
}

export function utmsDeCaminhos(
  prefixo: string,
  nome: (campo: string) => string = (campo) => `utm_${campo}`,
): RegraDeCampo[] {
  return CAMPOS_UTM.map((campo) => ({
    caminho: `${prefixo}${nome(campo)}`,
    destino: `utm.${campo}`,
  }));
}

export function mapeamentoDe(
  campos: readonly RegraDeCampo[],
  ignorarQuando: Mapeamento['ignorarQuando'] = [],
): Mapeamento {
  return { campos, ignorarQuando };
}

/** Sem autenticidade: o endereço secreto (token) é a única proteção. */
export function semAutenticidade(): ResultadoDeAutenticidade {
  return { ok: true };
}

/** Valor do cabeçalho conferido com o segredo, em tempo constante. */
export function conferirChaveNoCabecalho(
  entrada: EntradaDeAutenticidade,
  nomeDoCabecalho: string,
  rotulo: string,
): ResultadoDeAutenticidade {
  if (!entrada.segredo) {
    return { ok: true };
  }
  const recebida = cabecalho(entrada.cabecalhos, nomeDoCabecalho);
  if (!recebida) {
    return {
      ok: false,
      mensagem: `Chave ausente: ${rotulo} exige o cabeçalho ${nomeDoCabecalho}.`,
    };
  }
  return iguaisEmTempoConstante(recebida.trim(), entrada.segredo)
    ? { ok: true }
    : {
        ok: false,
        mensagem: `Chave inválida: o cabeçalho ${nomeDoCabecalho} não confere com a chave da integração.`,
      };
}

/** Lista de textos de um valor que pode ser texto, lista de textos ou lista de `{ name }`. */
export function nomesDeLista(valor: unknown): string[] {
  const itens = Array.isArray(valor)
    ? valor
    : valor === undefined
      ? []
      : [valor];
  return itens.flatMap((item) => {
    if (typeof item === 'string') {
      return item.trim() ? [item.trim()] : [];
    }
    if (ehObjeto(item) && typeof item.name === 'string' && item.name.trim()) {
      return [item.name.trim()];
    }
    return [];
  });
}

/** Junta `{ a, b }` num caminho de ajuda: `contact.fields.3`. */
export function textoOuNulo(valor: unknown): string | null {
  if (typeof valor === 'string') {
    return valor.trim() || null;
  }
  if (typeof valor === 'number' && Number.isFinite(valor)) {
    return String(valor);
  }
  return null;
}

/** Aviso padrão do passo a passo de campos escolhidos pelo Admin. */
export const DICA_ATUALIZACAO =
  'Para atualizar um negócio pelo recebimento, mapeie os campos para os destinos "etapa" (nome ou posição da etapa), "dono" (e-mail ou identificador do usuário) e "status" (aberto, ganho ou perdido).';
