/**
 * Como a verificação de saúde lida com falhas do banco: prazo para cada
 * consulta e uma descrição curta do erro, segura para a resposta pública.
 */

/** A consulta não terminou dentro do prazo. */
export class PrazoEsgotadoError extends Error {
  constructor(readonly prazoMs: number) {
    super(`O banco não respondeu em ${prazoMs} ms`);
    this.name = 'PrazoEsgotadoError';
  }
}

/**
 * Rejeita com `PrazoEsgotadoError` se a operação não terminar em `prazoMs`. A
 * operação não é cancelada; a resposta é que não fica esperando por ela.
 */
export function comPrazo<T>(
  operacao: PromiseLike<T>,
  prazoMs: number,
): Promise<T> {
  let temporizador: NodeJS.Timeout | undefined;
  const prazo = new Promise<never>((_resolver, rejeitar) => {
    temporizador = setTimeout(
      () => rejeitar(new PrazoEsgotadoError(prazoMs)),
      prazoMs,
    );
  });
  return Promise.race([operacao, prazo]).finally(() =>
    clearTimeout(temporizador),
  );
}

/** Mensagem por tipo de erro do adapter do Prisma (`meta.driverAdapterError.cause.kind`). */
const MENSAGEM_POR_TIPO: Readonly<Record<string, string>> = {
  DatabaseNotReachable: 'Não foi possível conectar ao banco',
  SocketTimeout: 'A conexão com o banco expirou',
  ConnectionClosed: 'O banco encerrou a conexão',
  TlsConnectionError: 'Falha na conexão segura (TLS) com o banco',
  AuthenticationFailed: 'O banco recusou o usuário ou a senha',
  DatabaseAccessDenied: 'O usuário configurado não tem acesso ao banco',
  DatabaseDoesNotExist: 'O banco de dados configurado não existe',
  TooManyConnections: 'O banco recusou a conexão: há conexões demais abertas',
  TableDoesNotExist:
    'Falta uma tabela no banco (as migrations foram aplicadas?)',
};

const MENSAGEM_GENERICA = 'Falha ao consultar o banco';

/**
 * Descrição curta de uma falha do banco, para o campo `banco.erro` de
 * `GET /api/saude` — uma rota pública.
 *
 * Nunca repete a mensagem do driver, que traz host, porta, usuário e nome do
 * banco: usa só o tipo do erro e o código (SQLSTATE do PostgreSQL ou código do
 * Node/Prisma), quando houver.
 */
export function descreverFalhaDoBanco(falha: unknown): string {
  if (falha instanceof PrazoEsgotadoError) {
    return `${falha.message}.`;
  }
  const causa = causaDoAdapter(falha);
  const mensagem =
    (causa?.tipo && MENSAGEM_POR_TIPO[causa.tipo]) ?? MENSAGEM_GENERICA;
  const codigo = causa ? causa.codigo : codigoDe(falha);
  return codigo ? `${mensagem} (${codigo}).` : `${mensagem}.`;
}

/**
 * Detalhe técnico para o log do servidor: a última linha da mensagem original
 * (a do Prisma começa com um cabeçalho de várias linhas). Não vai para a resposta.
 */
export function detalharFalhaParaLog(falha: unknown): string {
  const texto = falha instanceof Error ? falha.message : String(falha);
  const linhas = texto.split('\n').filter((linha) => linha.trim() !== '');
  return linhas.at(-1)?.trim() ?? texto;
}

interface CausaDoAdapter {
  tipo?: string;
  codigo?: string;
}

/** A causa que o adapter do Prisma anexa ao erro, se for um erro dele. */
function causaDoAdapter(falha: unknown): CausaDoAdapter | undefined {
  if (!ehObjeto(falha)) {
    return undefined;
  }
  const doMeta =
    ehObjeto(falha.meta) && ehObjeto(falha.meta.driverAdapterError)
      ? falha.meta.driverAdapterError.cause
      : undefined;
  const causa =
    doMeta ?? (falha.name === 'DriverAdapterError' ? falha.cause : undefined);
  if (!ehObjeto(causa)) {
    return undefined;
  }
  return {
    tipo: textoOuNada(causa.kind),
    codigo: textoOuNada(causa.originalCode),
  };
}

function codigoDe(falha: unknown): string | undefined {
  return ehObjeto(falha) ? textoOuNada(falha.code) : undefined;
}

function textoOuNada(valor: unknown): string | undefined {
  return typeof valor === 'string' && valor !== '' ? valor : undefined;
}

function ehObjeto(valor: unknown): valor is Record<string, unknown> {
  return typeof valor === 'object' && valor !== null;
}
