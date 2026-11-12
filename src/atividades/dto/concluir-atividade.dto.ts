import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';
import { ResultadoReuniao } from '../../generated/prisma/client';
import {
  IsDataHoraComFuso,
  MENSAGEM_DATA_HORA,
  mensagemDeValores,
} from './transformacoes';

/** `POST /atividades/:id/concluir` — o corpo é opcional, salvo para reunião (R6.6). */
export class ConcluirAtividadeDto {
  @ApiPropertyOptional({
    enum: ResultadoReuniao,
    enumName: 'ResultadoReuniao',
    description:
      'R6.6 — obrigatório ao concluir uma reunião; recusado nos outros tipos.',
  })
  @IsOptional()
  @IsEnum(ResultadoReuniao, {
    message: mensagemDeValores(Object.values(ResultadoReuniao)),
  })
  resultadoReuniao?: ResultadoReuniao;

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    description:
      'R6.6 — com `REMARCADA`: início da nova reunião (no futuro). Cria a reunião pendente com a mesma duração.',
  })
  @IsOptional()
  @IsDataHoraComFuso({ message: MENSAGEM_DATA_HORA })
  novaData?: string;
}
