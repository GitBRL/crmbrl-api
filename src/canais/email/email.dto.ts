import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  aparar,
  apararOuNulo,
  CamposComunsDoCanalDto,
  CanalBaseDto,
  maximo,
  MENSAGEM_BOOLEANO,
  MENSAGEM_OBRIGATORIO,
  MENSAGEM_TEXTO,
  OpcionalNaoNulo,
} from '../comum/dto-comum';
import { SEGURANCAS_SMTP, type SegurancaSmtp } from './configuracao-email';

const MENSAGEM_PORTA = { message: 'deve ser uma porta de 1 a 65535' };
const MENSAGEM_EMAIL = { message: 'deve ser um e-mail válido' };

class ServidorEntradaDto {
  @ApiPropertyOptional({ example: 'imap.gmail.com', maxLength: 253 })
  @Transform(aparar)
  @OpcionalNaoNulo()
  @IsString(MENSAGEM_TEXTO)
  @IsNotEmpty(MENSAGEM_OBRIGATORIO)
  @MaxLength(253, maximo(253))
  host?: string;

  @ApiPropertyOptional({ example: 993 })
  @OpcionalNaoNulo()
  @IsInt(MENSAGEM_PORTA)
  @Min(1, MENSAGEM_PORTA)
  @Max(65535, MENSAGEM_PORTA)
  porta?: number;

  @ApiPropertyOptional({
    example: 'atendimento@empresa.com.br',
    description: 'Usuário do login (padrão: o endereço do canal).',
  })
  @Transform(aparar)
  @OpcionalNaoNulo()
  @IsString(MENSAGEM_TEXTO)
  @IsNotEmpty(MENSAGEM_OBRIGATORIO)
  @MaxLength(254, maximo(254))
  usuario?: string;
}

export class ImapEntradaDto extends ServidorEntradaDto {
  @ApiPropertyOptional({
    default: true,
    description: 'TLS desde a conexão (IMAPS, 993). `false` = porta 143.',
  })
  @OpcionalNaoNulo()
  @IsBoolean(MENSAGEM_BOOLEANO)
  tls?: boolean;

  @ApiPropertyOptional({ default: 'INBOX', maxLength: 200 })
  @Transform(aparar)
  @OpcionalNaoNulo()
  @IsString(MENSAGEM_TEXTO)
  @IsNotEmpty(MENSAGEM_OBRIGATORIO)
  @MaxLength(200, maximo(200))
  pasta?: string;
}

export class SmtpEntradaDto extends ServidorEntradaDto {
  @ApiPropertyOptional({
    enum: SEGURANCAS_SMTP,
    default: 'TLS',
    description: 'TLS (465), STARTTLS (587) ou NENHUMA (25, só rede interna).',
  })
  @OpcionalNaoNulo()
  @IsIn(SEGURANCAS_SMTP, {
    message: `deve ser um destes valores: ${SEGURANCAS_SMTP.join(', ')}`,
  })
  seguranca?: SegurancaSmtp;
}

/** Os campos de conexão (criação, edição e teste). */
export class ConexaoEmailEntradaDto {
  @ApiProperty({
    example: 'atendimento@empresa.com.br',
    description:
      'Endereço da caixa: remetente das respostas (único entre os canais de e-mail).',
  })
  @Transform(aparar)
  @IsEmail({}, MENSAGEM_EMAIL)
  @MaxLength(254, maximo(254))
  endereco: string;

  @ApiPropertyOptional({ type: ImapEntradaDto })
  @OpcionalNaoNulo()
  @ValidateNested()
  @Type(() => ImapEntradaDto)
  imap?: ImapEntradaDto;

  @ApiPropertyOptional({
    type: SmtpEntradaDto,
    description: 'Sem host, usa o do IMAP; sem usuário, o do IMAP.',
  })
  @OpcionalNaoNulo()
  @ValidateNested()
  @Type(() => SmtpEntradaDto)
  smtp?: SmtpEntradaDto;

  @ApiPropertyOptional({
    description:
      'Senha da caixa (IMAP; também do SMTP, se `senhaSmtp` não vier). Gravada cifrada; nunca volta na resposta. Na edição, ausente = mantém.',
    maxLength: 500,
  })
  @OpcionalNaoNulo()
  @IsString(MENSAGEM_TEXTO)
  @IsNotEmpty(MENSAGEM_OBRIGATORIO)
  @MaxLength(500, maximo(500))
  senha?: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Senha só do SMTP. `null` = usa a do IMAP.',
    maxLength: 500,
  })
  @IsOptional()
  @IsString(MENSAGEM_TEXTO)
  @MaxLength(500, maximo(500))
  senhaSmtp?: string | null;

  @ApiPropertyOptional({
    default: false,
    description: 'Aceita certificado TLS autoassinado (servidor interno).',
  })
  @OpcionalNaoNulo()
  @IsBoolean(MENSAGEM_BOOLEANO)
  ignorarCertificado?: boolean;
}

