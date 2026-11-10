import { Injectable, Logger } from '@nestjs/common';
import { AuditoriaService } from '../auditoria/auditoria.service';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import type { TemplatesDaConversaDto } from '../canais/templates-canal.dto';
import {
  RegistroCanais,
  ROTULO_DO_TIPO_DE_CANAL,
} from '../canais/registro-canais';
import { calcularAlteracoes } from '../comum/dados/sanitizar';
import { normalizarEtiquetas } from '../comum/dominio/etiquetas';
import { rotuloDoPapel, setorDaPessoa } from '../comum/dominio/papeis';
import {
  ConflitoException,
  DadosInvalidosException,
  NaoEncontradoException,
  RegraVioladaException,
  SemPermissaoException,
} from '../comum/erros/excecoes';
import { montarPagina, paraSkipTake } from '../comum/paginacao/paginacao';
import { EventosDominioService } from '../eventos/eventos-dominio.service';
import type { NegocioDto } from '../funis/dto/negocios.dto';
import { NegociosService } from '../funis/negocios.service';
import { funisAcessiveis } from '../funis/acessos-no-banco';
import type {
  Canal,
  Conversa,
  MotivoAtribuicao,
  Prisma,
} from '../generated/prisma/client';
import { PrismaService, type Tx } from '../prisma/prisma.service';
import { travarChave } from '../prisma/travas';
import { salas } from '../tempo-real/catalogo';
import { TempoRealService } from '../tempo-real/tempo-real.service';
import {
  EVENTOS_DO_ATENDIMENTO,
  REGRA_ATENDIMENTO,
} from './atendimento.constantes';
import { ContagensDoAtendimento } from './contagens.service';
import { type Campos, PessoaDto } from './dto/comum.dto';
import {
  type AcoesDaConversaDto,
  type AtendenteDto,
  type AtribuicaoDto,
  type AtualizarConversaDto,
  type ConversaCompleta,
  type ConversaDetalhada,
  ConversaDetalheDto,
  ConversaResumoDto,
  type CriarNegocioDaConversaDto,
  type FiltroAtendentesDto,
  type FiltroConversasDto,
  INCLUIR_CONVERSA,
  INCLUIR_CONVERSA_DETALHE,
  type PaginaConversasDto,
  type ResolverConversaDto,
  type TransferirConversaDto,
} from './dto/conversa.dto';
import { ORIGEM_DO_CANAL } from './entrada';
import { inicioDaContagem, lerHorario } from './horario';
import { MotorDoAtendimento } from './motor-do-atendimento.service';
import { PERGUNTA_PADRAO_DA_PESQUISA, pesquisaValida } from './satisfacao';
import { prazosDoSla } from './sla';
import {
  filtroDeConversasVisiveis,
  podeUsarAtendimento,
  podeVerConversa,
} from './visibilidade';
import {
  type Area,
  SETOR_COMERCIAL,
  SETOR_MARKETING,
} from '../comum/dominio/setores';

/** Status "em aberto" (R12: no máximo uma por contato e canal). */
const EM_ABERTO = ['ABERTA', 'PENDENTE'] as const;

/** Filtro que não casa com nenhuma conversa (quem não vê nenhuma). */
const NENHUMA_CONVERSA: Prisma.ConversaWhereInput = { id: { in: [] } };

/** Mensagem para quem não usa o Atendimento (Marketing). */
export const SEM_ATENDIMENTO = 'O seu papel não usa o Atendimento.';

/** 403 para quem não usa o Atendimento (o Marketing, R12). */
export function exigirAtendimento(usuario: UsuarioAutenticado): void {
  if (!podeUsarAtendimento(usuario)) {
    throw new SemPermissaoException(SEM_ATENDIMENTO, {
      regra: REGRA_ATENDIMENTO,
    });
  }
}

/**
 * Conversas do Atendimento (R12): lista com o recorte de visibilidade,
 * detalhe, assumir, transferir (pessoa e/ou fila, com nota), resolver (com a
 * pesquisa de satisfação), reabrir, marcar como lida, etiquetas, prioridade,
 * negócio ligado e o histórico de atribuições. Toda mudança numa transação
 * com a auditoria, o histórico, a outbox e o tempo real depois do commit.
 */
@Injectable()
export class ConversasService {
  private readonly logger = new Logger(ConversasService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly motor: MotorDoAtendimento,
    private readonly auditoria: AuditoriaService,
    private readonly eventos: EventosDominioService,
    private readonly registro: RegistroCanais,
    private readonly negocios: NegociosService,
    private readonly contagens: ContagensDoAtendimento,
    private readonly tempoReal: TempoRealService,
  ) {}

  // -------------------------------------------------------------------------
  // Leitura
  // -------------------------------------------------------------------------

