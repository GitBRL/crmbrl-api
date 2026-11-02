import {
  ApiProperty,
  ApiPropertyOptional,
  IntersectionType,
} from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { FORMATO_VALOR, formatarValor } from '../../comum/dominio/dinheiro';
import type { Utm } from '../../comum/dominio/utm';
import { PaginacaoDto } from '../../comum/paginacao/paginacao';
import {
  Area,
  OrigemContato,
  StatusNegocio,
  TipoAtor,
} from '../../generated/prisma/client';
import {
  diasNaEtapa,
  estaParado,
  formatarDataSemHora,
  type MovimentacaoCompleta,
  type NegocioCompleto,
} from '../negocio-completo';
import {
  aparar,
  lerBooleano,
  OpcionalNaoNulo,
  ResumoContatoDto,
  ResumoEmpresaDto,
  ResumoEtapaDto,
  ResumoFunilDto,
  ResumoUsuarioDto,
  UtmDto,
} from './comum.dto';

const MENSAGEM_VALOR =
  'deve ser um valor em reais com até 2 casas, com ponto (ex.: 1500.00)';
const MENSAGEM_UUID = 'deve ser um identificador (UUID) válido';
const FORMATO_DATA = /^\d{4}-\d{2}-\d{2}$/;
const MENSAGEM_FORMATO_DATA = 'deve estar no formato AAAA-MM-DD';
const MENSAGEM_DATA = 'deve ser uma data válida';

export const TAMANHO_MAXIMO_MOTIVO_PERDA = 500;

/** Etapa no negócio, com o prazo-alvo (para o "parado"). */
export class EtapaDoNegocioDto extends ResumoEtapaDto {
  @ApiPropertyOptional({ nullable: true, type: Number })
  prazoDias: number | null;

  @ApiPropertyOptional({ nullable: true, type: Number })
  probabilidade: number | null;
}

