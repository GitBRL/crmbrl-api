/**
 * Regras puras de contato (R4.1, R4.2, R4.3, R4.7): normalização da entrada e
 * o plano de reconversão. Sem banco — o `ContatosService` trava, procura e
 * grava; aqui só se decide o quê.
 */
import type { ValorJson } from '../comum/dados/sanitizar';
import { ehEmailValido, normalizarEmail } from '../comum/dominio/email';
import {
  juntarEtiquetas,
  normalizarEtiquetas,
} from '../comum/dominio/etiquetas';
import { normalizarTelefone } from '../comum/dominio/telefone';
import { normalizarUtm, type Utm } from '../comum/dominio/utm';
import { DadosInvalidosException } from '../comum/erros/excecoes';
import { ehUuid } from '../comum/validacao/parse-id.pipe';
import {
  type ProblemaDeCampo,
  resumirProblemas,
} from '../comum/validacao/validacao';
import {
  type Contato,
  OrigemContato,
  Prisma,
} from '../generated/prisma/client';
import {
  BYTES_MAXIMOS_CAMPOS_PERSONALIZADOS,
  CHAVES_MAXIMAS_CAMPOS_PERSONALIZADOS,
  TAMANHO_MAXIMO_CHAVE_PERSONALIZADA,
  TAMANHO_MAXIMO_NOME,
  TAMANHO_MAXIMO_TEXTO_CURTO,
} from './contatos.constantes';

/** Objeto JSON (campos personalizados, UTM). */
export type ObjetoJson = { [chave: string]: ValorJson };

/**
 * Entrada da deduplicação — a assinatura de `ContatosService.encontrarOuCriar`
 * (contrato §5), usada por webhooks, importação e passagens.
 */
export interface EntradaEncontrarOuCriar {
  nome: string;
  email?: string;
  telefone?: string;
  empresaNome?: string;
  cargo?: string;
  origem: OrigemContato;
  origemDetalhe?: string;
  utm?: Utm;
  etiquetas?: string[];
  camposPersonalizados?: Record<string, unknown>;
  responsavelId?: string;
}

/** O que a criação manual acrescenta à entrada da deduplicação. */
export interface EntradaDeContato extends EntradaEncontrarOuCriar {
  empresaId?: string | null;
  consentimento?: { em: Date; origem: string } | null;
  optOutMarketing?: boolean;
}

/** Entrada normalizada: e-mail em minúsculas, telefone em E.164, etiquetas e UTM limpas. */
export interface ContatoNormalizado {
  readonly nome: string;
  readonly email: string | null;
  readonly telefone: string | null;
  readonly cargo: string | null;
  readonly empresaId: string | null;
  readonly empresaNome: string | null;
  readonly origem: OrigemContato;
  readonly origemDetalhe: string | null;
  readonly utm: Utm | null;
  readonly etiquetas: string[];
  readonly camposPersonalizados: ObjetoJson;
  readonly responsavelId: string | null;
  readonly consentimento: { readonly em: Date; readonly origem: string } | null;
  readonly optOutMarketing: boolean;
  /** Valores recusados no modo tolerante (vão para a auditoria). */
  readonly descartados: readonly ProblemaDeCampo[];
}

export interface OpcoesDeNormalizacao {
  /**
   * Automação (webhook, importação): um e-mail ou telefone inválido é
   * descartado quando o outro meio de contato é válido, para não perder o
   * lead. Na entrada manual (padrão) qualquer valor inválido é erro.
   */
  tolerante?: boolean;
}

const CAMPOS_DO_MEIO_DE_CONTATO = new Set(['nome', 'email', 'telefone']);
const MENSAGEM_SEM_MEIO_DE_CONTATO = 'informe o e-mail ou o telefone';

/** Texto de uma linha: espaços colapsados, aparado e cortado no limite; vazio vira `null`. */
export function normalizarTextoCurto(
  valor: unknown,
  limite: number = TAMANHO_MAXIMO_TEXTO_CURTO,
): string | null {
  if (typeof valor !== 'string' && typeof valor !== 'number') {
    return null;
  }
  const texto = String(valor)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limite)
    .trim();
  return texto || null;
}

/** Objeto literal (`{ … }`), sem listas, datas nem instâncias de classes. */
export function ehObjetoSimples(
  valor: unknown,
): valor is Record<string, unknown> {
  return Object.prototype.toString.call(valor) === '[object Object]';
}

/** Coluna `jsonb` → objeto (qualquer outro valor vira `{}`). */
export function objetoJson(
  valor: Prisma.JsonValue | null | undefined,
): ObjetoJson {
  return ehObjetoSimples(valor) ? (valor as ObjetoJson) : {};
}