  async listar(
    usuario: UsuarioAutenticado,
    filtro: FiltroConversasDto,
  ): Promise<PaginaConversasDto> {
    exigirAtendimento(usuario);
    const visiveis = filtroDeConversasVisiveis(usuario) ?? NENHUMA_CONVERSA;
    const agora = new Date();
    const condicoes: Prisma.ConversaWhereInput[] = [visiveis];
    if (filtro.escopo === 'MINHAS') {
      condicoes.push({ responsavelId: usuario.id });
    } else if (filtro.escopo === 'SEM_RESPONSAVEL') {
      condicoes.push({ responsavelId: null });
    }
    condicoes.push({
      status: { in: filtro.status?.length ? filtro.status : [...EM_ABERTO] },
    });
    if (filtro.filaId) {
      condicoes.push({ filaId: filtro.filaId });
    }
    if (filtro.canalId) {
      condicoes.push({ canalId: filtro.canalId });
    }
    if (filtro.tipoCanal?.length) {
      condicoes.push({ canal: { tipo: { in: filtro.tipoCanal } } });
    }
    if (filtro.responsavelId) {
      condicoes.push({ responsavelId: filtro.responsavelId });
    }
    if (filtro.contatoId) {
      condicoes.push({ contatoId: filtro.contatoId });
    }
    if (filtro.etiqueta?.length) {
      condicoes.push({ etiquetas: { hasSome: filtro.etiqueta } });
    }
    if (filtro.prioridade?.length) {
      condicoes.push({ prioridade: { in: filtro.prioridade } });
    }
    if (filtro.naoLidas) {
      condicoes.push({ naoLidas: { gt: 0 } });
    }
    if (filtro.slaEstourado) {
      condicoes.push({
        status: { not: 'RESOLVIDA' },
        OR: [
          { primeiraRespostaEm: null, slaPrimeiraRespostaAte: { lte: agora } },
          { slaResolucaoAte: { lte: agora } },
        ],
      });
    }
    if (filtro.atendidasPelaIa === false) {
      condicoes.push({ sdr: { is: null } });
    }
    if (
      filtro.atendidasPelaIa === true ||
      filtro.sdrModo?.length ||
      filtro.sdrSituacao?.length
    ) {
      condicoes.push({
        sdr: {
          is: {
            ...(filtro.sdrModo?.length ? { modo: { in: filtro.sdrModo } } : {}),
            ...(filtro.sdrSituacao?.length
              ? { situacao: { in: filtro.sdrSituacao } }
              : {}),
          },
        },
      });
    }
    if (filtro.busca) {
      condicoes.push({ OR: filtroDeBusca(filtro.busca) });
    }
    const where: Prisma.ConversaWhereInput = { AND: condicoes };
    const emAberto: Prisma.ConversaWhereInput = {
      AND: [visiveis, { status: { in: [...EM_ABERTO] } }],
    };
    const [itens, total, minhas, semResponsavel, todas, naoLidas] =
      await Promise.all([
        this.prisma.conversa.findMany({
          where,
          include: INCLUIR_CONVERSA,
          orderBy: [
            { ultimaMensagemEm: { sort: 'desc', nulls: 'last' } },
            { criadoEm: 'desc' },
            { id: 'asc' },
          ],
          ...paraSkipTake(filtro),
        }),
        this.prisma.conversa.count({ where }),
        this.prisma.conversa.count({
          where: { AND: [emAberto, { responsavelId: usuario.id }] },
        }),
        this.prisma.conversa.count({
          where: { AND: [emAberto, { responsavelId: null }] },
        }),
        this.prisma.conversa.count({ where: emAberto }),
        this.contagens.contar(usuario),
      ]);
    return {
      ...montarPagina(
        itens.map((conversa) => ConversaResumoDto.de(conversa, agora)),
        total,
        filtro,
      ),
      contadores: { minhas, semResponsavel, todas, naoLidas },
    };
  }

  async detalhar(
    usuario: UsuarioAutenticado,
    id: string,
  ): Promise<ConversaDetalheDto> {
    exigirAtendimento(usuario);
    const conversa = await this.prisma.conversa.findUnique({
      where: { id },
      include: INCLUIR_CONVERSA_DETALHE,
    });
    if (!conversa || !podeVerConversa(usuario, conversa)) {
      throw new NaoEncontradoException('Conversa não encontrada.');
    }
    const canal = await this.prisma.canal.findUniqueOrThrow({
      where: { id: conversa.canalId },
    });
    return this.montarDetalhe(
      conversa,
      canal,
      await this.veONegocio(usuario, conversa),
    );
  }

  /** R5.9: o negócio ligado à conversa só aparece para quem vê o funil dele. */
  private async veONegocio(
    usuario: UsuarioAutenticado,
    conversa: ConversaDetalhada,
  ): Promise<boolean> {
    if (!conversa.negocio) {
      return true;
    }
    return (await funisAcessiveis(this.prisma, usuario)).podeVerNegocio({
      funilId: conversa.negocio.funil.id,
      responsavelId: conversa.negocio.responsavelId,
    });
  }

  /** A contagem do menu (`nao-lidas.atendimento`). */
  async naoLidas(
    usuario: UsuarioAutenticado,
  ): Promise<{ atendimento: number }> {
    exigirAtendimento(usuario);
    return { atendimento: await this.contagens.contar(usuario) };
  }

  /** Histórico de quem cuidou da conversa. */
  async atribuicoes(
    usuario: UsuarioAutenticado,
    id: string,
  ): Promise<AtribuicaoDto[]> {
    await this.visivel(this.prisma, usuario, id);
    const PESSOA = { select: { id: true, nome: true, avatarUrl: true } };
    const FILA = { select: { id: true, nome: true, area: true } };
    const linhas = await this.prisma.conversaAtribuicao.findMany({
      where: { conversaId: id },
      orderBy: [{ criadoEm: 'asc' }, { id: 'asc' }],
      include: {
        deUsuario: PESSOA,
        paraUsuario: PESSOA,
        porUsuario: PESSOA,
        deFila: FILA,
        paraFila: FILA,
      },
    });
    return linhas.map((linha) => ({
      id: linha.id,
      motivo: linha.motivo,
      de: PessoaDto.ouNulo(linha.deUsuario),
      para: PessoaDto.ouNulo(linha.paraUsuario),
      deFila: linha.deFila,
      paraFila: linha.paraFila,
      nota: linha.nota,
      por: PessoaDto.ouNulo(linha.porUsuario),
      tipoAtor: linha.tipoAtor,
      criadoEm: linha.criadoEm.toISOString(),
    }));
  }

