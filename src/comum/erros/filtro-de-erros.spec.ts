import { BadRequestException, NotFoundException } from '@nestjs/common';
import { traduzirErroDoPrisma } from './erros-do-prisma';
import {
  ConflitoException,
  DadosInvalidosException,
  MuitasTentativasException,
  RegraVioladaException,
} from './excecoes';
import { montarCorpo } from './filtro-de-erros';

function erroDoPrisma(code: string, meta: Record<string, unknown>) {
  return Object.assign(new Error('falha'), {
    name: 'PrismaClientKnownRequestError',
    code,
    meta,
  });
}

describe('montarCorpo — formato padrão de erro', () => {
  it('mantém código, mensagem e detalhes dos erros da API', () => {
    expect(
      montarCorpo(
        new RegraVioladaException('R5.5', 'Informe o motivo.', {
          etapaId: 'e',
        }),
        'req',
      ),
    ).toEqual({
      statusCode: 422,
      erro: 'regra_violada',
      mensagem: 'Informe o motivo.',
      detalhes: { regra: 'R5.5', etapaId: 'e' },
      requisicaoId: 'req',
    });
    expect(montarCorpo(new DadosInvalidosException(), 'req')).toMatchObject({
      statusCode: 400,
      erro: 'dados_invalidos',
    });
    expect(
      montarCorpo(new MuitasTentativasException('Calma.', 10), 'req')
        .statusCode,
    ).toBe(429);
    expect(
      montarCorpo(new ConflitoException('Já existe.'), 'req'),
    ).not.toHaveProperty('detalhes');
  });

  it('dá código e mensagem em português às exceções do Nest e do body parser', () => {
    expect(
      montarCorpo(new NotFoundException('Cannot GET /api/x'), 'r'),
    ).toMatchObject({
      statusCode: 404,
      erro: 'nao_encontrado',
      mensagem: 'Rota não encontrada.',
    });
    expect(
      montarCorpo(new BadRequestException('Unexpected end of JSON input'), 'r')
        .mensagem,
    ).toBe('O corpo da requisição não é um JSON válido.');
    expect(
      montarCorpo(
        Object.assign(new Error('too large'), {
          status: 413,
          type: 'entity.too.large',
        }),
        'r',
      ),
    ).toMatchObject({ statusCode: 413, erro: 'muito_grande' });
  });

  it('esconde o erro desconhecido atrás de um 500 com o id da requisição', () => {
    expect(montarCorpo(new Error('senha do banco: 123'), 'abc')).toEqual({
      statusCode: 500,
      erro: 'erro_interno',
      mensagem:
        'Erro interno. Tente de novo; se persistir, informe o código abc.',
      requisicaoId: 'abc',
    });
  });
});

describe('traduzirErroDoPrisma', () => {
  it('P2002 → 409 com os campos e a restrição', () => {
    const erro = traduzirErroDoPrisma(
      erroDoPrisma('P2002', {
        driverAdapterError: {
          cause: { constraint: { index: 'contatos_email_ativo_key' } },
        },
      }),
    );
    expect(erro).toBeInstanceOf(ConflitoException);
    expect(erro?.detalhes).toEqual({
      campos: ['email'],
      restricao: 'contatos_email_ativo_key',
    });
    expect(
      traduzirErroDoPrisma(erroDoPrisma('P2002', { target: ['email'] }))
        ?.detalhes,
    ).toEqual({
      campos: ['email'],
    });
  });

  it('P2025 → 404, P2003 e P2034 → 409', () => {
    expect(traduzirErroDoPrisma(erroDoPrisma('P2025', {}))?.getStatus()).toBe(
      404,
    );
    expect(traduzirErroDoPrisma(erroDoPrisma('P2003', {}))?.getStatus()).toBe(
      409,
    );
    expect(traduzirErroDoPrisma(erroDoPrisma('P2034', {}))?.getStatus()).toBe(
      409,
    );
  });

  it('gatilho do banco que cita a regra vira 422 com a regra', () => {
    const erro = traduzirErroDoPrisma(
      erroDoPrisma('P2039', {
        driverAdapterError: {
          cause: {
            originalCode: '23514',
            originalMessage: 'A primeira origem do contato é imutável (R4.3).',
          },
        },
      }),
    );
    expect(erro).toBeInstanceOf(RegraVioladaException);
    expect(erro?.detalhes).toEqual({ regra: 'R4.3' });
    // O código fica só nos detalhes (Onda A: mensagens sem código de regra).
    expect(erro?.mensagem).toBe('A primeira origem do contato é imutável.');
  });

  it('o resto não é traduzido', () => {
    expect(traduzirErroDoPrisma(erroDoPrisma('P2010', {}))).toBeNull();
    expect(traduzirErroDoPrisma(new Error('x'))).toBeNull();
  });
});
