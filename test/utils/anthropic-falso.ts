/**
 * Cliente falso da Anthropic (R21) para os testes: implementa o
 * `ClienteAnthropic` com eventos de streaming iguais aos do SDK
 * (`message_start`, blocos de raciocínio e de texto, `message_delta`…),
 * guarda os parâmetros de cada chamada e segue um roteiro por chamada
 * (resposta, erro no início, erro no meio, travar até o tempo esgotar).
 * Sem roteiro, responde uma análise plausível montada com os números recebidos.
 */
import Anthropic from '@anthropic-ai/sdk';
import type {
  ClienteAnthropic,
  EventoDoFluxo,
  FluxoDeMensagem,
  MensagemFinal,
  ParametrosDoFluxo,
} from '../../src/bi/analise/cliente-anthropic';

export interface UsoFalso {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

export type RoteiroFalso =
  | {
      tipo: 'resposta';
      /** Objeto (vira JSON) ou o texto cru da resposta. */
      corpo?: unknown;
      stopReason?: 'end_turn' | 'max_tokens' | 'refusal';
      uso?: Partial<UsoFalso>;
    }
  /** Falha antes do primeiro evento (ex.: 401, 529). */
  | { tipo: 'erro'; erro: Error }
  /** Manda o começo do texto e falha no meio do streaming. */
  | { tipo: 'erro_no_meio'; erro: Error }
  /** Não termina nunca: só sai pelo `signal` (tempo esgotado ou cancelamento). */
  | { tipo: 'travar' };

export const USO_PADRAO: UsoFalso = {
  input_tokens: 1200,
  output_tokens: 450,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 900,
};

/** Erros do SDK com o status dado (o mesmo `APIError.generate` que o SDK usa). */
export function erroDaApi(status: number, mensagem = 'erro falso'): Error {
  return Anthropic.APIError.generate(
    status,
    { type: 'error', error: { type: 'api_error', message: mensagem } },
    mensagem,
    new Headers(),
  );
}

interface EntradaLida {
  painel?: string;
  indicadores?: {
    chave: string;
    rotulo: string;
    valor: number | null;
    variacao: number | null;
  }[];
  tabelas?: { chave: string; colunas: string[]; linhas: unknown[][] }[];
}

/** A entrada (JSON) da primeira mensagem do usuário. */
export function entradaDaChamada(parametros: ParametrosDoFluxo): EntradaLida {
  const primeira = parametros.messages[0];
  const conteudo = primeira.content ?? '';
  const texto =
    typeof conteudo === 'string'
      ? conteudo
      : conteudo.map((b) => (b.type === 'text' ? b.text : '')).join('');
  const inicio = texto.indexOf('{');
  return inicio >= 0 ? (JSON.parse(texto.slice(inicio)) as EntradaLida) : {};
}

/** Análise plausível a partir dos números (e um link com o primeiro id de etapa, se houver). */
export function respostaPlausivel(parametros: ParametrosDoFluxo): unknown {
  const entrada = entradaDaChamada(parametros);
  const painel = entrada.painel ?? 'comercial';
  const indicadores = (entrada.indicadores ?? []).filter(
    (i) => i.valor !== null,
  );
  const comVariacao = indicadores
    .filter((i) => i.variacao !== null)
    .sort((a, b) => Math.abs(b.variacao ?? 0) - Math.abs(a.variacao ?? 0));
  let link = `/bi/${painel}`;
  for (const tabela of entrada.tabelas ?? []) {
    const indice = tabela.colunas.indexOf('etapaId:id');
    const id = indice >= 0 ? tabela.linhas[0]?.[indice] : undefined;
    if (typeof id === 'string') {
      link = `/funis/${painel === 'cs' ? 'cs' : 'comercial'}?etapaId=${id}`;
      break;
    }
  }
  const ultima = parametros.messages.at(-1);
  const pergunta =
    parametros.messages.length > 1 && typeof ultima?.content === 'string'
      ? ultima.content
      : null;
  return {
    resumo: pergunta
      ? `Resposta à ${pergunta.slice(0, 60)}`
      : `No período, ${indicadores[0]?.rotulo ?? 'o painel'} ficou em ${indicadores[0]?.valor ?? 0}.`,
    destaques: comVariacao.slice(0, 2).map((i) => ({
      titulo: i.rotulo,
      detalhe: `${i.rotulo}: ${i.valor} (${i.variacao}% sobre o período anterior).`,
      tendencia: (i.variacao ?? 0) >= 0 ? 'positiva' : 'negativa',
    })),
    riscos: [
      {
        titulo: 'Poucos dados',
        detalhe: 'Alguns indicadores têm base pequena.',
        gravidade: 'baixa',
      },
    ],
    acoes: [
      {
        titulo: 'Revisar a etapa com mais negócios',
        detalhe: 'Abra a lista e priorize os mais antigos.',
        prioridade: 'alta',
        link,
        rotuloLink: 'Ver a lista',
      },
    ],
  };
}

class FluxoFalso implements FluxoDeMensagem {
  private final: MensagemFinal | null = null;
  private erro: unknown = null;
  private consumido = false;

