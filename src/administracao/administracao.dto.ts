import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  aparar,
  FiltroDeConsultaDto,
  paraLista,
} from '../auditoria/consulta/filtro-de-consulta.dto';
import {
  type LogTecnico,
  NivelLog,
  TipoAtor,
} from '../generated/prisma/client';

const NIVEIS = Object.values(NivelLog);

/** Janela máxima do resumo: 7 dias. */
export const HORAS_MAXIMAS_DO_RESUMO = 168;

// ---------------------------------------------------------------------------
// Logs técnicos (R3.6)
// ---------------------------------------------------------------------------

/** Filtros de `GET /administracao/logs-tecnicos`. Todos opcionais e combináveis (E). */
export class FiltroLogsTecnicosDto extends FiltroDeConsultaDto {
  @ApiPropertyOptional({
    enum: NivelLog,
    enumName: 'NivelLog',
    isArray: true,
    description: 'Nível. Vários: repita o parâmetro ou separe por vírgula.',
    example: ['ERRO', 'AVISO'],
  })
  @IsOptional()
  @Transform(paraLista)
  @IsArray({ message: 'deve ser uma lista' })
  @ArrayMaxSize(NIVEIS.length, {
    message: `deve ter no máximo ${NIVEIS.length} itens`,
  })
  @IsEnum(NivelLog, {
    each: true,
    message: `(cada item) deve ser um destes valores: ${NIVEIS.join(', ')}`,
  })
  nivel?: NivelLog[];

  @ApiPropertyOptional({
    description:
      'Origem do log, pelo começo do nome (sem diferenciar maiúsculas): `HTTP`, `Fila` (todas as filas), `Fila:webhooks-saida.entregar`, `Eventos`…',
    example: 'Fila',
  })
  @IsOptional()
  @Transform(aparar)
  @IsString({ message: 'deve ser um texto' })
  @MaxLength(100, { message: 'deve ter no máximo 100 caracteres' })
  contexto?: string;
}

/** Linha da listagem de logs técnicos, como o SQL a devolve. */
export interface LinhaLogTecnico {
  id: bigint;
  criado_em: Date;
  nivel: NivelLog;
  contexto: string;
  mensagem: string;
  requisicao_id: string | null;
  usuario_id: string | null;
  metodo: string | null;
  rota: string | null;
  status: number | null;
  duracao_ms: number | null;
}

/** Log técnico na listagem (sem `dados`, que pode trazer a pilha do erro). */
export class LogTecnicoDto {
  @ApiProperty({ description: 'Id sequencial, em texto.', example: '512' })
  id: string;

  @ApiProperty({ format: 'date-time' })
  criadoEm: string;

  @ApiProperty({ enum: NivelLog, enumName: 'NivelLog' })
  nivel: NivelLog;

  @ApiProperty({
    description: 'Origem: `HTTP`, `Fila:<nome>`, `Eventos`, `Email`…',
    example: 'HTTP',
  })
  contexto: string;

  @ApiProperty({ example: 'Falha ao gravar o negócio' })
  mensagem: string;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description: 'Id da requisição (`X-Request-Id`) ou do job.',
  })
  requisicaoId: string | null;

  @ApiPropertyOptional({ nullable: true, type: String, format: 'uuid' })
  usuarioId: string | null;

  @ApiPropertyOptional({ nullable: true, type: String, example: 'POST' })
  metodo: string | null;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    example: '/api/v1/negocios/:id/mover',
  })
  rota: string | null;

  @ApiPropertyOptional({ nullable: true, type: Number, example: 500 })
  status: number | null;

  @ApiPropertyOptional({ nullable: true, type: Number, example: 35 })
  duracaoMs: number | null;

  static daLinha(linha: LinhaLogTecnico): LogTecnicoDto {
    return {
      id: linha.id.toString(),
      criadoEm: linha.criado_em.toISOString(),
      nivel: linha.nivel,
      contexto: linha.contexto,
      mensagem: linha.mensagem,
      requisicaoId: linha.requisicao_id,
      usuarioId: linha.usuario_id,
      metodo: linha.metodo,
      rota: linha.rota,
      status: linha.status,
      duracaoMs: linha.duracao_ms,
    };
  }

  static de(log: LogTecnico): LogTecnicoDto {
    return {
      id: log.id.toString(),
      criadoEm: log.criadoEm.toISOString(),
      nivel: log.nivel,
      contexto: log.contexto,
      mensagem: log.mensagem,
      requisicaoId: log.requisicaoId,
      usuarioId: log.usuarioId,
      metodo: log.metodo,
      rota: log.rota,
      status: log.status,
      duracaoMs: log.duracaoMs,
    };
  }
}

