import { Injectable } from '@nestjs/common';
import { AuditoriaService } from '../auditoria/auditoria.service';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import { type Alteracao, calcularAlteracoes } from '../comum/dados/sanitizar';
import {
  ConflitoException,
  DadosInvalidosException,
  NaoEncontradoException,
  RegraVioladaException,
} from '../comum/erros/excecoes';
import {
  montarPagina,
  type Pagina,
  paraSkipTake,
} from '../comum/paginacao/paginacao';
import {
  type ProblemaDeCampo,
  resumirProblemas,
} from '../comum/validacao/validacao';
import { EventosDominioService } from '../eventos/eventos-dominio.service';
import type {
  Atividade,
  Prisma,
  PrioridadeAtividade,
  ResultadoReuniao,
  StatusAtividade,
  TipoAtividade,
} from '../generated/prisma/client';
import { PrismaService, type Tx } from '../prisma/prisma.service';
import {
  AtividadeDto,
  type AtividadesAgrupadasDto,
  INCLUSOES_DA_ATIVIDADE,
  ReferenciaDosGruposDto,
} from './dto/atividade.dto';
import type { AtualizarAtividadeDto } from './dto/atualizar-atividade.dto';
import type { ConcluirAtividadeDto } from './dto/concluir-atividade.dto';
import type { CriarAtividadeDto } from './dto/criar-atividade.dto';
import type {
  FiltroAgrupadasDto,
  FiltroAtividadesDto,
  FiltroBaseAtividadesDto,
} from './dto/filtro-atividades.dto';
import { lerDataHora } from './dto/transformacoes';
import type { AcessoAosFunis } from '../funis/acesso-funis';
import { funisAcessiveis } from '../funis/acessos-no-banco';
import { registrarPrimeiraInteracao } from '../funis/primeira-interacao';
import { FUSO_HORARIO_DAS_ATIVIDADES } from './fuso-horario';
import {
  condicaoAguardandoResultado,
  condicaoAtrasada,
  condicaoNaoAguardandoResultado,
  condicaoDoGrupo,
  condicaoNaoAtrasada,
  filtroDeVisibilidade,
  flexionar,
  GRUPOS_DE_ATIVIDADES,
  marcadoresParaRearmar,
  ordemDoGrupo,
  type QuemConsulta,
  type ReferenciaDeTempo,
  referenciaDeTempo,
  resolverDatas,
  ROTULO_DO_GRUPO,
  rotuloDoTipo,
} from './regras-atividades';

/** Campos que a alteração (`PATCH`) muda — os que a auditoria compara. */
const CAMPOS_EDITAVEIS = [
  'tipo',
  'titulo',
  'descricao',
  'prioridade',
  'venceEm',
  'inicioEm',
  'fimEm',
  'responsavelId',
  'contatoId',
  'empresaId',
  'negocioId',
  'resultadoReuniao',
] as const;

type CampoEditavel = (typeof CAMPOS_EDITAVEIS)[number];

const ROTULO_DO_CAMPO: Readonly<Record<CampoEditavel, string>> = {
  tipo: 'tipo',
  titulo: 'título',
  descricao: 'descrição',
  prioridade: 'prioridade',
  venceEm: 'vencimento',
  inicioEm: 'início',
  fimEm: 'fim',
  responsavelId: 'responsável',
  contatoId: 'contato',
  empresaId: 'empresa',
  negocioId: 'negócio',
  resultadoReuniao: 'resultado da reunião',
};

/**
 * Dados dos eventos `atividade.criada` e `atividade.concluida` (outbox, R10.1)
 * — o que os webhooks de saída recebem em `dados` (R9.2). A descrição fica de
 * fora (texto livre, pode ser longo).
 */
export interface DadosDoEventoDeAtividade {
  atividadeId: string;
  tipo: TipoAtividade;
  titulo: string;
  status: StatusAtividade;
  prioridade: PrioridadeAtividade;
  venceEm: string | null;
  inicioEm: string | null;
  fimEm: string | null;
  responsavelId: string;
  criadoPorId: string | null;
  concluidaEm: string | null;
  concluidaPorId: string | null;
  contatoId: string | null;
  empresaId: string | null;
  negocioId: string | null;
  /** R6.6 — só em reunião concluída; nulo = sem resultado. */
  resultadoReuniao: ResultadoReuniao | null;
  remarcadaDeId: string | null;
}

export function dadosDoEvento(atividade: Atividade): DadosDoEventoDeAtividade {
  const iso = (data: Date | null) => data?.toISOString() ?? null;
  return {
    atividadeId: atividade.id,
    tipo: atividade.tipo,
    titulo: atividade.titulo,
    status: atividade.status,
    prioridade: atividade.prioridade,
    venceEm: iso(atividade.venceEm),
    inicioEm: iso(atividade.inicioEm),
    fimEm: iso(atividade.fimEm),
    responsavelId: atividade.responsavelId,
    criadoPorId: atividade.criadoPorId,
    concluidaEm: iso(atividade.concluidaEm),
    concluidaPorId: atividade.concluidaPorId,
    contatoId: atividade.contatoId,
    empresaId: atividade.empresaId,
    negocioId: atividade.negocioId,
    resultadoReuniao: atividade.resultadoReuniao,
    remarcadaDeId: atividade.remarcadaDeId,
  };
}