  constructor(
    private readonly roteiro: RoteiroFalso,
    private readonly parametros: ParametrosDoFluxo,
    private readonly sinal: AbortSignal,
    private readonly atrasoMs: number,
  ) {}

  abort(): void {
    /* o `signal` já cuida */
  }

  async finalMessage(): Promise<MensagemFinal> {
    if (!this.consumido) {
      for await (const _ of this) {
        /* consome */
      }
    }
    if (this.erro) {
      throw this.erro;
    }
    return this.final as MensagemFinal;
  }

  private async pausa(): Promise<void> {
    await new Promise((r) => setTimeout(r, this.atrasoMs));
    if (this.sinal.aborted) {
      throw new Anthropic.APIUserAbortError();
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<EventoDoFluxo> {
    this.consumido = true;
    try {
      yield* this.gerar();
    } catch (erro) {
      this.erro = erro;
      throw erro;
    }
  }

  private async *gerar(): AsyncGenerator<EventoDoFluxo> {
    const r = this.roteiro;
    if (this.sinal.aborted) {
      throw new Anthropic.APIUserAbortError();
    }
    if (r.tipo === 'erro') {
      throw r.erro;
    }
    if (r.tipo === 'travar') {
      await new Promise<void>((resolver) => {
        if (this.sinal.aborted) {
          resolver();
        }
        this.sinal.addEventListener('abort', () => resolver(), { once: true });
      });
      throw new Anthropic.APIUserAbortError();
    }
    const uso = {
      ...USO_PADRAO,
      ...(r.tipo === 'resposta' ? r.uso : {}),
    };
    const corpo =
      r.tipo === 'resposta' && r.corpo !== undefined
        ? r.corpo
        : respostaPlausivel(this.parametros);
    const texto = typeof corpo === 'string' ? corpo : JSON.stringify(corpo);
    const mensagem = {
      id: 'msg_falsa',
      type: 'message',
      role: 'assistant',
      model: this.parametros.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { ...uso, output_tokens: 1 },
    } as unknown as MensagemFinal;
    yield { type: 'message_start', message: mensagem } as EventoDoFluxo;
    await this.pausa();
    yield {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '', signature: '' },
    } as EventoDoFluxo;
    yield { type: 'content_block_stop', index: 0 } as EventoDoFluxo;
    yield {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'text', text: '', citations: null },
    } as EventoDoFluxo;
    const pedacos = 6;
    const tamanho = Math.ceil(texto.length / pedacos);
    for (let i = 0; i < pedacos; i++) {
      if (r.tipo === 'erro_no_meio' && i === 2) {
        throw r.erro;
      }
      await this.pausa();
      yield {
        type: 'content_block_delta',
        index: 1,
        delta: {
          type: 'text_delta',
          text: texto.slice(i * tamanho, (i + 1) * tamanho),
        },
      } as EventoDoFluxo;
    }
    yield { type: 'content_block_stop', index: 1 } as EventoDoFluxo;
    const stopReason =
      r.tipo === 'resposta' ? (r.stopReason ?? 'end_turn') : 'end_turn';
    yield {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { ...uso },
    } as unknown as EventoDoFluxo;
    yield { type: 'message_stop' } as EventoDoFluxo;
    this.final = {
      ...mensagem,
      content: [
        { type: 'thinking', thinking: '', signature: 'assinatura' },
        { type: 'text', text: texto, citations: null },
      ],
      stop_reason: stopReason,
      usage: { ...mensagem.usage, ...uso },
    } as unknown as MensagemFinal;
  }
}

export class ClienteAnthropicFalso implements ClienteAnthropic {
  /** Parâmetros de cada chamada, na ordem. */
  readonly chamadas: ParametrosDoFluxo[] = [];
  private readonly roteiros: RoteiroFalso[] = [];
  /** Pausa entre os eventos (deixa o streaming observável). */
  atrasoMs = 2;

  /** Próximas chamadas seguem estes roteiros; depois, a resposta plausível. */
  enfileirar(...roteiros: RoteiroFalso[]): void {
    this.roteiros.push(...roteiros);
  }

  limpar(): void {
    this.chamadas.length = 0;
    this.roteiros.length = 0;
    this.atrasoMs = 2;
  }

  transmitir(
    parametros: ParametrosDoFluxo,
    opcoes: { signal: AbortSignal; timeout: number },
  ): FluxoDeMensagem {
    this.chamadas.push(structuredClone(parametros));
    const roteiro = this.roteiros.shift() ?? { tipo: 'resposta' };
    return new FluxoFalso(roteiro, parametros, opcoes.signal, this.atrasoMs);
  }
}
