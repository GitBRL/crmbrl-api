import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiFoundResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import {
  Papeis,
  Publico,
  SemVerificacaoDeOrigem,
  UsuarioAtual,
} from '../../auth/decorators';
import type { UsuarioAutenticado } from '../../auth/usuario-autenticado';
import { ApiRespostasDeErro } from '../../comum/erros/documentacao-erros';
import { ParseIdPipe } from '../../comum/validacao/parse-id.pipe';
import { CampoBuscadoDto } from '../entrada/dto/webhook-entrada.dto';
import { ConexoesFacebookService } from './conexoes-facebook.service';
import {
  CanalDaMetaDto,
  ConectarComTokenDePaginaDto,
  ConexaoFacebookDto,
  ConfiguracaoDoLoginDto,
  FiltroFormulariosFacebookDto,
  FiltroPaginasFacebookDto,
  FormularioDoFacebookDto,
  IniciarLoginFacebookDto,
  InicioDoLoginDto,
  PaginaDoFacebookDto,
} from './facebook.dto';

/**
 * Conexão com o Facebook Lead Ads (R32.14), só para o Admin (§12): o login, as
 * páginas, os formulários e as perguntas que o assistente da integração usa. A
 * integração em si é criada em `POST /webhooks/entradas` com `aplicativo:
 * FACEBOOK_LEAD_ADS` e `configuracao: { conexaoId, paginaId, formularioId }`.
 */
@ApiTags('Facebook Lead Ads')
@ApiCookieAuth()
@ApiRespostasDeErro(401, 403)
@Papeis('ADMIN')
@Controller('webhooks/facebook')
export class FacebookController {
  constructor(private readonly conexoes: ConexoesFacebookService) {}

  @Get('configuracao')
  @ApiOperation({
    summary: 'Endereço de retorno do login, escopos e versão da Graph',
    description:
      'A tela mostra o `enderecoDeRetorno` para o Admin cadastrá-lo no app da Meta (URIs de redirecionamento OAuth válidos).',
  })
  @ApiOkResponse({ type: ConfiguracaoDoLoginDto })
  configuracao(): ConfiguracaoDoLoginDto {
    return this.conexoes.configuracaoDoLogin();
  }

  @Get('canais')
  @ApiOperation({
    summary:
      'Canais Messenger e Instagram cujo app da Meta pode ser reaproveitado',
    description:
      'Só o ID do app aparece; o segredo é copiado pela API ao criar a conexão (`canalId`).',
  })
  @ApiOkResponse({ type: [CanalDaMetaDto] })
  canais(): Promise<CanalDaMetaDto[]> {
    return this.conexoes.canaisReaproveitaveis();
  }

