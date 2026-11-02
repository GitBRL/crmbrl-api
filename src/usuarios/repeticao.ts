/**
 * Repetição de transações que o banco abortou por conflito de escrita ou
 * deadlock (Prisma `P2034`, SQLSTATE 40001/40P01).
 *
 * O desligamento trava os rodízios e mexe em linhas de vários módulos; uma
 * transação concorrente que trave as mesmas linhas em outra ordem (ex.: um
 * webhook reconvertendo um contato do desligado) pode levar o PostgreSQL a
 * abortar uma das duas. Como a transação inteira foi desfeita, basta repetir.
 */

/** O erro é o `P2034` do Prisma (conflito de escrita ou deadlock)? */
export function ehConflitoDeEscrita(erro: unknown): boolean {
  return (
    typeof erro === 'object' &&
    erro !== null &&
    (erro as { code?: unknown }).code === 'P2034'
  );
}

/** Roda `operacao` e a repete (até `tentativas` vezes no total) em conflito de escrita. */
export async function repetirEmConflito<T>(
  operacao: () => Promise<T>,
  tentativas = 3,
): Promise<T> {
  for (let tentativa = 1; ; tentativa++) {
    try {
      return await operacao();
    } catch (erro) {
      if (tentativa >= tentativas || !ehConflitoDeEscrita(erro)) {
        throw erro;
      }
    }
  }
}
