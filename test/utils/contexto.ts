import {
  executarComoAtor,
  haContexto,
} from '../../src/comum/contexto/contexto-requisicao';

/**
 * R35.2: roda `fn` como a fila rodaria um job (ator `SISTEMA`). Use quando o
 * teste chama direto um serviço da API que, em produção, roda num job ou num
 * agendamento: sem contexto, o banco não devolve nada das tabelas protegidas.
 */
export function comoSistema<T>(fn: () => T): T {
  // executarComoAtor já inicia as consultas preguiçosas do Prisma dentro do contexto.
  return executarComoAtor({ tipoAtor: 'SISTEMA', descricao: 'Teste' }, fn);
}

const PAPEIS = new Set(['ADMIN', 'C_LEVEL', 'LIDER', 'MEMBRO']);

/** O primeiro argumento que parece um usuário (`{ id, papel }`), se houver. */
function usuarioDosArgumentos(
  argumentos: readonly unknown[],
): { id: string; papel: string; nome?: string } | null {
  for (const argumento of argumentos) {
    if (
      argumento &&
      typeof argumento === 'object' &&
      typeof (argumento as { id?: unknown }).id === 'string' &&
      PAPEIS.has((argumento as { papel?: unknown }).papel as string)
    ) {
      return argumento as { id: string; papel: string; nome?: string };
    }
  }
  return null;
}

/**
 * O serviço com cada método rodando no contexto que ele teria em produção
 * quando o teste o chama fora de qualquer contexto: se algum argumento é um
 * usuário (`servico.listar(usuario, …)`, como numa requisição), no contexto
 * dele — a RLS recorta como recortaria na rota; senão, como sistema (como a
 * fila rodaria o job). Dentro de um contexto aberto pelo próprio teste
 * (`executarComoAtor`), roda nele. `t.get(...)` já devolve os serviços assim.
 */
export function servicoComoSistema<T>(
  servico: T,
  opcoes: { sempreSistema?: boolean } = {},
): T {
  if (servico === null || typeof servico !== 'object') {
    return servico;
  }
  return new Proxy(servico, {
    get(alvo, chave) {
      const valor = Reflect.get(alvo, chave) as unknown;
      // Funções comuns e os `jest.fn`/`spyOn` (que o teste confere) passam como estão.
      if (typeof valor !== 'function' || 'mock' in valor) {
        return valor;
      }
      return (...argumentos: unknown[]) => {
        if (haContexto()) {
          return (valor as (...a: unknown[]) => unknown).apply(
            alvo,
            argumentos,
          );
        }
        // O gateway do WhatsApp fala com o banco sempre como sistema (R35.2).
        const usuario = opcoes.sempreSistema
          ? null
          : usuarioDosArgumentos(argumentos);
        const noContexto = <R>(fn: () => R): R =>
          usuario
            ? executarComoAtor(
                {
                  tipoAtor: 'USUARIO',
                  usuario: {
                    id: usuario.id,
                    papel: usuario.papel as never,
                    nome: usuario.nome ?? 'Teste',
                  },
                },
                fn,
              )
            : comoSistema(fn);
        const resultado = noContexto(() =>
          (valor as (...a: unknown[]) => unknown).apply(alvo, argumentos),
        );
        return iteradorNoContexto(resultado, noContexto);
      };
    },
  });
}

/** Um gerador assíncrono (ex.: `iterarIds`) avança no contexto em que foi criado. */
function iteradorNoContexto(
  resultado: unknown,
  noContexto: <R>(fn: () => R) => R,
): unknown {
  if (
    !resultado ||
    typeof resultado !== 'object' ||
    typeof (resultado as AsyncIterator<unknown>).next !== 'function' ||
    !(Symbol.asyncIterator in resultado)
  ) {
    return resultado;
  }
  const iterador = resultado as AsyncGenerator<unknown>;
  const envolvido: AsyncGenerator<unknown> = {
    next: (...a: [] | [unknown]) => noContexto(() => iterador.next(...a)),
    return: (v: unknown) => noContexto(() => iterador.return(v)),
    throw: (e: unknown) => noContexto(() => iterador.throw(e)),
    [Symbol.asyncIterator]() {
      return envolvido;
    },
    [Symbol.asyncDispose]: () => Promise.resolve(),
  };
  return envolvido;
}
