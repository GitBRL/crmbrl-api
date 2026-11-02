import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { ArquivoDto } from '../arquivos/arquivos.dto';
import { UsuarioAtual } from '../auth/decorators';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import { ApiRespostasDeErro } from '../comum/erros/documentacao-erros';
import { BiService } from './bi.service';
import { PAINEIS_BI, type PainelBi } from './bi.tipos';
import {
  ExportarBiDto,
  FiltroBiDto,
  PainelBiDto,
  PaineisDoUsuarioDto,
} from './dto/filtro-bi.dto';
import { DadosInvalidosException } from '../comum/erros/excecoes';

function painelDaRota(valor: string): PainelBi {
  if (!(PAINEIS_BI as readonly string[]).includes(valor)) {
    throw new DadosInvalidosException('Painel desconhecido.', {
      campos: [
        { campo: 'painel', mensagens: [`use um de: ${PAINEIS_BI.join(', ')}`] },
      ],
    });
  }
  return valor as PainelBi;
}

/**
 * BI (R20): um endpoint por painel — Marketing, Comercial, CS e Atendimento —,
 * com período e comparação, e a exportação de cada um. A visibilidade é a das
 * listas (R1); o cache dura 30 segundos por pessoa e filtro.
 */
@ApiTags('BI')
@ApiCookieAuth()
@ApiRespostasDeErro(401)
@Controller('bi')
export class BiController {
  constructor(private readonly bi: BiService) {}

  @Get('paineis')
  @ApiOperation({
    summary: 'Painéis do BI que o papel do usuário vê (as abas)',
  })
  @ApiOkResponse({ type: PaineisDoUsuarioDto })
  paineis(@UsuarioAtual() usuario: UsuarioAutenticado): PaineisDoUsuarioDto {
    return { paineis: this.bi.paineis(usuario) };
  }

  @Get(':painel')
  @ApiOperation({
    summary: 'Painel do BI: cartões com comparação e tabelas dos gráficos',
    description:
      'Painéis: `marketing`, `comercial`, `cs`, `atendimento` e `financeiro` (MRR, inadimplência por faixa e previsto × realizado; só Admin, C-level e CS). Cada resposta traz `cartoes` (valor, anterior e variação), `tabelas` (dados dos gráficos e das tabelas) e `meta`. ' +
      'Admin e C-level veem todos os painéis; as pessoas de área veem o da sua área (e o Atendimento, exceto Marketing); os números respeitam a visibilidade das listas. ' +
      'O resultado fica em cache por 30 segundos; envie `Cache-Control: no-cache` para recalcular.',
  })
  @ApiParam({
    name: 'painel',
    enum: ['marketing', 'comercial', 'cs', 'atendimento', 'financeiro'],
  })
  @ApiOkResponse({ type: PainelBiDto })
  @ApiRespostasDeErro(400, 403, 404)
  painel(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('painel') painel: string,
    @Query() filtro: FiltroBiDto,
    @Headers('cache-control') cacheControl?: string,
  ): Promise<PainelBiDto> {
    return this.bi.painel(
      usuario,
      painelDaRota(painel),
      filtro,
      /no-cache|no-store/i.test(cacheControl ?? ''),
    ) as Promise<PainelBiDto>;
  }

  @Post(':painel/exportar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Exporta o painel (XLSX ou CSV com `;`)',
    description:
      'O corpo leva os mesmos filtros do painel, `formato` e, opcionalmente, `tabela` (chave de `tabelas` ou `cartoes`). ' +
      'Sem `tabela`, o XLSX tem uma aba por tabela e o CSV exporta os indicadores. Devolve o arquivo salvo (`url` para baixar com a sessão). Auditado (`bi.exportado`).',
  })
  @ApiParam({
    name: 'painel',
    enum: ['marketing', 'comercial', 'cs', 'atendimento', 'financeiro'],
  })
  @ApiOkResponse({ type: ArquivoDto })
  @ApiRespostasDeErro(400, 403, 404)
  exportar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('painel') painel: string,
    @Body() dto: ExportarBiDto,
  ): Promise<ArquivoDto> {
    return this.bi.exportar(usuario, painelDaRota(painel), dto);
  }
}
