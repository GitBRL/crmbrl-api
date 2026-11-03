/**
 * Calling API do WhatsApp (R29): leitura do webhook `calls` e corpos das
 * chamadas à Graph, em funções puras — testadas em `formato-chamadas.spec.ts`.
 *
 * **Tudo o que a referência não confirma fica aqui**, marcado com `LACUNA n`
 * (n = número em `TRABALHO/referencias/whatsapp-cloud-chamadas.md`, seção
 * "Lacunas"). Quando o usuário testar com a Meta real, é este arquivo (e o
 * `graph-ligacoes.ts`) que se ajusta:
 *
 * - LACUNA 1/2: o navegador como ponto WebRTC e a ausência de TURN. Nada aqui:
 *   é do softphone (a API só sinaliza).
 * - LACUNA 3: o prazo exato do `accept` (30 a 60 s). O tempo de toque do canal
 *   fica sempre abaixo disso (`TOQUE_MAXIMO_SEGUNDOS`).
 * - LACUNA 4: `accept` sem `pre_accept`. Sempre mandamos os dois.
 * - LACUNA 5: `sdp_type` dos corpos de `pre_accept`/`accept`: `"answer"` (exemplos
 *   e docs secundárias), não `"offer"` como diz a tabela da Meta.
 * - LACUNA 6: `from`/`to` do `connect` recebido (comentários do exemplo invertidos)
 *   e `direction` ausente no `connect`. Não dependemos deles: o cliente é o
 *   `contacts[0]` (`wa_id`/`user_id`), a empresa é `metadata.phone_number_id`, e a
 *   direção do `connect` sai do `session.sdp_type` (`offer` = ligação recebida,
 *   `answer` = resposta SDP de uma ligação feita).
 * - LACUNA 7: `status` do `terminate` (`COMPLETED`/`FAILED`; `REJECTED` aparece
 *   em fontes secundárias). Aceitamos os três, em qualquer caixa, e tratamos o
 *   valor desconhecido como `COMPLETED`.
 * - LACUNA 8: nome do campo de expiração em `GET call_permissions`
 *   (`expiration_time` no exemplo, `expiration` na tabela): lemos os dois.
 * - LACUNA 9: limite diário de ligações feitas (100 ou 5): nunca fixamos o
 *   número; lemos `actions[start_call].limits` e tratamos o erro 138012/138005.
 * - LACUNA 12: o template de permissão é um componente `call_permission_request`
 *   (não confirmado como botão): detectamos o componente pelo tipo.
 * - LACUNA 13: reinício de ICE e candidatos tardios: do softphone.
 * - LACUNA 17: nada foi testado contra a Meta real; BSUID/usernames podem
 *   omitir o telefone: usamos `user_id` como alternativa.
 */

type Json = Record<string, unknown>;

const objeto = (valor: unknown): Json =>
  typeof valor === 'object' && valor !== null && !Array.isArray(valor)
    ? (valor as Json)
    : {};

const texto = (valor: unknown): string | null =>
  typeof valor === 'string' && valor.trim() !== ''
    ? valor.trim()
    : typeof valor === 'number' && Number.isFinite(valor)
      ? String(valor)
      : null;

/** Texto sem alteração (o SDP termina com CRLF: nunca aparar). */
const semAparar = (valor: unknown): string | null =>
  typeof valor === 'string' && valor.trim() !== '' ? valor : null;

const numero = (valor: unknown): number | null => {
  const convertido = typeof valor === 'string' ? Number(valor) : valor;
  return typeof convertido === 'number' && Number.isFinite(convertido)
    ? convertido
    : null;
};

/** `timestamp` da Meta (segundos desde 1970, como texto ou número). */
function instante(valor: unknown): Date | null {
  const segundos = numero(valor);
  return segundos !== null && segundos > 0 ? new Date(segundos * 1000) : null;
}

