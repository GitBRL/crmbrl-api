/**
 * Chamadas `fetch` às APIs dos aplicativos (Typeform, ActiveCampaign, ManyChat),
 * com tempo limite, sem seguir redirecionamentos e com os erros traduzidos:
 * 401/403 → credencial recusada; o resto → falha no aplicativo. O token nunca
 * entra em mensagem de erro.
 */
import { CredencialRecusadaError, FalhaNoAplicativoError } from './tipos';

export const PRAZO_DAS_CHAMADAS_MS = 10_000;

export interface PedidoDoAplicativo {
  readonly buscar: typeof fetch;
  readonly url: string;
  readonly metodo?: 'GET' | 'PUT' | 'DELETE' | 'POST';
  readonly cabecalhos: Record<string, string>;
  readonly corpo?: unknown;
  /** Nome do aplicativo, para as mensagens (`Typeform`). */
  readonly aplicativo: string;
  /** Status que também valem como sucesso além de 2xx (ex.: 404 ao remover). */
  readonly aceitar?: readonly number[];
}

export interface RespostaDoAplicativo {
  readonly status: number;
  readonly dados: unknown;
}

export async function chamarAplicativo(
  pedido: PedidoDoAplicativo,
): Promise<RespostaDoAplicativo> {
  let resposta: Response;
  try {
    resposta = await pedido.buscar(pedido.url, {
      method: pedido.metodo ?? 'GET',
      headers: {
        Accept: 'application/json',
        ...(pedido.corpo === undefined
          ? {}
          : { 'Content-Type': 'application/json' }),
        ...pedido.cabecalhos,
      },
      body:
        pedido.corpo === undefined ? undefined : JSON.stringify(pedido.corpo),
      redirect: 'manual',
      signal: AbortSignal.timeout(PRAZO_DAS_CHAMADAS_MS),
    });
  } catch (erro) {
    const nome =
      typeof erro === 'object' && erro !== null && 'name' in erro
        ? String((erro as { name: unknown }).name)
        : '';
    throw new FalhaNoAplicativoError(
      nome === 'TimeoutError' || nome === 'AbortError'
        ? `O ${pedido.aplicativo} não respondeu em ${PRAZO_DAS_CHAMADAS_MS / 1000} s.`
        : `Não foi possível falar com o ${pedido.aplicativo} (falha de conexão).`,
    );
  }
  const texto = await lerTexto(resposta);
  if (resposta.status === 401 || resposta.status === 403) {
    throw new CredencialRecusadaError(
      `O ${pedido.aplicativo} recusou a credencial (HTTP ${resposta.status}): ela expirou, foi revogada ou está errada.`,
    );
  }
  if (
    !(resposta.status >= 200 && resposta.status < 300) &&
    !pedido.aceitar?.includes(resposta.status)
  ) {
    throw new FalhaNoAplicativoError(
      `O ${pedido.aplicativo} respondeu HTTP ${resposta.status}${
        resposta.status >= 300 && resposta.status < 400
          ? ' (redirecionamento não é seguido)'
          : ''
      }.`,
    );
  }
  let dados: unknown = null;
  if (texto) {
    try {
      dados = JSON.parse(texto) as unknown;
    } catch {
      throw new FalhaNoAplicativoError(
        `O ${pedido.aplicativo} respondeu algo que não é JSON.`,
      );
    }
  }
  return { status: resposta.status, dados };
}

/** Lê no máximo 1 MB da resposta. */
async function lerTexto(resposta: Response): Promise<string> {
  const texto = await resposta.text().catch(() => '');
  return texto.length > 1_000_000 ? texto.slice(0, 1_000_000) : texto;
}
