import { Injectable } from '@nestjs/common';
import { AuditoriaService } from '../auditoria/auditoria.service';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import { calcularAlteracoes } from '../comum/dados/sanitizar';
import { rotuloDaArea } from '../comum/dominio/papeis';
import {
  ConflitoException,
  DadosInvalidosException,
  NaoEncontradoException,
  RegraVioladaException,
  SemPermissaoException,
} from '../comum/erros/excecoes';
import type {
  Etapa,
  Funil,
  Prisma,
  TipoEtapa,
} from '../generated/prisma/client';
import { PrismaService, type Tx } from '../prisma/prisma.service';
import {
  type AlcanceNoFunil,
  type NivelNoFunil,
  podeConfigurarFunis,
} from './acesso-funis';
import {
  chaveDoAlvo,
  mudancaDeAcessos,
  resumoDosAcessos,
  validarAcessosPedidos,
} from './acessos-extras';
import {
  esquecerAcessosDaRequisicao,
  funisAcessiveis,
} from './acessos-no-banco';
import {
  AcessoDto,
  type AcessosDoFunilDto,
  INCLUIR_ALVO_DO_ACESSO,
  type SubstituirAcessosDto,
} from './dto/acessos.dto';
import {
  type AtualizarEtapaDto,
  type AtualizarFunilDto,
  type CriarEtapaDto,
  type CriarFunilDto,
  ETAPAS_POR_FUNIL_MAXIMO,
  EtapaDto,
  type FiltroFunisDto,
  FunilDto,
  type FunilParaDto,
  type ReordenarEtapasDto,
} from './dto/funis.dto';
import { garantirSetorAtivo } from '../setores/setores-no-banco';

type FunilComEtapas = FunilParaDto;

/** Etapas de um funil novo quando a lista não vem (R5.2). */
const ETAPAS_PADRAO: readonly { nome: string; tipo: TipoEtapa }[] = [
  { nome: 'Novo', tipo: 'ABERTA' },
  { nome: 'Em andamento', tipo: 'ABERTA' },
  { nome: 'Ganho', tipo: 'GANHO' },
  { nome: 'Perdido', tipo: 'PERDIDO' },
];

const ETAPAS_EM_ORDEM = {
  orderBy: [{ ordem: 'asc' }, { criadoEm: 'asc' }],
} satisfies Prisma.Funil$etapasArgs;

/** O funil como o `FunilDto` mostra: etapas em ordem e o nome do setor dono. */
const INCLUIR_FUNIL = {
  etapas: ETAPAS_EM_ORDEM,
  setor: { select: { nome: true } },
} satisfies Prisma.FunilInclude;

/** Mesmo nome, sem diferenciar maiúsculas nem espaços nas pontas. */
function mesmoNome(a: string, b: string): boolean {
  return (
    a.trim().toLocaleLowerCase('pt-BR') === b.trim().toLocaleLowerCase('pt-BR')
  );
}

/**
 * R5.2: todo funil tem ao menos uma etapa aberta, exatamente uma de ganho e
 * exatamente uma de perda. Lança 422 com as contagens quando não fecha.
 */
export function validarTiposDasEtapas(tipos: readonly TipoEtapa[]): void {
  const abertas = tipos.filter((tipo) => tipo === 'ABERTA').length;
  const ganho = tipos.filter((tipo) => tipo === 'GANHO').length;
  const perda = tipos.filter((tipo) => tipo === 'PERDIDO').length;
  if (abertas < 1 || ganho !== 1 || perda !== 1) {
    throw new RegraVioladaException(
      'R5.2',
      'Todo funil tem ao menos uma etapa aberta, exatamente uma de ganho e exatamente uma de perda.',
      { abertas, ganho, perda },
    );
  }
}

/**
 * Configuração de funis e etapas (R5.1, R5.2). Admin e C-level configuram
 * todos; o líder, os da sua área (criar funis extras, renomear, criar,
 * reordenar e excluir etapas). Os três funis-base não são excluídos — só
 * arquivados.
 */