export class NegocioDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'ACME — plano anual' })
  titulo: string;

  @ApiProperty({
    enum: StatusNegocio,
    enumName: 'StatusNegocio',
    description: 'Deriva do tipo da etapa (R5.3).',
  })
  status: StatusNegocio;

  @ApiProperty({ description: 'Em reais, texto decimal.', example: '1500.00' })
  valor: string;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description: 'Valor recorrente mensal.',
    example: '299.90',
  })
  valorRecorrente: string | null;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    format: 'date',
    example: '2026-11-30',
  })
  previsaoFechamento: string | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  motivoPerda: string | null;

  @ApiPropertyOptional({ nullable: true, type: String, format: 'date-time' })
  ganhoEm: string | null;

  @ApiPropertyOptional({ nullable: true, type: String, format: 'date-time' })
  perdidoEm: string | null;

  @ApiProperty({
    format: 'date-time',
    description: 'Desde quando está na etapa atual.',
  })
  etapaDesde: string;

  @ApiProperty({ description: 'Dias inteiros na etapa atual.', example: 3 })
  diasNaEtapa: number;

  @ApiProperty({
    description:
      'Aberto há mais tempo na etapa do que o prazo-alvo dela (R5.10).',
  })
  parado: boolean;

  @ApiProperty({
    description: 'Ordem no kanban dentro da etapa (crescente).',
    example: 1.5,
  })
  posicao: number;

  @ApiProperty({ enum: OrigemContato, enumName: 'OrigemContato' })
  origem: OrigemContato;

  @ApiPropertyOptional({ nullable: true, type: String })
  origemDetalhe: string | null;

  @ApiPropertyOptional({ nullable: true, type: UtmDto })
  utm: Utm | null;

  @ApiProperty({
    description:
      'Quantas vezes o contato voltou por automação com este negócio aberto (R5.6).',
  })
  reconversoes: number;

  @ApiPropertyOptional({ nullable: true, type: String, format: 'date-time' })
  ultimaReconversaoEm: string | null;

  @ApiProperty({ type: 'object', additionalProperties: true })
  camposPersonalizados: Record<string, unknown>;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    format: 'uuid',
    description: 'Negócio que originou este por uma passagem (R5.7).',
  })
  negocioOrigemId: string | null;

  @ApiProperty({ type: ResumoFunilDto })
  funil: ResumoFunilDto;

  @ApiProperty({ type: EtapaDoNegocioDto })
  etapa: EtapaDoNegocioDto;

  @ApiProperty({ type: ResumoContatoDto })
  contato: ResumoContatoDto;

  @ApiPropertyOptional({ nullable: true, type: ResumoEmpresaDto })
  empresa: ResumoEmpresaDto | null;

  @ApiPropertyOptional({
    nullable: true,
    type: ResumoUsuarioDto,
    description: 'Nulo = sem responsável (o membro da área pode assumir).',
  })
  responsavel: ResumoUsuarioDto | null;

  @ApiPropertyOptional({ nullable: true, type: String, format: 'uuid' })
  criadoPorId: string | null;

  @ApiProperty({ format: 'date-time' })
  criadoEm: string;

  @ApiProperty({ format: 'date-time' })
  atualizadoEm: string;

  static de(negocio: NegocioCompleto, agora: Date = new Date()): NegocioDto {
    return {
      id: negocio.id,
      titulo: negocio.titulo,
      status: negocio.status,
      valor: formatarValor(negocio.valor) ?? '0.00',
      valorRecorrente: formatarValor(negocio.valorRecorrente),
      previsaoFechamento: formatarDataSemHora(negocio.previsaoFechamento),
      motivoPerda: negocio.motivoPerda,
      ganhoEm: negocio.ganhoEm?.toISOString() ?? null,
      perdidoEm: negocio.perdidoEm?.toISOString() ?? null,
      etapaDesde: negocio.etapaDesde.toISOString(),
      diasNaEtapa: diasNaEtapa(negocio.etapaDesde, agora),
      parado: estaParado(negocio, negocio.etapa.prazoDias, agora),
      posicao: negocio.posicao,
      origem: negocio.origem,
      origemDetalhe: negocio.origemDetalhe,
      utm: (negocio.utm as Utm | null) ?? null,
      reconversoes: negocio.reconversoes,
      ultimaReconversaoEm: negocio.ultimaReconversaoEm?.toISOString() ?? null,
      camposPersonalizados:
        (negocio.camposPersonalizados as Record<string, unknown> | null) ?? {},
      negocioOrigemId: negocio.negocioOrigemId,
      funil: {
        id: negocio.funil.id,
        nome: negocio.funil.nome,
        area: negocio.funil.area,
      },
      etapa: {
        id: negocio.etapa.id,
        nome: negocio.etapa.nome,
        tipo: negocio.etapa.tipo,
        ordem: negocio.etapa.ordem,
        prazoDias: negocio.etapa.prazoDias,
        probabilidade: negocio.etapa.probabilidade,
      },
      contato: {
        id: negocio.contato.id,
        nome: negocio.contato.nome,
        email: negocio.contato.email,
        telefone: negocio.contato.telefone,
        etiquetas: negocio.contato.etiquetas,
      },
      empresa: negocio.empresa
        ? { id: negocio.empresa.id, nome: negocio.empresa.nome }
        : null,
      responsavel: negocio.responsavel
        ? {
            id: negocio.responsavel.id,
            nome: negocio.responsavel.nome,
            avatarUrl: negocio.responsavel.avatarUrl,
          }
        : null,
      criadoPorId: negocio.criadoPorId,
      criadoEm: negocio.criadoEm.toISOString(),
      atualizadoEm: negocio.atualizadoEm.toISOString(),
    };
  }
}

