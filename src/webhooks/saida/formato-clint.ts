/**
 * Formato de saída no estilo do Clint (R32.12): o cartão Webhook → "Enviar".
 * Gatilhos (negócio criado, entra na etapa X, muda de etapa, muda de status),
 * filtro de funil, método POST (JSON) ou GET (parâmetros na URL) e os campos
 * escolhidos, cada um com um identificador editável. Funções puras.
 */
import type { StatusNegocio } from '../../generated/prisma/client';

export const TIPOS_DE_GATILHO = [
  'NEGOCIO_CRIADO',
  'ENTRA_NA_ETAPA',
  'MUDA_DE_ETAPA',
  'MUDA_DE_STATUS',
] as const;
export type TipoDeGatilho = (typeof TIPOS_DE_GATILHO)[number];

export interface Gatilho {
  readonly tipo: TipoDeGatilho;
  /** Só os negócios deste funil. */
  readonly funilId?: string;
  /** `ENTRA_NA_ETAPA`: a etapa (o funil é o dela). */
  readonly etapaId?: string;
  /** `MUDA_DE_STATUS`: só para este status (sem ele, qualquer mudança). */
  readonly status?: StatusNegocio;
}

export const DESCRICAO_DOS_GATILHOS: Readonly<Record<TipoDeGatilho, string>> = {
  NEGOCIO_CRIADO: 'Negócio criado.',
  ENTRA_NA_ETAPA:
    'Negócio entra numa etapa (escolha a etapa): ao ser criado nela ou ao ser movido para ela.',
  MUDA_DE_ETAPA: 'Negócio muda de etapa (qualquer etapa do funil).',
  MUDA_DE_STATUS:
    'Negócio muda de status: ganho, perdido ou reaberto (escolha um status ou deixe vazio para qualquer).',
};

/** Eventos de domínio que os gatilhos observam. */
export const EVENTOS_DOS_GATILHOS = [
  'negocio.criado',
  'negocio.movido',
  'negocio.ganho',
  'negocio.perdido',
  'negocio.reaberto',
] as const;

export function ehEventoDeGatilho(tipo: string): boolean {
  return (EVENTOS_DOS_GATILHOS as readonly string[]).includes(tipo);
}

// ---------------------------------------------------------------------------
// Campos
// ---------------------------------------------------------------------------

export interface CampoDeSaida {
  /** De onde vem o valor (`contato.email`, `contato.camposPersonalizados.cidade`…). */
  readonly origem: string;
  /** O nome do campo no envio. Editável. */
  readonly identificador: string;
}

export interface OrigemDeCampo {
  readonly origem: string;
  readonly rotulo: string;
  readonly grupo: string;
  readonly identificadorPadrao: string;
}

