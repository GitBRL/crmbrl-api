import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type as Transformar } from 'class-transformer';
import {
  Equals,
  IsBoolean,
  IsEmail,
  IsEnum,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { PaginacaoDto } from '../../comum/paginacao/paginacao';
import { Area } from '../../generated/prisma/client';
import {
  CATEGORIAS,
  type Categoria,
  MAX_CARACTERES_DESCRICAO_CHAMADO,
  MAX_CARACTERES_MODELO_CORPO,
  MAX_CARACTERES_PERGUNTA,
  MAX_CARACTERES_TITULO_CHAMADO,
  MIN_CARACTERES_PERGUNTA,
  MIN_CARACTERES_SEGREDO,
  ORCAMENTO_MENSAL_MAXIMO,
  PERGUNTAS_POR_DIA_MAXIMO,
  PRIORIDADES_TICKETHUB,
  type PrioridadeTicketHub,
} from '../assistente.constantes';
import { DESTINOS, type DestinoConfigurado } from '../configuracao-assistente';

const CATEGORIAS_LISTA = [...CATEGORIAS];
const DIA = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const MENSAGEM_DIA = 'deve ser uma data AAAA-MM-DD';

// ---------------------------------------------------------------------------
// Pessoa que usa o assistente
// ---------------------------------------------------------------------------

export class PerguntarDto {
  @ApiProperty({
    description: `A pergunta (${MIN_CARACTERES_PERGUNTA} a ${MAX_CARACTERES_PERGUNTA} caracteres).`,
    example: 'Como eu movo um negócio para outra etapa?',
  })
  @IsString({ message: 'deve ser um texto' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @MinLength(MIN_CARACTERES_PERGUNTA, { message: 'escreva a pergunta' })
  @MaxLength(MAX_CARACTERES_PERGUNTA, {
    message: `no máximo ${MAX_CARACTERES_PERGUNTA} caracteres`,
  })
  pergunta: string;

  @ApiProperty({
    description:
      'Rota atual do front (ex.: `/funis/comercial`). A API tira a consulta e troca os ids por `:id` antes de enviar à IA.',
    example: '/funis/comercial',
  })
  @IsString({ message: 'deve ser um texto' })
  @MaxLength(500, { message: 'no máximo 500 caracteres' })
  tela: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Continuar esta conversa (sem ele, começa uma nova).',
  })
  @IsOptional()
  @IsUUID('all', { message: 'deve ser um identificador (UUID) válido' })
  conversaId?: string;
}

export class AvaliarRespostaDto {
  @ApiProperty({
    enum: ['UTIL', 'NAO_UTIL'],
    nullable: true,
    description: '`null` tira a avaliação.',
  })
  @ValidateIf((_, v) => v !== null)
  @IsIn(['UTIL', 'NAO_UTIL'], { message: 'use UTIL, NAO_UTIL ou null' })
  avaliacao: 'UTIL' | 'NAO_UTIL' | null;
}

export class AbrirChamadoDto {
  @ApiProperty({
    description:
      'Confirmação explícita da pessoa (o chamado só é aberto com `true`).',
    example: true,
  })
  @Equals(true, { message: 'confirme a abertura do chamado' })
  confirmar: true;

  @ApiPropertyOptional({
    description: `Título (padrão: o resumo do pedido). 3 a ${MAX_CARACTERES_TITULO_CHAMADO} caracteres.`,
  })
  @IsOptional()
  @IsString({ message: 'deve ser um texto' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @MinLength(3, { message: 'no mínimo 3 caracteres' })
  @MaxLength(MAX_CARACTERES_TITULO_CHAMADO, {
    message: `no máximo ${MAX_CARACTERES_TITULO_CHAMADO} caracteres`,
  })
  titulo?: string;

  @ApiPropertyOptional({
    description: `O que a pessoa quer acrescentar (padrão: a pergunta). Até ${MAX_CARACTERES_DESCRICAO_CHAMADO} caracteres; a conversa vai junto.`,
  })
  @IsOptional()
  @IsString({ message: 'deve ser um texto' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @MaxLength(MAX_CARACTERES_DESCRICAO_CHAMADO, {
    message: `no máximo ${MAX_CARACTERES_DESCRICAO_CHAMADO} caracteres`,
  })
  descricao?: string;
}

// ---------------------------------------------------------------------------
// Admin: configuração
// ---------------------------------------------------------------------------

export class TicketHubConfigDto {
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      'Origem do TicketHub (ex.: `https://chamados.empresa.com.br`). `null` volta para `TICKETHUB_URL`.',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString({ message: 'deve ser um texto' })
  @MaxLength(500, { message: 'no máximo 500 caracteres' })
  url?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      'Endereço do TicketHub que as pessoas abrem no navegador (base do link do chamado), quando diferente da URL usada pela API. `null` = a mesma.',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString({ message: 'deve ser um texto' })
  @MaxLength(500, { message: 'no máximo 500 caracteres' })
  urlPublica?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      'E-mail da conta de serviço. `null` volta para `TICKETHUB_EMAIL`.',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsEmail({}, { message: 'deve ser um e-mail válido' })
  email?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      'Senha da conta de serviço (gravada cifrada, nunca devolvida). Omitida: mantém; `null`: volta para `TICKETHUB_SENHA`.',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString({ message: 'deve ser um texto' })
  @MinLength(1, { message: 'informe a senha' })
  @MaxLength(200, { message: 'no máximo 200 caracteres' })
  senha?: string | null;

  @ApiPropertyOptional({ enum: PRIORIDADES_TICKETHUB })
  @IsOptional()
  @IsIn([...PRIORIDADES_TICKETHUB], {
    message: `use ${PRIORIDADES_TICKETHUB.join(', ')}`,
  })
  prioridade?: PrioridadeTicketHub;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    format: 'uuid',
    description: 'Sistema do TicketHub em que os chamados entram (opcional).',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID('all', { message: 'deve ser um identificador (UUID) válido' })
  sistemaId?: string | null;
}

export class WebhookConfigDto {
  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString({ message: 'deve ser um texto' })
  @MaxLength(2000, { message: 'no máximo 2000 caracteres' })
  url?: string | null;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { type: 'string', nullable: true },
    nullable: true,
    description:
      'Cabeçalhos extras (cifrados). Um nome com `null` remove; os omitidos ficam; `null` no lugar do objeto apaga todos.',
    example: { Authorization: 'Bearer …' },
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsObject({ message: 'deve ser um objeto' })
  cabecalhos?: Record<string, string | null> | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: `Segredo da assinatura HMAC-SHA256 (cabeçalho \`X-CRM-Assinatura\`), no mínimo ${MIN_CARACTERES_SEGREDO} caracteres. Omitido: mantém; \`null\`: sem assinatura.`,
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString({ message: 'deve ser um texto' })
  @MinLength(MIN_CARACTERES_SEGREDO, {
    message: `no mínimo ${MIN_CARACTERES_SEGREDO} caracteres`,
  })
  @MaxLength(200, { message: 'no máximo 200 caracteres' })
  segredo?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      'Modelo do corpo (JSON com variáveis `{{…}}`); `null` usa o padrão.',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString({ message: 'deve ser um texto' })
  @MaxLength(MAX_CARACTERES_MODELO_CORPO, {
    message: `no máximo ${MAX_CARACTERES_MODELO_CORPO} caracteres`,
  })
  modeloCorpo?: string | null;
}

export class ConfigurarAssistenteDto {
  @ApiPropertyOptional({
    description: 'Perguntas por pessoa por dia. 0 desliga o assistente.',
    minimum: 0,
    maximum: PERGUNTAS_POR_DIA_MAXIMO,
  })
  @IsOptional()
  @IsInt({ message: 'deve ser um número inteiro' })
  @Min(0, { message: 'deve ser no mínimo 0' })
  @Max(PERGUNTAS_POR_DIA_MAXIMO, {
    message: `deve ser no máximo ${PERGUNTAS_POR_DIA_MAXIMO}`,
  })
  perguntasPorDia?: number;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    description:
      'Orçamento de tokens do mês (todas as pessoas; entrada + saída + cache). `null` = sem orçamento.',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt({ message: 'deve ser um número inteiro' })
  @Min(0, { message: 'deve ser no mínimo 0' })
  @Max(ORCAMENTO_MENSAL_MAXIMO, {
    message: `deve ser no máximo ${ORCAMENTO_MENSAL_MAXIMO}`,
  })
  orcamentoMensalTokens?: number | null;

  @ApiPropertyOptional({ enum: DESTINOS })
  @IsOptional()
  @IsIn([...DESTINOS], { message: `use ${DESTINOS.join(', ')}` })
  destino?: DestinoConfigurado;

  @ApiPropertyOptional({ type: TicketHubConfigDto })
  @IsOptional()
  @ValidateNested()
  @Transformar(() => TicketHubConfigDto)
  ticketHub?: TicketHubConfigDto;

  @ApiPropertyOptional({ type: WebhookConfigDto })
  @IsOptional()
  @ValidateNested()
  @Transformar(() => WebhookConfigDto)
  webhook?: WebhookConfigDto;
}

// ---------------------------------------------------------------------------
// Admin: histórico
// ---------------------------------------------------------------------------

function booleano({ value }: { value: unknown }): unknown {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
}

export class FiltroPeriodoAssistenteDto extends PaginacaoDto {
  @ApiPropertyOptional({
    example: '2026-10-01',
    description: 'Primeiro dia (São Paulo), inclusive.',
  })
  @IsOptional()
  @Matches(DIA, { message: MENSAGEM_DIA })
  de?: string;

  @ApiPropertyOptional({
    example: '2026-10-31',
    description: 'Último dia (São Paulo), inclusive.',
  })
  @IsOptional()
  @Matches(DIA, { message: MENSAGEM_DIA })
  ate?: string;
}

export class FiltroHistoricoAssistenteDto extends FiltroPeriodoAssistenteDto {
  @ApiPropertyOptional({ enum: CATEGORIAS_LISTA })
  @IsOptional()
  @IsIn(CATEGORIAS_LISTA, { message: `use ${CATEGORIAS_LISTA.join(', ')}` })
  categoria?: Categoria;

  @ApiPropertyOptional({
    enum: [...Object.values(Area), 'SEM_AREA'],
    description: 'Área da pessoa (SEM_AREA: Admin e C-level).',
  })
  @IsOptional()
  @IsIn([...Object.values(Area), 'SEM_AREA'], {
    message: 'use MARKETING, COMERCIAL, CS ou SEM_AREA',
  })
  area?: Area | 'SEM_AREA';

  @ApiPropertyOptional({ format: 'uuid', description: 'Só desta pessoa.' })
  @IsOptional()
  @IsUUID('all', { message: 'deve ser um identificador (UUID) válido' })
  usuarioId?: string;

  @ApiPropertyOptional({
    example: 'funis',
    description: 'Módulo da tela (1º trecho da rota).',
  })
  @IsOptional()
  @Matches(/^[a-z][a-z0-9-]{0,40}$/, { message: 'módulo inválido' })
  modulo?: string;

  @ApiPropertyOptional({ type: Boolean })
  @IsOptional()
  @Transform(booleano)
  @IsBoolean({ message: 'use true ou false' })
  resolvido?: boolean;

  @ApiPropertyOptional({ enum: ['UTIL', 'NAO_UTIL', 'SEM_AVALIACAO'] })
  @IsOptional()
  @IsIn(['UTIL', 'NAO_UTIL', 'SEM_AVALIACAO'], {
    message: 'use UTIL, NAO_UTIL ou SEM_AVALIACAO',
  })
  avaliacao?: 'UTIL' | 'NAO_UTIL' | 'SEM_AVALIACAO';

  @ApiPropertyOptional({
    type: Boolean,
    description: 'Só as que viraram chamado.',
  })
  @IsOptional()
  @Transform(booleano)
  @IsBoolean({ message: 'use true ou false' })
  comChamado?: boolean;

  @ApiPropertyOptional({ description: 'Texto na pergunta ou na resposta.' })
  @IsOptional()
  @IsString({ message: 'deve ser um texto' })
  @MaxLength(200, { message: 'no máximo 200 caracteres' })
  busca?: string;
}

export class ExportarHistoricoAssistenteDto extends FiltroHistoricoAssistenteDto {
  @ApiProperty({ enum: ['xlsx', 'csv'] })
  @IsIn(['xlsx', 'csv'], { message: 'use xlsx ou csv' })
  formato: 'xlsx' | 'csv';
}

export class FiltroChamadosAssistenteDto extends FiltroPeriodoAssistenteDto {
  @ApiPropertyOptional({ enum: ['PENDENTE', 'ENVIADO', 'FALHOU'] })
  @IsOptional()
  @IsEnum(['PENDENTE', 'ENVIADO', 'FALHOU'], {
    message: 'use PENDENTE, ENVIADO ou FALHOU',
  })
  status?: 'PENDENTE' | 'ENVIADO' | 'FALHOU';
}

// ---------------------------------------------------------------------------
// Respostas (documentação)
// ---------------------------------------------------------------------------

export class EstadoAssistenteDto {
  @ApiProperty({
    description:
      'Pode perguntar agora (IA configurada, base com artigos, limites ok).',
  })
  disponivel: boolean;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Por que não está disponível.',
  })
  motivo: string | null;
  @ApiProperty({
    description: 'Aviso fixo do painel: as perguntas ficam registradas.',
  })
  aviso: string;
  @ApiProperty({ example: 'claude-opus-5-5' }) modelo: string;
  @ApiProperty() perguntasPorDia: number;
  @ApiProperty() usadasHoje: number;
  @ApiProperty() restantesHoje: number;
  @ApiProperty() maxCaracteresPergunta: number;
  @ApiProperty() maxPerguntasPorConversa: number;
  @ApiProperty({
    description:
      'Há destino de chamados pronto (o botão "Abrir chamado" pode aparecer).',
  })
  chamadosDisponiveis: boolean;
  @ApiProperty({ enum: CATEGORIAS_LISTA, isArray: true })
  categoriasComChamado: Categoria[];
}

export class ChamadoAssistenteDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ format: 'uuid' }) conversaId: string;
  @ApiProperty({ format: 'uuid' }) perguntaId: string;
  @ApiProperty() titulo: string;
  @ApiProperty() descricao: string;
  @ApiProperty() tela: string;
  @ApiProperty({ enum: CATEGORIAS_LISTA }) categoria: Categoria;
  @ApiProperty({ enum: ['TICKETHUB', 'WEBHOOK'] }) destino: string;
  @ApiProperty({
    enum: ['PENDENTE', 'ENVIADO', 'FALHOU'],
    description: 'PENDENTE: na fila (pode estar esperando nova tentativa).',
  })
  status: string;
  @ApiProperty() tentativas: number;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  proximaTentativaEm: string | null;
  @ApiProperty({ type: String, nullable: true }) ultimoErro: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Número do chamado no destino (no TicketHub, o id).',
  })
  numero: string | null;
  @ApiProperty({ type: String, nullable: true }) link: string | null;
  @ApiProperty({ format: 'date-time' }) criadoEm: string;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  enviadoEm: string | null;
  @ApiPropertyOptional({
    description: 'Só no histórico do Admin.',
    type: 'object',
    properties: { id: { type: 'string' }, nome: { type: 'string' } },
  })
  usuario?: { id: string; nome: string };
}