/** Vínculos pedidos na criação ou na alteração (`null` = sem vínculo). */
interface VinculosPedidos {
  contatoId?: string | null;
  empresaId?: string | null;
  negocioId?: string | null;
}

/** O que a validação dos vínculos encontrou — base da herança na criação. */
interface VinculosEncontrados {
  negocio: { contatoId: string; empresaId: string | null } | null;
  contato: { empresaId: string | null } | null;
}

function lancarSeHouver(problemas: readonly ProblemaDeCampo[]): void {
  if (problemas.length > 0) {
    throw new DadosInvalidosException(resumirProblemas(problemas), {
      campos: problemas,
    });
  }
}

function relacionadosDe(atividade: Atividade) {
  return {
    contato: atividade.contatoId,
    empresa: atividade.empresaId,
    negocio: atividade.negocioId,
  };
}

function ehUmaNota(): RegraVioladaException {
  return new RegraVioladaException(
    'R6.2',
    'A nota já nasce concluída e não muda de status.',
  );
}

/**
 * Atividades (R6): criação, consulta com filtros e agrupamentos, alteração e
 * mudança de status. Toda alteração grava, na mesma transação, a auditoria
 * (R3.1) e — na criação e na conclusão — o evento de domínio (R10.1).
 *
 * Quem vê a atividade (R6.4) também pode alterá-la, concluí-la, cancelá-la e
 * reabri-la; para os demais ela "não existe" (404).
 *
 * Dentro das transações, as consultas carregam no máximo uma relação: com
 * várias, o Prisma as busca em paralelo na única conexão da transação (o `pg`
 * avisa que isso deixará de funcionar). A resposta completa é lida depois da
 * confirmação.
 */