/** Campo do webhook que traz as chamadas. */
export const CAMPO_DE_CHAMADAS = 'calls';

// ---------------------------------------------------------------------------
// Webhook `calls`
// ---------------------------------------------------------------------------

export interface ErroDeChamada {
  codigo: number | null;
  mensagem: string | null;
}

/** `calls[]` do webhook: `connect` (oferta ou resposta SDP) ou `terminate`. */
export interface ChamadaDoWebhook {
  /** `wacid.…`. */
  id: string;
  evento: string;
  /** `USER_INITIATED` / `BUSINESS_INITIATED`, quando a Meta informa (LACUNA 6). */
  direcao: 'RECEBIDA' | 'FEITA' | null;
  de: string | null;
  para: string | null;
  quando: Date | null;
  sdpTipo: 'offer' | 'answer' | null;
  sdp: string | null;
  /** Só no `terminate` (LACUNA 7). */
  status: 'COMPLETED' | 'FAILED' | 'REJECTED' | null;
  iniciadaEm: Date | null;
  encerradaEm: Date | null;
  duracaoSegundos: number | null;
  erros: ErroDeChamada[];
  /** O `biz_opaque_callback_data` que mandamos (o id da ligação no CRM). */
  dadosOpacos: string | null;
}

/** `statuses[]` do webhook de chamadas: `RINGING`, `ACCEPTED`, `REJECTED`. */
export interface StatusDeChamada {
  id: string;
  status: string;
  quando: Date | null;
  dadosOpacos: string | null;
}

/** Quem é o cliente da chamada (do `contacts[0]` e, na falta dele, de `from`/`to`). */
export interface ClienteDaChamada {
  telefone: string | null;
  bsuid: string | null;
  nome: string | null;
}

export type EventoDeChamadas =
  | { tipo: 'chamada'; chamada: ChamadaDoWebhook; cliente: ClienteDaChamada }
  | { tipo: 'status'; status: StatusDeChamada; cliente: ClienteDaChamada };

function direcaoDe(valor: unknown): 'RECEBIDA' | 'FEITA' | null {
  const direcao = texto(valor)?.toUpperCase();
  if (direcao === 'USER_INITIATED') return 'RECEBIDA';
  if (direcao === 'BUSINESS_INITIATED') return 'FEITA';
  return null;
}

function statusDoTerminate(valor: unknown): ChamadaDoWebhook['status'] {
  // LACUNA 7: `["Failed","Completed"]` aparece no exemplo oficial como placeholder.
  const bruto = Array.isArray(valor) ? valor[0] : valor;
  const status = texto(bruto)?.toUpperCase();
  if (status === 'FAILED' || status === 'REJECTED' || status === 'COMPLETED') {
    return status;
  }
  return status ? 'COMPLETED' : null;
}

function apenasDigitos(valor: string | null): string | null {
  const digitos = valor?.replace(/\D/g, '') ?? '';
  return digitos !== '' ? digitos : null;
}

function lerChamada(bruta: Json): ChamadaDoWebhook | null {
  const id = texto(bruta.id);
  const evento = texto(bruta.event)?.toLowerCase();
  if (!id || !evento) {
    return null;
  }
  const sessao = objeto(bruta.session);
  // O SDP pode vir em `session.sdp` ou, em docs de BSPs, em `connection.webrtc.sdp` (referência §3.6).
  const sdp =
    semAparar(sessao.sdp) ??
    semAparar(objeto(objeto(bruta.connection).webrtc).sdp);
  const sdpTipo = texto(sessao.sdp_type)?.toLowerCase();
  const erros = (Array.isArray(bruta.errors) ? bruta.errors : []).map(
    (erro): ErroDeChamada => ({
      codigo: numero(objeto(erro).code),
      mensagem:
        texto(objeto(erro).message) ??
        texto(objeto(erro).title) ??
        texto(objeto(objeto(erro).error_data).details),
    }),
  );
  return {
    id,
    evento,
    direcao: direcaoDe(bruta.direction),
    de: apenasDigitos(texto(bruta.from)),
    para: apenasDigitos(texto(bruta.to)),
    quando: instante(bruta.timestamp),
    sdpTipo: sdpTipo === 'offer' || sdpTipo === 'answer' ? sdpTipo : null,
    sdp,
    status: statusDoTerminate(bruta.status),
    iniciadaEm: instante(bruta.start_time),
    encerradaEm: instante(bruta.end_time),
    duracaoSegundos: numero(bruta.duration),
    erros,
    dadosOpacos: texto(bruta.biz_opaque_callback_data),
  };
}

