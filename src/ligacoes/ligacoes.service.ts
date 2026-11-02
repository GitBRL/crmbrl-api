import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { AuditoriaService } from '../auditoria/auditoria.service';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import { dadosDoEvento } from '../atividades/atividades.service';
import { AtendimentoService } from '../atendimento/atendimento.service';
import { exigirAtendimento } from '../atendimento/conversas.service';
import { DistribuicaoDaFila } from '../atendimento/distribuicao-fila.service';
import { lideresParaAvisar } from '../atendimento/lideres';
import { MotorDoAtendimento } from '../atendimento/motor-do-atendimento.service';
import {
  filtroDeConversasVisiveis,
  podeUsarAtendimento,
} from '../atendimento/visibilidade';
import {
  ConflitoException,
  NaoEncontradoException,
  SemPermissaoException,
} from '../comum/erros/excecoes';
import { ehDiretoria } from '../comum/dominio/papeis';
import { traduzirErroDoPrisma } from '../comum/erros/erros-do-prisma';
import { AMBIENTE, type Ambiente } from '../config/ambiente';
import { EventosDominioService } from '../eventos/eventos-dominio.service';
import { FilaService, type Trabalho } from '../fila/fila.service';
import type { Prisma } from '../generated/prisma/client';
import { NotificacoesService } from '../notificacoes/notificacoes.service';
import { PrismaService, type Tx } from '../prisma/prisma.service';
import {
  ESPERA_PARA_FINALIZAR_SOZINHO_S,
  FILA_FINALIZAR_GRAVACAO,
} from './gravacao/gravacao.constantes';
import { salas } from '../tempo-real/catalogo';
import { TempoRealService } from '../tempo-real/tempo-real.service';
import { ConfiguracaoDeLigacoesService } from './configuracao-ligacoes.service';
import { ContextoDaLigacao } from './contexto-da-ligacao';
import type { AcaoDeChamada } from './formato-chamadas';
import { GraphLigacoes } from './graph-ligacoes';
import {
  formatarDuracao,
  INCLUIR_LIGACAO,
  type LigacaoCompleta,
  paraLigacaoDto,
} from './ligacao-dto';
import {
  ESPERA_DO_TERMINATE_S,
  ESTADOS_ATIVOS,
  FILA_CONEXAO_PERDIDA,
  FILA_FECHAR_ENCERRAMENTO,
  FILA_VIGIAR_LIGACAO,
  PRAZO_DE_RETORNO_HORAS,
  REGRA_LIGACOES,
  textoDoMotivo,
  TIPOS_NOTIFICACAO_LIGACAO,
  TOLERANCIA_DE_DESCONEXAO_S,
  VIGIA_DA_LIGACAO_FEITA_S,
} from './ligacoes.constantes';
import type {
  AnotarLigacaoDto,
  FiltroDeLigacoesDto,
  LigacaoDto,
  ListaDeLigacoesDto,
  LigacoesDoUsuarioDto,
} from './ligacoes.dto';
import {
  decidir,
  ehTerminal,
  type EventoDaLigacao,
} from './maquina-de-estados';
import { PermissoesDeLigacaoService } from './permissoes-de-ligacao.service';

/** O que um evento acrescenta à ligação além do estado (horários, duração, erro da Meta). */
export interface ExtraDaTransicao {
  quando?: Date;
  /** Duração informada pela Meta no `terminate` (segundos). */
  duracaoSegundos?: number | null;
  inicioNaMeta?: Date | null;
  fimNaMeta?: Date | null;
  erroCodigo?: number | null;
  erroMensagem?: string | null;
}

export interface ResultadoDaTransicao {
  aplicada: boolean;
  ligacao: LigacaoCompleta;
}

/**
 * Ligações do WhatsApp (R29): o núcleo. Toda mudança de estado passa por
 * `transicionar`, que serializa por ligação (trava consultiva), pergunta à
 * máquina de estados (`maquina-de-estados.ts`), grava e — ao chegar num estado
 * terminal — fecha a ligação (`finalizar`): atividade, evento na conversa,
 * avisos, permissão, mensagem de perdida e auditoria, tudo na mesma transação.
 * O tempo real e as chamadas à Meta (reject, terminate) saem depois do commit.
 */
