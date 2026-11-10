import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import type { ValorJson } from '../../comum/dados/sanitizar';
import { semCodigoDeRegra } from '../../comum/dados/textos';
import {
  type EventoAuditoria,
  Papel,
  TipoAtor,
} from '../../generated/prisma/client';
import { extrairAlteracoes, lerRelacionados } from './alteracoes';
import {
  aparar,
  FiltroDeConsultaDto,
  paraBooleano,
  paraLista,
} from './filtro-de-consulta.dto';

const TIPOS_DE_ATOR = Object.values(TipoAtor);

/** Esquema OpenAPI de um valor JSON qualquer (antes/depois de um campo). */
const VALOR_JSON = {
  oneOf: [
    { type: 'string' },
    { type: 'number' },
    { type: 'boolean' },
    { type: 'object', additionalProperties: true },
    { type: 'array', items: {} },
  ],
  nullable: true,
};

/** Filtros de `GET /auditoria` (R3.4). Todos opcionais e combináveis (E). */
export class FiltroAuditoriaDto extends FiltroDeConsultaDto {
  @ApiPropertyOptional({
    type: [String],
    description:
      'Ação no formato `entidade.verbo` (ex.: `negocio.movido`). Várias: repita o parâmetro ou separe por vírgula.',
    example: ['negocio.movido', 'negocio.ganho'],
  })
  @IsOptional()
  @Transform(paraLista)
  @IsArray({ message: 'deve ser uma lista' })
  @ArrayMaxSize(20, { message: 'deve ter no máximo 20 itens' })
  @IsString({ each: true, message: '(cada item) deve ser um texto' })
  @MaxLength(100, {
    each: true,
    message: '(cada item) deve ter no máximo 100 caracteres',
  })
  acao?: string[];

  @ApiPropertyOptional({
    description: 'Entidade afetada, em snake_case (ex.: `negocio`, `contato`).',
    example: 'negocio',
  })
  @IsOptional()
  @Transform(aparar)
  @IsString({ message: 'deve ser um texto' })
  @MaxLength(100, { message: 'deve ter no máximo 100 caracteres' })
  entidade?: string;

  @ApiPropertyOptional({ description: 'Id da entidade afetada.' })
  @IsOptional()
  @Transform(aparar)
  @IsString({ message: 'deve ser um texto' })
  @MaxLength(100, { message: 'deve ter no máximo 100 caracteres' })
  entidadeId?: string;

  @ApiPropertyOptional({
    description:
      'Com `entidade` e `entidadeId`: traz também os eventos em que ela aparece como relacionada ' +
      '(ex.: o negócio criado para o contato) — a mesma base da linha do tempo (R3.5).',
    default: false,
  })
  @IsOptional()
  @Transform(paraBooleano)
  @IsBoolean({ message: 'deve ser verdadeiro ou falso' })
  incluirRelacionados: boolean = false;

  @ApiPropertyOptional({
    enum: TipoAtor,
    enumName: 'TipoAtor',
    isArray: true,
    description:
      'Tipo de ator. Vários: repita o parâmetro ou separe por vírgula.',
  })
  @IsOptional()
  @Transform(paraLista)
  @IsArray({ message: 'deve ser uma lista' })
  @IsEnum(TipoAtor, {
    each: true,
    message: `(cada item) deve ser um destes valores: ${TIPOS_DE_ATOR.join(', ')}`,
  })
  tipoAtor?: TipoAtor[];
}

/** Linha da listagem, como o SQL a devolve. */
export interface LinhaEventoAuditoria {
  id: bigint;
  criado_em: Date;
  tipo_ator: TipoAtor;
  usuario_id: string | null;
  ator_descricao: string | null;
  acao: string;
  entidade: string;
  entidade_id: string | null;
  resumo: string;
  requisicao_id: string | null;
  /** `dados -> 'alteracoes'`, só para contar os campos. */
  alteracoes: unknown;
}

/** Evento de auditoria na listagem (R3.4); o diff e os metadados ficam no detalhe. */
export class EventoAuditoriaDto {
  @ApiProperty({ description: 'Id sequencial, em texto.', example: '1024' })
  id: string;

  @ApiProperty({ format: 'date-time' })
  criadoEm: string;

  @ApiProperty({ enum: TipoAtor, enumName: 'TipoAtor' })
  tipoAtor: TipoAtor;

  @ApiPropertyOptional({
    format: 'uuid',
    nullable: true,
    type: String,
    description: 'Usuário que fez a ação (nulo para sistema, webhook…).',
  })
  usuarioId: string | null;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description:
      'Nome do ator no momento do evento (usuário, webhook, job da fila…).',
    example: 'Ana Souza',
  })
  atorDescricao: string | null;

  @ApiProperty({ example: 'negocio.movido' })
  acao: string;

  @ApiProperty({ example: 'negocio' })
  entidade: string;

  @ApiPropertyOptional({ nullable: true, type: String })
  entidadeId: string | null;

  @ApiProperty({
    example: 'Negócio "ACME" movido de Proposta para Negociação',
  })
  resumo: string;

  @ApiProperty({
    description:
      'Quantos campos o evento alterou (o antes/depois está no detalhe).',
    example: 1,
  })
  quantidadeAlteracoes: number;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description: 'Id da requisição (`X-Request-Id`).',
  })
  requisicaoId: string | null;

  static daLinha(linha: LinhaEventoAuditoria): EventoAuditoriaDto {
    return {
      id: linha.id.toString(),
      criadoEm: linha.criado_em.toISOString(),
      tipoAtor: linha.tipo_ator,
      usuarioId: linha.usuario_id,
      atorDescricao: linha.ator_descricao,
      acao: linha.acao,
      entidade: linha.entidade,
      entidadeId: linha.entidade_id,
      // Eventos antigos guardam o código da regra no resumo; a leitura o tira.
      resumo: semCodigoDeRegra(linha.resumo),
      quantidadeAlteracoes: extrairAlteracoes({
        alteracoes: linha.alteracoes,
      }).length,
      requisicaoId: linha.requisicao_id,
    };
  }
}