/** Um negócio do outro lado da jornada (passagem entre funis, R5.7). */
export class NegocioDaJornadaDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({
    enum: Area,
    enumName: 'Area',
    description: 'Área do funil desse negócio.',
  })
  area: Area;

  @ApiProperty({
    description:
      'Quem consulta vê esse negócio (R5.9). Sem acesso, a tela mostra só a área ("negócio em Customer Success, sem acesso").',
  })
  visivel: boolean;
}

/** De onde o negócio veio e o que ele gerou nos outros funis (R5.7). */
export class JornadaDoNegocioDto {
  @ApiPropertyOptional({
    nullable: true,
    type: NegocioDaJornadaDto,
    description: 'O negócio que originou este por uma passagem.',
  })
  origem: NegocioDaJornadaDto | null;

  @ApiProperty({
    type: [NegocioDaJornadaDto],
    description:
      'Os negócios criados a partir deste por passagens, do mais antigo ao mais novo — inclusive os de funis que quem consulta não vê.',
  })
  gerados: NegocioDaJornadaDto[];
}

/** `GET /negocios/:id`: o negócio e a jornada dele entre os funis. */
export class NegocioDetalheDto extends NegocioDto {
  @ApiProperty({ type: JornadaDoNegocioDto })
  jornada: JornadaDoNegocioDto;
}

export class CriarNegocioDto {
  @ApiPropertyOptional({
    maxLength: 200,
    description: 'Padrão: o nome do contato.',
  })
  @OpcionalNaoNulo()
  @Transform(aparar)
  @IsString({ message: 'deve ser um texto' })
  @IsNotEmpty({ message: 'é obrigatório' })
  @MaxLength(200, { message: 'deve ter no máximo 200 caracteres' })
  titulo?: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID('all', { message: MENSAGEM_UUID })
  contatoId: string;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    format: 'uuid',
    description: 'Padrão: a empresa do contato.',
  })
  @IsOptional()
  @IsUUID('all', { message: MENSAGEM_UUID })
  empresaId?: string | null;

  @ApiProperty({ format: 'uuid' })
  @IsUUID('all', { message: MENSAGEM_UUID })
  funilId: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Padrão: a primeira etapa aberta do funil.',
  })
  @OpcionalNaoNulo()
  @IsUUID('all', { message: MENSAGEM_UUID })
  etapaId?: string;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    format: 'uuid',
    description:
      'Padrão: quem cria. `null` deixa sem responsável (o membro da área pode assumir).',
  })
  @IsOptional()
  @IsUUID('all', { message: MENSAGEM_UUID })
  responsavelId?: string | null;

  @ApiPropertyOptional({ example: '1500.00', default: '0.00' })
  @OpcionalNaoNulo()
  @IsString({ message: 'deve ser um texto' })
  @Matches(FORMATO_VALOR, { message: MENSAGEM_VALOR })
  valor?: string;

  @ApiPropertyOptional({ nullable: true, type: String, example: '299.90' })
  @IsOptional()
  @IsString({ message: 'deve ser um texto' })
  @Matches(FORMATO_VALOR, { message: MENSAGEM_VALOR })
  valorRecorrente?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    format: 'date',
    example: '2026-11-30',
  })
  @IsOptional()
  @Matches(FORMATO_DATA, { message: MENSAGEM_FORMATO_DATA })
  @IsDateString({ strict: true }, { message: MENSAGEM_DATA })
  previsaoFechamento?: string | null;

  @ApiPropertyOptional({
    maxLength: TAMANHO_MAXIMO_MOTIVO_PERDA,
    description: 'Obrigatório se a etapa for de perda (R5.5).',
  })
  @OpcionalNaoNulo()
  @Transform(aparar)
  @IsString({ message: 'deve ser um texto' })
  @IsNotEmpty({ message: 'é obrigatório' })
  @MaxLength(TAMANHO_MAXIMO_MOTIVO_PERDA, {
    message: `deve ter no máximo ${TAMANHO_MAXIMO_MOTIVO_PERDA} caracteres`,
  })
  motivoPerda?: string;

  @ApiPropertyOptional({
    enum: OrigemContato,
    enumName: 'OrigemContato',
    default: OrigemContato.MANUAL,
  })
  @OpcionalNaoNulo()
  @IsEnum(OrigemContato, { message: 'deve ser uma origem válida' })
  origem?: OrigemContato;

  @ApiPropertyOptional({ maxLength: 200, example: 'Indicação do cliente X' })
  @OpcionalNaoNulo()
  @Transform(aparar)
  @IsString({ message: 'deve ser um texto' })
  @MaxLength(200, { message: 'deve ter no máximo 200 caracteres' })
  origemDetalhe?: string;

  @ApiPropertyOptional({ type: UtmDto })
  @OpcionalNaoNulo()
  @IsObject({ message: 'deve ser um objeto' })
  @ValidateNested()
  @Type(() => UtmDto)
  utm?: UtmDto;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  @OpcionalNaoNulo()
  @IsObject({ message: 'deve ser um objeto' })
  camposPersonalizados?: Record<string, unknown>;
}

