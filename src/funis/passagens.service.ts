import { Injectable } from '@nestjs/common';
import { AuditoriaService } from '../auditoria/auditoria.service';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import { calcularAlteracoes } from '../comum/dados/sanitizar';
import {
  ConflitoException,
  NaoEncontradoException,
  RegraVioladaException,
  SemPermissaoException,
} from '../comum/erros/excecoes';
import type {
  EstrategiaDistribuicao,
  Etapa,
  Funil,
} from '../generated/prisma/client';
import { PrismaService, type Tx } from '../prisma/prisma.service';
import {
  podeConfigurarPassagens,
  podeSerResponsavelNaArea,
} from './acesso-funis';
import {
  type AtualizarPassagemDto,
  type CriarPassagemDto,
  INCLUIR_PASSAGEM,
  type PassagemCompleta,
  PassagemDto,
} from './dto/passagens.dto';

interface DefinicaoDePassagem {
  etapaGatilhoId: string;
  etapaDestinoId: string;
  estrategia: EstrategiaDistribuicao;
  responsavelFixoId: string | null;
}

type EtapaComFunil = Etapa & { funil: Funil };

/**
 * Configuração das passagens entre funis (R5.7; matriz: Admin e C-level). A
 * execução fica no `MotorDeNegociosService`, na transação da movimentação.
 *
 * Uma passagem liga a etapa-gatilho de um funil a uma etapa **aberta** de outro
 * funil, com a estratégia de distribuição do negócio criado (R5.8). Passagem
 * que já rodou não é excluída — desative-a (`ativa: false`): o histórico de
 * execuções é o que garante "uma única vez por negócio de origem".
 */
