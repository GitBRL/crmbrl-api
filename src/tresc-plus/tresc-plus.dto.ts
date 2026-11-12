import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  aparar,
  apararOuNulo,
  maximo,
  MENSAGEM_BOOLEANO,
  MENSAGEM_OBRIGATORIO,
  MENSAGEM_TEXTO,
  MENSAGEM_UUID,
} from '../canais/comum/dto-comum';
import {
  FORMATOS_DE_ENVELOPE,
  type FormatoDeEnvelope,
  LIMITE_ENVIO_DISCADOR,
} from './tresc-plus.constantes';

const MENSAGEM_INTEIRO = { message: 'deve ser um número inteiro' };

// ---------------------------------------------------------------------------
// R34.1 — conexão da empresa
// ---------------------------------------------------------------------------

export class AtualizarConexaoDto {
  @ApiPropertyOptional({
    description: 'Liga ou desliga a integração (exige o token).',
  })
  @IsOptional()
  @IsBoolean(MENSAGEM_BOOLEANO)
  ativa?: boolean;

  @ApiPropertyOptional({ example: 'https://3c.plus/api/v1' })
  @IsOptional()
  @Transform(aparar)
  @IsString(MENSAGEM_TEXTO)
  @MaxLength(300, maximo(300))
  urlApi?: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      'Servidor socket.io (lacuna: o endereço real só se confirma com a conta). Vazio/nulo = o host da API.',
  })
  @IsOptional()
  @Transform(apararOuNulo)
  @IsString(MENSAGEM_TEXTO)
  @MaxLength(300, maximo(300))
  urlSocket?: string | null;

  @ApiPropertyOptional({ example: '/socket.io' })
  @IsOptional()
  @Transform(aparar)
  @IsString(MENSAGEM_TEXTO)
  @MaxLength(100, maximo(100))
  caminhoSocket?: string;

  @ApiPropertyOptional({
    enum: FORMATOS_DE_ENVELOPE,
    description:
      'Formato do envelope dos eventos: `AUTO` (detecta), `EVENTO_DADOS` (`{event,data}`) ou `OBJETO` (nome do evento + objeto).',
  })
  @IsOptional()
  @IsIn(FORMATOS_DE_ENVELOPE, {
    message: `deve ser um destes valores: ${FORMATOS_DE_ENVELOPE.join(', ')}`,
  })
  formatoEnvelope?: FormatoDeEnvelope;

  @ApiPropertyOptional({
    description:
      'Token do gestor. Cifrado ao gravar e nunca devolvido: a resposta traz só os 4 últimos caracteres.',
  })
  @IsOptional()
  @Transform(aparar)
  @IsString(MENSAGEM_TEXTO)
  @MaxLength(500, maximo(500))
  token?: string;

  @ApiPropertyOptional({
    description: 'Apaga o token guardado (e desativa a integração).',
  })
  @IsOptional()
  @IsBoolean(MENSAGEM_BOOLEANO)
  limparToken?: boolean;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    description: 'Campanha padrão do modo manual.',
  })
  @IsOptional()
  @IsInt(MENSAGEM_INTEIRO)
  @Min(1, { message: 'deve ser maior que zero' })
  campanhaPadraoId?: number | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @Transform(apararOuNulo)
  @IsString(MENSAGEM_TEXTO)
  @MaxLength(200, maximo(200))
  campanhaPadraoNome?: string | null;
}

export class CampanhaPadraoDto {
  @ApiProperty() id: number;
  @ApiProperty({ type: String, nullable: true }) nome: string | null;
}

export class TesteDaConexaoDto {
  @ApiProperty({ format: 'date-time' }) em: string;
  @ApiProperty() ok: boolean;
  @ApiProperty({ type: String, nullable: true }) mensagem: string | null;
}

export class OuvinteDto {
  @ApiProperty({
    type: String,
    nullable: true,
    description: '`conectado`, `reconectando`, `desconectado` ou `erro`.',
  })
  estado: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) em:
    string | null;
}