/** Coluna `jsonb` de UTM → `Utm` (só as cinco chaves) ou `null`. */
export function utmDoJson(
  valor: Prisma.JsonValue | null | undefined,
): Utm | null {
  return ehObjetoSimples(valor) ? normalizarUtm(valor) : null;
}

/** `Utm`/objeto JSON → valor para gravar numa coluna `jsonb` anulável. */
export function jsonOuNulo(
  valor: Utm | ObjetoJson | null | undefined,
): Prisma.InputJsonObject | typeof Prisma.DbNull {
  return valor && Object.keys(valor).length > 0
    ? (valor as Prisma.InputJsonObject)
    : Prisma.DbNull;
}

function problema(campo: string, mensagem: string): ProblemaDeCampo {
  return { campo, mensagens: [mensagem] };
}

function erroDeCampo(campo: string, mensagem: string): DadosInvalidosException {
  const campos = [problema(campo, mensagem)];
  return new DadosInvalidosException(resumirProblemas(campos), { campos });
}

/**
 * Campos personalizados (R4.7): um objeto JSON com até 200 chaves (de até 100
 * caracteres) e 64 KB. Chaves são aparadas; as vazias, descartadas. Valores
 * `null` são mantidos (no PATCH, significam "apagar a chave").
 */
export function normalizarCamposPersonalizados(
  valor: unknown,
  campo = 'camposPersonalizados',
): ObjetoJson {
  if (valor === undefined || valor === null) {
    return {};
  }
  if (!ehObjetoSimples(valor)) {
    throw erroDeCampo(campo, 'deve ser um objeto');
  }
  let copia: unknown;
  try {
    copia = JSON.parse(JSON.stringify(valor));
  } catch {
    throw erroDeCampo(campo, 'deve ser um JSON válido');
  }
  const resultado: ObjetoJson = {};
  for (const [chaveBruta, item] of Object.entries(copia as ObjetoJson)) {
    const chave = chaveBruta.trim();
    if (!chave) {
      continue;
    }
    if (chave.length > TAMANHO_MAXIMO_CHAVE_PERSONALIZADA) {
      throw erroDeCampo(
        campo,
        `cada chave deve ter no máximo ${TAMANHO_MAXIMO_CHAVE_PERSONALIZADA} caracteres`,
      );
    }
    resultado[chave] = item;
  }
  garantirLimitesDosCampos(resultado, campo);
  return resultado;
}

function garantirLimitesDosCampos(campos: ObjetoJson, campo: string): void {
  if (Object.keys(campos).length > CHAVES_MAXIMAS_CAMPOS_PERSONALIZADOS) {
    throw erroDeCampo(
      campo,
      `deve ter no máximo ${CHAVES_MAXIMAS_CAMPOS_PERSONALIZADOS} chaves`,
    );
  }
  if (
    Buffer.byteLength(JSON.stringify(campos)) >
    BYTES_MAXIMOS_CAMPOS_PERSONALIZADOS
  ) {
    throw erroDeCampo(
      campo,
      `deve ter no máximo ${BYTES_MAXIMOS_CAMPOS_PERSONALIZADOS / 1024} KB`,
    );
  }
}

/**
 * PATCH dos campos personalizados (JSON Merge Patch no primeiro nível): as
 * chaves enviadas substituem as atuais, `null` apaga a chave e as que não
 * vieram ficam. `null` no lugar do objeto inteiro limpa tudo.
 */
export function aplicarPatchDosCampos(
  atuais: Prisma.JsonValue | null | undefined,
  patch: Record<string, unknown> | null,
): ObjetoJson {
  if (patch === null) {
    return {};
  }
  const mudancas = normalizarCamposPersonalizados(patch);
  const resultado: ObjetoJson = { ...objetoJson(atuais) };
  for (const [chave, valor] of Object.entries(mudancas)) {
    if (valor === null) {
      delete resultado[chave];
    } else {
      resultado[chave] = valor;
    }
  }
  garantirLimitesDosCampos(resultado, 'camposPersonalizados');
  return resultado;
}

/** Valor de campo "vazio" para a reconversão: ausente, `null` ou texto em branco. */
export function ehValorVazio(valor: ValorJson | undefined): boolean {
  return (
    valor === undefined ||
    valor === null ||
    (typeof valor === 'string' && valor.trim() === '')
  );
}

type Leitura =
  { valor: string; erro?: undefined } | { valor: null; erro?: string };

