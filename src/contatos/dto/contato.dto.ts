import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { QUANTIDADE_MAXIMA_ETIQUETAS } from '../../comum/dominio/etiquetas';
import { PaginacaoDto } from '../../comum/paginacao/paginacao';
import { OrigemContato } from '../../generated/prisma/client';
import {
  ORIGENS_MANUAIS,
  type OrigemManual,
  TAMANHO_MAXIMO_BUSCA,
  TAMANHO_MAXIMO_MOTIVO,
  TAMANHO_MAXIMO_NOME,
  TAMANHO_MAXIMO_TEXTO_CURTO,
} from '../contatos.constantes';
import { objetoJson, utmDoJson } from '../deduplicacao';
import type { ContatoComRelacoes } from '../relacoes';
import {
  ConsentimentoContatoDto,
  ConsentimentoEntradaDto,
  EmpresaVinculadaDto,
  OrigemContatoDto,
  UltimaOrigemContatoDto,
  UsuarioVinculadoDto,
  UtmOrigemDto,
} from './comum.dto';
import {
  EhCamposPersonalizados,
  EhEmail,
  EhTelefone,
  ParaBooleano,
  ParaMinusculas,
  SeInformado,
} from './validadores';

const MENSAGEM_TEXTO = 'deve ser um texto';
const maximo = (limite: number) => ({
  message: `deve ter no máximo ${limite} caracteres`,
});
const MENSAGEM_UUID = { message: 'deve ser um identificador (UUID) válido' };
const MENSAGEM_LISTA_DE_ETIQUETAS = {
  message: `deve ter no máximo ${QUANTIDADE_MAXIMA_ETIQUETAS} etiquetas`,
};

/** Criação manual (R4.1–R4.7). Com e-mail ou telefone de um contato existente, reconverte em vez de duplicar (R4.2). */
export class CriarContatoDto {
  @ApiProperty({ example: 'Maria Souza', maxLength: TAMANHO_MAXIMO_NOME })
  @IsString({ message: MENSAGEM_TEXTO })
  @Matches(/\S/, { message: 'é obrigatório' })
  @MaxLength(TAMANHO_MAXIMO_NOME, maximo(TAMANHO_MAXIMO_NOME))
  nome: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'maria@empresa.com.br',
    description:
      'Gravado aparado e em minúsculas. Informe e-mail, telefone ou os dois (R4.1).',
  })
  @IsOptional()
  @IsString({ message: MENSAGEM_TEXTO })
  @MaxLength(254, maximo(254))
  @EhEmail()
  email?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: '(11) 98765-4321',
    description:
      'Em qualquer formato; gravado em E.164 só com dígitos (`5511987654321`). Números brasileiros sem o 55 ganham o código do país e têm o DDD validado (R4.1).',
  })
  @IsOptional()
  @IsString({ message: MENSAGEM_TEXTO })
  @MaxLength(30, maximo(30))
  @EhTelefone()
  telefone?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'Diretora financeira',
  })
  @IsOptional()
  @IsString({ message: MENSAGEM_TEXTO })
  @MaxLength(TAMANHO_MAXIMO_TEXTO_CURTO, maximo(TAMANHO_MAXIMO_TEXTO_CURTO))
  cargo?: string | null;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Empresa existente. Use `empresaId` ou `empresaNome`.',
  })
  @IsOptional()
  @ParaMinusculas()
  @IsUUID('loose', MENSAGEM_UUID)
  empresaId?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'ACME Ltda',
    description:
      'Nome da empresa: vincula à empresa ativa com o mesmo nome (sem diferenciar maiúsculas) ou cria uma nova.',
  })
  @IsOptional()
  @IsString({ message: MENSAGEM_TEXTO })
  @MaxLength(TAMANHO_MAXIMO_NOME, maximo(TAMANHO_MAXIMO_NOME))
  empresaNome?: string | null;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Usuário ativo (R4.5). Padrão: quem cria. Líder atribui a si ou à equipe; membro, só a si.',
  })
  @SeInformado()
  @ParaMinusculas()
  @IsUUID('loose', MENSAGEM_UUID)
  responsavelId?: string;

  @ApiPropertyOptional({
    enum: ORIGENS_MANUAIS,
    default: 'MANUAL',
    description:
      'De onde a pessoa veio (R4.3). WEBHOOK, PASSAGEM e IMPORTACAO são só do sistema.',
  })
  @SeInformado()
  @IsIn(ORIGENS_MANUAIS, {
    message: `deve ser um destes valores: ${ORIGENS_MANUAIS.join(', ')}`,
  })
  origem?: OrigemManual;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'Indicação do cliente ACME',
  })
  @IsOptional()
  @IsString({ message: MENSAGEM_TEXTO })
  @MaxLength(TAMANHO_MAXIMO_TEXTO_CURTO, maximo(TAMANHO_MAXIMO_TEXTO_CURTO))
  origemDetalhe?: string | null;

  @ApiPropertyOptional({ type: () => UtmOrigemDto, nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => UtmOrigemDto)
  utm?: UtmOrigemDto | null;

  @ApiPropertyOptional({
    type: [String],
    example: ['VIP', 'Evento 2026'],
    description: 'Aparadas e sem duplicatas (R4.7).',
  })
  @SeInformado()
  @IsArray({ message: 'deve ser uma lista' })
  @ArrayMaxSize(QUANTIDADE_MAXIMA_ETIQUETAS, MENSAGEM_LISTA_DE_ETIQUETAS)
  @IsString({ each: true, message: '(cada item) deve ser um texto' })
  @MaxLength(100, {
    each: true,
    message: '(cada item) deve ter no máximo 100 caracteres',
  })
  etiquetas?: string[];

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    example: { faturamento: '50 mil', segmento: 'Varejo' },
    description: 'Objeto JSON livre (R4.7): até 200 chaves e 64 KB.',
  })
  @SeInformado()
  @EhCamposPersonalizados()
  camposPersonalizados?: Record<string, unknown>;

  @ApiPropertyOptional({
    default: false,
    description:
      'Não quer receber disparos nem automações de marketing (R4.6).',
  })
  @SeInformado()
  @IsBoolean({ message: 'deve ser verdadeiro ou falso' })
  optOutMarketing?: boolean;

  @ApiPropertyOptional({ type: () => ConsentimentoEntradaDto, nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => ConsentimentoEntradaDto)
  consentimento?: ConsentimentoEntradaDto | null;
}