/** Edição dos dados do negócio. Etapa e status mudam por `mover` e `reabrir`. */
export class AtualizarNegocioDto {
  @ApiPropertyOptional({ maxLength: 200 })
  @OpcionalNaoNulo()
  @Transform(aparar)
  @IsString({ message: 'deve ser um texto' })
  @IsNotEmpty({ message: 'é obrigatório' })
  @MaxLength(200, { message: 'deve ter no máximo 200 caracteres' })
  titulo?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @OpcionalNaoNulo()
  @IsUUID('all', { message: MENSAGEM_UUID })
  contatoId?: string;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    format: 'uuid',
    description: '`null` tira a empresa.',
  })
  @IsOptional()
  @IsUUID('all', { message: MENSAGEM_UUID })
  empresaId?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    format: 'uuid',
    description: '`null` deixa sem responsável.',
  })
  @IsOptional()
  @IsUUID('all', { message: MENSAGEM_UUID })
  responsavelId?: string | null;

  @ApiPropertyOptional({ example: '1500.00' })
  @OpcionalNaoNulo()
  @IsString({ message: 'deve ser um texto' })
  @Matches(FORMATO_VALOR, { message: MENSAGEM_VALOR })
  valor?: string;

  @ApiPropertyOptional({ nullable: true, type: String, example: '299.90' })
  @IsOptional()
  @IsString({ message: 'deve ser um texto' })
  @Matches(FORMATO_VALOR, { message: MENSAGEM_VALOR })
  valorRecorrente?: string | null;

  @ApiPropertyOptional({ nullable: true, type: String, format: 'date' })
  @IsOptional()
  @Matches(FORMATO_DATA, { message: MENSAGEM_FORMATO_DATA })
  @IsDateString({ strict: true }, { message: MENSAGEM_DATA })
  previsaoFechamento?: string | null;

  @ApiPropertyOptional({
    maxLength: TAMANHO_MAXIMO_MOTIVO_PERDA,
    description: 'Só para negócio perdido (R5.5).',
  })
  @OpcionalNaoNulo()
  @Transform(aparar)
  @IsString({ message: 'deve ser um texto' })
  @IsNotEmpty({ message: 'é obrigatório' })
  @MaxLength(TAMANHO_MAXIMO_MOTIVO_PERDA, {
    message: `deve ter no máximo ${TAMANHO_MAXIMO_MOTIVO_PERDA} caracteres`,
  })
  motivoPerda?: string;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  @OpcionalNaoNulo()
  @IsObject({ message: 'deve ser um objeto' })
  camposPersonalizados?: Record<string, unknown>;
}

export class MoverNegocioDto {
  @ApiProperty({
    format: 'uuid',
    description:
      'Etapa de destino, do mesmo funil (R5.4). A mesma etapa só reposiciona o cartão.',
  })
  @IsUUID('all', { message: MENSAGEM_UUID })
  etapaId: string;