  /** Etiquetas em uso nas conversas que a pessoa vê. */
  async etiquetas(usuario: UsuarioAutenticado): Promise<string[]> {
    exigirAtendimento(usuario);
    const visiveis = filtroDeConversasVisiveis(usuario) ?? NENHUMA_CONVERSA;
    const conversas = await this.prisma.conversa.findMany({
      where: { AND: [visiveis, { etiquetas: { isEmpty: false } }] },
      select: { etiquetas: true },
      take: 5000,
      orderBy: { atualizadoEm: 'desc' },
    });
    return [
      ...new Set(conversas.flatMap((conversa) => conversa.etiquetas)),
    ].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  }

  /** Quem pode receber conversas (para transferir): ativos das áreas que atendem. */
  async atendentes(
    usuario: UsuarioAutenticado,
    filtro: FiltroAtendentesDto,
  ): Promise<AtendenteDto[]> {
    exigirAtendimento(usuario);
    const pessoas = await this.prisma.usuario.findMany({
      where: {
        ativo: true,
        // Só Líder e Membro têm setor; o Marketing não atende (R12).
        ...(filtro.area
          ? { area: filtro.area }
          : {
              OR: [{ area: null }, { area: { not: SETOR_MARKETING } }],
            }),
        ...(filtro.busca
          ? { nome: { contains: filtro.busca, mode: 'insensitive' } }
          : {}),
      },
      select: {
        id: true,
        nome: true,
        avatarUrl: true,
        papel: true,
        area: true,
      },
      orderBy: [{ nome: 'asc' }, { id: 'asc' }],
    });
    const cargas = await this.prisma.conversa.groupBy({
      by: ['responsavelId'],
      where: {
        responsavelId: { in: pessoas.map((pessoa) => pessoa.id) },
        status: { not: 'RESOLVIDA' },
      },
      _count: { _all: true },
    });
    const porPessoa = new Map(
      cargas.map((carga) => [carga.responsavelId, carga._count._all]),
    );
    const conectados = new Set(
      this.tempoReal.ativo ? await this.tempoReal.usuariosConectados() : [],
    );
    return pessoas.map((pessoa) => ({
      ...PessoaDto.de(pessoa),
      papel: pessoa.papel,
      rotuloPapel: rotuloDoPapel(pessoa.papel, pessoa.area),
      area: setorDaPessoa(pessoa),
      emAberto: porPessoa.get(pessoa.id) ?? 0,
      conectado: conectados.has(pessoa.id),
    }));
  }

  // -------------------------------------------------------------------------
  // Ações
  // -------------------------------------------------------------------------

  /** Muda status (ABERTA ↔ PENDENTE), prioridade, assunto, etiquetas ou negócio ligado. */
  async atualizar(
    usuario: UsuarioAutenticado,
    id: string,
    dto: AtualizarConversaDto,
  ): Promise<ConversaDetalheDto> {
    let negocioId: string | null | undefined = dto.negocioId;
    if (negocioId) {
      negocioId = await this.negocioDoContato(usuario, id, negocioId);
    }
    await this.prisma.$transaction(async (tx) => {
      const antes = await this.travarVisivel(tx, usuario, id);
      const dados: Prisma.ConversaUncheckedUpdateInput = {};
      if (dto.status !== undefined && dto.status !== antes.status) {
        if (antes.status === 'RESOLVIDA') {
          throw new RegraVioladaException(
            REGRA_ATENDIMENTO,
            'A conversa está resolvida: use "Reabrir" para voltar a atendê-la.',
            { motivo: 'conversa_resolvida' },
          );
        }
        dados.status = dto.status;
      }
      if (dto.prioridade !== undefined) {
        dados.prioridade = dto.prioridade;
      }
      if (dto.assunto !== undefined) {
        dados.assunto = dto.assunto;
      }
      if (dto.etiquetas !== undefined) {
        dados.etiquetas = normalizarEtiquetas(dto.etiquetas);
      }
      if (negocioId !== undefined) {
        dados.negocioId = negocioId;
      }
      const depois = await tx.conversa.update({
        where: { id },
        data: dados,
      });
      const alteracoes = calcularAlteracoes(antes, depois, [
        'status',
        'prioridade',
        'assunto',
        'etiquetas',
        'negocioId',
      ]);
      if (Object.keys(alteracoes).length === 0) {
        return;
      }
      await this.auditoria.registrar(tx, {
        acao: 'conversa.atualizada',
        entidade: 'conversa',
        entidadeId: id,
        resumo: `Conversa com "${antes.contato.nome}" alterada (${Object.keys(alteracoes).join(', ')})`,
        dados: { alteracoes },
        relacionados: {
          contato: antes.contatoId,
          negocio: depois.negocioId ?? antes.negocioId,
        },
      });
      await this.motor.emitirConversa(tx, id);
    });
    return this.detalhar(usuario, id);
  }

  /** Assume uma conversa em aberto sem responsável (R12). 409 se já tem. */
  async assumir(
    usuario: UsuarioAutenticado,
    id: string,
  ): Promise<ConversaDetalheDto> {
    await this.prisma.$transaction(async (tx) => {
      const conversa = await this.travarVisivel(tx, usuario, id);
      this.exigirEmAberto(conversa);
      if (conversa.responsavelId) {
        throw new ConflitoException(
          conversa.responsavelId === usuario.id
            ? 'Esta conversa já está com você.'
            : `Esta conversa já está com ${conversa.responsavel?.nome ?? 'outra pessoa'}.`,
          { responsavelId: conversa.responsavelId },
        );
      }
      const salasAntes = this.motor.salas(conversa);
      const atualizada = await this.motor.atribuir(tx, conversa, {
        usuarioId: usuario.id,
        motivo: 'ASSUMIDA',
      });
      await this.motor.avisoDeSistema(
        tx,
        { ...atualizada, fila: conversa.fila },
        `${usuario.nome} assumiu a conversa.`,
        { evento: 'assumida', usuarioId: usuario.id },
      );
      await this.auditoria.registrar(tx, {
        acao: 'conversa.assumida',
        entidade: 'conversa',
        entidadeId: id,
        resumo: `${usuario.nome} assumiu a conversa com "${conversa.contato.nome}"`,
        relacionados: { contato: conversa.contatoId },
      });
      await this.eventos.publicar(
        tx,
        EVENTOS_DO_ATENDIMENTO.CONVERSA_ATRIBUIDA,
        {
          conversaId: id,
          responsavelId: usuario.id,
          motivo: 'ASSUMIDA',
        },
      );
      await this.motor.emitirConversa(tx, id, { salasAntes });
      await this.motor.publicarContagens(tx, {
        usuarios: [usuario.id],
        areas: [conversa.fila?.area],
      });
    });
    await this.podarSala(id);
    return this.detalhar(usuario, id);
  }

