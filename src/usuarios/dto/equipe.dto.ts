import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { Area } from '../../generated/prisma/client';
import { MENSAGEM_UUID } from './criar-usuario.dto';
import { MENSAGEM_AREA } from './filtro-usuarios.dto';
import { idEmMinusculas } from './transformacoes';
import { UsuarioResumoDto } from './usuario.dto';

/** Filtros da visão de equipes. */
export class FiltroEquipesDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Só a equipe deste líder (ou C-level). O líder só consulta a própria equipe.',
  })
  @IsOptional()
  @Transform(idEmMinusculas)
  @IsUUID('all', { message: MENSAGEM_UUID })
  liderId?: string;

  @ApiPropertyOptional({
    enum: Area,
    enumName: 'Area',
    description: 'Só as equipes de líderes desta área.',
  })
  @IsOptional()
  @IsEnum(Area, { message: MENSAGEM_AREA })
  area?: Area;
}

/** Carga de trabalho de uma pessoa. */
export class IndicadoresDto {
  @ApiProperty({ example: 12 })
  atividadesPendentes: number;

  @ApiProperty({
    description: 'Pendentes com vencimento no passado (R6.3).',
    example: 2,
  })
  atividadesAtrasadas: number;

  @ApiProperty({ example: 5 })
  negociosAbertos: number;

  @ApiProperty({
    description: 'Soma do valor dos negócios abertos, em reais.',
    example: '15000.00',
  })
  valorEmAberto: string;

  @ApiProperty({ description: 'Contatos de que é responsável.', example: 40 })
  contatos: number;
}

/** Uma pessoa na visão de equipe. */
export class MembroDaEquipeDto {
  @ApiProperty({ type: UsuarioResumoDto })
  usuario: UsuarioResumoDto;

  @ApiProperty({ type: IndicadoresDto })
  indicadores: IndicadoresDto;

  @ApiProperty({
    description:
      'Responde provisoriamente a quem não é o líder que o papel exige (depois de um desligamento, R7.3): o Admin precisa definir um novo líder.',
  })
  aguardandoNovoLider: boolean;
}

/** Uma equipe: o líder (ou C-level) e quem responde a ele. */
export class EquipeDto {
  @ApiProperty({ type: MembroDaEquipeDto })
  lider: MembroDaEquipeDto;

  @ApiPropertyOptional({
    enum: Area,
    enumName: 'Area',
    nullable: true,
    description: 'Área da equipe; nula para a equipe de um C-level.',
  })
  area: Area | null;

  @ApiProperty({ type: [MembroDaEquipeDto] })
  membros: MembroDaEquipeDto[];
}