export class ConexaoTrescPlusDto {
  @ApiProperty() ativa: boolean;
  @ApiProperty() urlApi: string;
  @ApiProperty({ type: String, nullable: true }) urlSocket: string | null;
  @ApiProperty() caminhoSocket: string;
  @ApiProperty({ enum: FORMATOS_DE_ENVELOPE })
  formatoEnvelope: FormatoDeEnvelope;
  @ApiProperty() tokenConfigurado: boolean;
  @ApiProperty({
    type: String,
    nullable: true,
    example: '••••a1b2',
    description: 'Só os 4 últimos caracteres.',
  })
  token: string | null;
  @ApiProperty({ type: CampanhaPadraoDto, nullable: true })
  campanhaPadrao: CampanhaPadraoDto | null;
  @ApiProperty({ type: TesteDaConexaoDto, nullable: true })
  teste: TesteDaConexaoDto | null;
  @ApiProperty({ type: OuvinteDto }) ouvinte: OuvinteDto;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  reconciliadaEm: string | null;
}

export class UsuarioDoTesteDto {
  @ApiProperty({ type: Number, nullable: true }) id: number | null;
  @ApiProperty({ type: String, nullable: true }) nome: string | null;
  @ApiProperty({ type: String, nullable: true }) papel: string | null;
}

export class ResultadoDoTesteTrescDto {
  @ApiProperty() ok: boolean;
  @ApiProperty() mensagem: string;
  @ApiProperty({ type: UsuarioDoTesteDto, nullable: true })
  usuario: UsuarioDoTesteDto | null;
}

export class CampanhaTrescDto {
  @ApiProperty() id: number;
  @ApiProperty() nome: string;
  @ApiProperty({ type: Boolean, nullable: true }) pausada: boolean | null;
}

export class ListaTrescDto {
  @ApiProperty() id: number;
  @ApiProperty() nome: string;
}

// ---------------------------------------------------------------------------
// R34.2 — vínculo do vendedor
// ---------------------------------------------------------------------------

export class VincularDto {
  @ApiProperty({ description: 'E-mail ou ramal do usuário no 3C+.' })
  @Transform(aparar)
  @IsString(MENSAGEM_TEXTO)
  @IsNotEmpty(MENSAGEM_OBRIGATORIO)
  @MaxLength(200, maximo(200))
  usuario: string;

  @ApiProperty({
    description:
      'Senha do 3C+. Usada uma única vez em `POST /authenticate`; nunca é guardada.',
  })
  @IsString(MENSAGEM_TEXTO)
  @IsNotEmpty(MENSAGEM_OBRIGATORIO)
  @MaxLength(200, maximo(200))
  senha: string;
}

export class VinculoDto {
  @ApiProperty() vinculado: boolean;
  @ApiPropertyOptional({ type: String, format: 'uuid' }) usuarioId?: string;
  @ApiPropertyOptional({ type: String, nullable: true }) ramal?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) nome3c?: string | null;
  @ApiPropertyOptional({ type: Number }) trescUsuarioId?: number;
  @ApiPropertyOptional({
    type: String,
    example: '••••a1b2',
    description: 'Só os 4 últimos caracteres do token.',
  })
  token?: string;
  @ApiPropertyOptional({ type: String, format: 'date-time' })
  vinculadoEm?: string;
}

// ---------------------------------------------------------------------------
// R34.5 — agente e ligação
// ---------------------------------------------------------------------------