  @Post('oauth/iniciar')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: '"Entrar com o Facebook": monta a URL do diálogo',
    description:
      'Cria a conexão (ou reaproveita `conexaoId`, para reconectar) e devolve `urlDialogo` (em `META_DIALOGO_URL`) com `state` assinado, de uso único e válido por 10 minutos. A tela navega até ela. Depois do diálogo, a Meta chama `GET /publico/facebook/oauth/retorno`, que troca o `code` e volta para `/integracoes?facebook=conectado|cancelado|erro&conexao=<id>[&motivo=<código>&mensagem=<texto>]`.',
  })
  @ApiCreatedResponse({ type: InicioDoLoginDto })
  @ApiRespostasDeErro(400, 404, 422)
  iniciarLogin(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Body() dto: IniciarLoginFacebookDto,
  ): Promise<InicioDoLoginDto> {
    return this.conexoes.iniciarLogin(usuario, dto);
  }

  @Post('conexoes/token-de-pagina')
  @ApiOperation({
    summary: 'Conexão por token de página colado (sem OAuth)',
    description:
      'Para ambiente sem domínio público. O token é conferido na Meta (`paginaId` ou `/me`), guardado cifrado e nunca devolvido. O ID e o segredo do app continuam obrigatórios (o segredo confere a assinatura do webhook).',
  })
  @ApiCreatedResponse({ type: ConexaoFacebookDto })
  @ApiRespostasDeErro(400, 404, 422)
  conectarComToken(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Body() dto: ConectarComTokenDePaginaDto,
  ): Promise<ConexaoFacebookDto> {
    return this.conexoes.conectarComTokenDePagina(usuario, dto);
  }

  @Get('conexoes')
  @ApiOperation({ summary: 'Conexões com o Facebook (sem segredos)' })
  @ApiOkResponse({ type: [ConexaoFacebookDto] })
  listar(): Promise<ConexaoFacebookDto[]> {
    return this.conexoes.listar();
  }

  @Get('conexoes/:id')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({ summary: 'Uma conexão (com as páginas)' })
  @ApiOkResponse({ type: ConexaoFacebookDto })
  @ApiRespostasDeErro(404)
  detalhar(@Param('id', ParseIdPipe) id: string): Promise<ConexaoFacebookDto> {
    return this.conexoes.detalhar(id);
  }

  @Delete('conexoes/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({
    summary: 'Exclui a conexão e apaga os tokens',
    description: '409 se alguma integração ainda a usa.',
  })
  @ApiNoContentResponse()
  @ApiRespostasDeErro(404, 409)
  excluir(@Param('id', ParseIdPipe) id: string): Promise<void> {
    return this.conexoes.excluir(id);
  }

  @Post('conexoes/:id/atualizar-paginas')
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({
    summary: 'Pergunta de novo à Meta quais páginas o usuário administra',
    description:
      'Renova também os tokens das páginas. Token recusado: 422 e a conexão fica "precisa de atenção".',
  })
  @ApiOkResponse({ type: ConexaoFacebookDto })
  @ApiRespostasDeErro(404, 422)
  atualizarPaginas(
    @Param('id', ParseIdPipe) id: string,
  ): Promise<ConexaoFacebookDto> {
    return this.conexoes.atualizarPaginasPorId(id);
  }

  @Get('conexoes/:id/paginas')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({ summary: 'Páginas da conexão (passo "escolher a página")' })
  @ApiOkResponse({ type: [PaginaDoFacebookDto] })
  @ApiRespostasDeErro(404, 422)
  paginas(
    @Param('id', ParseIdPipe) id: string,
    @Query() filtro: FiltroPaginasFacebookDto,
  ): Promise<PaginaDoFacebookDto[]> {
    return this.conexoes.paginas(id, filtro.atualizar === true);
  }

  @Get('conexoes/:id/paginas/:paginaId/formularios')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiParam({ name: 'paginaId', example: '300000000000001' })
  @ApiOperation({
    summary: 'Formulários de lead da página (passo "escolher o formulário")',
  })
  @ApiOkResponse({ type: [FormularioDoFacebookDto] })
  @ApiRespostasDeErro(404, 422)
  formularios(
    @Param('id', ParseIdPipe) id: string,
    @Param('paginaId') paginaId: string,
    @Query() filtro: FiltroFormulariosFacebookDto,
  ): Promise<FormularioDoFacebookDto[]> {
    return this.conexoes.formularios(id, paginaId, filtro.busca);
  }

  @Get('conexoes/:id/paginas/:paginaId/formularios/:formularioId/perguntas')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiParam({ name: 'paginaId', example: '300000000000001' })
  @ApiParam({ name: 'formularioId', example: '400000000000001' })
  @ApiOperation({
    summary:
      'Perguntas do formulário (e os metadados do lead) para o mapeamento',
    description:
      'Cada item é `{ caminho, rotulo, tipo }`: o `caminho` é a chave da pergunta (`full_name`, `email`, `phone_number`, as personalizadas), que o mapeamento usa; os metadados (`ad_id`, `campaign_name`, `form_id`…) vêm com `tipo: "metadado"`.',
  })
  @ApiOkResponse({ type: [CampoBuscadoDto] })
  @ApiRespostasDeErro(404, 422)
  perguntas(
    @Param('id', ParseIdPipe) id: string,
    @Param('paginaId') paginaId: string,
    @Param('formularioId') formularioId: string,
  ): Promise<CampoBuscadoDto[]> {
    return this.conexoes.perguntas(id, paginaId, formularioId);
  }
}

/** O retorno do diálogo do Facebook: a Meta redireciona o navegador para cá (sem login do CRM; o `state` assinado é a prova). */
@ApiTags('Facebook Lead Ads')
@Publico()
@SemVerificacaoDeOrigem()
@Controller('publico/facebook')
export class FacebookPublicoController {
  constructor(private readonly conexoes: ConexoesFacebookService) {}

  @Get('oauth/retorno')
  @ApiOperation({
    summary: 'Retorno do "Entrar com o Facebook"',
    description:
      'Confere o `state` (assinado, de uso único, até 10 minutos), troca o `code` por um token de longa duração, guarda as páginas e redireciona (302) para `/integracoes?facebook=conectado|cancelado|erro&conexao=<id>`. Em erro, `motivo` é `state_invalido`, `state_vencido`, `state_usado`, `sem_codigo`, `meta_recusou` (com `mensagem`) ou o `error` da Meta (ex.: `access_denied`, com `facebook=cancelado`).',
  })
  @ApiQuery({ name: 'code', required: false })
  @ApiQuery({ name: 'state', required: false })
  @ApiQuery({ name: 'error', required: false })
  @ApiFoundResponse({ description: 'Redireciona para a tela de Integrações.' })
  async retorno(
    @Query() consulta: Record<string, unknown>,
    @Res() resposta: Response,
  ): Promise<void> {
    const { destino } = await this.conexoes.concluirLogin(consulta);
    resposta.setHeader('Cache-Control', 'no-store');
    resposta.setHeader('Referrer-Policy', 'no-referrer');
    resposta.redirect(HttpStatus.FOUND, destino);
  }
}
