import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  Equals,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { TAMANHO_MAXIMO_EMAIL } from '../../comum/dominio/email';
import {
  TipoMensagem,
  type StatusConversa,
} from '../../generated/prisma/client';
import {
  aparar,
  apararOuNulo,
  CamposComunsDoCanalDto,
  CanalBaseDto,
  lerBooleano,
  maximo,
  MENSAGEM_BOOLEANO,
  MENSAGEM_OBRIGATORIO,
  MENSAGEM_TEXTO,
  MENSAGEM_UUID,
  OpcionalNaoNulo,
} from '../comum/dto-comum';
import {
  CONTATOS_DO_FORMULARIO,
  type ContatoDoFormulario,
  DOMINIOS_POR_CANAL,
  POSICOES_DO_WIDGET,
  type PosicaoDoWidget,
  TEMAS_DO_WIDGET,
  type TemaDoWidget,
} from './configuracao-webchat';

/** Tamanho máximo de uma mensagem do visitante. */
export const TAMANHO_MAXIMO_MENSAGEM_VISITANTE = 4000;
/** Tamanho máximo do nome no formulário inicial. */
export const TAMANHO_MAXIMO_NOME_VISITANTE = 120;
/** Tamanho máximo do token do visitante (base64url de 32 bytes = 43). */
const TAMANHO_MAXIMO_TOKEN = 128;

// ---------------------------------------------------------------------------
// Configuração do canal (Admin)
// ---------------------------------------------------------------------------

export class AparenciaDoWidgetEntradaDto {
  @ApiPropertyOptional({ example: 'Fale com a gente', maxLength: 60 })
  @OpcionalNaoNulo()
  @IsString(MENSAGEM_TEXTO)
  @MaxLength(60, maximo(60))
  titulo?: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'Respondemos em poucos minutos.',
    maxLength: 120,
  })
  @IsOptional()
  @IsString(MENSAGEM_TEXTO)
  @MaxLength(120, maximo(120))
  subtitulo?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'Olá! Como podemos ajudar?',
    maxLength: 500,
  })
  @IsOptional()
  @IsString(MENSAGEM_TEXTO)
  @MaxLength(500, maximo(500))
  saudacao?: string | null;

  @ApiPropertyOptional({ example: '#2563EB', description: 'Cor `#RRGGBB`.' })
  @OpcionalNaoNulo()
  @IsString(MENSAGEM_TEXTO)
  corPrimaria?: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: '#FFFFFF',
    description:
      'Cor do texto sobre a cor principal. `null` (ou mudar só a principal) = preto ou branco, o de mais contraste.',
  })
  @IsOptional()
  @IsString(MENSAGEM_TEXTO)
  corTextoPrimaria?: string | null;

  @ApiPropertyOptional({ enum: TEMAS_DO_WIDGET, default: 'automatico' })
  @OpcionalNaoNulo()
  @IsIn(TEMAS_DO_WIDGET, {
    message: `deve ser um destes valores: ${TEMAS_DO_WIDGET.join(', ')}`,
  })
  tema?: TemaDoWidget;

  @ApiPropertyOptional({ enum: POSICOES_DO_WIDGET, default: 'direita' })
  @OpcionalNaoNulo()
  @IsIn(POSICOES_DO_WIDGET, {
    message: `deve ser um destes valores: ${POSICOES_DO_WIDGET.join(', ')}`,
  })
  posicao?: PosicaoDoWidget;
}

export class CriarCanalWebchatDto extends CamposComunsDoCanalDto {
  @ApiPropertyOptional({
    type: [String],
    example: ['https://www.seusite.com.br', 'https://*.seusite.com.br'],
    description:
      'Sites onde o widget pode rodar (CORS e origem do Socket.IO). Sem esquema, vale `https://`; `*.` vale para os subdomínios. O próprio CRM sempre pode (prévia).',
  })
  @OpcionalNaoNulo()
  @IsArray({ message: 'deve ser uma lista' })
  @ArrayMaxSize(DOMINIOS_POR_CANAL, {
    message: `deve ter no máximo ${DOMINIOS_POR_CANAL} itens`,
  })
  @IsString({ each: true, message: 'cada domínio deve ser um texto' })
  @MaxLength(253, { each: true, message: 'domínio longo demais' })
  dominios?: string[];

  @ApiPropertyOptional({ type: AparenciaDoWidgetEntradaDto })
  @OpcionalNaoNulo()
  @ValidateNested()
  @Type(() => AparenciaDoWidgetEntradaDto)
  aparencia?: AparenciaDoWidgetEntradaDto;