  /**
   * Transfere para uma pessoa e/ou outra fila, com nota (R12). Só para a fila:
   * a conversa fica sem responsável e entra na distribuição dela. Alguém de
   * outra área só recebe com uma fila da área dele.
   */
  async transferir(
    usuario: UsuarioAutenticado,
    id: string,
    dto: TransferirConversaDto,
  ): Promise<ConversaDetalheDto> {
    if (!dto.usuarioId && !dto.filaId) {
      throw new DadosInvalidosException(
        'Escolha para quem (ou para qual fila) transferir.',
        {
          campos: [
            { campo: 'usuarioId', mensagens: ['informe a pessoa ou a fila'] },
          ],
        },
      );
    }
    const continuaVendo = await this.prisma.$transaction(async (tx) => {
      const conversa = await this.travarVisivel(tx, usuario, id);
      this.exigirEmAberto(conversa);
      const filaDestino = dto.filaId
        ? await this.filaParaReceber(tx, dto.filaId)
        : null;
      const pessoa = dto.usuarioId
        ? await this.pessoaParaReceber(tx, dto.usuarioId)
        : null;
      const areaFinal = filaDestino?.area ?? conversa.fila?.area ?? null;
      if (pessoa) {
        const areaDaPessoa = setorDaPessoa(pessoa);
        if (areaDaPessoa && areaFinal && areaDaPessoa !== areaFinal) {
          throw new RegraVioladaException(
            REGRA_ATENDIMENTO,
            filaDestino
              ? `${pessoa.nome} não atende a fila ${filaDestino.nome}: escolha uma fila do setor dela.`
              : `Para transferir para alguém de outro setor, escolha também uma fila do setor de ${pessoa.nome}.`,
            { motivo: 'area_diferente' },
          );
        }
      }
      const filaId = filaDestino?.id ?? conversa.filaId;
      const novoResponsavel = pessoa?.id ?? null;
      if (
        novoResponsavel === conversa.responsavelId &&
        filaId === conversa.filaId
      ) {
        throw new ConflitoException(
          pessoa
            ? `A conversa já está com ${pessoa.nome}.`
            : 'A conversa já está nesta fila.',
        );
      }
      const salasAntes = this.motor.salas(conversa);
      const motivo: MotivoAtribuicao =
        conversa.responsavelId === null &&
        filaId === conversa.filaId &&
        novoResponsavel !== usuario.id
          ? 'MANUAL'
          : 'TRANSFERENCIA';
      let atualizada = await this.motor.atribuir(tx, conversa, {
        usuarioId: novoResponsavel,
        filaId,
        motivo,
        nota: dto.nota || null,
      });
      if (filaId !== conversa.filaId) {
        atualizada = await this.recalcularSla(tx, atualizada);
      }
      if (!pessoa) {
        atualizada = await this.motor.distribuir(tx, atualizada);
      }
      const destino = await tx.conversa.findUniqueOrThrow({
        where: { id },
        include: INCLUIR_CONVERSA,
      });
      const descricao = [
        destino.responsavel ? `para ${destino.responsavel.nome}` : null,
        filaDestino ? `na fila ${filaDestino.nome}` : null,
      ]
        .filter(Boolean)
        .join(' ');
      await this.motor.avisoDeSistema(
        tx,
        destino,
        `${usuario.nome} transferiu a conversa${descricao ? ` ${descricao}` : ''}.${dto.nota ? ` Nota: ${dto.nota}` : ''}`,
        {
          evento: 'transferida',
          de: conversa.responsavelId,
          para: destino.responsavelId,
          deFilaId: conversa.filaId,
          paraFilaId: destino.filaId,
          nota: dto.nota ?? null,
        },
      );
      await this.auditoria.registrar(tx, {
        acao: 'conversa.transferida',
        entidade: 'conversa',
        entidadeId: id,
        resumo: `Conversa com "${conversa.contato.nome}" transferida${conversa.responsavel ? ` de ${conversa.responsavel.nome}` : ''}${descricao ? ` ${descricao}` : ''}`,
        dados: {
          deUsuarioId: conversa.responsavelId,
          paraUsuarioId: destino.responsavelId,
          deFilaId: conversa.filaId,
          paraFilaId: destino.filaId,
          nota: dto.nota ?? null,
        },
        relacionados: { contato: conversa.contatoId },
      });
      await this.eventos.publicar(
        tx,
        EVENTOS_DO_ATENDIMENTO.CONVERSA_TRANSFERIDA,
        {
          conversaId: id,
          deUsuarioId: conversa.responsavelId,
          paraUsuarioId: destino.responsavelId,
          deFilaId: conversa.filaId,
          paraFilaId: destino.filaId,
        },
      );
      await this.motor.emitirConversa(tx, id, { salasAntes });
      await this.motor.publicarContagens(tx, {
        usuarios: [conversa.responsavelId, destino.responsavelId],
        areas: [conversa.fila?.area, destino.fila?.area],
      });
      return podeVerConversa(usuario, destino);
    });
    // Quem deixou de ver a conversa (inclusive quem transferiu) sai da sala dela.
    await this.podarSala(id);
    if (!continuaVendo) {
      const conversa = await this.prisma.conversa.findUniqueOrThrow({
        where: { id },
        include: INCLUIR_CONVERSA_DETALHE,
      });
      const canal = await this.prisma.canal.findUniqueOrThrow({
        where: { id: conversa.canalId },
      });
      // Quem transferiu para fora do próprio alcance recebe a última foto da conversa.
      return {
        ...this.montarDetalhe(
          conversa,
          canal,
          await this.veONegocio(usuario, conversa),
        ),
        acoes: SEM_ACOES,
      };
    }
    return this.detalhar(usuario, id);
  }

