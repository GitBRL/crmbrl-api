import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import {
  EVENTOS_DE_WEBHOOK,
  type EventoDeWebhook,
} from '../../../eventos/tipos-eventos';
import {
  FormatoWebhookSaida,
  MetodoWebhookSaida,
  StatusNegocio,
} from '../../../generated/prisma/client';
import {
  aparar,
  MENSAGEM_UUID,
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

import {
  CAMPOS_DE_SAIDA_MAXIMOS,
  GATILHOS_MAXIMOS,
  TIPOS_DE_GATILHO,
  type TipoDeGatilho,
} from '../formato-clint';

const MENSAGEM_EVENTO = {
  each: true,
  message: `(cada item) ${mensagemDeValores(EVENTOS_DE_WEBHOOK)}`,
};

export class GatilhoDto {
  @ApiProperty({
    enum: TIPOS_DE_GATILHO,
    enumName: 'TipoDeGatilho',
    example: 'ENTRA_NA_ETAPA',
    description:
      '`NEGOCIO_CRIADO`, `ENTRA_NA_ETAPA` (exige `etapaId`), `MUDA_DE_ETAPA` ou `MUDA_DE_STATUS` (ganho, perdido ou reaberto).',
  })
  @IsIn(TIPOS_DE_GATILHO, {
    message: mensagemDeValores(TIPOS_DE_GATILHO),
  })
  tipo: TipoDeGatilho;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Filtro de funil: só os negócios deste funil.',
  })
  @OpcionalNaoNulo()
  @IsUUID('all', MENSAGEM_UUID)
  funilId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Só em `ENTRA_NA_ETAPA`: a etapa (o funil é o dela).',
  })
  @OpcionalNaoNulo()
  @IsUUID('all', MENSAGEM_UUID)
  etapaId?: string;

  @ApiPropertyOptional({
    enum: StatusNegocio,
    enumName: 'StatusNegocio',
    description: 'Só em `MUDA_DE_STATUS`: sem ele, qualquer mudança de status.',
  })
  @OpcionalNaoNulo()
  @IsEnum(StatusNegocio, {
    message: mensagemDeValores(Object.values(StatusNegocio)),
  })
  status?: StatusNegocio;
}

export class CampoDeSaidaDto {
  @ApiProperty({
    example: 'contato.email',
    description:
      'De onde vem o valor (lista em `GET /webhooks/saidas/formato-clint`); campos personalizados: `contato.camposPersonalizados.<chave>` ou `negocio.camposPersonalizados.<chave>`.',
  })
  @IsString({ message: MENSAGEM_TEXTO })
  origem: string;

  @ApiProperty({
    example: 'email',
    description: 'O nome do campo no envio (editável). Único no destino.',
  })
  @IsString({ message: MENSAGEM_TEXTO })
  identificador: string;
}

/** Campos do formato do Clint, comuns à criação e à edição. */
const MENSAGEM_METODO = {
  message: mensagemDeValores(Object.values(MetodoWebhookSaida)),
};

export class CriarWebhookSaidaDto {
  @ApiPropertyOptional({
    enum: FormatoWebhookSaida,
    enumName: 'FormatoWebhookSaida',
    default: 'ENVELOPE_CRM',
    description:
      '`ENVELOPE_CRM`: o envelope `{ id, evento, ocorridoEm, dados }` dos eventos assinados (R9.3). `CLINT`: o estilo do Clint (R32.12) — gatilhos de negócio, POST (JSON) ou GET e os campos escolhidos com identificador editável. Não muda depois de criado.',
  })
  @OpcionalNaoNulo()
  @IsEnum(FormatoWebhookSaida, {
    message: mensagemDeValores(Object.values(FormatoWebhookSaida)),
  })
  formato?: FormatoWebhookSaida;

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
  @ValidateIf((o: CriarWebhookSaidaDto) => o.formato !== 'CLINT')
  @IsArray({ message: 'deve ser uma lista' })
  @ArrayMinSize(1, { message: 'escolha pelo menos um evento' })
  @ArrayMaxSize(EVENTOS_DE_WEBHOOK.length, {
    message: `deve ter no máximo ${EVENTOS_DE_WEBHOOK.length} eventos`,
  })
  @ArrayUnique({ message: 'não repita eventos' })
  @IsIn(EVENTOS_DE_WEBHOOK, MENSAGEM_EVENTO)
  eventos?: EventoDeWebhook[];

  @ApiPropertyOptional({
    enum: MetodoWebhookSaida,
    enumName: 'MetodoWebhookSaida',
    default: 'POST',
    description:
      '`POST` (corpo JSON, `Content-Type: application/json`) ou `GET` (os campos vão como parâmetros da URL). `GET` só no formato `CLINT`.',
  })
  @OpcionalNaoNulo()
  @IsEnum(MetodoWebhookSaida, MENSAGEM_METODO)
  metodo?: MetodoWebhookSaida;