  @ApiPropertyOptional({
    maxLength: TAMANHO_MAXIMO_MOTIVO_PERDA,
    description: 'Obrigatório ao entrar numa etapa de perda (R5.5).',
  })
  @OpcionalNaoNulo()
  @Transform(aparar)
  @IsString({ message: 'deve ser um texto' })
  @IsNotEmpty({ message: 'é obrigatório' })
  @MaxLength(TAMANHO_MAXIMO_MOTIVO_PERDA, {
    message: `deve ter no máximo ${TAMANHO_MAXIMO_MOTIVO_PERDA} caracteres`,
  })
  motivoPerda?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Cartão que fica logo acima, na etapa de destino. Sem `depoisDeId` nem `antesDeId`, o cartão vai para o topo.',
  })
  @OpcionalNaoNulo()
  @IsUUID('all', { message: MENSAGEM_UUID })
  depoisDeId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Cartão que fica logo abaixo, na etapa de destino.',
  })
  @OpcionalNaoNulo()
  @IsUUID('all', { message: MENSAGEM_UUID })
  antesDeId?: string;
}

export class ReabrirNegocioDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Etapa aberta do mesmo funil. Padrão: a etapa aberta em que estava antes de fechar.',
  })
  @OpcionalNaoNulo()
  @IsUUID('all', { message: MENSAGEM_UUID })
  etapaId?: string;
}

/** Recorte dos negócios por quem é o responsável. */
export const VISOES = ['TODOS', 'MEUS', 'EQUIPE'] as const;
export type Visao = (typeof VISOES)[number];

export const ORDENACOES_NEGOCIOS = [
  'criadoEm',
  'atualizadoEm',
  'valor',
  'previsaoFechamento',
  'posicao',
  'titulo',
] as const;
export type OrdenacaoNegocios = (typeof ORDENACOES_NEGOCIOS)[number];

/** Filtros comuns ao kanban e à lista de negócios. */
export class FiltroBaseNegociosDto {
  @ApiPropertyOptional({
    enum: VISOES,
    default: 'TODOS',
    description:
      '`MEUS`: sou o responsável; `EQUIPE`: eu e meus liderados (diretos e os liderados deles); `TODOS`: tudo o que posso ver (R5.9).',
  })
  @IsOptional()
  @IsIn(VISOES, { message: 'deve ser TODOS, MEUS ou EQUIPE' })
  visao: Visao = 'TODOS';

  @ApiPropertyOptional({
    description:
      'Busca no título, no nome/e-mail/telefone do contato e no nome da empresa.',
    maxLength: 100,
  })
  @IsOptional()
  @Transform(aparar)
  @IsString({ message: 'deve ser um texto' })
  @MaxLength(100, { message: 'deve ter no máximo 100 caracteres' })
  busca?: string;

  @ApiPropertyOptional({
    description:
      'Etiqueta do contato ou da empresa (sem diferenciar maiúsculas).',
    maxLength: 50,
  })
  @IsOptional()
  @Transform(aparar)
  @IsString({ message: 'deve ser um texto' })
  @MaxLength(50, { message: 'deve ter no máximo 50 caracteres' })
  etiqueta?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('all', { message: MENSAGEM_UUID })
  responsavelId?: string;

  @ApiPropertyOptional({
    description: 'Só os sem responsável (os que o membro pode assumir).',
  })
  @IsOptional()
  @Transform(lerBooleano)
  @IsBoolean({ message: 'deve ser verdadeiro ou falso' })
  semResponsavel?: boolean;
}

