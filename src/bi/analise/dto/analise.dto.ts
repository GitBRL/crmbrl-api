import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type as Transformar } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { PaginacaoDto } from '../../../comum/paginacao/paginacao';
import { PAINEIS_BI, type PainelBi } from '../../bi.tipos';
import {
  FiltroBiDto,
  FiltrosAplicadosDto,
  PeriodoBiDto,
} from '../../dto/filtro-bi.dto';
import {
  LIMITE_DIARIO_MAXIMO,
  MAX_CARACTERES_PERGUNTA,
} from '../analise.constantes';

const PAINEIS = [...PAINEIS_BI];

/** Corpo do `POST /bi/analise`: o painel e os mesmos filtros da tela. */
export class SolicitarAnaliseDto extends FiltroBiDto {
  @ApiProperty({ enum: PAINEIS, example: 'comercial' })
  @IsIn(PAINEIS, {
    message: `painel inválido: use um de ${PAINEIS.join(', ')}`,
  })
  painel: PainelBi;
}

export class PerguntaAnaliseDto {
  @ApiProperty({
    description: `Pergunta sobre a mesma análise (até ${MAX_CARACTERES_PERGUNTA} caracteres).`,
    example: 'Por que a taxa de ganho caiu?',
  })
  @IsString({ message: 'deve ser um texto' })
  @MinLength(3, { message: 'escreva a pergunta (no mínimo 3 caracteres)' })
  @MaxLength(MAX_CARACTERES_PERGUNTA, {
    message: `no máximo ${MAX_CARACTERES_PERGUNTA} caracteres`,
  })
  pergunta: string;
}

export class ConfiguracaoAnaliseDto {
  @ApiProperty({
    description:
      'Análises por dia (fuso de São Paulo), somando todos os Admins. 0 desliga a análise.',
    minimum: 0,
    maximum: LIMITE_DIARIO_MAXIMO,
    example: 20,
  })
  @Transformar(() => Number)
  @IsInt({ message: 'deve ser um número inteiro' })
  @Min(0, { message: 'deve ser no mínimo 0' })
  @Max(LIMITE_DIARIO_MAXIMO, {
    message: `deve ser no máximo ${LIMITE_DIARIO_MAXIMO}`,
  })
  limiteDiario: number;
}

export class FiltroHistoricoAnaliseDto extends PaginacaoDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Só as análises desta pessoa.',
  })
  @IsOptional()
  @IsUUID('all', { message: 'deve ser um identificador (UUID) válido' })
  usuarioId?: string;

  @ApiPropertyOptional({ enum: PAINEIS })
  @IsOptional()
  @IsIn(PAINEIS, {
    message: `painel inválido: use um de ${PAINEIS.join(', ')}`,
  })
  painel?: PainelBi;
}

// ---------------------------------------------------------------------------
// Respostas (documentação)
// ---------------------------------------------------------------------------

export class EstadoAnaliseDto {
  @ApiProperty({ description: 'Há chave da Anthropic no servidor.' })
  configurada: boolean;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Como configurar (quando `configurada` é falso).',
  })
  comoConfigurar: string | null;
  @ApiProperty({
    description:
      'Pode pedir uma análise agora (configurada, limite maior que zero e ainda não atingido).',
  })
  disponivel: boolean;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Por que não está disponível (texto para a tela).',
  })
  motivo: string | null;
  @ApiProperty({ example: 'claude-opus-5-5' }) modelo: string;
  @ApiProperty() limiteDiario: number;
  @ApiProperty() usadasHoje: number;
  @ApiProperty() restantesHoje: number;
  @ApiProperty() maxPerguntasPorAnalise: number;
}

export class LinkAnaliseDto {
  @ApiProperty({ example: '/funis/comercial' }) caminho: string;
  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    example: { etapaId: '8b8aee89-5717-4e9e-9e4b-983d70e5be2c' },
  })
  parametros: Record<string, string>;
  @ApiProperty({ example: 'Ver negócios em Proposta' }) rotulo: string;
  @ApiProperty({
    description:
      'O link do modelo foi corrigido (parâmetro ou rota desconhecida).',
  })
  ajustado: boolean;
}

export class DestaqueAnaliseDto {
  @ApiProperty() titulo: string;
  @ApiProperty() detalhe: string;
  @ApiProperty({ enum: ['positiva', 'negativa', 'neutra'] }) tendencia: string;
}

