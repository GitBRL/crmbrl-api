import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';
import { formatarCnpj } from '../../comum/dominio/cnpj';
import { QUANTIDADE_MAXIMA_ETIQUETAS } from '../../comum/dominio/etiquetas';
import { PaginacaoDto } from '../../comum/paginacao/paginacao';
import {
  TAMANHO_MAXIMO_BUSCA,
  TAMANHO_MAXIMO_NOME,
  TAMANHO_MAXIMO_SITE,
  TAMANHO_MAXIMO_TEXTO_CURTO,
  UFS,
} from '../contatos.constantes';
import { objetoJson } from '../deduplicacao';
import type { EmpresaComRelacoes } from '../relacoes';
import { UsuarioVinculadoDto } from './comum.dto';
import {
  EhCamposPersonalizados,
  EhCnpj,
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
const MENSAGEM_UF = { message: 'deve ser a sigla de uma UF (ex.: SP)' };

/** UF em maiúsculas; texto vazio vira `null` (= sem UF). */
const ParaUf = () =>
  Transform(({ value }: { value: unknown }) => {
    if (typeof value !== 'string') {
      return value;
    }
    const sigla = value.trim().toUpperCase();
    return sigla === '' ? null : sigla;
  });

/** Criação de empresa (R4.4, R4.5, R4.7). */
export class CriarEmpresaDto {
  @ApiProperty({ example: 'ACME Ltda', maxLength: TAMANHO_MAXIMO_NOME })
  @IsString({ message: MENSAGEM_TEXTO })
  @Matches(/\S/, { message: 'é obrigatório' })
  @MaxLength(TAMANHO_MAXIMO_NOME, maximo(TAMANHO_MAXIMO_NOME))
  nome: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: '11.222.333/0001-81',
    description:
      'Opcional; se vier, os dígitos verificadores são validados e ele é único entre as empresas (R4.4). Aceita o CNPJ alfanumérico. Gravado sem pontuação.',
  })
  @IsOptional()
  @IsString({ message: MENSAGEM_TEXTO })
  @MaxLength(30, maximo(30))
  @EhCnpj()
  cnpj?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'https://acme.com.br',
  })
  @IsOptional()
  @IsString({ message: MENSAGEM_TEXTO })
  @MaxLength(TAMANHO_MAXIMO_SITE, maximo(TAMANHO_MAXIMO_SITE))
  site?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'contato@acme.com.br',
  })
  @IsOptional()
  @IsString({ message: MENSAGEM_TEXTO })
  @MaxLength(254, maximo(254))
  @EhEmail()
  email?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: '(11) 3333-4444',
  })
  @IsOptional()
  @IsString({ message: MENSAGEM_TEXTO })
  @MaxLength(30, maximo(30))
  @EhTelefone()
  telefone?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'Varejo' })
  @IsOptional()
  @IsString({ message: MENSAGEM_TEXTO })
  @MaxLength(TAMANHO_MAXIMO_TEXTO_CURTO, maximo(TAMANHO_MAXIMO_TEXTO_CURTO))
  segmento?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'São Paulo' })
  @IsOptional()
  @IsString({ message: MENSAGEM_TEXTO })
  @MaxLength(TAMANHO_MAXIMO_TEXTO_CURTO, maximo(TAMANHO_MAXIMO_TEXTO_CURTO))
  cidade?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    enum: UFS,
    example: 'SP',
  })
  @IsOptional()
  @ParaUf()
  @IsIn(UFS, MENSAGEM_UF)
  uf?: string | null;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Usuário ativo (R4.5). Padrão: quem cria. Líder atribui a si ou à equipe; membro, só a si.',
  })
  @SeInformado()
  @ParaMinusculas()
  @IsUUID('loose', MENSAGEM_UUID)
  responsavelId?: string;

  @ApiPropertyOptional({ type: [String], example: ['Cliente', 'Grande conta'] })
  @SeInformado()
  @IsArray({ message: 'deve ser uma lista' })
  @ArrayMaxSize(QUANTIDADE_MAXIMA_ETIQUETAS, {
    message: `deve ter no máximo ${QUANTIDADE_MAXIMA_ETIQUETAS} etiquetas`,
  })
  @IsString({ each: true, message: '(cada item) deve ser um texto' })
  @MaxLength(100, {
    each: true,
    message: '(cada item) deve ter no máximo 100 caracteres',
  })
  etiquetas?: string[];

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  @SeInformado()
  @EhCamposPersonalizados()
  camposPersonalizados?: Record<string, unknown>;
}

/** Edição (PATCH): só os campos enviados mudam; `null` apaga os opcionais. */
export class AtualizarEmpresaDto {
  @ApiPropertyOptional({ maxLength: TAMANHO_MAXIMO_NOME })
  @SeInformado()
  @IsString({ message: MENSAGEM_TEXTO })
  @Matches(/\S/, { message: 'é obrigatório' })
  @MaxLength(TAMANHO_MAXIMO_NOME, maximo(TAMANHO_MAXIMO_NOME))
  nome?: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsString({ message: MENSAGEM_TEXTO })
  @MaxLength(30, maximo(30))
  @EhCnpj()
  cnpj?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsString({ message: MENSAGEM_TEXTO })
  @MaxLength(TAMANHO_MAXIMO_SITE, maximo(TAMANHO_MAXIMO_SITE))
  site?: string | null;

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
  segmento?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsString({ message: MENSAGEM_TEXTO })
  @MaxLength(TAMANHO_MAXIMO_TEXTO_CURTO, maximo(TAMANHO_MAXIMO_TEXTO_CURTO))
  cidade?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, enum: UFS })
  @IsOptional()
  @ParaUf()
  @IsIn(UFS, MENSAGEM_UF)
  uf?: string | null;

  @ApiPropertyOptional({ format: 'uuid' })
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
  @ArrayMaxSize(QUANTIDADE_MAXIMA_ETIQUETAS, {
    message: `deve ter no máximo ${QUANTIDADE_MAXIMA_ETIQUETAS} etiquetas`,
  })
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
    description:
      'Mescla com os atuais: `null` numa chave a apaga; `null` no lugar do objeto limpa tudo.',
  })
  @IsOptional()
  @EhCamposPersonalizados()
  camposPersonalizados?: Record<string, unknown> | null;
}