/**
 * Edição (PATCH): só os campos enviados mudam. `null` (ou texto vazio) apaga
 * e-mail, telefone, cargo e empresa — desde que sobre um meio de contato
 * (R4.1). As origens não se editam (R4.3).
 */
export class AtualizarContatoDto {
  @ApiPropertyOptional({ maxLength: TAMANHO_MAXIMO_NOME })
  @SeInformado()
  @IsString({ message: MENSAGEM_TEXTO })
  @Matches(/\S/, { message: 'é obrigatório' })
  @MaxLength(TAMANHO_MAXIMO_NOME, maximo(TAMANHO_MAXIMO_NOME))
  nome?: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsString({ message: MENSAGEM_TEXTO })
  @MaxLength(254, maximo(254))
  @EhEmail()
  email?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsString({ message: MENSAGEM_TEXTO })
  @MaxLength(30, maximo(30))
  @EhTelefone()
  telefone?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsString({ message: MENSAGEM_TEXTO })
  @MaxLength(TAMANHO_MAXIMO_TEXTO_CURTO, maximo(TAMANHO_MAXIMO_TEXTO_CURTO))
  cargo?: string | null;

  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true })
  @IsOptional()
  @ParaMinusculas()
  @IsUUID('loose', MENSAGEM_UUID)
  empresaId?: string | null;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Usuário ativo (R4.5). Líder atribui a si ou à equipe; membro, só a si.',
  })
  @SeInformado()
  @ParaMinusculas()
  @IsUUID('loose', MENSAGEM_UUID)
  responsavelId?: string;

  @ApiPropertyOptional({
    type: [String],
    description: 'Substitui a lista inteira.',
  })
  @SeInformado()
  @IsArray({ message: 'deve ser uma lista' })
  @ArrayMaxSize(QUANTIDADE_MAXIMA_ETIQUETAS, MENSAGEM_LISTA_DE_ETIQUETAS)
  @IsString({ each: true, message: '(cada item) deve ser um texto' })
  @MaxLength(100, {
    each: true,
    message: '(cada item) deve ter no máximo 100 caracteres',
  })
  etiquetas?: string[];

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    nullable: true,
    example: { faturamento: '80 mil', antigo: null },
    description:
      'Mescla com os atuais: as chaves enviadas substituem, `null` apaga a chave, as ausentes ficam. `null` no lugar do objeto limpa tudo.',
  })
  @IsOptional()
  @EhCamposPersonalizados()
  camposPersonalizados?: Record<string, unknown> | null;

  @ApiPropertyOptional({
    description: 'Ligar registra a data do opt-out; desligar a apaga (R4.6).',
  })
  @SeInformado()
  @IsBoolean({ message: 'deve ser verdadeiro ou falso' })
  optOutMarketing?: boolean;

  @ApiPropertyOptional({
    type: () => ConsentimentoEntradaDto,
    nullable: true,
    description: '`null` apaga o consentimento registrado.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => ConsentimentoEntradaDto)
  consentimento?: ConsentimentoEntradaDto | null;
}

export const ORDENACOES_DE_CONTATOS = [
  'criadoEm',
  'atualizadoEm',
  'nome',
  'ultimaOrigemEm',
] as const;
export type OrdenacaoDeContatos = (typeof ORDENACOES_DE_CONTATOS)[number];

/** Listagem com busca, filtros e paginação. */
export class FiltroContatosDto extends PaginacaoDto {
  @ApiPropertyOptional({
    description:
      'Nome, e-mail ou telefone (em qualquer formato). Cada palavra precisa aparecer no nome ou no e-mail.',
  })
  @IsOptional()
  @IsString({ message: MENSAGEM_TEXTO })
  @MaxLength(TAMANHO_MAXIMO_BUSCA, maximo(TAMANHO_MAXIMO_BUSCA))
  busca?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @ParaMinusculas()
  @IsUUID('loose', MENSAGEM_UUID)
  responsavelId?: string;

  @ApiPropertyOptional({ description: 'Só os contatos sem responsável.' })
  @IsOptional()
  @ParaBooleano()
  @IsBoolean({ message: 'deve ser verdadeiro ou falso' })
  semResponsavel?: boolean;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @ParaMinusculas()
  @IsUUID('loose', MENSAGEM_UUID)
  empresaId?: string;

  @ApiPropertyOptional({
    enum: OrigemContato,
    enumName: 'OrigemContato',
    description: 'Primeira origem (R4.3).',
  })
  @IsOptional()
  @IsEnum(OrigemContato, {
    message: `deve ser um destes valores: ${Object.values(OrigemContato).join(', ')}`,
  })
  origem?: OrigemContato;

  @ApiPropertyOptional({
    enum: OrigemContato,
    enumName: 'OrigemContato',
    description: 'Última origem (R4.3).',
  })
  @IsOptional()
  @IsEnum(OrigemContato, {
    message: `deve ser um destes valores: ${Object.values(OrigemContato).join(', ')}`,
  })
  ultimaOrigem?: OrigemContato;

  @ApiPropertyOptional({
    description: 'Tem a etiqueta (sem diferenciar maiúsculas).',
    example: 'VIP',
  })
  @IsOptional()
  @IsString({ message: MENSAGEM_TEXTO })
  @MaxLength(100, maximo(100))
  etiqueta?: string;

  @ApiPropertyOptional({
    description: 'Com (`true`) ou sem (`false`) opt-out de marketing (R4.6).',
  })
  @IsOptional()
  @ParaBooleano()
  @IsBoolean({ message: 'deve ser verdadeiro ou falso' })
  optOut?: boolean;

  @ApiPropertyOptional({ enum: ORDENACOES_DE_CONTATOS, default: 'criadoEm' })
  @IsOptional()
  @IsIn(ORDENACOES_DE_CONTATOS, {
    message: `deve ser um destes valores: ${ORDENACOES_DE_CONTATOS.join(', ')}`,
  })
  ordenarPor: OrdenacaoDeContatos = 'criadoEm';

  @ApiPropertyOptional({
    enum: ['asc', 'desc'],
    description: 'Padrão: `asc` para nome, `desc` para datas.',
  })
  @IsOptional()
  @IsIn(['asc', 'desc'], { message: 'deve ser asc ou desc' })
  ordem?: 'asc' | 'desc';
}

export class AnonimizarContatoDto {
  @ApiPropertyOptional({
    maxLength: TAMANHO_MAXIMO_MOTIVO,
    example: 'Pedido do titular por e-mail em 20/10/2026',
    description:
      'Fica na auditoria, que é permanente: não escreva dados pessoais aqui.',
  })
  @IsOptional()
  @IsString({ message: MENSAGEM_TEXTO })
  @MaxLength(TAMANHO_MAXIMO_MOTIVO, maximo(TAMANHO_MAXIMO_MOTIVO))
  motivo?: string;
}

export class ContatoDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'Maria Souza' })
  nome: string;

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
    description: 'E.164 só com dígitos.',
  })
  telefone: string | null;

  @ApiProperty({ type: String, nullable: true })
  cargo: string | null;

  @ApiProperty({ type: () => EmpresaVinculadaDto, nullable: true })
  empresa: EmpresaVinculadaDto | null;

  @ApiProperty({ type: () => UsuarioVinculadoDto, nullable: true })
  responsavel: UsuarioVinculadoDto | null;

  @ApiProperty({ type: () => OrigemContatoDto })
  primeiraOrigem: OrigemContatoDto;

  @ApiProperty({ type: () => UltimaOrigemContatoDto })
  ultimaOrigem: UltimaOrigemContatoDto;

  @ApiProperty({
    example: 2,
    description:
      'Quantas vezes chegou: 1 na criação, +1 a cada reconversão (R4.2).',
  })
  conversoes: number;

  @ApiProperty({ type: [String], example: ['VIP'] })
  etiquetas: string[];

  @ApiProperty({ type: 'object', additionalProperties: true })
  camposPersonalizados: Record<string, unknown>;

  @ApiProperty({
    description: 'Fora de disparos e automações de marketing (R4.6).',
  })
  optOutMarketing: boolean;

  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  optOutEm: string | null;

  @ApiProperty({ type: () => ConsentimentoContatoDto, nullable: true })
  consentimento: ConsentimentoContatoDto | null;

  @ApiProperty({ type: () => UsuarioVinculadoDto, nullable: true })
  criadoPor: UsuarioVinculadoDto | null;

  @ApiProperty({ format: 'date-time' })
  criadoEm: string;

  @ApiProperty({ format: 'date-time' })
  atualizadoEm: string;

  @ApiProperty({
    description:
      'Quem pede pode editar (matriz §12: Admin e C-level, todos; líder, os da equipe; membro, os seus).',
  })
  podeEditar: boolean;

  static de(contato: ContatoComRelacoes, podeEditar: boolean): ContatoDto {
    return {
      id: contato.id,
      nome: contato.nome,
      email: contato.email,
      telefone: contato.telefone,
      cargo: contato.cargo,
      empresa: contato.empresa
        ? { id: contato.empresa.id, nome: contato.empresa.nome }
        : null,
      responsavel: contato.responsavel
        ? UsuarioVinculadoDto.de(contato.responsavel)
        : null,
      primeiraOrigem: {
        tipo: contato.primeiraOrigem,
        detalhe: contato.primeiraOrigemDetalhe,
        utm: UtmOrigemDto.de(utmDoJson(contato.primeiraOrigemUtm)),
      },
      ultimaOrigem: {
        tipo: contato.ultimaOrigem,
        detalhe: contato.ultimaOrigemDetalhe,
        utm: UtmOrigemDto.de(utmDoJson(contato.ultimaOrigemUtm)),
        em: contato.ultimaOrigemEm.toISOString(),
      },
      conversoes: contato.conversoes,
      etiquetas: contato.etiquetas,
      camposPersonalizados: objetoJson(contato.camposPersonalizados),
      optOutMarketing: contato.optOutMarketing,
      optOutEm: contato.optOutEm?.toISOString() ?? null,
      consentimento:
        contato.consentimentoEm || contato.consentimentoOrigem
          ? {
              em: contato.consentimentoEm?.toISOString() ?? null,
              origem: contato.consentimentoOrigem,
            }
          : null,
      criadoPor: contato.criadoPor
        ? UsuarioVinculadoDto.de(contato.criadoPor)
        : null,
      criadoEm: contato.criadoEm.toISOString(),
      atualizadoEm: contato.atualizadoEm.toISOString(),
      podeEditar,
    };
  }
}

/** Resposta do `POST /contatos` (201 nos dois casos). */
export class ResultadoCriacaoContatoDto {
  @ApiProperty({
    description:
      '`true`: contato novo. `false`: já existia um contato ativo com o mesmo e-mail ou telefone, que foi reconvertido (R4.2).',
  })
  criado: boolean;

  @ApiProperty({ type: () => ContatoDto })
  contato: ContatoDto;
}