  /**
   * Resolve a conversa (R12) e, se o canal tiver a pesquisa ligada (e o
   * contato já tiver escrito), pede a nota de 1 a 5 — válida por 24 h.
   */
  async resolver(
    usuario: UsuarioAutenticado,
    id: string,
    dto: ResolverConversaDto,
  ): Promise<ConversaDetalheDto> {
    await this.prisma.$transaction(async (tx) => {
      const conversa = await this.travarVisivel(tx, usuario, id);
      if (conversa.status === 'RESOLVIDA') {
        throw new ConflitoException('Esta conversa já está resolvida.');
      }
      const agora = new Date();
      const resolvida = await tx.conversa.update({
        where: { id },
        data: {
          status: 'RESOLVIDA',
          resolvidaEm: agora,
          resolvidaPorId: usuario.id,
          aguardandoDesde: null,
          naoLidas: 0,
        },
      });
      await tx.mensagem.updateMany({
        where: { conversaId: id, direcao: 'ENTRADA', lidaEm: null },
        data: { lidaEm: agora },
      });
      await this.motor.avisoDeSistema(
        tx,
        { ...resolvida, fila: conversa.fila },
        `Conversa resolvida por ${usuario.nome}.`,
        { evento: 'resolvida', usuarioId: usuario.id },
      );
      const canal = await tx.canal.findUniqueOrThrow({
        where: { id: conversa.canalId },
      });
      let pesquisaEnviada = false;
      if (
        dto.enviarPesquisa !== false &&
        canal.pesquisaSatisfacao &&
        canal.ativo &&
        !canal.excluidoEm &&
        conversa.ultimaEntradaEm !== null &&
        conversa.satisfacaoRespondidaEm === null &&
        this.registro.buscar(canal.tipo) !== undefined &&
        this.registro.podeResponder(resolvida, canal).pode
      ) {
        const comPesquisa = await tx.conversa.update({
          where: { id },
          data: { satisfacaoSolicitadaEm: agora },
        });
        await this.motor.criarSaida(tx, comPesquisa, canal, {
          texto:
            canal.mensagemSatisfacao?.trim() || PERGUNTA_PADRAO_DA_PESQUISA,
          autorId: null,
          metadados: { automatica: 'pesquisa_de_satisfacao' },
        });
        pesquisaEnviada = true;
      }
      await this.auditoria.registrar(tx, {
        acao: 'conversa.resolvida',
        entidade: 'conversa',
        entidadeId: id,
        resumo: `Conversa com "${conversa.contato.nome}" resolvida por ${usuario.nome}${pesquisaEnviada ? ' (pesquisa de satisfação enviada)' : ''}`,
        dados: { pesquisaEnviada },
        relacionados: { contato: conversa.contatoId },
      });
      await this.eventos.publicar(
        tx,
        EVENTOS_DO_ATENDIMENTO.CONVERSA_RESOLVIDA,
        {
          conversaId: id,
          canalId: conversa.canalId,
          contatoId: conversa.contatoId,
          filaId: conversa.filaId,
          responsavelId: conversa.responsavelId,
          resolvidaPorId: usuario.id,
          duracaoSegundos: Math.round(
            (agora.getTime() - conversa.criadoEm.getTime()) / 1000,
          ),
          pesquisaEnviada,
        },
      );
      await this.motor.emitirConversa(tx, id);
      await this.motor.publicarContagens(tx, this.motor.afetadosPor(conversa));
    });
    return this.detalhar(usuario, id);
  }

