/**
 * Estrutura dos aplicativos das integrações de entrada (R32.1): cada aplicativo é
 * um adaptador que sabe (1) transformar o corpo recebido em itens com caminhos
 * reconhecíveis, (2) verificar a autenticidade, (3) oferecer um modelo de
 * mapeamento pronto, (4) explicar o passo a passo do lado da ferramenta e,
 * quando há credencial, (5) testá-la e buscar os campos do aplicativo.
 *
 * Tudo aqui é puro (sem banco): o processamento (`ProcessamentoEntradaService`)
 * e as rotas usam os adaptadores pelo registro (`registro.ts`).
 */
import type { IncomingHttpHeaders } from 'node:http';
import type { AplicativoIntegracao } from '../../generated/prisma/client';
import type { Mapeamento } from '../entrada/mapeamento';

/** Um item do corpo (ex.: cada lead do RD Station). `corpo` é o que o mapeamento enxerga. */
export interface ItemRecebido {
  readonly corpo: unknown;
  /** Descrição curta para as mensagens (`lead 2 de 3`), ou `null` quando o corpo tem um item só. */
  readonly rotulo: string | null;
  /** Chave de idempotência do evento (H2: plataformas de curso), quando o aplicativo define uma. */
  readonly chaveDoEvento?: string | null;
  /** Plataformas de curso (R32.20): o código do evento (`PURCHASE_APPROVED`, `order_approved`, `myeduzz.invoice_paid`…). */
  readonly evento?: string | null;
  /** Plataformas de curso: os produtos do evento (para o filtro por produto). */
  readonly produtos?: readonly ProdutoDoItem[];
}

export interface ProdutoDoItem {
  readonly id: string | null;
  readonly nome: string | null;
}

export interface EntradaDeAutenticidade {
  readonly cabecalhos: IncomingHttpHeaders;
  /** Parâmetros da URL (a Kiwify assina pela query string, H2). */
  readonly query: Readonly<Record<string, unknown>>;
  readonly corpoBruto: Buffer;
  /** O segredo decifrado, ou `null` se a integração não tem. */
  readonly segredo: string | null;
  readonly configuracao: Readonly<Record<string, unknown>>;
}

export type ResultadoDeAutenticidade =
  { readonly ok: true } | { readonly ok: false; readonly mensagem: string };

/** Como o aplicativo trata o segredo da integração (`segredoCifrado`). */
export type ModoDoSegredo =
  'NAO_USA' | 'OPCIONAL' | 'GERADO_PELO_CRM' | 'OBRIGATORIO';

/** O que a tabela de eventos faz com um evento (plataformas de curso, R32.20). */
export type AcaoDoEvento =
  'IGNORAR' | 'ABRIR' | 'GANHO' | 'PERDIDO' | 'ETIQUETAR';

export interface RegraDoEvento {
  readonly acao: AcaoDoEvento;
  /** `ABRIR`: etapa aberta do funil da integração (sem ela, a etapa inicial). */
  readonly etapaId?: string | null;
  /** `PERDIDO`: o motivo da perda (R5.5); sem ele, vale o motivo padrão da integração. */
  readonly motivoPerda?: string | null;
  /** Etiquetas somadas ao contato (qualquer ação, menos `IGNORAR`). */
  readonly etiquetas: readonly string[];
}

export type GrupoDeEvento =
  'COMPRA' | 'PAGAMENTO_PENDENTE' | 'CARRINHO' | 'POS_VENDA' | 'ASSINATURA';

export interface DefinicaoDeEvento {
  /** O código que a plataforma envia (chave da tabela). */
  readonly codigo: string;
  /** Nome amigável para a tela. */
  readonly nome: string;
  readonly descricao: string;
  readonly grupo: GrupoDeEvento;
  /** O que a integração faz com ele sem configuração (o modelo `VENDAS`). */
  readonly padrao: RegraDoEvento;
}

export interface ModeloDeEventos {
  readonly codigo: string;
  readonly nome: string;
  readonly descricao: string;
  /** Uma regra por evento (os que faltam valem `IGNORAR`). */
  readonly regras: Readonly<Record<string, RegraDoEvento>>;
}

/** A tabela de eventos de uma plataforma de curso: eventos conhecidos, modelos prontos e filtro por produto. */
export interface EventosDoAplicativo {
  readonly eventos: readonly DefinicaoDeEvento[];
  readonly modelos: readonly ModeloDeEventos[];
  /** O assistente oferece o filtro por produto (`configuracao.produtos`). */
  readonly filtroPorProduto: boolean;
}

export type TipoDeAutenticidade =
  | 'NENHUMA'
  | 'HMAC_X_ASSINATURA'
  | 'CHAVE_NO_CABECALHO'
  | 'TYPEFORM_ASSINATURA'
  | 'HOTMART_HOTTOK'
  | 'KIWIFY_ASSINATURA'
  | 'EDUZZ_ASSINATURA';

export interface CampoDaCredencial {
  readonly chave: string;
  readonly rotulo: string;
  /** Segredo: guardado cifrado e devolvido só mascarado. */
  readonly secreto: boolean;
  readonly obrigatorio: boolean;
  readonly descricao: string;
  readonly exemplo?: string;
}

export interface PassoAPasso {
  /** Onde fazer (`No Elementor`). */
  readonly titulo: string;
  readonly passos: readonly string[];
}