/** Um campo alterado: o "antes/depois" da auditoria (R3.1). */
export class AlteracaoDto {
  @ApiProperty({ example: 'etapaId' })
  campo: string;

  @ApiProperty({
    ...VALOR_JSON,
    description:
      'Valor anterior (qualquer JSON; `[omitido]` em campos sensíveis).',
    example: 'Proposta',
  })
  antes: ValorJson;

  @ApiProperty({
    ...VALOR_JSON,
    description: 'Valor novo (qualquer JSON; `[omitido]` em campos sensíveis).',
    example: 'Negociação',
  })
  depois: ValorJson;
}

/** Entidade ligada ao evento (`relacionados`). */
export class ReferenciaDto {
  @ApiProperty({ example: 'contato' })
  entidade: string;

  @ApiProperty({ example: '6f1c2b0e-8a3d-4c55-9a51-2d8f8d7c1e10' })
  id: string;
}

/** Quem fez a ação, como está hoje no cadastro. */
export class UsuarioDoEventoDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'Ana Souza' })
  nome: string;

  @ApiProperty({ example: 'ana@brl.com.br' })
  email: string;

  @ApiProperty({ enum: Papel, enumName: 'Papel' })
  papel: Papel;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'COMERCIAL',
    description: 'Setor (chave) de Líder e Membro; nulo para Admin e C-level.',
  })
  area: string | null;

  @ApiProperty({ description: 'Falso se a pessoa foi desligada depois.' })
  ativo: boolean;
}

/** Detalhe de um evento de auditoria (R3.4): diff, dados gravados e metadados. */
export class EventoAuditoriaDetalheDto extends EventoAuditoriaDto {
  @ApiProperty({
    type: [AlteracaoDto],
    description:
      'Campos alterados, em ordem alfabética do campo (vazio se o evento não altera campos).',
  })
  alteracoes: AlteracaoDto[];

  @ApiPropertyOptional({
    nullable: true,
    type: 'object',
    additionalProperties: true,
    description:
      'Tudo o que foi gravado em `dados` (inclui `alteracoes`), sem senhas, tokens nem segredos.',
  })
  dados: Record<string, unknown> | null;

  @ApiProperty({
    type: [ReferenciaDto],
    description:
      'Entidades ligadas ao evento (a própria entidade e as relacionadas).',
  })
  relacionados: ReferenciaDto[];

  @ApiPropertyOptional({ nullable: true, type: String, example: '192.0.2.10' })
  ip: string | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  userAgent: string | null;

  @ApiPropertyOptional({
    type: UsuarioDoEventoDto,
    nullable: true,
    description: 'O usuário do evento, se houver (dados atuais do cadastro).',
  })
  usuario: UsuarioDoEventoDto | null;

  static de(
    evento: EventoAuditoria,
    usuario: UsuarioDoEventoDto | null,
  ): EventoAuditoriaDetalheDto {
    const alteracoes = extrairAlteracoes(evento.dados);
    const dados =
      typeof evento.dados === 'object' &&
      evento.dados !== null &&
      !Array.isArray(evento.dados)
        ? (evento.dados as Record<string, unknown>)
        : null;
    return {
      id: evento.id.toString(),
      criadoEm: evento.criadoEm.toISOString(),
      tipoAtor: evento.tipoAtor,
      usuarioId: evento.usuarioId,
      atorDescricao: evento.atorDescricao,
      acao: evento.acao,
      entidade: evento.entidade,
      entidadeId: evento.entidadeId,
      resumo: semCodigoDeRegra(evento.resumo),
      quantidadeAlteracoes: alteracoes.length,
      requisicaoId: evento.requisicaoId,
      alteracoes,
      dados,
      relacionados: lerRelacionados(evento.relacionados),
      ip: evento.ip,
      userAgent: evento.userAgent,
      usuario,
    };
  }
}

/** Valores para montar os filtros da tela de auditoria. */
export class FiltrosDaAuditoriaDto {
  @ApiProperty({
    type: [String],
    description: 'Ações já registradas, em ordem alfabética.',
    example: ['negocio.movido', 'usuario.login'],
  })
  acoes: string[];

  @ApiProperty({
    type: [String],
    description: 'Entidades já registradas, em ordem alfabética.',
    example: ['negocio', 'usuario'],
  })
  entidades: string[];

  @ApiProperty({ enum: TipoAtor, enumName: 'TipoAtor', isArray: true })
  tiposAtor: TipoAtor[];
}