  /**
   * Reabre uma conversa resolvida (R12). 409 se o contato já tem outra
   * conversa em aberto no canal. Sem responsável ativo, fica com quem reabriu.
   */
  async reabrir(
    usuario: UsuarioAutenticado,
    id: string,
  ): Promise<ConversaDetalheDto> {
    await this.prisma.$transaction(async (tx) => {
      // Mesma ordem de travas da entrada (`receber`): primeiro a chave do
      // contato no canal, depois a linha da conversa — senão uma nota de
      // satisfação chegando junto pode travar as duas transações.
      const previa = await this.visivel(tx, usuario, id);
      await travarChave(
        tx,
        'atendimento-conversa',
        previa.canalId,
        previa.contatoId,
      );
      const conversa = await this.travarVisivel(tx, usuario, id);
      if (conversa.status !== 'RESOLVIDA') {
        throw new ConflitoException('Esta conversa já está em aberto.');
      }
      const outra = await tx.conversa.findFirst({
        where: {
          canalId: conversa.canalId,
          contatoId: conversa.contatoId,
          status: { not: 'RESOLVIDA' },
          id: { not: id },
        },
        select: { id: true },
      });
      if (outra) {
        throw new ConflitoException(
          'O contato já tem outra conversa em aberto neste canal: continue por ela.',
          { conversaId: outra.id },
        );
      }
      const salasAntes = this.motor.salas(conversa);
      const agora = new Date();
      const fila = conversa.filaId
        ? await tx.filaAtendimento.findUnique({
            where: { id: conversa.filaId },
          })
        : null;
      let reaberta = await tx.conversa.update({
        where: { id },
        data: {
          status: 'ABERTA',
          resolvidaEm: null,
          resolvidaPorId: null,
          reaberturas: { increment: 1 },
          slaResolucaoAte: prazosDoSla(fila, agora).slaResolucaoAte,
          slaResolucaoAvisadoEm: null,
        },
      });
      const responsavelAtivo = conversa.responsavelId
        ? await tx.usuario.findFirst({
            where: { id: conversa.responsavelId, ativo: true },
            select: { id: true },
          })
        : null;
      if (!responsavelAtivo) {
        reaberta = await this.motor.atribuir(tx, reaberta, {
          usuarioId: usuario.id,
          motivo: 'REABERTURA',
        });
      }
      await this.motor.avisoDeSistema(
        tx,
        { ...reaberta, fila: conversa.fila },
        `Conversa reaberta por ${usuario.nome}.`,
        { evento: 'reaberta', usuarioId: usuario.id },
      );
      await this.auditoria.registrar(tx, {
        acao: 'conversa.reaberta',
        entidade: 'conversa',
        entidadeId: id,
        resumo: `Conversa com "${conversa.contato.nome}" reaberta por ${usuario.nome}`,
        relacionados: { contato: conversa.contatoId },
      });
      await this.eventos.publicar(
        tx,
        EVENTOS_DO_ATENDIMENTO.CONVERSA_REABERTA,
        {
          conversaId: id,
          responsavelId: reaberta.responsavelId,
          filaId: reaberta.filaId,
        },
      );
      await this.motor.emitirConversa(tx, id, { salasAntes });
      await this.motor.publicarContagens(tx, {
        usuarios: [reaberta.responsavelId],
      });
    });
    await this.podarSala(id);
    return this.detalhar(usuario, id);
  }

  /**
   * Marca as mensagens do contato como lidas. Só o responsável (ou qualquer um
   * que veja, se a conversa está sem responsável): o líder que espia não
   * apaga o aviso de quem atende.
   */
  async marcarLida(
    usuario: UsuarioAutenticado,
    id: string,
  ): Promise<ConversaDetalheDto> {
    await this.prisma.$transaction(async (tx) => {
      const conversa = await this.travarVisivel(tx, usuario, id);
      const podeMarcar =
        conversa.responsavelId === null ||
        conversa.responsavelId === usuario.id;
      if (!podeMarcar || conversa.naoLidas === 0) {
        return;
      }
      await tx.conversa.update({ where: { id }, data: { naoLidas: 0 } });
      await tx.mensagem.updateMany({
        where: { conversaId: id, direcao: 'ENTRADA', lidaEm: null },
        data: { lidaEm: new Date() },
      });
      await this.motor.emitirConversa(tx, id);
      await this.motor.publicarContagens(tx, this.motor.afetadosPor(conversa));
    });
    return this.detalhar(usuario, id);
  }

  /**
   * Cria um negócio para o contato da conversa (padrão: funil-base da área da
   * fila) e o liga à conversa. As regras do negócio são as dos funis (R5).
   */
  async criarNegocio(
    usuario: UsuarioAutenticado,
    id: string,
    dto: CriarNegocioDaConversaDto,
  ): Promise<NegocioDto> {
    const conversa = await this.visivel(this.prisma, usuario, id);
    if (conversa.contato.excluidoEm) {
      throw new RegraVioladaException(
        REGRA_ATENDIMENTO,
        'O contato desta conversa foi excluído: não dá para criar negócio.',
        { motivo: 'contato_excluido' },
      );
    }
    let funilId = dto.funilId;
    if (!funilId) {
      const area: Area =
        conversa.fila?.area ?? setorDaPessoa(usuario) ?? SETOR_COMERCIAL;
      const base = await this.prisma.funil.findFirst({
        where: { area, base: true, excluidoEm: null },
        select: { id: true },
      });
      if (!base) {
        throw new RegraVioladaException(
          REGRA_ATENDIMENTO,
          'Não há funil para criar o negócio: escolha um funil.',
          { motivo: 'sem_funil' },
        );
      }
      funilId = base.id;
    }
    const negocio = await this.negocios.criar(usuario, {
      contatoId: conversa.contatoId,
      funilId,
      ...(dto.etapaId ? { etapaId: dto.etapaId } : {}),
      ...(dto.titulo ? { titulo: dto.titulo } : {}),
      ...(dto.valor ? { valor: dto.valor } : {}),
      origem: ORIGEM_DO_CANAL[conversa.canal.tipo],
      origemDetalhe: conversa.canal.nome,
    });
    await this.prisma.$transaction(async (tx) => {
      const atual = await this.travarVisivel(tx, usuario, id);
      await tx.conversa.update({
        where: { id },
        data: { negocioId: negocio.id },
      });
      await this.motor.avisoDeSistema(
        tx,
        atual,
        `${usuario.nome} criou o negócio "${negocio.titulo}" (${negocio.funil.nome}) a partir desta conversa.`,
        { evento: 'negocio_criado', negocioId: negocio.id },
      );
      await this.auditoria.registrar(tx, {
        acao: 'conversa.negocio_ligado',
        entidade: 'conversa',
        entidadeId: id,
        resumo: `Negócio "${negocio.titulo}" criado a partir da conversa com "${atual.contato.nome}"`,
        dados: { negocioId: negocio.id, anterior: atual.negocioId },
        relacionados: { contato: atual.contatoId, negocio: negocio.id },
      });
      await this.motor.emitirConversa(tx, id);
    });
    return negocio;
  }

  // -------------------------------------------------------------------------
  // Apoio
  // -------------------------------------------------------------------------

