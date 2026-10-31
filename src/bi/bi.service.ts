import { Injectable } from '@nestjs/common';
import type { ArquivoDto } from '../arquivos/arquivos.dto';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import { SemPermissaoException } from '../comum/erros/excecoes';
import { CACHE_BI_MAXIMO, CACHE_BI_SEGUNDOS, REGRA_BI } from './bi.constantes';
import type { ConteudoDoPainel, PainelBi, PainelCalculado } from './bi.tipos';
import { CacheBi } from './cache-bi';
import type { ExportarBiDto, FiltroBiDto } from './dto/filtro-bi.dto';
import { paineisDoPapel, podeVerPainel } from './escopo-bi';
import { ExportacaoBiService } from './exportacao-bi.service';
import { FiltrosBiService } from './filtros-bi.service';
import { PainelAtendimentoService } from './painel-atendimento.service';
import { PainelComercialService } from './painel-comercial.service';
import { PainelCsService } from './painel-cs.service';
import { PainelFinanceiroService } from './painel-financeiro.service';
import { PainelMarketingService } from './painel-marketing.service';

/**
 * BI (R20): a porta dos painéis. Confere o papel, resolve os filtros, usa o
 * cache curto (por pessoa e filtro) e entrega o painel calculado.
 */
@Injectable()
export class BiService {
  private readonly cache = new CacheBi<PainelCalculado>(
    CACHE_BI_SEGUNDOS * 1000,
    CACHE_BI_MAXIMO,
  );

  constructor(
    private readonly filtros: FiltrosBiService,
    private readonly marketing: PainelMarketingService,
    private readonly comercial: PainelComercialService,
    private readonly cs: PainelCsService,
    private readonly atendimento: PainelAtendimentoService,
    private readonly financeiro: PainelFinanceiroService,
    private readonly exportacao: ExportacaoBiService,
  ) {}

  /** Abas que o papel do usuário vê. */
  paineis(usuario: UsuarioAutenticado): PainelBi[] {
    return paineisDoPapel(usuario.papel);
  }

  /** `semCache`: ignora o cache e recalcula (o cliente pediu `Cache-Control: no-cache`). */
  async painel(
    usuario: UsuarioAutenticado,
    painel: PainelBi,
    dto: FiltroBiDto,
    semCache = false,
  ): Promise<PainelCalculado> {
    this.exigirPainel(usuario, painel);
    const chave = JSON.stringify([usuario.id, usuario.papel, painel, dto]);
    if (!semCache) {
      const guardado = this.cache.obter(chave);
      if (guardado) {
        return guardado;
      }
    }
    const calculado = await this.calcular(usuario, painel, dto);
    this.cache.guardar(chave, calculado);
    return calculado;
  }

  async exportar(
    usuario: UsuarioAutenticado,
    painel: PainelBi,
    dto: ExportarBiDto,
  ): Promise<ArquivoDto> {
    this.exigirPainel(usuario, painel);
    const calculado = await this.calcular(usuario, painel, dto);
    return this.exportacao.exportar(usuario, painel, dto, calculado);
  }

  private exigirPainel(usuario: UsuarioAutenticado, painel: PainelBi): void {
    if (!podeVerPainel(usuario.papel, painel)) {
      throw new SemPermissaoException(
        'Você não tem acesso a este painel do BI.',
        { regra: REGRA_BI },
      );
    }
  }

  private async calcular(
    usuario: UsuarioAutenticado,
    painel: PainelBi,
    dto: FiltroBiDto,
  ): Promise<PainelCalculado> {
    const filtro = await this.filtros.resolver(usuario, painel, dto);
    let conteudo: ConteudoDoPainel;
    switch (painel) {
      case 'marketing':
        conteudo = await this.marketing.calcular(usuario, filtro);
        break;
      case 'comercial':
        conteudo = await this.comercial.calcular(usuario, filtro);
        break;
      case 'cs':
        conteudo = await this.cs.calcular(usuario, filtro);
        break;
      case 'atendimento':
        conteudo = await this.atendimento.calcular(usuario, filtro);
        break;
      case 'financeiro':
        conteudo = await this.financeiro.calcular(usuario, filtro);
        break;
    }
    return {
      painel,
      periodo: {
        de: filtro.de.toISOString(),
        ate: filtro.ate.toISOString(),
      },
      anterior:
        filtro.anteriorDe && filtro.anteriorAte
          ? {
              de: filtro.anteriorDe.toISOString(),
              ate: filtro.anteriorAte.toISOString(),
            }
          : null,
      geradoEm: new Date().toISOString(),
      filtros: filtro.aplicados,
      ...conteudo,
    };
  }
}
