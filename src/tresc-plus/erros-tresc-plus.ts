import {
  ErroApi,
  RegraVioladaException,
  ServicoIndisponivelException,
} from '../comum/erros/excecoes';
import { REGRA_TRESC_PLUS } from './tresc-plus.constantes';

export type CodigoDeErroTrescPlus =
  | 'token_invalido'
  | 'sem_permissao'
  | 'nao_encontrado'
  | 'agente_nao_ocioso'
  | 'sem_campanha'
  | 'dados_recusados'
  | 'limite'
  | 'indisponivel'
  | 'rede';

/** Erro de uma chamada ao 3C+, já com a mensagem em português para quem usa o CRM. */
export class ErroTrescPlus extends Error {
  constructor(
    readonly codigo: CodigoDeErroTrescPlus,
    mensagem: string,
    /** Status HTTP do 3C+ (0 = sem resposta: rede, tempo esgotado). */
    readonly status: number,
    /** Trecho da resposta do 3C+ (só texto curto, nunca o token). */
    readonly detalhe?: string,
  ) {
    super(mensagem);
    this.name = 'ErroTrescPlus';
  }

  /** O erro que a API do CRM devolve: nunca 401 (o front deslogaria a pessoa) e nunca o corpo cru. */
  paraErroApi(): ErroApi {
    const detalhes = { regra: REGRA_TRESC_PLUS, motivo: this.codigo };
    if (this.codigo === 'indisponivel' || this.codigo === 'rede') {
      return new ServicoIndisponivelException(this.message, detalhes);
    }
    return new RegraVioladaException(REGRA_TRESC_PLUS, this.message, {
      motivo: this.codigo,
    });
  }
}

/** Texto curto da mensagem de erro que o 3C+ devolveu (Laravel: `message`, `error`, `errors`). */
export function mensagemDoCorpo(corpo: unknown): string {
  if (typeof corpo === 'string') return corpo.slice(0, 300);
  if (corpo === null || typeof corpo !== 'object') return '';
  const objeto = corpo as Record<string, unknown>;
  for (const chave of ['message', 'error', 'detail', 'mensagem']) {
    const valor = objeto[chave];
    if (typeof valor === 'string' && valor.trim()) return valor.slice(0, 300);
  }
  const erros = objeto.errors;
  if (erros && typeof erros === 'object') {
    const primeiro = Object.values(erros as Record<string, unknown>)[0];
    const texto = Array.isArray(primeiro) ? primeiro[0] : primeiro;
    if (typeof texto === 'string') return texto.slice(0, 300);
  }
  return '';
}

/** Traduz a resposta de erro do 3C+ para uma mensagem clara (R34.5). */
export function traduzirErroHttp(
  status: number,
  corpo: unknown,
): ErroTrescPlus {
  const original = mensagemDoCorpo(corpo);
  const texto = original.toLowerCase();
  if (status === 401) {
    return new ErroTrescPlus(
      'token_invalido',
      'O 3C+ não aceitou o token. Confira o token da empresa ou conecte-se de novo ao 3C+.',
      status,
      original,
    );
  }
  if (status === 403) {
    return new ErroTrescPlus(
      'sem_permissao',
      'O 3C+ recusou: este usuário não tem permissão para esta ação (algumas exigem perfil de gestor).',
      status,
      original,
    );
  }
  if (status === 404) {
    return new ErroTrescPlus(
      'nao_encontrado',
      'O 3C+ não encontrou o que foi pedido (campanha, lista ou ligação).',
      status,
      original,
    );
  }
  if (status === 429) {
    return new ErroTrescPlus(
      'limite',
      'O 3C+ pediu para aguardar um pouco: muitas requisições. Tente de novo em instantes.',
      status,
      original,
    );
  }
  if (status >= 500) {
    return new ErroTrescPlus(
      'indisponivel',
      'O 3C+ está indisponível no momento. Tente de novo em instantes.',
      status,
      original,
    );
  }
  if (/idle|ocios|dispon[ií]vel|not available|n[aã]o est[aá]/.test(texto)) {
    return new ErroTrescPlus(
      'agente_nao_ocioso',
      'Você não está ocioso no 3C+: termine a ligação em curso, saia da pausa ou do pós-atendimento e tente de novo.',
      status,
      original,
    );
  }
  if (/campaign|campanha/.test(texto)) {
    return new ErroTrescPlus(
      'sem_campanha',
      'Entre em uma campanha do 3C+ antes de ligar.',
      status,
      original,
    );
  }
  return new ErroTrescPlus(
    'dados_recusados',
    original
      ? `O 3C+ não aceitou o pedido: ${original}`
      : 'O 3C+ não aceitou o pedido.',
    status,
    original,
  );
}
