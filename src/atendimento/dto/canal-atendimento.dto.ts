import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { TipoCanal } from '../../generated/prisma/client';
import type { HorarioDeAtendimento } from '../horario';
import {
  apararOuNulo,
  MENSAGEM_UUID,
  OpcionalNaoNulo,
  ResumoFilaDto,
} from './comum.dto';

/** Tamanho máximo das mensagens automáticas do canal. */
export const TAMANHO_MAXIMO_AUTOMATICA = 1000;

export class HorarioDto implements HorarioDeAtendimento {
  @ApiProperty({ example: 'America/Sao_Paulo' })
  fusoHorario: string;

  @ApiProperty({
    description:
      'Intervalos por dia da semana, de "0" (domingo) a "6" (sábado). Dia ausente ou vazio = fechado.',
    type: 'object',
    additionalProperties: {
      type: 'array',
      items: {
        type: 'object',
        required: ['inicio', 'fim'],
        properties: {
          inicio: { type: 'string', example: '08:00' },
          fim: { type: 'string', example: '18:00' },
        },
      },
    },
    example: {
      '1': [
        { inicio: '08:00', fim: '12:00' },
        { inicio: '13:00', fim: '18:00' },
      ],
    },
  })
  dias: HorarioDeAtendimento['dias'];
}

export class SituacaoDoHorarioDto {
  @ApiProperty({ description: 'Atende agora.' })
  aberto: boolean;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    format: 'date-time',
    description: 'Fechado: quando abre de novo.',
  })
  proximaAbertura: string | null;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    format: 'date-time',
    description: 'Aberto: quando fecha (nulo = não fecha nos próximos dias).',
  })
  proximoFechamento: string | null;
}

/** Um canal com a configuração de atendimento (R12). */
export class CanalDoAtendimentoDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ enum: TipoCanal, enumName: 'TipoCanal' })
  tipo: TipoCanal;

  @ApiProperty()
  nome: string;

  @ApiProperty()
  ativo: boolean;

  @ApiProperty({
    description:
      'O módulo do canal está instalado nesta API (dá para enviar por ele).',
  })
  disponivel: boolean;

  @ApiPropertyOptional({
    nullable: true,
    type: ResumoFilaDto,
    description:
      'Fila das conversas novas. Nula: as conversas ficam sem fila (só Admin e C-level veem).',
  })
  filaPadrao: ResumoFilaDto | null;

  @ApiPropertyOptional({
    nullable: true,
    type: HorarioDto,
    description: 'Nulo = atende 24 horas.',
  })
  horarioAtendimento: HorarioDto | null;

  @ApiProperty({ type: SituacaoDoHorarioDto })
  situacaoHorario: SituacaoDoHorarioDto;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description:
      'Resposta automática fora do horário (uma vez por conversa em cada período fechado). Nula = não responde.',
  })
  mensagemForaHorario: string | null;

  @ApiProperty({
    description: 'Pede a nota de 1 a 5 ao resolver a conversa (vale por 24 h).',
  })
  pesquisaSatisfacao: boolean;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description:
      'Pergunta da pesquisa. Nula = a pergunta padrão (`perguntaPadrao`).',
  })
  mensagemSatisfacao: string | null;

  @ApiProperty({
    description: 'A pergunta usada quando o canal não define a sua.',
  })
  perguntaPadrao: string;

  @ApiProperty()
  conversasEmAberto: number;

  @ApiPropertyOptional({ nullable: true, type: String })
  ultimoErro: string | null;

  @ApiPropertyOptional({ nullable: true, type: String, format: 'date-time' })
  ultimoErroEm: string | null;

  @ApiProperty({ description: 'A pessoa pode alterar a configuração.' })
  podeEditar: boolean;
}

/**
 * `PATCH /atendimento/canais/:id`: só os campos enviados mudam. `null` limpa
 * (fila padrão, horário = 24 h, mensagens = padrão/nenhuma).
 */
export class AtualizarAtendimentoDoCanalDto {
  @ApiPropertyOptional({ nullable: true, type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID('all', { message: MENSAGEM_UUID })
  filaPadraoId?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    type: HorarioDto,
    description: 'Nulo = 24 horas.',
  })
  @IsOptional()
  @IsObject({ message: 'deve ter o fuso e os dias da semana' })
  horarioAtendimento?: Record<string, unknown> | null;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    maxLength: TAMANHO_MAXIMO_AUTOMATICA,
  })
  @IsOptional()
  @Transform(apararOuNulo)
  @IsString({ message: 'deve ser um texto' })
  @MaxLength(TAMANHO_MAXIMO_AUTOMATICA, {
    message: `deve ter no máximo ${TAMANHO_MAXIMO_AUTOMATICA} caracteres`,
  })
  mensagemForaHorario?: string | null;

  @ApiPropertyOptional()
  @OpcionalNaoNulo()
  @IsBoolean({ message: 'deve ser verdadeiro ou falso' })
  pesquisaSatisfacao?: boolean;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    maxLength: TAMANHO_MAXIMO_AUTOMATICA,
  })
  @IsOptional()
  @Transform(apararOuNulo)
  @IsString({ message: 'deve ser um texto' })
  @MaxLength(TAMANHO_MAXIMO_AUTOMATICA, {
    message: `deve ter no máximo ${TAMANHO_MAXIMO_AUTOMATICA} caracteres`,
  })
  mensagemSatisfacao?: string | null;
}