export class RiscoAnaliseDto {
  @ApiProperty() titulo: string;
  @ApiProperty() detalhe: string;
  @ApiProperty({ enum: ['alta', 'media', 'baixa'] }) gravidade: string;
}

export class AcaoAnaliseDto {
  @ApiProperty() titulo: string;
  @ApiProperty() detalhe: string;
  @ApiProperty({ enum: ['alta', 'media', 'baixa'] }) prioridade: string;
  @ApiProperty({ type: LinkAnaliseDto }) link: LinkAnaliseDto;
}

export class ResultadoAnaliseDto {
  @ApiProperty() resumo: string;
  @ApiProperty({ type: [DestaqueAnaliseDto] }) destaques: DestaqueAnaliseDto[];
  @ApiProperty({ type: [RiscoAnaliseDto] }) riscos: RiscoAnaliseDto[];
  @ApiProperty({ type: [AcaoAnaliseDto] }) acoes: AcaoAnaliseDto[];
}

export class RespostaPerguntaAnaliseDto {
  @ApiProperty({ description: 'Resposta direta à pergunta.' }) resposta: string;
  @ApiProperty({ type: [DestaqueAnaliseDto] }) destaques: DestaqueAnaliseDto[];
  @ApiProperty({ type: [RiscoAnaliseDto] }) riscos: RiscoAnaliseDto[];
  @ApiProperty({ type: [AcaoAnaliseDto] }) acoes: AcaoAnaliseDto[];
}

export class TokensAnaliseDto {
  @ApiProperty() entrada: number;
  @ApiProperty() saida: number;
  @ApiProperty({ description: 'Lidos do cache de prompt.' })
  cacheLeitura: number;
  @ApiProperty({ description: 'Gravados no cache de prompt.' })
  cacheEscrita: number;
}

export class UsuarioAnaliseDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty() nome: string;
}

export class PerguntaRespondidaDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty() pergunta: string;
  @ApiProperty({ type: RespostaPerguntaAnaliseDto, nullable: true })
  resposta: RespostaPerguntaAnaliseDto | null;
  @ApiProperty({ enum: ['EM_ANDAMENTO', 'CONCLUIDA', 'FALHOU'] })
  status: string;
  @ApiProperty({ type: String, nullable: true }) erro: string | null;
  @ApiProperty() tentativas: number;
  @ApiProperty({ type: TokensAnaliseDto }) tokens: TokensAnaliseDto;
  @ApiProperty({ type: Number, nullable: true }) duracaoMs: number | null;
  @ApiProperty({ format: 'date-time' }) criadoEm: string;
}

export class AnaliseResumoDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ type: UsuarioAnaliseDto }) usuario: UsuarioAnaliseDto;
  @ApiProperty({ enum: PAINEIS }) painel: string;
  @ApiProperty({ type: PeriodoBiDto }) periodo: PeriodoBiDto;
  @ApiProperty({ type: FiltrosAplicadosDto }) filtros: FiltrosAplicadosDto;
  @ApiProperty({ enum: ['EM_ANDAMENTO', 'CONCLUIDA', 'FALHOU'] })
  status: string;
  @ApiProperty({ type: String, nullable: true }) erro: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'O resumo da análise.',
  })
  resumo: string | null;
  @ApiProperty() modelo: string;
  @ApiProperty() tentativas: number;
  @ApiProperty({ description: 'Perguntas de acompanhamento feitas.' })
  totalPerguntas: number;
  @ApiProperty({
    type: TokensAnaliseDto,
    description: 'Somando a análise e as perguntas.',
  })
  tokens: TokensAnaliseDto;
  @ApiProperty({ type: Number, nullable: true }) duracaoMs: number | null;
  @ApiProperty({ format: 'date-time' }) criadoEm: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  concluidoEm: string | null;
}

export class AnaliseDetalheDto extends AnaliseResumoDto {
  @ApiProperty({ type: ResultadoAnaliseDto, nullable: true })
  resultado: ResultadoAnaliseDto | null;
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description:
      'Exatamente o que foi enviado ao modelo: indicadores e tabelas agregadas (sem dados de contatos).',
  })
  entrada: Record<string, unknown>;
  @ApiProperty({ type: [PerguntaRespondidaDto] })
  perguntas: PerguntaRespondidaDto[];
}

export class PaginaAnalisesDto {
  @ApiProperty({ type: [AnaliseResumoDto] }) itens: AnaliseResumoDto[];
  @ApiProperty() total: number;
  @ApiProperty() pagina: number;
  @ApiProperty() porPagina: number;
}
