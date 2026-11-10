import { Injectable } from '@nestjs/common';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import { ehDiretoria, ehLider, setorDaPessoa } from '../comum/dominio/papeis';
import {
  DadosInvalidosException,
  NaoEncontradoException,
  SemPermissaoException,
} from '../comum/erros/excecoes';
import { PrismaService } from '../prisma/prisma.service';
import { REGRA_BI } from './bi.constantes';
import type { FiltroResolvido, PainelBi } from './bi.tipos';
import type { FiltroBiDto } from './dto/filtro-bi.dto';
import { areaDoPainel } from './escopo-bi';
import { resolverPeriodo } from './periodo';

/**
 * Valida os filtros comuns contra o papel e os resolve (período, pessoas, funil,
 * canal, fila). Filtro fora do alcance de quem pede é recusado ou, quando
 * revelaria a existência de algo, tratado como "não encontrado" (R1, R20).
 */
@Injectable()
export class FiltrosBiService {
  constructor(private readonly prisma: PrismaService) {}

  async resolver(
    usuario: UsuarioAutenticado,
    painel: PainelBi,
    dto: FiltroBiDto,
    agora: Date = new Date(),
  ): Promise<FiltroResolvido> {
    const comparar = dto.comparar ?? true;
    const { atual, anterior } = resolverPeriodo(
      dto.de,
      dto.ate,
      comparar,
      agora,
    );
    const areaDoUsuario = setorDaPessoa(usuario);
    if (dto.area && !ehDiretoria(usuario.papel) && dto.area !== areaDoUsuario) {
      throw new SemPermissaoException(
        'Você só pode consultar o seu próprio setor.',
        { regra: REGRA_BI },
      );
    }
    const pessoas = await this.pessoas(usuario, dto);
    const areaDoPainelAtual = areaDoPainel(painel);
    const funilId = await this.funil(painel, areaDoPainelAtual, dto.funilId);
    const canalId = await this.canal(painel, dto.canalId);
    const filaId = await this.fila(painel, dto.filaId);
    const area =
      painel === 'marketing' || painel === 'atendimento' || painel === 'sdr'
        ? (dto.area ?? null)
        : areaDoPainelAtual;
    return {
      de: atual.de,
      ate: atual.ate,
      anteriorDe: anterior?.de ?? null,
      anteriorAte: anterior?.ate ?? null,
      area,
      pessoas,
      funilId,
      canalId,
      filaId,
      aplicados: {
        area,
        equipeId: dto.equipeId ?? null,
        pessoaId: dto.pessoaId ?? null,
        funilId,
        canalId,
        filaId,
        comparar,
      },
    };
  }

  /** Equipe (líder + liderados) e pessoa; com os dois, a interseção. `null` = sem filtro. */
  private async pessoas(
    usuario: UsuarioAutenticado,
    dto: FiltroBiDto,
  ): Promise<string[] | null> {
    const areaDoUsuario = setorDaPessoa(usuario);
    let equipe: string[] | null = null;
    if (dto.equipeId) {
      const lider = await this.prisma.usuario.findUnique({
        where: { id: dto.equipeId },
        select: {
          id: true,
          papel: true,
          area: true,
          liderados: { select: { id: true } },
        },
      });
      if (!lider || !ehLider(lider.papel)) {
        throw new DadosInvalidosException(
          'Equipe inválida: informe um líder.',
          {
            campos: [{ campo: 'equipeId', mensagens: ['não é um líder'] }],
          },
        );
      }
      if (
        !ehDiretoria(usuario.papel) &&
        setorDaPessoa(lider) !== areaDoUsuario
      ) {
        throw new SemPermissaoException(
          'Você só pode consultar equipes do seu setor.',
          { regra: REGRA_BI },
        );
      }
      equipe = [lider.id, ...lider.liderados.map((liderado) => liderado.id)];
    }
    if (!dto.pessoaId) {
      return equipe;
    }
    const pessoa = await this.prisma.usuario.findUnique({
      where: { id: dto.pessoaId },
      select: { id: true, papel: true, area: true },
    });
    if (
      !pessoa ||
      (!ehDiretoria(usuario.papel) && setorDaPessoa(pessoa) !== areaDoUsuario)
    ) {
      throw new NaoEncontradoException('Pessoa não encontrada.');
    }
    return equipe ? equipe.filter((id) => id === pessoa.id) : [pessoa.id];
  }

  private async funil(
    painel: PainelBi,
    areaDoPainelAtual: ReturnType<typeof areaDoPainel>,
    funilId: string | undefined,
  ): Promise<string | null> {
    if (
      !funilId ||
      painel === 'atendimento' ||
      painel === 'sdr' ||
      painel === 'financeiro'
    ) {
      return null;
    }
    const funil = await this.prisma.funil.findFirst({
      where: { id: funilId, excluidoEm: null },
      select: { area: true },
    });
    if (!funil || funil.area !== areaDoPainelAtual) {
      throw new NaoEncontradoException('Funil não encontrado.');
    }
    return funilId;
  }

  private async canal(
    painel: PainelBi,
    canalId: string | undefined,
  ): Promise<string | null> {
    if (
      !canalId ||
      (painel !== 'marketing' && painel !== 'atendimento' && painel !== 'sdr')
    ) {
      return null;
    }
    const canal = await this.prisma.canal.findFirst({
      where: { id: canalId },
      select: { id: true },
    });
    if (!canal) {
      throw new NaoEncontradoException('Canal não encontrado.');
    }
    return canalId;
  }

  private async fila(
    painel: PainelBi,
    filaId: string | undefined,
  ): Promise<string | null> {
    if (!filaId || (painel !== 'atendimento' && painel !== 'sdr')) {
      return null;
    }
    const fila = await this.prisma.filaAtendimento.findFirst({
      where: { id: filaId },
      select: { id: true },
    });
    if (!fila) {
      throw new NaoEncontradoException('Fila não encontrada.');
    }
    return filaId;
  }
}