/** Detalhe do log técnico: com os `dados` (erro com nome, mensagem e pilha). */
export class LogTecnicoDetalheDto extends LogTecnicoDto {
  @ApiPropertyOptional({
    nullable: true,
    type: 'object',
    additionalProperties: true,
    description:
      'Dados do log, sem segredos; em falhas, `erro: { nome, mensagem, codigo?, pilha }`.',
  })
  dados: Record<string, unknown> | null;

  static detalhe(log: LogTecnico): LogTecnicoDetalheDto {
    const dados =
      typeof log.dados === 'object' &&
      log.dados !== null &&
      !Array.isArray(log.dados)
        ? (log.dados as Record<string, unknown>)
        : null;
    return Object.assign(LogTecnicoDto.de(log), { dados });
  }
}

// ---------------------------------------------------------------------------
// Resumo do Admin
// ---------------------------------------------------------------------------

export class FiltroResumoDto {
  @ApiPropertyOptional({
    description: 'Janela do resumo, em horas (até 7 dias).',
    default: 24,
    minimum: 1,
    maximum: HORAS_MAXIMAS_DO_RESUMO,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'deve ser um número inteiro' })
  @Min(1, { message: 'deve ser no mínimo 1' })
  @Max(HORAS_MAXIMAS_DO_RESUMO, {
    message: `deve ser no máximo ${HORAS_MAXIMAS_DO_RESUMO}`,
  })
  horas: number = 24;
}

export class PeriodoDoResumoDto {
  @ApiProperty({ format: 'date-time' })
  de: string;

  @ApiProperty({ format: 'date-time' })
  ate: string;

  @ApiProperty({ example: 24 })
  horas: number;
}

export class ContagemPorAcaoDto {
  @ApiProperty({ example: 'usuario.login' })
  acao: string;

  @ApiProperty({ example: 12 })
  quantidade: number;
}

export class ContagemPorTipoAtorDto {
  @ApiProperty({ enum: TipoAtor, enumName: 'TipoAtor' })
  tipoAtor: TipoAtor;

  @ApiProperty({ example: 40 })
  quantidade: number;
}

export class ResumoAuditoriaDto {
  @ApiProperty({ description: 'Eventos de auditoria na janela.', example: 52 })
  total: number;

  @ApiProperty({
    type: [ContagemPorAcaoDto],
    description: 'Contagem por ação, da mais frequente para a menos.',
  })
  porAcao: ContagemPorAcaoDto[];

  @ApiProperty({
    type: [ContagemPorTipoAtorDto],
    description: 'Contagem por tipo de ator, do mais frequente para o menos.',
  })
  porTipoAtor: ContagemPorTipoAtorDto[];
}

export class ContagemPorNivelDto {
  @ApiProperty({ example: 0 }) DEBUG: number;
  @ApiProperty({ example: 0 }) INFO: number;
  @ApiProperty({ example: 3 }) AVISO: number;
  @ApiProperty({ example: 1 }) ERRO: number;
}

export class ResumoLogsTecnicosDto {
  @ApiProperty({ description: 'Logs técnicos na janela.', example: 4 })
  total: number;