const CAMPOS_FIXOS: readonly OrigemDeCampo[] = [
  {
    origem: 'contato.id',
    rotulo: 'ID do contato',
    grupo: 'Contato',
    identificadorPadrao: 'contato_id',
  },
  {
    origem: 'contato.nome',
    rotulo: 'Nome',
    grupo: 'Contato',
    identificadorPadrao: 'nome',
  },
  {
    origem: 'contato.email',
    rotulo: 'E-mail',
    grupo: 'Contato',
    identificadorPadrao: 'email',
  },
  {
    origem: 'contato.telefone',
    rotulo: 'Telefone',
    grupo: 'Contato',
    identificadorPadrao: 'telefone',
  },
  {
    origem: 'contato.empresa',
    rotulo: 'Empresa',
    grupo: 'Contato',
    identificadorPadrao: 'empresa',
  },
  {
    origem: 'contato.cargo',
    rotulo: 'Cargo',
    grupo: 'Contato',
    identificadorPadrao: 'cargo',
  },
  {
    origem: 'contato.etiquetas',
    rotulo: 'Etiquetas',
    grupo: 'Contato',
    identificadorPadrao: 'etiquetas',
  },
  {
    origem: 'negocio.id',
    rotulo: 'ID do negócio',
    grupo: 'Negócio',
    identificadorPadrao: 'negocio_id',
  },
  {
    origem: 'negocio.titulo',
    rotulo: 'Título',
    grupo: 'Negócio',
    identificadorPadrao: 'negocio',
  },
  {
    origem: 'negocio.valor',
    rotulo: 'Valor',
    grupo: 'Negócio',
    identificadorPadrao: 'valor',
  },
  {
    origem: 'negocio.valorRecorrente',
    rotulo: 'Valor recorrente',
    grupo: 'Negócio',
    identificadorPadrao: 'valor_recorrente',
  },
  {
    origem: 'negocio.status',
    rotulo: 'Status (aberto, ganho ou perdido)',
    grupo: 'Negócio',
    identificadorPadrao: 'status',
  },
  {
    origem: 'negocio.motivoPerda',
    rotulo: 'Motivo da perda',
    grupo: 'Negócio',
    identificadorPadrao: 'motivo_perda',
  },
  {
    origem: 'negocio.origem',
    rotulo: 'Origem',
    grupo: 'Negócio',
    identificadorPadrao: 'origem',
  },
  {
    origem: 'negocio.origemDetalhe',
    rotulo: 'Detalhe da origem',
    grupo: 'Negócio',
    identificadorPadrao: 'origem_detalhe',
  },
  {
    origem: 'negocio.criadoEm',
    rotulo: 'Criado em',
    grupo: 'Negócio',
    identificadorPadrao: 'criado_em',
  },
  {
    origem: 'funil.id',
    rotulo: 'ID do funil',
    grupo: 'Funil e etapa',
    identificadorPadrao: 'funil_id',
  },
  {
    origem: 'funil.nome',
    rotulo: 'Funil',
    grupo: 'Funil e etapa',
    identificadorPadrao: 'funil',
  },
  {
    origem: 'etapa.id',
    rotulo: 'ID da etapa',
    grupo: 'Funil e etapa',
    identificadorPadrao: 'etapa_id',
  },
  {
    origem: 'etapa.nome',
    rotulo: 'Etapa',
    grupo: 'Funil e etapa',
    identificadorPadrao: 'etapa',
  },
  {
    origem: 'etapa.anterior',
    rotulo: 'Etapa anterior (só quando o negócio muda de etapa)',
    grupo: 'Funil e etapa',
    identificadorPadrao: 'etapa_anterior',
  },
  {
    origem: 'dono.id',
    rotulo: 'ID do dono',
    grupo: 'Dono',
    identificadorPadrao: 'dono_id',
  },
  {
    origem: 'dono.nome',
    rotulo: 'Dono',
    grupo: 'Dono',
    identificadorPadrao: 'dono',
  },
  {
    origem: 'dono.email',
    rotulo: 'E-mail do dono',
    grupo: 'Dono',
    identificadorPadrao: 'dono_email',
  },
  {
    origem: 'dono.identificador',
    rotulo: 'Identificador do dono nas integrações',
    grupo: 'Dono',
    identificadorPadrao: 'dono_identificador',
  },
  {
    origem: 'utm.source',
    rotulo: 'UTM source',
    grupo: 'UTMs',
    identificadorPadrao: 'utm_source',
  },
  {
    origem: 'utm.medium',
    rotulo: 'UTM medium',
    grupo: 'UTMs',
    identificadorPadrao: 'utm_medium',
  },
  {
    origem: 'utm.campaign',
    rotulo: 'UTM campaign',
    grupo: 'UTMs',
    identificadorPadrao: 'utm_campaign',
  },
  {
    origem: 'utm.term',
    rotulo: 'UTM term',
    grupo: 'UTMs',
    identificadorPadrao: 'utm_term',
  },
  {
    origem: 'utm.content',
    rotulo: 'UTM content',
    grupo: 'UTMs',
    identificadorPadrao: 'utm_content',
  },
  {
    origem: 'evento.gatilho',
    rotulo: 'Gatilho que disparou o envio',
    grupo: 'Evento',
    identificadorPadrao: 'gatilho',
  },
  {
    origem: 'evento.ocorridoEm',
    rotulo: 'Quando aconteceu',
    grupo: 'Evento',
    identificadorPadrao: 'ocorrido_em',
  },
];

export const CAMPOS_DE_SAIDA: readonly OrigemDeCampo[] = CAMPOS_FIXOS;

export const PREFIXO_PERSONALIZADO_DO_CONTATO = 'contato.camposPersonalizados.';
export const PREFIXO_PERSONALIZADO_DO_NEGOCIO = 'negocio.camposPersonalizados.';

export const CAMPOS_DE_SAIDA_MAXIMOS = 60;
export const GATILHOS_MAXIMOS = 20;
const FORMATO_DO_IDENTIFICADOR = /^[A-Za-z0-9_.\-[\]]{1,100}$/;
const FORMATO_DA_CHAVE_PERSONALIZADA = /^[^\s]{1,100}$/;

