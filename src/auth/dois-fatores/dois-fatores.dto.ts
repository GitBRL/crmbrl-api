import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { TAMANHO_MAXIMO_SENHA } from '../../comum/criptografia/criptografia.service';

export class CodigoDto {
  @ApiProperty({
    example: '123456',
    description: 'Código de 6 dígitos do aplicativo.',
  })
  @IsString({ message: 'deve ser um texto' })
  @IsNotEmpty({ message: 'é obrigatório' })
  @MaxLength(32, { message: 'deve ter no máximo 32 caracteres' })
  codigo: string;
}

export class DesativarDoisFatoresDto extends CodigoDto {
  @ApiProperty({ format: 'password', description: 'A senha atual.' })
  @IsString({ message: 'deve ser um texto' })
  @IsNotEmpty({ message: 'é obrigatória' })
  @MaxLength(TAMANHO_MAXIMO_SENHA, {
    message: `deve ter no máximo ${TAMANHO_MAXIMO_SENHA} caracteres`,
  })
  senha: string;
}

export class AtivacaoDoisFatoresDto {
  @ApiProperty({
    example: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
    description: 'A chave em base32, para digitar no aplicativo.',
  })
  chave: string;

  @ApiProperty({ description: 'QR code como data URL (PNG).' })
  qrCode: string;

  @ApiProperty({ description: 'Endereço `otpauth://` que o QR contém.' })
  urlOtpauth: string;
}

export class CodigosRecuperacaoDto {
  @ApiProperty({
    type: String,
    isArray: true,
    example: ['K7M2P-9QXWA'],
    description:
      'Dez códigos de uso único, mostrados só esta vez (a API guarda apenas o HMAC deles).',
  })
  codigos: string[];
}

export class SituacaoDoisFatoresDto {
  @ApiProperty()
  ativo: boolean;

  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  ativadoEm: string | null;

  @ApiProperty({ description: 'Códigos de recuperação ainda não usados.' })
  codigosRestantes: number;
}
