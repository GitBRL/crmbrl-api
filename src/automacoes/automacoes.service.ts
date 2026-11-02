import { Injectable } from '@nestjs/common';
import { AuditoriaService } from '../auditoria/auditoria.service';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import { calcularAlteracoes } from '../comum/dados/sanitizar';
import {
  DadosInvalidosException,
  NaoEncontradoException,
  RegraVioladaException,
  SemPermissaoException,
} from '../comum/erros/excecoes';
import {
  CAMPOS_DE_DATA_RELATIVA,
  type DataRelativa,
  type Recorrencia,
} from '../comum/gatilhos/agenda';
import { CATALOGO_DE_GATILHOS } from '../comum/gatilhos/catalogo';
import { montarPagina, paraSkipTake } from '../comum/paginacao/paginacao';
import type { DefinicaoDePassos } from '../comum/passos/definicao';
import { PassosService } from '../comum/passos/passos.service';
import type {
  Area,
  Automacao,
  LimiteExecucao,
  Prisma,
  TipoGatilhoAutomacao,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AgendasDeAutomacao } from './agendas-de-automacao.service';
import {
  CRITERIOS_DE_PARADA,
  REGRA_AUTOMACOES,
  TIPOS_DE_PASSO_DE_AUTOMACAO,
} from './automacoes.constantes';
import {
  AtualizarAutomacaoDto,
  CriarAutomacaoDto,
  CriarDeModeloProntoDto,
  FiltroAutomacoesDto,
} from './automacoes.dto';
import { conferirCondicoes } from './condicoes';
import { conferirGatilho, gatilhoDoCatalogo } from './gatilho-config';
import {
  type EntidadeDeAutomacao,
  IniciadorDeExecucao,
} from './iniciador-de-execucao.service';
import { MODELOS_PRONTOS, modeloPronto } from './modelos-prontos';
import {
  areaDaNovaAutomacao,
  marketingDaNovaAutomacao,
  filtroDeAutomacoesVisiveis,
  podeGerenciarAutomacao,
  podeUsarAutomacoes,
} from './permissoes-automacoes';

const CAMPOS_AUDITADOS = [
  'nome',
  'descricao',
  'area',
  'ativa',
  'tipoGatilho',
  'evento',
  'gatilhoConfig',
  'entidade',
  'condicoes',
  'definicao',
  'criteriosParada',
  'limiteExecucao',
  'limitePeriodoDias',
  'marketing',
] as const;

/** Campos que, mudando, geram uma nova versão (execuções em andamento seguem na antiga). */
const CAMPOS_DA_VERSAO = [
  'tipoGatilho',
  'evento',
  'gatilhoConfig',
  'entidade',
  'condicoes',
  'definicao',
  'criteriosParada',
  'limiteExecucao',
  'limitePeriodoDias',
  'marketing',
] as const;

export interface AutomacaoDto {
  id: string;
  nome: string;
  descricao: string | null;
  area: Area | null;
  ativa: boolean;
  tipoGatilho: TipoGatilhoAutomacao;
  evento: string | null;
  /** Rótulo legível do gatilho (catálogo, data relativa ou recorrência). */
  gatilhoRotulo: string;
  gatilhoConfig: unknown;
  entidade: string;
  condicoes: unknown;
  definicao: unknown;
  criteriosParada: string[];
  limiteExecucao: LimiteExecucao;
  limitePeriodoDias: number | null;
  marketing: boolean;
  modelo: string | null;
  versao: number;
  /** O que falta para poder ativar (vazio = pronta). */
  pendencias: string[];
  proximaExecucaoEm: string | null;
  ultimaExecucaoEm: string | null;
  criadoPor: { id: string; nome: string } | null;
  criadoEm: string;
  atualizadoEm: string;
  /** Só nas listagens: execuções reais por status. */
  execucoes?: Record<string, number>;
}

export interface AvaliacaoDaAutomacao {
  erros: string[];
  pendencias: string[];
  entidade: EntidadeDeAutomacao | null;
  condicoes: Prisma.InputJsonObject;
  definicao: DefinicaoDePassos;
}

