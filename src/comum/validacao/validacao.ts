import { ValidationPipe, type ValidationError } from '@nestjs/common';
import { DadosInvalidosException } from '../erros/excecoes';

/** Um campo com problema, em `detalhes.campos` da resposta 400. */
export interface ProblemaDeCampo {
  /** Caminho do campo, com pontos para os aninhados (`itens.0.nome`). */
  campo: string;
  mensagens: string[];
}

/**
 * `ValidationPipe` global: lista branca (`whitelist` + `forbidNonWhitelisted`:
 * campo desconhecido é erro), `transform` (o DTO chega como instância da
 * classe, com `@Type` convertendo query strings) e erro no formato padrão,
 * `400 dados_invalidos`, com `detalhes.campos`.
 *
 * Escreva as mensagens dos decorators em português (`{ message: '…' }`); as
 * mensagens padrão do class-validator, em inglês, são traduzidas aqui.
 */
export function criarValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    validationError: { target: false, value: false },
    exceptionFactory: (erros: ValidationError[]) => {
      const campos = listarProblemas(erros);
      return new DadosInvalidosException(resumirProblemas(campos), { campos });
    },
  });
}

/** `Dados inválidos — email: deve ser um e-mail válido.` (o primeiro problema, para a mensagem). */
export function resumirProblemas(campos: readonly ProblemaDeCampo[]): string {
  const primeiro = campos[0];
  if (!primeiro) {
    return 'Dados inválidos.';
  }
  const mensagem = (primeiro.mensagens[0] ?? '').replace(/\.$/, '');
  const outros =
    campos.length > 1 ? ` (e mais ${campos.length - 1} campo(s))` : '';
  return `Dados inválidos — ${primeiro.campo}: ${mensagem}${outros}.`;
}

/** Achata os erros do class-validator (inclusive os aninhados) em `ProblemaDeCampo[]`. */
export function listarProblemas(
  erros: readonly ValidationError[],
  prefixo = '',
): ProblemaDeCampo[] {
  const problemas: ProblemaDeCampo[] = [];
  for (const erro of erros) {
    const campo = prefixo ? `${prefixo}.${erro.property}` : erro.property;
    const mensagens = Object.values(erro.constraints ?? {}).map((mensagem) =>
      traduzirMensagemDeValidacao(mensagem, erro.property),
    );
    if (mensagens.length > 0) {
      problemas.push({ campo, mensagens });
    }
    if (erro.children && erro.children.length > 0) {
      problemas.push(...listarProblemas(erro.children, campo));
    }
  }
  return problemas;
}

type Traducao = readonly [RegExp, (...grupos: string[]) => string];

/** Mensagens padrão do class-validator 0.15 (sem o nome do campo no começo). */
const TRADUCOES: readonly Traducao[] = [
  [/^should not exist$/, () => 'não é um campo aceito'],
  [/^should not be empty$/, () => 'é obrigatório'],
  [/^should not be null or undefined$/, () => 'é obrigatório'],
  [/^must be a string$/, () => 'deve ser um texto'],
  [/^must be an email$/, () => 'deve ser um e-mail válido'],
  [/^must be a boolean value$/, () => 'deve ser verdadeiro ou falso'],
  [/^must be an integer number$/, () => 'deve ser um número inteiro'],
  [
    /^must be a number conforming to the specified constraints$/,
    () => 'deve ser um número',
  ],
  [/^must be a number string$/, () => 'deve ser um número'],
  [/^must be a positive number$/, () => 'deve ser um número positivo'],
  [/^must be a negative number$/, () => 'deve ser um número negativo'],
  [/^must not be less than (.+)$/, (minimo) => `deve ser no mínimo ${minimo}`],
  [
    /^must not be greater than (.+)$/,
    (maximo) => `deve ser no máximo ${maximo}`,
  ],
  [
    /^must be longer than or equal to (\d+) and shorter than or equal to (\d+) characters$/,
    (minimo, maximo) => `deve ter de ${minimo} a ${maximo} caracteres`,
  ],
  [
    /^must be longer than or equal to (\d+) characters$/,
    (minimo) => `deve ter pelo menos ${minimo} caracteres`,
  ],
  [
    /^must be shorter than or equal to (\d+) characters$/,
    (maximo) => `deve ter no máximo ${maximo} caracteres`,
  ],
  [
    /^must be one of the following values: (.*)$/,
    (valores) => `deve ser um destes valores: ${valores}`,
  ],
  [
    /^should not be one of the following values: (.*)$/,
    (valores) => `não pode ser um destes valores: ${valores}`,
  ],
  [/^must be a UUID$/, () => 'deve ser um identificador (UUID) válido'],
  [
    /^must be a valid ISO 8601 date string$/,
    () => 'deve ser uma data no formato ISO 8601',
  ],
  [/^must be a Date instance$/, () => 'deve ser uma data'],
  [/^must be an array$/, () => 'deve ser uma lista'],
  [/^must be an object$/, () => 'deve ser um objeto'],
  [/^must be a non-empty object$/, () => 'deve ser um objeto não vazio'],
  [/^must be a URL address$/, () => 'deve ser um endereço (URL) válido'],
  [/^must be a json string$/, () => 'deve ser um JSON válido'],
  [
    /^must contain at least (\d+) elements$/,
    (minimo) => `deve ter pelo menos ${minimo} itens`,
  ],
  [
    /^must contain no more than (\d+) elements$/,
    (maximo) => `deve ter no máximo ${maximo} itens`,
  ],
  [/^must match .* regular expression$/, () => 'está em formato inválido'],
  [/^is not a valid decimal number\.$/, () => 'deve ser um número decimal'],
  [/^must be equal to (.+)$/, (valor) => `deve ser igual a ${valor}`],
  [/^must be either object or array$/, () => 'deve ser um objeto ou uma lista'],
];

/**
 * Traduz uma mensagem padrão do class-validator. Mensagens próprias (já em
 * português) passam como vieram.
 */
export function traduzirMensagemDeValidacao(
  mensagem: string,
  propriedade: string,
): string {
  let texto = mensagem;
  let cadaItem = false;
  if (texto.startsWith('each value in ')) {
    cadaItem = true;
    texto = texto.slice('each value in '.length);
  }
  if (texto.startsWith('nested property ')) {
    texto = texto.slice('nested property '.length);
  }
  if (texto.startsWith('property ')) {
    texto = texto.slice('property '.length);
  }
  if (!texto.startsWith(`${propriedade} `)) {
    return mensagem;
  }
  const resto = texto.slice(propriedade.length + 1);
  for (const [padrao, traduzir] of TRADUCOES) {
    const encontrado = padrao.exec(resto);
    if (encontrado) {
      const traducao = traduzir(...encontrado.slice(1));
      return cadaItem ? `(cada item) ${traducao}` : traducao;
    }
  }
  return mensagem;
}