  /**
   * Depois de a conversa mudar de mãos (já confirmada no banco): tira da sala
   * `conversa:<id>` quem está conectado e deixou de vê-la — ex.: os colegas da
   * área que olhavam a conversa sem responsável quando alguém a assume.
   * Melhor esforço: uma falha aqui não desfaz a operação.
   */
  async podarSala(conversaId: string): Promise<void> {
    try {
      if (!this.tempoReal.ativo) {
        return;
      }
      const conectados = await this.tempoReal.usuariosConectados();
      if (conectados.length === 0) {
        return;
      }
      const [conversa, pessoas] = await Promise.all([
        this.prisma.conversa.findUnique({
          where: { id: conversaId },
          select: { responsavelId: true, fila: { select: { area: true } } },
        }),
        this.prisma.usuario.findMany({
          where: { id: { in: conectados } },
          select: { id: true, papel: true, area: true },
        }),
      ]);
      for (const pessoa of pessoas) {
        if (!conversa || !podeVerConversa(pessoa, conversa)) {
          this.tempoReal.removerDaSala(pessoa.id, salas.conversa(conversaId));
        }
      }
    } catch (erro) {
      this.logger.warn(
        `Não deu para atualizar a sala da conversa ${conversaId}: ${erro instanceof Error ? erro.message : String(erro)}`,
      );
    }
  }

  /** A conversa, se a pessoa a vê (404 se não). */
  async visivel(
    tx: Tx | PrismaService,
    usuario: UsuarioAutenticado,
    id: string,
  ): Promise<ConversaCompleta> {
    exigirAtendimento(usuario);
    const conversa = await tx.conversa.findUnique({
      where: { id },
      include: INCLUIR_CONVERSA,
    });
    if (!conversa || !podeVerConversa(usuario, conversa)) {
      throw new NaoEncontradoException('Conversa não encontrada.');
    }
    return conversa;
  }

  /** Trava a linha da conversa (`FOR UPDATE`) e confere a visibilidade. */
  async travarVisivel(
    tx: Tx,
    usuario: UsuarioAutenticado,
    id: string,
  ): Promise<ConversaCompleta> {
    exigirAtendimento(usuario);
    await tx.$queryRaw`SELECT id FROM conversas WHERE id = ${id}::uuid FOR UPDATE`;
    return this.visivel(tx, usuario, id);
  }

  exigirEmAberto(conversa: Conversa): void {
    if (conversa.status === 'RESOLVIDA') {
      throw new RegraVioladaException(
        REGRA_ATENDIMENTO,
        'A conversa está resolvida: reabra para continuar o atendimento.',
        { motivo: 'conversa_resolvida' },
      );
    }
  }

  /**
   * Templates que dá para enviar nesta conversa (canais que usam templates, como o
   * WhatsApp oficial, R28), com as variáveis, e a situação da janela de 24 h.
   * Canal sem templates: `suportado: false` e lista vazia.
   */
  async templates(
    usuario: UsuarioAutenticado,
    id: string,
  ): Promise<TemplatesDaConversaDto> {
    const conversa = await this.visivel(this.prisma, usuario, id);
    const canal = await this.prisma.canal.findUniqueOrThrow({
      where: { id: conversa.canalId },
    });
    const adaptador = this.registro.buscar(canal.tipo);
    if (!adaptador?.listarTemplates) {
      return {
        suportado: false,
        janelaAberta: true,
        janelaAte: null,
        aviso: null,
        sincronizadoEm: null,
        itens: [],
      };
    }
    const permissao = this.registro.podeResponder(conversa, canal);
    const itens = await adaptador.listarTemplates(canal, {
      somenteUsaveis: true,
    });
    const sincronizadoEm = itens.reduce<string | null>(
      (maior, item) =>
        maior === null || item.sincronizadoEm > maior
          ? item.sincronizadoEm
          : maior,
      null,
    );
    return {
      suportado: true,
      janelaAberta: permissao.pode,
      janelaAte: conversa.janelaAte?.toISOString() ?? null,
      aviso: permissao.pode ? null : (permissao.motivo ?? null),
      sincronizadoEm,
      itens,
    };
  }

  montarDetalhe(
    conversa: ConversaDetalhada,
    canal: Canal,
    mostrarNegocio = true,
  ): Campos<ConversaDetalheDto> {
    const agora = new Date();
    const emAberto = conversa.status !== 'RESOLVIDA';
    const disponivel =
      canal.ativo &&
      !canal.excluidoEm &&
      this.registro.buscar(canal.tipo) !== undefined;
    const permissao = disponivel
      ? this.registro.podeResponder(conversa, canal)
      : {
          pode: false,
          motivo: canal.ativo
            ? `O canal ${ROTULO_DO_TIPO_DE_CANAL[canal.tipo]} não está disponível nesta instalação.`
            : 'O canal desta conversa está desativado.',
        };
    const acoes: AcoesDaConversaDto = {
      assumir: emAberto && conversa.responsavelId === null,
      transferir: emAberto,
      resolver: emAberto,
      reabrir: !emAberto,
      responder: emAberto && permissao.pode,
      enviarTemplate:
        emAberto &&
        disponivel &&
        this.registro.buscar(canal.tipo)?.prepararTemplate !== undefined,
      criarNegocio: conversa.contato.excluidoEm === null,
    };
    const negocio =
      mostrarNegocio && conversa.negocio && !conversa.negocio.excluidoEm
        ? conversa.negocio
        : null;
    return {
      ...ConversaResumoDto.de(conversa, agora),
      primeiraRespostaEm: conversa.primeiraRespostaEm?.toISOString() ?? null,
      resolvidaPor: PessoaDto.ouNulo(conversa.resolvidaPor),
      reaberturas: conversa.reaberturas,
      satisfacao: {
        solicitadaEm: conversa.satisfacaoSolicitadaEm?.toISOString() ?? null,
        nota: conversa.satisfacaoNota,
        comentario: conversa.satisfacaoComentario,
        respondidaEm: conversa.satisfacaoRespondidaEm?.toISOString() ?? null,
        aguardando:
          conversa.status === 'RESOLVIDA' &&
          pesquisaValida(
            conversa.satisfacaoSolicitadaEm,
            conversa.satisfacaoRespondidaEm,
            agora,
          ),
      },
      negocio: negocio
        ? {
            id: negocio.id,
            titulo: negocio.titulo,
            status: negocio.status,
            funil: negocio.funil,
          }
        : null,
      podeResponder: {
        pode: permissao.pode,
        motivo: permissao.motivo ?? null,
        apenasTemplate: permissao.apenasTemplate ?? false,
      },
      acoes,
    };
  }