function lerEmail(email: unknown): Leitura {
  if (typeof email !== 'string' || email.trim() === '') {
    return { valor: null };
  }
  return ehEmailValido(email)
    ? { valor: normalizarEmail(email) }
    : { valor: null, erro: 'deve ser um e-mail válido' };
}

/** Mensagem de validação a partir do motivo do `normalizarTelefone` ("DDD 20 não existe."). */
export function mensagemDeTelefoneInvalido(motivo: string): string {
  return `deve ser um telefone válido (${motivo.replace(/\.$/, '')})`;
}

function lerTelefone(telefone: unknown): Leitura {
  if (typeof telefone === 'number') {
    return lerTelefone(String(telefone));
  }
  if (typeof telefone !== 'string' || telefone.trim() === '') {
    return { valor: null };
  }
  const resultado = normalizarTelefone(telefone);
  return resultado.valido
    ? { valor: resultado.telefone }
    : { valor: null, erro: mensagemDeTelefoneInvalido(resultado.motivo) };
}

function ehOrigemValida(origem: unknown): origem is OrigemContato {
  return (
    typeof origem === 'string' &&
    (Object.values(OrigemContato) as string[]).includes(origem)
  );
}

/**
 * Normaliza e valida a entrada de um contato (R4.1, R4.3, R4.7): nome
 * obrigatório, e-mail em minúsculas, telefone em E.164 só com dígitos (DDD
 * validado), pelo menos um meio de contato, etiquetas sem duplicatas, UTM só
 * com as cinco chaves e campos personalizados em JSON.
 *
 * Lança `DadosInvalidosException` (400) com `detalhes.campos` — e
 * `detalhes.regra = 'R4.1'` quando o problema é o nome ou o meio de contato.
 */
export function normalizarEntradaDeContato(
  entrada: EntradaDeContato,
  opcoes: OpcoesDeNormalizacao = {},
): ContatoNormalizado {
  const problemas: ProblemaDeCampo[] = [];
  const descartados: ProblemaDeCampo[] = [];

  const nome = normalizarTextoCurto(entrada.nome, TAMANHO_MAXIMO_NOME);
  if (!nome) {
    problemas.push(problema('nome', 'é obrigatório'));
  }

  const email = lerEmail(entrada.email);
  const telefone = lerTelefone(entrada.telefone);
  const algumValido = email.valor !== null || telefone.valor !== null;
  for (const [campo, leitura] of [
    ['email', email],
    ['telefone', telefone],
  ] as const) {
    if (leitura.erro) {
      (opcoes.tolerante && algumValido ? descartados : problemas).push(
        problema(campo, leitura.erro),
      );
    }
  }
  const semMeioDeContato = !algumValido && !email.erro && !telefone.erro;
  if (semMeioDeContato) {
    problemas.push(
      problema('email', MENSAGEM_SEM_MEIO_DE_CONTATO),
      problema('telefone', MENSAGEM_SEM_MEIO_DE_CONTATO),
    );
  }

  if (!ehOrigemValida(entrada.origem)) {
    problemas.push(problema('origem', 'deve ser uma origem válida'));
  }
  for (const campo of ['responsavelId', 'empresaId'] as const) {
    const id = entrada[campo];
    if (id !== undefined && id !== null && !ehUuid(id)) {
      problemas.push(
        problema(campo, 'deve ser um identificador (UUID) válido'),
      );
    }
  }

  let camposPersonalizados: ObjetoJson = {};
  try {
    camposPersonalizados = normalizarCamposPersonalizados(
      entrada.camposPersonalizados,
    );
  } catch (erro) {
    if (!(erro instanceof DadosInvalidosException)) {
      throw erro;
    }
    problemas.push(
      ...((erro.detalhes?.campos as ProblemaDeCampo[] | undefined) ?? []),
    );
  }

  if (problemas.length > 0) {
    const doMeioDeContato = problemas.some(({ campo }) =>
      CAMPOS_DO_MEIO_DE_CONTATO.has(campo),
    );
    const mensagem =
      semMeioDeContato && problemas.length === 2
        ? 'O contato precisa de e-mail ou telefone.'
        : resumirProblemas(problemas);
    throw new DadosInvalidosException(mensagem, {
      ...(doMeioDeContato ? { regra: 'R4.1' } : {}),
      campos: problemas,
    });
  }

  const consentimento = entrada.consentimento
    ? {
        em: entrada.consentimento.em,
        origem:
          normalizarTextoCurto(entrada.consentimento.origem) ?? 'não informada',
      }
    : null;

  return {
    nome: nome as string,
    email: email.valor,
    telefone: telefone.valor,
    cargo: normalizarTextoCurto(entrada.cargo),
    empresaId: entrada.empresaId?.toLowerCase() ?? null,
    empresaNome: normalizarTextoCurto(entrada.empresaNome, TAMANHO_MAXIMO_NOME),
    origem: entrada.origem,
    origemDetalhe: normalizarTextoCurto(entrada.origemDetalhe),
    utm: normalizarUtm(entrada.utm),
    etiquetas: normalizarEtiquetas(entrada.etiquetas),
    camposPersonalizados,
    responsavelId: entrada.responsavelId?.toLowerCase() ?? null,
    consentimento,
    optOutMarketing: entrada.optOutMarketing === true,
    descartados,
  };
}

