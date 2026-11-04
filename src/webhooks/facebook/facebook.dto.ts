import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  MaxLength,
} from 'class-validator';
import {
  aparar,
  MENSAGEM_BOOLEANO,
  MENSAGEM_TEXTO,
  MENSAGEM_UUID,
  maximo,
  OpcionalNaoNulo,
} from '../dto-comum';

// ---------------------------------------------------------------------------
// Entrada
// ---------------------------------------------------------------------------

/** O app da Meta: ou o canal de onde reaproveitar, ou o id e o segredo. */
class AppDaMetaDto {
  @ApiPropertyOptional({
    description:
      'ID do app da Meta (developers.facebook.com > Configurações do app > Básico). Sem `canalId` e sem `conexaoId`, é obrigatório.',
    example: '1234567890123456',
  })
  @OpcionalNaoNulo()
  @Transform(aparar)
  @IsString({ message: MENSAGEM_TEXTO })
  @Length(1, 40, { message: 'deve ter entre 1 e 40 caracteres' })
  appId?: string;

  @ApiPropertyOptional({
    description:
      'Segredo do app (guardado cifrado, nunca devolvido). Sem `canalId` e sem `conexaoId`, é obrigatório.',
  })
  @OpcionalNaoNulo()
  @Transform(aparar)
  @IsString({ message: MENSAGEM_TEXTO })
  @Length(1, 200, { message: 'deve ter entre 1 e 200 caracteres' })
  appSecret?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Reaproveita o ID e o segredo do app de um canal Messenger ou Instagram (veja `GET /webhooks/facebook/canais`). Os valores são copiados para a conexão.',
  })
  @OpcionalNaoNulo()
  @IsUUID('all', MENSAGEM_UUID)
  canalId?: string;

  @ApiPropertyOptional({
    description:
      'Nome da conexão na tela. Padrão: o nome do usuário ou da página do Facebook.',
  })
  @OpcionalNaoNulo()
  @Transform(aparar)
  @IsString({ message: MENSAGEM_TEXTO })
  @Length(1, 100, { message: 'deve ter entre 1 e 100 caracteres' })
  nome?: string;
}

export class IniciarLoginFacebookDto extends AppDaMetaDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Reconecta uma conexão existente com o mesmo app (o token expirou ou foi revogado). Sem ela, uma conexão nova é criada.',
  })
  @OpcionalNaoNulo()
  @IsUUID('all', MENSAGEM_UUID)
  conexaoId?: string;
}

export class ConectarComTokenDePaginaDto extends AppDaMetaDto {
  @ApiProperty({
    description:
      'Token de acesso da página (Graph API Explorer ou Business Suite). Guardado cifrado, nunca devolvido.',
  })
  @Transform(aparar)
  @IsString({ message: MENSAGEM_TEXTO })
  @Length(1, 1000, { message: 'deve ter entre 1 e 1000 caracteres' })
  tokenPagina: string;

  @ApiPropertyOptional({
    description:
      'ID da página dona do token. Sem ele, o CRM pergunta à Meta quem é o dono do token (`/me`).',
    example: '300000000000001',
  })
  @OpcionalNaoNulo()
  @Transform(aparar)
  @IsString({ message: MENSAGEM_TEXTO })
  @Length(1, 40, { message: 'deve ter entre 1 e 40 caracteres' })
  paginaId?: string;
}

export class FiltroPaginasFacebookDto {
  @ApiPropertyOptional({
    description:
      'Verdadeiro: pergunta à Meta de novo quais páginas o usuário administra (só em conexões por login).',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === 'true' || value === true
      ? true
      : value === 'false'
        ? false
        : value,
  )
  @IsBoolean(MENSAGEM_BOOLEANO)
  atualizar?: boolean;
}

export class FiltroFormulariosFacebookDto {
  @ApiPropertyOptional({ description: 'Parte do nome do formulário.' })
  @IsOptional()
  @Transform(aparar)
  @IsString({ message: MENSAGEM_TEXTO })
  @MaxLength(100, maximo(100))
  busca?: string;
}

// ---------------------------------------------------------------------------
// Saída
// ---------------------------------------------------------------------------

export class ConfiguracaoDoLoginDto {
  @ApiProperty({
    example: 'https://crm.exemplo.com.br/api/v1/publico/facebook/oauth/retorno',
    description:
      'Endereço de retorno do login: cadastre-o em "URIs de redirecionamento OAuth válidos" (Login do Facebook) no app da Meta.',
  })
  enderecoDeRetorno: string;

