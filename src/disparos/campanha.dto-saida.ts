import type { ArquivoDto } from '../arquivos/arquivos.dto';
import type {
  Campanha,
  StatusCampanha,
  TipoCanal,
  TipoPublico,
} from '../generated/prisma/client';
import type { ContadoresDaCampanha } from './progresso-da-campanha.service';
import type { Area } from '../comum/dominio/setores';

/** O que a pessoa pode fazer com a campanha agora (o front mostra só os botões que cabem). */
export interface AcoesDaCampanha {
  editar: boolean;
  editarConteudo: boolean;
  iniciar: boolean;
  aprovar: boolean;
  reprovar: boolean;
  pausar: boolean;
  retomar: boolean;
  cancelar: boolean;
  reenviarFalhas: boolean;
  excluir: boolean;
  duplicar: boolean;
}

export interface CanalDaCampanhaDto {
  id: string;
  nome: string;
  tipo: TipoCanal;
  ordem: number;
  telefone: string | null;
  /** Status do número no gateway (WhatsApp). */
  statusDoNumero: string | null;
  numeroPausado: boolean;
}

export interface PessoaResumoDto {
  id: string;
  nome: string;
}

/** O que a campanha aguarda para o próximo envio (calculado na hora da consulta). */
export interface AguardandoDaCampanha {
  motivo:
    | 'intervalo'
    | 'janela_de_envio'
    | 'limite_diario'
    | 'confirmacoes'
    | 'sem_canal';
  ate: string | null;
}

export interface CampanhaDto {
  id: string;
  nome: string;
  descricao: string | null;
  area: Area | null;
  canal: 'WHATSAPP' | 'EMAIL';
  status: StatusCampanha;
  tipoPublico: TipoPublico;
  segmento: unknown;
  importacaoId: string | null;
  modeloId: string | null;
  assunto: string | null;
  texto: string;
  arquivo: ArquivoDto | null;
  ritmo: {
    intervaloMinimoSegundos: number;
    intervaloMaximoSegundos: number;
    loteTamanho: number | null;
    lotePausaSegundos: number | null;
    simularDigitando: boolean;
    pausarAposFalhas: number;
  };
  janelaEnvio: unknown;
  agendadaPara: string | null;
  iniciadaEm: string | null;
  pausadaEm: string | null;
  pausaMotivo: string | null;
  concluidaEm: string | null;
  canceladaEm: string | null;
  aprovacao: {
    solicitadaEm: string | null;
    aprovadaEm: string | null;
    aprovadaPor: PessoaResumoDto | null;
    reprovacaoMotivo: string | null;
  };
  proximoEnvioEm: string | null;
  aguardando: AguardandoDaCampanha | null;
  canais: CanalDaCampanhaDto[];
  contadores: ContadoresDaCampanha;
  /** 0 a 100: destinatários já resolvidos (enviados, falhas, inválidos, excluídos) sobre o total. */
  progresso: number;
  campanhaOrigemId: string | null;
  criadoPor: PessoaResumoDto | null;
  criadoEm: string;
  atualizadoEm: string;
  acoes: AcoesDaCampanha;
}

export type CampanhaResumoDto = Omit<
  CampanhaDto,
  'segmento' | 'texto' | 'assunto' | 'janelaEnvio' | 'ritmo' | 'aprovacao'
>;

export function iso(data: Date | null): string | null {
  return data ? data.toISOString() : null;
}

export function progressoDe(c: ContadoresDaCampanha): number {
  if (c.total <= 0) {
    return 0;
  }
  const resolvidos = c.total - c.pendentes - c.enviando;
  return Math.min(100, Math.round((resolvidos / c.total) * 100));
}

export type CampanhaComRelacoes = Campanha & {
  criadoPor?: PessoaResumoDto | null;
  aprovadaPor?: PessoaResumoDto | null;
};
