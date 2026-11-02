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
] as const;
export type ConteudoDaLinhaDoTempo =
  (typeof CONTEUDOS_DA_LINHA_DO_TEMPO)[number];

export class FiltroDaLinhaDoTempoDto extends PaginacaoDto {
  @ApiPropertyOptional({
    enum: CONTEUDOS_DA_LINHA_DO_TEMPO,
    default: 'tudo',
    description: 'Eventos de auditoria, atividades ou os dois.',
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

/**
 * Item da linha do tempo de um contato, empresa ou negócio (R3.5): um evento
 * de auditoria ou uma atividade, ordenados por `ocorridoEm` (mais recentes
 * primeiro; atividades futuras, como reuniões marcadas, aparecem no topo).
 */
export class RegistroDaLinhaDoTempoDto {
  @ApiProperty({ enum: ['evento', 'atividade'] })
  tipo: 'evento' | 'atividade';

  @ApiProperty({
    format: 'date-time',
    description:
      'Evento: quando aconteceu. Atividade: concluída/cancelada em, senão início (reunião), vencimento ou criação.',
  })
  ocorridoEm: string;

  @ApiProperty({ type: () => EventoDaLinhaDoTempoDto, nullable: true })
  evento: EventoDaLinhaDoTempoDto | null;

  @ApiProperty({ type: () => AtividadeDaLinhaDoTempoDto, nullable: true })
  atividade: AtividadeDaLinhaDoTempoDto | null;
}
