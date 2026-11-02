/**
 * Leitura do que a auditoria gravou (R3.1): o diff `dados.alteracoes` e as
 * referências `relacionados` (`entidade:id`), no formato que a consulta
 * devolve.
 */
import { VALOR_OMITIDO, type ValorJson } from '../../comum/dados/sanitizar';

/** Um campo alterado: valor antes e depois (campos sensíveis vêm `[omitido]`). */
export interface AlteracaoDeCampo {
  campo: string;
  antes: ValorJson;
  depois: ValorJson;
}

/** Uma entidade ligada ao evento (base da linha do tempo, R3.5). */
export interface ReferenciaRelacionada {
  entidade: string;
  id: string;
}

function ehObjeto(valor: unknown): valor is Record<string, unknown> {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor);
}

function comoJson(valor: unknown): ValorJson {
  return valor === undefined ? null : (valor as ValorJson);
}

/**
 * O diff de um evento, a partir de `dados.alteracoes`:
 *
 * - o formato da base (`calcularAlteracoes`): `{ campo: { antes, depois } }`;
 *   num campo sensível a auditoria grava só `{ senha: '[omitido]' }` (o
 *   sanitizador tira o objeto inteiro), que vira antes e depois `[omitido]`;
 * - ou uma lista `[{ campo, antes, depois }]`.
 *
 * Qualquer outra coisa (ou nada) devolve lista vazia. No formato de objeto os
 * campos saem em ordem alfabética (o `jsonb` não guarda a ordem das chaves); a
 * lista sai na ordem gravada.
 */
export function extrairAlteracoes(dados: unknown): AlteracaoDeCampo[] {
  const alteracoes = ehObjeto(dados) ? dados.alteracoes : undefined;
  if (Array.isArray(alteracoes)) {
    return alteracoes.flatMap((item): AlteracaoDeCampo[] =>
      ehObjeto(item) && typeof item.campo === 'string' && item.campo !== ''
        ? [
            {
              campo: item.campo,
              antes: comoJson(item.antes),
              depois: comoJson(item.depois),
            },
          ]
        : [],
    );
  }
  if (!ehObjeto(alteracoes)) {
    return [];
  }
  return Object.entries(alteracoes)
    .sort(([campoA], [campoB]) => campoA.localeCompare(campoB, 'pt-BR'))
    .flatMap(([campo, valor]): AlteracaoDeCampo[] => {
      if (valor === VALOR_OMITIDO) {
        return [{ campo, antes: VALOR_OMITIDO, depois: VALOR_OMITIDO }];
      }
      return ehObjeto(valor) && ('antes' in valor || 'depois' in valor)
        ? [
            {
              campo,
              antes: comoJson(valor.antes),
              depois: comoJson(valor.depois),
            },
          ]
        : [];
    });
}

/** `['contato:<id>', …]` → `[{ entidade: 'contato', id }]` (entradas sem `:` são ignoradas). */
export function lerRelacionados(
  relacionados: readonly string[],
): ReferenciaRelacionada[] {
  return relacionados.flatMap((referencia): ReferenciaRelacionada[] => {
    const separador = referencia.indexOf(':');
    if (separador <= 0 || separador === referencia.length - 1) {
      return [];
    }
    return [
      {
        entidade: referencia.slice(0, separador),
        id: referencia.slice(separador + 1),
      },
    ];
  });
}