/**
 * Lê o `value` de uma mudança do campo `calls`. A direção do `connect` sem
 * `direction` sai do tipo do SDP (LACUNA 6); o cliente sai de `contacts[0]`.
 */
export function eventosDeChamadas(valor: Json): EventoDeChamadas[] {
  const contato = objeto(
    (Array.isArray(valor.contacts) ? valor.contacts : [])[0],
  );
  const perfil = objeto(contato.profile);
  const eventos: EventoDeChamadas[] = [];
  for (const bruta of Array.isArray(valor.calls) ? valor.calls : []) {
    const chamada = lerChamada(objeto(bruta));
    if (!chamada) {
      continue;
    }
    if (!chamada.direcao && chamada.evento === 'connect') {
      chamada.direcao =
        chamada.sdpTipo === 'offer'
          ? 'RECEBIDA'
          : chamada.sdpTipo === 'answer'
            ? 'FEITA'
            : null;
    }
    const brutoDe = objeto(bruta);
    const recebida = chamada.direcao === 'RECEBIDA';
    eventos.push({
      tipo: 'chamada',
      chamada,
      cliente: {
        telefone:
          apenasDigitos(texto(contato.wa_id)) ??
          (recebida ? chamada.de : chamada.para),
        bsuid:
          texto(contato.user_id) ??
          texto(recebida ? brutoDe.from_user_id : brutoDe.to_user_id),
        nome: texto(perfil.name),
      },
    });
  }
  for (const bruto of Array.isArray(valor.statuses) ? valor.statuses : []) {
    const item = objeto(bruto);
    const id = texto(item.id);
    const status = texto(item.status)?.toUpperCase();
    if (!id || !status || (texto(item.type) && texto(item.type) !== 'call')) {
      continue;
    }
    eventos.push({
      tipo: 'status',
      status: {
        id,
        status,
        quando: instante(item.timestamp),
        dadosOpacos: texto(item.biz_opaque_callback_data),
      },
      cliente: {
        telefone:
          apenasDigitos(texto(item.recipient_id)) ??
          apenasDigitos(texto(contato.wa_id)),
        bsuid: texto(item.recipient_user_id) ?? texto(contato.user_id),
        nome: texto(perfil.name),
      },
    });
  }
  return eventos;
}

/** Chave de dedupe de um evento (a Meta reentrega por até 7 dias, referência §1.3). */
export function chaveDeDedupe(
  canalId: string,
  evento: EventoDeChamadas,
): string {
  if (evento.tipo === 'status') {
    return `${canalId}:status:${evento.status.id}:${evento.status.status}`;
  }
  const { chamada } = evento;
  const faceta =
    chamada.evento === 'connect' ? (chamada.sdpTipo ?? 'sem-sdp') : '';
  return `${canalId}:${chamada.evento}:${chamada.id}${faceta ? `:${faceta}` : ''}`;
}

// ---------------------------------------------------------------------------
// Resposta do cliente ao pedido de permissão (campo `messages`)
// ---------------------------------------------------------------------------

/** `interactive.call_permission_reply` de uma mensagem do webhook `messages` (referência §3.2). */
export interface RespostaDePermissao {
  resposta: 'accept' | 'reject';
  permanente: boolean;
  expiraEm: Date | null;
  /** `user_action` ou `automatic` (o cliente ligou para a empresa). */
  origem: string | null;
  /** `context.id`: wamid do pedido ou wacid da ligação perdida. */
  contextoId: string | null;
}