@Injectable()
export class AtividadesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditoria: AuditoriaService,
    private readonly eventos: EventosDominioService,
  ) {}

  /** R6.1, R6.2 — cria a atividade (a nota já nasce concluída). */
  async criar(
    usuario: UsuarioAutenticado,
    dto: CriarAtividadeDto,
  ): Promise<AtividadeDto> {
    const { datas, problemas } = resolverDatas(dto.tipo, {
      venceEm: lerDataHora(dto.venceEm),
      inicioEm: lerDataHora(dto.inicioEm),
      fimEm: lerDataHora(dto.fimEm),
    });
    lancarSeHouver(problemas);
    const nota = dto.tipo === 'NOTA';
    const concluida = nota || dto.concluida === true;

    const criada = await this.prisma.$transaction(async (tx) => {
      const responsavel = await this.validarResponsavel(
        tx,
        dto.responsavelId ?? usuario.id,
      );
      const pedidos: VinculosPedidos = {
        contatoId: dto.contatoId ?? null,
        empresaId: dto.empresaId ?? null,
        negocioId: dto.negocioId ?? null,
      };
      const encontrados = await this.validarVinculos(tx, usuario, pedidos);
      const vinculos = await this.herdarVinculos(tx, pedidos, encontrados);
      const agora = new Date();
      const atividade = await tx.atividade.create({
        data: {
          tipo: dto.tipo,
          titulo: dto.titulo,
          descricao: dto.descricao ?? null,
          status: concluida ? 'CONCLUIDA' : 'PENDENTE',
          prioridade: dto.prioridade ?? 'MEDIA',
          ...datas,
          responsavelId: responsavel.id,
          criadoPorId: usuario.id,
          concluidaEm: concluida ? agora : null,
          concluidaPorId: concluida ? usuario.id : null,
          ...vinculos,
        },
      });
      const dados = dadosDoEvento(atividade);
      await this.auditoria.registrar(tx, {
        acao: 'atividade.criada',
        entidade: 'atividade',
        entidadeId: atividade.id,
        resumo: resumoDaCriacao(atividade, responsavel.nome),
        dados: { ...dados },
        relacionados: relacionadosDe(atividade),
      });
      await this.eventos.publicar(tx, 'atividade.criada', dados);
      if (concluida && !nota) {
        await this.eventos.publicar(tx, 'atividade.concluida', dados);
        await this.registrarInteracao(tx, atividade, usuario.id);
      }
      return atividade;
    });
    return this.carregarResposta(criada.id, usuario);
  }

  /** Lista paginada do que o usuário pode ver (R6.4), com os filtros. */
  async listar(
    usuario: UsuarioAutenticado,
    filtro: FiltroAtividadesDto,
  ): Promise<Pagina<AtividadeDto>> {
    const referencia = referenciaDeTempo(new Date(), filtro.fusoHorario);
    const acesso = await funisAcessiveis(this.prisma, usuario);
    const where = this.filtroDaLista(usuario, filtro, referencia, acesso);
    const [itens, total] = await Promise.all([
      this.prisma.atividade.findMany({
        where,
        include: INCLUSOES_DA_ATIVIDADE,
        orderBy: ordemDaLista(filtro),
        ...paraSkipTake(filtro),
      }),
      this.prisma.atividade.count({ where }),
    ]);
    return montarPagina(
      itens.map((atividade) =>
        AtividadeDto.de(semNegocioInvisivel(atividade, acesso), referencia),
      ),
      total,
      filtro,
    );
  }

  /**
   * Os seis grupos da agenda (atrasadas, hoje, próximos 7 dias, mais tarde,
   * sem data, concluídas), com o total de cada um e as primeiras atividades.
   * Os grupos saem um depois do outro, cada um com duas consultas — sem ocupar
   * o pool de conexões de uma vez.
   */
  async agrupar(
    usuario: UsuarioAutenticado,
    filtro: FiltroAgrupadasDto,
  ): Promise<AtividadesAgrupadasDto> {
    const referencia = referenciaDeTempo(new Date(), filtro.fusoHorario);
    const acesso = await funisAcessiveis(this.prisma, usuario);
    const comuns = this.condicoesComuns(usuario, filtro, acesso);
    const grupos: AtividadesAgrupadasDto['grupos'] = [];
    for (const grupo of GRUPOS_DE_ATIVIDADES) {
      const where: Prisma.AtividadeWhereInput = {
        AND: [...comuns, condicaoDoGrupo(grupo, referencia)],
      };
      const [total, itens] = await Promise.all([
        this.prisma.atividade.count({ where }),
        filtro.limitePorGrupo > 0
          ? this.prisma.atividade.findMany({
              where,
              include: INCLUSOES_DA_ATIVIDADE,
              orderBy: ordemDoGrupo(grupo),
              take: filtro.limitePorGrupo,
            })
          : Promise.resolve([]),
      ]);
      grupos.push({
        grupo,
        rotulo: ROTULO_DO_GRUPO[grupo],
        total,
        itens: itens.map((atividade) =>
          AtividadeDto.de(semNegocioInvisivel(atividade, acesso), referencia),
        ),
      });
    }
    return { referencia: ReferenciaDosGruposDto.de(referencia), grupos };
  }

  /** Uma atividade que o usuário pode ver (R6.4); as outras dão 404. */
  async detalhar(
    usuario: UsuarioAutenticado,
    id: string,
  ): Promise<AtividadeDto> {
    const atividade = await this.prisma.atividade.findFirst({
      where: { AND: [{ id }, filtroDeVisibilidade(usuario)] },
      include: INCLUSOES_DA_ATIVIDADE,
    });
    if (!atividade) {
      throw new NaoEncontradoException('Atividade não encontrada.');
    }
    return AtividadeDto.de(
      semNegocioInvisivel(
        atividade,
        await funisAcessiveis(this.prisma, usuario),
      ),
      this.referenciaPadrao(),
    );
  }

  /** Altera os campos enviados (R6.1, R6.2), auditando o antes/depois. */
  async atualizar(
    usuario: UsuarioAutenticado,
    id: string,
    dto: AtualizarAtividadeDto,
  ): Promise<AtividadeDto> {
    await this.prisma.$transaction(async (tx) => {
      const atual = await this.carregarParaAlterar(tx, usuario, id);
      const tipo = dto.tipo ?? atual.tipo;
      const problemas: ProblemaDeCampo[] = [];
      if (tipo !== atual.tipo && (tipo === 'NOTA' || atual.tipo === 'NOTA')) {
        problemas.push({
          campo: 'tipo',
          mensagens: [
            atual.tipo === 'NOTA'
              ? 'a nota não muda de tipo'
              : 'uma atividade não pode virar nota',
          ],
        });
      }
      const resolvidas = resolverDatas(
        tipo,
        {
          venceEm: lerDataHora(dto.venceEm),
          inicioEm: lerDataHora(dto.inicioEm),
          fimEm: lerDataHora(dto.fimEm),
        },
        atual,
      );
      problemas.push(...resolvidas.problemas);
      lancarSeHouver(problemas);

      let novaData: Date | null = null;
      if (dto.resultadoReuniao !== undefined) {
        if (atual.tipo !== 'REUNIAO' || atual.status !== 'CONCLUIDA') {
          throw new DadosInvalidosException(
            'O resultado só se corrige numa reunião concluída.',
            {
              campos: [
                {
                  campo: 'resultadoReuniao',
                  mensagens: ['só vale para reunião concluída'],
                },
              ],
            },
          );
        }
        novaData = this.validarResultado(
          atual.tipo,
          dto.resultadoReuniao,
          dto.novaData,
          false,
        );
      }

      const trocaResponsavel =
        dto.responsavelId !== undefined &&
        dto.responsavelId !== atual.responsavelId;
      const novoResponsavel = trocaResponsavel
        ? await this.validarResponsavel(tx, dto.responsavelId as string)
        : null;
      const mudou = <C extends 'contatoId' | 'empresaId' | 'negocioId'>(
        campo: C,
      ) =>
        dto[campo] !== undefined && dto[campo] !== atual[campo]
          ? dto[campo]
          : undefined;
      await this.validarVinculos(tx, usuario, {
        contatoId: mudou('contatoId'),
        empresaId: mudou('empresaId'),
        negocioId: mudou('negocioId'),
      });

      const depois = {
        tipo,
        titulo: dto.titulo ?? atual.titulo,
        descricao:
          dto.descricao === undefined ? atual.descricao : dto.descricao,
        prioridade: dto.prioridade ?? atual.prioridade,
        ...resolvidas.datas,
        responsavelId: novoResponsavel?.id ?? atual.responsavelId,
        contatoId:
          dto.contatoId === undefined ? atual.contatoId : dto.contatoId,
        empresaId:
          dto.empresaId === undefined ? atual.empresaId : dto.empresaId,
        negocioId:
          dto.negocioId === undefined ? atual.negocioId : dto.negocioId,
        resultadoReuniao:
          dto.resultadoReuniao === undefined
            ? atual.resultadoReuniao
            : dto.resultadoReuniao,
      };
      const alteracoes = calcularAlteracoes(atual, depois, CAMPOS_EDITAVEIS);
      if (Object.keys(alteracoes).length === 0) {
        return;
      }
      const atualizada = await tx.atividade.update({
        where: { id },
        data: {
          ...depois,
          ...marcadoresParaRearmar(atual, depois, new Date()),
        },
      });
      const anterior = novoResponsavel
        ? await tx.usuario.findUnique({
            where: { id: atual.responsavelId },
            select: { nome: true },
          })
        : null;
      if (novaData && atual.resultadoReuniao !== 'REMARCADA') {
        await this.criarRemarcacao(tx, atualizada, novaData);
      }
      await this.auditoria.registrar(tx, {
        acao: 'atividade.atualizada',
        entidade: 'atividade',
        entidadeId: id,
        resumo: resumoDaAlteracao(
          atualizada,
          alteracoes,
          novoResponsavel
            ? { antes: anterior?.nome ?? '—', depois: novoResponsavel.nome }
            : undefined,
        ),
        dados: { alteracoes },
        relacionados: relacionadosDe(atualizada),
      });
    });
    return this.carregarResposta(id, usuario);
  }

  /**
   * R6.2 — conclui a pendente, gravando quando e quem concluiu. R6.6 — a
   * reunião concluída por uma pessoa exige o resultado; `REMARCADA` cria, na
   * mesma transação, a nova reunião pendente. Os outros tipos recusam o campo.
   */
  async concluir(
    usuario: UsuarioAutenticado,
    id: string,
    dto: ConcluirAtividadeDto = {},
  ): Promise<AtividadeDto> {
    await this.prisma.$transaction(async (tx) => {
      const atual = await this.carregarParaAlterar(tx, usuario, id);
      if (atual.tipo === 'NOTA') {
        throw ehUmaNota();
      }
      if (atual.status !== 'PENDENTE') {
        throw new ConflitoException(
          atual.status === 'CONCLUIDA'
            ? 'A atividade já está concluída.'
            : 'A atividade está cancelada: reabra-a antes de concluir.',
          { status: atual.status },
        );
      }
      const novaData = this.validarResultado(
        atual.tipo,
        dto.resultadoReuniao,
        dto.novaData,
        true,
      );
      const atualizada = await tx.atividade.update({
        where: { id },
        data: {
          status: 'CONCLUIDA',
          concluidaEm: new Date(),
          concluidaPorId: usuario.id,
          resultadoReuniao: dto.resultadoReuniao ?? null,
        },
      });
      await this.registrarMudancaDeStatus(
        tx,
        atual,
        atualizada,
        'atividade.concluida',
        'concluíd',
      );
      await this.eventos.publicar(
        tx,
        'atividade.concluida',
        dadosDoEvento(atualizada),
      );
      if (novaData) {
        await this.criarRemarcacao(tx, atualizada, novaData);
      }
      await this.registrarInteracao(tx, atualizada, usuario.id);
    });
    return this.carregarResposta(id, usuario);
  }

  /** R6.2 — cancela a pendente. */
  async cancelar(
    usuario: UsuarioAutenticado,
    id: string,
  ): Promise<AtividadeDto> {
    await this.prisma.$transaction(async (tx) => {
      const atual = await this.carregarParaAlterar(tx, usuario, id);
      if (atual.tipo === 'NOTA') {
        throw ehUmaNota();
      }
      if (atual.status !== 'PENDENTE') {
        throw new ConflitoException(
          atual.status === 'CANCELADA'
            ? 'A atividade já está cancelada.'
            : 'A atividade já está concluída: reabra-a antes de cancelar.',
          { status: atual.status },
        );
      }
      const atualizada = await tx.atividade.update({
        where: { id },
        data: { status: 'CANCELADA', canceladaEm: new Date() },
      });
      await this.registrarMudancaDeStatus(
        tx,
        atual,
        atualizada,
        'atividade.cancelada',
        'cancelad',
      );
    });
    return this.carregarResposta(id, usuario);
  }

  /** Volta uma concluída ou cancelada para pendente (os lembretes no futuro voltam a valer). */
  async reabrir(
    usuario: UsuarioAutenticado,
    id: string,
  ): Promise<AtividadeDto> {
    await this.prisma.$transaction(async (tx) => {
      const atual = await this.carregarParaAlterar(tx, usuario, id);
      if (atual.tipo === 'NOTA') {
        throw ehUmaNota();
      }
      if (atual.status === 'PENDENTE') {
        throw new ConflitoException('A atividade já está pendente.', {
          status: atual.status,
        });
      }
      const atualizada = await tx.atividade.update({
        where: { id },
        data: {
          status: 'PENDENTE',
          concluidaEm: null,
          concluidaPorId: null,
          canceladaEm: null,
          resultadoReuniao: null,
          ...marcadoresParaRearmar(atual, atual, new Date(), true),
        },
      });
      await this.registrarMudancaDeStatus(
        tx,
        atual,
        atualizada,
        'atividade.reaberta',
        'reabert',
      );
    });
    return this.carregarResposta(id, usuario);
  }

  /**
   * R6.6 — confere resultado e nova data. Devolve a nova data (só em `REMARCADA`).
   * `exigir`: ao concluir por uma pessoa, a reunião precisa de resultado.
   */
  private validarResultado(
    tipo: TipoAtividade,
    resultado: ResultadoReuniao | undefined,
    novaData: string | undefined,
    exigir: boolean,
  ): Date | null {
    const problemas: ProblemaDeCampo[] = [];
    if (tipo !== 'REUNIAO') {
      if (resultado !== undefined) {
        problemas.push({
          campo: 'resultadoReuniao',
          mensagens: ['só vale para reunião'],
        });
      }
      if (novaData !== undefined) {
        problemas.push({
          campo: 'novaData',
          mensagens: ['só vale para reunião remarcada'],
        });
      }
    } else if (resultado === undefined) {
      if (exigir) {
        problemas.push({
          campo: 'resultadoReuniao',
          mensagens: ['é obrigatório para concluir uma reunião'],
        });
      }
      if (novaData !== undefined) {
        problemas.push({
          campo: 'novaData',
          mensagens: ['só vale com o resultado REMARCADA'],
        });
      }
    } else if (resultado !== 'REMARCADA' && novaData !== undefined) {
      problemas.push({
        campo: 'novaData',
        mensagens: ['só vale com o resultado REMARCADA'],
      });
    }
    let data: Date | null = null;
    if (resultado === 'REMARCADA' && tipo === 'REUNIAO') {
      data = lerDataHora(novaData) ?? null;
      if (!data) {
        problemas.push({
          campo: 'novaData',
          mensagens: ['é obrigatória para remarcar'],
        });
      } else if (data.getTime() <= Date.now()) {
        problemas.push({
          campo: 'novaData',
          mensagens: ['deve ser no futuro'],
        });
      }
    }
    lancarSeHouver(problemas);
    return data;
  }

  /** R6.6 — a nova reunião pendente de uma remarcação (mesma duração e vínculos). */
  private async criarRemarcacao(
    tx: Tx,
    origem: Atividade,
    novaData: Date,
  ): Promise<void> {
    const duracao =
      origem.inicioEm && origem.fimEm
        ? origem.fimEm.getTime() - origem.inicioEm.getTime()
        : 60 * 60 * 1000;
    const nova = await tx.atividade.create({
      data: {
        tipo: 'REUNIAO',
        titulo: origem.titulo,
        descricao: origem.descricao,
        prioridade: origem.prioridade,
        status: 'PENDENTE',
        venceEm: novaData,
        inicioEm: novaData,
        fimEm: new Date(novaData.getTime() + duracao),
        responsavelId: origem.responsavelId,
        criadoPorId: origem.concluidaPorId ?? origem.criadoPorId,
        contatoId: origem.contatoId,
        empresaId: origem.empresaId,
        negocioId: origem.negocioId,
        remarcadaDeId: origem.id,
      },
    });
    const dados = dadosDoEvento(nova);
    await this.auditoria.registrar(tx, {
      acao: 'atividade.criada',
      entidade: 'atividade',
      entidadeId: nova.id,
      resumo: `Reunião "${nova.titulo}" remarcada`,
      dados: { ...dados },
      relacionados: relacionadosDe(nova),
    });
    await this.eventos.publicar(tx, 'atividade.criada', dados);
  }

  /** R6.7 — atividade concluída por uma pessoa (menos nota): primeira interação. */
  private async registrarInteracao(
    tx: Tx,
    atividade: Atividade,
    usuarioId: string,
  ): Promise<void> {
    if (atividade.tipo === 'NOTA') {
      return;
    }
    let contatoId = atividade.contatoId;
    if (!contatoId && atividade.negocioId) {
      const negocio = await tx.negocio.findUnique({
        where: { id: atividade.negocioId },
        select: { contatoId: true },
      });
      contatoId = negocio?.contatoId ?? null;
    }
    if (contatoId) {
      await registrarPrimeiraInteracao(tx, {
        contatoId,
        tipo: 'ATIVIDADE',
        usuarioId,
      });
    }
  }

  private referenciaPadrao(): ReferenciaDeTempo {
    return referenciaDeTempo(new Date(), FUSO_HORARIO_DAS_ATIVIDADES);
  }

  /** A resposta completa, lida depois que a alteração foi confirmada. */
  private async carregarResposta(
    id: string,
    usuario: QuemConsulta,
  ): Promise<AtividadeDto> {
    const atividade = await this.prisma.atividade.findUniqueOrThrow({
      where: { id },
      include: INCLUSOES_DA_ATIVIDADE,
    });
    return AtividadeDto.de(
      semNegocioInvisivel(
        atividade,
        await funisAcessiveis(this.prisma, usuario),
      ),
      this.referenciaPadrao(),
    );
  }

  /**
   * Trava a linha (alterações concorrentes esperam) e carrega a atividade se o
   * usuário pode vê-la (R6.4); senão, 404.
   */
  private async carregarParaAlterar(
    tx: Tx,
    usuario: QuemConsulta,
    id: string,
  ): Promise<Atividade> {
    await tx.$queryRaw`SELECT id FROM atividades WHERE id = ${id}::uuid FOR UPDATE`;
    const atividade = await tx.atividade.findFirst({
      where: { AND: [{ id }, filtroDeVisibilidade(usuario)] },
    });
    if (!atividade) {
      throw new NaoEncontradoException('Atividade não encontrada.');
    }
    return atividade;
  }

  /** R6.2 — o responsável é um usuário ativo. */
  private async validarResponsavel(
    tx: Tx,
    id: string,
  ): Promise<{ id: string; nome: string }> {
    const responsavel = await tx.usuario.findUnique({
      where: { id },
      select: { id: true, nome: true, ativo: true },
    });
    if (!responsavel?.ativo) {
      throw new RegraVioladaException(
        'R6.2',
        'O responsável precisa ser um usuário ativo.',
        { campo: 'responsavelId', responsavelId: id },
      );
    }
    return { id: responsavel.id, nome: responsavel.nome };
  }

  /**
   * R6.1 — os vínculos pedidos existem (e não foram excluídos); o negócio,
   * além disso, precisa estar visível para o usuário (R5.9). Os outros saem
   * como "não encontrado", sem revelar que existem.
   */
  private async validarVinculos(
    tx: Tx,
    usuario: QuemConsulta,
    pedidos: VinculosPedidos,
  ): Promise<VinculosEncontrados> {
    const problemas: ProblemaDeCampo[] = [];
    const encontrados: VinculosEncontrados = { negocio: null, contato: null };
    if (pedidos.negocioId) {
      const negocio = await tx.negocio.findFirst({
        where: { id: pedidos.negocioId, excluidoEm: null },
        select: {
          responsavelId: true,
          contatoId: true,
          empresaId: true,
          funilId: true,
        },
      });
      if (
        negocio &&
        (await funisAcessiveis(tx, usuario)).podeVerNegocio(negocio)
      ) {
        encontrados.negocio = {
          contatoId: negocio.contatoId,
          empresaId: negocio.empresaId,
        };
      } else {
        problemas.push({
          campo: 'negocioId',
          mensagens: ['negócio não encontrado'],
        });
      }
    }
    if (pedidos.contatoId) {
      const contato = await tx.contato.findFirst({
        where: { id: pedidos.contatoId, excluidoEm: null },
        select: { empresaId: true },
      });
      if (contato) {
        encontrados.contato = contato;
      } else {
        problemas.push({
          campo: 'contatoId',
          mensagens: ['contato não encontrado'],
        });
      }
    }
    if (
      pedidos.empresaId &&
      !(await this.empresaAtiva(tx, pedidos.empresaId))
    ) {
      problemas.push({
        campo: 'empresaId',
        mensagens: ['empresa não encontrada'],
      });
    }
    lancarSeHouver(problemas);
    return encontrados;
  }

  /**
   * Na criação, o que não foi informado vem do que foi: do negócio, o contato
   * e a empresa dele; do contato, a empresa — assim a atividade aparece na
   * linha do tempo de cada um (R3.5). Vínculos excluídos não são herdados.
   */
  private async herdarVinculos(
    tx: Tx,
    pedidos: VinculosPedidos,
    encontrados: VinculosEncontrados,
  ): Promise<{
    contatoId: string | null;
    empresaId: string | null;
    negocioId: string | null;
  }> {
    const { negocio } = encontrados;
    let contato = encontrados.contato;
    let contatoId = pedidos.contatoId ?? null;
    if (!contatoId && negocio) {
      const doNegocio = await tx.contato.findFirst({
        where: { id: negocio.contatoId, excluidoEm: null },
        select: { empresaId: true },
      });
      if (doNegocio) {
        contatoId = negocio.contatoId;
        contato = doNegocio;
      }
    }
    let empresaId = pedidos.empresaId ?? null;
    for (const candidata of [negocio?.empresaId, contato?.empresaId]) {
      if (!empresaId && candidata && (await this.empresaAtiva(tx, candidata))) {
        empresaId = candidata;
      }
    }
    return { contatoId, empresaId, negocioId: pedidos.negocioId ?? null };
  }

  private async empresaAtiva(tx: Tx, id: string): Promise<boolean> {
    const empresa = await tx.empresa.findFirst({
      where: { id, excluidoEm: null },
      select: { id: true },
    });
    return empresa !== null;
  }

  private registrarMudancaDeStatus(
    tx: Tx,
    antes: Atividade,
    depois: Atividade,
    acao: string,
    participio: string,
  ) {
    return this.auditoria.registrar(tx, {
      acao,
      entidade: 'atividade',
      entidadeId: depois.id,
      resumo: `${rotuloDoTipo(depois.tipo)} "${depois.titulo}" ${flexionar(depois.tipo, participio)}`,
      dados: {
        alteracoes: calcularAlteracoes(antes, depois, [
          'status',
          'concluidaEm',
          'concluidaPorId',
          'canceladaEm',
          'resultadoReuniao',
        ]),
      },
      relacionados: relacionadosDe(depois),
    });
  }

  /** Condições que valem para a lista e para os agrupamentos. */
  private condicoesComuns(
    usuario: UsuarioAutenticado,
    filtro: FiltroBaseAtividadesDto,
    acesso: AcessoAosFunis,
  ): Prisma.AtividadeWhereInput[] {
    const condicoes: Prisma.AtividadeWhereInput[] = [
      filtroDeVisibilidade(usuario),
    ];
    if (filtro.escopo === 'MINHAS') {
      condicoes.push({ responsavelId: usuario.id });
    } else if (filtro.escopo === 'EQUIPE') {
      condicoes.push({
        responsavel: {
          OR: [{ liderId: usuario.id }, { lider: { liderId: usuario.id } }],
        },
      });
    }
    if (filtro.responsavelId) {
      condicoes.push({ responsavelId: filtro.responsavelId });
    }
    if (filtro.criadoPorId) {
      condicoes.push({ criadoPorId: filtro.criadoPorId });
    }
    // R6.2 — a nota só aparece na linha do tempo, ou quando pedida pelo tipo.
    condicoes.push(
      filtro.tipo && filtro.tipo.length > 0
        ? { tipo: { in: filtro.tipo } }
        : { tipo: { not: 'NOTA' } },
    );
    if (filtro.prioridade && filtro.prioridade.length > 0) {
      condicoes.push({ prioridade: { in: filtro.prioridade } });
    }
    if (filtro.contatoId) {
      condicoes.push({ contatoId: filtro.contatoId });
    }
    if (filtro.empresaId) {
      condicoes.push({ empresaId: filtro.empresaId });
    }
    if (filtro.negocioId) {
      // R5.9: pelas atividades não se descobre negócio de funil que a pessoa não vê.
      condicoes.push({
        negocioId: filtro.negocioId,
        negocio: acesso.filtroDeNegocios(),
      });
    }
    if (filtro.resultadoReuniao && filtro.resultadoReuniao.length > 0) {
      const resultados = filtro.resultadoReuniao.filter(
        (r): r is ResultadoReuniao => r !== 'SEM_RESULTADO',
      );
      condicoes.push({
        tipo: 'REUNIAO',
        OR: [
          ...(resultados.length > 0
            ? [{ resultadoReuniao: { in: resultados } }]
            : []),
          ...(filtro.resultadoReuniao.includes('SEM_RESULTADO')
            ? [{ resultadoReuniao: null }]
            : []),
        ],
      });
    }
    if (filtro.aguardandoResultado !== undefined) {
      condicoes.push(
        filtro.aguardandoResultado
          ? condicaoAguardandoResultado(new Date())
          : condicaoNaoAguardandoResultado(new Date()),
      );
    }
    if (filtro.encaminhadas !== undefined) {
      condicoes.push(
        filtro.encaminhadas
          ? { encaminhadaEm: { not: null } }
          : { encaminhadaEm: null },
      );
    }
    if (filtro.busca) {
      condicoes.push({
        OR: [
          { titulo: { contains: filtro.busca, mode: 'insensitive' } },
          { descricao: { contains: filtro.busca, mode: 'insensitive' } },
        ],
      });
    }
    return condicoes;
  }

  private filtroDaLista(
    usuario: UsuarioAutenticado,
    filtro: FiltroAtividadesDto,
    referencia: ReferenciaDeTempo,
    acesso: AcessoAosFunis,
  ): Prisma.AtividadeWhereInput {
    const condicoes = this.condicoesComuns(usuario, filtro, acesso);
    if (filtro.status && filtro.status.length > 0) {
      condicoes.push({ status: { in: filtro.status } });
    }
    if (filtro.grupo) {
      condicoes.push(condicaoDoGrupo(filtro.grupo, referencia));
    }
    if (filtro.atrasadas !== undefined) {
      condicoes.push(
        filtro.atrasadas
          ? condicaoAtrasada(referencia.agora)
          : condicaoNaoAtrasada(referencia.agora),
      );
    }
    const de = lerDataHora(filtro.de);
    const ate = lerDataHora(filtro.ate);
    if (de && ate && ate.getTime() <= de.getTime()) {
      lancarSeHouver([
        { campo: 'ate', mensagens: ['deve ser depois de `de`'] },
      ]);
    }
    if (de || ate) {
      condicoes.push({
        venceEm: { ...(de ? { gte: de } : {}), ...(ate ? { lt: ate } : {}) },
      });
    }
    return { AND: condicoes };
  }
}

