import {
  ESPERA_BASE_HTTP_MS,
  TENTATIVAS_HTTP,
  TIMEOUT_HTTP_MS,
} from './tresc-plus.constantes';
import { ErroTrescPlus, traduzirErroHttp } from './erros-tresc-plus';

type Metodo = 'GET' | 'POST' | 'PUT' | 'DELETE';

export interface OpcoesDoCliente {
  /** `https://3c.plus/api/v1` (configurável por empresa). */
  baseUrl: string;
  /** Token (`Authorization: Bearer`); sem ele só `authenticate` funciona. */
  token?: string;
  /** Troca o `fetch` (testes). */
  fetchImpl?: typeof fetch;
  tentativas?: number;
  esperaBaseMs?: number;
  timeoutMs?: number;
  /** Troca a espera (testes). */
  dormir?: (ms: number) => Promise<void>;
  /** Troca o sorteio do jitter (testes). */
  aleatorio?: () => number;
}

interface Pedido {
  query?: Record<string, string | number | boolean | undefined>;
  /** Corpo `application/x-www-form-urlencoded` (a maioria das rotas do 3C+). */
  form?: Record<string, string | number | boolean | undefined | null>;
  /** Corpo JSON (`mailing.json`). */
  json?: unknown;
  semToken?: boolean;
}

/** Espera do backoff exponencial com jitter de até 25%: `base * 2^tentativa`. Pura e testável. */
export function esperaDoBackoff(
  tentativa: number,
  baseMs: number,
  aleatorio: () => number = Math.random,
): number {
  return Math.round(baseMs * 2 ** tentativa * (1 + 0.25 * aleatorio()));
}

/** `Retry-After` em segundos → ms (até 10 s); `null` se ausente ou ilegível. */
export function esperaDoRetryAfter(cabecalho: string | null): number | null {
  if (!cabecalho) return null;
  const segundos = Number(cabecalho);
  if (!Number.isFinite(segundos) || segundos < 0) return null;
  return Math.min(segundos, 10) * 1000;
}

const dormirPadrao = (ms: number): Promise<void> =>
  new Promise((resolver) => setTimeout(resolver, ms));

/**
 * Cliente HTTP do 3C+ (R34.1/R34.5), só com o `fetch` do Node: Bearer, timeout, backoff em 429/5xx e
 * erros traduzidos para português (`ErroTrescPlus`). Só as leituras (GET) são repetidas em 5xx e em
 * falha de rede; um POST que pode já ter discado ou qualificado só é repetido no 429 (o 3C+ recusou
 * antes de agir). O token nunca entra em mensagem de erro nem em log.
 */
export class ClienteTrescPlus {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly tentativas: number;
  private readonly esperaBaseMs: number;
  private readonly timeoutMs: number;
  private readonly dormir: (ms: number) => Promise<void>;
  private readonly aleatorio: () => number;

  constructor(private readonly opcoes: OpcoesDoCliente) {
    this.base = opcoes.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = opcoes.fetchImpl ?? fetch;
    this.tentativas = opcoes.tentativas ?? TENTATIVAS_HTTP;
    this.esperaBaseMs = opcoes.esperaBaseMs ?? ESPERA_BASE_HTTP_MS;
    this.timeoutMs = opcoes.timeoutMs ?? TIMEOUT_HTTP_MS;
    this.dormir = opcoes.dormir ?? dormirPadrao;
    this.aleatorio = opcoes.aleatorio ?? Math.random;
  }

  // -------------------------------------------------------------------------
  // Rotas (referência §2–§9)
  // -------------------------------------------------------------------------

