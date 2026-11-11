import { Injectable } from '@nestjs/common';
import { AuditoriaService } from '../auditoria/auditoria.service';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import { calcularAlteracoes } from '../comum/dados/sanitizar';
import {
  ehDiretoria,
  ehDoSetor,
  ehLiderDoSetor,
  ehMembro,
  rotuloDaArea,
} from '../comum/dominio/papeis';
import {
  NaoEncontradoException,
  RegraVioladaException,
  SemPermissaoException,
} from '../comum/erros/excecoes';
import type { FilaAtendimento } from '../generated/prisma/client';
import { PrismaService, type Tx } from '../prisma/prisma.service';
import { REGRA_ATENDIMENTO } from './atendimento.constantes';
import { exigirAtendimento } from './conversas.service';
import { DistribuicaoDaFila } from './distribuicao-fila.service';
import { PessoaDto, ResumoCanalDto } from './dto/comum.dto';
import type {
  AtualizarFilaDto,
  CriarFilaDto,
  DefinirParticipacaoNaFilaDto,
  FilaDto,
  FiltroFilasDto,
} from './dto/fila.dto';
import { garantirSetorDoAtendimento } from './setor-do-atendimento';
import type { Area } from '../comum/dominio/setores';

/** Quem configura as filas de um setor: Admin, C-level e o líder do setor. */
export function podeConfigurarArea(
  usuario: Pick<UsuarioAutenticado, 'papel' | 'area'>,
  area: Area | null,
): boolean {
  if (ehDiretoria(usuario.papel)) {
    return true;
  }
  return area !== null && ehLiderDoSetor(usuario, area);
}

const CAMPOS_AUDITADOS = [
  'nome',
  'area',
  'descricao',
  'slaPrimeiraRespostaMinutos',
  'slaResolucaoMinutos',
  'estrategia',
  'ativa',
] as const;

/**
 * Filas de atendimento (R12): SLA, estratégia de distribuição e
 * participantes. Todos que usam o Atendimento listam (para filtrar e
 * transferir); configuram Admin, C-level e o líder da área da fila.
 */
