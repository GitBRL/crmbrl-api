import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsNotEmpty,
  IsString,
  Length,
  MaxLength,
} from 'class-validator';
import {
  TAMANHO_MAXIMO_SENHA,
  TAMANHO_MINIMO_SENHA,
} from '../../comum/criptografia/criptografia.service';
import type { Escopo } from '../../comum/dominio/permissoes';
import { Papel, TipoTokenSenha } from '../../generated/prisma/client';
import type { Area } from '../../comum/dominio/setores';

const MENSAGEM_TAMANHO_SENHA = `deve ter de ${TAMANHO_MINIMO_SENHA} a ${TAMANHO_MAXIMO_SENHA} caracteres`;

export class EntrarDto {
  @ApiProperty({ example: 'admin@brl.com.br' })
  @IsString({ message: 'deve ser um texto' })
  @IsNotEmpty({ message: 'é obrigatório' })
  @MaxLength(320, { message: 'deve ter no máximo 320 caracteres' })
  email: string;

  @ApiProperty({ example: 'minha senha secreta', format: 'password' })
  @IsString({ message: 'deve ser um texto' })
  @IsNotEmpty({ message: 'é obrigatória' })
  @MaxLength(TAMANHO_MAXIMO_SENHA, {
    message: `deve ter no máximo ${TAMANHO_MAXIMO_SENHA} caracteres`,
  })
  senha: string;
}

export class TrocarSenhaDto {
  @ApiProperty({ format: 'password' })
  @IsString({ message: 'deve ser um texto' })
  @IsNotEmpty({ message: 'é obrigatória' })
  @MaxLength(TAMANHO_MAXIMO_SENHA, {
    message: `deve ter no máximo ${TAMANHO_MAXIMO_SENHA} caracteres`,
  })
  senhaAtual: string;

  @ApiProperty({
    format: 'password',
    minLength: TAMANHO_MINIMO_SENHA,
    maxLength: TAMANHO_MAXIMO_SENHA,
    description: 'De 8 a 128 caracteres (R2.1).',
  })
  @IsString({ message: 'deve ser um texto' })
  @Length(TAMANHO_MINIMO_SENHA, TAMANHO_MAXIMO_SENHA, {
    message: MENSAGEM_TAMANHO_SENHA,
  })
  novaSenha: string;
}

export class EsqueciSenhaDto {
  @ApiProperty({ example: 'fulano@brl.com.br' })
  @IsEmail({}, { message: 'deve ser um e-mail válido' })
  @MaxLength(320, { message: 'deve ter no máximo 320 caracteres' })
  email: string;
}

export class TokenDeSenhaDto {
  @ApiProperty({
    description: 'Token recebido por e-mail (convite ou redefinição).',
  })
  @IsString({ message: 'deve ser um texto' })
  @IsNotEmpty({ message: 'é obrigatório' })
  @MaxLength(200, { message: 'deve ter no máximo 200 caracteres' })
  token: string;
}

export class RedefinirSenhaDto extends TokenDeSenhaDto {
  @ApiProperty({
    format: 'password',
    minLength: TAMANHO_MINIMO_SENHA,
    maxLength: TAMANHO_MAXIMO_SENHA,
  })
  @IsString({ message: 'deve ser um texto' })
  @Length(TAMANHO_MINIMO_SENHA, TAMANHO_MAXIMO_SENHA, {
    message: MENSAGEM_TAMANHO_SENHA,
  })
  novaSenha: string;
}

export class ConsultaTokenDto {
  @ApiProperty({ description: 'O token ainda pode ser usado.' })
  valido: boolean;

  @ApiPropertyOptional({ enum: TipoTokenSenha, enumName: 'TipoTokenSenha' })
  tipo?: TipoTokenSenha;

  @ApiPropertyOptional({ example: 'Fulano de Tal' })
  nome?: string;

  @ApiPropertyOptional({ example: 'fulano@brl.com.br' })
  email?: string;

  @ApiPropertyOptional({ format: 'date-time' })
  expiraEm?: string;
}

export class MensagemDto {
  @ApiProperty({
    example:
      'Se o e-mail estiver cadastrado, enviaremos um link para redefinir a senha.',
  })
  mensagem: string;
}