export function respostaDePermissao(
  mensagem: Json,
): RespostaDePermissao | null {
  const interativo = objeto(mensagem.interactive);
  if (texto(interativo.type) !== 'call_permission_reply') {
    return null;
  }
  const resposta = objeto(interativo.call_permission_reply);
  const decisao = texto(resposta.response)?.toLowerCase();
  if (decisao !== 'accept' && decisao !== 'reject') {
    return null;
  }
  return {
    resposta: decisao,
    permanente: resposta.is_permanent === true,
    expiraEm: instante(resposta.expiration_timestamp),
    origem: texto(resposta.response_source),
    contextoId: texto(objeto(mensagem.context).id),
  };
}

// ---------------------------------------------------------------------------
// Corpos das chamadas à Graph (`POST /{phone_number_id}/calls`)
// ---------------------------------------------------------------------------

export type AcaoDeChamada = 'pre_accept' | 'accept' | 'reject' | 'terminate';

/** Corpo de `pre_accept`/`accept` (com a resposta SDP, `answer` — LACUNA 5), `reject` e `terminate`. */
export function corpoDeAcao(
  acao: AcaoDeChamada,
  idMeta: string,
  sdp?: string,
): Json {
  return {
    messaging_product: 'whatsapp',
    call_id: idMeta,
    action: acao,
    ...(sdp ? { session: { sdp_type: 'answer', sdp } } : {}),
  };
}

/** Corpo do `connect` de uma ligação feita: `to` (telefone) ou `recipient` (BSUID). */
export function corpoDeConnect(
  cliente: { telefone: string | null; bsuid: string | null },
  sdp: string,
  dadosOpacos: string,
): Json {
  return {
    messaging_product: 'whatsapp',
    ...(cliente.telefone ? { to: cliente.telefone } : {}),
    ...(cliente.bsuid && !cliente.telefone ? { recipient: cliente.bsuid } : {}),
    action: 'connect',
    session: { sdp_type: 'offer', sdp },
    biz_opaque_callback_data: dadosOpacos,
  };
}

/** `id` da chamada na resposta do `connect` (`calls[0].id`). */
export function idDaChamadaCriada(resposta: unknown): string | null {
  const calls = objeto(resposta).calls;
  return texto(objeto(Array.isArray(calls) ? calls[0] : null).id);
}

/**
 * Corpo de `POST /{phone_number_id}/settings`: liga ou desliga as chamadas no
 * número. O horário de ligações é do CRM (não mandamos `call_hours`: com ele a
 * Meta nem entrega a ligação fora do horário e o CRM não registraria a perdida);
 * SIP fica desligado (com SIP a Graph de chamadas deixa de valer, erro 131055).
 */
export function corpoDeConfiguracao(ativa: boolean): Json {
  return {
    calling: {
      status: ativa ? 'ENABLED' : 'DISABLED',
      call_icon_visibility: 'DEFAULT',
      sip: { status: 'DISABLED' },
    },
  };
}

// ---------------------------------------------------------------------------
// Permissão do cliente
// ---------------------------------------------------------------------------

export interface LimiteDaMeta {
  periodo: string;
  maximo: number | null;
  uso: number | null;
  liberaEm: Date | null;
}

export interface AcaoDePermissao {
  pode: boolean;
  limites: LimiteDaMeta[];
}

export interface PermissaoNaMeta {
  status: 'no_permission' | 'temporary' | 'permanent';
  expiraEm: Date | null;
  /** `send_call_permission_request` (null = a Meta não informou). */
  pedir: AcaoDePermissao | null;
  /** `start_call`. */
  ligar: AcaoDePermissao | null;
}