  @ApiProperty({ type: [String] })
  escopos: string[];

  @ApiProperty({ example: 'v24.0' })
  versaoDaGraph: string;

  @ApiProperty({
    description:
      'O CRM tem endereço público acessível pela Meta? Falso em `http://` (ambiente local): o webhook não chega e o login só funciona com o diálogo do ambiente; a reconciliação (a cada 15 min) cobre a falta do webhook.',
  })
  enderecoPublicoHttps: boolean;
}

export class CanalDaMetaDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  nome: string;

  @ApiProperty({ enum: ['MESSENGER', 'INSTAGRAM'] })
  tipo: string;

  @ApiProperty({ example: '1234567890123456' })
  appId: string;
}

export class InicioDoLoginDto {
  @ApiProperty({
    format: 'uuid',
    description: 'A conexão que o login vai preencher.',
  })
  conexaoId: string;

  @ApiProperty({
    description:
      'Endereço do diálogo do Facebook (`META_DIALOGO_URL`) com `state` assinado, de uso único e válido por 10 minutos. A tela navega até ele (`window.location`).',
  })
  urlDialogo: string;

  @ApiProperty({ format: 'date-time' })
  expiraEm: string;

  @ApiProperty({
    description:
      'O `redirect_uri` enviado à Meta (igual a `enderecoDeRetorno`).',
  })
  enderecoDeRetorno: string;
}

export class PaginaDoFacebookDto {
  @ApiProperty({ example: '300000000000001' })
  id: string;

  @ApiProperty({ example: 'Escola Demo BRL' })
  nome: string;

  @ApiProperty({ type: String, nullable: true, example: 'Education' })
  categoria: string | null;
}

export class FormularioDoFacebookDto {
  @ApiProperty({ example: '400000000000001' })
  id: string;

  @ApiProperty({ example: 'Interesse em matrícula 2027' })
  nome: string;

  @ApiProperty({ type: String, nullable: true, example: 'ACTIVE' })
  status: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'pt_BR' })
  idioma: string | null;

  @ApiProperty({ type: String, nullable: true })
  criadoEm: string | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Leads já recebidos pelo formulário na Meta.',
  })
  leads: number | null;
}

export class UsuarioDoFacebookDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  nome: string;
}

export class WebhookDaConexaoFacebookDto {
  @ApiProperty({
    example: 'https://crm.brl.com.br/api/v1/publico/meta/webhook',
    description:
      'URL de retorno (callback) para Webhooks > Page no app da Meta (a mesma do Instagram, do Messenger e do WhatsApp oficial).',
  })
  url: string;

  @ApiProperty({
    description:
      'Token de verificação desta conexão, para colar no painel da Meta (o `hub.verify_token` do desafio).',
  })
  tokenVerificacao: string;

  @ApiProperty({
    type: [String],
    example: ['leadgen'],
    description: 'Campos a assinar no objeto Page.',
  })
  campos: string[];
}

export class ConexaoFacebookDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'Facebook de Maria Gestora' })
  nome: string;

  @ApiProperty({
    enum: ['USUARIO', 'PAGINA'],
    description:
      '`USUARIO`: "Entrar com o Facebook"; `PAGINA`: token de página colado.',
  })
  tipo: string;

  @ApiProperty({ example: '1234567890123456' })
  appId: string;

  @ApiProperty({ example: '••••••••3f9a' })
  appSecretMascarado: string;

  @ApiProperty({
    description:
      'O login terminou e há token. Falso enquanto o diálogo do Facebook está aberto (ou foi cancelado).',
  })
  conectada: boolean;

  @ApiProperty({ type: UsuarioDoFacebookDto, nullable: true })
  usuarioFacebook: UsuarioDoFacebookDto | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'Quando o token do usuário expira (as páginas seguem valendo).',
  })
  expiraEm: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  conectadaEm: string | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Canal Messenger/Instagram de onde o app foi reaproveitado.',
  })
  canalOrigemId: string | null;

  @ApiProperty({ type: [PaginaDoFacebookDto] })
  paginas: PaginaDoFacebookDto[];

  @ApiProperty({
    description: 'Integrações (não excluídas) que usam esta conexão.',
  })
  integracoes: number;

  @ApiProperty({ type: WebhookDaConexaoFacebookDto })
  webhook: WebhookDaConexaoFacebookDto;

  @ApiProperty()
  precisaAtencao: boolean;

  @ApiProperty({ type: String, nullable: true })
  atencaoMotivo: string | null;

  @ApiProperty({ format: 'date-time' })
  criadoEm: string;
}
