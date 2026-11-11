import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  type Etapa,
  type Funil,
  TipoEtapa,
  VisibilidadeFunil,
} from '../../generated/prisma/client';
import { NIVEIS_NO_FUNIL, type NivelNoFunil } from '../acesso-funis';
import { aparar, lerBooleano, OpcionalNaoNulo } from './comum.dto';
import type { Area } from '../../comum/dominio/setores';
import { ChaveDeSetor } from '../../comum/validacao/setor';

/** Limites das etapas (R5.2). */
export const PRAZO_MAXIMO_DIAS = 3_650;
export const ETAPAS_POR_FUNIL_MAXIMO = 30;

export class EtapaDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  funilId: string;

  @ApiProperty({ example: 'Proposta' })
  nome: string;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description:
      'Identifica as etapas da configuração inicial (ex.: `qualificado_mql`), estável mesmo se renomeadas.',
    example: 'proposta',
  })
  chave: string | null;

  @ApiProperty({ description: 'Posição no funil, a partir de 1.', example: 4 })
  ordem: number;

  @ApiProperty({ enum: TipoEtapa, enumName: 'TipoEtapa' })
  tipo: TipoEtapa;

  @ApiPropertyOptional({
    nullable: true,
    type: Number,
    description:
      'Prazo-alvo em dias: acima dele o negócio aberto está "parado" (R5.10).',
    example: 7,
  })
  prazoDias: number | null;

  @ApiPropertyOptional({
    nullable: true,
    type: Number,
    description: 'Probabilidade de fechamento, de 0 a 100.',
    example: 60,
  })
  probabilidade: number | null;

  @ApiProperty({ format: 'date-time' })
  criadoEm: string;

  @ApiProperty({ format: 'date-time' })
  atualizadoEm: string;

  static de(etapa: Etapa): EtapaDto {
    return {
      id: etapa.id,
      funilId: etapa.funilId,
      nome: etapa.nome,
      chave: etapa.chave,
      ordem: etapa.ordem,
      tipo: etapa.tipo,
      prazoDias: etapa.prazoDias,
      probabilidade: etapa.probabilidade,
      criadoEm: etapa.criadoEm.toISOString(),
      atualizadoEm: etapa.atualizadoEm.toISOString(),
    };
  }
}

/** O funil com etapas e o nome do setor, como `FunilDto.de` precisa. */
export type FunilParaDto = Funil & {
  etapas: Etapa[];
  setor: { nome: string };
};

export class FunilDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'Comercial' })
  nome: string;

  @ApiProperty({ type: String, example: 'COMERCIAL' })
  area: Area;

  @ApiProperty({
    description:
      'Funil-base da área (R5.1): não pode ser excluído, só arquivado.',
  })
  base: boolean;

  @ApiProperty({ example: 2 })
  ordem: number;

  @ApiProperty({
    description: 'Falso = arquivado: some do kanban e não recebe negócios.',
  })
  ativo: boolean;

  @ApiPropertyOptional({ nullable: true, type: String })
  descricao: string | null;

  @ApiProperty({ example: 'Comercial', description: 'Nome do setor dono.' })
  nomeSetor: string;

  @ApiProperty({
    enum: VisibilidadeFunil,
    enumName: 'VisibilidadeFunil',
    description:
      'Quem vê (R5.9): `SETOR` = o setor dono inteiro; `RESTRITA` = do setor dono só os líderes, os demais só pela lista de acessos do funil.',
  })
  visibilidade: VisibilidadeFunil;

  @ApiProperty({
    enum: NIVEIS_NO_FUNIL,
    enumName: 'NivelNoFunil',
    description:
      'O nível de quem consulta neste funil (R5.12), para a tela decidir os botões: `CONFIGURAR` (líder do setor dono, C-level, Admin: configura, reabre e exclui), `GESTOR` (vê, cria, edita e move todos, troca o responsável), `MEMBRO` (vê os seus e os sem responsável; cria, assume, edita e move os que vê) ou `VER` (só leitura).',
  })
  nivel: NivelNoFunil;

  @ApiProperty({
    description:
      'Vê todos os negócios do funil (R5.12): verdadeiro se quem consulta tem, por algum caminho (direto, pelo setor ou pelo papel), `VER`, `GESTOR` ou `CONFIGURAR`; falso = só os seus e os sem responsável. Ver é separado de agir: um `MEMBRO` com `veTodos` vê os negócios dos colegas, mas edita e move só os seus e os sem responsável.',
  })
  veTodos: boolean;

  @ApiProperty({ type: [EtapaDto], description: 'Etapas em ordem.' })
  etapas: EtapaDto[];

  @ApiProperty({ format: 'date-time' })
  criadoEm: string;

  @ApiProperty({ format: 'date-time' })
  atualizadoEm: string;

  static de(
    funil: FunilParaDto,
    nivel: NivelNoFunil,
    veTodos = nivel !== 'MEMBRO',
  ): FunilDto {
    return {
      id: funil.id,
      nome: funil.nome,
      area: funil.area,
      base: funil.base,
      ordem: funil.ordem,
      ativo: funil.ativo,
      descricao: funil.descricao,
      nomeSetor: funil.setor.nome,
      visibilidade: funil.visibilidade,
      nivel,
      veTodos,
      etapas: [...funil.etapas]
        .sort((a, b) => a.ordem - b.ordem)
        .map((etapa) => EtapaDto.de(etapa)),
      criadoEm: funil.criadoEm.toISOString(),
      atualizadoEm: funil.atualizadoEm.toISOString(),
    };
  }
}