export interface ModeloDoAplicativo {
  readonly nome: string;
  readonly descricao: string;
  readonly mapeamento: Mapeamento;
  /** Corpo de exemplo, no formato real da ferramenta (já normalizado, como o mapeamento o enxerga). */
  readonly exemplo: Readonly<Record<string, unknown>>;
}

/** O que o catálogo mostra e o assistente usa (R32.1). */
export interface DefinicaoDoAplicativo {
  readonly aplicativo: AplicativoIntegracao;
  readonly nome: string;
  readonly descricao: string;
  /** Falso para os aplicativos da fatia H2 (já no enum, ainda sem adaptador). */
  readonly disponivel: boolean;
  /** Como o aplicativo envia: `webhook` (a ferramenta chama o endereço) ou `api` (o CRM busca). */
  readonly entrega: 'WEBHOOK' | 'API';
  readonly tiposDeConteudo: readonly string[];
  readonly autenticidade: {
    readonly tipo: TipoDeAutenticidade;
    readonly descricao: string;
    readonly segredo: ModoDoSegredo;
    readonly rotuloDoSegredo: string | null;
    /** Nome do cabeçalho que leva a chave/assinatura (quando houver). */
    readonly cabecalho: string | null;
  };
  /** Campos da credencial do aplicativo, ou `null` se ele não pede. */
  readonly credencial: readonly CampoDaCredencial[] | null;
  /** O assistente oferece "Buscar campos da integração". */
  readonly buscaCampos: boolean;
  /** O assistente escolhe um formulário do aplicativo (Typeform). */
  readonly escolheFormulario: boolean;
  readonly passoAPasso: PassoAPasso;
  readonly modelo: ModeloDoAplicativo | null;
  /** Dicas dos destinos do mapeamento que o aplicativo usa (`etapa`, `dono`, `status`). */
  readonly dicas: readonly string[];
  /** Plataformas de curso: a tabela de eventos (R32.20). `undefined` nos demais. */
  readonly eventos?: EventosDoAplicativo;
}

export interface CampoBuscado {
  /** Caminho como o mapeamento o enxerga (`contact.fields.3`, `custom_fields.cidade`, `<ref>`). */
  readonly caminho: string;
  readonly rotulo: string;
  readonly tipo: string | null;
}

export interface FormularioDoAplicativo {
  readonly id: string;
  readonly titulo: string;
  readonly url: string | null;
  readonly atualizadoEm: string | null;
}

/** Credencial recusada pelo aplicativo (token expirado, revogado, chave inválida): a integração "precisa de atenção". */
export class CredencialRecusadaError extends Error {
  constructor(mensagem: string) {
    super(mensagem);
    this.name = 'CredencialRecusadaError';
  }
}

/** Falha ao falar com o aplicativo que não é da credencial (rede, resposta inesperada, 5xx). */
export class FalhaNoAplicativoError extends Error {
  constructor(mensagem: string) {
    super(mensagem);
    this.name = 'FalhaNoAplicativoError';
  }
}

export type Credencial = Readonly<Record<string, string>>;

export interface ContextoHttp {
  /** `fetch` (trocado nos testes por um falso). */
  readonly buscar: typeof fetch;
  readonly typeformUrl: string;
  readonly manychatUrl: string;
  /** Confere o endereço digitado pelo usuário (SSRF, R9.1); devolve a URL normalizada ou lança. */
  readonly verificarEndereco: (endereco: string) => Promise<string>;
}

export interface AdaptadorDeAplicativo {
  readonly definicao: DefinicaoDoAplicativo;
  /** O corpo (JSON ou formulário já lido) → itens. Nunca lança: corpo estranho vira um item só. */
  normalizarCorpo(corpo: unknown): ItemRecebido[];
  verificarAutenticidade(
    entrada: EntradaDeAutenticidade,
  ): ResultadoDeAutenticidade;
  /**
   * Um aviso de teste do aplicativo (o `ping` da Eduzz) que deve receber 2xx **sem
   * processar**: devolve o motivo (fica no histórico como `IGNORADO`) ou `null`.
   */
  respostaSemProcessar?(corpo: unknown): string | null;
  /** O corpo sem o que for segredo do aplicativo (o `originSecret` da Eduzz), para o que vai ao histórico. */
  ocultarSegredosDoCorpo?(corpo: unknown): unknown;
  /** Mensagem específica para o item sem e-mail nem telefone (ex.: contato do Instagram no ManyChat). */
  explicarFaltaDeContato?(
    item: Readonly<Record<string, unknown>>,
  ): string | null;
  /** Confere e normaliza a credencial enviada pelo Admin (aparar, URL…). Devolve os problemas por campo. */
  lerCredencial?(
    entrada: Record<string, unknown>,
  ):
    | { credencial: Credencial }
    | { problemas: { campo: string; mensagem: string }[] };
  /** Chama o aplicativo para ver se a credencial vale. Lança `CredencialRecusadaError` ou `FalhaNoAplicativoError`. */
  testarCredencial?(credencial: Credencial, http: ContextoHttp): Promise<void>;
  buscarCampos?(
    credencial: Credencial,
    configuracao: Readonly<Record<string, unknown>>,
    http: ContextoHttp,
  ): Promise<CampoBuscado[]>;
}
