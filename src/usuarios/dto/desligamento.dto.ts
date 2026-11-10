import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import type { Area } from '../../comum/dominio/setores';
import { ChaveDeSetor } from '../../comum/validacao/setor';
import { Papel } from '../../generated/prisma/client';
import {
  MOTIVOS_DESTINATARIO,
  type MotivoDestinatario,
} from '../dominio/destinatario';
import {
  MOTIVOS_DA_PARTE,
  type MotivoDaParte,
  type ParteDosNegocios,
} from '../dominio/divisao-de-negocios';
import { MENSAGEM_PAPEL, MENSAGEM_UUID } from './criar-usuario.dto';
import { idEmMinusculas } from './transformacoes';
import { UsuarioDto, UsuarioResumoDto } from './usuario.dto';

const DESCRICAO_DESTINATARIO =
  'Obrigatório no desligamento de um C-level: o outro C-level ativo que recebe (R7.2). ' +
  'Nos demais casos é opcional e serve de confirmação: se vier, precisa ser o destinatário ' +
  'calculado (o da prévia); se a situação mudou desde a prévia, a resposta é 409.';

/** Pedido de desligamento (R7). */
export class DesligarUsuarioDto {
  @ApiPropertyOptional({ format: 'uuid', description: DESCRICAO_DESTINATARIO })
  @IsOptional()
  @Transform(idEmMinusculas)
  @IsUUID('all', { message: MENSAGEM_UUID })
  destinatarioId?: string;
}

/** Query da prévia do desligamento (R7.1). */
export class ConsultaPreviaDesligamentoDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'C-level desligado: o C-level escolhido, para a prévia já mostrar o destinatário.',
  })
  @IsOptional()
  @Transform(idEmMinusculas)
  @IsUUID('all', { message: MENSAGEM_UUID })
  destinatarioId?: string;
}

/** O que vai (ou foi) para o destinatário. */
export class ContagensEncaminhamentoDto {
  @ApiProperty({ description: 'Atividades pendentes.', example: 12 })
  atividades: number;

  @ApiProperty({ description: 'Negócios abertos.', example: 3 })
  negocios: number;

  @ApiProperty({ example: 40 })
  contatos: number;

  @ApiProperty({ example: 2 })
  empresas: number;

  @ApiProperty({
    description: 'Liderados ativos, que passam a responder ao destinatário.',
    example: 0,
  })
  liderados: number;

  @ApiProperty({
    description:
      'Webhooks de entrada e passagens com o usuário como responsável fixo (passam para o destinatário).',
    example: 0,
  })
  responsavelFixo: number;
}

export class FunilDaParteDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'Contas VIP' })
  nome: string;

  @ApiProperty({
    type: String,
    example: 'COMERCIAL',
    description: 'Setor dono.',
  })
  area: Area;
}

/** Para quem vão os negócios abertos (ajuste da R7.3): uma linha por pessoa. */
export class ParteDosNegociosDto {
  @ApiProperty({ type: UsuarioResumoDto })
  destinatario: UsuarioResumoDto;

  @ApiProperty({
    enum: MOTIVOS_DA_PARTE,
    description:
      '`DESTINATARIO`: o destinatário calculado (R7.2), nos funis em que pode ser responsável (R5.13). `LIDER_DO_SETOR_DO_FUNIL`: o líder ativo do setor dono de um funil em que o destinatário não atua; sem líder, `C_LEVEL` (um C-level ativo) e, no fim, `ADMIN` (quem executa).',
  })
  motivo: MotivoDaParte;

  @ApiProperty({ description: 'Quantos negócios abertos.', example: 2 })
  negocios: number;

  @ApiProperty({
    type: [FunilDaParteDto],
    description: 'Os funis desses negócios.',
  })
  funis: FunilDaParteDto[];

  static de(
    parte: ParteDosNegocios<Parameters<typeof UsuarioResumoDto.de>[0]>,
  ): ParteDosNegociosDto {
    return {
      destinatario: UsuarioResumoDto.de(parte.destinatario),
      motivo: parte.motivo,
      negocios: parte.negocioIds.length,
      funis: parte.funis.map(({ id, nome, area }) => ({ id, nome, area })),
    };
  }
}