export class FiltroFunisDto {
  @ApiPropertyOptional({ type: String, example: 'COMERCIAL' })
  @IsOptional()
  @ChaveDeSetor()
  area?: Area;

  @ApiPropertyOptional({
    description: 'Inclui os funis arquivados.',
    default: false,
  })
  @IsOptional()
  @Transform(lerBooleano)
  @IsBoolean({ message: 'deve ser verdadeiro ou falso' })
  incluirArquivados: boolean = false;
}

/** Etapa dentro da criação de um funil (a ordem é a da lista). */
export class NovaEtapaDoFunilDto {
  @ApiProperty({ example: 'Proposta', maxLength: 100 })
  @Transform(aparar)
  @IsString({ message: 'deve ser um texto' })
  @IsNotEmpty({ message: 'é obrigatório' })
  @MaxLength(100, { message: 'deve ter no máximo 100 caracteres' })
  nome: string;

  @ApiPropertyOptional({
    enum: TipoEtapa,
    enumName: 'TipoEtapa',
    default: TipoEtapa.ABERTA,
  })
  @IsOptional()
  @IsEnum(TipoEtapa, { message: 'deve ser ABERTA, GANHO ou PERDIDO' })
  tipo?: TipoEtapa;

  @ApiPropertyOptional({
    nullable: true,
    type: Number,
    minimum: 1,
    maximum: PRAZO_MAXIMO_DIAS,
  })
  @IsOptional()
  @IsInt({ message: 'deve ser um número inteiro' })
  @Min(1, { message: 'deve ser no mínimo 1' })
  @Max(PRAZO_MAXIMO_DIAS, {
    message: `deve ser no máximo ${PRAZO_MAXIMO_DIAS}`,
  })
  prazoDias?: number | null;

  @ApiPropertyOptional({
    nullable: true,
    type: Number,
    minimum: 0,
    maximum: 100,
  })
  @IsOptional()
  @IsInt({ message: 'deve ser um número inteiro' })
  @Min(0, { message: 'deve ser no mínimo 0' })
  @Max(100, { message: 'deve ser no máximo 100' })
  probabilidade?: number | null;
}

export class CriarFunilDto {
  @ApiProperty({ example: 'Parcerias', maxLength: 100 })
  @Transform(aparar)
  @IsString({ message: 'deve ser um texto' })
  @IsNotEmpty({ message: 'é obrigatório' })
  @MaxLength(100, { message: 'deve ter no máximo 100 caracteres' })
  nome: string;

