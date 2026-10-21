import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';
import { Area, Papel } from '../../generated/prisma/client';
import { ResumoUsuarioDto } from './comum.dto';

/** Por que a pessoa está (ou não) no rodízio. */
export const MOTIVOS_NO_RODIZIO = [
  'MEMBRO_DA_AREA',
  'LIDER_INCLUIDO_PELA_REGRA',
  'INCLUIDO_MANUALMENTE',
] as const;
export type MotivoNoRodizio = (typeof MOTIVOS_NO_RODIZIO)[number];

export class ParticipanteDoRodizioDto extends ResumoUsuarioDto {
  @ApiProperty({ enum: Papel, enumName: 'Papel' })
  papel: Papel;

  @ApiProperty({ enum: MOTIVOS_NO_RODIZIO })
  motivo: MotivoNoRodizio;
}

export class AjusteDoRodizioDto extends ResumoUsuarioDto {
  @ApiProperty({ enum: Papel, enumName: 'Papel' })
  papel: Papel;

  @ApiProperty({ description: 'Ativo no CRM.' })
  ativo: boolean;

  @ApiProperty({
    description:
      'Falso tira a pessoa do rodízio; verdadeiro a inclui (ex.: um líder quando a regra não inclui líderes).',
  })
  participa: boolean;
}

export class RegraDistribuicaoDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ enum: Area, enumName: 'Area' })
  area: Area;

  @ApiProperty({ description: 'O líder da área entra no rodízio.' })
  incluirLideres: boolean;

  @ApiPropertyOptional({
    nullable: true,
    type: ResumoUsuarioDto,
    description: 'O último escolhido (o ponteiro).',
  })
  ultimoUsuario: ResumoUsuarioDto | null;

  @ApiPropertyOptional({
    nullable: true,
    type: ResumoUsuarioDto,
    description:
      'Quem recebe o próximo negócio. Sem participantes: o líder da área ou, sem líder, um C-level (R5.8).',
  })
  proximo: ResumoUsuarioDto | null;

  @ApiProperty({
    type: [ParticipanteDoRodizioDto],
    description: 'Quem está no rodízio agora, na ordem em que recebe.',
  })
  participantes: ParticipanteDoRodizioDto[];

  @ApiProperty({
    type: [AjusteDoRodizioDto],
    description: 'Ajustes manuais (inclusões e exclusões).',
  })
  ajustes: AjusteDoRodizioDto[];

  @ApiProperty({ format: 'date-time' })
  atualizadoEm: string;
}

export class AtualizarRegraDistribuicaoDto {
  @ApiProperty({ description: 'O líder da área entra no rodízio.' })
  @IsBoolean({ message: 'deve ser verdadeiro ou falso' })
  incluirLideres: boolean;
}

export class DefinirParticipacaoDto {
  @ApiProperty({
    description: 'Falso tira a pessoa do rodízio; verdadeiro a inclui.',
  })
  @IsBoolean({ message: 'deve ser verdadeiro ou falso' })
  participa: boolean;
}