type DadosDaAutomacao = Pick<
  Automacao,
  | 'tipoGatilho'
  | 'evento'
  | 'gatilhoConfig'
  | 'entidade'
  | 'condicoes'
  | 'definicao'
  | 'criteriosParada'
  | 'limiteExecucao'
  | 'limitePeriodoDias'
>;

function json(valor: unknown): Prisma.InputJsonValue {
  return valor as Prisma.InputJsonValue;
}

/**
 * Automações e cadências (R19): CRUD, validação (gatilho, condições, passos),
 * ativação, duplicação, exclusão, modelos prontos e catálogo para o editor.
 * Execução, histórico e modo teste ficam em `ExecucoesDeAutomacao`.
 */
@Injectable()
export class AutomacoesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditoria: AuditoriaService,
    private readonly passos: PassosService,
    private readonly agendas: AgendasDeAutomacao,
    private readonly iniciador: IniciadorDeExecucao,
  ) {}

  // -------------------------------------------------------------------------
  // Acesso
  // -------------------------------------------------------------------------

  exigirUso(usuario: UsuarioAutenticado): void {
    if (!podeUsarAutomacoes(usuario)) {
      throw new SemPermissaoException(
        'Só Admin, C-level e líderes usam as automações.',
      );
    }
  }

  /** A automação, se a pessoa a vê (404 se não — não revela que existe). */
  async obter(usuario: UsuarioAutenticado, id: string): Promise<Automacao> {
    this.exigirUso(usuario);
    const automacao = await this.prisma.automacao.findFirst({
      where: { id, excluidoEm: null },
    });
    if (!automacao || !podeGerenciarAutomacao(usuario, automacao)) {
      throw new NaoEncontradoException('Automação não encontrada.');
    }
    return automacao;
  }

  // -------------------------------------------------------------------------
  // Consulta
  // -------------------------------------------------------------------------

  async listar(usuario: UsuarioAutenticado, filtro: FiltroAutomacoesDto) {
    this.exigirUso(usuario);
    const where: Prisma.AutomacaoWhereInput = {
      excluidoEm: null,
      ...filtroDeAutomacoesVisiveis(usuario),
      ...(filtro.busca
        ? { nome: { contains: filtro.busca, mode: 'insensitive' } }
        : {}),
      ...(filtro.ativa !== undefined ? { ativa: filtro.ativa } : {}),
      ...(filtro.area ? { area: filtro.area } : {}),
      ...(filtro.tipoGatilho ? { tipoGatilho: filtro.tipoGatilho } : {}),
      ...(filtro.evento ? { evento: filtro.evento } : {}),
    };
    const [total, linhas] = await Promise.all([
      this.prisma.automacao.count({ where }),
      this.prisma.automacao.findMany({
        where,
        orderBy: [{ ativa: 'desc' }, { atualizadoEm: 'desc' }],
        include: { criadoPor: { select: { id: true, nome: true } } },
        ...paraSkipTake(filtro),
      }),
    ]);
    const contagens = await this.prisma.execucao.groupBy({
      by: ['automacaoId', 'status'],
      where: {
        automacaoId: { in: linhas.map((l) => l.id) },
        teste: false,
      },
      _count: { _all: true },
    });
    const itens = linhas.map((l) => {
      const execucoes: Record<string, number> = {};
      for (const c of contagens) {
        if (c.automacaoId === l.id) {
          execucoes[c.status] = c._count._all;
        }
      }
      return { ...this.montar(l, l.criadoPor), execucoes };
    });
    return montarPagina(itens, total, filtro);
  }

  async detalhar(
    usuario: UsuarioAutenticado,
    id: string,
  ): Promise<AutomacaoDto> {
    const automacao = await this.obter(usuario, id);
    return this.montarCompleta(automacao);
  }

  private async montarCompleta(automacao: Automacao): Promise<AutomacaoDto> {
    const criadoPor = automacao.criadoPorId
      ? await this.prisma.usuario.findUnique({
          where: { id: automacao.criadoPorId },
          select: { id: true, nome: true },
        })
      : null;
    return this.montar(automacao, criadoPor);
  }

  montar(
    a: Automacao,
    criadoPor: { id: string; nome: string } | null,
  ): AutomacaoDto {
    const avaliacao = this.avaliar(a);
    return {
      id: a.id,
      nome: a.nome,
      descricao: a.descricao,
      area: a.area,
      ativa: a.ativa,
      tipoGatilho: a.tipoGatilho,
      evento: a.evento,
      gatilhoRotulo: rotuloDoGatilho(a),
      gatilhoConfig: a.gatilhoConfig,
      entidade: a.entidade,
      condicoes: a.condicoes,
      definicao: a.definicao,
      criteriosParada: a.criteriosParada,
      limiteExecucao: a.limiteExecucao,
      limitePeriodoDias: a.limitePeriodoDias,
      marketing: a.marketing,
      modelo: a.modelo,
      versao: a.versao,
      pendencias: [...avaliacao.erros, ...avaliacao.pendencias],
      proximaExecucaoEm: a.proximaExecucaoEm?.toISOString() ?? null,
      ultimaExecucaoEm: a.ultimaExecucaoEm?.toISOString() ?? null,
      criadoPor,
      criadoEm: a.criadoEm.toISOString(),
      atualizadoEm: a.atualizadoEm.toISOString(),
    };
  }

  /** Gatilhos, campos de data, tipos de passo e opções, para o editor. */
  catalogo(usuario: UsuarioAutenticado) {
    this.exigirUso(usuario);
    return {
      gatilhos: CATALOGO_DE_GATILHOS.map((g) => ({
        evento: g.evento,
        rotulo: g.rotulo,
        entidade: g.entidade,
        origem: g.origem,
        filtros: g.filtros,
        ...(g.evento === 'negocio.parado'
          ? { filtros: [...g.filtros, 'diasAlemDoPrazo'] }
          : {}),
        ...(g.evento === 'atividade.atrasada'
          ? { filtros: [...g.filtros, 'horasAlemDoVencimento'] }
          : {}),
      })),
      camposDeData: Object.entries(CAMPOS_DE_DATA_RELATIVA).map(
        ([campo, d]) => ({ campo, rotulo: d.rotulo, entidade: d.entidade }),
      ),
      campoDeDataPersonalizado: {
        prefixo: 'contato.campos.',
        entidade: 'contato',
        formato: 'AAAA-MM-DD',
      },
      tiposDePasso: this.passos.tiposDisponiveis('AUTOMACAO'),
      acoes: Object.values(TIPOS_DE_PASSO_DE_AUTOMACAO),
      criteriosDeParada: CRITERIOS_DE_PARADA,
      limitesDeExecucao: ['UMA_VEZ', 'UMA_VEZ_POR_PERIODO', 'SEMPRE'],
      modelosProntos: MODELOS_PRONTOS.map((m) => ({
        chave: m.chave,
        nome: m.nome,
        descricao: m.descricao,
        areas: m.areas,
        aConfigurar: m.aConfigurar,
      })),
    };
  }

  modelosProntos(usuario: UsuarioAutenticado) {
    this.exigirUso(usuario);
    return MODELOS_PRONTOS;
  }

  // -------------------------------------------------------------------------
  // Validação
  // -------------------------------------------------------------------------

  /** Confere o gatilho, as condições e os passos. `erros` impedem salvar; `pendencias`, ativar. */
  avaliar(
    dados: Partial<DadosDaAutomacao> & Pick<DadosDaAutomacao, 'tipoGatilho'>,
  ): AvaliacaoDaAutomacao {
    const erros: string[] = [];
    const pendencias: string[] = [];
    const gatilho = conferirGatilho({
      tipoGatilho: dados.tipoGatilho,
      evento: dados.evento,
      gatilhoConfig: dados.gatilhoConfig,
      entidade: dados.entidade,
    });
    erros.push(...gatilho.erros);
    pendencias.push(...gatilho.pendencias);
    const { condicoes, erros: errosCondicoes } = conferirCondicoes(
      dados.condicoes,
    );
    erros.push(...errosCondicoes);
    if (dados.tipoGatilho === 'RECORRENCIA' && !condicoes.segmento) {
      pendencias.push('Escolha o público da recorrência.');
    }
    let definicao: DefinicaoDePassos = { passos: [] };
    try {
      definicao = this.passos.validarDefinicao(
        'AUTOMACAO',
        dados.definicao ?? { passos: [] },
      );
      if (definicao.passos.length === 0) {
        pendencias.push('Adicione ao menos uma ação.');
      }
    } catch (erro) {
      if (erro instanceof DadosInvalidosException) {
        const problemas = (
          erro.getResponse() as {
            detalhes?: { problemas?: Array<{ mensagem: string }> };
          }
        ).detalhes?.problemas;
        erros.push(...(problemas?.map((p) => p.mensagem) ?? [erro.message]));
      } else {
        throw erro;
      }
    }
    if (
      dados.limiteExecucao === 'UMA_VEZ_POR_PERIODO' &&
      !dados.limitePeriodoDias
    ) {
      erros.push('Informe o período do limite (em dias).');
    }
    return {
      erros: [...new Set(erros)],
      pendencias: [...new Set(pendencias)],
      entidade: gatilho.entidade,
      condicoes: condicoes as unknown as Prisma.InputJsonObject,
      definicao,
    };
  }

  /** `POST /automacoes/validar`: o que o editor mostra antes de salvar. */
  validar(usuario: UsuarioAutenticado, dto: CriarAutomacaoDto) {
    this.exigirUso(usuario);
    const avaliacao = this.avaliar({
      tipoGatilho: dto.tipoGatilho,
      evento: dto.evento ?? null,
      gatilhoConfig: (dto.gatilhoConfig ?? {}) as Prisma.JsonValue,
      entidade: dto.entidade,
      condicoes: (dto.condicoes ?? {}) as Prisma.JsonValue,
      definicao: (dto.definicao ?? { passos: [] }) as Prisma.JsonValue,
      limiteExecucao: dto.limiteExecucao ?? 'UMA_VEZ',
      limitePeriodoDias: dto.limitePeriodoDias ?? null,
    });
    return {
      valido: avaliacao.erros.length === 0,
      erros: avaliacao.erros,
      pendencias: avaliacao.pendencias,
      entidade: avaliacao.entidade,
    };
  }

  private lancarSeInvalida(avaliacao: AvaliacaoDaAutomacao): void {
    if (avaliacao.erros.length > 0) {
      throw new DadosInvalidosException(avaliacao.erros[0], {
        problemas: avaliacao.erros.map((mensagem) => ({ mensagem })),
      });
    }
  }

  // -------------------------------------------------------------------------
  // Escrita
  // -------------------------------------------------------------------------

  async criar(
    usuario: UsuarioAutenticado,
    dto: CriarAutomacaoDto,
  ): Promise<AutomacaoDto> {
    this.exigirUso(usuario);
    const limite = dto.limiteExecucao ?? 'UMA_VEZ';
    const avaliacao = this.avaliar({
      tipoGatilho: dto.tipoGatilho,
      evento: dto.tipoGatilho === 'EVENTO' ? (dto.evento ?? null) : null,
      gatilhoConfig: (dto.gatilhoConfig ?? {}) as Prisma.JsonValue,
      entidade: dto.entidade,
      condicoes: (dto.condicoes ?? {}) as Prisma.JsonValue,
      definicao: (dto.definicao ?? { passos: [] }) as Prisma.JsonValue,
      limiteExecucao: limite,
      limitePeriodoDias: dto.limitePeriodoDias ?? null,
    });
    this.lancarSeInvalida(avaliacao);
    const entidade = avaliacao.entidade!;
    const area = areaDaNovaAutomacao(usuario, dto.area);
    const criada = await this.prisma.$transaction(async (tx) => {
      const automacao = await tx.automacao.create({
        data: {
          nome: dto.nome,
          descricao: dto.descricao ?? null,
          area,
          ativa: false,
          tipoGatilho: dto.tipoGatilho,
          evento: dto.tipoGatilho === 'EVENTO' ? dto.evento : null,
          gatilhoConfig: json(dto.gatilhoConfig ?? {}),
          entidade,
          condicoes: avaliacao.condicoes,
          definicao: json(avaliacao.definicao),
          criteriosParada: dto.criteriosParada ?? [],
          limiteExecucao: limite,
          limitePeriodoDias:
            limite === 'UMA_VEZ_POR_PERIODO'
              ? (dto.limitePeriodoDias ?? null)
              : null,
          marketing: marketingDaNovaAutomacao(area, dto.marketing),
          modelo: dto.modelo ?? null,
          criadoPorId: usuario.id,
        },
      });
      await this.auditoria.registrar(tx, {
        acao: 'automacao.criada',
        entidade: 'automacao',
        entidadeId: automacao.id,
        resumo: `${usuario.nome} criou a automação "${automacao.nome}"`,
        dados: {
          alteracoes: calcularAlteracoes({}, automacao, CAMPOS_AUDITADOS),
          regra: REGRA_AUTOMACOES,
        },
      });
      return automacao;
    });
    return this.montarCompleta(criada);
  }

  async atualizar(
    usuario: UsuarioAutenticado,
    id: string,
    dto: AtualizarAutomacaoDto,
  ): Promise<AutomacaoDto> {
    const antes = await this.obter(usuario, id);
    const proximo = {
      tipoGatilho: dto.tipoGatilho ?? antes.tipoGatilho,
      evento:
        (dto.tipoGatilho ?? antes.tipoGatilho) === 'EVENTO'
          ? dto.evento !== undefined
            ? dto.evento
            : antes.evento
          : null,
      gatilhoConfig: (dto.gatilhoConfig ??
        antes.gatilhoConfig) as Prisma.JsonValue,
      entidade:
        dto.entidade ??
        (dto.tipoGatilho || dto.evento || dto.gatilhoConfig
          ? undefined
          : antes.entidade),
      condicoes: (dto.condicoes ?? antes.condicoes) as Prisma.JsonValue,
      definicao: (dto.definicao ?? antes.definicao) as Prisma.JsonValue,
      limiteExecucao: dto.limiteExecucao ?? antes.limiteExecucao,
      limitePeriodoDias:
        dto.limitePeriodoDias !== undefined
          ? dto.limitePeriodoDias
          : antes.limitePeriodoDias,
    };
    const avaliacao = this.avaliar(proximo);
    this.lancarSeInvalida(avaliacao);
    if (antes.ativa && avaliacao.pendencias.length > 0) {
      throw new RegraVioladaException(
        REGRA_AUTOMACOES,
        'A automação ativa precisa continuar completa: pause-a antes de deixar algo em branco.',
        { pendencias: avaliacao.pendencias },
      );
    }
    const area =
      dto.area !== undefined
        ? areaDaNovaAutomacao(usuario, dto.area)
        : antes.area;
    const depois = await this.prisma.$transaction(async (tx) => {
      const dados: Prisma.AutomacaoUncheckedUpdateInput = {
        ...(dto.nome !== undefined ? { nome: dto.nome } : {}),
        ...(dto.descricao !== undefined ? { descricao: dto.descricao } : {}),
        area,
        tipoGatilho: proximo.tipoGatilho,
        evento: proximo.evento,
        gatilhoConfig: json(proximo.gatilhoConfig),
        entidade: avaliacao.entidade!,
        condicoes: avaliacao.condicoes,
        definicao: json(avaliacao.definicao),
        ...(dto.criteriosParada !== undefined
          ? { criteriosParada: dto.criteriosParada }
          : {}),
        limiteExecucao: proximo.limiteExecucao,
        limitePeriodoDias:
          proximo.limiteExecucao === 'UMA_VEZ_POR_PERIODO'
            ? proximo.limitePeriodoDias
            : null,
        ...(dto.marketing !== undefined ? { marketing: dto.marketing } : {}),
      };
      const previa = { ...antes, ...dados } as unknown as Automacao;
      const mudouVersao = CAMPOS_DA_VERSAO.some(
        (c) => JSON.stringify(previa[c]) !== JSON.stringify(antes[c]),
      );
      if (mudouVersao) {
        dados.versao = { increment: 1 };
        // Agenda: recalcula a partir de agora (a regra mudou).
        if (antes.ativa) {
          Object.assign(dados, this.estadoDaAgenda(previa, new Date()));
        }
      }
      const depois = await tx.automacao.update({ where: { id }, data: dados });
      const alteracoes = calcularAlteracoes(antes, depois, CAMPOS_AUDITADOS);
      if (Object.keys(alteracoes).length > 0) {
        await this.auditoria.registrar(tx, {
          acao: 'automacao.atualizada',
          entidade: 'automacao',
          entidadeId: id,
          resumo: `${usuario.nome} alterou a automação "${depois.nome}"`,
          dados: { alteracoes, versao: depois.versao },
        });
      }
      return depois;
    });
    return this.montarCompleta(depois);
  }

  /** Marco da agenda ao ativar ou mudar a regra: nada do passado dispara. */
  private estadoDaAgenda(
    automacao: Pick<Automacao, 'tipoGatilho' | 'gatilhoConfig' | 'evento'>,
    agora: Date,
  ): Prisma.AutomacaoUncheckedUpdateInput {
    if (
      automacao.tipoGatilho === 'DATA_RELATIVA' ||
      automacao.tipoGatilho === 'RECORRENCIA'
    ) {
      return {
        proximaExecucaoEm: this.agendas.proximaOcorrenciaDa(automacao, agora),
        ultimaExecucaoEm: null,
      };
    }
    if (
      automacao.evento === 'negocio.parado' ||
      automacao.evento === 'atividade.atrasada'
    ) {
      return { ultimaExecucaoEm: agora, proximaExecucaoEm: null };
    }
    return { proximaExecucaoEm: null };
  }

  async ativar(usuario: UsuarioAutenticado, id: string): Promise<AutomacaoDto> {
    const antes = await this.obter(usuario, id);
    if (antes.ativa) {
      return this.montarCompleta(antes);
    }
    const avaliacao = this.avaliar(antes);
    const faltas = [...avaliacao.erros, ...avaliacao.pendencias];
    if (faltas.length > 0) {
      throw new RegraVioladaException(REGRA_AUTOMACOES, faltas[0], {
        pendencias: faltas,
      });
    }
    const depois = await this.prisma.$transaction(async (tx) => {
      const depois = await tx.automacao.update({
        where: { id },
        data: { ativa: true, ...this.estadoDaAgenda(antes, new Date()) },
      });
      await this.auditoria.registrar(tx, {
        acao: 'automacao.ativada',
        entidade: 'automacao',
        entidadeId: id,
        resumo: `${usuario.nome} ativou a automação "${depois.nome}"`,
        dados: { regra: REGRA_AUTOMACOES },
      });
      return depois;
    });
    return this.montarCompleta(depois);
  }

  async pausar(
    usuario: UsuarioAutenticado,
    id: string,
    opcoes: { cancelarExecucoes?: boolean } = {},
  ): Promise<AutomacaoDto> {
    const antes = await this.obter(usuario, id);
    const depois = await this.prisma.$transaction(async (tx) => {
      const depois = await tx.automacao.update({
        where: { id },
        data: { ativa: false },
      });
      const canceladas = opcoes.cancelarExecucoes
        ? await this.passos.cancelarAtivas(
            { automacaoId: id },
            'automacao_pausada',
            { tx },
          )
        : 0;
      if (antes.ativa || canceladas > 0) {
        await this.auditoria.registrar(tx, {
          acao: 'automacao.pausada',
          entidade: 'automacao',
          entidadeId: id,
          resumo: `${usuario.nome} pausou a automação "${depois.nome}"${canceladas > 0 ? ` e cancelou ${canceladas} execução(ões)` : ''}`,
          dados: { execucoesCanceladas: canceladas },
        });
      }
      return depois;
    });
    return this.montarCompleta(depois);
  }

  async duplicar(
    usuario: UsuarioAutenticado,
    id: string,
  ): Promise<AutomacaoDto> {
    const origem = await this.obter(usuario, id);
    const copia = await this.prisma.$transaction(async (tx) => {
      const copia = await tx.automacao.create({
        data: {
          nome: `${origem.nome} (cópia)`.slice(0, 120),
          descricao: origem.descricao,
          area: origem.area,
          ativa: false,
          tipoGatilho: origem.tipoGatilho,
          evento: origem.evento,
          gatilhoConfig: json(origem.gatilhoConfig),
          entidade: origem.entidade,
          condicoes: json(origem.condicoes),
          definicao: json(origem.definicao),
          criteriosParada: origem.criteriosParada,
          limiteExecucao: origem.limiteExecucao,
          limitePeriodoDias: origem.limitePeriodoDias,
          marketing: origem.marketing,
          modelo: origem.modelo,
          criadoPorId: usuario.id,
        },
      });
      await this.auditoria.registrar(tx, {
        acao: 'automacao.duplicada',
        entidade: 'automacao',
        entidadeId: copia.id,
        resumo: `${usuario.nome} duplicou a automação "${origem.nome}"`,
        dados: { origemId: origem.id },
      });
      return copia;
    });
    return this.montarCompleta(copia);
  }

  async excluir(usuario: UsuarioAutenticado, id: string): Promise<void> {
    const automacao = await this.obter(usuario, id);
    await this.prisma.$transaction(async (tx) => {
      await tx.automacao.update({
        where: { id },
        data: { excluidoEm: new Date(), ativa: false },
      });
      const canceladas = await this.passos.cancelarAtivas(
        { automacaoId: id },
        'automacao_excluida',
        { tx },
      );
      await this.auditoria.registrar(tx, {
        acao: 'automacao.excluida',
        entidade: 'automacao',
        entidadeId: id,
        resumo: `${usuario.nome} excluiu a automação "${automacao.nome}"`,
        dados: { execucoesCanceladas: canceladas },
      });
    });
  }

  // -------------------------------------------------------------------------
  // Modelos prontos
  // -------------------------------------------------------------------------

  async criarDeModelo(
    usuario: UsuarioAutenticado,
    chave: string,
    dto: CriarDeModeloProntoDto,
  ): Promise<AutomacaoDto> {
    this.exigirUso(usuario);
    const modelo = modeloPronto(chave);
    if (!modelo) {
      throw new NaoEncontradoException('Modelo de automação não encontrado.');
    }
    const base = modelo.automacao;
    return this.criar(usuario, {
      nome: dto.nome ?? modelo.nome,
      descricao: modelo.descricao,
      area: dto.area ?? null,
      tipoGatilho: base.tipoGatilho,
      evento: base.evento,
      gatilhoConfig: { ...base.gatilhoConfig, ...dto.gatilhoConfig },
      condicoes: base.condicoes,
      definicao: base.definicao,
      criteriosParada: base.criteriosParada,
      limiteExecucao: base.limiteExecucao,
      limitePeriodoDias: base.limitePeriodoDias ?? null,
      marketing: base.marketing,
      modelo: modelo.chave,
    });
  }
}

function rotuloDoGatilho(
  a: Pick<Automacao, 'tipoGatilho' | 'evento' | 'gatilhoConfig'>,
): string {
  if (a.tipoGatilho === 'EVENTO') {
    return gatilhoDoCatalogo(a.evento)?.rotulo ?? a.evento ?? 'Gatilho';
  }
  if (a.tipoGatilho === 'DATA_RELATIVA') {
    const c = a.gatilhoConfig as unknown as DataRelativa;
    const campo =
      CAMPOS_DE_DATA_RELATIVA[c.campo as keyof typeof CAMPOS_DE_DATA_RELATIVA]
        ?.rotulo ?? c.campo;
    const dias = Math.abs(c.dias);
    return c.dias === 0
      ? `No dia: ${campo}`
      : `${dias} dia(s) ${c.dias < 0 ? 'antes' : 'depois'}: ${campo}`;
  }
  const r = a.gatilhoConfig as unknown as Recorrencia;
  return `Recorrência ${r.frequencia === 'diaria' ? 'diária' : r.frequencia === 'semanal' ? 'semanal' : 'mensal'} às ${r.hora}`;
}