export class LiderResumoDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  nome: string;

  @ApiProperty({ enum: Papel, enumName: 'Papel' })
  papel: Papel;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Setor do líder (chave); nulo para C-level.',
  })
  area: Area | null;
}

export class UsuarioDoPerfilDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  nome: string;

  @ApiProperty()
  email: string;

  @ApiProperty({ enum: Papel, enumName: 'Papel' })
  papel: Papel;

  @ApiProperty({
    example: 'Líder Comercial',
    description:
      'Admin, C-level, "Líder " + nome do setor, ou o nome do setor (membro).',
  })
  rotuloPapel: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'COMERCIAL',
    description: 'Setor (chave); nulo para Admin e C-level.',
  })
  area: Area | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'Comercial',
    description: 'Nome do setor; nulo para Admin e C-level.',
  })
  nomeSetor: string | null;

  @ApiProperty({ enum: ['ADMINISTRADOR', 'DIRETORIA', 'LIDER', 'MEMBRO'] })
  nivel: 'ADMINISTRADOR' | 'DIRETORIA' | 'LIDER' | 'MEMBRO';

  @ApiPropertyOptional({ type: LiderResumoDto, nullable: true })
  lider: LiderResumoDto | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  avatarUrl: string | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  telefone: string | null;

  @ApiPropertyOptional({ nullable: true, type: String, format: 'date-time' })
  ultimoAcessoEm: string | null;
}

const ESCOPOS: Escopo[] = ['TODOS', 'AREA', 'EQUIPE', 'PROPRIOS', 'NENHUM'];

/** Permissões derivadas do papel (matriz de acesso, seção 12 das regras). */
export class PermissoesDto {
  @ApiProperty() gerenciarUsuarios: boolean;
  @ApiProperty({ enum: ESCOPOS }) verUsuarios: Escopo;
  @ApiProperty({ enum: ESCOPOS }) configurarFunis: Escopo;
  @ApiProperty({
    enum: ESCOPOS,
    description: 'PROPRIOS = os seus e os sem responsável da área (R5.9).',
  })
  verNegocios: Escopo;
  @ApiProperty({ enum: ESCOPOS }) reabrirNegocios: Escopo;
  @ApiProperty() verContatos: boolean;
  @ApiProperty({ enum: ESCOPOS }) editarContatos: Escopo;
  @ApiProperty() importarContatos: boolean;
  @ApiProperty() anonimizarContatos: boolean;
  @ApiProperty({ enum: ESCOPOS }) verAtividades: Escopo;
  @ApiProperty() configurarPassagens: boolean;
  @ApiProperty({ enum: ESCOPOS }) configurarRodizio: Escopo;
  @ApiProperty() gerenciarWebhooks: boolean;
  @ApiProperty() verAuditoria: boolean;
  @ApiProperty() verLogsTecnicos: boolean;
  @ApiProperty() verDocumentacaoApi: boolean;
  @ApiProperty({
    type: String,
    isArray: true,
    example: ['COMERCIAL'],
    description:
      'Setores (chaves) cujos funis a pessoa vê: Admin e C-level, todos os ativos; Líder e Membro, o seu (R5.9).',
  })
  areasVisiveis: Area[];
}

export class SessaoDoPerfilDto {
  @ApiProperty({ format: 'date-time' })
  criadaEm: string;

  @ApiProperty({
    format: 'date-time',
    description: 'Renovada com o uso (R2.2).',
  })
  expiraEm: string;
}

/** Resposta de `auth/entrar`, `auth/eu` e `auth/senha`. */
export class PerfilDto {
  @ApiProperty({ type: UsuarioDoPerfilDto })
  usuario: UsuarioDoPerfilDto;

  @ApiProperty({
    description:
      'Com troca pendente, só auth/eu, auth/senha e auth/sair funcionam (R2.7).',
  })
  deveTrocarSenha: boolean;

  @ApiProperty({ type: PermissoesDto })
  permissoes: PermissoesDto;

  @ApiProperty({ type: SessaoDoPerfilDto })
  sessao: SessaoDoPerfilDto;
}
