import {
  ApiProperty,
  ApiPropertyOptional,
  getSchemaPath,
} from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  MaxLength,
} from 'class-validator';
import {
  QUANTIDADE_MAXIMA_ETIQUETAS,
  TAMANHO_MAXIMO_ETIQUETA,
} from '../../../comum/dominio/etiquetas';
import { PaginacaoDto } from '../../../comum/paginacao/paginacao';
import {
  EstrategiaDistribuicao,
  ModeloMapeamento,
} from '../../../generated/prisma/client';
import {
  aparar,
  EtapaDoWebhookDto,
  FunilDoWebhookDto,
  lerBooleano,
  MENSAGEM_BOOLEANO,
  MENSAGEM_TEXTO,
  MENSAGEM_UUID,
  maximo,
  mensagemDeValores,
  OpcionalNaoNulo,
  UsuarioDoWebhookDto,
} from '../../dto-comum';
import {
  TAMANHO_MAXIMO_NOME_WEBHOOK,
  TAMANHO_MAXIMO_SEGREDO,
  TAMANHO_MINIMO_SEGREDO,
} from '../../webhooks.constantes';

const MENSAGEM_ESTRATEGIA = {
  message: mensagemDeValores(Object.values(EstrategiaDistribuicao)),
};
const MENSAGEM_MODELO = {
  message: mensagemDeValores(Object.values(ModeloMapeamento)),
};
const MENSAGEM_SEGREDO = {
  message: `deve ter de ${TAMANHO_MINIMO_SEGREDO} a ${TAMANHO_MAXIMO_SEGREDO} caracteres`,
};

// ---------------------------------------------------------------------------
// Mapeamento (documentação e resposta)
// ---------------------------------------------------------------------------

export class RegraDeCampoDto {
  @ApiProperty({
    example: 'lead.contatos[0].email',
    description:
      'Caminho no corpo recebido: chaves separadas por ponto, índice de lista (`itens[0]`) e um curinga `*` opcional no último trecho (`planilha_*`).',
  })
  caminho: string;

  @ApiProperty({
    example: 'email',
    description:
      '`nome`, `email`, `telefone`, `empresa`, `cargo`, `titulo`, `valor`, `valorRecorrente`, `etiquetas`, ' +
      '`utm.source|medium|campaign|term|content` ou `camposPersonalizados.<chave>` (com curinga, a chave leva `*`).',
  })
  destino: string;
}

export class CondicaoParaIgnorarDto {
  @ApiProperty({ example: 'teste' })
  caminho: string;

  @ApiProperty({
    oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }],
    example: true,
    description:
      'Se o campo vier com este valor (sem diferenciar maiúsculas), o recebimento é ignorado.',
  })
  valor: string | number | boolean;
}

export class MapeamentoDto {
  @ApiProperty({
    type: [RegraDeCampoDto],
    description:
      'Regras na ordem: para o mesmo destino vale o primeiro caminho com valor (no e-mail e no telefone, o primeiro válido); etiquetas se somam.',
  })
  campos: RegraDeCampoDto[];

  @ApiProperty({ type: [CondicaoParaIgnorarDto] })
  ignorarQuando: CondicaoParaIgnorarDto[];
}

// ---------------------------------------------------------------------------
// Entrada (corpo e query)
// ---------------------------------------------------------------------------

/** Campos comuns da criação e da edição. */
class CamposDoWebhookEntradaDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Funil de entrada (R8.1). Padrão: o funil-base de Marketing.',
  })
  @OpcionalNaoNulo()
  @IsUUID('all', MENSAGEM_UUID)
  funilId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Etapa de entrada, do funil escolhido (não pode ser a de perda). Padrão: "Novo lead" no Marketing; nos outros funis, a primeira etapa aberta.',
  })
  @OpcionalNaoNulo()
  @IsUUID('all', MENSAGEM_UUID)
  etapaId?: string;

  @ApiPropertyOptional({
    enum: EstrategiaDistribuicao,
    enumName: 'EstrategiaDistribuicao',
    default: 'RODIZIO',
    description:
      'Como o negócio criado ganha responsável (R5.8): rodízio da área, um responsável fixo ou o líder da área.',
  })
  @OpcionalNaoNulo()
  @IsEnum(EstrategiaDistribuicao, MENSAGEM_ESTRATEGIA)
  estrategia?: EstrategiaDistribuicao;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'Obrigatório com `RESPONSAVEL_FIXO`: usuário ativo que vê o funil (da área, C-level ou Admin).',
  })
  @IsOptional()
  @IsUUID('all', MENSAGEM_UUID)
  responsavelFixoId?: string | null;

  @ApiPropertyOptional({
    enum: ModeloMapeamento,
    enumName: 'ModeloMapeamento',
    default: 'GENERICO',
    description:
      '`GENERICO` e `DISPAROS_BRL` são modelos prontos (veja `GET /webhooks/entradas/modelos`); `PERSONALIZADO` usa o `mapeamento`.',
  })
  @OpcionalNaoNulo()
  @IsEnum(ModeloMapeamento, MENSAGEM_MODELO)
  modeloMapeamento?: ModeloMapeamento;

  @ApiPropertyOptional({
    allOf: [{ $ref: getSchemaPath(MapeamentoDto) }],
    description:
      'Só com `PERSONALIZADO`: precisa de uma regra para `nome` e outra para `email` ou `telefone`.',
  })
  @OpcionalNaoNulo()
  @IsObject({ message: 'deve ser um objeto { campos, ignorarQuando }' })
  mapeamento?: Record<string, unknown>;

  @ApiPropertyOptional({
    type: [String],
    example: ['Landing', 'Black Friday'],
    description: 'Etiquetas acrescentadas a todo contato que chegar por aqui.',
  })
  @OpcionalNaoNulo()
  @IsArray({ message: 'deve ser uma lista' })
  @ArrayMaxSize(QUANTIDADE_MAXIMA_ETIQUETAS, {
    message: `deve ter no máximo ${QUANTIDADE_MAXIMA_ETIQUETAS} etiquetas`,
  })
  @IsString({ each: true, message: `(cada item) ${MENSAGEM_TEXTO}` })
  @MaxLength(TAMANHO_MAXIMO_ETIQUETA, {
    each: true,
    message: `(cada item) deve ter no máximo ${TAMANHO_MAXIMO_ETIQUETA} caracteres`,
  })
  etiquetasFixas?: string[];

  @ApiPropertyOptional({
    description:
      'Desativado, o endereço responde 410 (R8.7) e nada é registrado.',
  })
  @OpcionalNaoNulo()
  @IsBoolean(MENSAGEM_BOOLEANO)
  ativo?: boolean;
}