function lerAcao(acoes: unknown[], nome: string): AcaoDePermissao | null {
  const acao = acoes
    .map(objeto)
    .find((item) => texto(item.action_name) === nome);
  if (!acao) {
    return null;
  }
  return {
    pode: acao.can_perform_action !== false,
    limites: (Array.isArray(acao.limits) ? acao.limits : []).map((bruto) => {
      const limite = objeto(bruto);
      return {
        periodo: texto(limite.time_period) ?? '',
        maximo: numero(limite.max_allowed),
        uso: numero(limite.current_usage),
        liberaEm: instante(limite.limit_expiration_time),
      };
    }),
  };
}

/** Lê a resposta de `GET /{phone_number_id}/call_permissions` (referência §3.4, LACUNAS 8 e 9). */
export function permissaoDaMeta(resposta: unknown): PermissaoNaMeta {
  const corpo = objeto(resposta);
  const permissao = objeto(corpo.permission);
  const status = texto(permissao.status)?.toLowerCase();
  return {
    status:
      status === 'temporary' || status === 'permanent'
        ? status
        : 'no_permission',
    // LACUNA 8: `expiration_time` (exemplo) ou `expiration` (tabela).
    expiraEm: instante(permissao.expiration_time ?? permissao.expiration),
    pedir: lerAcao(
      Array.isArray(corpo.actions) ? corpo.actions : [],
      'send_call_permission_request',
    ),
    ligar: lerAcao(
      Array.isArray(corpo.actions) ? corpo.actions : [],
      'start_call',
    ),
  };
}

/** Mensagem interativa livre de pedido de permissão (dentro da janela de 24 h, referência §3.1). */
export function corpoDePedidoInterativo(
  cliente: { telefone: string | null; bsuid: string | null },
  texto: string,
): Json {
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    ...(cliente.telefone ? { to: cliente.telefone } : {}),
    ...(cliente.bsuid && !cliente.telefone ? { recipient: cliente.bsuid } : {}),
    type: 'interactive',
    interactive: {
      type: 'call_permission_request',
      action: { name: 'call_permission_request' },
      body: { text: texto },
    },
  };
}

/** O template tem o componente de pedido de permissão? (LACUNA 12.) */
export function temComponenteDePermissao(componentes: unknown): boolean {
  return (Array.isArray(componentes) ? componentes : []).some(
    (item) =>
      texto(objeto(item).type)?.toLowerCase() === 'call_permission_request',
  );
}

/** Texto padrão do pedido de permissão (o atendente pode trocar). */
export const TEXTO_PADRAO_DO_PEDIDO =
  'Olá! Gostaríamos de ligar para você pelo WhatsApp para continuar o seu atendimento. Você autoriza?';

// ---------------------------------------------------------------------------
// Erros da Calling API (referência §5.1)
// ---------------------------------------------------------------------------

export interface ErroDeChamadaTraduzido {
  /** Código estável para o front. */
  motivo: string;
  mensagem: string;
}

