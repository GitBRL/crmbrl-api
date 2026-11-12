import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Papeis, UsuarioAtual } from '../auth/decorators';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import { ApiRespostasDeErro } from '../comum/erros/documentacao-erros';
import { ParseIdPipe } from '../comum/validacao/parse-id.pipe';
import { LigacaoDto } from '../ligacoes/ligacoes.dto';
import { AgenteTrescPlusService } from './agente.service';
import { ConexaoTrescPlusService } from './conexao.service';
import { DiscadorTrescPlusService } from './discador.service';
import {
  ReconciliacaoTrescPlusService,
  type ResultadoDaReconciliacao,
} from './reconciliacao.service';
import {
  AtualizarConexaoDto,
  CampanhaTrescDto,
  ConexaoTrescPlusDto,
  ConsultaDeCampanhaDto,
  EntrarNaCampanhaDto,
  EntrarNaPausaDto,
  EnviarAoDiscadorDto,
  EstadoDoAgenteDto,
  LigarTrescDto,
  ListaTrescDto,
  PausaTrescDto,
  QualificacaoTrescDto,
  QualificarLigacaoDto,
  RelatorioDoDiscadorDto,
  ResultadoDoTesteTrescDto,
  VincularDto,
  VinculoDto,
} from './tresc-plus.dto';
import { VinculosTrescPlusService } from './vinculos.service';

/**
 * Configuração do 3C+ (R34.1) e vínculos dos vendedores (R34.2): só Admin.
 * Os eventos de tempo real `tresc.*` estão em `src/tempo-real/catalogo.ts`.
 */
@ApiTags('3C+ — Conexão')
@ApiCookieAuth()
@ApiRespostasDeErro(401, 403)
@Controller('tresc-plus')
export class ConexaoTrescPlusController {
  constructor(
    private readonly conexao: ConexaoTrescPlusService,
    private readonly vinculos: VinculosTrescPlusService,
    private readonly reconciliacao: ReconciliacaoTrescPlusService,
  ) {}

  @Get('conexao')
  @Papeis('ADMIN')
  @ApiOperation({
    summary: 'Conexão da empresa com o 3C+ (R34.1)',
    description:
      'O token do gestor nunca sai inteiro: `token` traz só os 4 últimos caracteres.',
  })
  @ApiOkResponse({ type: ConexaoTrescPlusDto })
  obter(): Promise<ConexaoTrescPlusDto> {
    return this.conexao.obter();
  }

  @Patch('conexao')
  @Papeis('ADMIN')
  @ApiOperation({
    summary: 'Altera a conexão com o 3C+',
    description:
      'URLs, token do gestor (cifrado), campanha padrão do modo manual, formato do envelope do socket e liga/desliga. Reinicia o ouvinte de eventos.',
  })
  @ApiOkResponse({ type: ConexaoTrescPlusDto })
  @ApiRespostasDeErro(400, 422)
  atualizar(
    @Body() dto: AtualizarConexaoDto,
    @UsuarioAtual() usuario: UsuarioAutenticado,
  ): Promise<ConexaoTrescPlusDto> {
    return this.conexao.atualizar(usuario, dto);
  }

  @Post('conexao/testar')
  @Papeis('ADMIN')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Testa a conexão (`GET /me` com o token do gestor)',
  })
  @ApiOkResponse({ type: ResultadoDoTesteTrescDto })
  testar(): Promise<ResultadoDoTesteTrescDto> {
    return this.conexao.testar();
  }

  @Post('reconciliar')
  @Papeis('ADMIN')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Roda agora a reconciliação por `GET /calls`',
    description:
      'O job periódico faz o mesmo a cada `TRESC_PLUS_RECONCILIACAO_MIN` minutos.',
  })
  @ApiRespostasDeErro(422, 503)
  reconciliar(): Promise<ResultadoDaReconciliacao> {
    return this.reconciliacao.reconciliar();
  }

  @Get('vinculos')
  @Papeis('ADMIN')
  @ApiOperation({ summary: 'Vendedores conectados ao 3C+' })
  listar(): Promise<Array<VinculoDto & { usuarioNome: string }>> {
    return this.vinculos.listar();
  }

  @Delete('vinculos/:usuarioId')
  @Papeis('ADMIN')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'O Admin desvincula um vendedor do 3C+' })
  @ApiNoContentResponse()
  @ApiRespostasDeErro(404)
  async desvincularOutro(
    @Param('usuarioId', ParseIdPipe) usuarioId: string,
    @UsuarioAtual() usuario: UsuarioAutenticado,
  ): Promise<void> {
    await this.vinculos.desvincular(usuario, usuarioId);
  }
}

/** Vínculo do próprio vendedor (R34.2). */
@ApiTags('3C+ — Vínculo')
@ApiCookieAuth()
@ApiRespostasDeErro(401)
@Controller('tresc-plus/vinculo')
export class VinculoTrescPlusController {
  constructor(private readonly vinculos: VinculosTrescPlusService) {}

