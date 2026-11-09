import {
  ApiProperty,
  ApiPropertyOptional,
  OmitType,
  PartialType,
} from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsIn,
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
import {
  CAMPOS_DO_WEBHOOK,
  TIPOS_META,
  type TipoCanalMeta,
} from './eventos-meta';

const ID_DA_META = {
  message: 'deve ser o id numérico da Meta (só dígitos)',
};

export class CriarCanalMetaDto extends CamposComunsDoCanalDto {
  @ApiProperty({ enum: TIPOS_META, description: 'Instagram ou Messenger.' })
  @IsIn(TIPOS_META, {
    message: `deve ser um destes valores: ${TIPOS_META.join(', ')}`,
  })
  tipo: TipoCanalMeta;

  @ApiPropertyOptional({
    example: '1234567890123456',
    description:
      'Id do app na Meta ("Usar outro app"). Sem `appId` e `appSecret`, o canal usa o app cadastrado em Configurações > Apps de login (422 se ainda não foi cadastrado). Os dois vêm juntos.',
  })
  @IsOptional()
  @Transform(aparar)
  @IsString(MENSAGEM_TEXTO)
  @Matches(/^\d{5,30}$/, ID_DA_META)
  appId?: string;

  @ApiPropertyOptional({
    description:
      'App secret de um app próprio (cifrado; confere a assinatura do webhook). Vem junto com `appId`.',
  })
  @IsOptional()
  @IsString(MENSAGEM_TEXTO)
  @IsNotEmpty(MENSAGEM_OBRIGATORIO)
  @MaxLength(200, maximo(200))
  appSecret?: string;

  @ApiProperty({
    example: '109876543210987',
    description: 'Id da página do Facebook.',
  })
  @Transform(aparar)
  @IsString(MENSAGEM_TEXTO)
  @Matches(/^\d{5,30}$/, ID_DA_META)
  pageId: string;

  @ApiProperty({
    description: 'Token de acesso da página (cifrado; envia as mensagens).',
  })
  @IsString(MENSAGEM_TEXTO)
  @IsNotEmpty(MENSAGEM_OBRIGATORIO)
  @MaxLength(1000, maximo(1000))
  tokenPagina: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: '17841400000000000',
    description:
      'Id da conta profissional do Instagram (obrigatório no Instagram).',
  })
  @Transform(apararOuNulo)
  @IsOptional()
  @IsString(MENSAGEM_TEXTO)
  @Matches(/^\d{5,30}$/, ID_DA_META)
  instagramId?: string | null;
}

/** Edição: o tipo não muda; segredos ausentes = mantém os gravados. */
export class AtualizarCanalMetaDto extends PartialType(
  OmitType(CriarCanalMetaDto, ['tipo'] as const),
) {}

export class WebhookDoCanalDto {
  @ApiProperty({
    example: 'https://crm.brl.com.br/api/v1/publico/meta/webhook',
    description: 'URL de retorno (callback) para o painel do app na Meta.',
  })
  url: string;

  @ApiProperty({
    description: 'Token de verificação para colar no painel da Meta.',
  })
  tokenVerificacao: string;

  @ApiProperty({ type: [String], example: CAMPOS_DO_WEBHOOK })
  campos: string[];
}

export class CanalMetaDto extends CanalBaseDto {
  @ApiProperty({ example: '1234567890123456' })
  appId: string;

  @ApiProperty({
    description:
      'Verdadeiro: o ID e o segredo são cópia do app das Configurações (acompanham as trocas dele). Falso: app próprio.',
  })
  appDasConfiguracoes: boolean;

  @ApiProperty({ example: '109876543210987' })
  pageId: string;

  @ApiProperty({ type: String, nullable: true })
  instagramId: string | null;

  @ApiProperty({ type: String, nullable: true, example: '••••••••3f9a' })
  appSecret: string | null;

  @ApiProperty({ type: String, nullable: true, example: '••••••••Zx0P' })
  tokenPagina: string | null;

  @ApiProperty({ type: WebhookDoCanalDto })
  webhook: WebhookDoCanalDto;
}

export class TesteDoCanalMetaDto {
  @ApiProperty()
  ok: boolean;

  @ApiProperty({ example: 'Conectado à página "Loja BRL".' })
  mensagem: string;

  @ApiProperty({ type: String, nullable: true, example: 'Loja BRL' })
  nome: string | null;
}

export class TokenDeVerificacaoDto {
  @ApiProperty()
  tokenVerificacao: string;
}