  /** O negócio informado é do contato da conversa e a pessoa o vê? (Devolve o id.) */
  private async negocioDoContato(
    usuario: UsuarioAutenticado,
    conversaId: string,
    negocioId: string,
  ): Promise<string> {
    const conversa = await this.visivel(this.prisma, usuario, conversaId);
    const negocio = await this.negocios.detalhar(usuario, negocioId);
    if (negocio.contato.id !== conversa.contatoId) {
      throw new RegraVioladaException(
        REGRA_ATENDIMENTO,
        'O negócio escolhido é de outro contato.',
        { motivo: 'negocio_de_outro_contato' },
      );
    }
    return negocio.id;
  }

  private async filaParaReceber(tx: Tx, filaId: string) {
    const fila = await tx.filaAtendimento.findFirst({
      where: { id: filaId, excluidoEm: null },
    });
    if (!fila) {
      throw new NaoEncontradoException('Fila não encontrada.');
    }
    if (!fila.ativa) {
      throw new RegraVioladaException(
        REGRA_ATENDIMENTO,
        `A fila ${fila.nome} está desativada.`,
        { motivo: 'fila_desativada' },
      );
    }
    return fila;
  }

  private async pessoaParaReceber(tx: Tx, usuarioId: string) {
    const pessoa = await tx.usuario.findUnique({
      where: { id: usuarioId },
      select: { id: true, nome: true, papel: true, area: true, ativo: true },
    });
    if (!pessoa) {
      throw new NaoEncontradoException('Pessoa não encontrada.');
    }
    if (!pessoa.ativo) {
      throw new RegraVioladaException(
        REGRA_ATENDIMENTO,
        `${pessoa.nome} está desligado(a) e não recebe conversas.`,
        { motivo: 'usuario_inativo' },
      );
    }
    if (!podeUsarAtendimento(pessoa)) {
      throw new RegraVioladaException(
        REGRA_ATENDIMENTO,
        `${pessoa.nome} é do Marketing, que não usa o Atendimento.`,
        { motivo: 'papel_sem_atendimento' },
      );
    }
    return pessoa;
  }

  /**
   * Prazos do SLA de novo, com a fila nova, contados da chegada da conversa.
   * A primeira resposta só tem prazo na conversa que o contato começou.
   */
  private async recalcularSla(tx: Tx, conversa: Conversa): Promise<Conversa> {
    const [fila, canal, primeira] = await Promise.all([
      conversa.filaId
        ? tx.filaAtendimento.findUnique({ where: { id: conversa.filaId } })
        : Promise.resolve(null),
      tx.canal.findUniqueOrThrow({
        where: { id: conversa.canalId },
        select: { horarioAtendimento: true },
      }),
      tx.mensagem.findFirst({
        where: {
          conversaId: conversa.id,
          direcao: { in: ['ENTRADA', 'SAIDA'] },
        },
        orderBy: [{ ocorridaEm: 'asc' }, { id: 'asc' }],
        select: { direcao: true },
      }),
    ]);
    const prazos = prazosDoSla(
      fila,
      inicioDaContagem(lerHorario(canal.horarioAtendimento), conversa.criadoEm),
    );
    if (primeira?.direcao !== 'ENTRADA') {
      prazos.slaPrimeiraRespostaAte = null;
    }
    return tx.conversa.update({
      where: { id: conversa.id },
      data: {
        slaPrimeiraRespostaAte: prazos.slaPrimeiraRespostaAte,
        slaResolucaoAte: prazos.slaResolucaoAte,
        ...(mesmoInstante(
          prazos.slaPrimeiraRespostaAte,
          conversa.slaPrimeiraRespostaAte,
        )
          ? {}
          : { slaPrimeiraRespostaAvisadoEm: null }),
        ...(mesmoInstante(prazos.slaResolucaoAte, conversa.slaResolucaoAte)
          ? {}
          : { slaResolucaoAvisadoEm: null }),
      },
    });
  }
}

const SEM_ACOES: AcoesDaConversaDto = {
  assumir: false,
  transferir: false,
  resolver: false,
  reabrir: false,
  responder: false,
  enviarTemplate: false,
  criarNegocio: false,
};

function mesmoInstante(a: Date | null, b: Date | null): boolean {
  return (a?.getTime() ?? null) === (b?.getTime() ?? null);
}

/** Busca por nome, e-mail ou telefone do contato, ou pelo assunto. */
function filtroDeBusca(busca: string): Prisma.ConversaWhereInput[] {
  const texto = busca.trim();
  const digitos = texto.replace(/\D/g, '');
  return [
    { contato: { nome: { contains: texto, mode: 'insensitive' } } },
    { contato: { email: { contains: texto.toLowerCase() } } },
    ...(digitos.length >= 4
      ? [{ contato: { telefone: { contains: digitos } } }]
      : []),
    { assunto: { contains: texto, mode: 'insensitive' } },
  ];
}
