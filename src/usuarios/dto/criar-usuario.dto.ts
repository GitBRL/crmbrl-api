import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';
import {
  TAMANHO_MAXIMO_SENHA,
  TAMANHO_MINIMO_SENHA,
} from '../../comum/criptografia/criptografia.service';
import { TAMANHO_MAXIMO_EMAIL } from '../../comum/dominio/email';
import { TODOS_OS_PAPEIS } from '../../comum/dominio/papeis';
import type { Area } from '../../comum/dominio/setores';
import { ChaveDeSetor } from '../../comum/validacao/setor';
import { Papel } from '../../generated/prisma/client';
import { aparar, emailNormalizado, idEmMinusculas } from './transformacoes';

export const TAMANHO_MAXIMO_NOME = 200;
export const TAMANHO_MAXIMO_URL = 2_000;
export const MENSAGEM_PAPEL = `deve ser um destes valores: ${TODOS_OS_PAPEIS.join(', ')}`;
export const MENSAGEM_UUID = 'deve ser um identificador (UUID) válido';
export const MENSAGEM_TAMANHO_SENHA = `deve ter de ${TAMANHO_MINIMO_SENHA} a ${TAMANHO_MAXIMO_SENHA} caracteres`;

export class CriarUsuarioDto {
  @ApiProperty({ example: 'Ana Souza', maxLength: TAMANHO_MAXIMO_NOME })
  @Transform(aparar)
  @IsString({ message: 'deve ser um texto' })
  @IsNotEmpty({ message: 'é obrigatório' })
  @MaxLength(TAMANHO_MAXIMO_NOME, {
    message: `deve ter no máximo ${TAMANHO_MAXIMO_NOME} caracteres`,
  })
  nome: string;

  @ApiProperty({
    example: 'ana@brl.com.br',
    description:
      'Único, sem diferença de maiúsculas; gravado aparado e em minúsculas (R1.1).',
  })
  @Transform(emailNormalizado)
  @IsEmail({}, { message: 'deve ser um e-mail válido' })
  @MaxLength(TAMANHO_MAXIMO_EMAIL, {
    message: `deve ter no máximo ${TAMANHO_MAXIMO_EMAIL} caracteres`,
  })
  email: string;

  @ApiProperty({
    enum: Papel,
    enumName: 'Papel',
    description:
      'O nível: `ADMIN`, `C_LEVEL`, `LIDER` ou `MEMBRO`. O setor vai em `area` (R1).',
  })
  @IsEnum(Papel, { message: MENSAGEM_PAPEL })
  papel: Papel;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'COMERCIAL',
    description:
      'Setor da pessoa (chave, `GET /setores`): obrigatório para Líder e Membro, e precisa estar ativo (R1.9); ' +
      'Admin e C-level não têm setor (R1.2: ignorado, fica nulo).',
  })
  @IsOptional()
  @ChaveDeSetor()
  area?: Area | null;

  @ApiPropertyOptional({
    format: 'uuid',
    nullable: true,
    description:
      'Obrigatório para membro (um líder ativo do mesmo setor) e para líder (um C-level ativo); ' +
      'Admin e C-level não têm líder (R1.2).',
  })
  @IsOptional()
  @Transform(idEmMinusculas)
  @IsUUID('all', { message: MENSAGEM_UUID })
  liderId?: string | null;

  @ApiPropertyOptional({
    example: 'ana.vendas',
    nullable: true,
    maxLength: 100,
    description:
      'Identificador do usuário nas integrações (R32.4): o que ferramentas como ActiveCampaign, ManyChat e Typeform mandam no lugar do e-mail para definir o dono do negócio. Opcional e único (sem diferenciar maiúsculas); letras, números e . _ - @ + :. `null` ou vazio apaga.',
  })
  @IsOptional()
  @Transform(aparar)
  @IsString({ message: 'deve ser um texto' })
  @MaxLength(100, { message: 'deve ter no máximo 100 caracteres' })
  @Matches(/^[A-Za-z0-9._@+:-]*$/, {
    message: 'use só letras, números e . _ - @ + :',
  })
  identificadorIntegracao?: string | null;

  @ApiPropertyOptional({
    example: '(11) 98765-4321',
    nullable: true,
    description: 'Gravado em E.164 só com dígitos.',
  })
  @IsOptional()
  @IsString({ message: 'deve ser um texto' })
  @MaxLength(30, { message: 'deve ter no máximo 30 caracteres' })
  telefone?: string | null;

  @ApiPropertyOptional({
    example: 'https://arquivos.brl.com.br/avatares/ana.png',
    nullable: true,
  })
  @IsOptional()
  @IsUrl(
    { protocols: ['http', 'https'], require_protocol: true },
    { message: 'deve ser um endereço (URL) http ou https' },
  )
  @MaxLength(TAMANHO_MAXIMO_URL, {
    message: `deve ter no máximo ${TAMANHO_MAXIMO_URL} caracteres`,
  })
  avatarUrl?: string | null;

  @ApiPropertyOptional({
    format: 'password',
    minLength: TAMANHO_MINIMO_SENHA,
    maxLength: TAMANHO_MAXIMO_SENHA,
    description:
      'Senha temporária: o usuário troca no primeiro acesso. Sem ela, a API envia o convite por e-mail, ' +
      'o que exige SMTP configurado (R2.8).',
  })
  @IsOptional()
  @IsString({ message: 'deve ser um texto' })
  @Length(TAMANHO_MINIMO_SENHA, TAMANHO_MAXIMO_SENHA, {
    message: MENSAGEM_TAMANHO_SENHA,
  })
  senhaTemporaria?: string;
}