@Injectable()
export class FunisService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditoria: AuditoriaService,
  ) {}

  /**
   * Funis que o usuário vê (R5.9, R5.11), em ordem: os do seu setor que a
   * visibilidade deixa e os de outros setores por acesso — cada um com o nível
   * dele (R5.12). Admin e C-level veem todos.
   */
  async listar(
    usuario: UsuarioAutenticado,
    filtro: FiltroFunisDto,
  ): Promise<FunilDto[]> {
    const acesso = await funisAcessiveis(this.prisma, usuario);
    const funis = await this.prisma.funil.findMany({
      where: {
        ...(acesso.todos ? {} : { id: { in: acesso.idsVisiveis() } }),
        ...(filtro.area ? { area: filtro.area } : {}),
        excluidoEm: null,
        ...(filtro.incluirArquivados ? {} : { ativo: true }),
      },
      include: INCLUIR_FUNIL,
      orderBy: [{ ordem: 'asc' }, { nome: 'asc' }],
    });
    return funis.map((funil) => {
      const alcance = acesso.alcance(funil.id) as AlcanceNoFunil;
      return FunilDto.de(funil, alcance.nivel, alcance.veTodos);
    });
  }

  async detalhar(usuario: UsuarioAutenticado, id: string): Promise<FunilDto> {
    const { funil, nivel, veTodos } = await this.carregarVisivel(
      this.prisma,
      usuario,
      id,
    );
    return FunilDto.de(funil, nivel, veTodos);
  }

  /** Cria um funil extra (nunca um funil-base: esses vêm da configuração inicial). */
  async criar(
    usuario: UsuarioAutenticado,
    dto: CriarFunilDto,
  ): Promise<FunilDto> {
    this.exigirConfiguracao(usuario, dto.area);
    const etapas =
      dto.etapas?.map((etapa) => ({
        nome: etapa.nome,
        tipo: etapa.tipo ?? 'ABERTA',
        prazoDias: etapa.prazoDias ?? null,
        probabilidade: etapa.probabilidade ?? null,
      })) ??
      ETAPAS_PADRAO.map((etapa) => ({
        ...etapa,
        prazoDias: null,
        probabilidade: null,
      }));
    validarTiposDasEtapas(etapas.map((etapa) => etapa.tipo));
    this.exigirNomesUnicos(etapas.map((etapa) => etapa.nome));
    const funil = await this.prisma.$transaction(async (tx) => {
      await garantirSetorAtivo(tx, dto.area);
      await this.exigirNomeLivre(tx, dto.area, dto.nome);
      const { _max } = await tx.funil.aggregate({ _max: { ordem: true } });
      const criado = await tx.funil.create({
        data: {
          nome: dto.nome,
          area: dto.area,
          visibilidade: dto.visibilidade ?? 'SETOR',
          base: false,
          ordem: (_max.ordem ?? 0) + 1,
          descricao: dto.descricao || null,
          etapas: {
            create: etapas.map((etapa, indice) => ({
              ...etapa,
              ordem: indice + 1,
            })),
          },
        },
        include: INCLUIR_FUNIL,
      });
      await this.auditoria.registrar(tx, {
        acao: 'funil.criado',
        entidade: 'funil',
        entidadeId: criado.id,
        resumo: `Funil ${criado.nome} criado no setor ${rotuloDaArea(criado.area)}`,
        dados: {
          area: criado.area,
          visibilidade: criado.visibilidade,
          etapas: criado.etapas.map((etapa) => ({
            nome: etapa.nome,
            tipo: etapa.tipo,
          })),
        },
      });
      return criado;
    });
    esquecerAcessosDaRequisicao();
    return FunilDto.de(funil, 'CONFIGURAR');
  }

  /** Renomeia, descreve, reordena, arquiva (`ativo: false`) ou reativa o funil. */
  async atualizar(
    usuario: UsuarioAutenticado,
    id: string,
    dto: AtualizarFunilDto,
  ): Promise<FunilDto> {
    const funil = await this.prisma.$transaction(async (tx) => {
      const antes = await this.carregarParaConfigurar(tx, usuario, id);
      if (dto.nome !== undefined && !mesmoNome(dto.nome, antes.nome)) {
        await this.exigirNomeLivre(tx, antes.area, dto.nome, antes.id);
      }
      if (dto.ativo === false && antes.ativo) {
        await this.exigirSemDependenciasDeEntrada(tx, antes, 'arquivar');
      }
      if (dto.ativo === true && !antes.ativo) {
        // R1.9: funil de setor desativado não volta a ficar ativo.
        await garantirSetorAtivo(tx, antes.area);
      }
      const depois = await tx.funil.update({
        where: { id },
        data: {
          ...(dto.nome !== undefined ? { nome: dto.nome } : {}),
          ...(dto.descricao !== undefined
            ? { descricao: dto.descricao || null }
            : {}),
          ...(dto.ordem !== undefined ? { ordem: dto.ordem } : {}),
          ...(dto.ativo !== undefined ? { ativo: dto.ativo } : {}),
          ...(dto.visibilidade !== undefined
            ? { visibilidade: dto.visibilidade }
            : {}),
        },
        include: INCLUIR_FUNIL,
      });
      const alteracoes = calcularAlteracoes(antes, depois, [
        'nome',
        'descricao',
        'ordem',
        'ativo',
        'visibilidade',
      ]);
      if (Object.keys(alteracoes).length > 0) {
        const arquivamento = 'ativo' in alteracoes;
        await this.auditoria.registrar(tx, {
          acao: arquivamento
            ? depois.ativo
              ? 'funil.reativado'
              : 'funil.arquivado'
            : 'funil.atualizado',
          entidade: 'funil',
          entidadeId: depois.id,
          resumo: arquivamento
            ? `Funil ${depois.nome} ${depois.ativo ? 'reativado' : 'arquivado'}`
            : `Funil ${depois.nome} atualizado (${Object.keys(alteracoes).join(', ')})`,
          dados: { alteracoes, visibilidade: depois.visibilidade },
        });
      }
      return depois;
    });
    esquecerAcessosDaRequisicao();
    return FunilDto.de(funil, 'CONFIGURAR');
  }

  /** Exclusão lógica de um funil extra (R5.1: os funis-base não são excluídos). */
  async excluir(usuario: UsuarioAutenticado, id: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const funil = await this.carregarParaConfigurar(tx, usuario, id);
      if (funil.base) {
        throw new RegraVioladaException(
          'R5.1',
          `O funil-base ${funil.nome} não pode ser excluído; ele pode ser só arquivado.`,
          { funilId: funil.id },
        );
      }
      const abertos = await tx.negocio.count({
        where: { funilId: funil.id, status: 'ABERTO', excluidoEm: null },
      });
      if (abertos > 0) {
        throw new RegraVioladaException(
          'R5.1',
          `O funil tem ${abertos} negócio(s) aberto(s): feche-os ou mova-os por uma passagem antes de excluir.`,
          { negociosAbertos: abertos },
        );
      }
      await this.exigirSemDependenciasDeEntrada(tx, funil, 'excluir', true);
      await tx.funil.update({
        where: { id: funil.id },
        data: { excluidoEm: new Date(), ativo: false },
      });
      await this.auditoria.registrar(tx, {
        acao: 'funil.excluido',
        entidade: 'funil',
        entidadeId: funil.id,
        resumo: `Funil ${funil.nome} excluído`,
        dados: { area: funil.area },
      });
    });
  }

  /** Cria uma etapa aberta (R5.2: o funil já tem a única de ganho e a única de perda). */
  async criarEtapa(
    usuario: UsuarioAutenticado,
    funilId: string,
    dto: CriarEtapaDto,
  ): Promise<FunilDto> {
    const funil = await this.prisma.$transaction(async (tx) => {
      const atual = await this.carregarParaConfigurar(tx, usuario, funilId);
      if (dto.tipo && dto.tipo !== 'ABERTA') {
        throw new RegraVioladaException(
          'R5.2',
          'O funil já tem a etapa de ganho e a de perda (exatamente uma de cada): novas etapas são abertas.',
          { tipo: dto.tipo },
        );
      }
      if (atual.etapas.length >= ETAPAS_POR_FUNIL_MAXIMO) {
        throw new RegraVioladaException(
          'R5.2',
          `Um funil tem no máximo ${ETAPAS_POR_FUNIL_MAXIMO} etapas.`,
        );
      }
      this.exigirNomeDeEtapaLivre(atual.etapas, dto.nome);
      const ultimaAberta = atual.etapas.reduce(
        (maior, etapa, indice) => (etapa.tipo === 'ABERTA' ? indice : maior),
        -1,
      );
      const posicao = Math.min(
        Math.max((dto.ordem ?? ultimaAberta + 2) - 1, 0),
        atual.etapas.length,
      );
      const etapa = await tx.etapa.create({
        data: {
          funilId: atual.id,
          nome: dto.nome,
          tipo: 'ABERTA',
          ordem: posicao + 1,
          prazoDias: dto.prazoDias ?? null,
          probabilidade: dto.probabilidade ?? null,
        },
      });
      const ordem = atual.etapas.map(({ id }) => id);
      ordem.splice(posicao, 0, etapa.id);
      await this.gravarOrdem(tx, [...atual.etapas, etapa], ordem);
      await this.auditoria.registrar(tx, {
        acao: 'etapa.criada',
        entidade: 'etapa',
        entidadeId: etapa.id,
        resumo: `Etapa ${etapa.nome} criada no funil ${atual.nome}`,
        dados: {
          ordem: posicao + 1,
          prazoDias: etapa.prazoDias,
          probabilidade: etapa.probabilidade,
        },
        relacionados: { funil: atual.id },
      });
      return this.recarregar(tx, atual.id);
    });
    return FunilDto.de(funil, 'CONFIGURAR');
  }

  /** Renomeia a etapa ou muda prazo-alvo e probabilidade (o tipo não muda). */
  async atualizarEtapa(
    usuario: UsuarioAutenticado,
    funilId: string,
    etapaId: string,
    dto: AtualizarEtapaDto,
  ): Promise<EtapaDto> {
    const etapa = await this.prisma.$transaction(async (tx) => {
      const funil = await this.carregarParaConfigurar(tx, usuario, funilId);
      const antes = funil.etapas.find(({ id }) => id === etapaId);
      if (!antes) {
        throw new NaoEncontradoException('Etapa não encontrada neste funil.');
      }
      if (dto.nome !== undefined && !mesmoNome(dto.nome, antes.nome)) {
        this.exigirNomeDeEtapaLivre(funil.etapas, dto.nome, antes.id);
      }
      const depois = await tx.etapa.update({
        where: { id: antes.id },
        data: {
          ...(dto.nome !== undefined ? { nome: dto.nome } : {}),
          ...(dto.prazoDias !== undefined ? { prazoDias: dto.prazoDias } : {}),
          ...(dto.probabilidade !== undefined
            ? { probabilidade: dto.probabilidade }
            : {}),
        },
      });
      const alteracoes = calcularAlteracoes(antes, depois, [
        'nome',
        'prazoDias',
        'probabilidade',
      ]);
      if (Object.keys(alteracoes).length > 0) {
        await this.auditoria.registrar(tx, {
          acao: 'etapa.atualizada',
          entidade: 'etapa',
          entidadeId: depois.id,
          resumo: `Etapa ${depois.nome} do funil ${funil.nome} atualizada (${Object.keys(alteracoes).join(', ')})`,
          dados: { alteracoes },
          relacionados: { funil: funil.id },
        });
      }
      return depois;
    });
    return EtapaDto.de(etapa);
  }

  /**
   * Exclui uma etapa aberta sem negócios (R5.2). A de ganho e a de perda não
   * saem (exatamente uma de cada), nem a última aberta; etapa usada por
   * passagem ou webhook de entrada também não.
   */
  async excluirEtapa(
    usuario: UsuarioAutenticado,
    funilId: string,
    etapaId: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const funil = await this.carregarParaConfigurar(tx, usuario, funilId);
      const etapa = funil.etapas.find(({ id }) => id === etapaId);
      if (!etapa) {
        throw new NaoEncontradoException('Etapa não encontrada neste funil.');
      }
      if (etapa.tipo !== 'ABERTA') {
        throw new RegraVioladaException(
          'R5.2',
          `A etapa de ${etapa.tipo === 'GANHO' ? 'ganho' : 'perda'} não pode ser excluída: todo funil tem exatamente uma.`,
          { etapaId, tipo: etapa.tipo },
        );
      }
      const abertas = funil.etapas.filter(({ tipo }) => tipo === 'ABERTA');
      if (abertas.length <= 1) {
        throw new RegraVioladaException(
          'R5.2',
          'Todo funil precisa de ao menos uma etapa aberta.',
          { etapaId },
        );
      }
      const negocios = await tx.negocio.count({
        where: { etapaId, excluidoEm: null },
      });
      const excluidos = await tx.negocio.count({
        where: { etapaId, excluidoEm: { not: null } },
      });
      if (negocios + excluidos > 0) {
        throw new RegraVioladaException(
          'R5.2',
          negocios > 0
            ? `Etapa com negócios não pode ser excluída: mova os ${negocios} negócio(s) antes.`
            : `Etapa com negócios não pode ser excluída: ela guarda ${excluidos} negócio(s) excluído(s).`,
          { negocios, negociosExcluidos: excluidos },
        );
      }
      const passagens = await tx.passagem.findMany({
        where: {
          OR: [{ etapaGatilhoId: etapaId }, { etapaDestinoId: etapaId }],
        },
        select: { id: true, nome: true },
      });
      if (passagens.length > 0) {
        throw new RegraVioladaException(
          'R5.7',
          `A etapa é usada pela(s) passagem(ns) ${passagens.map(({ nome }) => nome).join(', ')}: altere-as antes.`,
          { passagens },
        );
      }
      const webhooks = await tx.webhookEntrada.findMany({
        where: { etapaId },
        select: { id: true, nome: true },
      });
      if (webhooks.length > 0) {
        throw new RegraVioladaException(
          'R8.1',
          `A etapa é a entrada do(s) webhook(s) ${webhooks.map(({ nome }) => nome).join(', ')}: altere-os antes.`,
          { webhooks },
        );
      }
      await tx.etapa.delete({ where: { id: etapaId } });
      const restantes = funil.etapas.filter(({ id }) => id !== etapaId);
      await this.gravarOrdem(
        tx,
        restantes,
        restantes.map(({ id }) => id),
      );
      await this.auditoria.registrar(tx, {
        acao: 'etapa.excluida',
        entidade: 'etapa',
        entidadeId: etapaId,
        resumo: `Etapa ${etapa.nome} excluída do funil ${funil.nome}`,
        dados: { nome: etapa.nome, ordem: etapa.ordem },
        relacionados: { funil: funil.id },
      });
    });
  }

  /** Nova ordem das etapas: a lista precisa trazer todas, cada uma uma vez. */
  async reordenarEtapas(
    usuario: UsuarioAutenticado,
    funilId: string,
    dto: ReordenarEtapasDto,
  ): Promise<FunilDto> {
    const funil = await this.prisma.$transaction(async (tx) => {
      const atual = await this.carregarParaConfigurar(tx, usuario, funilId);
      const existentes = new Set(atual.etapas.map(({ id }) => id));
      const pedidas = dto.etapaIds.map((id) => id.toLowerCase());
      if (
        pedidas.length !== existentes.size ||
        pedidas.some((id) => !existentes.has(id))
      ) {
        throw new DadosInvalidosException(
          'Envie todas as etapas do funil, cada uma uma vez, na nova ordem.',
          {
            campos: [
              {
                campo: 'etapaIds',
                mensagens: ['deve ter exatamente as etapas do funil'],
              },
            ],
          },
        );
      }
      const antes = atual.etapas.map(({ nome }) => nome);
      await this.gravarOrdem(tx, atual.etapas, pedidas);
      const depois = await this.recarregar(tx, atual.id);
      await this.auditoria.registrar(tx, {
        acao: 'funil.etapas_reordenadas',
        entidade: 'funil',
        entidadeId: atual.id,
        resumo: `Etapas do funil ${atual.nome} reordenadas`,
        dados: {
          alteracoes: {
            etapas: { antes, depois: depois.etapas.map(({ nome }) => nome) },
          },
        },
      });
      return depois;
    });
    return FunilDto.de(funil, 'CONFIGURAR');
  }

  // -------------------------------------------------------------------------
  // Acessos extras do funil (R5.11)
  // -------------------------------------------------------------------------

  /** A lista de acessos do funil, para quem o configura (R5.1, R5.11). */
  async listarAcessos(
    usuario: UsuarioAutenticado,
    funilId: string,
  ): Promise<AcessosDoFunilDto> {
    const funil = await this.prisma.$transaction((tx) =>
      this.carregarParaConfigurar(tx, usuario, funilId),
    );
    return this.acessosDoFunil(this.prisma, funil);
  }

  /**
   * Troca a lista de acessos do funil pela enviada (R5.11): valida os alvos
   * (existem; os novos ativos; o setor dono não entra), grava só o que mudou e
   * audita a lista antes e depois (`funil.acessos_alterados`).
   */
  async substituirAcessos(
    usuario: UsuarioAutenticado,
    funilId: string,
    dto: SubstituirAcessosDto,
  ): Promise<AcessosDoFunilDto> {
    const resposta = await this.prisma.$transaction(async (tx) => {
      const funil = await this.carregarParaConfigurar(tx, usuario, funilId);
      const gravados = await tx.acessoFunil.findMany({
        where: { funilId: funil.id },
        select: { id: true, area: true, usuarioId: true, nivel: true },
      });
      const pedidos = await validarAcessosPedidos(
        tx,
        funil.area,
        dto.acessos,
        gravados,
      );
      const mudanca = mudancaDeAcessos(gravados, pedidos);
      if (mudanca.remover.length > 0) {
        await tx.acessoFunil.deleteMany({
          where: { id: { in: mudanca.remover } },
        });
      }
      for (const { id, nivel } of mudanca.atualizar) {
        await tx.acessoFunil.update({ where: { id }, data: { nivel } });
      }
      if (mudanca.criar.length > 0) {
        await tx.acessoFunil.createMany({
          data: mudanca.criar.map((acesso) => ({
            funilId: funil.id,
            area: acesso.area,
            usuarioId: acesso.usuarioId,
            nivel: acesso.nivel,
          })),
        });
      }
      const antes = resumoDosAcessos(gravados);
      const depois = resumoDosAcessos(pedidos);
      if (JSON.stringify(antes) !== JSON.stringify(depois)) {
        await this.auditoria.registrar(tx, {
          acao: 'funil.acessos_alterados',
          entidade: 'funil',
          entidadeId: funil.id,
          resumo: `Acessos do funil ${funil.nome} alterados (${depois.length} na lista)`,
          dados: {
            visibilidade: funil.visibilidade,
            alteracoes: { acessos: { antes, depois } },
            incluidos: mudanca.criar.map(chaveDoAlvo),
            removidos: gravados
              .filter(({ id }) => mudanca.remover.includes(id))
              .map(chaveDoAlvo),
          },
        });
      }
      return this.acessosDoFunil(tx, funil);
    });
    esquecerAcessosDaRequisicao();
    return resposta;
  }

  private async acessosDoFunil(
    db: Tx,
    funil: FunilComEtapas,
  ): Promise<AcessosDoFunilDto> {
    const acessos = await db.acessoFunil.findMany({
      where: { funilId: funil.id },
      include: INCLUIR_ALVO_DO_ACESSO,
      // Estável: as linhas gravadas juntas (mesmo PUT) têm o mesmo `criadoEm`.
      orderBy: [
        { criadoEm: 'asc' },
        { area: { sort: 'asc', nulls: 'last' } },
        { usuario: { nome: 'asc' } },
        { id: 'asc' },
      ],
    });
    return {
      funilId: funil.id,
      nome: funil.nome,
      area: funil.area,
      nomeSetor: funil.setor.nome,
      visibilidade: funil.visibilidade,
      acessos: acessos.map((acesso) => AcessoDto.de(acesso)),
    };
  }

  // -------------------------------------------------------------------------
  // Apoio
  // -------------------------------------------------------------------------

  private exigirConfiguracao(
    usuario: UsuarioAutenticado,
    area: Funil['area'],
  ): void {
    if (!podeConfigurarFunis(usuario, area)) {
      throw new SemPermissaoException(
        `Só o Admin, o C-level e o líder de ${rotuloDaArea(area)} configuram os funis dessa área.`,
        { regra: 'R5.1' },
      );
    }
  }

  /** O funil, se a pessoa o vê (R5.9, R5.11), com o nível dela — senão 404. */
  private async carregarVisivel(
    tx: Tx,
    usuario: UsuarioAutenticado,
    id: string,
  ): Promise<{
    funil: FunilComEtapas;
    nivel: NivelNoFunil;
    veTodos: boolean;
  }> {
    const funil = await tx.funil.findFirst({
      where: { id, excluidoEm: null },
      include: INCLUIR_FUNIL,
    });
    const alcance = funil
      ? (await funisAcessiveis(tx, usuario)).alcance(funil.id)
      : null;
    if (!funil || !alcance) {
      throw new NaoEncontradoException('Funil não encontrado.');
    }
    return { funil, nivel: alcance.nivel, veTodos: alcance.veTodos };
  }

  /**
   * Funil visível e configurável pelo usuário (R5.1: líder do setor dono,
   * C-level e Admin — os acessos extras não configuram), travado até o fim da
   * transação.
   */
  private async carregarParaConfigurar(
    tx: Tx,
    usuario: UsuarioAutenticado,
    id: string,
  ): Promise<FunilComEtapas> {
    await tx.$queryRaw`SELECT id FROM funis WHERE id = ${id}::uuid FOR UPDATE`;
    const { funil, nivel } = await this.carregarVisivel(tx, usuario, id);
    if (nivel !== 'CONFIGURAR') {
      throw new SemPermissaoException(
        `Só o Admin, o C-level e o líder de ${rotuloDaArea(funil.area)} configuram este funil.`,
        { regra: 'R5.1' },
      );
    }
    return funil;
  }

  private recarregar(tx: Tx, id: string): Promise<FunilComEtapas> {
    return tx.funil.findUniqueOrThrow({
      where: { id },
      include: INCLUIR_FUNIL,
    });
  }

  /** Grava `ordem` = posição na lista (1, 2, 3…), só nas etapas que mudaram. */
  private async gravarOrdem(
    tx: Tx,
    etapas: readonly Etapa[],
    ordem: readonly string[],
  ): Promise<void> {
    const atual = new Map(etapas.map((etapa) => [etapa.id, etapa.ordem]));
    for (const [indice, id] of ordem.entries()) {
      if (atual.get(id) !== indice + 1) {
        await tx.etapa.update({ where: { id }, data: { ordem: indice + 1 } });
      }
    }
  }

  private exigirNomesUnicos(nomes: readonly string[]): void {
    const vistos: string[] = [];
    for (const nome of nomes) {
      if (vistos.some((visto) => mesmoNome(visto, nome))) {
        throw new ConflitoException(
          `Duas etapas com o nome "${nome}": cada etapa do funil tem um nome.`,
          { nome },
        );
      }
      vistos.push(nome);
    }
  }

  private exigirNomeDeEtapaLivre(
    etapas: readonly Etapa[],
    nome: string,
    ignorarId?: string,
  ): void {
    if (
      etapas.some(
        (etapa) => etapa.id !== ignorarId && mesmoNome(etapa.nome, nome),
      )
    ) {
      throw new ConflitoException(
        `Já existe uma etapa chamada "${nome}" neste funil.`,
        { nome },
      );
    }
  }

  private async exigirNomeLivre(
    tx: Tx,
    area: Funil['area'],
    nome: string,
    ignorarId?: string,
  ): Promise<void> {
    const mesmos = await tx.funil.findMany({
      where: {
        area,
        excluidoEm: null,
        nome: { equals: nome.trim(), mode: 'insensitive' },
        ...(ignorarId ? { id: { not: ignorarId } } : {}),
      },
      select: { id: true },
    });
    if (mesmos.length > 0) {
      throw new ConflitoException(
        `Já existe um funil chamado "${nome}" na área ${rotuloDaArea(area)}.`,
        { nome },
      );
    }
  }

  /**
   * Um funil arquivado ou excluído não recebe negócios: antes, nenhuma passagem
   * ativa pode levar negócios para ele e nenhum webhook de entrada ativo pode
   * apontar para ele. Ao excluir, também nenhuma passagem ativa pode sair dele.
   */
  private async exigirSemDependenciasDeEntrada(
    tx: Tx,
    funil: Funil,
    acao: 'arquivar' | 'excluir',
    incluirOrigem = false,
  ): Promise<void> {
    const passagens = await tx.passagem.findMany({
      where: {
        ativa: true,
        OR: [
          { funilDestinoId: funil.id },
          ...(incluirOrigem ? [{ funilOrigemId: funil.id }] : []),
        ],
      },
      select: { id: true, nome: true },
    });
    if (passagens.length > 0) {
      throw new RegraVioladaException(
        'R5.7',
        `Não dá para ${acao} o funil ${funil.nome}: ele é usado pela(s) passagem(ns) ativa(s) ${passagens.map(({ nome }) => nome).join(', ')}. Desative-as antes.`,
        { passagens },
      );
    }
    const webhooks = await tx.webhookEntrada.findMany({
      where: { funilId: funil.id, ativo: true, excluidoEm: null },
      select: { id: true, nome: true },
    });
    if (webhooks.length > 0) {
      throw new RegraVioladaException(
        'R8.1',
        `Não dá para ${acao} o funil ${funil.nome}: ele recebe leads do(s) webhook(s) ${webhooks.map(({ nome }) => nome).join(', ')}. Desative-os antes.`,
        { webhooks },
      );
    }
  }
}