  /** `POST /authenticate`: o usuário (com `api_token`, `extension`, `id`). Não guarda a senha. */
  authenticate(usuario: string, senha: string): Promise<unknown> {
    return this.pedir('POST', '/authenticate', {
      form: { user: usuario, password: senha },
      semToken: true,
    });
  }
  me(): Promise<unknown> {
    return this.pedir('GET', '/me');
  }
  campanhas(): Promise<unknown> {
    return this.pedir('GET', '/campaigns');
  }
  campanha(id: number): Promise<unknown> {
    return this.pedir('GET', `/campaigns/${id}`);
  }
  campanhasDoAgente(): Promise<unknown> {
    return this.pedir('GET', '/agent/campaigns');
  }
  campanhaAtual(): Promise<unknown> {
    return this.pedir('GET', '/agent/loggedCampaign');
  }
  entrarNaCampanha(
    campanhaId: number,
    modo: 'dialer' | 'manual',
  ): Promise<unknown> {
    return this.pedir('POST', '/agent/login', {
      form: { campaign: campanhaId, mode: modo },
    });
  }
  sairDaCampanha(): Promise<unknown> {
    return this.pedir('POST', '/agent/logout');
  }
  conectarAgente(): Promise<unknown> {
    return this.pedir('POST', '/agent/connect');
  }
  pausas(): Promise<unknown> {
    return this.pedir('GET', '/agent/work_break_intervals');
  }
  entrarEmPausa(intervaloId: number): Promise<unknown> {
    return this.pedir('POST', `/agent/work_break/${intervaloId}/enter`);
  }
  sairDaPausa(): Promise<unknown> {
    return this.pedir('POST', '/agent/work_break/exit');
  }
  entrarNoModoManual(): Promise<unknown> {
    return this.pedir('POST', '/agent/manual_call/enter');
  }
  sairDoModoManual(): Promise<unknown> {
    return this.pedir('POST', '/agent/manual_call/exit');
  }
  discar(telefone: string): Promise<unknown> {
    return this.pedir('POST', '/agent/manual_call/dial', {
      form: { phone: telefone },
    });
  }
  desligar(chamadaId: string): Promise<unknown> {
    return this.pedir(
      'POST',
      `/agent/call/${encodeURIComponent(chamadaId)}/hangup`,
    );
  }
  qualificar(
    chamadaId: string,
    dados: {
      qualificacaoId: number;
      observacao?: string;
      telefone?: string;
      data?: string;
    },
  ): Promise<unknown> {
    return this.pedir(
      'POST',
      `/agent/call/${encodeURIComponent(chamadaId)}/qualify`,
      {
        form: {
          qualification_id: dados.qualificacaoId,
          qualification_note: dados.observacao,
          phone: dados.telefone,
          date: dados.data,
        },
      },
    );
  }
  qualificacoes(): Promise<unknown> {
    return this.pedir('GET', '/qualifications');
  }
  chamadas(consulta: {
    inicio: string;
    fim?: string;
    pagina?: number;
    porPagina?: number;
  }): Promise<unknown> {
    return this.pedir('GET', '/calls', {
      query: {
        per_page: consulta.porPagina ?? 100,
        page: consulta.pagina,
        start_date: consulta.inicio,
        end_date: consulta.fim,
        with_mailing: 'false',
      },
    });
  }
  listas(campanhaId: number): Promise<unknown> {
    return this.pedir('GET', `/campaigns/${campanhaId}/lists`);
  }
  criarLista(campanhaId: number, nome: string): Promise<unknown> {
    return this.pedir('POST', `/campaigns/${campanhaId}/lists`, {
      form: { name: nome },
    });
  }
  enviarMailing(
    campanhaId: number,
    listaId: number,
    registros: Array<{
      phone: string;
      identifier?: string;
      data?: Record<string, unknown>;
    }>,
  ): Promise<unknown> {
    return this.pedir(
      'POST',
      `/campaigns/${campanhaId}/lists/${listaId}/mailing.json`,
      { query: { return_data: 'true' }, json: registros },
    );
  }

  /** `GET /calls/{id}/recording`: o áudio (corpo em streaming) ou `null` se não existe. */
  async gravacao(chamadaId: string): Promise<{
    corpo: ReadableStream<Uint8Array>;
    mime: string;
    tamanho: number | null;
  } | null> {
    const resposta = await this.executar(
      'GET',
      `/calls/${encodeURIComponent(chamadaId)}/recording`,
      {},
      true,
    );
    if (resposta.status === 404 || resposta.status === 204) {
      await resposta.body?.cancel().catch(() => undefined);
      return null;
    }
    if (!resposta.body) return null;
    const tamanho = Number(resposta.headers.get('content-length'));
    return {
      corpo: resposta.body,
      mime: (resposta.headers.get('content-type') ?? 'audio/mpeg')
        .split(';')[0]
        .trim(),
      tamanho: Number.isFinite(tamanho) && tamanho > 0 ? tamanho : null,
    };
  }

  // -------------------------------------------------------------------------
  // Transporte
  // -------------------------------------------------------------------------

