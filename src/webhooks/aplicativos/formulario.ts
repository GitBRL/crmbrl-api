/**
 * Leitura de `application/x-www-form-urlencoded` com chaves aninhadas (R32.1):
 * `fields[email][value]`, `form[name]`, `contact[fields][3]`, `tags[]`.
 *
 * Diferente do `qs` do Express, índices numéricos **não** viram posições de
 * lista: `contact[fields][3]` é o campo de id 3 do ActiveCampaign, e o `qs`
 * perderia o 3 ao compactar a lista. Só viram lista as chaves repetidas
 * (`a=1&a=2`), os `a[]` e os objetos cujas chaves são exatamente 0..n-1.
 */

const CHAVES_PROIBIDAS = new Set(['__proto__', 'constructor', 'prototype']);

/** Parâmetros lidos no máximo (o Express limita em 1000). */
const PARAMETROS_MAXIMOS = 1_000;

/** Profundidade máxima das chaves (`a[b][c][d][e]`). */
const PROFUNDIDADE_MAXIMA = 8;

type Objeto = Record<string, unknown>;

/** `fields[email][value]` → `['fields', 'email', 'value']`; `tags[]` → `['tags', '']`; sem colchetes → a chave inteira. */
export function partesDaChave(chave: string): string[] {
  const correspondencia = /^([^[\]]+)((?:\[[^[\]]*\])+)$/.exec(chave);
  if (!correspondencia) {
    return [chave];
  }
  const colchetes = correspondencia[2].slice(1, -1).split('][');
  return [correspondencia[1], ...colchetes];
}

export function lerFormularioAninhado(texto: string): Objeto {
  const raiz: Objeto = {};
  let lidos = 0;
  for (const [chave, valor] of new URLSearchParams(texto)) {
    lidos += 1;
    if (lidos > PARAMETROS_MAXIMOS) {
      break;
    }
    inserir(raiz, partesDaChave(chave), valor);
  }
  return listasDeIndices(raiz) as Objeto;
}

function ehObjeto(valor: unknown): valor is Objeto {
  return Object.prototype.toString.call(valor) === '[object Object]';
}

function inserir(raiz: Objeto, partes: readonly string[], valor: string): void {
  if (
    partes.length > PROFUNDIDADE_MAXIMA ||
    partes.some((parte) => CHAVES_PROIBIDAS.has(parte))
  ) {
    return;
  }
  let alvo: Objeto = raiz;
  for (let i = 0; i < partes.length; i += 1) {
    const parte = partes[i];
    const ehUltima = i === partes.length - 1;
    if (parte === '') {
      // `[]` solto no começo ou duas vezes seguidas: sem posição, ignora.
      return;
    }
    const proximaVazia = partes[i + 1] === '';
    if (proximaVazia) {
      const lista = Array.isArray(alvo[parte])
        ? (alvo[parte] as unknown[])
        : [];
      alvo[parte] = lista;
      if (i + 1 === partes.length - 1) {
        lista.push(valor);
        return;
      }
      const novo: Objeto = {};
      lista.push(novo);
      alvo = novo;
      i += 1;
      continue;
    }
    if (ehUltima) {
      const atual = alvo[parte];
      if (atual === undefined) {
        alvo[parte] = valor;
      } else if (Array.isArray(atual)) {
        atual.push(valor);
      } else if (typeof atual === 'string') {
        alvo[parte] = [atual, valor];
      } else {
        alvo[parte] = valor;
      }
      return;
    }
    if (!ehObjeto(alvo[parte])) {
      alvo[parte] = {};
    }
    alvo = alvo[parte] as Objeto;
  }
}

/** Objetos com as chaves exatamente `0..n-1` viram lista (`a[0]=x&a[1]=y`). */
function listasDeIndices(valor: unknown): unknown {
  if (Array.isArray(valor)) {
    return valor.map(listasDeIndices);
  }
  if (!ehObjeto(valor)) {
    return valor;
  }
  const chaves = Object.keys(valor);
  const convertido: Objeto = {};
  for (const chave of chaves) {
    convertido[chave] = listasDeIndices(valor[chave]);
  }
  if (
    chaves.length > 0 &&
    chaves.every((chave, indice) => chave === String(indice))
  ) {
    return chaves.map((chave) => convertido[chave]);
  }
  return convertido;
}