@Injectable()
export class PassagensService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditoria: AuditoriaService,
  ) {}

  async listar(usuario: UsuarioAutenticado): Promise<PassagemDto[]> {
    this.exigirPermissao(usuario);
    const passagens = await this.prisma.passagem.findMany({
      include: INCLUIR_PASSAGEM,
      orderBy: [{ criadoEm: 'asc' }, { id: 'asc' }],
    });
    return passagens.map((passagem) => PassagemDto.de(passagem));
  }

  async detalhar(
    usuario: UsuarioAutenticado,
    id: string,
  ): Promise<PassagemDto> {
    this.exigirPermissao(usuario);
    return PassagemDto.de(await this.carregar(this.prisma, id));
  }

  async criar(
    usuario: UsuarioAutenticado,
    dto: CriarPassagemDto,
  ): Promise<PassagemDto> {
    this.exigirPermissao(usuario);
    const passagem = await this.prisma.$transaction(async (tx) => {
      const definicao = await this.validar(tx, {
        etapaGatilhoId: dto.etapaGatilhoId,
        etapaDestinoId: dto.etapaDestinoId,
        estrategia: dto.estrategia ?? 'RODIZIO',
        responsavelFixoId: dto.responsavelFixoId ?? null,
      });
      const criada = await tx.passagem.create({
        data: {
          nome: dto.nome,
          funilOrigemId: definicao.gatilho.funilId,
          etapaGatilhoId: definicao.gatilho.id,
          funilDestinoId: definicao.destino.funilId,
          etapaDestinoId: definicao.destino.id,
          estrategia: definicao.estrategia,
          responsavelFixoId: definicao.responsavelFixoId,
          ativa: dto.ativa ?? true,
        },
        include: INCLUIR_PASSAGEM,
      });
      await this.auditoria.registrar(tx, {
        acao: 'passagem.criada',
        entidade: 'passagem',
        entidadeId: criada.id,
        resumo: `Passagem ${criada.nome} criada (${criada.funilOrigem.nome} / ${criada.etapaGatilho.nome} → ${criada.funilDestino.nome} / ${criada.etapaDestino.nome})`,
        dados: {
          gatilho: `${criada.funilOrigem.nome} / ${criada.etapaGatilho.nome}`,
          destino: `${criada.funilDestino.nome} / ${criada.etapaDestino.nome}`,
          estrategia: criada.estrategia,
          responsavelFixoId: criada.responsavelFixoId,
          ativa: criada.ativa,
        },
      });
      return criada;
    });
    return PassagemDto.de(passagem);
  }

  async atualizar(
    usuario: UsuarioAutenticado,
    id: string,
    dto: AtualizarPassagemDto,
  ): Promise<PassagemDto> {
    this.exigirPermissao(usuario);
    const passagem = await this.prisma.$transaction(async (tx) => {
      const antes = await this.carregar(tx, id);
      const estrategia = dto.estrategia ?? antes.estrategia;
      const responsavelFixoId =
        dto.responsavelFixoId === undefined
          ? antes.responsavelFixoId
          : dto.responsavelFixoId;
      const definicao = await this.validar(
        tx,
        {
          etapaGatilhoId: dto.etapaGatilhoId ?? antes.etapaGatilhoId,
          etapaDestinoId: dto.etapaDestinoId ?? antes.etapaDestinoId,
          estrategia,
          responsavelFixoId,
        },
        antes.id,
      );
      const depois = await tx.passagem.update({
        where: { id },
        data: {
          ...(dto.nome !== undefined ? { nome: dto.nome } : {}),
          ...(dto.ativa !== undefined ? { ativa: dto.ativa } : {}),
          funilOrigemId: definicao.gatilho.funilId,
          etapaGatilhoId: definicao.gatilho.id,
          funilDestinoId: definicao.destino.funilId,
          etapaDestinoId: definicao.destino.id,
          estrategia: definicao.estrategia,
          responsavelFixoId: definicao.responsavelFixoId,
        },
        include: INCLUIR_PASSAGEM,
      });
      const alteracoes = calcularAlteracoes(antes, depois, [
        'nome',
        'ativa',
        'etapaGatilhoId',
        'etapaDestinoId',
        'estrategia',
        'responsavelFixoId',
      ]);
      if (Object.keys(alteracoes).length > 0) {
        await this.auditoria.registrar(tx, {
          acao: 'passagem.atualizada',
          entidade: 'passagem',
          entidadeId: depois.id,
          resumo: `Passagem ${depois.nome} atualizada (${Object.keys(alteracoes).join(', ')})`,
          dados: { alteracoes },
        });
      }
      return depois;
    });
    return PassagemDto.de(passagem);
  }

  /** Só exclui passagem que nunca rodou; a que já rodou é desativada. */
  async excluir(usuario: UsuarioAutenticado, id: string): Promise<void> {
    this.exigirPermissao(usuario);
    await this.prisma.$transaction(async (tx) => {
      const passagem = await this.carregar(tx, id);
      if (passagem._count.execucoes > 0) {
        throw new RegraVioladaException(
          'R5.7',
          `A passagem ${passagem.nome} já rodou ${passagem._count.execucoes} vez(es): desative-a em vez de excluir (o histórico garante que ela não repita).`,
          { execucoes: passagem._count.execucoes },
        );
      }
      await tx.passagem.delete({ where: { id } });
      await this.auditoria.registrar(tx, {
        acao: 'passagem.excluida',
        entidade: 'passagem',
        entidadeId: id,
        resumo: `Passagem ${passagem.nome} excluída`,
        dados: {
          gatilho: `${passagem.funilOrigem.nome} / ${passagem.etapaGatilho.nome}`,
          destino: `${passagem.funilDestino.nome} / ${passagem.etapaDestino.nome}`,
        },
      });
    });
  }

  private exigirPermissao(usuario: UsuarioAutenticado): void {
    if (!podeConfigurarPassagens(usuario)) {
      throw new SemPermissaoException(
        'Só o Admin e o C-level configuram as passagens entre funis (R5.7).',
      );
    }
  }

  private async carregar(tx: Tx, id: string): Promise<PassagemCompleta> {
    const passagem = await tx.passagem.findUnique({
      where: { id },
      include: INCLUIR_PASSAGEM,
    });
    if (!passagem) {
      throw new NaoEncontradoException('Passagem não encontrada.');
    }
    return passagem;
  }

  private async etapaComFunil(
    tx: Tx,
    etapaId: string,
    papel: 'gatilho' | 'destino',
  ): Promise<EtapaComFunil> {
    const etapa = await tx.etapa.findUnique({
      where: { id: etapaId },
      include: { funil: true },
    });
    if (!etapa || etapa.funil.excluidoEm) {
      throw new RegraVioladaException(
        'R5.7',
        `A etapa ${papel === 'gatilho' ? 'gatilho' : 'de destino'} não existe ou o funil dela foi excluído.`,
        { etapaId },
      );
    }
    return etapa;
  }

  /**
   * Regras de uma passagem: liga funis diferentes (R5.4), entra numa etapa
   * aberta do destino, responsável fixo ativo e da área do destino, e não
   * repete outra passagem com o mesmo gatilho para o mesmo funil.
   */
  private async validar(
    tx: Tx,
    definicao: DefinicaoDePassagem,
    ignorarId?: string,
  ): Promise<{
    gatilho: EtapaComFunil;
    destino: EtapaComFunil;
    estrategia: EstrategiaDistribuicao;
    responsavelFixoId: string | null;
  }> {
    const gatilho = await this.etapaComFunil(
      tx,
      definicao.etapaGatilhoId,
      'gatilho',
    );
    const destino = await this.etapaComFunil(
      tx,
      definicao.etapaDestinoId,
      'destino',
    );
    if (gatilho.funilId === destino.funilId) {
      throw new RegraVioladaException(
        'R5.7',
        'A passagem liga funis diferentes: dentro do mesmo funil, o negócio é movido (R5.4).',
        { funilId: gatilho.funilId },
      );
    }
    if (destino.tipo !== 'ABERTA') {
      throw new RegraVioladaException(
        'R5.7',
        'O negócio criado pela passagem entra numa etapa aberta do funil de destino.',
        { etapaDestinoId: destino.id, tipo: destino.tipo },
      );
    }
    let responsavelFixoId: string | null = null;
    if (definicao.estrategia === 'RESPONSAVEL_FIXO') {
      if (!definicao.responsavelFixoId) {
        throw new RegraVioladaException(
          'R5.8',
          'Informe o responsável fixo da passagem.',
          { estrategia: definicao.estrategia },
        );
      }
      const responsavel = await tx.usuario.findUnique({
        where: { id: definicao.responsavelFixoId },
        select: { id: true, ativo: true, papel: true },
      });
      if (
        !responsavel ||
        !responsavel.ativo ||
        !podeSerResponsavelNaArea(responsavel.papel, destino.funil.area)
      ) {
        throw new RegraVioladaException(
          'R5.8',
          'O responsável fixo precisa ser um usuário ativo da área do funil de destino (ou C-level/Admin).',
          { responsavelFixoId: definicao.responsavelFixoId },
        );
      }
      responsavelFixoId = responsavel.id;
    }
    const repetida = await tx.passagem.findFirst({
      where: {
        etapaGatilhoId: gatilho.id,
        funilDestinoId: destino.funilId,
        ...(ignorarId ? { id: { not: ignorarId } } : {}),
      },
      select: { id: true, nome: true },
    });
    if (repetida) {
      throw new ConflitoException(
        `Já existe a passagem ${repetida.nome} deste gatilho para o funil ${destino.funil.nome}.`,
        { passagemId: repetida.id },
      );
    }
    return {
      gatilho,
      destino,
      estrategia: definicao.estrategia,
      responsavelFixoId,
    };
  }
}
