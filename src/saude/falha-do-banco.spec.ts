import {
  comPrazo,
  descreverFalhaDoBanco,
  detalharFalhaParaLog,
  PrazoEsgotadoError,
} from './falha-do-banco';

/** Erro no formato que o Prisma 7 lança quando o adapter `pg` falha. */
function erroDoPrisma(causa: Record<string, unknown>, mensagem: string) {
  return Object.assign(
    new Error(`\nInvalid \`prisma.$queryRaw()\` invocation:\n\n\n${mensagem}`),
    {
      name: 'PrismaClientKnownRequestError',
      code: 'P2010',
      meta: {
        driverAdapterError: { name: 'DriverAdapterError', cause: causa },
      },
    },
  );
}

describe('descreverFalhaDoBanco', () => {
  it('traduz o tipo do erro do adapter sem repetir host, usuário nem banco', () => {
    const fora = erroDoPrisma(
      { kind: 'DatabaseNotReachable', host: '10.0.0.7', port: 5432 },
      "Raw query failed. Code: `N/A`. Message: `Can't reach database server at 10.0.0.7:5432`",
    );
    expect(descreverFalhaDoBanco(fora)).toBe(
      'Não foi possível conectar ao banco.',
    );

    const senha = erroDoPrisma(
      {
        kind: 'AuthenticationFailed',
        originalCode: '28P01',
        user: 'crmbrl',
      },
      'Raw query failed. Code: `28P01`. Message: `password authentication failed for user "crmbrl"`',
    );
    expect(descreverFalhaDoBanco(senha)).toBe(
      'O banco recusou o usuário ou a senha (28P01).',
    );
  });

  it('usa a mensagem genérica, com o código, para tipos desconhecidos', () => {
    const erro = erroDoPrisma(
      { kind: 'postgres', originalCode: '57P01' },
      'terminating connection due to administrator command',
    );
    expect(descreverFalhaDoBanco(erro)).toBe(
      'Falha ao consultar o banco (57P01).',
    );
  });

  it('aceita o DriverAdapterError sem o envelope do Prisma', () => {
    const erro = Object.assign(new Error('x'), {
      name: 'DriverAdapterError',
      cause: { kind: 'TooManyConnections' },
    });
    expect(descreverFalhaDoBanco(erro)).toBe(
      'O banco recusou a conexão: há conexões demais abertas.',
    );
  });

  it('usa o código de erros comuns do Node', () => {
    const erro = Object.assign(
      new Error('connect ECONNREFUSED 10.0.0.7:5432'),
      {
        code: 'ECONNREFUSED',
      },
    );
    expect(descreverFalhaDoBanco(erro)).toBe(
      'Falha ao consultar o banco (ECONNREFUSED).',
    );
    expect(descreverFalhaDoBanco('qualquer coisa')).toBe(
      'Falha ao consultar o banco.',
    );
  });

  it('descreve o prazo esgotado', () => {
    expect(descreverFalhaDoBanco(new PrazoEsgotadoError(3000))).toBe(
      'O banco não respondeu em 3000 ms.',
    );
  });
});

describe('detalharFalhaParaLog', () => {
  it('fica com a última linha da mensagem do Prisma', () => {
    const erro = erroDoPrisma(
      { kind: 'DatabaseNotReachable' },
      "Raw query failed. Code: `N/A`. Message: `Can't reach database server at banco:5432`",
    );
    expect(detalharFalhaParaLog(erro)).toBe(
      "Raw query failed. Code: `N/A`. Message: `Can't reach database server at banco:5432`",
    );
    expect(detalharFalhaParaLog('texto solto')).toBe('texto solto');
  });
});

describe('comPrazo', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('devolve o resultado quando a operação termina a tempo', async () => {
    await expect(comPrazo(Promise.resolve(42), 1000)).resolves.toBe(42);
  });

  it('repassa a falha da operação', async () => {
    await expect(
      comPrazo(Promise.reject(new Error('falhou')), 1000),
    ).rejects.toThrow('falhou');
  });

  it('rejeita com PrazoEsgotadoError quando o prazo acaba', async () => {
    jest.useFakeTimers();
    const resultado = comPrazo(new Promise<never>(() => undefined), 3000);
    const verificacao =
      expect(resultado).rejects.toBeInstanceOf(PrazoEsgotadoError);
    await jest.advanceTimersByTimeAsync(3000);
    await verificacao;
  });
});