  @ApiPropertyOptional({
    enum: CONTATOS_DO_FORMULARIO,
    default: 'EMAIL_OU_TELEFONE',
    description: 'Meio de contato que o formulário inicial pede, além do nome.',
  })
  @OpcionalNaoNulo()
  @IsIn(CONTATOS_DO_FORMULARIO, {
    message: `deve ser um destes valores: ${CONTATOS_DO_FORMULARIO.join(', ')}`,
  })
  contato?: ContatoDoFormulario;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: 500,
    description:
      'Texto do consentimento (LGPD) que o visitante marca. `null` = texto padrão.',
  })
  @Transform(apararOuNulo)
  @IsOptional()
  @IsString(MENSAGEM_TEXTO)
  @MaxLength(500, maximo(500))
  textoConsentimento?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'https://www.seusite.com.br/privacidade',
  })
  @Transform(apararOuNulo)
  @IsOptional()
  @IsString(MENSAGEM_TEXTO)
  @MaxLength(500, maximo(500))
  urlPrivacidade?: string | null;

  @ApiPropertyOptional({ default: true })
  @OpcionalNaoNulo()
  @IsBoolean(MENSAGEM_BOOLEANO)
  permitirAnexos?: boolean;
}

export class AtualizarCanalWebchatDto extends PartialType(
  CriarCanalWebchatDto,
) {}

export class AparenciaDoWidgetDto {
  @ApiProperty({ example: 'Fale com a gente' })
  titulo: string;

  @ApiProperty({ type: String, nullable: true })
  subtitulo: string | null;

  @ApiProperty({ type: String, nullable: true })
  saudacao: string | null;

  @ApiProperty({ example: '#2563EB' })
  corPrimaria: string;

  @ApiProperty({ example: '#FFFFFF' })
  corTextoPrimaria: string;

  @ApiProperty({ enum: TEMAS_DO_WIDGET })
  tema: TemaDoWidget;

  @ApiProperty({ enum: POSICOES_DO_WIDGET })
  posicao: PosicaoDoWidget;
}

export class InstalacaoDoWidgetDto {
  @ApiProperty({
    example: 'https://crm.brl.com.br/api/v1/publico/webchat/widget.js',
  })
  urlDoWidget: string;

  @ApiProperty({
    example:
      '<script src="https://crm.brl.com.br/api/v1/publico/webchat/widget.js" data-chave="wc_…" async></script>',
    description: 'Cole no site, antes de `</body>`.',
  })
  trecho: string;
}

export class CanalWebchatDto extends CanalBaseDto {
  @ApiProperty({
    example: 'wc_3k9f0QeZb1x7Lm2N8pRt5vW4',
    description: 'Chave pública do widget (vai no trecho de instalação).',
  })
  chavePublica: string;

  @ApiProperty({ type: [String], example: ['https://www.seusite.com.br'] })
  dominios: string[];

  @ApiProperty({ type: AparenciaDoWidgetDto })
  aparencia: AparenciaDoWidgetDto;

  @ApiProperty({ enum: CONTATOS_DO_FORMULARIO })
  contato: ContatoDoFormulario;

  @ApiProperty()
  textoConsentimento: string;

  @ApiProperty({ type: String, nullable: true })
  urlPrivacidade: string | null;

  @ApiProperty()
  permitirAnexos: boolean;

  @ApiProperty({ type: InstalacaoDoWidgetDto })
  instalacao: InstalacaoDoWidgetDto;
}

// ---------------------------------------------------------------------------
// Rotas públicas (widget)
// ---------------------------------------------------------------------------

/** Formulário inicial do widget (`application/x-www-form-urlencoded`). */
export class NovoVisitanteDto {
  @ApiProperty({ example: 'Maria Souza', maxLength: 120 })
  @Transform(aparar)
  @IsString(MENSAGEM_TEXTO)
  @IsNotEmpty(MENSAGEM_OBRIGATORIO)
  @MaxLength(
    TAMANHO_MAXIMO_NOME_VISITANTE,
    maximo(TAMANHO_MAXIMO_NOME_VISITANTE),
  )
  nome: string;

  @ApiPropertyOptional({ example: 'maria@exemplo.com' })
  @Transform(apararOuNulo)
  @IsOptional()
  @IsEmail({}, { message: 'deve ser um e-mail válido' })
  @MaxLength(TAMANHO_MAXIMO_EMAIL, maximo(TAMANHO_MAXIMO_EMAIL))
  email?: string | null;

