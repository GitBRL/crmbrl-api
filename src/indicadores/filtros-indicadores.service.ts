import { Injectable } from '@nestjs/common';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import { ehDiretoria, setorDaPessoa } from '../comum/dominio/papeis';
import { normalizarEtiquetas } from '../comum/dominio/etiquetas';
import {
  DadosInvalidosException,
  NaoEncontradoException,
  SemPermissaoException,
} from '../comum/erros/excecoes';
import { funisAcessiveis } from '../funis/acessos-no-banco';
import { PrismaService } from '../prisma/prisma.service';
import { FiltrosBiService } from '../bi/filtros-bi.service';
import { resolverPeriodo } from '../bi/periodo';
import type { FiltroBiDto } from '../bi/dto/filtro-bi.dto';
import { REGRA_INDICADORES } from './indicadores.constantes';
import type { FiltroResolvido, FiltrosDoIndicador } from './indicadores.tipos';
import { intervaloDoPeriodo } from './periodos';

/**
 * Valida os filtros dos indicadores (R33.3) contra o papel e os resolve. Mesmas
 * regras do BI (R20.3): período de até 366 dias, filtro fora do alcance é
 * recusado e funil que a pessoa não vê responde como inexistente — o filtro
 * nunca amplia a visibilidade.
 */
