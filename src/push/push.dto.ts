import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import type { PushInscricao } from '../generated/prisma/client';

const aparar = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class ChavePublicaPushDto {
  @ApiProperty({
    description:
      'Chave pública VAPID (base64url) para o `applicationServerKey` do `pushManager.subscribe`.',
  })
  chavePublica: string;
}

export class ChavesDaInscricaoDto {
  @ApiProperty({ description: 'Chave pública do aparelho (base64url).' })
  @IsString({ message: 'deve ser um texto' })
  @Matches(/^[A-Za-z0-9_-]{80,100}$/, {
    message: 'chave p256dh inválida (base64url)',
  })
  p256dh: string;

  @ApiProperty({ description: 'Segredo de autenticação (base64url).' })
  @IsString({ message: 'deve ser um texto' })
  @Matches(/^[A-Za-z0-9_-]{16,32}$/, {
    message: 'segredo auth inválido (base64url)',
  })
  auth: string;
}

export class InscreverPushDto {
  @ApiProperty({
    description:
      'Endereço do serviço de push do navegador (`subscription.endpoint`).',
  })
  @IsString({ message: 'deve ser um texto' })
  @Transform(aparar)
  @MinLength(10, { message: 'endereço inválido' })
  @MaxLength(2048, { message: 'no máximo 2048 caracteres' })
  endpoint: string;

  @ApiProperty({ type: ChavesDaInscricaoDto })
  @IsObject({ message: 'deve ser um objeto' })
  @ValidateNested()
  @Type(() => ChavesDaInscricaoDto)
  keys: ChavesDaInscricaoDto;

  @ApiProperty({
    description:
      'Nome do aparelho para a pessoa reconhecer (ex.: "Chrome no Android").',
    example: 'Chrome no Android',
  })
  @IsString({ message: 'deve ser um texto' })
  @Transform(aparar)
  @MinLength(1, { message: 'informe o aparelho' })
  @MaxLength(120, { message: 'no máximo 120 caracteres' })
  aparelho: string;
}

export class InscricaoCriadaDto {
  @ApiProperty({ format: 'uuid' })
  id: string;
}

export class InscricaoPushDto {
  @ApiProperty({ format: 'uuid' })
  id: string;
  @ApiProperty()
  aparelho: string;
  @ApiProperty({
    description:
      'Só o servidor do serviço de push (o endereço completo é segredo).',
    example: 'fcm.googleapis.com',
  })
  servico: string;
  @ApiProperty({ type: String, format: 'date-time' })
  criadoEm: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  ultimoEnvioEm: string | null;
  @ApiProperty({ type: String, nullable: true })
  ultimoErro: string | null;

  static de(inscricao: PushInscricao): InscricaoPushDto {
    return {
      id: inscricao.id,
      aparelho: inscricao.aparelho,
      servico: URL.canParse(inscricao.endpoint)
        ? new URL(inscricao.endpoint).host
        : '',
      criadoEm: inscricao.criadoEm.toISOString(),
      ultimoEnvioEm: inscricao.ultimoEnvioEm?.toISOString() ?? null,
      ultimoErro: inscricao.ultimoErro,
    };
  }
}

export class TiposDePreferenciaDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean({ message: 'deve ser verdadeiro ou falso' })
  conversa_atribuida?: boolean;
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean({ message: 'deve ser verdadeiro ou falso' })
  mencao?: boolean;
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean({ message: 'deve ser verdadeiro ou falso' })
  atividade_vencendo?: boolean;
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean({ message: 'deve ser verdadeiro ou falso' })
  sla_estourado?: boolean;
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean({ message: 'deve ser verdadeiro ou falso' })
  negocio_atribuido?: boolean;
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean({ message: 'deve ser verdadeiro ou falso' })
  parcela_atrasada?: boolean;
  @ApiPropertyOptional({
    description: 'Ligação do WhatsApp tocando ou perdida (R29).',
  })
  @IsOptional()
  @IsBoolean({ message: 'deve ser verdadeiro ou falso' })
  ligacao_recebida?: boolean;
}

export class AlterarPreferenciasPushDto {
  @ApiProperty({
    type: TiposDePreferenciaDto,
    description: 'Os tipos enviados mudam; os omitidos ficam como estão.',
  })
  @IsObject({ message: 'deve ser um objeto' })
  @ValidateNested()
  @Type(() => TiposDePreferenciaDto)
  tipos: TiposDePreferenciaDto;
}

export class PreferenciasPushDto {
  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'boolean' },
    example: {
      conversa_atribuida: true,
      mencao: true,
      atividade_vencendo: true,
      sla_estourado: true,
      negocio_atribuido: true,
      parcela_atrasada: true,
      ligacao_recebida: true,
    },
  })
  tipos: Record<string, boolean>;
}

export class ResultadoDoTestePushDto {
  @ApiProperty({ description: 'Aparelhos que receberam.' })
  enviados: number;
  @ApiProperty({
    description: 'Aparelhos em que o envio falhou (podem tentar de novo).',
  })
  falhas: number;
  @ApiProperty({ description: 'Inscrições expiradas, removidas agora.' })
  removidas: number;
}
