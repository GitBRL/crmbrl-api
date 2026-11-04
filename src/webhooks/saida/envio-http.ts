/**
 * O envio HTTP de uma entrega (R9.3–R9.5), com o `fetch` nativo do Node:
 * `POST` com tempo limite, sem seguir redirecionamentos (um redirecionamento
 * poderia levar a uma rede interna, R9.1) e lendo só o começo da resposta.
 */
import {
  BYTES_DO_TRECHO_DA_RESPOSTA,
  PRAZO_DO_ENVIO_MS,
} from '../webhooks.constantes';

export interface PedidoDeEnvio {
  readonly url: string;
  /** `POST` (padrão) ou `GET` (formato Clint: os parâmetros já vão na URL e não há corpo). */
  readonly metodo?: 'POST' | 'GET';
  readonly corpo: string;
  readonly cabecalhos: Readonly<Record<string, string>>;
  /** Tempo limite da tentativa inteira (conexão, resposta e leitura do trecho). */
  readonly prazoMs?: number;
  /** Bytes da resposta guardados (padrão 2 KB, R9.5). */
  readonly bytesDoTrecho?: number;
}

/** O que fica registrado de cada tentativa (R9.5). */
export interface ResultadoDoEnvio {
  /** Resposta 2xx (R9.4). */
  readonly sucesso: boolean;
  readonly statusHttp: number | null;
  readonly duracaoMs: number;
  /** Até 2 KB da resposta. */
  readonly trechoResposta: string | null;
  readonly erro: string | null;
}

/** Tamanho máximo da mensagem de erro gravada. */
const TAMANHO_MAXIMO_ERRO = 1_000;

/** Faz o `POST` e devolve o resultado; nunca lança erro. */
export async function enviarPost(
  pedido: PedidoDeEnvio,
): Promise<ResultadoDoEnvio> {
  const prazoMs = pedido.prazoMs ?? PRAZO_DO_ENVIO_MS;
  const inicio = performance.now();
  const duracao = () => Math.round(performance.now() - inicio);
  try {
    const metodo = pedido.metodo ?? 'POST';
    const resposta = await fetch(pedido.url, {
      method: metodo,
      headers: { ...pedido.cabecalhos },
      body: metodo === 'GET' ? undefined : pedido.corpo,
      redirect: 'manual',
      signal: AbortSignal.timeout(prazoMs),
    });
    const trecho = await lerTrecho(
      resposta,
      pedido.bytesDoTrecho ?? BYTES_DO_TRECHO_DA_RESPOSTA,
    );
    const sucesso = resposta.status >= 200 && resposta.status < 300;
    return {
      sucesso,
      statusHttp: resposta.status,
      duracaoMs: duracao(),
      trechoResposta: trecho,
      erro: sucesso ? null : descreverStatus(resposta),
    };
  } catch (erro) {
    return {
      sucesso: false,
      statusHttp: null,
      duracaoMs: duracao(),
      trechoResposta: null,
      erro: limitar(descreverFalha(erro, prazoMs)),
    };
  }
}

/** Lê no máximo `limite` bytes do corpo da resposta e descarta o resto. */
export async function lerTrecho(
  resposta: Response,
  limite: number,
): Promise<string | null> {
  if (!resposta.body) {
    return null;
  }
  const leitor = resposta.body.getReader();
  const partes: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < limite) {
      const { done, value } = await leitor.read();
      if (done) {
        break;
      }
      partes.push(value);
      total += value.byteLength;
    }
  } finally {
    await leitor.cancel().catch(() => undefined);
  }
  const bytes = Buffer.concat(partes).subarray(0, limite);
  const texto = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  return texto.length > 0 ? texto : null;
}

function descreverStatus(resposta: Response): string {
  if (resposta.status >= 300 && resposta.status < 400) {
    const destino = resposta.headers.get('location');
    return limitar(
      `HTTP ${resposta.status}: redirecionamentos não são seguidos${destino ? ` (para ${destino})` : ''}; cadastre o endereço final.`,
    );
  }
  return `HTTP ${resposta.status}${resposta.statusText ? ` ${resposta.statusText}` : ''}`;
}

interface ErroComCausa {
  readonly name?: unknown;
  readonly message?: unknown;
  readonly code?: unknown;
  readonly cause?: unknown;
}

/**
 * Mensagem curta para erros de rede, tempo limite e TLS. Lê os campos do erro
 * em vez de usar `instanceof` (os erros do `fetch` podem vir de outro "realm",
 * como nos testes).
 */
export function descreverFalha(erro: unknown, prazoMs: number): string {
  if (typeof erro !== 'object' || erro === null) {
    return `Falha no envio: ${String(erro)}`;
  }
  const { name, message, cause } = erro as ErroComCausa;
  if (name === 'TimeoutError' || name === 'AbortError') {
    const prazo =
      prazoMs >= 1000 ? `${Math.round(prazoMs / 1000)} s` : `${prazoMs} ms`;
    return `Sem resposta em ${prazo} (tempo limite).`;
  }
  if (typeof cause === 'object' && cause !== null) {
    const { code, message: mensagemDaCausa } = cause as ErroComCausa;
    const codigo = typeof code === 'string' ? ` (${code})` : '';
    const detalhe =
      typeof mensagemDaCausa === 'string' ? `: ${mensagemDaCausa}` : '';
    return `Falha de conexão${codigo}${detalhe}`;
  }
  return `Falha no envio: ${typeof message === 'string' ? message : String(name)}`;
}

function limitar(texto: string): string {
  return texto.length > TAMANHO_MAXIMO_ERRO
    ? `${texto.slice(0, TAMANHO_MAXIMO_ERRO)}…`
    : texto;
}