  @ApiPropertyOptional({ example: '(11) 98765-4321' })
  @Transform(apararOuNulo)
  @IsOptional()
  @IsString(MENSAGEM_TEXTO)
  @MaxLength(40, maximo(40))
  telefone?: string | null;

  @ApiProperty({
    example: true,
    description: 'Consentimento (LGPD): obrigatório (`true`).',
  })
  @Transform(lerBooleano)
  @Equals(true, { message: 'é preciso concordar para iniciar a conversa' })
  consentimento: boolean;

  @ApiPropertyOptional({
    example: 'https://www.seusite.com.br/planos?utm_source=google',
    description:
      'Página em que o chat foi aberto (as UTMs dela vão para o contato).',
  })
  @Transform(apararOuNulo)
  @IsOptional()
  @IsString(MENSAGEM_TEXTO)
  @MaxLength(1000, maximo(1000))
  pagina?: string | null;
}

/** Só o token do visitante (no corpo, nunca na URL). */
export class TokenDoVisitanteDto {
  @ApiProperty({ description: 'Token devolvido ao criar o visitante.' })
  @IsString(MENSAGEM_TEXTO)
  @IsNotEmpty(MENSAGEM_OBRIGATORIO)
  @MaxLength(TAMANHO_MAXIMO_TOKEN, maximo(TAMANHO_MAXIMO_TOKEN))
  token: string;
}

export class MensagemDoVisitanteEntradaDto extends TokenDoVisitanteDto {
  @ApiProperty({ example: 'Oi! Quero saber dos planos.', maxLength: 4000 })
  @Transform(aparar)
  @IsString(MENSAGEM_TEXTO)
  @IsNotEmpty(MENSAGEM_OBRIGATORIO)
  @MaxLength(
    TAMANHO_MAXIMO_MENSAGEM_VISITANTE,
    maximo(TAMANHO_MAXIMO_MENSAGEM_VISITANTE),
  )
  texto: string;

  @ApiPropertyOptional({
    description:
      'Id gerado pelo widget (8 a 64 letras, números, `-` ou `_`): repetir o envio não duplica a mensagem.',
  })
  @IsOptional()
  @Matches(/^[A-Za-z0-9_-]{8,64}$/, {
    message: 'deve ter de 8 a 64 letras, números, - ou _',
  })
  idCliente?: string;
}

/** Campos do multipart do anexo — o `token` precisa vir antes do arquivo. */
export class AnexoDoVisitanteEntradaDto extends TokenDoVisitanteDto {
  @ApiPropertyOptional({ maxLength: 4000, description: 'Legenda (opcional).' })
  @Transform(apararOuNulo)
  @IsOptional()
  @IsString(MENSAGEM_TEXTO)
  @MaxLength(
    TAMANHO_MAXIMO_MENSAGEM_VISITANTE,
    maximo(TAMANHO_MAXIMO_MENSAGEM_VISITANTE),
  )
  texto?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @Matches(/^[A-Za-z0-9_-]{8,64}$/, {
    message: 'deve ter de 8 a 64 letras, números, - ou _',
  })
  idCliente?: string;
}

export class HistoricoDoVisitanteDto extends TokenDoVisitanteDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Mensagens anteriores a esta (paginação para cima).',
  })
  @IsOptional()
  @IsUUID('all', MENSAGEM_UUID)
  antes?: string;
}

/** Query do link assinado de um anexo. */
export class LinkDoArquivoDto {
  @ApiProperty({
    format: 'uuid',
    description: 'Visitante para quem o link foi assinado.',
  })
  @IsUUID('all', MENSAGEM_UUID)
  v: string;

  @ApiProperty({ description: 'Expira em (segundos desde 1970).' })
  @Matches(/^\d{1,12}$/, { message: 'inválido' })
  e: string;

  @ApiProperty({ description: 'Assinatura.' })
  @Matches(/^[0-9a-f]{64}$/, { message: 'inválida' })
  a: string;
}

export class HorarioPublicoDto {
  @ApiProperty({ description: 'Atende agora?' })
  aberto: boolean;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Fechado: quando abre de novo.',
  })
  proximaAbertura: string | null;
}

export class LimitesDoWidgetDto {
  @ApiProperty({ example: 4000 })
  tamanhoMaximoTexto: number;