/** Lista paginada de negócios: os filtros do kanban e mais alguns. */
export class FiltroNegociosDto extends IntersectionType(
  PaginacaoDto,
  FiltroBaseNegociosDto,
) {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('all', { message: MENSAGEM_UUID })
  funilId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('all', { message: MENSAGEM_UUID })
  etapaId?: string;

  @ApiPropertyOptional({ enum: StatusNegocio, enumName: 'StatusNegocio' })
  @IsOptional()
  @IsEnum(StatusNegocio, { message: 'deve ser ABERTO, GANHO ou PERDIDO' })
  status?: StatusNegocio;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('all', { message: MENSAGEM_UUID })
  contatoId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('all', { message: MENSAGEM_UUID })
  empresaId?: string;

  @ApiPropertyOptional({
    description: 'Só os abertos há mais tempo que o prazo-alvo da etapa.',
  })
  @IsOptional()
  @Transform(lerBooleano)
  @IsBoolean({ message: 'deve ser verdadeiro ou falso' })
  parados?: boolean;

  @ApiPropertyOptional({ enum: ORDENACOES_NEGOCIOS, default: 'criadoEm' })
  @IsOptional()
  @IsIn(ORDENACOES_NEGOCIOS, {
    message: `deve ser um destes valores: ${ORDENACOES_NEGOCIOS.join(', ')}`,
  })
  ordenarPor: OrdenacaoNegocios = 'criadoEm';

  @ApiPropertyOptional({ enum: ['asc', 'desc'], default: 'desc' })
  @IsOptional()
  @IsIn(['asc', 'desc'], { message: 'deve ser asc ou desc' })
  direcao: 'asc' | 'desc' = 'desc';
}

export class MovimentacaoDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiPropertyOptional({
    nullable: true,
    type: ResumoEtapaDto,
    description: 'Nulo na entrada do negócio no funil.',
  })
  deEtapa: ResumoEtapaDto | null;

  @ApiPropertyOptional({
    nullable: true,
    type: ResumoEtapaDto,
    description: 'Nulo só se a etapa foi excluída depois.',
  })
  paraEtapa: ResumoEtapaDto | null;

  @ApiPropertyOptional({ nullable: true, type: ResumoUsuarioDto })
  usuario: ResumoUsuarioDto | null;

  @ApiProperty({ enum: TipoAtor, enumName: 'TipoAtor' })
  tipoAtor: TipoAtor;

  @ApiPropertyOptional({
    nullable: true,
    type: Number,
    description: 'Quanto tempo ficou na etapa anterior.',
  })
  segundosNaEtapaAnterior: number | null;

  @ApiProperty({ format: 'date-time' })
  criadoEm: string;

  static de(movimentacao: MovimentacaoCompleta): MovimentacaoDto {
    return {
      id: movimentacao.id,
      deEtapa: movimentacao.deEtapa,
      paraEtapa: movimentacao.paraEtapa,
      usuario: movimentacao.usuario,
      tipoAtor: movimentacao.tipoAtor,
      segundosNaEtapaAnterior: movimentacao.segundosNaEtapaAnterior,
      criadoEm: movimentacao.criadoEm.toISOString(),
    };
  }
}

/** Uma passagem executada por uma movimentação (R5.7). */
export class PassagemExecutadaDto {
  @ApiProperty({ format: 'uuid' })
  passagemId: string;

  @ApiProperty({ example: 'Comercial → Customer Success' })
  nome: string;

  @ApiProperty({ format: 'uuid' })
  negocioOrigemId: string;

  @ApiProperty({
    format: 'uuid',
    description:
      'O negócio criado no funil de destino — ou o aberto que recebeu a reconversão (R5.6).',
  })
  negocioDestinoId: string;

  @ApiProperty({ format: 'uuid' })
  funilDestinoId: string;

  @ApiProperty()
  criado: boolean;

  @ApiProperty()
  reconversao: boolean;

  @ApiPropertyOptional({ nullable: true, type: ResumoUsuarioDto })
  responsavel: ResumoUsuarioDto | null;
}

export class ResultadoMovimentacaoDto {
  @ApiProperty({ type: NegocioDto })
  negocio: NegocioDto;

  @ApiProperty({
    type: [PassagemExecutadaDto],
    description:
      'Passagens disparadas por esta movimentação, na mesma transação.',
  })
  passagens: PassagemExecutadaDto[];
}
