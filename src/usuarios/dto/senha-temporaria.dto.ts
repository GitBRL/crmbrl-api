import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';
import {
  TAMANHO_MAXIMO_SENHA,
  TAMANHO_MINIMO_SENHA,
} from '../../comum/criptografia/criptografia.service';
import { MENSAGEM_TAMANHO_SENHA } from './criar-usuario.dto';
import { SenhaNaoComum } from '../../auth/senhas-comuns';

/** Senha temporária definida pelo Admin (R2.8). */
export class DefinirSenhaTemporariaDto {
  @ApiProperty({
    format: 'password',
    minLength: TAMANHO_MINIMO_SENHA,
    maxLength: TAMANHO_MAXIMO_SENHA,
    description:
      'O usuário é obrigado a trocá-la no próximo acesso; as sessões dele são encerradas.',
  })
  @IsString({ message: 'deve ser um texto' })
  @Length(TAMANHO_MINIMO_SENHA, TAMANHO_MAXIMO_SENHA, {
    message: MENSAGEM_TAMANHO_SENHA,
  })
  @SenhaNaoComum()
  senha: string;
}