export class PerguntaAssistenteDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ format: 'uuid' }) conversaId: string;
  @ApiProperty() pergunta: string;
  @ApiProperty() tela: string;
  @ApiProperty() modulo: string;
  @ApiProperty({ enum: ['EM_ANDAMENTO', 'CONCLUIDA', 'FALHOU'] })
  status: string;
  @ApiProperty({ type: String, nullable: true }) resposta: string | null;
  @ApiProperty({ type: Boolean, nullable: true }) resolvido: boolean | null;
  @ApiProperty({ enum: CATEGORIAS_LISTA, nullable: true })
  categoria: Categoria | null;
  @ApiProperty({ type: String, nullable: true }) resumoDoPedido: string | null;
  @ApiProperty({ type: String, nullable: true }) erro: string | null;
  @ApiProperty({ enum: ['UTIL', 'NAO_UTIL'], nullable: true })
  avaliacao: 'UTIL' | 'NAO_UTIL' | null;
  @ApiProperty({
    description: 'A categoria permite abrir chamado e ainda não há um.',
  })
  podeAbrirChamado: boolean;
  @ApiProperty({ type: ChamadoAssistenteDto, nullable: true })
  chamado: ChamadoAssistenteDto | null;
  @ApiProperty({ format: 'date-time' }) criadoEm: string;
  @ApiPropertyOptional({ description: 'Só no histórico do Admin.' })
  tokens?: number;
  @ApiPropertyOptional({
    description: 'Só no histórico do Admin.',
    type: 'object',
    properties: {
      id: { type: 'string' },
      nome: { type: 'string' },
      papel: { type: 'string' },
      area: { type: 'string', nullable: true },
    },
  })
  usuario?: { id: string; nome: string; papel: string; area: string | null };
}

export class ConversaAssistenteDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty() titulo: string;
  @ApiProperty({ format: 'date-time' }) criadoEm: string;
  @ApiProperty({ format: 'date-time' }) atualizadoEm: string;
  @ApiProperty() totalPerguntas: number;
  @ApiPropertyOptional({ type: [PerguntaAssistenteDto] })
  perguntas?: PerguntaAssistenteDto[];
}
