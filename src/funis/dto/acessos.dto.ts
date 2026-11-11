import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsOptional,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { rotuloComNomeDoSetor } from '../../comum/dominio/papeis';
import type { Area } from '../../comum/dominio/setores';
import { ChaveDeSetor, DESCRICAO_SETOR } from '../../comum/validacao/setor';
import {
  NivelAcesso,
  Papel,
  VisibilidadeFunil,
} from '../../generated/prisma/client';

/** Limite de linhas numa lista de acessos (um funil ou um setor). */
export const ACESSOS_POR_LISTA_MAXIMO = 200;

const DESCRICAO_NIVEL =
  '`VER` ("Só ver": todos os negócios, só leitura), `MEMBRO` ("Como membro": os seus e os sem responsável; cria, assume, edita e move os que vê) ou `GESTOR` ("Ver e editar todos": também troca o responsável). Configurar o funil, reabrir e excluir negócios continuam só com o líder do setor dono, o C-level e o Admin (R5.12).';

/** Uma linha da lista de acessos enviada no `PUT` (exatamente um alvo). */
export class NovoAcessoDto {
  @ApiPropertyOptional({
    type: String,
    example: 'CS',
    description: `Setor inteiro que recebe o acesso — ${DESCRICAO_SETOR} Informe \`area\` **ou** \`usuarioId\`.`,
  })
  @IsOptional()
  @ChaveDeSetor()
  area?: Area;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Pessoa que recebe o acesso. Informe `area` **ou** `usuarioId`.',
  })
  @IsOptional()
  @IsUUID('all', { message: 'deve ser um id válido' })
  usuarioId?: string;

  @ApiProperty({
    enum: NivelAcesso,
    enumName: 'NivelAcesso',
    description: DESCRICAO_NIVEL,
  })
  @IsEnum(NivelAcesso, { message: 'deve ser VER, MEMBRO ou GESTOR' })
  nivel: NivelAcesso;
}

/** `PUT /funis/:id/acessos` e `PUT /setores/:chave/acessos`: a lista completa substitui a atual. */
export class SubstituirAcessosDto {
  @ApiProperty({
    type: [NovoAcessoDto],
    description:
      'A lista inteira (a atual é trocada por ela; lista vazia remove todos). Cada alvo uma vez só.',
  })
  @IsArray({ message: 'deve ser uma lista' })
  @ArrayMaxSize(ACESSOS_POR_LISTA_MAXIMO, {
    message: `deve ter no máximo ${ACESSOS_POR_LISTA_MAXIMO} acessos`,
  })
  @ValidateNested({ each: true })
  @Type(() => NovoAcessoDto)
  acessos: NovoAcessoDto[];
}

export class PessoaDoAcessoDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'Ana Souza' })
  nome: string;

  @ApiPropertyOptional({ nullable: true, type: String })
  avatarUrl: string | null;

  @ApiProperty({ enum: Papel, enumName: 'Papel' })
  papel: Papel;

  @ApiPropertyOptional({ nullable: true, type: String, example: 'CS' })
  area: Area | null;

  @ApiProperty({ example: 'Customer Success' })
  rotuloPapel: string;

  @ApiProperty({ description: 'Falso = desligada (o acesso não vale).' })
  ativo: boolean;
}

export class AcessoDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({
    enum: ['SETOR', 'PESSOA'],
    description: 'Quem recebe: um setor inteiro ou uma pessoa.',
  })
  alvo: 'SETOR' | 'PESSOA';

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    example: 'CS',
    description: 'Setor que recebe (alvo `SETOR`).',
  })
  area: Area | null;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    example: 'Customer Success',
  })
  nomeSetor: string | null;

  @ApiPropertyOptional({
    nullable: true,
    type: Boolean,
    description:
      'Alvo `SETOR`: falso = setor desativado (o acesso não conta, R5.11).',
  })
  setorAtivo: boolean | null;

  @ApiPropertyOptional({
    nullable: true,
    type: PessoaDoAcessoDto,
    description: 'Pessoa que recebe (alvo `PESSOA`).',
  })
  usuario: PessoaDoAcessoDto | null;

  @ApiProperty({
    enum: NivelAcesso,
    enumName: 'NivelAcesso',
    description: DESCRICAO_NIVEL,
  })
  nivel: NivelAcesso;

  @ApiProperty({ format: 'date-time' })
  atualizadoEm: string;

  static de(acesso: AcessoComAlvo): AcessoDto {
    const { setor, usuario } = acesso;
    return {
      id: acesso.id,
      alvo: acesso.usuarioId ? 'PESSOA' : 'SETOR',
      area: acesso.area,
      nomeSetor: setor?.nome ?? null,
      setorAtivo: setor ? setor.ativo : null,
      usuario: usuario
        ? {
            id: usuario.id,
            nome: usuario.nome,
            avatarUrl: usuario.avatarUrl,
            papel: usuario.papel,
            area: usuario.area,
            rotuloPapel: rotuloComNomeDoSetor(
              usuario.papel,
              usuario.setor?.nome ?? null,
            ),
            ativo: usuario.ativo,
          }
        : null,
      nivel: acesso.nivel,
      atualizadoEm: acesso.atualizadoEm.toISOString(),
    };
  }
}

/** Uma linha de acesso com o setor e a pessoa (o `include` de `INCLUIR_ALVO_DO_ACESSO`). */
export interface AcessoComAlvo {
  id: string;
  area: string | null;
  usuarioId: string | null;
  nivel: NivelAcesso;
  atualizadoEm: Date;
  setor: { nome: string; ativo: boolean } | null;
  usuario: {
    id: string;
    nome: string;
    avatarUrl: string | null;
    papel: Papel;
    area: string | null;
    ativo: boolean;
    setor: { nome: string } | null;
  } | null;
}

/** O `include` que dá a cada linha de acesso o setor e a pessoa (com o setor dela). */
export const INCLUIR_ALVO_DO_ACESSO = {
  setor: { select: { nome: true, ativo: true } },
  usuario: {
    select: {
      id: true,
      nome: true,
      avatarUrl: true,
      papel: true,
      area: true,
      ativo: true,
      setor: { select: { nome: true } },
    },
  },
} as const;

export class AcessosDoFunilDto {
  @ApiProperty({ format: 'uuid' })
  funilId: string;

  @ApiProperty({ example: 'Parcerias' })
  nome: string;

  @ApiProperty({
    type: String,
    example: 'COMERCIAL',
    description: 'Setor dono.',
  })
  area: Area;

  @ApiProperty({ example: 'Comercial' })
  nomeSetor: string;

  @ApiProperty({ enum: VisibilidadeFunil, enumName: 'VisibilidadeFunil' })
  visibilidade: VisibilidadeFunil;

  @ApiProperty({
    type: [AcessoDto],
    description:
      'A lista do funil (vale também no `RESTRITA`). No `SETOR`, os acessos do setor dono (`GET /setores/:chave/acessos`) também valem.',
  })
  acessos: AcessoDto[];
}

export class AcessosDoSetorDto {
  @ApiProperty({
    type: String,
    example: 'COMERCIAL',
    description: 'Setor dono.',
  })
  area: Area;

  @ApiProperty({ example: 'Comercial' })
  nomeSetor: string;

  @ApiProperty({
    type: [AcessoDto],
    description:
      'Valem para todos os funis do setor, menos os `RESTRITA` (esses só pela lista do funil).',
  })
  acessos: AcessoDto[];
}
