import { Inject, Injectable, Logger } from '@nestjs/common';
import { AMBIENTE, type Ambiente } from '../../config/ambiente';
import {
  type AcessoMeta,
  semChaveSecreta,
  tokenDe,
  urlComProva,
} from '../../comum/meta/prova-da-chave';

/** Prazo de uma chamada à Graph API. */
const PRAZO_MS = 15_000;
/** Redirecionamentos seguidos no download de um anexo (a CDN da Meta redireciona). */
const MAXIMO_DE_REDIRECIONAMENTOS = 5;
/** Intervalo mínimo entre dois avisos de "chamada sem chave secreta". */
const INTERVALO_DO_AVISO_MS = 10 * 60_000;

/** O corpo da resposta, parando (413) se passar do limite. */
async function lerAte(
  resposta: Response,
  limiteBytes: number,
): Promise<Buffer> {
  const partes: Uint8Array[] = [];
  let total = 0;
  if (!resposta.body) {
    return Buffer.alloc(0);
  }
  for await (const parte of resposta.body as AsyncIterable<Uint8Array>) {
    total += parte.byteLength;
    if (total > limiteBytes) {
      // Sair do laço cancela o resto do download.
      throw new ErroDaGraph('Anexo grande demais.', 413, null, null);
    }
    partes.push(parte);
  }
  return Buffer.concat(partes);
}

/** Erro da Graph API (`{ error: { message, type, code, error_subcode } }`). */
export class ErroDaGraph extends Error {
  constructor(
    mensagem: string,
    readonly status: number,
    readonly codigo: number | null,
    readonly subcodigo: number | null,
  ) {
    super(mensagem);
    this.name = 'ErroDaGraph';
  }

  /** Mensagem fora da janela de 24 h (R14). */
  get foraDaJanela(): boolean {
    return (
      this.subcodigo === 2018278 ||
      this.subcodigo === 2534022 ||
      (this.codigo === 10 && /window|janela/i.test(this.message))
    );
  }

  /** Token de página inválido ou expirado. */
  get tokenInvalido(): boolean {
    return (
      this.codigo === 190 ||
      this.codigo === 102 ||
      this.codigo === 463 ||
      this.codigo === 467
    );
  }

  /** Tentar de novo depois adianta (limite de chamadas, instabilidade da Meta). */
  get passageiro(): boolean {
    return (
      this.status === 0 ||
      this.status >= 500 ||
      [1, 2, 4, 17, 32, 341, 613].includes(this.codigo ?? -1)
    );
  }
}

/** Resposta do envio (`POST /me/messages`). */
export interface RespostaDoEnvio {
  recipient_id?: string;
  message_id?: string;
}

/**
 * Cliente da Graph API da Meta (Instagram e Messenger, R14). O endereço vem
 * de `META_GRAPH_URL` (a Graph de verdade em produção; a falsa do ambiente dos
 * agentes e a dos testes) e a versão de `META_GRAPH_VERSAO`. O token vai no
 * cabeçalho `Authorization` (nunca na URL). Com a chave secreta do app que
 * emitiu o token (`AcessoMeta`), toda chamada leva também `appsecret_proof`
 * na query (R14.10); sem ela a chamada segue sem a prova e registra um aviso.
 */
@Injectable()
export class GraphApi {
  private readonly logger = new Logger(GraphApi.name);
  private ultimoAviso = 0;

  constructor(@Inject(AMBIENTE) private readonly ambiente: Ambiente) {}

  /** Envia uma mensagem (texto ou anexo) a um PSID/IGSID. */
  enviarMensagem(
    token: AcessoMeta,
    destinatario: string,
    mensagem: Record<string, unknown>,
  ): Promise<RespostaDoEnvio> {
    return this.pedir<RespostaDoEnvio>('POST', 'me/messages', token, {
      recipient: { id: destinatario },
      messaging_type: 'RESPONSE',
      message: mensagem,
    });
  }

  /** Um objeto da Graph (perfil do contato, página, conta do Instagram). */
  obter<T = Record<string, unknown>>(
    token: AcessoMeta,
    id: string,
    campos: readonly string[],
  ): Promise<T> {
    return this.pedir<T>(
      'GET',
      `${encodeURIComponent(id)}?fields=${campos.map(encodeURIComponent).join(',')}`,
      token,
    );
  }

  /** `POST /<caminho>` com corpo JSON (WhatsApp oficial: mensagens). */
  postar<T = Record<string, unknown>>(
    token: AcessoMeta,
    caminho: string,
    corpo: unknown,
  ): Promise<T> {
    return this.pedir<T>('POST', caminho, token, corpo);
  }

  /** `POST /<caminho>` multipart (WhatsApp oficial: upload de mídia). */
  postarArquivo<T = Record<string, unknown>>(
    token: AcessoMeta,
    caminho: string,
    formulario: FormData,
  ): Promise<T> {
    return this.pedir<T>('POST', caminho, token, formulario);
  }