@Injectable()
export class FilasService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditoria: AuditoriaService,
    private readonly distribuicao: DistribuicaoDaFila,
  ) {}

  async listar(
    usuario: UsuarioAutenticado,
    filtro: FiltroFilasDto,
  ): Promise<FilaDto[]> {
    exigirAtendimento(usuario);
    const filas = await this.prisma.filaAtendimento.findMany({
      where: {
        excluidoEm: null,
        ...(filtro.area ? { area: filtro.area } : {}),
        ...(filtro.incluirInativas ? {} : { ativa: true }),
      },
      orderBy: [{ setor: { ordem: 'asc' } }, { nome: 'asc' }, { id: 'asc' }],
    });
    return Promise.all(
      filas.map((fila) => this.montar(this.prisma, usuario, fila)),
    );
  }

  async detalhar(usuario: UsuarioAutenticado, id: string): Promise<FilaDto> {
    exigirAtendimento(usuario);
    const fila = await this.obter(this.prisma, id);
    return this.montar(this.prisma, usuario, fila);
  }

  async criar(
    usuario: UsuarioAutenticado,
    dto: CriarFilaDto,
  ): Promise<FilaDto> {
    this.exigirConfigurar(usuario, dto.area);
    const fila = await this.prisma.$transaction(async (tx) => {
      await garantirSetorDoAtendimento(tx, dto.area);
      const participantes = dto.participantes?.length
        ? await this.validarParticipantes(tx, dto.area, dto.participantes)
        : [];
      const criada = await tx.filaAtendimento.create({
        data: {
          nome: dto.nome,
          area: dto.area,
          descricao: dto.descricao ?? null,
          slaPrimeiraRespostaMinutos: dto.slaPrimeiraRespostaMinutos ?? null,
          slaResolucaoMinutos: dto.slaResolucaoMinutos ?? null,
          estrategia: dto.estrategia ?? 'RODIZIO',
          ativa: dto.ativa ?? true,
          participantes: participantes.length
            ? { create: participantes.map((usuarioId) => ({ usuarioId })) }
            : undefined,
        },
      });
      await this.auditoria.registrar(tx, {
        acao: 'fila_atendimento.criada',
        entidade: 'fila_atendimento',
        entidadeId: criada.id,
        resumo: `Fila de atendimento "${criada.nome}" criada (${rotuloDaArea(criada.area)})`,
        dados: {
          alteracoes: calcularAlteracoes({}, criada, CAMPOS_AUDITADOS),
          participantes,
        },
      });
      return criada;
    });
    return this.montar(this.prisma, usuario, fila);
  }

  async atualizar(
    usuario: UsuarioAutenticado,
    id: string,
    dto: AtualizarFilaDto,
  ): Promise<FilaDto> {
    const fila = await this.prisma.$transaction(async (tx) => {
      const antes = await this.travar(tx, id);
      this.exigirConfigurar(usuario, antes.area);
      const area = dto.area ?? antes.area;
      if (area !== antes.area) {
        this.exigirConfigurar(usuario, area);
        await garantirSetorDoAtendimento(tx, area);
        const emAberto = await tx.conversa.count({
          where: { filaId: id, status: { not: 'RESOLVIDA' } },
        });
        if (emAberto > 0) {
          throw new RegraVioladaException(
            REGRA_ATENDIMENTO,
            `A fila tem ${emAberto === 1 ? '1 conversa' : `${emAberto} conversas`} em aberto: transfira ou resolva antes de mudar a área.`,
            { motivo: 'fila_com_conversas', conversas: emAberto },
          );
        }
        // A lista era da área antiga: começa vazia na nova.
        await tx.filaParticipante.deleteMany({ where: { filaId: id } });
      } else if (dto.ativa === true && !antes.ativa) {
        // R1.9: fila de setor desativado não volta a ficar ativa.
        await garantirSetorDoAtendimento(tx, area);
      }
      const depois = await tx.filaAtendimento.update({
        where: { id },
        data: {
          ...(dto.nome !== undefined ? { nome: dto.nome } : {}),
          area,
          ...(dto.descricao !== undefined ? { descricao: dto.descricao } : {}),
          ...(dto.slaPrimeiraRespostaMinutos !== undefined
            ? { slaPrimeiraRespostaMinutos: dto.slaPrimeiraRespostaMinutos }
            : {}),
          ...(dto.slaResolucaoMinutos !== undefined
            ? { slaResolucaoMinutos: dto.slaResolucaoMinutos }
            : {}),
          ...(dto.estrategia !== undefined
            ? { estrategia: dto.estrategia }
            : {}),
          ...(dto.ativa !== undefined ? { ativa: dto.ativa } : {}),
          ...(area !== antes.area ? { ultimoUsuarioId: null } : {}),
        },
      });
      let participantes: string[] | undefined;
      if (dto.participantes !== undefined) {
        participantes = await this.validarParticipantes(
          tx,
          area,
          dto.participantes,
        );
        await this.definirLista(tx, id, participantes);
      }
      const alteracoes = calcularAlteracoes(antes, depois, CAMPOS_AUDITADOS);
      if (Object.keys(alteracoes).length > 0 || participantes !== undefined) {
        await this.auditoria.registrar(tx, {
          acao: 'fila_atendimento.atualizada',
          entidade: 'fila_atendimento',
          entidadeId: id,
          resumo: `Fila de atendimento "${depois.nome}" alterada`,
          dados: { alteracoes, ...(participantes ? { participantes } : {}) },
        });
      }
      return depois;
    });
    return this.montar(this.prisma, usuario, fila);
  }

  /**
   * Exclusão lógica. 422 com conversas em aberto na fila; os canais que a
   * tinham como padrão ficam sem fila padrão.
   */
  async excluir(usuario: UsuarioAutenticado, id: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const fila = await this.travar(tx, id);
      this.exigirConfigurar(usuario, fila.area);
      const emAberto = await tx.conversa.count({
        where: { filaId: id, status: { not: 'RESOLVIDA' } },
      });
      if (emAberto > 0) {
        throw new RegraVioladaException(
          REGRA_ATENDIMENTO,
          `A fila tem ${emAberto === 1 ? '1 conversa' : `${emAberto} conversas`} em aberto: transfira ou resolva antes de excluir.`,
          { motivo: 'fila_com_conversas', conversas: emAberto },
        );
      }
      const canais = await tx.canal.findMany({
        where: { filaPadraoId: id },
        select: { id: true, nome: true },
      });
      await tx.canal.updateMany({
        where: { filaPadraoId: id },
        data: { filaPadraoId: null },
      });
      await tx.filaAtendimento.update({
        where: { id },
        data: { excluidoEm: new Date(), ativa: false },
      });
      await this.auditoria.registrar(tx, {
        acao: 'fila_atendimento.excluida',
        entidade: 'fila_atendimento',
        entidadeId: id,
        resumo: `Fila de atendimento "${fila.nome}" excluída${canais.length ? ` (canais sem fila padrão: ${canais.map((canal) => canal.nome).join(', ')})` : ''}`,
        dados: { canaisSemFila: canais.map((canal) => canal.id) },
      });
    });
  }

  /**
   * Põe ou tira alguém da distribuição. Na fila que vale para a área inteira:
   * `false` retira a pessoa; `true` devolve um membro retirado — e, para um
   * líder, transforma a área numa lista (os membros de agora + o líder).
   */
  async definirParticipacao(
    usuario: UsuarioAutenticado,
    filaId: string,
    usuarioId: string,
    dto: DefinirParticipacaoNaFilaDto,
  ): Promise<FilaDto> {
    const fila = await this.prisma.$transaction(async (tx) => {
      const fila = await this.travar(tx, filaId);
      this.exigirConfigurar(usuario, fila.area);
      const pessoa = await this.pessoaDaArea(tx, fila.area, usuarioId);
      const { participantes } = await this.distribuicao.situacao(tx, fila);
      if (!dto.participa) {
        await tx.filaParticipante.upsert({
          where: { filaId_usuarioId: { filaId, usuarioId } },
          create: { filaId, usuarioId, participa: false },
          update: { participa: false },
        });
      } else if (participantes.modo === 'LISTA') {
        await tx.filaParticipante.upsert({
          where: { filaId_usuarioId: { filaId, usuarioId } },
          create: { filaId, usuarioId, participa: true },
          update: { participa: true },
        });
      } else if (ehMembro(pessoa.papel)) {
        await tx.filaParticipante.deleteMany({ where: { filaId, usuarioId } });
      } else {
        const membros = participantes.pessoas
          .filter(
            (item) =>
              ehMembro(item.usuario.papel) && item.motivo !== 'RETIRADO',
          )
          .map((item) => item.usuario.id);
        await this.definirLista(tx, filaId, [...membros, usuarioId]);
      }
      await this.auditoria.registrar(tx, {
        acao: 'fila_atendimento.atualizada',
        entidade: 'fila_atendimento',
        entidadeId: filaId,
        resumo: `${pessoa.nome} ${dto.participa ? 'incluído(a) na' : 'retirado(a) da'} distribuição da fila "${fila.nome}"`,
        dados: { usuarioId, participa: dto.participa },
        relacionados: { usuario: usuarioId },
      });
      return fila;
    });
    return this.montar(this.prisma, usuario, fila);
  }

  /** Desfaz o ajuste da pessoa (volta a seguir a regra da fila). */
  async removerAjuste(
    usuario: UsuarioAutenticado,
    filaId: string,
    usuarioId: string,
  ): Promise<FilaDto> {
    const fila = await this.prisma.$transaction(async (tx) => {
      const fila = await this.travar(tx, filaId);
      this.exigirConfigurar(usuario, fila.area);
      const { count } = await tx.filaParticipante.deleteMany({
        where: { filaId, usuarioId },
      });
      if (count === 0) {
        throw new NaoEncontradoException('Esta pessoa não tem ajuste na fila.');
      }
      await this.auditoria.registrar(tx, {
        acao: 'fila_atendimento.atualizada',
        entidade: 'fila_atendimento',
        entidadeId: filaId,
        resumo: `Ajuste de participação desfeito na fila "${fila.nome}"`,
        dados: { usuarioId, ajusteRemovido: true },
        relacionados: { usuario: usuarioId },
      });
      return fila;
    });
    return this.montar(this.prisma, usuario, fila);
  }

  // -------------------------------------------------------------------------

  private exigirConfigurar(usuario: UsuarioAutenticado, area: Area): void {
    exigirAtendimento(usuario);
    if (!podeConfigurarArea(usuario, area)) {
      throw new SemPermissaoException(
        `Só Admin, C-level e o líder de ${rotuloDaArea(area)} configuram as filas dessa área.`,
        { regra: REGRA_ATENDIMENTO },
      );
    }
  }

  private async obter(
    tx: Tx | PrismaService,
    id: string,
  ): Promise<FilaAtendimento> {
    const fila = await tx.filaAtendimento.findFirst({
      where: { id, excluidoEm: null },
    });
    if (!fila) {
      throw new NaoEncontradoException('Fila não encontrada.');
    }
    return fila;
  }

  private async travar(tx: Tx, id: string): Promise<FilaAtendimento> {
    await tx.$queryRaw`SELECT id FROM filas_atendimento WHERE id = ${id}::uuid FOR UPDATE`;
    return this.obter(tx, id);
  }

  private async pessoaDaArea(tx: Tx, area: Area, usuarioId: string) {
    const pessoa = await tx.usuario.findUnique({
      where: { id: usuarioId },
      select: { id: true, nome: true, papel: true, area: true, ativo: true },
    });
    if (!pessoa) {
      throw new NaoEncontradoException('Pessoa não encontrada.');
    }
    if (!pessoa.ativo || !ehDoSetor(pessoa, area)) {
      throw new RegraVioladaException(
        REGRA_ATENDIMENTO,
        `${pessoa.nome} não é uma pessoa ativa de ${rotuloDaArea(area)}.`,
        { motivo: 'fora_da_area' },
      );
    }
    return pessoa;
  }

  /** Os participantes informados são pessoas ativas da área? (Sem repetidos.) */
  private async validarParticipantes(
    tx: Tx,
    area: Area,
    ids: readonly string[],
  ): Promise<string[]> {
    const unicos = [...new Set(ids)];
    if (unicos.length === 0) {
      return [];
    }
    const pessoas = await tx.usuario.findMany({
      where: {
        id: { in: unicos },
        ativo: true,
        area,
      },
      select: { id: true },
    });
    const validos = new Set(pessoas.map((pessoa) => pessoa.id));
    const fora = unicos.filter((id) => !validos.has(id));
    if (fora.length > 0) {
      throw new RegraVioladaException(
        REGRA_ATENDIMENTO,
        `Os participantes precisam ser pessoas ativas de ${rotuloDaArea(area)}.`,
        { motivo: 'fora_da_area', usuarios: fora },
      );
    }
    return unicos;
  }

  /** A lista da fila passa a ser exatamente `usuarios` (vazia = a área inteira). */
  private async definirLista(
    tx: Tx,
    filaId: string,
    usuarios: readonly string[],
  ): Promise<void> {
    await tx.filaParticipante.deleteMany({
      where: {
        filaId,
        participa: true,
        usuarioId: { notIn: [...usuarios] },
      },
    });
    for (const usuarioId of usuarios) {
      await tx.filaParticipante.upsert({
        where: { filaId_usuarioId: { filaId, usuarioId } },
        create: { filaId, usuarioId, participa: true },
        update: { participa: true },
      });
    }
  }

  private async montar(
    tx: Tx | PrismaService,
    usuario: UsuarioAutenticado,
    fila: FilaAtendimento,
  ): Promise<FilaDto> {
    const [situacao, canais, emAberto, semResponsavel] = await Promise.all([
      this.distribuicao.situacao(tx, fila),
      tx.canal.findMany({
        where: { filaPadraoId: fila.id, excluidoEm: null },
        select: { id: true, tipo: true, nome: true, ativo: true },
        orderBy: { nome: 'asc' },
      }),
      tx.conversa.count({
        where: { filaId: fila.id, status: { not: 'RESOLVIDA' } },
      }),
      tx.conversa.count({
        where: {
          filaId: fila.id,
          status: { not: 'RESOLVIDA' },
          responsavelId: null,
        },
      }),
    ]);
    return {
      id: fila.id,
      chave: fila.chave,
      nome: fila.nome,
      area: fila.area,
      descricao: fila.descricao,
      slaPrimeiraRespostaMinutos: fila.slaPrimeiraRespostaMinutos,
      slaResolucaoMinutos: fila.slaResolucaoMinutos,
      estrategia: fila.estrategia,
      ativa: fila.ativa,
      modoParticipantes: situacao.participantes.modo,
      pessoas: situacao.participantes.pessoas.map((pessoa) => ({
        ...PessoaDto.de(pessoa.usuario),
        papel: pessoa.usuario.papel,
        participa: pessoa.participa,
        motivo: pessoa.motivo,
        emAberto: situacao.cargas.get(pessoa.usuario.id) ?? 0,
      })),
      proximo: PessoaDto.ouNulo(situacao.proximo),
      canais: canais.map((canal) => ResumoCanalDto.de(canal)),
      conversasEmAberto: emAberto,
      conversasSemResponsavel: semResponsavel,
      podeEditar: podeConfigurarArea(usuario, fila.area),
      criadoEm: fila.criadoEm.toISOString(),
      atualizadoEm: fila.atualizadoEm.toISOString(),
    };
  }
}