  @Get()
  @ApiOperation({
    summary:
      'O vínculo do usuário com o 3C+ (ramal, id e os 4 últimos caracteres do token)',
  })
  @ApiOkResponse({ type: VinculoDto })
  obter(@UsuarioAtual() usuario: UsuarioAutenticado): Promise<VinculoDto> {
    return this.vinculos.obter(usuario);
  }

  @Post()
  @ApiOperation({
    summary: 'Conecta o usuário ao 3C+ (`POST /authenticate`)',
    description:
      'A senha é usada uma única vez e nunca é guardada: o CRM fica só com o `api_token` (cifrado), o ramal e o id do usuário no 3C+.',
  })
  @ApiCreatedResponse({ type: VinculoDto })
  @ApiRespostasDeErro(400, 409, 422, 503)
  vincular(
    @Body() dto: VincularDto,
    @UsuarioAtual() usuario: UsuarioAutenticado,
  ): Promise<VinculoDto> {
    return this.vinculos.vincular(usuario, dto);
  }

  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Desconecta o usuário do 3C+' })
  @ApiNoContentResponse()
  @ApiRespostasDeErro(404)
  async desvincular(
    @UsuarioAtual() usuario: UsuarioAutenticado,
  ): Promise<void> {
    await this.vinculos.desvincular(usuario, usuario.id);
  }
}

/** Agente e ligação (R34.5). */
@ApiTags('3C+ — Agente e ligações')
@ApiCookieAuth()
@ApiRespostasDeErro(401)
@Controller('tresc-plus')
export class AgenteTrescPlusController {
  constructor(private readonly agente: AgenteTrescPlusService) {}

  @Get('agente')
  @ApiOperation({
    summary: 'Estado do agente (campanha, modo, pausa, ligação em curso)',
    description:
      'Com `atualizar=true`, confere no 3C+ a campanha atual. O estado em tempo real vem em `tresc.agente`.',
  })
  @ApiOkResponse({ type: EstadoDoAgenteDto })
  estado(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Query('atualizar') atualizar?: string,
  ): Promise<EstadoDoAgenteDto> {
    return this.agente.estado(usuario, atualizar === 'true');
  }

  @Get('agente/campanhas')
  @ApiOperation({ summary: 'Campanhas em que o agente pode entrar' })
  @ApiOkResponse({ type: [CampanhaTrescDto] })
  @ApiRespostasDeErro(422, 503)
  campanhas(
    @UsuarioAtual() usuario: UsuarioAutenticado,
  ): Promise<CampanhaTrescDto[]> {
    return this.agente.campanhas(usuario);
  }

