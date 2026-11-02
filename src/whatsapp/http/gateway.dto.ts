import { Type } from 'class-transformer';
import {
  IsBase64,
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { TipoMensagem } from '../../generated/prisma/client';

/** `POST /numeros/:id/desconectar`. */
export class DesconectarNoGatewayDto {
  /** Logout: o celular desvincula o aparelho e as chaves são apagadas. */
  @IsOptional()
  @IsBoolean({ message: 'deve ser verdadeiro ou falso' })
  sair?: boolean;
}

/** `POST /numeros/:id/verificar`. */
export class VerificarNumeroNoGatewayDto {
  @IsString({ message: 'deve ser um texto' })
  @IsNotEmpty({ message: 'é obrigatório' })
  @MaxLength(30, { message: 'deve ter no máximo 30 caracteres' })
  telefone: string;
}

/** `POST /numeros/:id/digitando`. */
export class DigitandoNoGatewayDto {
  /** JID do contato (`…@s.whatsapp.net` ou `…@lid`). */
  @IsString({ message: 'deve ser um texto' })
  @MaxLength(80, { message: 'deve ter no máximo 80 caracteres' })
  @Matches(/^[0-9]{5,20}(:[0-9]+)?@(s\.whatsapp\.net|lid)$/, {
    message: 'deve ser o endereço de um contato do WhatsApp',
  })
  para: string;

  @IsBoolean({ message: 'deve ser verdadeiro ou falso' })
  ativo: boolean;
}

export class MidiaDoSimuladorDto {
  /** Conteúdo em base64 (até ~25 MB depois de decodificado). */
  @IsBase64({}, { message: 'deve estar em base64' })
  base64: string;

  @IsString({ message: 'deve ser um texto' })
  @IsNotEmpty({ message: 'é obrigatório' })
  @MaxLength(200, { message: 'deve ter no máximo 200 caracteres' })
  nome: string;

  @IsString({ message: 'deve ser um texto' })
  @IsNotEmpty({ message: 'é obrigatório' })
  @MaxLength(120, { message: 'deve ter no máximo 120 caracteres' })
  mime: string;
}

/** `POST /simulador/receber` (só no modo simulado). */
export class EntradaDoSimuladorDto {
  @IsUUID('all', { message: 'deve ser um id válido' })
  numeroId: string;

  /** Telefone de quem "manda" (qualquer formato). */
  @IsString({ message: 'deve ser um texto' })
  @IsNotEmpty({ message: 'é obrigatório' })
  @MaxLength(30, { message: 'deve ter no máximo 30 caracteres' })
  de: string;

  @IsOptional()
  @IsString({ message: 'deve ser um texto' })
  @MaxLength(120, { message: 'deve ter no máximo 120 caracteres' })
  nome?: string;

  /** Padrão: TEXTO, ou o tipo da mídia. */
  @IsOptional()
  @IsEnum(TipoMensagem, { message: 'deve ser um tipo de mensagem válido' })
  tipo?: TipoMensagem;

  @IsOptional()
  @IsString({ message: 'deve ser um texto' })
  @MaxLength(4096, { message: 'deve ter no máximo 4096 caracteres' })
  texto?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => MidiaDoSimuladorDto)
  midia?: MidiaDoSimuladorDto;

  /** Id externo da mensagem citada. */
  @IsOptional()
  @IsString({ message: 'deve ser um texto' })
  @MaxLength(128, { message: 'deve ter no máximo 128 caracteres' })
  respondeA?: string;
}