  private async pedir(
    metodo: Metodo,
    caminho: string,
    pedido: Pedido = {},
  ): Promise<unknown> {
    const resposta = await this.executar(metodo, caminho, pedido, false);
    if (resposta.status === 204) return null;
    const tipo = resposta.headers.get('content-type') ?? '';
    const texto = await resposta.text();
    if (texto === '') return null;
    if (tipo.includes('json') || /^[[{]/.test(texto.trimStart())) {
      try {
        return JSON.parse(texto) as unknown;
      } catch {
        return texto;
      }
    }
    return texto;
  }

  /**
   * Faz a chamada com timeout e backoff. `crua` devolve a `Response` mesmo em 404/204 (gravação); os
   * demais status de erro viram `ErroTrescPlus`.
   */
  private async executar(
    metodo: Metodo,
    caminho: string,
    pedido: Pedido,
    crua: boolean,
  ): Promise<Response> {
    const url = new URL(this.base + caminho);
    for (const [chave, valor] of Object.entries(pedido.query ?? {})) {
      if (valor !== undefined) url.searchParams.set(chave, String(valor));
    }
    const cabecalhos: Record<string, string> = { Accept: 'application/json' };
    if (!pedido.semToken && this.opcoes.token) {
      cabecalhos.Authorization = `Bearer ${this.opcoes.token}`;
    }
    let corpo: string | undefined;
    if (pedido.json !== undefined) {
      cabecalhos['Content-Type'] = 'application/json';
      corpo = JSON.stringify(pedido.json);
    } else if (pedido.form) {
      cabecalhos['Content-Type'] = 'application/x-www-form-urlencoded';
      const parametros = new URLSearchParams();
      for (const [chave, valor] of Object.entries(pedido.form)) {
        if (valor !== undefined && valor !== null && valor !== '') {
          parametros.set(chave, String(valor));
        }
      }
      corpo = parametros.toString();
    }
    const leitura = metodo === 'GET';
    for (let tentativa = 0; ; tentativa += 1) {
      const ultima = tentativa >= this.tentativas - 1;
      let resposta: Response;
      try {
        resposta = await this.fetchImpl(url, {
          method: metodo,
          headers: cabecalhos,
          body: corpo,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (erro) {
        if (leitura && !ultima) {
          await this.dormir(
            esperaDoBackoff(tentativa, this.esperaBaseMs, this.aleatorio),
          );
          continue;
        }
        const tempo = erro instanceof Error && erro.name === 'TimeoutError';
        throw new ErroTrescPlus(
          'rede',
          tempo
            ? 'O 3C+ demorou demais para responder. Tente de novo.'
            : 'Não foi possível falar com o 3C+. Confira o endereço da API e a conexão.',
          0,
        );
      }
      if (
        resposta.ok ||
        (crua && (resposta.status === 404 || resposta.status === 204))
      ) {
        return resposta;
      }
      const repetir =
        !ultima &&
        (resposta.status === 429 ||
          (leitura && [500, 502, 503, 504].includes(resposta.status)));
      if (repetir) {
        const espera =
          esperaDoRetryAfter(resposta.headers.get('retry-after')) ??
          esperaDoBackoff(tentativa, this.esperaBaseMs, this.aleatorio);
        await resposta.body?.cancel().catch(() => undefined);
        await this.dormir(espera);
        continue;
      }
      const texto = await resposta.text().catch(() => '');
      let conteudo: unknown = texto;
      try {
        conteudo = JSON.parse(texto);
      } catch {
        // texto puro
      }
      throw traduzirErroHttp(resposta.status, conteudo);
    }
  }
}

// ---------------------------------------------------------------------------
// Leitura tolerante das respostas (o formato real é lacuna da referência §11)
// ---------------------------------------------------------------------------

const objeto = (valor: unknown): Record<string, unknown> | null =>
  valor !== null && typeof valor === 'object' && !Array.isArray(valor)
    ? (valor as Record<string, unknown>)
    : null;

/** `{data: X}` → `X`; senão o próprio valor. */
export function desembrulhar(valor: unknown): unknown {
  const o = objeto(valor);
  return o && 'data' in o && o.data !== undefined ? o.data : valor;
}

/** Lista de uma resposta (`[...]`, `{data:[...]}` ou `{data:{data:[...]}}`). */
export function listaDe(valor: unknown): unknown[] {
  const interno = desembrulhar(valor);
  if (Array.isArray(interno)) return interno;
  const o = objeto(interno);
  if (o && Array.isArray(o.data)) return o.data;
  return [];
}

export function numeroDe(valor: unknown): number | null {
  const n = typeof valor === 'string' ? Number(valor) : valor;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

export function textoDe(valor: unknown): string | null {
  return typeof valor === 'string' && valor.trim() !== ''
    ? valor.trim()
    : typeof valor === 'number'
      ? String(valor)
      : null;
}

export { objeto as comoObjeto };