  @ApiProperty({ type: String, example: 'COMERCIAL' })
  @ChaveDeSetor()
  area: Area;

  @ApiPropertyOptional({ nullable: true, type: String, maxLength: 500 })
  @IsOptional()
  @Transform(aparar)
  @IsString({ message: 'deve ser um texto' })
  @MaxLength(500, { message: 'deve ter no máximo 500 caracteres' })
  descricao?: string | null;

  @ApiPropertyOptional({
    enum: VisibilidadeFunil,
    enumName: 'VisibilidadeFunil',
    default: VisibilidadeFunil.SETOR,
    description: 'Quem vê (R5.9). Padrão: o setor inteiro.',
  })
  @IsOptional()
  @IsEnum(VisibilidadeFunil, { message: 'deve ser SETOR ou RESTRITA' })
  visibilidade?: VisibilidadeFunil;

  @ApiPropertyOptional({
    type: [NovaEtapaDoFunilDto],
    description:
      'Etapas em ordem: ao menos uma aberta, exatamente uma de ganho e uma de perda (R5.2). ' +
      'Sem a lista, o funil nasce com Novo → Em andamento → Ganho → Perdido.',
  })
  @IsOptional()
  @IsArray({ message: 'deve ser uma lista' })
  @ArrayMinSize(3, { message: 'deve ter pelo menos 3 etapas' })
  @ArrayMaxSize(ETAPAS_POR_FUNIL_MAXIMO, {
    message: `deve ter no máximo ${ETAPAS_POR_FUNIL_MAXIMO} etapas`,
  })
  @ValidateNested({ each: true })
  @Type(() => NovaEtapaDoFunilDto)
  etapas?: NovaEtapaDoFunilDto[];
}

export class AtualizarFunilDto {
  @ApiPropertyOptional({ example: 'Parcerias', maxLength: 100 })
  @OpcionalNaoNulo()
  @Transform(aparar)
  @IsString({ message: 'deve ser um texto' })
  @IsNotEmpty({ message: 'é obrigatório' })
  @MaxLength(100, { message: 'deve ter no máximo 100 caracteres' })
  nome?: string;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    maxLength: 500,
    description: '`null` apaga a descrição.',
  })
  @IsOptional()
  @Transform(aparar)
  @IsString({ message: 'deve ser um texto' })
  @MaxLength(500, { message: 'deve ter no máximo 500 caracteres' })
  descricao?: string | null;

  @ApiPropertyOptional({
    description: 'Posição do funil na lista.',
    minimum: 0,
  })
  @OpcionalNaoNulo()
  @IsInt({ message: 'deve ser um número inteiro' })
  @Min(0, { message: 'deve ser no mínimo 0' })
  @Max(10_000, { message: 'deve ser no máximo 10000' })
  ordem?: number;

  @ApiPropertyOptional({
    description: 'Falso arquiva o funil; verdadeiro o reativa.',
  })
  @OpcionalNaoNulo()
  @IsBoolean({ message: 'deve ser verdadeiro ou falso' })
  ativo?: boolean;

  @ApiPropertyOptional({
    enum: VisibilidadeFunil,
    enumName: 'VisibilidadeFunil',
    description:
      'Quem vê (R5.9): `SETOR` = o setor dono inteiro; `RESTRITA` = do setor dono só os líderes, os demais só pela lista de acessos do funil.',
  })
  @OpcionalNaoNulo()
  @IsEnum(VisibilidadeFunil, { message: 'deve ser SETOR ou RESTRITA' })
  visibilidade?: VisibilidadeFunil;
}

export class CriarEtapaDto {
  @ApiProperty({ example: 'Demonstração', maxLength: 100 })
  @Transform(aparar)
  @IsString({ message: 'deve ser um texto' })
  @IsNotEmpty({ message: 'é obrigatório' })
  @MaxLength(100, { message: 'deve ter no máximo 100 caracteres' })
  nome: string;