  @Post('agente/entrar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Entra na campanha (modo manual ou discador)' })
  @ApiOkResponse({ type: EstadoDoAgenteDto })
  @ApiRespostasDeErro(400, 422, 503)
  entrar(
    @Body() dto: EntrarNaCampanhaDto,
    @UsuarioAtual() usuario: UsuarioAutenticado,
  ): Promise<EstadoDoAgenteDto> {
    return this.agente.entrar(usuario, dto);
  }

  @Post('agente/sair')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Sai da campanha' })
  @ApiOkResponse({ type: EstadoDoAgenteDto })
  @ApiRespostasDeErro(422, 503)
  sair(
    @UsuarioAtual() usuario: UsuarioAutenticado,
  ): Promise<EstadoDoAgenteDto> {
    return this.agente.sair(usuario);
  }

  @Get('agente/pausas')
  @ApiOperation({ summary: 'Intervalos (pausas) disponíveis' })
  @ApiOkResponse({ type: [PausaTrescDto] })
  @ApiRespostasDeErro(422, 503)
  pausas(
    @UsuarioAtual() usuario: UsuarioAutenticado,
  ): Promise<PausaTrescDto[]> {
    return this.agente.pausas(usuario);
  }

  @Post('agente/pausa')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Entra numa pausa' })
  @ApiOkResponse({ type: EstadoDoAgenteDto })
  @ApiRespostasDeErro(400, 422, 503)
  entrarEmPausa(
    @Body() dto: EntrarNaPausaDto,
    @UsuarioAtual() usuario: UsuarioAutenticado,
  ): Promise<EstadoDoAgenteDto> {
    return this.agente.entrarEmPausa(usuario, dto.intervaloId);
  }

  @Delete('agente/pausa')
  @ApiOperation({ summary: 'Sai da pausa' })
  @ApiOkResponse({ type: EstadoDoAgenteDto })
  @ApiRespostasDeErro(422, 503)
  sairDaPausa(
    @UsuarioAtual() usuario: UsuarioAutenticado,
  ): Promise<EstadoDoAgenteDto> {
    return this.agente.sairDaPausa(usuario);
  }

  @Post('ligacoes')
  @ApiOperation({
    summary: 'Liga para o contato pelo 3C+',
    description:
      'Entra na campanha padrão e no modo manual se preciso e disca com o token do vendedor. A ligação entra no contato e no negócio. Os estados chegam por `tresc.ligacao`.',
  })
  @ApiCreatedResponse({ type: LigacaoDto })
  @ApiRespostasDeErro(400, 404, 422, 503)
  ligar(
    @Body() dto: LigarTrescDto,
    @UsuarioAtual() usuario: UsuarioAutenticado,
  ): Promise<LigacaoDto> {
    return this.agente.ligar(usuario, dto);
  }

  @Post('ligacoes/:id/desligar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Desliga a ligação em curso' })
  @ApiOkResponse({ type: LigacaoDto })
  @ApiRespostasDeErro(404, 422, 503)
  desligar(
    @Param('id', ParseIdPipe) id: string,
    @UsuarioAtual() usuario: UsuarioAutenticado,
  ): Promise<LigacaoDto> {
    return this.agente.desligar(usuario, id);
  }

  @Get('ligacoes/:id/qualificacoes')
  @ApiOperation({ summary: 'Qualificações da campanha da ligação' })
  @ApiOkResponse({ type: [QualificacaoTrescDto] })
  @ApiRespostasDeErro(404, 422, 503)
  qualificacoesDaLigacao(
    @Param('id', ParseIdPipe) id: string,
    @UsuarioAtual() usuario: UsuarioAutenticado,
  ): Promise<QualificacaoTrescDto[]> {
    return this.agente.qualificacoes(usuario, id);
  }

  @Get('qualificacoes')
  @ApiOperation({
    summary:
      'Qualificações de uma campanha (padrão: a do agente ou a padrão da empresa)',
  })
  @ApiOkResponse({ type: [QualificacaoTrescDto] })
  @ApiRespostasDeErro(422, 503)
  qualificacoes(
    @Query() consulta: ConsultaDeCampanhaDto,
    @UsuarioAtual() usuario: UsuarioAutenticado,
  ): Promise<QualificacaoTrescDto[]> {
    return this.agente.qualificacoes(usuario, null, consulta.campanhaId);
  }

  @Post('ligacoes/:id/qualificar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Qualifica a ligação (com observação e agendamento opcionais)',
    description:
      'Só quem fez a ligação. O resultado aparece na ligação, na atividade e na linha do tempo.',
  })
  @ApiOkResponse({ type: LigacaoDto })
  @ApiRespostasDeErro(400, 404, 422, 503)
  qualificar(
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: QualificarLigacaoDto,
    @UsuarioAtual() usuario: UsuarioAutenticado,
  ): Promise<LigacaoDto> {
    return this.agente.qualificar(usuario, id, dto);
  }
}

/** Envio ao discador (R34.6): Admin, C-level e líderes. */
@ApiTags('3C+ — Discador')
@ApiCookieAuth()
@ApiRespostasDeErro(401, 403)
@Papeis('ADMIN', 'C_LEVEL', 'LIDER')
@Controller('tresc-plus')
export class DiscadorTrescPlusController {
  constructor(
    private readonly discador: DiscadorTrescPlusService,
    private readonly conexao: ConexaoTrescPlusService,
  ) {}

  @Get('campanhas')
  @ApiOperation({ summary: 'Campanhas da empresa no 3C+ (token do gestor)' })
  @ApiOkResponse({ type: [CampanhaTrescDto] })
  @ApiRespostasDeErro(422, 503)
  campanhas(): Promise<CampanhaTrescDto[]> {
    return this.conexao
      .campanhas()
      .then((lista) => lista.map((c) => ({ ...c })));
  }

  @Get('campanhas/:id/listas')
  @ApiOperation({ summary: 'Listas (mailings) de uma campanha' })
  @ApiOkResponse({ type: [ListaTrescDto] })
  @ApiRespostasDeErro(422, 503)
  listas(@Param('id') id: string): Promise<ListaTrescDto[]> {
    return this.discador.listas(Number(id));
  }

  @Post('discador/enviar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Envia negócios e contatos a uma campanha do discador',
    description:
      '`mailing.json` com `identifier` = id do negócio/contato e `data` (nome, empresa, funil, etapa). O relatório traz os importados e os filtrados, com o motivo em português.',
  })
  @ApiOkResponse({ type: RelatorioDoDiscadorDto })
  @ApiRespostasDeErro(400, 422, 503)
  enviar(
    @Body() dto: EnviarAoDiscadorDto,
    @UsuarioAtual() usuario: UsuarioAutenticado,
  ): Promise<RelatorioDoDiscadorDto> {
    return this.discador.enviar(usuario, dto);
  }
}
