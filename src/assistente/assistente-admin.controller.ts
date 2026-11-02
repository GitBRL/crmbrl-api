import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ArquivoDto } from '../arquivos/arquivos.dto';
import { Papeis, UsuarioAtual } from '../auth/decorators';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import { ServicoIndisponivelException } from '../comum/erros/excecoes';
import { ApiRespostasDeErro } from '../comum/erros/documentacao-erros';
import { ApiRespostaPaginada, type Pagina } from '../comum/paginacao/paginacao';
import { ParseIdPipe } from '../comum/validacao/parse-id.pipe';
import { REGRA_ASSISTENTE } from './assistente.constantes';
import { ChamadosAssistenteService } from './chamados/chamados-assistente.service';
import {
  ConectorChamadosService,
  ErroDoDestino,
} from './chamados/conector-chamados.service';
import { ConfiguracaoAssistenteService } from './configuracao-assistente.service';
import {
  ChamadoAssistenteDto,
  ConfigurarAssistenteDto,
  ExportarHistoricoAssistenteDto,
  FiltroChamadosAssistenteDto,
  FiltroHistoricoAssistenteDto,
  FiltroPeriodoAssistenteDto,
  PerguntaAssistenteDto,
} from './dto/assistente.dto';
import {
  HistoricoAssistenteService,
  type TemaSemResposta,
} from './historico-assistente.service';

/**
 * Administração do assistente (R25), só Admin: configuração (limites e
 * destino dos chamados; segredos mascarados), histórico de dúvidas com
 * filtros e exportação, temas sem resposta e chamados.
 */
@ApiTags('Assistente de IA — Admin')
@ApiCookieAuth()
@ApiRespostasDeErro(401, 403)
@Papeis('ADMIN')
@Controller('assistente/admin')
export class AssistenteAdminController {
  constructor(
    private readonly historico: HistoricoAssistenteService,
    private readonly configuracao: ConfiguracaoAssistenteService,
    private readonly chamados: ChamadosAssistenteService,
    private readonly conector: ConectorChamadosService,
  ) {}

  @Get('configuracao')
  @ApiOperation({
    summary: 'Configuração (segredos mascarados), uso do mês e artigos da base',
  })
  configuracaoAtual() {
    return this.historico.painel();
  }

  @Put('configuracao')
  @ApiOperation({
    summary:
      'Altera limites e destino dos chamados (parcial; auditado sem valores de segredos)',
  })
  @ApiRespostasDeErro(400)
  async configurar(
    @UsuarioAtual() u: UsuarioAutenticado,
    @Body() dto: ConfigurarAssistenteDto,
  ) {
    await this.configuracao.salvar(u, dto);
    return this.historico.painel();
  }

  @Post('configuracao/testar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Testa o destino: login no TicketHub ou checagem do endereço do webhook (nada é criado)',
  })
  @ApiRespostasDeErro(503)
  async testar(): Promise<{ ok: boolean; mensagem: string }> {
    const destino = await this.configuracao.destino();
    if (!destino.pronto) {
      throw new ServicoIndisponivelException(destino.motivo, {
        regra: REGRA_ASSISTENTE,
        motivo: 'destino_nao_configurado',
      });
    }
    try {
      return {
        ok: true,
        mensagem: await this.conector.testar(destino.destino),
      };
    } catch (erro) {
      if (erro instanceof ErroDoDestino) {
        return { ok: false, mensagem: erro.message };
      }
      throw erro;
    }
  }

  @Get('historico')
  @ApiOperation({ summary: 'Todas as perguntas, com filtros (paginado)' })
  @ApiRespostaPaginada(PerguntaAssistenteDto)
  @ApiRespostasDeErro(400)
  listar(
    @Query() f: FiltroHistoricoAssistenteDto,
  ): Promise<Pagina<PerguntaAssistenteDto>> {
    return this.historico.historico(f);
  }

  @Post('historico/exportar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Exporta o histórico filtrado (XLSX ou CSV com `;`; auditado)',
    description:
      'Os filtros do histórico e `formato` vão na query; devolve o arquivo salvo (`url` para baixar com a sessão). Até 20 mil linhas.',
  })
  @ApiOkResponse({ type: ArquivoDto })
  @ApiRespostasDeErro(400)
  exportar(
    @UsuarioAtual() u: UsuarioAutenticado,
    @Query() f: ExportarHistoricoAssistenteDto,
  ): Promise<ArquivoDto> {
    return this.historico.exportar(u, f);
  }

  @Get('temas')
  @ApiOperation({
    summary:
      'Temas mais pedidos sem resposta (não resolvidos ou não úteis), no período',
  })
  @ApiRespostasDeErro(400)
  temas(@Query() f: FiltroPeriodoAssistenteDto): Promise<TemaSemResposta[]> {
    return this.historico.temas(f);
  }

  @Get('chamados')
  @ApiOperation({ summary: 'Chamados abertos pelo assistente (paginado)' })
  @ApiRespostaPaginada(ChamadoAssistenteDto)
  @ApiRespostasDeErro(400)
  listarChamados(
    @Query() f: FiltroChamadosAssistenteDto,
  ): Promise<Pagina<ChamadoAssistenteDto>> {
    return this.historico.chamados(f);
  }

  @Post('chamados/:id/reenviar')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Reenvia um chamado que falhou (auditado)' })
  @ApiRespostasDeErro(400, 404, 409, 503)
  reenviar(
    @UsuarioAtual() u: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
  ): Promise<ChamadoAssistenteDto> {
    return this.chamados.reenviar(u, id);
  }
}