const DESCRICAO_DIVISAO =
  'Para quem vai cada parte dos negócios abertos (ajuste da R7.3): a do destinatário primeiro; ' +
  'os de funis em que ele não pode ser responsável (R5.13) vão para o líder do setor dono do funil ' +
  '(sem líder, um C-level; sem C-level, o Admin que executa). Vazia sem negócios abertos ou enquanto ' +
  'o destinatário não está definido (C-level desligado: o C-level escolhido recebe todos).';

/** Prévia do desligamento (R7.1): quem recebe e quanto, antes de confirmar. */
export class PreviaDesligamentoDto {
  @ApiProperty({ type: UsuarioResumoDto })
  usuario: UsuarioResumoDto;

  @ApiPropertyOptional({
    type: UsuarioResumoDto,
    nullable: true,
    description: 'Nulo enquanto o Admin não escolhe (C-level desligado).',
  })
  destinatario: UsuarioResumoDto | null;

  @ApiPropertyOptional({
    enum: MOTIVOS_DESTINATARIO,
    nullable: true,
    description: 'Por que este destinatário (R7.2).',
  })
  motivoDestinatario: MotivoDestinatario | null;

  @ApiProperty({
    example: 'O que está com Pedro (Comercial) vai para o líder, Ana.',
  })
  explicacao: string;

  @ApiProperty({
    description: 'C-level: o Admin precisa escolher outro C-level ativo.',
  })
  exigeEscolha: boolean;

  @ApiProperty({
    type: [UsuarioResumoDto],
    description: 'Quem pode ser escolhido (C-level desligado).',
  })
  candidatos: UsuarioResumoDto[];

  @ApiProperty({
    type: [UsuarioResumoDto],
    description: 'Líderes desligados pulados ao subir na cadeia.',
  })
  ignorados: UsuarioResumoDto[];

  @ApiProperty({ type: ContagensEncaminhamentoDto })
  contagens: ContagensEncaminhamentoDto;

  @ApiProperty({ type: [ParteDosNegociosDto], description: DESCRICAO_DIVISAO })
  divisaoDosNegocios: ParteDosNegociosDto[];

  @ApiProperty({
    type: [UsuarioResumoDto],
    description: 'Liderados ativos, que passam a responder ao destinatário.',
  })
  liderados: UsuarioResumoDto[];

  @ApiProperty({
    description:
      'Desligamento de um líder: os Admins recebem o alerta "equipe sem líder" (R7.3).',
  })
  alertaEquipeSemLider: boolean;
}

/** Contagens do que foi feito no desligamento. */
export class ContagensDesligamentoDto extends ContagensEncaminhamentoDto {
  @ApiProperty({ description: 'Sessões encerradas (R2.4).', example: 2 })
  sessoesRevogadas: number;
}

/** Resultado do desligamento (R7.3, R7.4). */
export class ResultadoDesligamentoDto {
  @ApiProperty({ type: UsuarioDto })
  usuario: UsuarioDto;

  @ApiProperty({ type: UsuarioResumoDto })
  destinatario: UsuarioResumoDto;

  @ApiProperty({ enum: MOTIVOS_DESTINATARIO })
  motivoDestinatario: MotivoDestinatario;

  @ApiProperty({ type: ContagensDesligamentoDto })
  contagens: ContagensDesligamentoDto;

  @ApiProperty({ type: [ParteDosNegociosDto], description: DESCRICAO_DIVISAO })
  divisaoDosNegocios: ParteDosNegociosDto[];
}

/** Reativação (R7.5): exige um líder válido; nada do que foi encaminhado volta. */
export class ReativarUsuarioDto {
  @ApiPropertyOptional({
    enum: Papel,
    enumName: 'Papel',
    description:
      'Novo papel, se a pessoa volta em outra função (padrão: o de antes).',
  })
  @IsOptional()
  @IsEnum(Papel, { message: MENSAGEM_PAPEL })
  papel?: Papel;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'COMERCIAL',
    description:
      'Novo setor (chave), se a pessoa volta em outro setor (padrão: o de antes). Obrigatório para Líder e Membro ' +
      'e precisa estar ativo (R1.9); ignorado para Admin e C-level.',
  })
  @IsOptional()
  @ChaveDeSetor()
  area?: Area | null;

  @ApiPropertyOptional({
    format: 'uuid',
    nullable: true,
    description:
      'Obrigatório para membro (líder ativo do setor) e líder (C-level ativo); Admin e C-level não têm (R1.2, R7.5).',
  })
  @IsOptional()
  @Transform(idEmMinusculas)
  @IsUUID('all', { message: MENSAGEM_UUID })
  liderId?: string | null;
}