function ordemDaLista(
  filtro: FiltroAtividadesDto,
): Prisma.AtividadeOrderByWithRelationInput[] {
  if (!filtro.ordem && filtro.grupo) {
    return ordemDoGrupo(filtro.grupo);
  }
  switch (filtro.ordem ?? 'DATA') {
    case 'DATA':
      return [
        { venceEm: { sort: 'asc', nulls: 'last' } },
        { criadoEm: 'asc' },
        { id: 'asc' },
      ];
    case 'DATA_DESC':
      return [
        { venceEm: { sort: 'desc', nulls: 'last' } },
        { criadoEm: 'desc' },
        { id: 'asc' },
      ];
    case 'CRIACAO_DESC':
      return [{ criadoEm: 'desc' }, { id: 'asc' }];
    case 'CONCLUSAO_DESC':
      return [{ concluidaEm: { sort: 'desc', nulls: 'last' } }, { id: 'asc' }];
    case 'PRIORIDADE':
      return [
        { prioridade: 'desc' },
        { venceEm: { sort: 'asc', nulls: 'last' } },
        { id: 'asc' },
      ];
  }
}

function resumoDaCriacao(
  atividade: Atividade,
  nomeDoResponsavel: string,
): string {
  const { tipo, titulo } = atividade;
  if (tipo === 'NOTA') {
    return `Nota "${titulo}" registrada`;
  }
  if (atividade.status === 'CONCLUIDA') {
    return `${rotuloDoTipo(tipo)} "${titulo}" ${flexionar(tipo, 'registrad')} como ${flexionar(tipo, 'concluíd')}`;
  }
  return `${rotuloDoTipo(tipo)} "${titulo}" ${flexionar(tipo, 'criad')} para ${nomeDoResponsavel}`;
}

function resumoDaAlteracao(
  atividade: Atividade,
  alteracoes: Record<string, Alteracao>,
  troca?: { antes: string; depois: string },
): string {
  const campos = CAMPOS_EDITAVEIS.filter((campo) => campo in alteracoes).map(
    (campo) =>
      campo === 'responsavelId' && troca
        ? `responsável (${troca.antes} → ${troca.depois})`
        : ROTULO_DO_CAMPO[campo],
  );
  return `${rotuloDoTipo(atividade.tipo)} "${atividade.titulo}" ${flexionar(atividade.tipo, 'atualizad')}: ${campos.join(', ')}`;
}

/**
 * R5.9: a atividade que a pessoa vê (R6.4) pode ser de um negócio que ela não
 * vê — o resumo do negócio some da resposta.
 */
function semNegocioInvisivel<
  T extends {
    negocio: { funilId: string; responsavelId: string | null } | null;
  },
>(atividade: T, acesso: AcessoAosFunis): T {
  return atividade.negocio && !acesso.podeVerNegocio(atividade.negocio)
    ? { ...atividade, negocio: null }
    : atividade;
}
