import {
  ConflitoException,
  type ErroApi,
  NaoEncontradoException,
  RegraVioladaException,
} from './excecoes';

/**
 * Campos de cada restrição única do schema (o adapter do Prisma informa só o
 * nome da restrição). Mantenha junto com `prisma/schema.prisma`.
 */
const CAMPOS_POR_RESTRICAO: Readonly<Record<string, readonly string[]>> = {
  usuarios_email_key: ['email'],
  sessoes_token_hash_key: ['tokenHash'],
  tokens_senha_token_hash_key: ['tokenHash'],
  empresas_cnpj_ativo_key: ['cnpj'],
  contatos_email_ativo_key: ['email'],
  contatos_telefone_ativo_key: ['telefone'],
  funis_base_area_key: ['area'],
  etapas_funil_id_chave_key: ['funilId', 'chave'],
  etapas_funil_ganho_key: ['tipo'],
  etapas_funil_perdido_key: ['tipo'],
  passagens_chave_key: ['chave'],
  passagem_execucoes_passagem_id_negocio_origem_id_key: [
    'passagemId',
    'negocioOrigemId',
  ],
  regras_distribuicao_area_key: ['area'],
  regras_distribuicao_participantes_regra_id_usuario_id_key: [
    'regraId',
    'usuarioId',
  ],
  webhooks_entrada_token_hash_key: ['tokenHash'],
  webhook_entregas_webhook_id_evento_id_key: ['webhookId', 'eventoId'],
  // Onda A (migration `onda_a_atendimento`).
  arquivos_chave_key: ['chave'],
  canais_tipo_id_externo_ativo_key: ['tipo', 'idExterno'],
  filas_atendimento_chave_key: ['chave'],
  fila_participantes_fila_id_usuario_id_key: ['filaId', 'usuarioId'],
  contato_identificadores_tipo_valor_key: ['tipo', 'valor'],
  conversas_ultima_mensagem_id_key: ['ultimaMensagemId'],
  conversas_uma_em_aberto_key: ['canalId', 'contatoId'],
  mensagens_canal_id_id_externo_key: ['canalId', 'idExterno'],
  respostas_rapidas_atalho_global_key: ['atalho'],
  respostas_rapidas_area_atalho_key: ['area', 'atalho'],
  webchat_visitantes_token_hash_key: ['tokenHash'],
  whatsapp_numeros_canal_id_key: ['canalId'],
  chat_canais_chave_key: ['chave'],
  chat_membros_canal_id_usuario_id_key: ['canalId', 'usuarioId'],
};

/**
 * Traduz os erros conhecidos do Prisma em erros da API. Devolve `null` para os
 * demais (viram 500 no filtro).
 *
 * - P2002 (único violado) → 409, com `detalhes.campos` e `detalhes.restricao`;
 * - P2025 (registro não encontrado) → 404;
 * - P2003 (chave estrangeira) → 409;
 * - P2034 (conflito de escrita / deadlock) → 409, pedindo para tentar de novo;
 * - gatilho do banco que cita uma regra (`… (R4.3).`, SQLSTATE 23514) → 422.
 *
 * Os serviços devem validar antes e lançar mensagens próprias; isto é a rede
 * de proteção para a corrida que nenhuma validação prévia evita.
 */
export function traduzirErroDoPrisma(erro: unknown): ErroApi | null {
  if (!ehErroConhecidoDoPrisma(erro)) {
    return null;
  }
  const causa = causaDoAdaptador(erro.meta);
  switch (erro.code) {
    case 'P2002': {
      const restricao = restricaoDe(erro.meta, causa);
      const campos = camposDoUnico(erro.meta);
      return new ConflitoException('Já existe um registro com esses dados.', {
        ...(campos.length > 0 ? { campos } : {}),
        ...(restricao ? { restricao } : {}),
      });
    }
    case 'P2025':
      return new NaoEncontradoException();
    case 'P2003':
      return new ConflitoException(
        'A operação depende de um registro relacionado que não existe ou ainda está em uso.',
      );
    case 'P2034':
      return new ConflitoException(
        'Outra alteração aconteceu ao mesmo tempo. Tente de novo.',
      );
    default:
      break;
  }
  const mensagem =
    typeof causa?.originalMessage === 'string' ? causa.originalMessage : '';
  const regra = /\s*\((R\d+\.\d+)\)\.?$/.exec(mensagem);
  if (causa?.originalCode === '23514' && regra) {
    // O código da regra vai em `detalhes.regra`, não no texto para a pessoa.
    const texto = `${mensagem.slice(0, regra.index).trimEnd().replace(/\.$/, '')}.`;
    return new RegraVioladaException(regra[1], texto);
  }
  return null;
}

interface ErroConhecidoDoPrisma {
  code: string;
  meta?: unknown;
}

interface CausaDoAdaptador {
  originalCode?: unknown;
  originalMessage?: unknown;
  constraint?: { fields?: unknown; index?: unknown };
}

function ehErroConhecidoDoPrisma(erro: unknown): erro is ErroConhecidoDoPrisma {
  return (
    typeof erro === 'object' &&
    erro !== null &&
    (erro as { name?: unknown }).name === 'PrismaClientKnownRequestError' &&
    typeof (erro as { code?: unknown }).code === 'string'
  );
}

function causaDoAdaptador(meta: unknown): CausaDoAdaptador | undefined {
  if (typeof meta !== 'object' || meta === null) {
    return undefined;
  }
  return (meta as { driverAdapterError?: { cause?: CausaDoAdaptador } })
    .driverAdapterError?.cause;
}

function restricaoDe(
  meta: unknown,
  causa: CausaDoAdaptador | undefined,
): string | undefined {
  const indice = causa?.constraint?.index;
  if (typeof indice === 'string') {
    return indice;
  }
  const alvo = (meta as { target?: unknown } | undefined)?.target;
  return typeof alvo === 'string' ? alvo : undefined;
}

/** Campos da restrição única violada, no formato do Prisma clássico ou do adapter. */
export function camposDoUnico(meta: unknown): string[] {
  if (typeof meta !== 'object' || meta === null) {
    return [];
  }
  const alvo = (meta as { target?: unknown }).target;
  if (Array.isArray(alvo)) {
    return alvo.filter((campo): campo is string => typeof campo === 'string');
  }
  const causa = causaDoAdaptador(meta);
  if (Array.isArray(causa?.constraint?.fields)) {
    return causa.constraint.fields
      .filter((campo): campo is string => typeof campo === 'string')
      .map((campo) => campo.replace(/^"|"$/g, ''));
  }
  const restricao = restricaoDe(meta, causa);
  return restricao && CAMPOS_POR_RESTRICAO[restricao]
    ? [...CAMPOS_POR_RESTRICAO[restricao]]
    : [];
}