export class EstadoDoAgenteDto {
  @ApiProperty() vinculado: boolean;
  @ApiProperty({
    enum: [
      'desconectado',
      'ocioso',
      'manual',
      'em_ligacao',
      'pos_atendimento',
      'pausa',
    ],
  })
  estado: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) desde:
    string | null;
  @ApiProperty({ type: CampanhaPadraoDto, nullable: true })
  campanha: CampanhaPadraoDto | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: '`manual` ou `dialer`.',
  })
  modo: string | null;
  @ApiProperty({
    type: CampanhaPadraoDto,
    nullable: true,
    description: 'Pausa em curso.',
  })
  pausa: CampanhaPadraoDto | null;
  @ApiProperty({
    type: String,
    nullable: true,
    format: 'uuid',
    description: 'Ligação do 3C+ em curso ou aguardando qualificação.',
  })
  ligacaoId: string | null;
  @ApiProperty({
    type: CampanhaPadraoDto,
    nullable: true,
    description:
      'Campanha padrão da empresa (usada ao ligar sem estar em campanha).',
  })
  campanhaPadrao: CampanhaPadraoDto | null;
}

export class EntrarNaCampanhaDto {
  @ApiPropertyOptional({
    description: 'Ausente: a campanha padrão da empresa.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt(MENSAGEM_INTEIRO)
  @Min(1, { message: 'deve ser maior que zero' })
  campanhaId?: number;

  @ApiPropertyOptional({ enum: ['manual', 'dialer'], default: 'manual' })
  @IsOptional()
  @IsIn(['manual', 'dialer'], { message: 'deve ser manual ou dialer' })
  modo?: 'manual' | 'dialer';
}

export class EntrarNaPausaDto {
  @ApiProperty({
    description: 'Id do intervalo (de `GET /tresc-plus/agente/pausas`).',
  })
  @IsInt(MENSAGEM_INTEIRO)
  @Min(1, { message: 'deve ser maior que zero' })
  intervaloId: number;
}

export class PausaTrescDto {
  @ApiProperty() id: number;
  @ApiProperty() nome: string;
  @ApiProperty({ type: Number, nullable: true }) minutos: number | null;
  @ApiProperty({ type: String, nullable: true }) cor: string | null;
}

export class LigarTrescDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Contato a ligar. Sem ele, informe `negocioId` (o contato do negócio) ou só `telefone` (receptivo/avulso não registra).',
  })
  @IsOptional()
  @IsUUID('all', MENSAGEM_UUID)
  contatoId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Negócio da ligação (a ligação entra nele).',
  })
  @IsOptional()
  @IsUUID('all', MENSAGEM_UUID)
  negocioId?: string;

  @ApiPropertyOptional({
    description: 'Telefone a discar. Ausente: o telefone do contato.',
  })
  @IsOptional()
  @Transform(aparar)
  @IsString(MENSAGEM_TEXTO)
  @MaxLength(40, maximo(40))
  telefone?: string;
}

export class QualificacaoTrescDto {
  @ApiProperty() id: number;
  @ApiProperty() nome: string;
  @ApiProperty({ type: String, nullable: true }) cor: string | null;
  @ApiProperty({ type: Boolean, nullable: true }) conversao: boolean | null;
  @ApiProperty({
    type: Boolean,
    description: 'Permite agendar retorno (`agendarPara`).',
  })
  permiteAgendar: boolean;
}

export class QualificarLigacaoDto {
  @ApiProperty({
    description:
      'Id da qualificação (de `GET /tresc-plus/ligacoes/:id/qualificacoes`).',
  })
  @IsInt(MENSAGEM_INTEIRO)
  @Min(1, { message: 'deve ser maior que zero' })
  qualificacaoId: number;

  @ApiPropertyOptional({ description: 'Observação da qualificação.' })
  @IsOptional()
  @Transform(aparar)
  @IsString(MENSAGEM_TEXTO)
  @MaxLength(1000, maximo(1000))
  observacao?: string;

  @ApiPropertyOptional({
    format: 'date-time',
    description: 'Agendamento de retorno (só em qualificação que permite).',
  })
  @IsOptional()
  @IsISO8601({ strict: true }, { message: 'deve ser uma data e hora válidas' })
  agendarPara?: string;