/** Erros da Calling API, em português, pelo código da Meta. */
const ERROS_DA_CALLING_API: Readonly<Record<number, ErroDeChamadaTraduzido>> = {
  100: {
    motivo: 'parametro_invalido',
    mensagem: 'A Meta recusou os dados da ligação (parâmetro inválido).',
  },
  613: {
    motivo: 'limite_de_consultas',
    mensagem:
      'A Meta limitou as consultas de permissão por um instante. Tente de novo em alguns segundos.',
  },
  138000: {
    motivo: 'chamadas_desativadas',
    mensagem: 'As chamadas não estão habilitadas neste número na Meta.',
  },
  138001: {
    motivo: 'cliente_nao_pode_receber',
    mensagem:
      'O cliente não pode receber ligações pelo WhatsApp (sem WhatsApp, termos não aceitos ou aplicativo sem suporte).',
  },
  138002: {
    motivo: 'limite_simultaneas',
    mensagem: 'O número atingiu o limite de ligações simultâneas.',
  },
  138003: {
    motivo: 'ligacao_duplicada',
    mensagem: 'Já existe uma ligação ativa com este cliente.',
  },
  138004: {
    motivo: 'erro_de_conexao',
    mensagem:
      'A Meta não conseguiu montar a conexão da ligação. Tente de novo.',
  },
  138005: {
    motivo: 'limite_de_ligacoes',
    mensagem: 'O número atingiu o limite de ligações iniciadas pela Meta.',
  },
  138006: {
    motivo: 'sem_permissao',
    mensagem: 'O cliente ainda não autorizou ligações neste número.',
  },
  138007: {
    motivo: 'tempo_esgotado_na_meta',
    mensagem:
      'A conexão da ligação demorou demais e a Meta desistiu. Tente de novo.',
  },
  138009: {
    motivo: 'limite_de_pedidos',
    mensagem:
      'A Meta recusou outro pedido de permissão: o limite de pedidos para este cliente foi atingido.',
  },
  138012: {
    motivo: 'limite_diario',
    mensagem: 'O limite de ligações feitas por este número foi atingido.',
  },
  138013: {
    motivo: 'ligacoes_feitas_indisponiveis',
    mensagem: 'Este número não pode fazer ligações pela Meta.',
  },
  138014: {
    motivo: 'chamadas_suspensas',
    mensagem:
      'A Meta desativou as chamadas deste número temporariamente por baixa qualidade.',
  },
  138015: {
    motivo: 'limite_de_mensagens_baixo',
    mensagem:
      'Não é possível ativar as chamadas: o limite de mensagens do número é menor que 2.000.',
  },
  138017: {
    motivo: 'permissao_ja_existe',
    mensagem: 'O cliente já deu permissão permanente: não é preciso pedir.',
  },
  138018: {
    motivo: 'pre_requisitos',
    mensagem:
      'O número não atende aos pré-requisitos das chamadas (SIP ativo ou aplicativo sem o campo "calls" assinado).',
  },
  131044: {
    motivo: 'sem_forma_de_pagamento',
    mensagem: 'A conta do WhatsApp Business não tem forma de pagamento válida.',
  },
  131055: {
    motivo: 'sip_ativo',
    mensagem:
      'O número usa SIP: a Graph API de chamadas não vale para ele. Desligue o SIP na Meta.',
  },
  131026: {
    motivo: 'cliente_nao_pode_receber',
    mensagem:
      'O cliente usa uma versão do WhatsApp que não recebe pedidos de permissão para ligar.',
  },
  // Mensagem fora da janela de 24 h (a Meta fechou a janela antes de o CRM saber, ex.: a hora do
  // último recebimento ficou desatualizada): o pedido interativo só vale dentro da janela.
  131047: {
    motivo: 'janela_fechada',
    mensagem:
      'A janela de 24 h com o cliente está fechada para o pedido de permissão. Use um template aprovado com o botão de permissão ou espere o cliente escrever.',
  },
  190: {
    motivo: 'token_invalido',
    mensagem:
      'O token do canal é inválido ou expirou: o Admin precisa gerar outro e salvar no canal.',
  },
};

export function traduzirErroDeChamada(
  codigo: number | null,
  mensagemOriginal?: string | null,
): ErroDeChamadaTraduzido {
  const conhecido = codigo !== null ? ERROS_DA_CALLING_API[codigo] : undefined;
  if (conhecido) {
    return conhecido;
  }
  return {
    motivo: 'erro_da_meta',
    mensagem: mensagemOriginal
      ? `A Meta recusou a operação: ${mensagemOriginal}`
      : 'A Meta recusou a operação.',
  };
}

/** Erros `138019` a `138023` do `terminate` (o cliente falhou ao montar ou manter a mídia). */
export function falhaDeMidia(codigo: number | null): boolean {
  return codigo !== null && codigo >= 138019 && codigo <= 138023;
}
