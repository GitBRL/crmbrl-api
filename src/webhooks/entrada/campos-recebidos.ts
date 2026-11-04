/**
 * "Atualizar campos recebidos" (R32.7): os caminhos de campo encontrados nos
 * corpos dos últimos recebimentos, cada um com um valor de exemplo mascarado
 * (o assistente mostra o que chegou sem expor o dado pessoal). Puro.
 */
import { ehObjetoSimples } from './mapeamento';

export interface CampoRecebido {
  readonly caminho: string;
  readonly tipo: 'texto' | 'numero' | 'booleano' | 'lista' | 'objeto';
  readonly exemplo: string | null;
  readonly ocorrencias: number;
}

const PROFUNDIDADE_MAXIMA = 6;
const CAMINHOS_MAXIMOS = 300;
const ITENS_DE_LISTA_LIDOS = 3;

const NOME_SENSIVEL =
  /senha|password|token|secret|segredo|authorization|api[-_]?key|credencia|cpf|cnpj|document/i;

/** `ma•••@empresa.com.br`, `•••••4321`, `Mar•••`; segredos por nome do campo viram `••••`. */
export function mascararExemplo(
  caminho: string,
  valor: unknown,
): string | null {
  if (valor === null || valor === undefined) {
    return null;
  }
  if (typeof valor === 'boolean') {
    return String(valor);
  }
  if (NOME_SENSIVEL.test(caminho)) {
    return '••••';
  }
  if (typeof valor === 'number') {
    const texto = String(valor);
    return texto.length >= 8 ? `•••${texto.slice(-2)}` : texto;
  }
  if (typeof valor !== 'string') {
    return null;
  }
  const texto = valor.replace(/\s+/g, ' ').trim();
  if (!texto) {
    return null;
  }
  const email = /^([^@\s]{1,})@([^@\s]+)$/.exec(texto);
  if (email) {
    return `${email[1].slice(0, 2)}•••@${email[2]}`;
  }
  const digitos = texto.replace(/\D/g, '');
  if (digitos.length >= 8 && /^[\d\s()+.-]+$/.test(texto)) {
    return `${'•'.repeat(Math.max(3, digitos.length - 4))}${digitos.slice(-4)}`;
  }
  if (texto.length <= 12 && !/\d{6,}/.test(texto)) {
    // Curtos e sem sequência de dígitos (utm_source, nome da campanha, status): mantém só o começo.
    return texto.length <= 3 ? texto : `${texto.slice(0, 3)}•••`;
  }
  return `${texto.slice(0, 3)}•••`;
}

function tipoDe(valor: unknown): CampoRecebido['tipo'] | null {
  if (typeof valor === 'string') {
    return 'texto';
  }
  if (typeof valor === 'number') {
    return 'numero';
  }
  if (typeof valor === 'boolean') {
    return 'booleano';
  }
  if (Array.isArray(valor)) {
    return 'lista';
  }
  if (ehObjetoSimples(valor)) {
    return 'objeto';
  }
  return null;
}

/** Os caminhos de folha de um item (listas até 3 posições, `a[0].b`), com o valor encontrado. */
export function caminhosDoItem(
  item: unknown,
): { caminho: string; valor: unknown }[] {
  const encontrados: { caminho: string; valor: unknown }[] = [];
  const percorrer = (valor: unknown, caminho: string, profundidade: number) => {
    if (encontrados.length >= CAMINHOS_MAXIMOS) {
      return;
    }
    if (Array.isArray(valor)) {
      if (valor.every((v) => typeof v !== 'object' || v === null)) {
        // Lista de valores simples (tags): um campo só.
        encontrados.push({ caminho, valor });
        return;
      }
      valor.slice(0, ITENS_DE_LISTA_LIDOS).forEach((elemento, indice) => {
        percorrer(elemento, `${caminho}[${indice}]`, profundidade + 1);
      });
      return;
    }
    if (ehObjetoSimples(valor)) {
      if (profundidade >= PROFUNDIDADE_MAXIMA) {
        return;
      }
      for (const [chave, interno] of Object.entries(valor)) {
        // Chaves com ponto só valem na raiz (o mapeamento as lê inteiras).
        if (profundidade > 0 && chave.includes('.')) {
          continue;
        }
        percorrer(
          interno,
          caminho ? `${caminho}.${chave}` : chave,
          profundidade + 1,
        );
      }
      return;
    }
    if (caminho) {
      encontrados.push({ caminho, valor });
    }
  };
  percorrer(item, '', 0);
  return encontrados;
}

/** Junta os caminhos de vários itens: ordem de aparição, contagem e o primeiro exemplo não vazio. */
export function consolidarCampos(itens: readonly unknown[]): CampoRecebido[] {
  const mapa = new Map<
    string,
    { tipo: CampoRecebido['tipo']; exemplo: string | null; ocorrencias: number }
  >();
  for (const item of itens) {
    const vistos = new Set<string>();
    for (const { caminho, valor } of caminhosDoItem(item)) {
      const tipo = tipoDe(valor);
      if (!tipo || vistos.has(caminho)) {
        continue;
      }
      vistos.add(caminho);
      const atual = mapa.get(caminho);
      const exemplo =
        tipo === 'lista'
          ? mascararExemplo(
              caminho,
              (valor as unknown[]).find(
                (v) => typeof v === 'string' || typeof v === 'number',
              ),
            )
          : mascararExemplo(caminho, valor);
      if (atual) {
        atual.ocorrencias += 1;
        atual.exemplo ??= exemplo;
      } else {
        mapa.set(caminho, { tipo, exemplo, ocorrencias: 1 });
      }
    }
  }
  return [...mapa.entries()].map(([caminho, dados]) => ({ caminho, ...dados }));
}