  @ApiProperty({ type: ContagemPorNivelDto })
  porNivel: ContagemPorNivelDto;

  @ApiProperty({
    type: [LogTecnicoDto],
    description:
      'Os últimos erros da janela (até 10), do mais novo para o mais antigo.',
  })
  errosRecentes: LogTecnicoDto[];
}

export class ResumoEventosDominioDto {
  @ApiProperty({
    description:
      'Eventos da outbox ainda não processados por todos os manipuladores (R10.1).',
    example: 0,
  })
  pendentes: number;

  @ApiProperty({
    description: 'Pendentes cuja última tentativa falhou.',
    example: 0,
  })
  comFalha: number;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    format: 'date-time',
    description: 'Quando o pendente mais antigo aconteceu (atraso da fila).',
  })
  maisAntigoPendenteEm: string | null;
}

export class ContagemPorStatusRecebimentoDto {
  @ApiProperty({ example: 0 }) RECEBIDO: number;
  @ApiProperty({ example: 30 }) PROCESSADO: number;
  @ApiProperty({ example: 2 }) IGNORADO: number;
  @ApiProperty({ example: 1 }) ERRO: number;
}

export class ResumoWebhooksDto {
  @ApiProperty({
    type: ContagemPorStatusRecebimentoDto,
    description:
      'Recebimentos dos webhooks de entrada na janela, por status (R8.6).',
  })
  recebimentos: ContagemPorStatusRecebimentoDto;

  @ApiProperty({
    description:
      'Entregas de webhooks de saída aguardando envio ou nova tentativa (R9.4).',
    example: 0,
  })
  entregasPendentes: number;

  @ApiProperty({
    description: 'Entregas que falharam de vez na janela (R9.4).',
    example: 0,
  })
  entregasFalhas: number;
}

export class ResumoRetencaoDto {
  @ApiProperty({ description: 'Dias de retenção (R3.6, R8.6).', example: 90 })
  dias: number;

  @ApiProperty({
    format: 'date-time',
    description: 'O que for anterior a este momento é apagado pelo job diário.',
  })
  limite: string;

  @ApiProperty({
    description:
      'Logs técnicos além do prazo, à espera do job (0 quando ele está em dia).',
    example: 0,
  })
  logsTecnicosVencidos: number;

  @ApiProperty({
    description: 'Recebimentos de webhook além do prazo, à espera do job.',
    example: 0,
  })
  recebimentosWebhookVencidos: number;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    format: 'date-time',
    description:
      'Última vez que o job apagou registros (evento `retencao.executada`).',
  })
  ultimaLimpezaEm: string | null;
}

/** Visão geral do Admin: o que aconteceu na janela e a saúde dos processos. */
export class ResumoAdministracaoDto {
  @ApiProperty({ type: PeriodoDoResumoDto })
  periodo: PeriodoDoResumoDto;

  @ApiProperty({ type: ResumoAuditoriaDto })
  auditoria: ResumoAuditoriaDto;

  @ApiProperty({ type: ResumoLogsTecnicosDto })
  logsTecnicos: ResumoLogsTecnicosDto;

  @ApiProperty({ type: ResumoEventosDominioDto })
  eventosDominio: ResumoEventosDominioDto;

  @ApiProperty({ type: ResumoWebhooksDto })
  webhooks: ResumoWebhooksDto;

  @ApiProperty({ type: ResumoRetencaoDto })
  retencao: ResumoRetencaoDto;
}

/** Os status de recebimento, todos com zero (para completar a contagem). */
export function contagemZeradaDeRecebimentos(): ContagemPorStatusRecebimentoDto {
  return { RECEBIDO: 0, PROCESSADO: 0, IGNORADO: 0, ERRO: 0 };
}

/** Os níveis de log, todos com zero (para completar a contagem). */
export function contagemZeradaDeNiveis(): ContagemPorNivelDto {
  return { DEBUG: 0, INFO: 0, AVISO: 0, ERRO: 0 };
}
