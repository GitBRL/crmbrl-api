import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { PaginacaoDto } from '../../comum/paginacao/paginacao';
import {
  PrioridadeAtividade,
  StatusAtividade,
  TipoAtividade,
  TipoAtor,
} from '../../generated/prisma/client';
import { UsuarioVinculadoDto } from './comum.dto';

export const CONTEUDOS_DA_LINHA_DO_TEMPO = [
  'tudo',
  'eventos',
  'atividades',
  'ligacoes',
] as const;
export type ConteudoDaLinhaDoTempo =
  (typeof CONTEUDOS_DA_LINHA_DO_TEMPO)[number];

export class FiltroDaLinhaDoTempoDto extends PaginacaoDto {
  @ApiPropertyOptional({
    enum: CONTEUDOS_DA_LINHA_DO_TEMPO,
    default: 'tudo',
    description:
      'Tudo (eventos de auditoria, atividades e ligações), só eventos, só atividades ou só ligações.',
  })
  @IsOptional()
  @IsIn(CONTEUDOS_DA_LINHA_DO_TEMPO, {
    message: `deve ser um destes valores: ${CONTEUDOS_DA_LINHA_DO_TEMPO.join(', ')}`,
  })
  incluir: ConteudoDaLinhaDoTempo = 'tudo';
}

/** Evento de auditoria na linha do tempo (sem IP, user agent nem id da requisição). */
export class EventoDaLinhaDoTempoDto {
  @ApiProperty({
    example: '1024',
    description: 'Id sequencial do evento (texto).',
  })
  id: string;

  @ApiProperty({ example: 'contato.reconvertido' })
  acao: string;

  @ApiProperty({ example: 'contato' })
  entidade: string;

  @ApiProperty({ type: String, nullable: true })
  entidadeId: string | null;

  @ApiProperty({
    example: 'Contato "Maria Souza" reconvertido (WEBHOOK: Landing)',
  })
  resumo: string;

  @ApiPropertyOptional({
    nullable: true,
    type: 'object',
    additionalProperties: true,
    description:
      'Campos alterados (`alteracoes: { campo: { antes, depois } }`) e outros detalhes.',
  })
  dados: unknown;

  @ApiProperty({ enum: TipoAtor, enumName: 'TipoAtor' })
  tipoAtor: TipoAtor;

  @ApiProperty({ type: String, nullable: true, format: 'uuid' })
  usuarioId: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'Ana Lima',
    description:
      'Nome de quem fez (usuário, webhook, job) no momento do evento.',
  })
  atorDescricao: string | null;

  @ApiProperty({ format: 'date-time' })
  criadoEm: string;
}

/** Atividade na linha do tempo (R3.5, R6). */
export class AtividadeDaLinhaDoTempoDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ enum: TipoAtividade, enumName: 'TipoAtividade' })
  tipo: TipoAtividade;

  @ApiProperty({ example: 'Ligar para apresentar a proposta' })
  titulo: string;

  @ApiProperty({ type: String, nullable: true })
  descricao: string | null;

  @ApiProperty({ enum: StatusAtividade, enumName: 'StatusAtividade' })
  status: StatusAtividade;

  @ApiProperty({ enum: PrioridadeAtividade, enumName: 'PrioridadeAtividade' })
  prioridade: PrioridadeAtividade;

  @ApiProperty({
    description:
      'Pendente com vencimento no passado (R6.3); na reunião, conta o fim.',
  })
  atrasada: boolean;

  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  venceEm: string | null;

  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  inicioEm: string | null;

  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  fimEm: string | null;

  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  concluidaEm: string | null;

  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  canceladaEm: string | null;

  @ApiProperty({ type: () => UsuarioVinculadoDto })
  responsavel: UsuarioVinculadoDto;

  @ApiProperty({ type: () => UsuarioVinculadoDto, nullable: true })
  criadoPor: UsuarioVinculadoDto | null;

  @ApiProperty({ type: String, nullable: true, format: 'uuid' })
  contatoId: string | null;

  @ApiProperty({ type: String, nullable: true, format: 'uuid' })
  empresaId: string | null;

  @ApiProperty({ type: String, nullable: true, format: 'uuid' })
  negocioId: string | null;

  @ApiProperty({ format: 'date-time' })
  criadoEm: string;
}

/** Ligação do WhatsApp na linha do tempo (R29.8): só a quem vê a ligação (R12). O painel completo abre em `/atendimento/ligacoes/:id`. */
export class LigacaoDaLinhaDoTempoDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ enum: ['RECEBIDA', 'FEITA'] }) direcao: string;
  @ApiProperty({
    enum: [
      'ENCERRADA',
      'PERDIDA',
      'RECUSADA',
      'SEM_RESPOSTA',
      'FALHOU',
      'CHAMANDO',
      'TOCANDO',
      'EM_ANDAMENTO',
    ],
  })
  estado: string;
  @ApiProperty({
    enum: ['atendida', 'perdida', 'recusada', 'sem_resposta', 'falhou'],
    nullable: true,
    type: String,
    description: 'Nulo enquanto a ligação está em curso.',
  })
  resultado: string | null;
  @ApiProperty({ type: String, nullable: true }) motivoTexto: string | null;
  @ApiProperty({ type: Number, nullable: true }) duracaoSegundos: number | null;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' })
  conversaId: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' })
  canalId: string | null;
  @ApiProperty({ type: String, nullable: true }) canalNome: string | null;
  @ApiProperty({ type: () => UsuarioVinculadoDto, nullable: true })
  atendente: UsuarioVinculadoDto | null;
  @ApiProperty({ format: 'date-time' }) iniciadaEm: string;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  encerradaEm: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Assunto do resumo, quando já está pronto.',
  })
  resumoAssunto: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Primeiros pontos do resumo (até 240 caracteres), quando já está pronto.',
  })
  resumoTrecho: string | null;
  @ApiProperty({ description: 'Há gravação para ouvir (e não foi apagada).' })
  temGravacao: boolean;
  @ApiProperty({ description: 'Há transcrição pronta.' })
  temTranscricao: boolean;
}

/**
 * Item da linha do tempo de um contato, empresa ou negócio (R3.5): um evento
 * de auditoria ou uma atividade, ordenados por `ocorridoEm` (mais recentes
 * primeiro; atividades futuras, como reuniões marcadas, aparecem no topo).
 */
export class RegistroDaLinhaDoTempoDto {
  @ApiProperty({ enum: ['evento', 'atividade', 'ligacao'] })
  tipo: 'evento' | 'atividade' | 'ligacao';

  @ApiProperty({
    format: 'date-time',
    description:
      'Evento: quando aconteceu. Ligação: quando começou. Atividade: concluída/cancelada em, senão início (reunião), vencimento ou criação.',
  })
  ocorridoEm: string;

  @ApiProperty({ type: () => EventoDaLinhaDoTempoDto, nullable: true })
  evento: EventoDaLinhaDoTempoDto | null;

  @ApiProperty({ type: () => AtividadeDaLinhaDoTempoDto, nullable: true })
  atividade: AtividadeDaLinhaDoTempoDto | null;

  @ApiProperty({
    type: () => LigacaoDaLinhaDoTempoDto,
    nullable: true,
    description: 'Preenchido quando `tipo` é `ligacao`.',
  })
  ligacao: LigacaoDaLinhaDoTempoDto | null;
}