@Injectable()
export class LigacoesService implements OnModuleInit {
  private readonly logger = new Logger('Ligacoes');

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditoria: AuditoriaService,
    private readonly eventos: EventosDominioService,
    private readonly notificacoes: NotificacoesService,
    private readonly tempoReal: TempoRealService,
    private readonly fila: FilaService,
    private readonly atendimento: AtendimentoService,
    private readonly motor: MotorDoAtendimento,
    private readonly distribuicao: DistribuicaoDaFila,
    private readonly config: ConfiguracaoDeLigacoesService,
    private readonly permissoes: PermissoesDeLigacaoService,
    private readonly graph: GraphLigacoes,
    @Inject(AMBIENTE) private readonly ambiente: Ambiente,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.fila.trabalhar<{ ligacaoId: string }>(
      FILA_FECHAR_ENCERRAMENTO,
      (trabalho) => this.fecharEncerramento(trabalho.dados.ligacaoId),
    );
    await this.fila.trabalhar<{ ligacaoId: string; usuarioId: string }>(
      FILA_CONEXAO_PERDIDA,
      (trabalho) => this.conexaoPerdida(trabalho.dados),
    );
    await this.fila.trabalhar<{ ligacaoId: string }>(
      FILA_VIGIAR_LIGACAO,
      (trabalho: Trabalho<{ ligacaoId: string }>) =>
        this.vigiar(trabalho.dados.ligacaoId),
    );
    this.tempoReal.aoDesconectar((usuarioId) =>
      this.aoUsuarioDesconectar(usuarioId),
    );
  }

  // -------------------------------------------------------------------------
  // Transação com emissões e chamadas à Meta depois do commit
  // -------------------------------------------------------------------------

  /** Roda `fn` numa transação; o tempo real e as ações pós-commit só saem se ela confirmar. */
  async executar<T>(
    fn: (tx: Tx, ctx: ContextoDaLigacao) => Promise<T>,
  ): Promise<T> {
    const ctx = new ContextoDaLigacao();
    const resultado = await this.prisma.$transaction((tx) => fn(tx, ctx), {
      timeout: 20_000,
    });
    await ctx.concluir(this.tempoReal);
    return resultado;
  }

  /** `POST /calls` (reject, terminate…) com o token do canal. */
  async agirNaMeta(
    canalId: string,
    acao: AcaoDeChamada,
    idMeta: string,
    sdp?: string,
  ): Promise<void> {
    const canal = await this.config.canalOficial(canalId);
    const { token, phoneNumberId } = await this.config.credenciais(canal);
    await this.graph.agir(token, phoneNumberId, acao, idMeta, sdp);
  }

  // -------------------------------------------------------------------------
  // Transições
  // -------------------------------------------------------------------------

  async carregar(tx: Tx | PrismaService, id: string): Promise<LigacaoCompleta> {
    const ligacao = await tx.ligacao.findUnique({
      where: { id },
      include: INCLUIR_LIGACAO,
    });
    if (!ligacao) {
      throw new NaoEncontradoException('Ligação não encontrada.');
    }
    return ligacao;
  }

  /**
   * Aplica um evento à ligação, se a máquina de estados deixar (R29.1). Quando
   * a ligação chega a um estado terminal, fecha-a (`finalizar`). Um `terminate`
   * atrasado, depois de a ligação já estar fechada, só completa a duração.
   */
  async transicionar(
    tx: Tx,
    ctx: ContextoDaLigacao,
    id: string,
    evento: EventoDaLigacao,
    extra: ExtraDaTransicao = {},
  ): Promise<ResultadoDaTransicao> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`ligacao:${id}`}, 0))`;
    const atual = await this.carregar(tx, id);
    const decisao = decidir(atual.estado, atual.direcao, evento);
    if (!decisao.aplicar) {
      if (
        decisao.razao === 'terminal' &&
        evento.tipo === 'encerrada_pela_meta'
      ) {
        await this.completarDuracao(tx, atual, extra);
      }
      return { aplicada: false, ligacao: atual };
    }
    const agora = extra.quando ?? new Date();
    const terminal = ehTerminal(decisao.estado);
    const dados: Prisma.LigacaoUncheckedUpdateInput = {
      estado: decisao.estado,
    };
    if (
      decisao.estado === 'TOCANDO' &&
      atual.direcao === 'FEITA' &&
      !atual.tocouEm
    ) {
      dados.tocouEm = agora;
    }
    if (decisao.estado === 'EM_ANDAMENTO') {
      dados.atendidaEm = extra.inicioNaMeta ?? agora;
      dados.ofertaSdp = null;
      dados.respostaSdp = null;
    }
    if (terminal) {
      const fim = extra.fimNaMeta ?? agora;
      dados.encerradaEm = fim;
      dados.motivo = decisao.motivo;
      dados.ofertaSdp = null;
      dados.respostaSdp = null;
      const inicio = atual.atendidaEm ?? extra.inicioNaMeta ?? null;
      dados.duracaoSegundos = inicio
        ? (extra.duracaoSegundos ??
          Math.max(0, Math.round((fim.getTime() - inicio.getTime()) / 1000)))
        : 0;
      if (extra.inicioNaMeta && !atual.atendidaEm) {
        dados.atendidaEm = extra.inicioNaMeta;
      }
    }
    if (extra.erroCodigo !== undefined) dados.erroCodigo = extra.erroCodigo;
    if (extra.erroMensagem !== undefined) {
      dados.erroMensagem = extra.erroMensagem;
    }
    await tx.ligacao.update({ where: { id }, data: dados });
    const ligacao = await this.carregar(tx, id);
    if (terminal) {
      await this.finalizar(tx, ctx, ligacao);
    } else if (ligacao.atendenteId) {
      ctx.emitir(salas.usuario(ligacao.atendenteId), 'ligacao.estado', {
        ligacaoId: ligacao.id,
        estado: ligacao.estado,
        motivo: ligacao.motivo,
        atendidaEm: ligacao.atendidaEm?.toISOString() ?? null,
      });
    }
    if (decisao.estado === 'EM_ANDAMENTO') {
      // Ligação conectada: zera a contagem de pedidos e de "sem resposta" (R29.4).
      await this.permissoes.contarDesfecho(
        tx,
        ligacao.canalId,
        ligacao.contatoId,
        'atendida',
      );
    }
    return { aplicada: true, ligacao };
  }

  /** `terminate` atrasado: a Meta sabe a duração real; o estado não muda. */
  private async completarDuracao(
    tx: Tx,
    ligacao: LigacaoCompleta,
    extra: ExtraDaTransicao,
  ): Promise<void> {
    if (
      extra.duracaoSegundos == null ||
      extra.duracaoSegundos === ligacao.duracaoSegundos
    ) {
      return;
    }
    await tx.ligacao.update({
      where: { id: ligacao.id },
      data: {
        duracaoSegundos: extra.duracaoSegundos,
        ...(extra.fimNaMeta ? { encerradaEm: extra.fimNaMeta } : {}),
        ...(extra.inicioNaMeta && !ligacao.atendidaEm
          ? { atendidaEm: extra.inicioNaMeta }
          : {}),
      },
    });
  }

  // -------------------------------------------------------------------------
  // Fechamento
  // -------------------------------------------------------------------------

  /**
   * Estado terminal: atividade `LIGACAO` do contato, evento na conversa, avisos,
   * permissão, mensagem de perdida, auditoria e tempo real (R29.7).
   */
  private async finalizar(
    tx: Tx,
    ctx: ContextoDaLigacao,
    original: LigacaoCompleta,
  ): Promise<void> {
    let ligacao = original;
    const atendida = ligacao.atendidaEm !== null;
    const duracao = ligacao.duracaoSegundos ?? 0;
    const textoMotivo = textoDoMotivo(ligacao.motivo);

    // Conversa: a recebida já tem; a feita atendida abre (ou usa) a conversa e a janela de 24 h.
    let conversaId = ligacao.conversaId;
    if (!conversaId && ligacao.direcao === 'FEITA') {
      conversaId = await this.conversaDaLigacaoFeita(tx, ligacao, atendida);
      if (conversaId) {
        await tx.ligacao.update({
          where: { id: ligacao.id },
          data: { conversaId },
        });
      }
    } else if (conversaId && ligacao.direcao === 'FEITA' && atendida) {
      await this.conversaDaLigacaoFeita(tx, ligacao, true);
    }

    ligacao = { ...ligacao, conversaId };
    const atividadeId = await this.registrarAtividade(tx, ligacao, {
      atendida,
      duracao,
    });
    if (atividadeId !== ligacao.atividadeId) {
      await tx.ligacao.update({
        where: { id: ligacao.id },
        data: { atividadeId },
      });
      ligacao = { ...ligacao, atividadeId };
    }

    await this.avisarNaConversa(tx, ligacao, conversaId, duracao);

    // Gravação (R30): se o navegador não finalizar, a API junta as partes que subiram.
    if (ligacao.gravar && atendida) {
      await this.fila.enviar(
        FILA_FINALIZAR_GRAVACAO,
        { ligacaoId: ligacao.id },
        { tx, atrasoSegundos: ESPERA_PARA_FINALIZAR_SOZINHO_S },
      );
    }

    // Permissão: ligação feita sem resposta conta para a revogação; atendida zera (já feito ao entrar em andamento).
    if (ligacao.direcao === 'FEITA') {
      const semResposta =
        !atendida &&
        (ligacao.estado === 'RECUSADA' || ligacao.estado === 'SEM_RESPOSTA') &&
        ligacao.motivo !== 'cancelada_pelo_atendente';
      await this.permissoes.contarDesfecho(
        tx,
        ligacao.canalId,
        ligacao.contatoId,
        semResposta ? 'sem_resposta' : 'ignorar',
      );
    }

    if (naoAtendidaRecebida(ligacao)) {
      await this.aoPerder(tx, ligacao, conversaId);
    }

    await this.auditoria.registrar(tx, {
      acao: `ligacao.${ligacao.estado.toLowerCase()}`,
      entidade: 'ligacao',
      entidadeId: ligacao.id,
      resumo: resumoDeAuditoria(ligacao, duracao),
      dados: {
        direcao: ligacao.direcao,
        estado: ligacao.estado,
        motivo: ligacao.motivo,
        duracaoSegundos: duracao,
        canalId: ligacao.canalId,
        idMeta: ligacao.idMeta,
        erroCodigo: ligacao.erroCodigo,
        regra: REGRA_LIGACOES,
      },
      relacionados: { contato: ligacao.contatoId },
    });

    // Tempo real: quem estava em ligação recebe `ligacao.encerrada`; quem ainda via tocar, `deixou_de_tocar`.
    const ringues = ligacao.tocouPara.filter(
      (id) => id !== ligacao.atendenteId,
    );
    if (ligacao.atendenteId) {
      ctx.emitir(salas.usuario(ligacao.atendenteId), 'ligacao.encerrada', {
        ligacaoId: ligacao.id,
        estado: ligacao.estado,
        duracaoSegundos: duracao,
        motivo: ligacao.motivo,
        motivoTexto: textoMotivo,
      });
    }
    if (ligacao.direcao === 'RECEBIDA' && ringues.length > 0) {
      for (const usuarioId of ringues) {
        ctx.emitir(salas.usuario(usuarioId), 'ligacao.deixou_de_tocar', {
          ligacaoId: ligacao.id,
          motivo: motivoDeDeixarDeTocar(ligacao.estado, ligacao.motivo),
        });
      }
    }
    await this.limparAvisosDeToque(tx, ctx, ligacao.id, ligacao.tocouPara);
  }

  /** Marca como lidas as notificações de "tocando" desta ligação e atualiza o sino de quem as tinha. */
  async limparAvisosDeToque(
    tx: Tx,
    ctx: ContextoDaLigacao,
    ligacaoId: string,
    usuarioIds: readonly string[],
  ): Promise<void> {
    if (usuarioIds.length === 0) {
      return;
    }
    const { count } = await tx.notificacao.updateMany({
      where: {
        tipo: TIPOS_NOTIFICACAO_LIGACAO.TOCANDO,
        lidaEm: null,
        usuarioId: { in: [...usuarioIds] },
        dados: { path: ['ligacaoId'], equals: ligacaoId },
      },
      data: { lidaEm: new Date() },
    });
    if (count === 0) {
      return;
    }
    for (const usuarioId of usuarioIds) {
      const naoLidas = await tx.notificacao.count({
        where: { usuarioId, lidaEm: null },
      });
      ctx.emitir(salas.usuario(usuarioId), 'nao-lidas', {
        notificacoes: naoLidas,
      });
    }
  }

  private async conversaDaLigacaoFeita(
    tx: Tx,
    ligacao: LigacaoCompleta,
    atendida: boolean,
  ): Promise<string | null> {
    if (atendida) {
      // O cliente atendeu: a ligação abre a janela de 24 h e, se preciso, a conversa (R28.4).
      const remetente = await this.remetenteDoContato(tx, ligacao);
      if (!remetente) {
        return null;
      }
      const { conversa } = await this.atendimento.conversaDaLigacao(
        tx,
        ligacao.canalId,
        remetente,
        ligacao.atendidaEm ?? new Date(),
      );
      return conversa.id;
    }
    const aberta = await tx.conversa.findFirst({
      where: {
        canalId: ligacao.canalId,
        contatoId: ligacao.contatoId,
        status: { not: 'RESOLVIDA' },
      },
      select: { id: true },
    });
    return aberta?.id ?? null;
  }

  private async remetenteDoContato(
    tx: Tx,
    ligacao: LigacaoCompleta,
  ): Promise<{
    tipo: 'WHATSAPP' | 'WHATSAPP_BSUID';
    valor: string;
    nome: string;
  } | null> {
    const telefone = ligacao.telefone ?? ligacao.contato.telefone;
    if (telefone) {
      return { tipo: 'WHATSAPP', valor: telefone, nome: ligacao.contato.nome };
    }
    const identificador = await tx.contatoIdentificador.findFirst({
      where: { contatoId: ligacao.contatoId, tipo: 'WHATSAPP_BSUID' },
    });
    return identificador
      ? {
          tipo: 'WHATSAPP_BSUID',
          valor: identificador.valor,
          nome: ligacao.contato.nome,
        }
      : null;
  }

  /** Evento do sistema na conversa do Atendimento (aparece como cartão da ligação). */
  private async avisarNaConversa(
    tx: Tx,
    ligacao: LigacaoCompleta,
    conversaId: string | null,
    duracao: number,
  ): Promise<void> {
    if (!conversaId) {
      return;
    }
    const conversa = await tx.conversa.findUnique({
      where: { id: conversaId },
      select: {
        id: true,
        canalId: true,
        responsavelId: true,
        fila: { select: { area: true } },
      },
    });
    if (!conversa) {
      return;
    }
    const quem = ligacao.atendente?.nome ?? 'a equipe';
    const motivo = textoDoMotivo(ligacao.motivo) ?? '';
    const texto =
      ligacao.estado === 'ENCERRADA'
        ? ligacao.direcao === 'RECEBIDA'
          ? `Ligação recebida atendida por ${quem} (${formatarDuracao(duracao)}).`
          : `Ligação feita por ${quem} (${formatarDuracao(duracao)}).`
        : ligacao.estado === 'PERDIDA'
          ? `Ligação perdida: ${motivo}`
          : ligacao.estado === 'RECUSADA'
            ? `O cliente recusou a ligação de ${quem}.`
            : ligacao.estado === 'SEM_RESPOSTA'
              ? ligacao.motivo === 'cancelada_pelo_atendente'
                ? `Ligação de ${quem} cancelada antes de o cliente atender.`
                : `Ligação de ${quem} sem resposta do cliente.`
              : `Ligação com falha: ${motivo}`;
    await this.motor.avisoDeSistema(tx, conversa, texto, {
      ligacao: {
        id: ligacao.id,
        direcao: ligacao.direcao,
        estado: ligacao.estado,
        motivo: ligacao.motivo,
        duracaoSegundos: duracao,
        atendente: ligacao.atendente,
      },
    });
  }

  /** Descrição da atividade: direção, duração, resultado, quem e a anotação. */
  descricaoDaAtividade(
    ligacao: Pick<
      LigacaoCompleta,
      | 'direcao'
      | 'estado'
      | 'motivo'
      | 'duracaoSegundos'
      | 'anotacao'
      | 'atendente'
      | 'iniciadaEm'
    >,
  ): string {
    const linhas = [
      `Direção: ${ligacao.direcao === 'RECEBIDA' ? 'recebida' : 'feita'} pelo WhatsApp.`,
      `Resultado: ${RESULTADO_POR_ESTADO[ligacao.estado]}${
        ligacao.motivo && ligacao.estado !== 'ENCERRADA'
          ? ` (${textoDoMotivo(ligacao.motivo)})`
          : ''
      }`,
      ligacao.estado === 'ENCERRADA'
        ? `Duração: ${formatarDuracao(ligacao.duracaoSegundos ?? 0)}.`
        : null,
      ligacao.atendente ? `Atendente: ${ligacao.atendente.nome}.` : null,
      ligacao.anotacao ? `\nAnotação: ${ligacao.anotacao}` : null,
    ];
    return linhas.filter(Boolean).join('\n');
  }

  /**
   * Cria ou conclui a atividade `LIGACAO` do contato (R29.7):
   * - perdida: "Retornar ligação" pendente para o responsável (ou a fila);
   * - feita a partir de uma atividade: ela é concluída se a ligação foi atendida
   *   (senão fica pendente com o registro da tentativa na descrição);
   * - demais: atividade concluída com o resultado.
   * Uma ligação atendida também conclui os "Retornar ligação" pendentes do contato.
   */
  private async registrarAtividade(
    tx: Tx,
    ligacao: LigacaoCompleta,
    resultado: { atendida: boolean; duracao: number },
  ): Promise<string | null> {
    const contato = ligacao.contato;
    const agora = new Date();
    const descricao = this.descricaoDaAtividade(ligacao);
    const empresaId = (
      await tx.contato.findUnique({
        where: { id: contato.id },
        select: { empresaId: true },
      })
    )?.empresaId;

    if (naoAtendidaRecebida(ligacao)) {
      const { responsavelId } = await this.responsavelDoRetorno(tx, ligacao);
      const titulo = `Retornar ligação: ${contato.nome}`;
      const criada = await tx.atividade.create({
        data: {
          tipo: 'LIGACAO',
          titulo,
          descricao,
          prioridade: 'ALTA',
          venceEm: new Date(
            agora.getTime() + PRAZO_DE_RETORNO_HORAS * 3_600_000,
          ),
          responsavelId,
          criadoPorId: null,
          contatoId: contato.id,
          empresaId: empresaId ?? null,
        },
      });
      await this.registrarCriacaoDeAtividade(tx, criada, ligacao);
      return criada.id;
    }

    if (ligacao.atividadeId) {
      const existente = await tx.atividade.findUnique({
        where: { id: ligacao.atividadeId },
      });
      if (existente && existente.status === 'PENDENTE') {
        const concluir = resultado.atendida && ligacao.atendenteId;
        const atualizada = await tx.atividade.update({
          where: { id: existente.id },
          data: {
            descricao: [existente.descricao, descricao]
              .filter(Boolean)
              .join('\n\n— Ligação —\n'),
            ...(concluir
              ? {
                  status: 'CONCLUIDA',
                  concluidaEm: agora,
                  concluidaPorId: ligacao.atendenteId,
                }
              : {}),
          },
        });
        if (concluir) {
          await this.registrarConclusaoDeAtividade(tx, atualizada, ligacao);
        }
      }
      return ligacao.atividadeId;
    }

    if (!ligacao.atendenteId) {
      // Sem atendente (recebida que falhou antes de atender): nada a registrar.
      return null;
    }
    const titulo =
      ligacao.direcao === 'RECEBIDA'
        ? `Ligação recebida de ${contato.nome}`
        : `Ligação feita para ${contato.nome}`;
    const criada = await tx.atividade.create({
      data: {
        tipo: 'LIGACAO',
        titulo,
        descricao,
        status: 'CONCLUIDA',
        concluidaEm: agora,
        concluidaPorId: ligacao.atendenteId,
        responsavelId: ligacao.atendenteId,
        criadoPorId: ligacao.atendenteId,
        contatoId: contato.id,
        empresaId: empresaId ?? null,
      },
    });
    await this.registrarCriacaoDeAtividade(tx, criada, ligacao, true);
    if (resultado.atendida) {
      await this.concluirRetornosPendentes(tx, ligacao, criada.id);
    }
    return criada.id;
  }

  private async registrarCriacaoDeAtividade(
    tx: Tx,
    atividade: Prisma.AtividadeGetPayload<object>,
    ligacao: LigacaoCompleta,
    concluida = false,
  ): Promise<void> {
    await this.auditoria.registrar(tx, {
      acao: 'atividade.criada',
      entidade: 'atividade',
      entidadeId: atividade.id,
      resumo: `Ligação do WhatsApp criou a atividade "${atividade.titulo}"`,
      dados: { ...dadosDoEvento(atividade), ligacaoId: ligacao.id },
      relacionados: {
        contato: atividade.contatoId,
        empresa: atividade.empresaId,
      },
    });
    await this.eventos.publicar(
      tx,
      'atividade.criada',
      dadosDoEvento(atividade),
    );
    if (concluida) {
      await this.eventos.publicar(
        tx,
        'atividade.concluida',
        dadosDoEvento(atividade),
      );
    }
  }

  private async registrarConclusaoDeAtividade(
    tx: Tx,
    atividade: Prisma.AtividadeGetPayload<object>,
    ligacao: LigacaoCompleta,
  ): Promise<void> {
    await this.auditoria.registrar(tx, {
      acao: 'atividade.concluida',
      entidade: 'atividade',
      entidadeId: atividade.id,
      resumo: `Atividade "${atividade.titulo}" concluída pela ligação do WhatsApp`,
      dados: { ...dadosDoEvento(atividade), ligacaoId: ligacao.id },
      relacionados: {
        contato: atividade.contatoId,
        empresa: atividade.empresaId,
      },
    });
    await this.eventos.publicar(
      tx,
      'atividade.concluida',
      dadosDoEvento(atividade),
    );
  }

  /** Uma ligação atendida com o contato conclui os "Retornar ligação" que ainda estavam pendentes. */
  private async concluirRetornosPendentes(
    tx: Tx,
    ligacao: LigacaoCompleta,
    exceto: string,
  ): Promise<void> {
    const pendentes = await tx.atividade.findMany({
      where: {
        id: { not: exceto },
        status: 'PENDENTE',
        tipo: 'LIGACAO',
        contatoId: ligacao.contatoId,
        ligacoes: { some: { estado: 'PERDIDA' } },
      },
    });
    for (const pendente of pendentes) {
      const concluida = await tx.atividade.update({
        where: { id: pendente.id },
        data: {
          status: 'CONCLUIDA',
          concluidaEm: new Date(),
          concluidaPorId: ligacao.atendenteId,
        },
      });
      await this.registrarConclusaoDeAtividade(tx, concluida, ligacao);
    }
  }

  /** Quem fica com o "Retornar ligação": responsável da conversa ou do contato; senão líder da fila; senão Admin. */
  private async responsavelDoRetorno(
    tx: Tx,
    ligacao: LigacaoCompleta,
  ): Promise<{ responsavelId: string; avisar: string[] }> {
    const conversa = ligacao.conversaId
      ? await tx.conversa.findUnique({
          where: { id: ligacao.conversaId },
          select: {
            responsavelId: true,
            filaId: true,
            fila: { select: { area: true } },
          },
        })
      : null;
    const contato = await tx.contato.findUnique({
      where: { id: ligacao.contatoId },
      select: { responsavelId: true },
    });
    for (const candidato of [conversa?.responsavelId, contato?.responsavelId]) {
      if (!candidato) continue;
      const usuario = await tx.usuario.findFirst({
        where: { id: candidato, ativo: true },
        select: { id: true, papel: true },
      });
      if (usuario && podeUsarAtendimento(usuario.papel)) {
        return { responsavelId: usuario.id, avisar: [usuario.id] };
      }
    }
    const lideres = await lideresParaAvisar(
      tx,
      null,
      conversa?.fila?.area ?? null,
    );
    const config = await this.config.ler(ligacao.canalId);
    const filaId = conversa?.filaId ?? config.filaId ?? null;
    let participantes: string[] = [];
    if (filaId) {
      const fila = await tx.filaAtendimento.findFirst({
        where: { id: filaId, excluidoEm: null },
      });
      if (fila) {
        const situacao = await this.distribuicao.situacao(tx, fila);
        participantes = situacao.participantes.elegiveis
          .map((usuario) => usuario.id)
          .slice(0, 20);
      }
    }
    const admin = await tx.usuario.findFirst({
      where: { papel: 'ADMIN', ativo: true },
      orderBy: { criadoEm: 'asc' },
      select: { id: true },
    });
    const responsavelId = lideres[0] ?? admin?.id;
    if (!responsavelId) {
      throw new Error('Nenhum usuário disponível para retornar a ligação.');
    }
    return {
      responsavelId,
      avisar: [...new Set([...participantes, ...lideres])],
    };
  }

  /** Ligação perdida: avisa o responsável (ou a fila) e manda a mensagem automática, se ligada. */
  private async aoPerder(
    tx: Tx,
    ligacao: LigacaoCompleta,
    conversaId: string | null,
  ): Promise<void> {
    const { avisar } = await this.responsavelDoRetorno(tx, ligacao);
    if (avisar.length > 0) {
      await this.notificacoes.notificarVarios(tx, avisar, {
        tipo: TIPOS_NOTIFICACAO_LIGACAO.PERDIDA,
        titulo: `Ligação perdida de ${ligacao.contato.nome}`,
        texto: `${textoDoMotivo(ligacao.motivo) ?? 'Ninguém atendeu.'} Há uma atividade "Retornar ligação".`,
        link: ligacao.atividadeId
          ? `/atividades?atividade=${ligacao.atividadeId}`
          : '/atividades',
        dados: { ligacaoId: ligacao.id, contatoId: ligacao.contatoId },
      });
    }
    const config = await this.config.ler(ligacao.canalId);
    if (
      ligacao.estado === 'PERDIDA' &&
      config.mensagemPerdidaAtiva &&
      config.mensagemPerdida?.trim() &&
      conversaId &&
      ligacao.motivo !== 'ligacoes_desativadas'
    ) {
      const conversa = await tx.conversa.findUnique({
        where: { id: conversaId },
      });
      const canal = await tx.canal.findUnique({
        where: { id: ligacao.canalId },
        select: { id: true, tipo: true },
      });
      if (
        conversa &&
        canal &&
        conversa.janelaAte &&
        conversa.janelaAte > new Date()
      ) {
        await this.motor.criarSaida(tx, conversa, canal, {
          texto: config.mensagemPerdida.trim(),
          autorId: null,
          metadados: { ligacaoPerdida: ligacao.id },
        });
      } else {
        this.logger.warn(
          `Mensagem de ligação perdida não enviada (${ligacao.id}): janela de 24 h fechada ou conversa ausente.`,
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // Consulta
  // -------------------------------------------------------------------------

  /** Quem pode ver a ligação: o atendente, quem foi chamado e quem vê a conversa (R12). */
  private async exigirAcesso(
    usuario: UsuarioAutenticado,
    ligacao: LigacaoCompleta,
  ): Promise<void> {
    exigirAtendimento(usuario);
    if (
      ehDiretoria(usuario.papel) ||
      ligacao.atendenteId === usuario.id ||
      ligacao.tocouPara.includes(usuario.id)
    ) {
      return;
    }
    const filtro = filtroDeConversasVisiveis(usuario);
    const visivel =
      filtro && ligacao.conversaId
        ? await this.prisma.conversa.findFirst({
            where: { id: ligacao.conversaId, ...filtro },
            select: { id: true },
          })
        : null;
    if (!visivel) {
      throw new NaoEncontradoException('Ligação não encontrada.');
    }
  }

  async obter(usuario: UsuarioAutenticado, id: string): Promise<LigacaoDto> {
    exigirAtendimento(usuario);
    const ligacao = await this.carregar(this.prisma, id);
    await this.exigirAcesso(usuario, ligacao);
    return paraLigacaoDto(ligacao, usuario.id, usuario.papel);
  }

  async listar(
    usuario: UsuarioAutenticado,
    filtro: FiltroDeLigacoesDto,
  ): Promise<ListaDeLigacoesDto> {
    exigirAtendimento(usuario);
    const visiveis = filtroDeConversasVisiveis(usuario);
    const limite = filtro.limite ?? 20;
    const onde: Prisma.LigacaoWhereInput[] = [];
    if (visiveis && Object.keys(visiveis).length > 0) {
      onde.push({
        OR: [{ atendenteId: usuario.id }, { conversa: visiveis }],
      });
    }
    if (filtro.contatoId) onde.push({ contatoId: filtro.contatoId });
    if (filtro.conversaId) onde.push({ conversaId: filtro.conversaId });
    if (filtro.direcao) onde.push({ direcao: filtro.direcao });
    const cursor = filtro.cursor ? decodificarCursor(filtro.cursor) : null;
    const itens = await this.prisma.ligacao.findMany({
      where: { AND: onde },
      include: INCLUIR_LIGACAO,
      orderBy: [{ iniciadaEm: 'desc' }, { id: 'desc' }],
      take: limite + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const haMais = itens.length > limite;
    const pagina = haMais ? itens.slice(0, limite) : itens;
    return {
      itens: pagina.map((item) =>
        paraLigacaoDto(item, usuario.id, usuario.papel),
      ),
      proximoCursor:
        haMais && pagina.length > 0
          ? codificarCursor((pagina[pagina.length - 1] as { id: string }).id)
          : null,
    };
  }

  /** A ligação em curso do usuário e as que ainda tocam para ele (retomar depois de recarregar a página). */
  async doUsuario(usuario: UsuarioAutenticado): Promise<LigacoesDoUsuarioDto> {
    exigirAtendimento(usuario);
    const emAndamento = await this.prisma.ligacao.findFirst({
      where: { atendenteId: usuario.id, estado: { in: [...ESTADOS_ATIVOS] } },
      include: INCLUIR_LIGACAO,
    });
    const tocando = await this.prisma.ligacao.findMany({
      where: {
        direcao: 'RECEBIDA',
        estado: 'TOCANDO',
        atendenteId: null,
        tocouPara: { has: usuario.id },
        expiraEm: { gt: new Date() },
      },
      include: INCLUIR_LIGACAO,
      orderBy: { iniciadaEm: 'asc' },
    });
    return {
      emAndamento: emAndamento ? paraLigacaoDto(emAndamento, usuario.id) : null,
      tocando: tocando.map((item) => paraLigacaoDto(item, usuario.id)),
    };
  }

  /** Anotação rápida (durante ou depois da ligação); vai para a descrição da atividade. */
  async anotar(
    usuario: UsuarioAutenticado,
    id: string,
    dto: AnotarLigacaoDto,
  ): Promise<LigacaoDto> {
    exigirAtendimento(usuario);
    await this.executar(async (tx) => {
      const ligacao = await this.carregar(tx, id);
      await this.exigirAcesso(usuario, ligacao);
      if (ligacao.atendenteId !== usuario.id && !ehDiretoria(usuario.papel)) {
        throw new SemPermissaoException(
          'Só quem atendeu ou ligou pode anotar a ligação.',
          { regra: REGRA_LIGACOES },
        );
      }
      const anotacao = dto.anotacao ?? null;
      await tx.ligacao.update({ where: { id }, data: { anotacao } });
      await this.auditoria.registrar(tx, {
        acao: 'ligacao.anotada',
        entidade: 'ligacao',
        entidadeId: id,
        resumo: `${usuario.nome} anotou a ligação com "${ligacao.contato.nome}"`,
        // O texto da anotação não vai para a auditoria (pode ter dado pessoal).
        dados: { apagada: anotacao === null, regra: REGRA_LIGACOES },
        relacionados: { contato: ligacao.contatoId, usuario: usuario.id },
      });
      if (ligacao.atividadeId && ehTerminal(ligacao.estado)) {
        const atualizada = await this.carregar(tx, id);
        await tx.atividade.updateMany({
          where: { id: ligacao.atividadeId, status: 'CONCLUIDA' },
          data: { descricao: this.descricaoDaAtividade(atualizada) },
        });
      }
    });
    return this.obter(usuario, id);
  }

  // -------------------------------------------------------------------------
  // Encerrar, desconexão e vigias
  // -------------------------------------------------------------------------

  /**
   * O atendente encerra (ou cancela) a ligação: sempre manda `terminate` à Meta
   * (afeta a cobrança). Em andamento, o webhook `terminate` fecha com duração e
   * motivo (um job fecha sozinho se ele não vier); chamando ou tocando (feita),
   * fecha na hora como "cancelada".
   */
  async encerrar(usuario: UsuarioAutenticado, id: string): Promise<LigacaoDto> {
    exigirAtendimento(usuario);
    const ligacao = await this.carregar(this.prisma, id);
    if (ligacao.atendenteId !== usuario.id && !ehDiretoria(usuario.papel)) {
      await this.exigirAcesso(usuario, ligacao);
      throw new SemPermissaoException(
        'Só quem atendeu ou ligou pode encerrar a ligação.',
        { regra: REGRA_LIGACOES },
      );
    }
    if (ehTerminal(ligacao.estado)) {
      return paraLigacaoDto(ligacao, usuario.id);
    }
    if (ligacao.direcao === 'RECEBIDA' && ligacao.estado === 'TOCANDO') {
      throw new ConflitoException(
        'A ligação ainda não foi atendida: ela termina sozinha se ninguém atender.',
        { motivo: 'ligacao_nao_atendida' },
      );
    }
    await this.prisma.$transaction((tx) =>
      this.auditoria.registrar(tx, {
        acao: 'ligacao.encerramento_pedido',
        entidade: 'ligacao',
        entidadeId: ligacao.id,
        resumo: `${usuario.nome} encerrou a ligação com "${ligacao.contato.nome}"`,
        dados: { estado: ligacao.estado, regra: REGRA_LIGACOES },
        relacionados: { contato: ligacao.contatoId, usuario: usuario.id },
      }),
    );
    await this.encerrarNaMeta(ligacao);
    return this.obter(usuario, id);
  }

  /** `terminate` na Meta + agenda ou faz o fechamento local. */
  private async encerrarNaMeta(ligacao: LigacaoCompleta): Promise<void> {
    await this.prisma.ligacao.updateMany({
      where: { id: ligacao.id, encerramentoSolicitadoEm: null },
      data: { encerramentoSolicitadoEm: new Date() },
    });
    if (ligacao.idMeta) {
      try {
        await this.agirNaMeta(ligacao.canalId, 'terminate', ligacao.idMeta);
      } catch (erro) {
        // Ligação que a Meta já encerrou, ou Meta fora do ar: o fechamento local garante o desfecho.
        this.logger.warn(
          `terminate da ligação ${ligacao.id} falhou: ${erro instanceof Error ? erro.message : String(erro)}`,
        );
      }
    }
    if (ligacao.estado === 'EM_ANDAMENTO') {
      await this.fila.enviar(
        FILA_FECHAR_ENCERRAMENTO,
        { ligacaoId: ligacao.id },
        { atrasoSegundos: ESPERA_DO_TERMINATE_S },
      );
      return;
    }
    await this.executar((tx, ctx) =>
      this.transicionar(tx, ctx, ligacao.id, {
        tipo: 'cancelada_pelo_atendente',
      }),
    );
  }

  /** Job: o atendente encerrou e o webhook `terminate` não veio: fecha com o que o CRM sabe. */
  async fecharEncerramento(ligacaoId: string): Promise<void> {
    await this.executar((tx, ctx) =>
      this.transicionar(tx, ctx, ligacaoId, {
        tipo: 'encerramento_forcado',
        motivo: 'encerrada_pelo_atendente',
      }),
    );
  }

  /** Um socket do usuário caiu: se ele tem ligação em curso, agenda a conferência depois da tolerância. */
  async aoUsuarioDesconectar(usuarioId: string): Promise<void> {
    const ligacao = await this.prisma.ligacao.findFirst({
      where: { atendenteId: usuarioId, estado: { in: [...ESTADOS_ATIVOS] } },
      select: { id: true },
    });
    if (!ligacao) {
      return;
    }
    await this.prisma.ligacao.update({
      where: { id: ligacao.id },
      data: { desconectadoEm: new Date() },
    });
    await this.fila.enviar(
      FILA_CONEXAO_PERDIDA,
      { ligacaoId: ligacao.id, usuarioId },
      { atrasoSegundos: TOLERANCIA_DE_DESCONEXAO_S },
    );
  }

  /** Job: passada a tolerância, se o atendente não voltou (nenhum socket), encerra a ligação. */
  async conexaoPerdida(dados: {
    ligacaoId: string;
    usuarioId: string;
  }): Promise<void> {
    const ligacao = await this.carregar(this.prisma, dados.ligacaoId);
    if (ehTerminal(ligacao.estado) || ligacao.atendenteId !== dados.usuarioId) {
      return;
    }
    if (await this.tempoReal.estaConectado(dados.usuarioId)) {
      await this.prisma.ligacao.update({
        where: { id: ligacao.id },
        data: { desconectadoEm: null },
      });
      return;
    }
    if (ligacao.idMeta) {
      try {
        await this.agirNaMeta(ligacao.canalId, 'terminate', ligacao.idMeta);
      } catch (erro) {
        this.logger.warn(
          `terminate da ligação ${ligacao.id} (conexão perdida) falhou: ${erro instanceof Error ? erro.message : String(erro)}`,
        );
      }
    }
    await this.executar((tx, ctx) =>
      this.transicionar(
        tx,
        ctx,
        ligacao.id,
        ligacao.estado === 'EM_ANDAMENTO'
          ? { tipo: 'encerramento_forcado', motivo: 'conexao_perdida' }
          : { tipo: 'falhou', motivo: 'conexao_perdida' },
      ),
    );
  }

  /** Agenda a vigia de uma ligação feita (a Meta costuma mandar o `terminate` antes). */
  async agendarVigia(ligacaoId: string): Promise<void> {
    await this.fila.enviar(
      FILA_VIGIAR_LIGACAO,
      { ligacaoId },
      { atrasoSegundos: VIGIA_DA_LIGACAO_FEITA_S },
    );
  }

  async vigiar(ligacaoId: string): Promise<void> {
    const ligacao = await this.carregar(this.prisma, ligacaoId);
    if (ligacao.estado !== 'CHAMANDO' && ligacao.estado !== 'TOCANDO') {
      return;
    }
    if (ligacao.idMeta) {
      try {
        await this.agirNaMeta(ligacao.canalId, 'terminate', ligacao.idMeta);
      } catch (erro) {
        this.logger.warn(
          `terminate da ligação ${ligacao.id} (vigia) falhou: ${erro instanceof Error ? erro.message : String(erro)}`,
        );
      }
    }
    await this.executar((tx, ctx) =>
      this.transicionar(tx, ctx, ligacaoId, { tipo: 'vigia_esgotada' }),
    );
  }

  /** Erro de unicidade da "uma ligação por atendente" → 409 em português; outros erros seguem. */
  traduzirUnicidade(erro: unknown): unknown {
    const traduzido = traduzirErroDoPrisma(erro);
    const restricao = (
      traduzido?.getResponse() as
        { detalhes?: { restricao?: string } } | undefined
    )?.detalhes?.restricao;
    if (restricao === 'ligacoes_uma_ativa_por_atendente_key') {
      return new ConflitoException(
        'Você já está em uma ligação: encerre-a antes de atender ou ligar de novo.',
        { motivo: 'ja_em_ligacao' },
      );
    }
    return erro;
  }

  get stunUrls(): readonly string[] {
    return this.ambiente.ligacoes.stunUrls;
  }

  get esperaPreAceiteMs(): number {
    return this.ambiente.ligacoes.esperaPreAceiteMs;
  }
}

/** Recebida que o cliente não chegou a falar com ninguém (perdida ou com falha antes de atender): precisa de retorno. */
function naoAtendidaRecebida(ligacao: LigacaoCompleta): boolean {
  return (
    ligacao.direcao === 'RECEBIDA' &&
    ligacao.atendidaEm === null &&
    (ligacao.estado === 'PERDIDA' || ligacao.estado === 'FALHOU')
  );
}

const RESULTADO_POR_ESTADO = {
  CHAMANDO: 'chamando',
  TOCANDO: 'tocando',
  EM_ANDAMENTO: 'em andamento',
  ENCERRADA: 'atendida',
  PERDIDA: 'perdida',
  RECUSADA: 'recusada pelo cliente',
  SEM_RESPOSTA: 'sem resposta',
  FALHOU: 'falhou',
} as const;

function motivoDeDeixarDeTocar(
  estado: string,
  motivo: string | null,
): 'tempo_esgotado' | 'cliente_desligou' | 'falha' | 'encerrada' {
  if (estado === 'PERDIDA') {
    return motivo === 'cliente_desligou'
      ? 'cliente_desligou'
      : 'tempo_esgotado';
  }
  return estado === 'FALHOU' ? 'falha' : 'encerrada';
}

function resumoDeAuditoria(ligacao: LigacaoCompleta, duracao: number): string {
  const quem = ligacao.atendente ? ` por ${ligacao.atendente.nome}` : '';
  const direcao = ligacao.direcao === 'RECEBIDA' ? 'recebida' : 'feita';
  switch (ligacao.estado) {
    case 'ENCERRADA':
      return `Ligação ${direcao}${quem} com "${ligacao.contato.nome}" encerrada (${formatarDuracao(duracao)})`;
    case 'PERDIDA':
      return `Ligação recebida de "${ligacao.contato.nome}" perdida (${ligacao.motivo ?? 'sem atendimento'})`;
    case 'RECUSADA':
      return `Ligação${quem} para "${ligacao.contato.nome}" recusada pelo cliente`;
    case 'SEM_RESPOSTA':
      return `Ligação${quem} para "${ligacao.contato.nome}" sem resposta`;
    default:
      return `Ligação ${direcao} com "${ligacao.contato.nome}" falhou (${ligacao.motivo ?? 'erro'})`;
  }
}

function codificarCursor(id: string): string {
  return Buffer.from(id, 'utf8').toString('base64url');
}

function decodificarCursor(cursor: string): string | null {
  try {
    const id = Buffer.from(cursor, 'base64url').toString('utf8');
    return /^[0-9a-f-]{36}$/i.test(id) ? id : null;
  } catch {
    return null;
  }
}