export class CriarWebhookEntradaDto extends CamposDoWebhookEntradaDto {
  @ApiProperty({
    example: 'Landing Black Friday',
    maxLength: TAMANHO_MAXIMO_NOME_WEBHOOK,
    description:
      'Único entre os pontos de entrada; vira o "detalhe" da origem dos contatos (R4.3).',
  })
  @Transform(aparar)
  @IsString({ message: MENSAGEM_TEXTO })
  @IsNotEmpty({ message: 'é obrigatório' })
  @MaxLength(TAMANHO_MAXIMO_NOME_WEBHOOK, maximo(TAMANHO_MAXIMO_NOME_WEBHOOK))
  nome: string;

  @ApiPropertyOptional({
    minLength: TAMANHO_MINIMO_SEGREDO,
    maxLength: TAMANHO_MAXIMO_SEGREDO,
    description:
      'Segredo HMAC (R8.3) já combinado com o sistema que envia. Com segredo, toda chamada precisa de `X-Assinatura`.',
  })
  @OpcionalNaoNulo()
  @IsString({ message: MENSAGEM_TEXTO })
  @Length(TAMANHO_MINIMO_SEGREDO, TAMANHO_MAXIMO_SEGREDO, MENSAGEM_SEGREDO)
  segredo?: string;

  @ApiPropertyOptional({
    default: false,
    description:
      'Gera um segredo HMAC (mostrado só nesta resposta). Não combine com `segredo`.',
  })
  @OpcionalNaoNulo()
  @IsBoolean(MENSAGEM_BOOLEANO)
  gerarSegredo?: boolean;
}

export class AtualizarWebhookEntradaDto extends CamposDoWebhookEntradaDto {
  @ApiPropertyOptional({
    example: 'Landing Black Friday',
    maxLength: TAMANHO_MAXIMO_NOME_WEBHOOK,
  })
  @OpcionalNaoNulo()
  @Transform(aparar)
  @IsString({ message: MENSAGEM_TEXTO })
  @IsNotEmpty({ message: 'é obrigatório' })
  @MaxLength(TAMANHO_MAXIMO_NOME_WEBHOOK, maximo(TAMANHO_MAXIMO_NOME_WEBHOOK))
  nome?: string;
}

export class DefinirSegredoEntradaDto {
  @ApiPropertyOptional({
    minLength: TAMANHO_MINIMO_SEGREDO,
    maxLength: TAMANHO_MAXIMO_SEGREDO,
    description:
      'O segredo combinado com o sistema que envia. Sem ele, a API gera um e o mostra só nesta resposta.',
  })
  @OpcionalNaoNulo()
  @IsString({ message: MENSAGEM_TEXTO })
  @Length(TAMANHO_MINIMO_SEGREDO, TAMANHO_MAXIMO_SEGREDO, MENSAGEM_SEGREDO)
  segredo?: string;
}

export class FiltroWebhooksDto extends PaginacaoDto {
  @ApiPropertyOptional({
    description: 'Parte do nome (sem diferenciar maiúsculas).',
  })
  @IsOptional()
  @Transform(aparar)
  @IsString({ message: MENSAGEM_TEXTO })
  @MaxLength(100, maximo(100))
  busca?: string;

  @ApiPropertyOptional({
    description: 'Só os ativos (`true`) ou só os desativados (`false`).',
  })
  @IsOptional()
  @Transform(lerBooleano)
  @IsBoolean(MENSAGEM_BOOLEANO)
  ativo?: boolean;
}

