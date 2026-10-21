import type { ValidationError } from '@nestjs/common';
import { DadosInvalidosException } from '../erros/excecoes';
import {
  criarValidationPipe,
  listarProblemas,
  resumirProblemas,
  traduzirMensagemDeValidacao,
} from './validacao';

describe('mensagens de validação em português', () => {
  it.each([
    ['email must be an email', 'email', 'deve ser um e-mail válido'],
    ['nome should not be empty', 'nome', 'é obrigatório'],
    [
      'senha must be longer than or equal to 8 characters',
      'senha',
      'deve ter pelo menos 8 caracteres',
    ],
    [
      'senha must be shorter than or equal to 128 characters',
      'senha',
      'deve ter no máximo 128 caracteres',
    ],
    ['pagina must not be less than 1', 'pagina', 'deve ser no mínimo 1'],
    [
      'papel must be one of the following values: ADMIN, CS',
      'papel',
      'deve ser um destes valores: ADMIN, CS',
    ],
    ['property intruso should not exist', 'intruso', 'não é um campo aceito'],
    [
      'each value in etiquetas must be a string',
      'etiquetas',
      '(cada item) deve ser um texto',
    ],
    [
      'nested property endereco must be either object or array',
      'endereco',
      'deve ser um objeto ou uma lista',
    ],
    ['id must be a UUID', 'id', 'deve ser um identificador (UUID) válido'],
  ])('"%s" → "%s"', (mensagem, propriedade, esperada) => {
    expect(traduzirMensagemDeValidacao(mensagem, propriedade)).toBe(esperada);
  });

  it('mensagens próprias (já em português) passam como vieram', () => {
    expect(
      traduzirMensagemDeValidacao('Informe o motivo da perda.', 'motivo'),
    ).toBe('Informe o motivo da perda.');
  });
});

describe('listarProblemas e resumo', () => {
  const erros: ValidationError[] = [
    {
      property: 'email',
      constraints: { isEmail: 'email must be an email' },
      children: [],
    },
    {
      property: 'endereco',
      children: [
        {
          property: 'cidade',
          constraints: { isString: 'cidade must be a string' },
          children: [],
        },
      ],
    },
  ];

  it('achata os aninhados com caminho pontuado', () => {
    expect(listarProblemas(erros)).toEqual([
      { campo: 'email', mensagens: ['deve ser um e-mail válido'] },
      { campo: 'endereco.cidade', mensagens: ['deve ser um texto'] },
    ]);
  });

  it('resume o primeiro problema na mensagem', () => {
    expect(resumirProblemas(listarProblemas(erros))).toBe(
      'Dados inválidos — email: deve ser um e-mail válido (e mais 1 campo(s)).',
    );
    expect(resumirProblemas([])).toBe('Dados inválidos.');
  });

  it('o pipe gera DadosInvalidosException com detalhes.campos', () => {
    const pipe = criarValidationPipe() as unknown as {
      exceptionFactory: (erros: ValidationError[]) => unknown;
    };
    const excecao = pipe.exceptionFactory(erros);
    expect(excecao).toBeInstanceOf(DadosInvalidosException);
    expect((excecao as DadosInvalidosException).detalhes).toEqual({
      campos: listarProblemas(erros),
    });
  });
});
