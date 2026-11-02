import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import {
  EVENTOS_DE_WEBHOOK,
  type EventoDeWebhook,
} from '../../../eventos/tipos-eventos';
import {
  aparar,
  MENSAGEM_BOOLEANO,
  MENSAGEM_TEXTO,
  maximo,
  mensagemDeValores,
  OpcionalNaoNulo,
  UsuarioDoWebhookDto,
} from '../../dto-comum';
import {
  TAMANHO_MAXIMO_NOME_WEBHOOK,
  TAMANHO_MAXIMO_URL,
} from '../../webhooks.constantes';

const MENSAGEM_EVENTO = {
  each: true,
  message: `(cada item) ${mensagemDeValores(EVENTOS_DE_WEBHOOK)}`,
};

export class CriarWebhookSaidaDto {
  @ApiProperty({
    example: 'TicketHub',
    maxLength: TAMANHO_MAXIMO_NOME_WEBHOOK,
    description: 'Único entre os destinos.',
  })
  @Transform(aparar)
  @IsString({ message: MENSAGEM_TEXTO })
  @IsNotEmpty({ message: 'é obrigatório' })
  @MaxLength(TAMANHO_MAXIMO_NOME_WEBHOOK, maximo(TAMANHO_MAXIMO_NOME_WEBHOOK))
  nome: string;

  @ApiProperty({
    example: 'https://sistema.exemplo.com.br/webhooks/crm',
    maxLength: TAMANHO_MAXIMO_URL,
    description:
      'HTTPS em produção. Rede interna e localhost são recusados (SSRF), salvo com WEBHOOKS_PERMITIR_REDE_INTERNA=true (R9.1).',
  })
  @Transform(aparar)
  @IsString({ message: MENSAGEM_TEXTO })
  @IsNotEmpty({ message: 'é obrigatório' })
  @MaxLength(TAMANHO_MAXIMO_URL, maximo(TAMANHO_MAXIMO_URL))
  url: string;

  @ApiProperty({
    enum: EVENTOS_DE_WEBHOOK,
    enumName: 'EventoDeWebhook',
    isArray: true,
    example: ['negocio.ganho', 'contato.criado'],
    description: 'Eventos assinados (R9.2).',
  })
  @IsArray({ message: 'deve ser uma lista' })
  @ArrayMinSize(1, { message: 'escolha pelo menos um evento' })
  @ArrayMaxSize(EVENTOS_DE_WEBHOOK.length, {
    message: `deve ter no máximo ${EVENTOS_DE_WEBHOOK.length} eventos`,
  })
  @ArrayUnique({ message: 'não repita eventos' })
  @IsIn(EVENTOS_DE_WEBHOOK, MENSAGEM_EVENTO)
  eventos: EventoDeWebhook[];

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { type: 'string' },
    example: { Authorization: 'Bearer chave-do-destino' },
    description:
      'Cabeçalhos extras de toda entrega (até 20). Ficam cifrados e só aparecem mascarados (R10.3).',
  })
  @OpcionalNaoNulo()
  @IsObject({ message: 'deve ser um objeto { "Nome": "valor" }' })
  cabecalhos?: Record<string, string>;

  @ApiPropertyOptional({ default: true })
  @OpcionalNaoNulo()
  @IsBoolean(MENSAGEM_BOOLEANO)
  ativo?: boolean;
}

export class AtualizarWebhookSaidaDto {
  @ApiPropertyOptional({ maxLength: TAMANHO_MAXIMO_NOME_WEBHOOK })
  @OpcionalNaoNulo()
  @Transform(aparar)
  @IsString({ message: MENSAGEM_TEXTO })
  @IsNotEmpty({ message: 'é obrigatório' })
  @MaxLength(TAMANHO_MAXIMO_NOME_WEBHOOK, maximo(TAMANHO_MAXIMO_NOME_WEBHOOK))
  nome?: string;

  @ApiPropertyOptional({ maxLength: TAMANHO_MAXIMO_URL })
  @OpcionalNaoNulo()
  @Transform(aparar)
  @IsString({ message: MENSAGEM_TEXTO })
  @IsNotEmpty({ message: 'é obrigatório' })
  @MaxLength(TAMANHO_MAXIMO_URL, maximo(TAMANHO_MAXIMO_URL))
  url?: string;