  @ApiPropertyOptional({
    enum: TipoEtapa,
    enumName: 'TipoEtapa',
    default: TipoEtapa.ABERTA,
    description:
      'Só `ABERTA`: o funil já tem a única etapa de ganho e a única de perda (R5.2).',
  })
  @IsOptional()
  @IsEnum(TipoEtapa, { message: 'deve ser ABERTA, GANHO ou PERDIDO' })
  tipo?: TipoEtapa;

  @ApiPropertyOptional({
    description:
      'Posição (a partir de 1). Padrão: depois da última etapa aberta, antes do ganho e da perda.',
    minimum: 1,
  })
  @OpcionalNaoNulo()
  @IsInt({ message: 'deve ser um número inteiro' })
  @Min(1, { message: 'deve ser no mínimo 1' })
  @Max(ETAPAS_POR_FUNIL_MAXIMO, {
    message: `deve ser no máximo ${ETAPAS_POR_FUNIL_MAXIMO}`,
  })
  ordem?: number;

  @ApiPropertyOptional({
    nullable: true,
    type: Number,
    minimum: 1,
    maximum: PRAZO_MAXIMO_DIAS,
  })
  @IsOptional()
  @IsInt({ message: 'deve ser um número inteiro' })
  @Min(1, { message: 'deve ser no mínimo 1' })
  @Max(PRAZO_MAXIMO_DIAS, {
    message: `deve ser no máximo ${PRAZO_MAXIMO_DIAS}`,
  })
  prazoDias?: number | null;

  @ApiPropertyOptional({
    nullable: true,
    type: Number,
    minimum: 0,
    maximum: 100,
  })
  @IsOptional()
  @IsInt({ message: 'deve ser um número inteiro' })
  @Min(0, { message: 'deve ser no mínimo 0' })
  @Max(100, { message: 'deve ser no máximo 100' })
  probabilidade?: number | null;
}

/** O tipo da etapa não muda depois de criada (ganho e perda são únicos por funil). */
export class AtualizarEtapaDto {
  @ApiPropertyOptional({ example: 'Proposta enviada', maxLength: 100 })
  @OpcionalNaoNulo()
  @Transform(aparar)
  @IsString({ message: 'deve ser um texto' })
  @IsNotEmpty({ message: 'é obrigatório' })
  @MaxLength(100, { message: 'deve ter no máximo 100 caracteres' })
  nome?: string;

  @ApiPropertyOptional({
    nullable: true,
    type: Number,
    minimum: 1,
    maximum: PRAZO_MAXIMO_DIAS,
    description: '`null` tira o prazo-alvo.',
  })
  @IsOptional()
  @IsInt({ message: 'deve ser um número inteiro' })
  @Min(1, { message: 'deve ser no mínimo 1' })
  @Max(PRAZO_MAXIMO_DIAS, {
    message: `deve ser no máximo ${PRAZO_MAXIMO_DIAS}`,
  })
  prazoDias?: number | null;

  @ApiPropertyOptional({
    nullable: true,
    type: Number,
    minimum: 0,
    maximum: 100,
    description: '`null` tira a probabilidade.',
  })
  @IsOptional()
  @IsInt({ message: 'deve ser um número inteiro' })
  @Min(0, { message: 'deve ser no mínimo 0' })
  @Max(100, { message: 'deve ser no máximo 100' })
  probabilidade?: number | null;
}

export class ReordenarEtapasDto {
  @ApiProperty({
    type: [String],
    format: 'uuid',
    description: 'Todas as etapas do funil, na nova ordem.',
  })
  @IsArray({ message: 'deve ser uma lista' })
  @ArrayMinSize(3, { message: 'deve ter pelo menos 3 itens' })
  @ArrayMaxSize(ETAPAS_POR_FUNIL_MAXIMO, {
    message: `deve ter no máximo ${ETAPAS_POR_FUNIL_MAXIMO} itens`,
  })
  @ArrayUnique({ message: 'não pode repetir etapas' })
  @IsUUID('all', {
    each: true,
    message: 'cada item deve ser um identificador (UUID) válido',
  })
  etapaIds: string[];
}
