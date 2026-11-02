import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import {
  EstrategiaDistribuicao,
  type Prisma,
} from '../../generated/prisma/client';
import {
  aparar,
  OpcionalNaoNulo,
  ResumoEtapaDto,
  ResumoFunilDto,
  ResumoUsuarioDto,
} from './comum.dto';

const MENSAGEM_UUID = 'deve ser um identificador (UUID) válido';
const MENSAGEM_ESTRATEGIA =
  'deve ser RODIZIO, RESPONSAVEL_FIXO ou LIDER_DA_AREA';

const RESUMO_ETAPA = {
  select: { id: true, nome: true, tipo: true, ordem: true },
} as const;
const RESUMO_FUNIL = { select: { id: true, nome: true, area: true } } as const;

/** `include` de uma passagem na listagem e no detalhe. */
export const INCLUIR_PASSAGEM = {
  funilOrigem: RESUMO_FUNIL,
  etapaGatilho: RESUMO_ETAPA,
  funilDestino: RESUMO_FUNIL,
  etapaDestino: RESUMO_ETAPA,
  responsavelFixo: { select: { id: true, nome: true, avatarUrl: true } },
  _count: { select: { execucoes: true } },
} satisfies Prisma.PassagemInclude;

export type PassagemCompleta = Prisma.PassagemGetPayload<{
  include: typeof INCLUIR_PASSAGEM;
}>;

export class PassagemDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description:
      'Identifica as passagens da configuração inicial (`marketing_comercial`, `comercial_cs`).',
  })
  chave: string | null;

  @ApiProperty({ example: 'Marketing → Comercial' })
  nome: string;

  @ApiProperty({ type: ResumoFunilDto })
  funilOrigem: ResumoFunilDto;

  @ApiProperty({
    type: ResumoEtapaDto,
    description: 'Entrar nesta etapa dispara a passagem.',
  })
  etapaGatilho: ResumoEtapaDto;

  @ApiProperty({ type: ResumoFunilDto })
  funilDestino: ResumoFunilDto;

  @ApiProperty({
    type: ResumoEtapaDto,
    description: 'Etapa (aberta) onde o negócio criado entra.',
  })
  etapaDestino: ResumoEtapaDto;

  @ApiProperty({
    enum: EstrategiaDistribuicao,
    enumName: 'EstrategiaDistribuicao',
  })
  estrategia: EstrategiaDistribuicao;

  @ApiPropertyOptional({ nullable: true, type: ResumoUsuarioDto })
  responsavelFixo: ResumoUsuarioDto | null;

  @ApiProperty()
  ativa: boolean;

  @ApiProperty({
    description: 'Quantas vezes já rodou (uma por negócio de origem).',
    example: 12,
  })
  execucoes: number;

  @ApiProperty({ format: 'date-time' })
  criadoEm: string;

  @ApiProperty({ format: 'date-time' })
  atualizadoEm: string;

  static de(passagem: PassagemCompleta): PassagemDto {
    return {
      id: passagem.id,
      chave: passagem.chave,
      nome: passagem.nome,
      funilOrigem: passagem.funilOrigem,
      etapaGatilho: passagem.etapaGatilho,
      funilDestino: passagem.funilDestino,
      etapaDestino: passagem.etapaDestino,
      estrategia: passagem.estrategia,
      responsavelFixo: passagem.responsavelFixo,
      ativa: passagem.ativa,
      execucoes: passagem._count.execucoes,
      criadoEm: passagem.criadoEm.toISOString(),
      atualizadoEm: passagem.atualizadoEm.toISOString(),
    };
  }
}

export class CriarPassagemDto {
  @ApiProperty({ example: 'Comercial → Parcerias', maxLength: 100 })
  @Transform(aparar)
  @IsString({ message: 'deve ser um texto' })
  @IsNotEmpty({ message: 'é obrigatório' })
  @MaxLength(100, { message: 'deve ter no máximo 100 caracteres' })
  nome: string;

  @ApiProperty({
    format: 'uuid',
    description: 'Etapa que dispara a passagem (define o funil de origem).',
  })
  @IsUUID('all', { message: MENSAGEM_UUID })
  etapaGatilhoId: string;

  @ApiProperty({
    format: 'uuid',
    description:
      'Etapa aberta de outro funil onde o negócio entra (define o funil de destino).',
  })
  @IsUUID('all', { message: MENSAGEM_UUID })
  etapaDestinoId: string;

  @ApiPropertyOptional({
    enum: EstrategiaDistribuicao,
    enumName: 'EstrategiaDistribuicao',
    default: EstrategiaDistribuicao.RODIZIO,
  })
  @OpcionalNaoNulo()
  @IsEnum(EstrategiaDistribuicao, { message: MENSAGEM_ESTRATEGIA })
  estrategia?: EstrategiaDistribuicao;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Obrigatório com `RESPONSAVEL_FIXO`.',
  })
  @IsOptional()
  @IsUUID('all', { message: MENSAGEM_UUID })
  responsavelFixoId?: string | null;

  @ApiPropertyOptional({ default: true })
  @OpcionalNaoNulo()
  @IsBoolean({ message: 'deve ser verdadeiro ou falso' })
  ativa?: boolean;
}

export class AtualizarPassagemDto {
  @ApiPropertyOptional({ maxLength: 100 })
  @OpcionalNaoNulo()
  @Transform(aparar)
  @IsString({ message: 'deve ser um texto' })
  @IsNotEmpty({ message: 'é obrigatório' })
  @MaxLength(100, { message: 'deve ter no máximo 100 caracteres' })
  nome?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @OpcionalNaoNulo()
  @IsUUID('all', { message: MENSAGEM_UUID })
  etapaGatilhoId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @OpcionalNaoNulo()
  @IsUUID('all', { message: MENSAGEM_UUID })
  etapaDestinoId?: string;

  @ApiPropertyOptional({
    enum: EstrategiaDistribuicao,
    enumName: 'EstrategiaDistribuicao',
  })
  @OpcionalNaoNulo()
  @IsEnum(EstrategiaDistribuicao, { message: MENSAGEM_ESTRATEGIA })
  estrategia?: EstrategiaDistribuicao;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    format: 'uuid',
    description: '`null` tira o responsável fixo.',
  })
  @IsOptional()
  @IsUUID('all', { message: MENSAGEM_UUID })
  responsavelFixoId?: string | null;

  @ApiPropertyOptional()
  @OpcionalNaoNulo()
  @IsBoolean({ message: 'deve ser verdadeiro ou falso' })
  ativa?: boolean;
}