  @ApiPropertyOptional({
    description: 'Telefone do agendamento (padrão: o da ligação).',
  })
  @IsOptional()
  @Transform(aparar)
  @IsString(MENSAGEM_TEXTO)
  @MaxLength(40, maximo(40))
  telefoneDoAgendamento?: string;
}

// ---------------------------------------------------------------------------
// R34.6 — discador
// ---------------------------------------------------------------------------

export class EnviarAoDiscadorDto {
  @ApiProperty({ description: 'Campanha do 3C+.' })
  @IsInt(MENSAGEM_INTEIRO)
  @Min(1, { message: 'deve ser maior que zero' })
  campanhaId: number;

  @ApiPropertyOptional({
    description:
      'Lista existente na campanha. Sem ela, informe `nomeLista` (a lista é criada).',
  })
  @IsOptional()
  @IsInt(MENSAGEM_INTEIRO)
  @Min(1, { message: 'deve ser maior que zero' })
  listaId?: number;

  @ApiPropertyOptional({ description: 'Nome da lista nova.' })
  @IsOptional()
  @Transform(aparar)
  @IsString(MENSAGEM_TEXTO)
  @MaxLength(120, maximo(120))
  nomeLista?: string;

  @ApiPropertyOptional({
    type: [String],
    description: `Negócios a enviar (até ${LIMITE_ENVIO_DISCADOR}); o \`identifier\` é o id do negócio.`,
  })
  @IsOptional()
  @IsArray({ message: 'deve ser uma lista' })
  @ArrayMaxSize(LIMITE_ENVIO_DISCADOR, {
    message: `informe no máximo ${LIMITE_ENVIO_DISCADOR} itens`,
  })
  @IsUUID('all', { each: true, ...MENSAGEM_UUID })
  negocioIds?: string[];

  @ApiPropertyOptional({
    type: [String],
    description: `Contatos a enviar (até ${LIMITE_ENVIO_DISCADOR}); o \`identifier\` é o id do contato.`,
  })
  @IsOptional()
  @IsArray({ message: 'deve ser uma lista' })
  @ArrayMaxSize(LIMITE_ENVIO_DISCADOR, {
    message: `informe no máximo ${LIMITE_ENVIO_DISCADOR} itens`,
  })
  @IsUUID('all', { each: true, ...MENSAGEM_UUID })
  contatoIds?: string[];
}

export class ItemDoRelatorioDto {
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Id do negócio ou do contato.',
  })
  identifier: string | null;
  @ApiProperty({ type: String, nullable: true }) telefone: string | null;
  @ApiProperty({
    description: 'Motivo (em português) de o número não ter sido importado.',
  })
  motivo: string;
}

export class RelatorioDoDiscadorDto {
  @ApiProperty({ format: 'uuid' }) envioId: string;
  @ApiProperty() campanhaId: number;
  @ApiProperty() listaId: number;
  @ApiProperty({ type: String, nullable: true }) listaNome: string | null;
  @ApiProperty({ description: 'Registros enviados ao 3C+.' }) enviados: number;
  @ApiProperty({ description: 'Importados pelo 3C+.' }) importados: number;
  @ApiProperty({
    description:
      'Filtrados pelo 3C+ (DND, ligações recentes, blacklist…) ou que o CRM nem enviou (sem telefone válido).',
  })
  filtrados: number;
  @ApiProperty({ type: [ItemDoRelatorioDto] }) detalhes: ItemDoRelatorioDto[];
}

export class ConsultaDeCampanhaDto {
  @ApiPropertyOptional({
    description:
      'Campanha cujas qualificações listar (padrão: a da ligação, a do agente ou a padrão da empresa).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt(MENSAGEM_INTEIRO)
  @Min(1, { message: 'deve ser maior que zero' })
  @Max(2_000_000_000, { message: 'valor alto demais' })
  campanhaId?: number;
}