/** O que a reconversão precisa saber do banco antes de planejar. */
export interface ContextoDaReconversao {
  /** O e-mail da entrada não é de outro contato ativo e pode ser copiado. */
  emailLivre: boolean;
  /** O telefone da entrada não é de outro contato ativo e pode ser copiado. */
  telefoneLivre: boolean;
  /** Empresa a vincular (já resolvida), usada só se o contato não tiver uma. */
  empresaId: string | null;
  /** Responsável a definir (já validado), usado só se o contato não tiver um. */
  responsavelId: string | null;
  agora: Date;
}

export interface PlanoDeReconversao {
  dados: Prisma.ContatoUncheckedUpdateInput;
  /** Campos vazios que a reconversão preencheu (`camposPersonalizados.<chave>` para os personalizados). */
  camposCompletados: string[];
}

/**
 * Reconversão (R4.2, R4.3): o contato já existe. Completa só os campos vazios
 * — nunca sobrescreve um preenchido —, junta etiquetas e campos personalizados
 * novos, troca a **última** origem (tipo, detalhe e UTM; a primeira é imutável)
 * e soma uma conversão. Opt-out pedido agora vale (é a vontade do titular,
 * R4.6); um opt-out existente nunca é desfeito por reconversão.
 */
export function planejarReconversao(
  existente: Contato,
  entrada: ContatoNormalizado,
  contexto: ContextoDaReconversao,
): PlanoDeReconversao {
  const dados: Prisma.ContatoUncheckedUpdateInput = {
    ultimaOrigem: entrada.origem,
    ultimaOrigemDetalhe: entrada.origemDetalhe,
    ultimaOrigemUtm: jsonOuNulo(entrada.utm),
    ultimaOrigemEm: contexto.agora,
    conversoes: { increment: 1 },
  };
  const completados: string[] = [];

  if (!existente.email && entrada.email && contexto.emailLivre) {
    dados.email = entrada.email;
    completados.push('email');
  }
  if (!existente.telefone && entrada.telefone && contexto.telefoneLivre) {
    dados.telefone = entrada.telefone;
    completados.push('telefone');
  }
  if (!existente.cargo && entrada.cargo) {
    dados.cargo = entrada.cargo;
    completados.push('cargo');
  }
  if (!existente.empresaId && contexto.empresaId) {
    dados.empresaId = contexto.empresaId;
    completados.push('empresaId');
  }
  if (!existente.responsavelId && contexto.responsavelId) {
    dados.responsavelId = contexto.responsavelId;
    completados.push('responsavelId');
  }

  const etiquetas = juntarEtiquetas(existente.etiquetas, entrada.etiquetas);
  if (JSON.stringify(etiquetas) !== JSON.stringify(existente.etiquetas)) {
    dados.etiquetas = etiquetas;
    completados.push('etiquetas');
  }

  const campos: ObjetoJson = { ...objetoJson(existente.camposPersonalizados) };
  const chavesNovas: string[] = [];
  for (const [chave, valor] of Object.entries(entrada.camposPersonalizados)) {
    if (ehValorVazio(campos[chave]) && !ehValorVazio(valor)) {
      campos[chave] = valor;
      chavesNovas.push(chave);
    }
  }
  if (chavesNovas.length > 0) {
    dados.camposPersonalizados = campos as Prisma.InputJsonObject;
    completados.push(
      ...chavesNovas.map((chave) => `camposPersonalizados.${chave}`),
    );
  }

  if (
    !existente.consentimentoEm &&
    !existente.consentimentoOrigem &&
    entrada.consentimento
  ) {
    dados.consentimentoEm = entrada.consentimento.em;
    dados.consentimentoOrigem = entrada.consentimento.origem;
    completados.push('consentimento');
  }
  if (!existente.optOutMarketing && entrada.optOutMarketing) {
    dados.optOutMarketing = true;
    dados.optOutEm = contexto.agora;
    completados.push('optOutMarketing');
  }

  return { dados, camposCompletados: completados };
}