export function ehOrigemValida(origem: string): boolean {
  if (CAMPOS_FIXOS.some((campo) => campo.origem === origem)) {
    return true;
  }
  for (const prefixo of [
    PREFIXO_PERSONALIZADO_DO_CONTATO,
    PREFIXO_PERSONALIZADO_DO_NEGOCIO,
  ]) {
    if (origem.startsWith(prefixo)) {
      return FORMATO_DA_CHAVE_PERSONALIZADA.test(origem.slice(prefixo.length));
    }
  }
  return false;
}

export function problemasDoCampo(campo: {
  origem: unknown;
  identificador: unknown;
}): { campo: string; mensagem: string }[] {
  const problemas: { campo: string; mensagem: string }[] = [];
  if (typeof campo.origem !== 'string' || !ehOrigemValida(campo.origem)) {
    problemas.push({
      campo: 'origem',
      mensagem:
        'origem desconhecida (veja GET /webhooks/saidas/formato-clint; campos personalizados: contato.camposPersonalizados.<chave> ou negocio.camposPersonalizados.<chave>)',
    });
  }
  if (
    typeof campo.identificador !== 'string' ||
    !FORMATO_DO_IDENTIFICADOR.test(campo.identificador)
  ) {
    problemas.push({
      campo: 'identificador',
      mensagem: 'deve ter de 1 a 100 caracteres: letras, números, _ - . [ ]',
    });
  }
  return problemas;
}

// ---------------------------------------------------------------------------
// Gatilhos
// ---------------------------------------------------------------------------

/** Dados do evento de negócio que o gatilho confere. */
export interface EventoDeNegocio {
  readonly tipo: string;
  readonly funilId: string;
  readonly etapaId: string;
}

/** Algum gatilho casa com o evento? Devolve o primeiro que casar. */
export function gatilhoQueCasa(
  gatilhos: readonly Gatilho[],
  evento: EventoDeNegocio,
): Gatilho | null {
  return (
    gatilhos.find((gatilho) => {
      if (gatilho.funilId && gatilho.funilId !== evento.funilId) {
        return false;
      }
      switch (gatilho.tipo) {
        case 'NEGOCIO_CRIADO':
          return evento.tipo === 'negocio.criado';
        case 'ENTRA_NA_ETAPA':
          return (
            (evento.tipo === 'negocio.criado' ||
              evento.tipo === 'negocio.movido') &&
            gatilho.etapaId === evento.etapaId
          );
        case 'MUDA_DE_ETAPA':
          return evento.tipo === 'negocio.movido';
        case 'MUDA_DE_STATUS': {
          const status = statusDoEvento(evento.tipo);
          return (
            status !== null && (!gatilho.status || gatilho.status === status)
          );
        }
      }
    }) ?? null
  );
}

function statusDoEvento(tipo: string): StatusNegocio | null {
  switch (tipo) {
    case 'negocio.ganho':
      return 'GANHO';
    case 'negocio.perdido':
      return 'PERDIDO';
    case 'negocio.reaberto':
      return 'ABERTO';
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Corpo e URL
// ---------------------------------------------------------------------------

export type ValorDeSaida = string | number | boolean | null | string[];

/** Os campos escolhidos, com os identificadores: `{ nome: "Maria", email: "…" }`. */
export function montarCorpoClint(
  campos: readonly CampoDeSaida[],
  valores: ReadonlyMap<string, ValorDeSaida>,
): Record<string, ValorDeSaida> {
  const corpo: Record<string, ValorDeSaida> = {};
  for (const { origem, identificador } of campos) {
    corpo[identificador] = valores.get(origem) ?? null;
  }
  return corpo;
}

/** Parâmetros da URL (GET): lista vira texto separado por vírgula; nulo, vazio. */
export function montarParametros(
  dados: Readonly<Record<string, unknown>>,
): string {
  const parametros = new URLSearchParams();
  for (const [chave, valor] of Object.entries(dados)) {
    parametros.append(
      chave,
      valor === null || valor === undefined
        ? ''
        : Array.isArray(valor)
          ? valor.join(',')
          : typeof valor === 'object'
            ? JSON.stringify(valor)
            : String(valor as string | number | boolean),
    );
  }
  return parametros.toString();
}

/** `url` com os parâmetros acrescentados (respeitando os que a URL já tem). */
export function urlComParametros(url: string, parametros: string): string {
  if (!parametros) {
    return url;
  }
  const destino = new URL(url);
  for (const [chave, valor] of new URLSearchParams(parametros)) {
    destino.searchParams.append(chave, valor);
  }
  return destino.toString();
}
