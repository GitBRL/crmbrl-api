import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import {
  aparar,
  apararOuNulo,
  CamposComunsDoCanalDto,
  CanalBaseDto,
  maximo,
  MENSAGEM_OBRIGATORIO,
  MENSAGEM_TEXTO,
} from '../comum/dto-comum';
import { TemplateDoCanalDto } from '../templates-canal.dto';
import { CAMPOS_DO_WEBHOOK_OFICIAL } from './formato-meta';

const ID_DA_META = { message: 'deve ser o id numérico da Meta (só dígitos)' };

export class CriarCanalOficialDto extends CamposComunsDoCanalDto {
  @ApiProperty({
    example: '100000000000001',
    description: 'Id do número (`phone_number_id`) na Meta.',
  })
  @Transform(aparar)
  @IsString(MENSAGEM_TEXTO)
  @Matches(/^\d{5,30}$/, ID_DA_META)
  phoneNumberId: string;

  @ApiProperty({
    example: '200000000000001',
    description: 'Id da conta do WhatsApp Business (WABA): templates.',
  })
  @Transform(aparar)
  @IsString(MENSAGEM_TEXTO)
  @Matches(/^\d{5,30}$/, ID_DA_META)
  wabaId: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: '+55 11 99999-0000',
    description:
      'Número exibido, como a Meta o mostra. Em branco, o "Testar conexão" preenche.',
  })
  @Transform(apararOuNulo)
  @IsOptional()
  @IsString(MENSAGEM_TEXTO)
  @MaxLength(40, maximo(40))
  numeroExibido?: string | null;

  @ApiProperty({
    description:
      'Token de acesso de usuário do sistema (cifrado; envia as mensagens).',
  })
  @IsString(MENSAGEM_TEXTO)
  @IsNotEmpty(MENSAGEM_OBRIGATORIO)
  @MaxLength(1000, maximo(1000))
  token: string;

  @ApiProperty({
    description: 'App secret (cifrado; confere a assinatura do webhook).',
  })
  @IsString(MENSAGEM_TEXTO)
  @IsNotEmpty(MENSAGEM_OBRIGATORIO)
  @MaxLength(200, maximo(200))
  appSecret: string;
}

/** Edição: segredos ausentes = mantém os gravados. */
export class AtualizarCanalOficialDto extends PartialType(
  CriarCanalOficialDto,
) {}

export class WebhookOficialDto {
  @ApiProperty({
    example: 'https://crm.brl.com.br/api/v1/publico/meta/webhook',
    description:
      'URL de retorno (callback) para o painel do app na Meta (a mesma do Instagram e do Messenger).',
  })
  url: string;

  @ApiProperty({ description: 'Verify token para colar no painel da Meta.' })
  tokenVerificacao: string;

  @ApiProperty({
    type: [String],
    example: CAMPOS_DO_WEBHOOK_OFICIAL,
    description: 'Campos a assinar no painel (WhatsApp > Configuração).',
  })
  campos: string[];
}

export class EstadoDoCanalOficialDto {
  @ApiProperty({
    enum: ['CONECTADO', 'ERRO', 'NAO_TESTADO'],
    description:
      '`ERRO`: o último teste, envio ou sincronização falhou (`motivo`); `CONECTADO`: o último teste passou.',
  })
  situacao: 'CONECTADO' | 'ERRO' | 'NAO_TESTADO';

  @ApiPropertyOptional({ type: String, nullable: true })
  motivo: string | null;

  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  conferidoEm: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Nome verificado na Meta.',
  })
  nomeVerificado: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'GREEN',
    description: 'Qualidade do número (`quality_rating`).',
  })
  qualidade: string | null;
}

export class ResumoDosTemplatesDto {
  @ApiProperty()
  total: number;

  @ApiProperty()
  aprovados: number;

  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  sincronizadoEm: string | null;
}

export class CanalOficialDto extends CanalBaseDto {
  @ApiProperty({ example: '100000000000001' })
  phoneNumberId: string;

  @ApiProperty({ example: '200000000000001' })
  wabaId: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  numeroExibido: string | null;

  @ApiProperty({ type: String, nullable: true, example: '••••••••Zx0P' })
  token: string | null;

  @ApiProperty({ type: String, nullable: true, example: '••••••••3f9a' })
  appSecret: string | null;

  @ApiProperty({ type: WebhookOficialDto })
  webhook: WebhookOficialDto;

  @ApiProperty({ type: EstadoDoCanalOficialDto })
  estado: EstadoDoCanalOficialDto;

  @ApiProperty({ type: ResumoDosTemplatesDto })
  templates: ResumoDosTemplatesDto;
}

export class TesteDoCanalOficialDto {
  @ApiProperty()
  ok: boolean;

  @ApiProperty({ example: 'Conectado ao número +55 11 99999-0000 (Loja BRL).' })
  mensagem: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  numeroExibido: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  nomeVerificado: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  qualidade: string | null;
}

export class SincronizacaoDeTemplatesDto {
  @ApiProperty()
  total: number;

  @ApiProperty()
  aprovados: number;

  @ApiProperty({ format: 'date-time' })
  sincronizadoEm: string;

  @ApiProperty({ type: [TemplateDoCanalDto] })
  itens: TemplateDoCanalDto[];
}

export class TokenDeVerificacaoOficialDto {
  @ApiProperty()
  tokenVerificacao: string;
}
