import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, IsUUID, Length } from 'class-validator';
import {
  aparar,
  MENSAGEM_TEXTO,
  MENSAGEM_UUID,
  mensagemDeValores,
  OpcionalNaoNulo,
} from '../dto-comum';

export const APLICATIVOS_DE_CONEXAO = ['TYPEFORM', 'RD_STATION'] as const;

export class IniciarLoginDeAplicativoDto {
  @ApiProperty({ enum: APLICATIVOS_DE_CONEXAO })
  @IsIn(APLICATIVOS_DE_CONEXAO, {
    message: mensagemDeValores(APLICATIVOS_DE_CONEXAO),
  })
  aplicativo: 'TYPEFORM' | 'RD_STATION';

  @ApiPropertyOptional({
    description:
      'Nome da conexão na tela. Padrão: o nome do serviço com a conta devolvida por ele.',
  })
  @OpcionalNaoNulo()
  @Transform(aparar)
  @IsString({ message: MENSAGEM_TEXTO })
  @Length(1, 100, { message: 'deve ter entre 1 e 100 caracteres' })
  nome?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Reconecta uma conexão existente (o acesso expirou, foi revogado ou o app mudou). Sem ela, uma conexão nova é criada.',
  })
  @OpcionalNaoNulo()
  @IsUUID('all', MENSAGEM_UUID)
  conexaoId?: string;

  @ApiPropertyOptional({
    enum: ['janela', 'pagina'],
    default: 'pagina',
    description:
      '`janela`: o retorno vai para `/retorno-login?app=…` (a janela avisa o assistente e fecha); `pagina` (padrão): `/integracoes?typeform|rd-station=…`.',
  })
  @OpcionalNaoNulo()
  @IsIn(['janela', 'pagina'], {
    message: mensagemDeValores(['janela', 'pagina']),
  })
  modo?: 'janela' | 'pagina';
}

export class FiltroConexoesDto {
  @ApiPropertyOptional({ enum: APLICATIVOS_DE_CONEXAO })
  @IsOptional()
  @IsIn(APLICATIVOS_DE_CONEXAO, {
    message: mensagemDeValores(APLICATIVOS_DE_CONEXAO),
  })
  aplicativo?: 'TYPEFORM' | 'RD_STATION';
}

export class ConexaoDeAplicativoDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ enum: APLICATIVOS_DE_CONEXAO })
  aplicativo: string;

  @ApiProperty({ example: 'Typeform da escola' })
  nome: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Nome ou e-mail da conta, como o serviço informou.',
  })
  conta: string | null;

  @ApiProperty({
    description:
      'O login terminou e há token. Falso enquanto a janela do serviço está aberta (ou foi cancelada).',
  })
  conectada: boolean;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  conectadaEm: string | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Quando o token de acesso vence (o CRM renova sozinho).',
  })
  expiraEm: string | null;

  @ApiProperty({
    description: 'Integrações (não excluídas) que usam esta conexão.',
  })
  integracoes: number;

  @ApiProperty()
  precisaAtencao: boolean;

  @ApiProperty({ type: String, nullable: true })
  atencaoMotivo: string | null;

  @ApiProperty({ format: 'date-time' })
  criadoEm: string;
}