export const ORDENACOES_DE_EMPRESAS = [
  'nome',
  'criadoEm',
  'atualizadoEm',
] as const;
export type OrdenacaoDeEmpresas = (typeof ORDENACOES_DE_EMPRESAS)[number];

export class FiltroEmpresasDto extends PaginacaoDto {
  @ApiPropertyOptional({
    description: 'Nome, CNPJ (com ou sem pontuação), e-mail ou telefone.',
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

  @ApiPropertyOptional({ description: 'Só as empresas sem responsável.' })
  @IsOptional()
  @ParaBooleano()
  @IsBoolean({ message: 'deve ser verdadeiro ou falso' })
  semResponsavel?: boolean;

  @ApiPropertyOptional({
    description: 'Tem a etiqueta (sem diferenciar maiúsculas).',
  })
  @IsOptional()
  @IsString({ message: MENSAGEM_TEXTO })
  @MaxLength(100, maximo(100))
  etiqueta?: string;

  @ApiPropertyOptional({ enum: UFS })
  @IsOptional()
  @ParaUf()
  @IsIn(UFS, MENSAGEM_UF)
  uf?: string;

  @ApiPropertyOptional({ enum: ORDENACOES_DE_EMPRESAS, default: 'nome' })
  @IsOptional()
  @IsIn(ORDENACOES_DE_EMPRESAS, {
    message: `deve ser um destes valores: ${ORDENACOES_DE_EMPRESAS.join(', ')}`,
  })
  ordenarPor: OrdenacaoDeEmpresas = 'nome';

  @ApiPropertyOptional({
    enum: ['asc', 'desc'],
    description: 'Padrão: `asc` para nome, `desc` para datas.',
  })
  @IsOptional()
  @IsIn(['asc', 'desc'], { message: 'deve ser asc ou desc' })
  ordem?: 'asc' | 'desc';
}

export class EmpresaDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'ACME Ltda' })
  nome: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '11222333000181',
    description: 'Sem pontuação (12 caracteres alfanuméricos + 2 dígitos).',
  })
  cnpj: string | null;

  @ApiProperty({ type: String, nullable: true, example: '11.222.333/0001-81' })
  cnpjFormatado: string | null;

  @ApiProperty({ type: String, nullable: true })
  site: string | null;

  @ApiProperty({ type: String, nullable: true })
  email: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'E.164 só com dígitos.',
  })
  telefone: string | null;

  @ApiProperty({ type: String, nullable: true })
  segmento: string | null;

  @ApiProperty({ type: String, nullable: true })
  cidade: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'SP' })
  uf: string | null;

  @ApiProperty({ type: () => UsuarioVinculadoDto, nullable: true })
  responsavel: UsuarioVinculadoDto | null;

  @ApiProperty({ type: [String] })
  etiquetas: string[];

  @ApiProperty({ type: 'object', additionalProperties: true })
  camposPersonalizados: Record<string, unknown>;

  @ApiProperty({
    example: 3,
    description: 'Contatos ativos ligados à empresa.',
  })
  quantidadeContatos: number;

  @ApiProperty({ type: () => UsuarioVinculadoDto, nullable: true })
  criadoPor: UsuarioVinculadoDto | null;

  @ApiProperty({ format: 'date-time' })
  criadoEm: string;

  @ApiProperty({ format: 'date-time' })
  atualizadoEm: string;

  @ApiProperty({
    description:
      'Quem pede pode editar (matriz §12: Admin e C-level, todas; líder, as da equipe; membro, as suas).',
  })
  podeEditar: boolean;

  static de(empresa: EmpresaComRelacoes, podeEditar: boolean): EmpresaDto {
    return {
      id: empresa.id,
      nome: empresa.nome,
      cnpj: empresa.cnpj,
      cnpjFormatado: empresa.cnpj ? formatarCnpj(empresa.cnpj) : null,
      site: empresa.site,
      email: empresa.email,
      telefone: empresa.telefone,
      segmento: empresa.segmento,
      cidade: empresa.cidade,
      uf: empresa.uf,
      responsavel: empresa.responsavel
        ? UsuarioVinculadoDto.de(empresa.responsavel)
        : null,
      etiquetas: empresa.etiquetas,
      camposPersonalizados: objetoJson(empresa.camposPersonalizados),
      quantidadeContatos: empresa._count.contatos,
      criadoPor: empresa.criadoPor
        ? UsuarioVinculadoDto.de(empresa.criadoPor)
        : null,
      criadoEm: empresa.criadoEm.toISOString(),
      atualizadoEm: empresa.atualizadoEm.toISOString(),
      podeEditar,
    };
  }
}