  @ApiPropertyOptional({
    type: [GatilhoDto],
    description:
      'Formato `CLINT`: pelo menos um gatilho. Não vale no `ENVELOPE_CRM` (que usa `eventos`).',
  })
  @OpcionalNaoNulo()
  @IsArray({ message: 'deve ser uma lista' })
  @ArrayMaxSize(GATILHOS_MAXIMOS, {
    message: `deve ter no máximo ${GATILHOS_MAXIMOS} gatilhos`,
  })
  @ValidateNested({ each: true })
  @Type(() => GatilhoDto)
  gatilhos?: GatilhoDto[];

  @ApiPropertyOptional({
    type: [CampoDeSaidaDto],
    description:
      'Formato `CLINT`: os campos enviados (pelo menos um), cada um com o identificador no envio.',
  })
  @OpcionalNaoNulo()
  @IsArray({ message: 'deve ser uma lista' })
  @ArrayMaxSize(CAMPOS_DE_SAIDA_MAXIMOS, {
    message: `deve ter no máximo ${CAMPOS_DE_SAIDA_MAXIMOS} campos`,
  })
  @ValidateNested({ each: true })
  @Type(() => CampoDeSaidaDto)
  campos?: CampoDeSaidaDto[];

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
    enum: MetodoWebhookSaida,
    enumName: 'MetodoWebhookSaida',
    description: '`GET` só no formato `CLINT`.',
  })
  @OpcionalNaoNulo()
  @IsEnum(MetodoWebhookSaida, MENSAGEM_METODO)
  metodo?: MetodoWebhookSaida;

  @ApiPropertyOptional({
    type: [GatilhoDto],
    description: 'Só no formato `CLINT`: substitui a lista.',
  })
  @OpcionalNaoNulo()
  @IsArray({ message: 'deve ser uma lista' })
  @ArrayMaxSize(GATILHOS_MAXIMOS, {
    message: `deve ter no máximo ${GATILHOS_MAXIMOS} gatilhos`,
  })
  @ValidateNested({ each: true })
  @Type(() => GatilhoDto)
  gatilhos?: GatilhoDto[];

  @ApiPropertyOptional({
    type: [CampoDeSaidaDto],
    description: 'Só no formato `CLINT`: substitui a lista.',
  })
  @OpcionalNaoNulo()
  @IsArray({ message: 'deve ser uma lista' })
  @ArrayMaxSize(CAMPOS_DE_SAIDA_MAXIMOS, {
    message: `deve ter no máximo ${CAMPOS_DE_SAIDA_MAXIMOS} campos`,
  })
  @ValidateNested({ each: true })
  @Type(() => CampoDeSaidaDto)
  campos?: CampoDeSaidaDto[];

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
    description:
      'Vazio no formato `CLINT` (os gatilhos escolhem o que é enviado).',
  })
  eventos: string[];

  @ApiProperty({ enum: FormatoWebhookSaida, enumName: 'FormatoWebhookSaida' })
  formato: FormatoWebhookSaida;

  @ApiProperty({ enum: MetodoWebhookSaida, enumName: 'MetodoWebhookSaida' })
  metodo: MetodoWebhookSaida;

  @ApiProperty({ type: [GatilhoDto], description: 'Só no formato `CLINT`.' })
  gatilhos: GatilhoDto[];

  @ApiProperty({
    type: [CampoDeSaidaDto],
    description: 'Só no formato `CLINT`.',
  })
  campos: CampoDeSaidaDto[];

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

export class OrigemDeCampoDto {
  @ApiProperty({ example: 'contato.email' })
  origem: string;

  @ApiProperty({ example: 'E-mail' })
  rotulo: string;

  @ApiProperty({ example: 'Contato' })
  grupo: string;

  @ApiProperty({
    example: 'email',
    description: 'O identificador sugerido (editável).',
  })
  identificadorPadrao: string;
}

export class TipoDeGatilhoDto {
  @ApiProperty({ enum: TIPOS_DE_GATILHO, enumName: 'TipoDeGatilho' })
  tipo: string;

  @ApiProperty()
  descricao: string;

  @ApiProperty({ description: 'Exige `etapaId`.' })
  exigeEtapa: boolean;

  @ApiProperty({ description: 'Aceita `status`.' })
  aceitaStatus: boolean;
}

export class FormatoClintDto {
  @ApiProperty({ type: [TipoDeGatilhoDto] })
  gatilhos: TipoDeGatilhoDto[];

  @ApiProperty({
    type: [OrigemDeCampoDto],
    description:
      'Os campos que dá para enviar. Além deles, `contato.camposPersonalizados.<chave>` e `negocio.camposPersonalizados.<chave>`.',
  })
  campos: OrigemDeCampoDto[];

  @ApiProperty({
    enum: MetodoWebhookSaida,
    enumName: 'MetodoWebhookSaida',
    isArray: true,
  })
  metodos: MetodoWebhookSaida[];
}
