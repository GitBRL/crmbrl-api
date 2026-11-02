/**
 * Cabeçalhos extras de um destino (R9.1), ex.: `Authorization: Bearer …`.
 * Ficam cifrados no banco (podem levar credenciais, R10.3) e só aparecem
 * mascarados. Funções puras.
 */
import type { ProblemaDeCampo } from '../../comum/validacao/validacao';
import { ehObjetoSimples } from '../entrada/mapeamento';
import {
  CABECALHOS_EXTRAS_MAXIMOS,
  TAMANHO_MAXIMO_NOME_CABECALHO,
  TAMANHO_MAXIMO_VALOR_CABECALHO,
} from '../webhooks.constantes';

/** Nome de cabeçalho HTTP (token da RFC 9110). */
const NOME_DE_CABECALHO = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/**
 * Cabeçalhos que o destino não define: os do protocolo e os que o CRM manda
 * em toda entrega (`Content-Type`, `User-Agent` e os `X-CRM-*`).
 */
const RESERVADOS = new Set([
  'host',
  'content-length',
  'content-type',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'upgrade',
  'te',
  'trailer',
  'expect',
  'user-agent',
  'proxy-authorization',
  'proxy-connection',
]);

export type CabecalhosExtras = Record<string, string>;

export type ResultadoDosCabecalhos =
  | {
      readonly validos: true;
      readonly cabecalhos: CabecalhosExtras;
      /** Nomes enviados com `null` (só com `permitirNulos`). */
      readonly removidos: readonly string[];
    }
  | { readonly validos: false; readonly problemas: ProblemaDeCampo[] };

/**
 * Valida e normaliza os cabeçalhos extras. Com `permitirNulos`, um valor
 * `null` significa "remover este cabeçalho" (atualização parcial).
 */
export function validarCabecalhos(
  entrada: unknown,
  opcoes: { permitirNulos?: boolean } = {},
): ResultadoDosCabecalhos {
  const problemas: ProblemaDeCampo[] = [];
  if (!ehObjetoSimples(entrada)) {
    return {
      validos: false,
      problemas: [
        {
          campo: 'cabecalhos',
          mensagens: ['deve ser um objeto { "Nome": "valor" }'],
        },
      ],
    };
  }
  const cabecalhos: CabecalhosExtras = {};
  const removidos: string[] = [];
  const vistos = new Set<string>();
  for (const [nomeBruto, valor] of Object.entries(entrada)) {
    const nome = nomeBruto.trim();
    const campo = `cabecalhos.${nome || nomeBruto}`;
    const minusculo = nome.toLowerCase();
    if (!nome || !NOME_DE_CABECALHO.test(nome)) {
      problemas.push({
        campo,
        mensagens: ['nome de cabeçalho inválido (use letras, números e -)'],
      });
      continue;
    }
    if (nome.length > TAMANHO_MAXIMO_NOME_CABECALHO) {
      problemas.push({
        campo,
        mensagens: [
          `o nome deve ter no máximo ${TAMANHO_MAXIMO_NOME_CABECALHO} caracteres`,
        ],
      });
      continue;
    }
    if (RESERVADOS.has(minusculo) || minusculo.startsWith('x-crm-')) {
      problemas.push({
        campo,
        mensagens: ['é um cabeçalho reservado (o CRM ou o protocolo definem)'],
      });
      continue;
    }
    if (vistos.has(minusculo)) {
      problemas.push({ campo, mensagens: ['está repetido'] });
      continue;
    }
    vistos.add(minusculo);
    if (valor === null && opcoes.permitirNulos) {
      removidos.push(nome);
      continue;
    }
    if (typeof valor !== 'string') {
      problemas.push({ campo, mensagens: ['deve ser um texto'] });
      continue;
    }
    if (valor.length > TAMANHO_MAXIMO_VALOR_CABECALHO) {
      problemas.push({
        campo,
        mensagens: [
          `o valor deve ter no máximo ${TAMANHO_MAXIMO_VALOR_CABECALHO} caracteres`,
        ],
      });
      continue;
    }
    if (['\r', '\n', '\0'].some((caractere) => valor.includes(caractere))) {
      problemas.push({
        campo,
        mensagens: ['não pode ter quebra de linha'],
      });
      continue;
    }
    cabecalhos[nome] = valor.trim();
  }
  if (Object.keys(cabecalhos).length > CABECALHOS_EXTRAS_MAXIMOS) {
    problemas.push({
      campo: 'cabecalhos',
      mensagens: [`deve ter no máximo ${CABECALHOS_EXTRAS_MAXIMOS} cabeçalhos`],
    });
  }
  return problemas.length > 0
    ? { validos: false, problemas }
    : { validos: true, cabecalhos, removidos };
}

/**
 * Junta a atualização aos cabeçalhos atuais (o nome não diferencia
 * maiúsculas): os enviados substituem, os `removidos` saem, os outros ficam.
 */
export function juntarCabecalhos(
  atuais: Readonly<CabecalhosExtras>,
  novos: Readonly<CabecalhosExtras>,
  removidos: readonly string[],
): CabecalhosExtras {
  const resultado: CabecalhosExtras = {};
  const tirar = new Set(
    [...removidos, ...Object.keys(novos)].map((nome) => nome.toLowerCase()),
  );
  for (const [nome, valor] of Object.entries(atuais)) {
    if (!tirar.has(nome.toLowerCase())) {
      resultado[nome] = valor;
    }
  }
  return { ...resultado, ...novos };
}