@Injectable()
export class FiltrosIndicadoresService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly filtrosBi: FiltrosBiService,
  ) {}

  /** O funil é do setor da pessoa (ou ela é da diretoria) e visível a ela (R5.9)? Senão, 404. */
  async exigirFunilVisivel(
    usuario: UsuarioAutenticado,
    funilId: string,
  ): Promise<{ id: string; nome: string; area: string }> {
    const funil = await this.prisma.funil.findFirst({
      where: { id: funilId, excluidoEm: null },
      select: { id: true, nome: true, area: true },
    });
    if (
      !funil ||
      (!ehDiretoria(usuario.papel) && funil.area !== setorDaPessoa(usuario)) ||
      !(await funisAcessiveis(this.prisma, usuario)).podeVerFunil(funilId)
    ) {
      throw new NaoEncontradoException('Funil não encontrado.');
    }
    return funil;
  }

  /** A etapa pertence a um funil visível? Devolve o funil dela. */
  async exigirEtapaVisivel(
    usuario: UsuarioAutenticado,
    etapaId: string,
  ): Promise<{ id: string; funilId: string }> {
    const etapa = await this.prisma.etapa.findUnique({
      where: { id: etapaId },
      select: { id: true, funilId: true },
    });
    if (!etapa) {
      throw new NaoEncontradoException('Etapa não encontrada.');
    }
    try {
      await this.exigirFunilVisivel(usuario, etapa.funilId);
    } catch {
      throw new NaoEncontradoException('Etapa não encontrada.');
    }
    return etapa;
  }

  async resolver(
    usuario: UsuarioAutenticado,
    filtros: FiltrosDoIndicador,
    agora: Date = new Date(),
  ): Promise<FiltroResolvido> {
    const comparar = filtros.comparar ?? true;
    const periodo = filtros.periodo ?? { tipo: 'ULTIMOS_30_DIAS' as const };
    let de: string | undefined;
    let ate: string | undefined;
    if (periodo.tipo === 'PERSONALIZADO') {
      if (!periodo.de || !periodo.ate) {
        throw new DadosInvalidosException(
          'Informe o início e o fim do período.',
          {
            campos: [
              {
                campo: 'periodo',
                mensagens: [
                  '"de" e "ate" são obrigatórios no período personalizado',
                ],
              },
            ],
          },
        );
      }
      de = periodo.de;
      ate = periodo.ate;
    } else {
      const intervalo = intervaloDoPeriodo(periodo.tipo, agora);
      de = intervalo.de.toISOString();
      ate = intervalo.ate.toISOString();
    }
    const { atual, anterior } = resolverPeriodo(de, ate, comparar, agora);

    const areaDoUsuario = setorDaPessoa(usuario);
    let setor: string | null = null;
    if (filtros.setor) {
      if (ehDiretoria(usuario.papel)) {
        const existe = await this.prisma.setor.findUnique({
          where: { chave: filtros.setor },
          select: { chave: true },
        });
        if (!existe) {
          throw new NaoEncontradoException('Setor não encontrado.');
        }
      } else if (filtros.setor !== areaDoUsuario) {
        throw new SemPermissaoException(
          'Você só pode consultar o seu próprio setor.',
          { regra: REGRA_INDICADORES },
        );
      }
      setor = filtros.setor;
    }

    const pessoas = await this.pessoas(usuario, filtros);

    let funilIds: string[] | null = null;
    if (filtros.funilIds && filtros.funilIds.length > 0) {
      funilIds = [...new Set(filtros.funilIds)];
      for (const id of funilIds) {
        await this.exigirFunilVisivel(usuario, id);
      }
    }
    let etapaIds: string[] | null = null;
    if (filtros.etapaIds && filtros.etapaIds.length > 0) {
      etapaIds = [...new Set(filtros.etapaIds)];
      for (const id of etapaIds) {
        await this.exigirEtapaVisivel(usuario, id);
      }
    }
    const origens = filtros.origens?.length
      ? [...new Set(filtros.origens)]
      : null;
    const minusculas = (valores: string[] | undefined) =>
      valores && valores.length > 0
        ? [
            ...new Set(
              valores.map((v) => v.trim().toLowerCase()).filter(Boolean),
            ),
          ]
        : null;
    const etiquetas = normalizarEtiquetas(filtros.etiquetas ?? []);

    const resolvido: FiltroResolvido = {
      de: atual.de,
      ate: atual.ate,
      anteriorDe: anterior?.de ?? null,
      anteriorAte: anterior?.ate ?? null,
      comparar,
      pessoas,
      funilIds,
      etapaIds,
      setor,
      origens,
      utmSource: minusculas(filtros.utmSource),
      utmCampaign: minusculas(filtros.utmCampaign),
      etiquetas: etiquetas.length > 0 ? etiquetas : null,
      aplicados: {},
    };
    resolvido.aplicados = {
      periodo: { tipo: periodo.tipo, de, ate },
      comparar,
      funilIds,
      etapaIds,
      setor,
      equipeId: filtros.equipeId ?? null,
      pessoaIds: filtros.pessoaIds ?? null,
      origens,
      utmSource: resolvido.utmSource,
      utmCampaign: resolvido.utmCampaign,
      etiquetas: resolvido.etiquetas,
    };
    return resolvido;
  }

  /** Equipe (líder + liderados) e pessoas escolhidas; com os dois, a interseção. `null` = sem filtro. */
  private async pessoas(
    usuario: UsuarioAutenticado,
    filtros: FiltrosDoIndicador,
  ): Promise<string[] | null> {
    const equipe = filtros.equipeId
      ? await this.filtrosBi.pessoas(usuario, {
          equipeId: filtros.equipeId,
        } as FiltroBiDto)
      : null;
    const escolhidas = filtros.pessoaIds?.length
      ? [...new Set(filtros.pessoaIds)]
      : null;
    if (!escolhidas) {
      return equipe;
    }
    const encontradas = await this.prisma.usuario.findMany({
      where: { id: { in: escolhidas } },
      select: { id: true, papel: true, area: true },
    });
    const areaDoUsuario = setorDaPessoa(usuario);
    if (
      encontradas.length !== escolhidas.length ||
      (!ehDiretoria(usuario.papel) &&
        encontradas.some((pessoa) => setorDaPessoa(pessoa) !== areaDoUsuario))
    ) {
      throw new NaoEncontradoException('Pessoa não encontrada.');
    }
    return equipe ? escolhidas.filter((id) => equipe.includes(id)) : escolhidas;
  }
}

/** Junta filtros em ordem: o que vem depois vence, chave a chave (`undefined` não sobrescreve). */
export function mesclarFiltros(
  ...partes: (FiltrosDoIndicador | undefined | null)[]
): FiltrosDoIndicador {
  const resultado: Record<string, unknown> = {};
  for (const parte of partes) {
    for (const [chave, valor] of Object.entries(parte ?? {})) {
      if (valor !== undefined && valor !== null) {
        resultado[chave] = valor;
      }
    }
  }
  return resultado as FiltrosDoIndicador;
}
