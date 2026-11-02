import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  aparar,
  maximo,
  MENSAGEM_TEXTO,
  MENSAGEM_UUID,
} from '../../canais/comum/dto-comum';
import { TipoAtividade } from '../../generated/prisma/client';
import { MAX_SEQUENCIA_DA_PARTE } from './gravacao.constantes';

export class GravacaoDaLigacaoDto {
  @ApiProperty({ enum: ['sem', 'enviando', 'pronta', 'falhou'] })
  situacao: 'sem' | 'enviando' | 'pronta' | 'falhou';
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Motivo da falha, em português.',
  })
  erro: string | null;
  @ApiProperty({ type: Number, nullable: true })
  duracaoSegundos: number | null;
  @ApiProperty({
    description:
      'Há áudio para ouvir (`GET /ligacoes/:id/audio`). Falso depois da remoção pela guarda.',
  })
  disponivel: boolean;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'A guarda venceu (ou o contato foi anonimizado): gravação e transcrição apagadas.',
  })
  removidaEm: string | null;
  @ApiProperty({
    description:
      'Só Admin e líderes baixam (`GET /ligacoes/:id/audio/baixar`).',
  })
  podeBaixar: boolean;
}

export class TranscricaoDaLigacaoDto {
  @ApiProperty({
    enum: ['pendente', 'processando', 'pronta', 'falhou', 'desativada'],
    nullable: true,
    description: 'Nulo = a ligação não foi gravada.',
  })
  situacao:
    'pendente' | 'processando' | 'pronta' | 'falhou' | 'desativada' | null;
  @ApiProperty({ type: String, nullable: true }) erro: string | null;
  @ApiProperty({ type: String, nullable: true }) processadaEm: string | null;
}

export class SugestaoDeAtividadeDto {
  @ApiProperty() id: string;
  @ApiProperty() titulo: string;
  @ApiProperty() descricao: string;
  @ApiProperty({ enum: ['LIGACAO', 'TAREFA', 'EMAIL', 'WHATSAPP', 'REUNIAO'] })
  tipo: string;
  @ApiProperty({ description: 'Prazo sugerido em dias a partir de hoje.' })
  prazoEmDias: number;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'A atividade criada quando o usuário confirmou.',
  })
  atividadeId: string | null;
  @ApiProperty({ type: String, nullable: true }) descartadaEm: string | null;
}

export class ConteudoDoResumoDto {
  @ApiProperty() assunto: string;
  @ApiProperty({ type: [String] }) pontosPrincipais: string[];
  @ApiProperty({ type: [String] }) combinados: string[];
  @ApiProperty({ type: [String] }) proximosPassos: string[];
  @ApiProperty({ enum: ['positivo', 'neutro', 'negativo', 'misto'] })
  sentimento: string;
  @ApiProperty() sentimentoMotivo: string;
  @ApiProperty({ type: [SugestaoDeAtividadeDto] })
  sugestoes: SugestaoDeAtividadeDto[];
  @ApiProperty({ description: 'Modelo do Claude que resumiu.' }) modelo: string;
}

export class ResumoDaLigacaoDto {
  @ApiProperty({
    enum: ['pendente', 'processando', 'pronto', 'falhou', 'desativado'],
    nullable: true,
  })
  situacao:
    'pendente' | 'processando' | 'pronto' | 'falhou' | 'desativado' | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Falha ou motivo de estar desativado (sem chave da Anthropic, conversa curta…).',
  })
  erro: string | null;
  @ApiProperty({ type: String, nullable: true }) processadoEm: string | null;
  @ApiProperty({ type: ConteudoDoResumoDto, nullable: true })
  conteudo: ConteudoDoResumoDto | null;
}

export class TrechoDaTranscricaoDto {
  @ApiProperty({ enum: ['atendente', 'cliente', 'participante'] })
  falante: string;
  @ApiProperty({ description: 'Segundos desde o início da gravação.' })
  inicio: number;
  @ApiProperty() fim: number;
  @ApiProperty() texto: string;
}

