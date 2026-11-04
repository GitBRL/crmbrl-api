import {
  ApiProperty,
  ApiPropertyOptional,
  getSchemaPath,
} from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsObject,
  IsString,
  MaxLength,
} from 'class-validator';
import {
  QUANTIDADE_MAXIMA_ETIQUETAS,
  TAMANHO_MAXIMO_ETIQUETA,
} from '../../../comum/dominio/etiquetas';
import {
  AplicativoIntegracao,
  ModeloMapeamento,
  ModoIntegracao,
} from '../../../generated/prisma/client';
import {
  MENSAGEM_TEXTO,
  mensagemDeValores,
  OpcionalNaoNulo,
} from '../../dto-comum';
import { MapeamentoDto } from './webhook-entrada.dto';

/** Prévia de uma configuração ainda não salva (`POST /webhooks/entradas/previa`). */
export class PreviaDeMapeamentoDto {
  @ApiPropertyOptional({
    enum: AplicativoIntegracao,
    enumName: 'AplicativoIntegracao',
    default: 'WEBHOOK',
    description:
      'O aplicativo: o corpo de exemplo passa pelo adaptador dele (ex.: o `form_response` do Typeform, o `leads[]` do RD Station) antes do mapeamento.',
  })
  @OpcionalNaoNulo()
  @IsEnum(AplicativoIntegracao, {
    message: mensagemDeValores(Object.values(AplicativoIntegracao)),
  })
  aplicativo?: AplicativoIntegracao;

  @ApiPropertyOptional({
    enum: ModoIntegracao,
    enumName: 'ModoIntegracao',
    default: 'CRIAR_OU_ATUALIZAR',
    description: 'No modo `ATUALIZAR` o nome não é obrigatório.',
  })
  @OpcionalNaoNulo()
  @IsEnum(ModoIntegracao, {
    message: mensagemDeValores(Object.values(ModoIntegracao)),
  })
  modo?: ModoIntegracao;

  @ApiPropertyOptional({
    enum: ModeloMapeamento,
    enumName: 'ModeloMapeamento',
    default: 'GENERICO',
    description: 'Padrão: `GENERICO` no Webhook e `DO_APLICATIVO` nos demais.',
  })
  @OpcionalNaoNulo()
  @IsEnum(ModeloMapeamento, {
    message: mensagemDeValores(Object.values(ModeloMapeamento)),
  })
  modeloMapeamento?: ModeloMapeamento;

  @ApiPropertyOptional({
    allOf: [{ $ref: getSchemaPath(MapeamentoDto) }],
    description: 'Obrigatório com `PERSONALIZADO`.',
  })
  @OpcionalNaoNulo()
  @IsObject({ message: 'deve ser um objeto { campos, ignorarQuando }' })
  mapeamento?: Record<string, unknown>;

  @ApiPropertyOptional({ type: [String], example: ['Landing'] })
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

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    example: {
      name: 'Maria Souza',
      email: 'MARIA@empresa.com.br',
      phone: '(11) 98765-4321',
      utm_source: 'google',
    },
    description: 'O corpo de exemplo, como o sistema de origem vai mandar.',
  })
  @IsObject({ message: 'deve ser um objeto JSON' })
  exemplo: Record<string, unknown>;
}

export class ContatoDaPreviaDto {
  @ApiProperty({ type: String, nullable: true, example: 'Maria Souza' })
  nome: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'maria@empresa.com.br',
  })
  email: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '5511987654321',
    description: 'Em E.164, só dígitos.',
  })
  telefone: string | null;

  @ApiProperty({ type: String, nullable: true })
  empresa: string | null;

  @ApiProperty({ type: String, nullable: true })
  cargo: string | null;

  @ApiProperty({ type: [String] })
  etiquetas: string[];

  @ApiProperty({ type: 'object', additionalProperties: true })
  camposPersonalizados: Record<string, unknown>;
}

export class NegocioDaPreviaDto {
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Sem título, o negócio leva o nome do contato.',
  })
  titulo: string | null;

  @ApiProperty({ type: String, nullable: true, example: '1500.00' })
  valor: string | null;

  @ApiProperty({ type: String, nullable: true, example: '300.00' })
  valorRecorrente: string | null;
}

export class UtmDaPreviaDto {
  @ApiPropertyOptional()
  source?: string;
  @ApiPropertyOptional()
  medium?: string;
  @ApiPropertyOptional()
  campaign?: string;
  @ApiPropertyOptional()
  term?: string;
  @ApiPropertyOptional()
  content?: string;
}

export class CampoEncontradoDto {
  @ApiProperty({ example: 'email' })
  destino: string;

  @ApiProperty({ example: 'lead.email' })
  caminho: string;
}

export class AtualizacoesDaPreviaDto {
  @ApiProperty({ type: String, nullable: true, example: 'Proposta' })
  etapa: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'ana@brl.com.br' })
  dono: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'ganho' })
  status: string | null;

  @ApiProperty({ type: String, nullable: true })
  motivoPerda: string | null;
}

/** O que o processamento faria com o corpo (R8.5), sem gravar nada. */
export class ResultadoDaPreviaDto {
  @ApiProperty({
    description:
      'O processamento criaria (ou reconverteria) o contato e o negócio.',
  })
  valido: boolean;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Motivo para ignorar (corpo vazio, envio de teste…).',
  })
  ignorado: string | null;

  @ApiProperty({
    type: [String],
    description: 'O que impediria o processamento (vira erro no recebimento).',
  })
  problemas: string[];

  @ApiProperty({
    type: [String],
    description: 'Valores descartados que não impedem o processamento.',
  })
  avisos: string[];

  @ApiProperty({ type: ContatoDaPreviaDto })
  contato: ContatoDaPreviaDto;

  @ApiProperty({ type: NegocioDaPreviaDto })
  negocio: NegocioDaPreviaDto;

  @ApiProperty({ type: UtmDaPreviaDto, nullable: true })
  utm: UtmDaPreviaDto | null;

  @ApiProperty({ type: [CampoEncontradoDto] })
  encontrados: CampoEncontradoDto[];

  @ApiProperty({
    type: AtualizacoesDaPreviaDto,
    description:
      'Etapa, dono, status e motivo da perda mapeados (ainda como texto: o processamento os confere, R32.4).',
  })
  atualizacoes: AtualizacoesDaPreviaDto;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description:
      'Campos personalizados do negócio (`negocio.camposPersonalizados.<chave>`).',
  })
  camposDoNegocio: Record<string, unknown>;

  @ApiProperty({
    example: 1,
    description:
      'Itens que o corpo tem (RD Station: um por lead). A prévia mostra o primeiro.',
  })
  itens: number;
}
