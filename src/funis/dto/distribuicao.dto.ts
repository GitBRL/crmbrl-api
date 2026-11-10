import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';
import { Papel } from '../../generated/prisma/client';
import { ResumoUsuarioDto } from './comum.dto';
import type { Area } from '../../comum/dominio/setores';

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

/**
 * Por que alguém que a regra (ou um ajuste) poria no rodízio ainda está fora
 * dele (ajuste da R5.8): o rodízio só inclui quem já ativou o acesso.
 */
export const MOTIVOS_AGUARDANDO_ACESSO = [
  'CONVITE_PENDENTE',
  'PRIMEIRO_ACESSO_PENDENTE',
] as const;
export type MotivoAguardandoAcesso = (typeof MOTIVOS_AGUARDANDO_ACESSO)[number];

export class AguardandoAcessoDto extends ResumoUsuarioDto {
  @ApiProperty({ enum: Papel, enumName: 'Papel' })
  papel: Papel;

  @ApiProperty({
    enum: MOTIVOS_AGUARDANDO_ACESSO,
    description:
      '`CONVITE_PENDENTE`: ainda não definiu a senha pelo link do convite. `PRIMEIRO_ACESSO_PENDENTE`: tem a senha temporária e ainda não concluiu o primeiro login (a troca dela).',
  })
  motivo: MotivoAguardandoAcesso;
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

  @ApiProperty({ type: String, example: 'COMERCIAL' })
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

  @ApiProperty({
    type: [AguardandoAcessoDto],
    description:
      'Quem a regra (ou um ajuste) poria no rodízio, mas ainda não ativou o acesso: fica fora da fila e entra sozinho ao concluir o primeiro login ou definir a senha do convite (R5.8).',
  })
  aguardandoAcesso: AguardandoAcessoDto[];

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