  @ApiPropertyOptional({
    enum: EVENTOS_DE_WEBHOOK,
    enumName: 'EventoDeWebhook',
    isArray: true,
  })
  @OpcionalNaoNulo()
  @IsArray({ message: 'deve ser uma lista' })
  @ArrayMinSize(1, { message: 'escolha pelo menos um evento' })
  @ArrayMaxSize(EVENTOS_DE_WEBHOOK.length, {
    message: `deve ter no máximo ${EVENTOS_DE_WEBHOOK.length} eventos`,
  })
  @ArrayUnique({ message: 'não repita eventos' })
  @IsIn(EVENTOS_DE_WEBHOOK, MENSAGEM_EVENTO)
  eventos?: EventoDeWebhook[];

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { type: 'string', nullable: true },
    nullable: true,
    example: { Authorization: 'Bearer chave-nova', 'X-Antigo': null },
    description:
      'Atualização parcial: os enviados substituem (o nome não diferencia maiúsculas), `null` remove um cabeçalho e os não enviados ficam. `null` no lugar do objeto remove todos.',
  })
  @IsOptional()
  @IsObject({ message: 'deve ser um objeto { "Nome": "valor" }' })
  cabecalhos?: Record<string, string | null> | null;

  @ApiPropertyOptional({
    description:
      'Reativar zera as falhas seguidas e o registro da desativação automática (R9.4).',
  })
  @OpcionalNaoNulo()
  @IsBoolean(MENSAGEM_BOOLEANO)
  ativo?: boolean;
}

export class CabecalhoMascaradoDto {
  @ApiProperty({ example: 'Authorization' })
  nome: string;

  @ApiProperty({ example: '••••••••ino1' })
  valorMascarado: string;
}

export class ContagemDeEntregasDto {
  @ApiProperty({
    example: 2,
    description: 'Aguardando envio ou nova tentativa (R9.4).',
  })
  pendentes: number;

  @ApiProperty({
    example: 1,
    description: 'Marcadas como falha depois de todas as tentativas.',
  })
  falhas: number;
}

export class WebhookSaidaDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'TicketHub' })
  nome: string;

  @ApiProperty({ example: 'https://sistema.exemplo.com.br/webhooks/crm' })
  url: string;

  @ApiProperty({
    enum: EVENTOS_DE_WEBHOOK,
    enumName: 'EventoDeWebhook',
    isArray: true,
  })
  eventos: string[];

  @ApiProperty({ type: [CabecalhoMascaradoDto] })
  cabecalhos: CabecalhoMascaradoDto[];

  @ApiProperty({
    example: '••••••••3f9a',
    description:
      'O segredo das assinaturas, mascarado (R10.3). O completo só aparece ao criar e ao regenerar.',
  })
  segredoMascarado: string;

  @ApiProperty()
  ativo: boolean;

  @ApiProperty({
    example: 0,
    description: 'Falhas seguidas; com 20 o destino é desativado (R9.4).',
  })
  falhasConsecutivas: number;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Quando foi desativado automaticamente (R9.4).',
  })
  desativadoAutomaticamenteEm: string | null;

  @ApiProperty({ type: ContagemDeEntregasDto })
  entregas: ContagemDeEntregasDto;

  @ApiProperty({ type: UsuarioDoWebhookDto, nullable: true })
  criadoPor: UsuarioDoWebhookDto | null;

  @ApiProperty({ format: 'date-time' })
  criadoEm: string;

  @ApiProperty({ format: 'date-time' })
  atualizadoEm: string;
}

export class WebhookSaidaComSegredoDto {
  @ApiProperty({ type: WebhookSaidaDto })
  webhook: WebhookSaidaDto;

  @ApiProperty({
    description:
      'O segredo das assinaturas (`X-CRM-Assinatura`, R9.3). Mostrado só agora: copie para o sistema de destino.',
  })
  segredo: string;
}

export class EventoDisponivelDto {
  @ApiProperty({ enum: EVENTOS_DE_WEBHOOK, enumName: 'EventoDeWebhook' })
  evento: string;

  @ApiProperty({ example: 'Negócio ganho.' })
  descricao: string;
}