  /** `GET /<caminho>` (com a query já no caminho). */
  consultar<T = Record<string, unknown>>(
    token: AcessoMeta,
    caminho: string,
  ): Promise<T> {
    return this.pedir<T>('GET', caminho, token);
  }

  /**
   * Baixa um anexo recebido (a URL da CDN da Meta), com limite de tamanho.
   * Só HTTPS (ou o próprio endereço da Graph configurada, como a falsa dos
   * testes), também em cada redirecionamento, e lendo no máximo o limite.
   * Com `token`, vai como `Authorization: Bearer` (a mídia do WhatsApp exige) —
   * só enquanto o endereço é do mesmo domínio do pedido original.
   */
  async baixar(
    url: string,
    limiteBytes: number,
    token?: string,
  ): Promise<{ conteudo: Buffer; mime: string | null }> {
    let endereco = url;
    for (let saltos = 0; ; saltos++) {
      if (!this.podeBaixarDe(endereco)) {
        throw new ErroDaGraph('Endereço do anexo recusado.', 400, null, null);
      }
      const resposta = await fetch(endereco, {
        redirect: 'manual',
        signal: AbortSignal.timeout(30_000),
        ...(token && new URL(endereco).origin === new URL(url).origin
          ? { headers: { Authorization: `Bearer ${token}` } }
          : {}),
      });
      const destino = resposta.headers.get('location');
      if (resposta.status >= 300 && resposta.status < 400 && destino) {
        await resposta.body?.cancel();
        if (saltos >= MAXIMO_DE_REDIRECIONAMENTOS) {
          throw new ErroDaGraph('Redirecionamentos demais.', 508, null, null);
        }
        endereco = new URL(destino, endereco).toString();
        continue;
      }
      if (!resposta.ok) {
        await resposta.body?.cancel();
        throw new ErroDaGraph(
          `Download do anexo respondeu ${resposta.status}.`,
          resposta.status,
          null,
          null,
        );
      }
      const declarado = Number(resposta.headers.get('content-length') ?? 0);
      if (declarado > limiteBytes) {
        await resposta.body?.cancel();
        throw new ErroDaGraph('Anexo grande demais.', 413, null, null);
      }
      return {
        conteudo: await lerAte(resposta, limiteBytes),
        mime: resposta.headers.get('content-type'),
      };
    }
  }

  private podeBaixarDe(endereco: string): boolean {
    if (!URL.canParse(endereco)) {
      return false;
    }
    const url = new URL(endereco);
    return (
      !url.username &&
      !url.password &&
      (url.protocol === 'https:' ||
        url.origin === new URL(this.ambiente.meta.graphUrl).origin)
    );
  }

  /** Aviso (sem dados sensíveis, no máximo um a cada 10 minutos) de chamada sem a prova. */
  private avisarSeSemChave(acesso: AcessoMeta): void {
    const agora = Date.now();
    if (
      !semChaveSecreta(acesso) ||
      agora - this.ultimoAviso < INTERVALO_DO_AVISO_MS
    ) {
      return;
    }
    this.ultimoAviso = agora;
    this.logger.warn(
      'Chamada à Graph API sem a chave secreta do app (appsecret_proof): com "Exigir chave secreta do aplicativo" ligado na Meta, uma conexão sem a chave deixa de funcionar.',
    );
  }

  private async pedir<T>(
    metodo: 'GET' | 'POST',
    caminho: string,
    acesso: AcessoMeta,
    corpo?: unknown,
  ): Promise<T> {
    const token = tokenDe(acesso);
    const url = urlComProva(
      `${this.ambiente.meta.graphUrl}/${this.ambiente.meta.graphVersao}/${caminho}`,
      acesso,
    );
    this.avisarSeSemChave(acesso);
    let resposta: Response;
    try {
      const pedido: RequestInit =
        metodo === 'POST'
          ? corpo instanceof FormData
            ? {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}` },
                body: corpo,
              }
            : {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${token}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify(corpo ?? {}),
              }
          : { method: 'GET', headers: { Authorization: `Bearer ${token}` } };
      resposta = await fetch(url, {
        ...pedido,
        signal: AbortSignal.timeout(PRAZO_MS),
      });
    } catch (erro) {
      throw new ErroDaGraph(
        `Sem resposta da Graph API da Meta (${erro instanceof Error ? erro.message : String(erro)}).`,
        0,
        null,
        null,
      );
    }
    const dados = (await resposta.json().catch(() => ({}))) as {
      error?: { message?: string; code?: number; error_subcode?: number };
    } & T;
    if (!resposta.ok || dados.error) {
      throw new ErroDaGraph(
        dados.error?.message ?? `A Graph API respondeu ${resposta.status}.`,
        resposta.status,
        dados.error?.code ?? null,
        dados.error?.error_subcode ?? null,
      );
    }
    return dados;
  }
}
