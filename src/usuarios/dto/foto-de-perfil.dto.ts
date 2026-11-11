import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';
import { MENSAGEM_UUID } from './criar-usuario.dto';

/** Corpo do `PUT /usuarios/eu/foto` (R2.10). */
export class DefinirFotoDto {
  @ApiProperty({
    format: 'uuid',
    description:
      'O `id` devolvido por `POST /arquivos?contexto=AVATAR` (JPG, PNG, GIF ou WebP, até 5 MB), enviado pela própria pessoa.',
  })
  @IsUUID('all', { message: MENSAGEM_UUID })
  arquivoId: string;
}

/** A foto de perfil depois da troca ou da remoção. */
export class FotoDePerfilDto {
  @ApiProperty({
    nullable: true,
    type: String,
    description:
      'Endereço da foto: `/api/v1/arquivos/<id>` para a enviada pelo CRM (abre com a sessão), ou `null` sem foto.',
  })
  avatarUrl: string | null;
}