export class TranscricaoCompletaDto {
  @ApiProperty({
    enum: ['pendente', 'processando', 'pronta', 'falhou', 'desativada'],
  })
  situacao: string;
  @ApiProperty({ type: String, nullable: true }) erro: string | null;
  @ApiProperty({ type: String, nullable: true }) modelo: string | null;
  @ApiProperty({ type: Number, nullable: true }) duracaoSegundos: number | null;
  @ApiProperty({ type: [TrechoDaTranscricaoDto] })
  trechos: TrechoDaTranscricaoDto[];
}

export class RespostaDaParteDto {
  @ApiProperty() sequencia: number;
  @ApiProperty({
    description: 'A parte já tinha chegado (reenvio): nada mudou.',
  })
  duplicada: boolean;
  @ApiProperty({ description: 'Partes guardadas até agora.' })
  partes: number;
}

export class FinalizarGravacaoDto {
  @ApiPropertyOptional({
    description:
      'Quantas partes o navegador enviou (0 a N-1). Ausente: as que a API tiver.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'deve ser um número inteiro' })
  @Min(0, { message: 'mínimo 0' })
  @Max(MAX_SEQUENCIA_DA_PARTE + 1, maximo(MAX_SEQUENCIA_DA_PARTE + 1))
  totalPartes?: number;
}

export class RespostaDeFinalizacaoDto {
  @ApiProperty({ enum: ['sem', 'enviando', 'pronta', 'falhou'] })
  gravacao: string;
  @ApiProperty({ description: 'Partes juntadas na gravação.' }) partes: number;
  @ApiProperty({
    description: 'Já tinha sido finalizada antes (chamada repetida).',
  })
  jaFinalizada: boolean;
}

export class ReprocessarDto {
  @ApiPropertyOptional({
    enum: ['completo', 'resumo'],
    default: 'completo',
    description:
      '`completo` refaz a conversão, a transcrição e o resumo; `resumo` só o resumo (exige a transcrição pronta).',
  })
  @IsOptional()
  @IsEnum(['completo', 'resumo'], {
    message: 'deve ser "completo" ou "resumo"',
  })
  etapa?: 'completo' | 'resumo';
}

export class ConfirmarSugestaoDto {
  @ApiPropertyOptional({ description: 'Ajuste do título antes de criar.' })
  @IsOptional()
  @Transform(aparar)
  @IsString(MENSAGEM_TEXTO)
  @MaxLength(160, maximo(160))
  titulo?: string;

  @ApiPropertyOptional({ description: 'Ajuste da descrição antes de criar.' })
  @IsOptional()
  @Transform(aparar)
  @IsString(MENSAGEM_TEXTO)
  @MaxLength(2000, maximo(2000))
  descricao?: string;

  @ApiPropertyOptional({ enum: TipoAtividade, enumName: 'TipoAtividade' })
  @IsOptional()
  @IsEnum(['LIGACAO', 'TAREFA', 'EMAIL', 'WHATSAPP', 'REUNIAO'], {
    message: 'deve ser LIGACAO, TAREFA, EMAIL, WHATSAPP ou REUNIAO',
  })
  tipo?: 'LIGACAO' | 'TAREFA' | 'EMAIL' | 'WHATSAPP' | 'REUNIAO';

  @ApiPropertyOptional({
    description:
      'Vencimento (ISO 8601 com fuso). Ausente: o prazo sugerido, às 18h de Brasília. Na reunião é o início.',
  })
  @IsOptional()
  @IsString(MENSAGEM_TEXTO)
  venceEm?: string;

  @ApiPropertyOptional({
    description: 'Só reunião: fim (ausente: 1 h depois do início).',
  })
  @IsOptional()
  @IsString(MENSAGEM_TEXTO)
  fimEm?: string;

  @ApiPropertyOptional({ description: 'Responsável (ausente: quem confirma).' })
  @IsOptional()
  @IsUUID('all', MENSAGEM_UUID)
  responsavelId?: string;
}

export class RespostaDeSugestaoDto {
  @ApiProperty() sugestaoId: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'A atividade criada (nulo ao descartar).',
  })
  atividadeId: string | null;
  @ApiProperty({ type: ConteudoDoResumoDto }) resumo: ConteudoDoResumoDto;
}
