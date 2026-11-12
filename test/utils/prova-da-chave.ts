import { createHmac } from 'node:crypto';

/**
 * Conferência do `appsecret_proof` para as Graphs falsas dos testes (R14.10).
 * Faz o papel do app da Meta com "Exigir chave secreta do aplicativo" ligado:
 * toda chamada com token de acesso precisa trazer `appsecret_proof` = HMAC-SHA256
 * (hex) do token com a chave secreta do app que o emitiu; faltando ou errada, a
 * resposta é a de verdade (HTTP 400, código 100, `GraphMethodException`).
 *
 * O cálculo aqui é independente do código da API (só `node:crypto`).
 */
export class ConferenciaDeProva {
  /** Ligada por padrão nos e2e de Meta; `false` volta ao comportamento antigo. */
  exigir = true;
  /** Chave secreta por token (vence a padrão). */
  readonly segredoPorToken = new Map<string, string>();
  /** Quantas chamadas com token passaram pela conferência e foram aceitas. */
  aceitas = 0;
  /** Como `aceitas`, mas não zera em `limpar` (conferência final da suíte). */
  totalAceitas = 0;
  /** Os motivos das recusas (`ausente`/`errada`) com o caminho, sem tokens nem provas. */
  recusadas: string[] = [];

  constructor(private readonly segredoPadrao: string) {}

  limpar(): void {
    this.aceitas = 0;
    this.recusadas = [];
    this.segredoPorToken.clear();
  }

  /** `null` se a chamada pode seguir; senão a resposta de erro da Meta. */
  conferir(
    url: URL,
    token: string,
  ): { status: number; erro: Record<string, unknown> } | null {
    if (!this.exigir) {
      return null;
    }
    const enviada = url.searchParams.get('appsecret_proof');
    const segredo = this.segredoPorToken.get(token) ?? this.segredoPadrao;
    const esperada = createHmac('sha256', segredo).update(token).digest('hex');
    if (enviada === esperada) {
      this.aceitas++;
      this.totalAceitas++;
      return null;
    }
    this.recusadas.push(`${enviada ? 'errada' : 'ausente'} ${url.pathname}`);
    return {
      status: 400,
      erro: {
        message: enviada
          ? 'Invalid appsecret_proof provided in the API argument'
          : 'API calls from the server require an appsecret_proof argument',
        type: 'GraphMethodException',
        code: 100,
      },
    };
  }
}

/** HMAC-SHA256 hex do token com a chave (para os testes calcularem o esperado). */
export function provaEsperada(token: string, segredo: string): string {
  return createHmac('sha256', segredo).update(token).digest('hex');
}

/**
 * O caminho do pedido (com a query) sem o `appsecret_proof`: o registro dos
 * falsos guarda o que foi chamado, e a prova já é conferida por `ConferenciaDeProva`.
 */
export function caminhoSemProva(url: URL): string {
  const consulta = url.search
    .replace(/([?&])appsecret_proof=[^&]*&?/, '$1')
    .replace(/[?&]$/, '');
  return `${url.pathname}${consulta}`;
}