export class CriarCanalEmailDto extends CamposComunsDoCanalDto {
  @ApiProperty({ example: 'atendimento@empresa.com.br' })
  @Transform(aparar)
  @IsEmail({}, MENSAGEM_EMAIL)
  @MaxLength(254, maximo(254))
  endereco: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'Atendimento BRL',
    maxLength: 120,
  })
  @Transform(apararOuNulo)
  @IsOptional()
  @IsString(MENSAGEM_TEXTO)
  @MaxLength(120, maximo(120))
  nomeRemetente?: string | null;

  @ApiProperty({ type: ImapEntradaDto })
  @ValidateNested()
  @Type(() => ImapEntradaDto)
  imap: ImapEntradaDto;

  @ApiPropertyOptional({ type: SmtpEntradaDto })
  @OpcionalNaoNulo()
  @ValidateNested()
  @Type(() => SmtpEntradaDto)
  smtp?: SmtpEntradaDto;

  @ApiProperty({ description: 'Senha da caixa (cifrada).', maxLength: 500 })
  @IsString(MENSAGEM_TEXTO)
  @IsNotEmpty(MENSAGEM_OBRIGATORIO)
  @MaxLength(500, maximo(500))
  senha: string;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 500 })
  @IsOptional()
  @IsString(MENSAGEM_TEXTO)
  @MaxLength(500, maximo(500))
  senhaSmtp?: string | null;

  @ApiPropertyOptional({ default: false })
  @OpcionalNaoNulo()
  @IsBoolean(MENSAGEM_BOOLEANO)
  ignorarCertificado?: boolean;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: 1000,
    description: 'Assinatura (texto) acrescentada às respostas.',
  })
  @Transform(apararOuNulo)
  @IsOptional()
  @IsString(MENSAGEM_TEXTO)
  @MaxLength(1000, maximo(1000))
  assinatura?: string | null;
}

export class AtualizarCanalEmailDto extends PartialType(CriarCanalEmailDto) {}

/** Teste de um canal salvo: os campos que vierem substituem os gravados (sem gravar). */
export class TestarCanalEmailDto extends PartialType(ConexaoEmailEntradaDto) {}

export class ServidorImapDto {
  @ApiProperty({ example: 'imap.gmail.com' })
  host: string;

  @ApiProperty({ example: 993 })
  porta: number;

  @ApiProperty()
  tls: boolean;

  @ApiProperty({ example: 'atendimento@empresa.com.br' })
  usuario: string;

  @ApiProperty({ example: 'INBOX' })
  pasta: string;
}

export class ServidorSmtpDto {
  @ApiProperty({ example: 'smtp.gmail.com' })
  host: string;

  @ApiProperty({ example: 465 })
  porta: number;

  @ApiProperty({ enum: SEGURANCAS_SMTP })
  seguranca: SegurancaSmtp;

  @ApiProperty({ example: 'atendimento@empresa.com.br' })
  usuario: string;
}

export class CanalEmailDto extends CanalBaseDto {
  @ApiProperty({ example: 'atendimento@empresa.com.br' })
  endereco: string;

  @ApiProperty({ type: String, nullable: true })
  nomeRemetente: string | null;

  @ApiProperty({ type: ServidorImapDto })
  imap: ServidorImapDto;

  @ApiProperty({ type: ServidorSmtpDto })
  smtp: ServidorSmtpDto;

  @ApiProperty()
  ignorarCertificado: boolean;

  @ApiProperty({ type: String, nullable: true })
  assinatura: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '••••••••3f9a',
    description: 'A senha gravada, mascarada.',
  })
  senha: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Senha própria do SMTP, mascarada (`null` = usa a do IMAP).',
  })
  senhaSmtp: string | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Última leitura da caixa com sucesso.',
  })
  ultimaVarreduraEm: string | null;
}

export class ResultadoDoTesteDto {
  @ApiProperty()
  ok: boolean;

  @ApiProperty({ example: 'Conectado.' })
  mensagem: string;
}

export class TesteDeConexaoEmailDto {
  @ApiProperty({ type: ResultadoDoTesteDto })
  imap: ResultadoDoTesteDto;

  @ApiProperty({ type: ResultadoDoTesteDto })
  smtp: ResultadoDoTesteDto;
}
