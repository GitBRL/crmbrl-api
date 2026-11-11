import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { TAMANHO_MAXIMO_EMAIL } from '../../comum/dominio/email';
import type { Area } from '../../comum/dominio/setores';
import { ChaveDeSetor } from '../../comum/validacao/setor';
import { Papel } from '../../generated/prisma/client';
import {
  MENSAGEM_PAPEL,
  MENSAGEM_UUID,
  TAMANHO_MAXIMO_NOME,
  TAMANHO_MAXIMO_URL,
} from './criar-usuario.dto';
import { aparar, emailNormalizado, idEmMinusculas } from './transformacoes';

/** Presente no corpo (mesmo que `null`, que então é recusado). */
const informado = (_objeto: object, valor: unknown): boolean =>
  valor !== undefined;

/**
 * Edição de um usuário pelo Admin (R1.5). Só os campos enviados mudam. Mudar o
 * papel, o setor ou o líder revalida a hierarquia (R1.2, R1.3); desligar e
 * reativar têm rotas próprias.
 */
export class AtualizarUsuarioDto {
  @ApiPropertyOptional({ example: 'Ana Souza', maxLength: TAMANHO_MAXIMO_NOME })
  @ValidateIf(informado)
  @Transform(aparar)
  @IsString({ message: 'deve ser um texto' })
  @IsNotEmpty({ message: 'é obrigatório' })
  @MaxLength(TAMANHO_MAXIMO_NOME, {
    message: `deve ter no máximo ${TAMANHO_MAXIMO_NOME} caracteres`,
  })
  nome?: string;

  @ApiPropertyOptional({
    example: 'ana@brl.com.br',
    description: 'Gravado aparado e em minúsculas (R1.1).',
  })
  @ValidateIf(informado)
  @Transform(emailNormalizado)
  @IsEmail({}, { message: 'deve ser um e-mail válido' })
  @MaxLength(TAMANHO_MAXIMO_EMAIL, {
    message: `deve ter no máximo ${TAMANHO_MAXIMO_EMAIL} caracteres`,
  })
  email?: string;

  @ApiPropertyOptional({
    enum: Papel,
    enumName: 'Papel',
    description:
      'Revalida a hierarquia (R1.3). Para Admin e C-level o líder e o setor são retirados; o último Admin ativo não é rebaixado (R1.4).',
  })
  @ValidateIf(informado)
  @IsEnum(Papel, { message: MENSAGEM_PAPEL })
  papel?: Papel;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'COMERCIAL',
    description:
      'Setor (chave): obrigatório quando o papel é Líder ou Membro; mudar revalida a hierarquia (R1.2, R1.3) ' +
      'e o novo setor precisa estar ativo (R1.9). Ignorado (fica nulo) para Admin e C-level.',
  })
  @IsOptional()
  @ChaveDeSetor()
  area?: Area | null;

  @ApiPropertyOptional({
    format: 'uuid',
    nullable: true,
    description: '`null` retira o líder (só para Admin e C-level, R1.2).',
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
    description: '`null` apaga.',
  })
  @IsOptional()
  @IsString({ message: 'deve ser um texto' })
  @MaxLength(30, { message: 'deve ter no máximo 30 caracteres' })
  telefone?: string | null;

  @ApiPropertyOptional({ nullable: true, description: '`null` apaga.' })
  @IsOptional()
  @IsUrl(
    { protocols: ['http', 'https'], require_protocol: true },
    { message: 'deve ser um endereço (URL) http ou https' },
  )
  @MaxLength(TAMANHO_MAXIMO_URL, {
    message: `deve ter no máximo ${TAMANHO_MAXIMO_URL} caracteres`,
  })
  avatarUrl?: string | null;
}