// ---------------------------------------------------------------------------
// Saída
// ---------------------------------------------------------------------------

export class ContagemDeRecebimentosDto {
  @ApiProperty({
    example: 42,
    description: 'Recebimentos nas últimas 24 horas.',
  })
  total: number;

  @ApiProperty({ example: 1, description: 'Deles, com erro.' })
  erros: number;
}

export class WebhookEntradaDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'Landing Black Friday' })
  nome: string;

  @ApiProperty({
    example: 'q3Xa9Lp0',
    description:
      'Começo do token, para reconhecer o endereço sem revelá-lo (R8.2).',
  })
  tokenPrefixo: string;

  @ApiProperty({
    example: 'https://crm.brl.com.br/api/v1/webhooks/entrada/q3Xa9Lp0…',
    description:
      'O endereço com o token cortado. O completo só aparece ao criar e ao regenerar o token (R8.2).',
  })
  enderecoMascarado: string;

  @ApiProperty({ type: FunilDoWebhookDto })
  funil: FunilDoWebhookDto;

  @ApiProperty({ type: EtapaDoWebhookDto })
  etapa: EtapaDoWebhookDto;

  @ApiProperty({
    enum: EstrategiaDistribuicao,
    enumName: 'EstrategiaDistribuicao',
  })
  estrategia: EstrategiaDistribuicao;

  @ApiProperty({ type: UsuarioDoWebhookDto, nullable: true })
  responsavelFixo: UsuarioDoWebhookDto | null;

  @ApiProperty({ enum: ModeloMapeamento, enumName: 'ModeloMapeamento' })
  modeloMapeamento: ModeloMapeamento;

  @ApiProperty({
    type: MapeamentoDto,
    description:
      'O mapeamento que vale: o do modelo pronto ou o personalizado.',
  })
  mapeamento: MapeamentoDto;

  @ApiProperty({ type: [String] })
  etiquetasFixas: string[];

  @ApiProperty({
    description: 'Com segredo, as chamadas precisam de `X-Assinatura` (R8.3).',
  })
  exigeAssinatura: boolean;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '••••••••3f9a',
    description: 'O segredo HMAC mascarado (R10.3).',
  })
  segredoMascarado: string | null;

  @ApiProperty()
  ativo: boolean;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  ultimoRecebimentoEm: string | null;

  @ApiProperty({ type: ContagemDeRecebimentosDto })
  recebimentos24h: ContagemDeRecebimentosDto;

  @ApiProperty({ type: UsuarioDoWebhookDto, nullable: true })
  criadoPor: UsuarioDoWebhookDto | null;

  @ApiProperty({ format: 'date-time' })
  criadoEm: string;

  @ApiProperty({ format: 'date-time' })
  atualizadoEm: string;
}

export class WebhookEntradaCriadoDto {
  @ApiProperty({ type: WebhookEntradaDto })
  webhook: WebhookEntradaDto;

  @ApiProperty({
    example: 'https://crm.brl.com.br/api/v1/webhooks/entrada/q3Xa9Lp0bZ…',
    description:
      'Endereço completo, com o token (R8.2). Copie agora: depois só aparece mascarado.',
  })
  url: string;

  @ApiPropertyOptional({
    description:
      'O segredo HMAC gerado (só quando `gerarSegredo`). Copie agora.',
  })
  segredo?: string;
}

export class TokenRegeneradoDto {
  @ApiProperty({ type: WebhookEntradaDto })
  webhook: WebhookEntradaDto;

  @ApiProperty({
    description:
      'O endereço novo, completo. O anterior para de funcionar na hora (404).',
  })
  url: string;
}

export class SegredoDefinidoDto {
  @ApiProperty({ type: WebhookEntradaDto })
  webhook: WebhookEntradaDto;

  @ApiPropertyOptional({
    description: 'O segredo gerado pela API (só quando ela gera). Copie agora.',
  })
  segredo?: string;
}

export class DestinoDeMapeamentoDto {
  @ApiProperty({ example: 'telefone' })
  destino: string;

  @ApiProperty({ example: 'Telefone do contato (E.164; DDD validado).' })
  descricao: string;
}

export class ModeloDeMapeamentoDto {
  @ApiProperty({ enum: ['GENERICO', 'DISPAROS_BRL'] })
  modelo: string;

  @ApiProperty({ example: 'Disparos BRL' })
  nome: string;

  @ApiProperty()
  descricao: string;

  @ApiProperty({ type: MapeamentoDto })
  mapeamento: MapeamentoDto;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description: 'Um corpo de exemplo nesse formato.',
  })
  exemplo: Record<string, unknown>;
}

export class ModelosDeMapeamentoDto {
  @ApiProperty({ type: [ModeloDeMapeamentoDto] })
  modelos: ModeloDeMapeamentoDto[];

  @ApiProperty({
    type: [DestinoDeMapeamentoDto],
    description:
      'Destinos aceitos num mapeamento personalizado (além de `camposPersonalizados.<chave>`).',
  })
  destinos: DestinoDeMapeamentoDto[];
}
