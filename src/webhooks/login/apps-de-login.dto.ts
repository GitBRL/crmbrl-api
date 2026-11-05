import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, Length } from 'class-validator';
import {
  aparar,
  MENSAGEM_BOOLEANO,
  MENSAGEM_TEXTO,
  OpcionalNaoNulo,
} from '../dto-comum';

export const APLICATIVOS_DE_LOGIN = ['META', 'TYPEFORM', 'RD_STATION'] as const;

export class GravarAppDeLoginDto {
  @ApiProperty({
    example: '1234567890123456',
    description:
      'ID do app no serviço (Meta: o ID numérico do app; Typeform e RD Station: o client ID).',
  })
  @Transform(aparar)
  @IsString({ message: MENSAGEM_TEXTO })
  @Length(1, 200, { message: 'deve ter entre 1 e 200 caracteres' })
  clientId: string;

  @ApiPropertyOptional({
    description:
      'Segredo do app (guardado cifrado, nunca devolvido). Obrigatório na primeira gravação e ao trocar o `clientId`; ausente nas demais, mantém o atual.',
  })
  @OpcionalNaoNulo()
  @Transform(aparar)
  @IsString({ message: MENSAGEM_TEXTO })
  @Length(1, 300, { message: 'deve ter entre 1 e 300 caracteres' })
  segredo?: string;

  @ApiPropertyOptional({
    description:
      'Confirma a troca do `clientId` de um app em uso: as conexões e os canais dele ficam "precisa de atenção" (o app mudou, conecte de novo). Sem a confirmação, a troca em uso dá 409.',
  })
  @IsOptional()
  @IsBoolean(MENSAGEM_BOOLEANO)
  confirmarTroca?: boolean;
}

export class EmUsoDoAppDto {
  @ApiProperty({
    description:
      'Conexões (Facebook marcadas com o app das Configurações; conexões de Typeform e RD Station).',
  })
  conexoes: number;

  @ApiProperty({
    description: 'Canais Messenger e Instagram com o app (só Meta).',
  })
  canais: number;

  @ApiProperty({
    description: 'Integrações (não excluídas) que usam essas conexões.',
  })
  integracoes: number;
}

export class WebhookDoAppDto {
  @ApiProperty({
    example: 'https://crm.brl.com.br/api/v1/publico/meta/webhook',
  })
  url: string;

  @ApiProperty({
    description:
      'Token de verificação do webhook de páginas do app (o `hub.verify_token` do desafio).',
  })
  tokenVerificacao: string;

  @ApiProperty({ type: [String], example: ['leadgen'] })
  campos: string[];
}

export class UsuarioDoAppDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  nome: string;
}

export class AppDeLoginDto {
  @ApiProperty({ enum: APLICATIVOS_DE_LOGIN })
  aplicativo: string;

  @ApiProperty({ example: 'Meta (Facebook, Instagram e Messenger)' })
  nome: string;

  @ApiProperty()
  configurado: boolean;

  @ApiProperty({ type: String, nullable: true, example: '1234567890123456' })
  clientId: string | null;

  @ApiProperty({ type: String, nullable: true, example: '••••••••3f9a' })
  segredoMascarado: string | null;

  @ApiProperty({
    example: 'https://crm.brl.com.br/api/v1/publico/facebook/oauth/retorno',
    description:
      'Endereço de retorno (redirect URI) a cadastrar no app do serviço. Meta: `…/publico/facebook/oauth/retorno`; Typeform e RD Station: `…/publico/conexoes/oauth/retorno`.',
  })
  enderecoDeRetorno: string;

  @ApiProperty({ type: EmUsoDoAppDto })
  emUso: EmUsoDoAppDto;

  @ApiProperty({
    type: [String],
    description:
      'Escopos que o CRM pede no login (Meta e Typeform; vazio no RD Station).',
  })
  escopos: string[];

  @ApiProperty({
    type: WebhookDoAppDto,
    nullable: true,
    description:
      'Só na Meta: o webhook de páginas do app (callback, token e campo `leadgen`).',
  })
  webhook: WebhookDoAppDto | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  atualizadoEm: string | null;

  @ApiProperty({ type: UsuarioDoAppDto, nullable: true })
  atualizadoPor: UsuarioDoAppDto | null;
}