  @ApiProperty({ example: 10485760, description: 'Em bytes.' })
  tamanhoMaximoAnexo: number;
}

/** O que o widget precisa para se desenhar (público). */
export class ConfiguracaoPublicaDto {
  @ApiProperty({ example: 'Site institucional' })
  nome: string;

  @ApiProperty({ type: AparenciaDoWidgetDto })
  aparencia: AparenciaDoWidgetDto;

  @ApiProperty({ enum: CONTATOS_DO_FORMULARIO })
  contato: ContatoDoFormulario;

  @ApiProperty()
  textoConsentimento: string;

  @ApiProperty({ type: String, nullable: true })
  urlPrivacidade: string | null;

  @ApiProperty()
  permitirAnexos: boolean;

  @ApiProperty({ type: HorarioPublicoDto })
  horario: HorarioPublicoDto;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Mostrada no widget quando o canal está fora do horário.',
  })
  mensagemForaHorario: string | null;

  @ApiProperty({ type: LimitesDoWidgetDto })
  limites: LimitesDoWidgetDto;
}

export class VisitanteCriadoDto {
  @ApiProperty({
    description:
      'Token anônimo do visitante: o widget guarda no navegador e manda nas próximas chamadas.',
  })
  token: string;

  @ApiProperty({ format: 'uuid' })
  visitanteId: string;

  @ApiProperty({ format: 'date-time' })
  expiraEm: string;
}

export class ArquivoPublicoDto {
  @ApiProperty({ example: 'foto.jpg' })
  nome: string;

  @ApiProperty({ example: 'image/jpeg' })
  mime: string;

  @ApiProperty({ example: 182044 })
  tamanho: number;

  @ApiProperty({
    description:
      'Caminho do download assinado, relativo ao endereço da API (vale por 24 h).',
    example: '/api/v1/publico/webchat/wc_…/arquivos/6f1c…?v=…&e=1761264000&a=…',
  })
  url: string;
}

export class AutorPublicoDto {
  @ApiProperty({ example: 'Ana' })
  nome: string;
}

/** Uma mensagem como o visitante vê. */
export class BotaoPublicoDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ example: 'Quero saber os preços' })
  rotulo: string;
}

export class MensagemPublicaDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({
    enum: ['visitante', 'equipe'],
    description: 'Quem escreveu.',
  })
  de: 'visitante' | 'equipe';

  @ApiProperty({ enum: TipoMensagem, enumName: 'TipoMensagem' })
  tipo: TipoMensagem;

  @ApiProperty({ type: String, nullable: true })
  texto: string | null;

  @ApiProperty({
    type: [BotaoPublicoDto],
    nullable: true,
    description:
      'Opções de resposta rápida das perguntas do chatbot (o widget as mostra como botões que respondem com o rótulo).',
  })
  botoes: BotaoPublicoDto[] | null;

  @ApiProperty({ type: ArquivoPublicoDto, nullable: true })
  arquivo: ArquivoPublicoDto | null;

  @ApiProperty({
    type: AutorPublicoDto,
    nullable: true,
    description: 'Primeiro nome de quem respondeu (nulo nas automáticas).',
  })
  autor: AutorPublicoDto | null;

  @ApiProperty({ format: 'date-time' })
  em: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'O `idCliente` enviado pelo widget (mensagens do visitante).',
  })
  idCliente: string | null;
}

export class ConversaPublicaDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ enum: ['ABERTA', 'PENDENTE', 'RESOLVIDA'] })
  status: StatusConversa;
}

export class SessaoDoVisitanteDto {
  @ApiProperty({ format: 'uuid' })
  visitanteId: string;

  @ApiProperty({ format: 'date-time' })
  expiraEm: string;

  @ApiProperty({ type: ConversaPublicaDto, nullable: true })
  conversa: ConversaPublicaDto | null;

  @ApiProperty({
    type: [MensagemPublicaDto],
    description: 'As últimas mensagens, da mais antiga para a mais nova.',
  })
  mensagens: MensagemPublicaDto[];

  @ApiProperty({ description: 'Há mensagens anteriores (use `historico`).' })
  haMais: boolean;
}

export class HistoricoPublicoDto {
  @ApiProperty({ type: [MensagemPublicaDto] })
  mensagens: MensagemPublicaDto[];

  @ApiProperty()
  haMais: boolean;
}

export class MensagemEnviadaDto {
  @ApiProperty({ type: MensagemPublicaDto })
  mensagem: MensagemPublicaDto;
}
