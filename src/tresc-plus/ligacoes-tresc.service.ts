import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Readable } from 'node:stream';
import type { ReadableStream as WebStream } from 'node:stream/web';
import { dadosDoEvento } from '../atividades/atividades.service';
import { ArquivosService } from '../arquivos/arquivos.service';
import { AuditoriaService } from '../auditoria/auditoria.service';
import { ErroApi } from '../comum/erros/excecoes';
import { AMBIENTE, type Ambiente } from '../config/ambiente';
import { EventosDominioService } from '../eventos/eventos-dominio.service';
import { FilaService } from '../fila/fila.service';
import type { QuemAcessa } from '../funis/acesso-funis';
import { negociosQueVe, veNegocio } from '../funis/negocios-visiveis';
import { registrarPrimeiraInteracao } from '../funis/primeira-interacao';
import type { Area } from '../comum/dominio/setores';
import type {
  Ligacao,
  Prisma,
  TrescPlusVinculo,
} from '../generated/prisma/client';
import { ContextoDaLigacao } from '../ligacoes/contexto-da-ligacao';
import {
  dadosDoEventoDeLigacao,
  EVENTOS_DE_LIGACAO,
} from '../ligacoes/eventos-de-ligacao.service';
import {
  formatarDuracao,
  INCLUIR_LIGACAO,
  type LigacaoCompleta,
} from '../ligacoes/ligacao-dto';
import {
  RESULTADO_POR_ESTADO,
  textoDoMotivo,
} from '../ligacoes/ligacoes.constantes';
import { PrismaService, type Tx } from '../prisma/prisma.service';
import { salas } from '../tempo-real/catalogo';
import { TempoRealService } from '../tempo-real/tempo-real.service';
import { ClienteWhisper } from '../transcricao/cliente-whisper';
import { TranscricaoService } from '../transcricao/transcricao.service';
import { ConexaoTrescPlusService } from './conexao.service';
import { ErroTrescPlus } from './erros-tresc-plus';
import {
  agenteDoEvento,
  type AgenteDoEvento,
  chaveDoEvento,
  decidirChamada,
  ehEstadoFinal,
  ehReceptiva,
  type EventoNormalizado,
  estadoDoAgente,
  estadoInicial,
  type HistoricoDaChamada,
  lerChamada,
  lerHistorico,
  mensagemDeFalhaDoAgente,
} from './eventos';
import {
  DIAS_DE_DEDUPE,
  EVENTO_HISTORICO,
  EVENTOS_DE_AGENTE,
  EVENTOS_DE_CHAMADA,
  FILA_BAIXAR_GRAVACAO,
  FILA_LIMPAR_EVENTOS,
  AGENDA_DA_LIMPEZA,
  GRAVACAO_MAX_BYTES_PADRAO,
  REGRA_TRESC_PLUS,
} from './tresc-plus.constantes';
import { descricaoDaAtividade } from './descricao-da-ligacao';
import { identifierDoDiscador, variantesDoTelefone } from './telefone';

export { descricaoDaAtividade };

/** Em quanto tempo uma ligação sem fim é fechada pela reconciliação. */
const PRAZO_DE_LIGACAO_PRESA_MS = 3 * 3_600_000;

const TENTATIVAS_DA_GRAVACAO = 4;

export interface ContatoEncontrado {
  contatoId: string;
  nome: string;
  empresa: string | null;
  negocioId: string | null;
  /** Todos os negócios abertos do contato (para o aviso do receptivo). */
  negocios: Array<{ id: string; titulo: string }>;
}

const sufixoDaMime = (mime: string): string =>
  mime.includes('wav') || mime.includes('wave')
    ? 'wav'
    : mime.includes('ogg')
      ? 'ogg'
      : mime.includes('mp4') || mime.includes('m4a')
        ? 'm4a'
        : mime.includes('webm')
          ? 'webm'
          : 'mp3';

/**
 * Ligações do 3C+ (R34.3, R34.4, R34.7): aplica os eventos do socket (e a reconciliação) à mesma
 * tabela de ligações do WhatsApp. Cada evento é aplicado numa transação, deduplicado por
 * chamada + tipo; o tempo real só sai depois do commit.
 */
@Injectable()
export class LigacoesTrescService implements OnModuleInit {
  private readonly logger = new Logger('TrescPlus');
  /** Chamadas sem contato já avisadas ao vendedor (receptivo de número desconhecido). */
  private readonly avisadasSemContato = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditoria: AuditoriaService,
    private readonly eventos: EventosDominioService,
    private readonly tempoReal: TempoRealService,
    private readonly fila: FilaService,
    private readonly arquivos: ArquivosService,
    private readonly transcricao: TranscricaoService,
    private readonly whisper: ClienteWhisper,
    private readonly conexao: ConexaoTrescPlusService,
    @Inject(AMBIENTE) private readonly ambiente: Ambiente,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.fila.trabalhar<{ ligacaoId: string }>(
      FILA_BAIXAR_GRAVACAO,
      (trabalho) =>
        this.baixarGravacao(
          trabalho.dados.ligacaoId,
          trabalho.tentativa > TENTATIVAS_DA_GRAVACAO,
        ),
      {
        tentativas: TENTATIVAS_DA_GRAVACAO,
        intervaloEntreTentativasSegundos: 20,
        esperaExponencial: true,
      },
    );
    await this.fila.trabalhar(FILA_LIMPAR_EVENTOS, async () => {
      await this.limparEventosAntigos();
    });
    await this.fila.agendar(FILA_LIMPAR_EVENTOS, AGENDA_DA_LIMPEZA);
  }

  // -------------------------------------------------------------------------
  // Entrada: eventos do socket
  // -------------------------------------------------------------------------

  async processarEvento(evento: EventoNormalizado): Promise<void> {
    const { tipo, dados } = evento;
    if (tipo === EVENTO_HISTORICO) {
      await this.processarHistorico(dados);
    } else if (EVENTOS_DE_AGENTE.some((t) => t === tipo)) {
      await this.processarEventoDeAgente(tipo, dados);
    } else if (EVENTOS_DE_CHAMADA.some((t) => t === tipo)) {
      await this.processarEventoDeChamada(tipo, dados);
    }
  }

  /**
   * O vínculo do vendedor pelo id do agente no 3C+ (R34.3). Nunca pelo nome: dois agentes podem ter o
   * mesmo nome e a ligação seria atribuída à pessoa errada; sem id, a ligação fica sem atendente.
   */
  async vinculoDoAgente(
    agente: AgenteDoEvento,
    tx: Tx | PrismaService = this.prisma,
  ): Promise<TrescPlusVinculo | null> {
    if (agente.id === null) return null;
    return tx.trescPlusVinculo.findUnique({
      where: { trescUsuarioId: agente.id },
    });
  }

  /** A pessoa (papel e setor) de um usuário, para as regras de visibilidade (R5.9). */
  private async pessoaDe(
    tx: Tx | PrismaService,
    usuarioId: string,
  ): Promise<QuemAcessa | null> {
    const usuario = await tx.usuario.findUnique({
      where: { id: usuarioId },
      select: { id: true, papel: true, area: true },
    });
    return usuario
      ? {
          id: usuario.id,
          papel: usuario.papel,
          area: usuario.area as Area | null,
        }
      : null;
  }

  /** R5.9: o atendente da ligação vê o funil do negócio ligado? (Sem atendente ou sem negócio: sim.) */
  private async atendenteVeONegocio(
    tx: Tx | PrismaService,
    ligacao: Pick<Ligacao, 'atendenteId' | 'negocioId'>,
  ): Promise<boolean> {
    if (!ligacao.negocioId || !ligacao.atendenteId) return true;
    const pessoa = await this.pessoaDe(tx, ligacao.atendenteId);
    return pessoa ? veNegocio(tx, pessoa, ligacao.negocioId) : false;
  }

  private async registrarChave(tx: Tx, chave: string | null): Promise<boolean> {
    if (chave === null) return true;
    const { count } = await tx.trescPlusEvento.createMany({
      data: [{ chave }],
      skipDuplicates: true,
    });
    return count === 1;
  }

  // -------------------------------------------------------------------------
  // Agente
  // -------------------------------------------------------------------------

  private async processarEventoDeAgente(
    tipo: string,
    dados: Record<string, unknown>,
  ): Promise<void> {
    const vinculo = await this.vinculoDoAgente(agenteDoEvento(dados));
    if (!vinculo) return;
    const estado = estadoDoAgente(tipo);
    const erro = mensagemDeFalhaDoAgente(tipo);
    const atualizacao: Prisma.TrescPlusVinculoUpdateInput = {};
    if (estado && estado !== vinculo.estado) {
      atualizacao.estado = estado;
      atualizacao.estadoDesde = new Date();
    }
    if (tipo === 'agent-was-logged-out') {
      atualizacao.campanhaId = null;
      atualizacao.campanhaNome = null;
      atualizacao.modo = null;
      atualizacao.pausaId = null;
      atualizacao.pausaNome = null;
    } else if (tipo === 'agent-entered-manual') {
      atualizacao.modo = 'manual';
    } else if (tipo === 'agent-left-manual-mode') {
      atualizacao.modo = null;
    } else if (tipo === 'agent-entered-work-break') {
      const pausa = lerPausaDoEvento(dados);
      atualizacao.pausaId = pausa.id;
      atualizacao.pausaNome = pausa.nome;
    } else if (tipo === 'agent-left-work-break') {
      atualizacao.pausaId = null;
      atualizacao.pausaNome = null;
    }
    const campanha = campanhaDoEventoDeAgente(dados);
    if (campanha && tipo !== 'agent-was-logged-out') {
      atualizacao.campanhaId = campanha.id;
      atualizacao.campanhaNome = campanha.nome ?? vinculo.campanhaNome;
    }
    const atual =
      Object.keys(atualizacao).length > 0
        ? await this.prisma.trescPlusVinculo.update({
            where: { id: vinculo.id },
            data: atualizacao,
          })
        : vinculo;
    this.emitirAgente(atual, erro);
    if (tipo === 'agent-in-acw' || tipo === 'agent-entered-manual-acw') {
      await this.pedirQualificacaoDaUltima(atual);
    }
  }

  emitirAgente(vinculo: TrescPlusVinculo, erro: string | null = null): void {
    this.tempoReal.emitir(salas.usuario(vinculo.usuarioId), 'tresc.agente', {
      estado: vinculo.estado,
      desde: vinculo.estadoDesde.toISOString(),
      campanha:
        vinculo.campanhaId !== null
          ? { id: vinculo.campanhaId, nome: vinculo.campanhaNome }
          : null,
      modo: vinculo.modo,
      pausa:
        vinculo.pausaId !== null
          ? { id: vinculo.pausaId, nome: vinculo.pausaNome }
          : null,
      erro,
    });
  }

  /** O agente entrou em pós-atendimento: pede a qualificação da última ligação ainda sem ela. */
  private async pedirQualificacaoDaUltima(
    vinculo: TrescPlusVinculo,
  ): Promise<void> {
    const ligacao = await this.prisma.ligacao.findFirst({
      where: {
        provedor: 'TRESC_PLUS',
        atendenteId: vinculo.usuarioId,
        qualificadaEm: null,
        atendidaEm: { not: null },
        iniciadaEm: { gte: new Date(Date.now() - 30 * 60_000) },
      },
      orderBy: { iniciadaEm: 'desc' },
      select: { id: true, campanhaId: true },
    });
    if (ligacao) {
      this.tempoReal.emitir(
        salas.usuario(vinculo.usuarioId),
        'tresc.qualificar',
        {
          ligacaoId: ligacao.id,
          campanhaId: ligacao.campanhaId,
        },
      );
    }
  }

  // -------------------------------------------------------------------------
  // Chamada
  // -------------------------------------------------------------------------

  private async processarEventoDeChamada(
    tipo: string,
    dados: Record<string, unknown>,
  ): Promise<void> {
    const chamada = lerChamada(dados);
    if (!chamada) return;
    const ctx = new ContextoDaLigacao();
    let vinculoAtualizado: TrescPlusVinculo | null = null;
    await this.prisma.$transaction(async (tx) => {
      if (!(await this.registrarChave(tx, chaveDoEvento(tipo, dados)))) return;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`tresc:${chamada.id}`}, 0))`;
      const vinculo = await this.vinculoDoAgente(chamada.agente, tx);
      const receptiva = ehReceptiva(dados);
      let ligacao = await this.buscar(tx, chamada.id);
      if (!ligacao) {
        const contato = await this.resolverContato(
          tx,
          { telefone: chamada.telefone, identifier: chamada.identifier },
          vinculo ? await this.pessoaDe(tx, vinculo.usuarioId) : null,
        );
        if (!contato) {
          if (receptiva) this.avisarReceptivoSemContato(ctx, chamada, vinculo);
          return;
        }
        const direcao = receptiva ? 'RECEBIDA' : 'FEITA';
        ligacao = await tx.ligacao.create({
          data: {
            provedor: 'TRESC_PLUS',
            idExterno: chamada.id,
            contatoId: contato.contatoId,
            negocioId: contato.negocioId,
            direcao,
            estado: estadoInicial(direcao),
            atendenteId: vinculo?.usuarioId ?? null,
            telefone: chamada.telefone,
            campanhaId: chamada.campanhaId ?? vinculo?.campanhaId ?? null,
            campanhaNome: chamada.campanhaNome ?? vinculo?.campanhaNome ?? null,
            modoChamada: chamada.modo ?? (receptiva ? 'receptive' : null),
            tocouPara: [],
          },
        });
        await this.auditoria.registrar(tx, {
          acao: 'ligacao.iniciada',
          entidade: 'ligacao',
          entidadeId: ligacao.id,
          resumo: `Ligação do 3C+ ${direcao === 'RECEBIDA' ? 'recebida' : 'iniciada'}`,
          dados: { provedor: 'TRESC_PLUS', regra: REGRA_TRESC_PLUS },
          relacionados: {
            contato: contato.contatoId,
            ...(vinculo ? { usuario: vinculo.usuarioId } : {}),
          },
        });
        // R6.7: a primeira interação só conta quando a ligação é atendida (em `aplicarDecisao`).
      }
      ligacao = await this.completarAtendente(tx, ligacao, vinculo, chamada);
      await this.avisarReceptivo(tx, ctx, ligacao, vinculo);
      const decisao = decidirChamada(ligacao.estado, ligacao.direcao, tipo);
      if (decisao) {
        ligacao = await this.aplicarDecisao(tx, ctx, ligacao, decisao);
      } else if (ligacao.atendenteId && !ehEstadoFinal(ligacao.estado)) {
        await this.emitirLigacao(tx, ctx, ligacao);
      }
      const estado = estadoDoAgente(tipo);
      if (vinculo && estado && estado !== vinculo.estado) {
        vinculoAtualizado = await tx.trescPlusVinculo.update({
          where: { id: vinculo.id },
          data: { estado, estadoDesde: new Date() },
        });
      }
    });
    await ctx.concluir(this.tempoReal);
    if (vinculoAtualizado) this.emitirAgente(vinculoAtualizado);
  }

  private buscar(tx: Tx, idExterno: string): Promise<Ligacao | null> {
    return tx.ligacao.findUnique({
      where: { provedor_idExterno: { provedor: 'TRESC_PLUS', idExterno } },
    });
  }

  /** Quando o agente só aparece num evento posterior (receptivo), completa o atendente e a campanha. */
  private async completarAtendente(
    tx: Tx,
    ligacao: Ligacao,
    vinculo: TrescPlusVinculo | null,
    chamada: { campanhaId: number | null; campanhaNome: string | null },
  ): Promise<Ligacao> {
    const dados: Prisma.LigacaoUncheckedUpdateInput = {};
    if (vinculo && ligacao.atendenteId === null) {
      dados.atendenteId = vinculo.usuarioId;
    }
    if (
      ligacao.campanhaId === null &&
      (chamada.campanhaId ?? vinculo?.campanhaId)
    ) {
      dados.campanhaId = chamada.campanhaId ?? vinculo?.campanhaId;
      dados.campanhaNome =
        chamada.campanhaNome ?? vinculo?.campanhaNome ?? null;
    }
    return Object.keys(dados).length > 0
      ? tx.ligacao.update({ where: { id: ligacao.id }, data: dados })
      : ligacao;
  }

  /** R34.7: a ligação recebida avisa o vendedor que atende (uma vez por vendedor). */
  private async avisarReceptivo(
    tx: Tx,
    ctx: ContextoDaLigacao,
    ligacao: Ligacao,
    vinculo: TrescPlusVinculo | null,
  ): Promise<void> {
    if (
      ligacao.direcao !== 'RECEBIDA' ||
      !vinculo ||
      ligacao.atendenteId !== vinculo.usuarioId ||
      ligacao.tocouPara.includes(vinculo.usuarioId) ||
      ehEstadoFinal(ligacao.estado)
    ) {
      return;
    }
    await tx.ligacao.update({
      where: { id: ligacao.id },
      data: { tocouPara: { push: vinculo.usuarioId } },
    });
    // R5.9: os negócios do aviso são só os que o vendedor que atende enxerga.
    const contato = await this.resolverContato(
      tx,
      {
        telefone: ligacao.telefone,
        identifier: null,
        contatoId: ligacao.contatoId,
      },
      await this.pessoaDe(tx, vinculo.usuarioId),
    );
    ctx.emitir(salas.usuario(vinculo.usuarioId), 'tresc.recebida', {
      ligacaoId: ligacao.id,
      telefone: ligacao.telefone,
      contato: contato
        ? {
            id: contato.contatoId,
            nome: contato.nome,
            empresa: contato.empresa,
          }
        : null,
      negocios: contato?.negocios ?? [],
      novoContato: false,
    });
  }

  private avisarReceptivoSemContato(
    ctx: ContextoDaLigacao,
    chamada: {
      id: string;
      telefone: string | null;
      telefoneBruto: string | null;
    },
    vinculo: TrescPlusVinculo | null,
  ): void {
    if (
      !vinculo ||
      this.avisadasSemContato.has(`${chamada.id}:${vinculo.usuarioId}`)
    ) {
      return;
    }
    if (this.avisadasSemContato.size > 500) this.avisadasSemContato.clear();
    this.avisadasSemContato.add(`${chamada.id}:${vinculo.usuarioId}`);
    ctx.emitir(salas.usuario(vinculo.usuarioId), 'tresc.recebida', {
      ligacaoId: null,
      telefone: chamada.telefone ?? chamada.telefoneBruto,
      contato: null,
      negocios: [],
      novoContato: true,
    });
  }

  /** Casa o número (ou o `identifier`) com um contato do CRM e escolhe o negócio. */
  async resolverContato(
    tx: Tx | PrismaService,
    busca: {
      telefone: string | null;
      identifier: string | null;
      contatoId?: string;
    },
    /**
     * Quem vai ver o resultado (R5.9): só entram os negócios que a pessoa vê e a escolha do negócio
     * se restringe a eles. Sem pessoa (ligação sem atendente), vale o mais recente.
     */
    pessoa: QuemAcessa | null = null,
  ): Promise<ContatoEncontrado | null> {
    let contatoId: string | null = busca.contatoId ?? null;
    let negocioId: string | null = null;
    if (!contatoId && busca.identifier) {
      const negocio = await tx.negocio.findFirst({
        where: { id: busca.identifier, excluidoEm: null },
        select: { id: true, contatoId: true },
      });
      if (negocio) {
        negocioId = negocio.id;
        contatoId = negocio.contatoId;
      } else {
        const contato = await tx.contato.findFirst({
          where: { id: busca.identifier, excluidoEm: null },
          select: { id: true },
        });
        contatoId = contato?.id ?? null;
      }
    }
    if (!contatoId && busca.telefone) {
      const variantes = variantesDoTelefone(busca.telefone);
      if (variantes.length > 0) {
        const contato = await tx.contato.findFirst({
          where: { telefone: { in: variantes }, excluidoEm: null },
          orderBy: { criadoEm: 'asc' },
          select: { id: true },
        });
        contatoId = contato?.id ?? null;
      }
    }
    if (!contatoId) return null;
    const contato = await tx.contato.findFirst({
      where: { id: contatoId, excluidoEm: null },
      select: { id: true, nome: true, empresa: { select: { nome: true } } },
    });
    if (!contato) return null;
    const abertos = await tx.negocio.findMany({
      where: { contatoId, status: 'ABERTO', excluidoEm: null },
      orderBy: { criadoEm: 'desc' },
      select: { id: true, titulo: true },
      take: 20,
    });
    let negocios = abertos;
    if (pessoa) {
      const visiveis = await negociosQueVe(tx, pessoa, [
        negocioId,
        ...abertos.map(({ id }) => id),
      ]);
      negocios = abertos.filter(({ id }) => visiveis.has(id));
      if (negocioId && !visiveis.has(negocioId)) negocioId = null;
    }
    return {
      contatoId,
      nome: contato.nome,
      empresa: contato.empresa?.nome ?? null,
      // Vários negócios abertos: o mais recente (sem o `identifier`, o telefone não distingue).
      negocioId: negocioId ?? negocios[0]?.id ?? null,
      negocios,
    };
  }

  // -------------------------------------------------------------------------
  // Mudança de estado e fechamento
  // -------------------------------------------------------------------------

  private async aplicarDecisao(
    tx: Tx,
    ctx: ContextoDaLigacao,
    ligacao: Ligacao,
    decisao: { estado: Ligacao['estado']; motivo: string | null },
    quando: Date = new Date(),
    /** Fechamento sem informação do 3C+ (ligação presa): não inventa duração. */
    semDuracao = false,
  ): Promise<Ligacao> {
    const terminal = ehEstadoFinal(decisao.estado);
    const dados: Prisma.LigacaoUncheckedUpdateInput = {
      estado: decisao.estado,
    };
    if (
      decisao.estado === 'TOCANDO' &&
      ligacao.direcao === 'FEITA' &&
      !ligacao.tocouEm
    ) {
      dados.tocouEm = quando;
    }
    if (decisao.estado === 'EM_ANDAMENTO') dados.atendidaEm = quando;
    if (terminal) {
      dados.encerradaEm = quando;
      dados.motivo = decisao.motivo;
      const inicio = ligacao.atendidaEm;
      dados.duracaoSegundos =
        inicio && !semDuracao
          ? Math.max(
              0,
              Math.round((quando.getTime() - inicio.getTime()) / 1000),
            )
          : 0;
    }
    const atualizada = await tx.ligacao.update({
      where: { id: ligacao.id },
      data: dados,
    });
    if (decisao.estado === 'EM_ANDAMENTO' && atualizada.atendenteId) {
      // R6.7 — ligação atendida por uma pessoa (a do discador só conta quando conecta ao agente).
      await registrarPrimeiraInteracao(tx, {
        contatoId: atualizada.contatoId,
        tipo: 'LIGACAO',
        usuarioId: atualizada.atendenteId,
        quando,
      });
    }
    if (terminal) {
      await this.finalizar(tx, ctx, atualizada);
    } else {
      await this.emitirLigacao(tx, ctx, atualizada);
    }
    return atualizada;
  }

  /** `tresc.ligacao` para o atendente; o negócio de um funil que ele não vê vai sem id (R5.9). */
  private async emitirLigacao(
    tx: Tx | PrismaService,
    ctx: ContextoDaLigacao,
    ligacao: Ligacao,
  ): Promise<void> {
    if (!ligacao.atendenteId) return;
    ctx.emitir(
      salas.usuario(ligacao.atendenteId),
      'tresc.ligacao',
      cargaDaLigacao(ligacao, await this.atendenteVeONegocio(tx, ligacao)),
    );
  }

  /**
   * Cria a atividade `LIGACAO` do contato (uma vez) quando a ligação foi feita ou atendida por uma pessoa.
   * Devolve o id da atividade (a existente ou a nova), ou `null` quando não há o que registrar.
   */
  private async garantirAtividade(
    tx: Tx,
    ligacao: Ligacao,
  ): Promise<string | null> {
    const atendida = ligacao.atendidaEm !== null;
    let atividadeId = ligacao.atividadeId;
    const contato = await tx.contato.findUnique({
      where: { id: ligacao.contatoId },
      select: { id: true, nome: true, empresaId: true },
    });
    const registraAtividade =
      ligacao.atendenteId !== null &&
      contato !== null &&
      (ligacao.direcao === 'FEITA' || atendida);
    if (registraAtividade && contato && ligacao.atendenteId && !atividadeId) {
      const criada = await tx.atividade.create({
        data: {
          tipo: 'LIGACAO',
          titulo:
            ligacao.direcao === 'RECEBIDA'
              ? `Ligação recebida de ${contato.nome} (3C+)`
              : `Ligação feita para ${contato.nome} (3C+)`,
          descricao: descricaoDaAtividade(ligacao),
          status: 'CONCLUIDA',
          concluidaEm: new Date(),
          concluidaPorId: ligacao.atendenteId,
          responsavelId: ligacao.atendenteId,
          criadoPorId: ligacao.atendenteId,
          contatoId: contato.id,
          negocioId: ligacao.negocioId,
          empresaId: contato.empresaId,
        },
      });
      atividadeId = criada.id;
      await tx.ligacao.update({
        where: { id: ligacao.id },
        data: { atividadeId },
      });
      await this.auditoria.registrar(tx, {
        acao: 'atividade.criada',
        entidade: 'atividade',
        entidadeId: criada.id,
        resumo: `Ligação do 3C+ criou a atividade "${criada.titulo}"`,
        dados: { ...dadosDoEvento(criada), ligacaoId: ligacao.id },
        relacionados: { contato: criada.contatoId, empresa: criada.empresaId },
      });
      await this.eventos.publicar(
        tx,
        'atividade.criada',
        dadosDoEvento(criada),
      );
      await this.eventos.publicar(
        tx,
        'atividade.concluida',
        dadosDoEvento(criada),
      );
    }
    return atividadeId;
  }

  /** Estado terminal: atividade do contato, auditoria, evento de domínio e aviso ao vendedor. */
  private async finalizar(
    tx: Tx,
    ctx: ContextoDaLigacao,
    ligacao: Ligacao,
  ): Promise<void> {
    const atendida = ligacao.atendidaEm !== null;
    await this.garantirAtividade(tx, ligacao);
    await this.auditoria.registrar(tx, {
      acao: `ligacao.${ligacao.estado.toLowerCase()}`,
      entidade: 'ligacao',
      entidadeId: ligacao.id,
      resumo: `Ligação do 3C+ ${RESULTADO_POR_ESTADO[ligacao.estado]}${
        ligacao.duracaoSegundos
          ? ` (${formatarDuracao(ligacao.duracaoSegundos)})`
          : ''
      }`,
      dados: {
        provedor: 'TRESC_PLUS',
        direcao: ligacao.direcao,
        estado: ligacao.estado,
        motivo: ligacao.motivo,
        duracaoSegundos: ligacao.duracaoSegundos ?? 0,
        idExterno: ligacao.idExterno,
        campanhaId: ligacao.campanhaId,
        regra: REGRA_TRESC_PLUS,
      },
      relacionados: {
        contato: ligacao.contatoId,
        ...(ligacao.negocioId ? { negocio: ligacao.negocioId } : {}),
      },
    });
    const completa = await tx.ligacao.findUniqueOrThrow({
      where: { id: ligacao.id },
      include: INCLUIR_LIGACAO,
    });
    await this.eventos.publicar(
      tx,
      EVENTOS_DE_LIGACAO.ENCERRADA,
      dadosDoEventoDeLigacao(completa as LigacaoCompleta, false),
    );
    await this.emitirLigacao(tx, ctx, completa);
    if (completa.atendenteId && atendida && completa.qualificadaEm === null) {
      ctx.emitir(salas.usuario(completa.atendenteId), 'tresc.qualificar', {
        ligacaoId: completa.id,
        campanhaId: completa.campanhaId,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Histórico (`call-history-was-created` e `GET /calls`)
  // -------------------------------------------------------------------------

  /** Completa a ligação com o registro final: duração, falado, qualificação, motivo e gravação. */
  async processarHistorico(dados: Record<string, unknown>): Promise<void> {
    const historico = lerHistorico(dados);
    if (!historico) return;
    const ctx = new ContextoDaLigacao();
    const baixar: { ligacaoId: string | null } = { ligacaoId: null };
    await this.prisma.$transaction(async (tx) => {
      const chave = `${EVENTO_HISTORICO}:${historico.chamada.id}`;
      if (!(await this.registrarChave(tx, chave))) return;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`tresc:${historico.chamada.id}`}, 0))`;
      baixar.ligacaoId = await this.aplicarHistorico(tx, ctx, historico);
    });
    await ctx.concluir(this.tempoReal);
    if (baixar.ligacaoId) {
      await this.fila.enviar(
        FILA_BAIXAR_GRAVACAO,
        { ligacaoId: baixar.ligacaoId },
        { chaveUnica: `tresc-gravacao:${baixar.ligacaoId}` },
      );
    }
  }

  private async aplicarHistorico(
    tx: Tx,
    ctx: ContextoDaLigacao,
    h: HistoricoDaChamada,
  ): Promise<string | null> {
    const chamada = h.chamada;
    const vinculo = await this.vinculoDoAgente(chamada.agente, tx);
    let ligacao = await this.buscar(tx, chamada.id);
    if (!ligacao) {
      const contato = await this.resolverContato(
        tx,
        { telefone: chamada.telefone, identifier: chamada.identifier },
        vinculo ? await this.pessoaDe(tx, vinculo.usuarioId) : null,
      );
      if (!contato) return null;
      const direcao =
        chamada.modo && ehReceptiva({ mode: chamada.modo })
          ? 'RECEBIDA'
          : 'FEITA';
      ligacao = await tx.ligacao.create({
        data: {
          provedor: 'TRESC_PLUS',
          idExterno: chamada.id,
          contatoId: contato.contatoId,
          negocioId: contato.negocioId,
          direcao,
          estado: estadoInicial(direcao),
          atendenteId: vinculo?.usuarioId ?? null,
          telefone: chamada.telefone,
          campanhaId: chamada.campanhaId,
          campanhaNome: chamada.campanhaNome,
          modoChamada: chamada.modo,
          iniciadaEm: h.dataDaChamada ?? new Date(),
          tocouPara: vinculo ? [vinculo.usuarioId] : [],
        },
      });
      // R6.7: a primeira interação só conta quando houve conversa (abaixo, `falou`).
    }
    ligacao = await this.completarAtendente(tx, ligacao, vinculo, chamada);
    const falou = (h.faladoSegundos ?? 0) > 0;
    const dados: Prisma.LigacaoUncheckedUpdateInput = {};
    if (h.faladoSegundos !== null) dados.tempoFaladoSegundos = h.faladoSegundos;
    if (h.qualificacao) {
      dados.qualificacaoId = h.qualificacao.id;
      dados.qualificacaoNome = h.qualificacao.nome;
      dados.qualificacaoConversao = h.qualificacao.conversao;
      dados.qualificacaoNota = h.observacao;
      dados.qualificadaEm = ligacao.qualificadaEm ?? new Date();
    }
    if (h.temGravacao) {
      dados.gravar = true;
      if (ligacao.gravacaoSituacao === 'SEM')
        dados.gravacaoSituacao = 'ENVIANDO';
    }
    // O histórico é o registro final: quem não chegou a ser atendido pelos eventos mas teve fala foi atendida.
    const reabrir =
      falou &&
      ehEstadoFinal(ligacao.estado) &&
      ligacao.estado !== 'ENCERRADA' &&
      ligacao.estado !== 'FALHOU';
    const fim = h.dataDaChamada
      ? new Date(
          h.dataDaChamada.getTime() +
            (h.cobradoSegundos ?? h.faladoSegundos ?? 0) * 1000,
        )
      : new Date();
    if (falou) {
      dados.duracaoSegundos = h.faladoSegundos;
      if (!ligacao.atendidaEm) dados.atendidaEm = h.dataDaChamada ?? new Date();
    }
    if (reabrir) {
      dados.estado = 'ENCERRADA';
      dados.motivo = 'concluida';
    }
    if (h.causaDoFim && !falou) {
      // Sem fala: a causa do fim informada pelo 3C+ (ex.: "NO ANSWER") explica o desfecho.
      dados.erroMensagem = h.causaDoFim;
    }
    let atualizada = await tx.ligacao.update({
      where: { id: ligacao.id },
      data: dados,
    });
    if (!ehEstadoFinal(atualizada.estado) || reabrir) {
      if (!ehEstadoFinal(atualizada.estado)) {
        const decisao = decidirChamada(
          atualizada.estado === 'CHAMANDO' || atualizada.estado === 'TOCANDO'
            ? falou
              ? 'EM_ANDAMENTO'
              : atualizada.estado
            : atualizada.estado,
          atualizada.direcao,
          'call-was-finished',
        );
        if (decisao) {
          if (falou && !atualizada.atendidaEm) {
            atualizada = await tx.ligacao.update({
              where: { id: atualizada.id },
              data: { atendidaEm: h.dataDaChamada ?? new Date() },
            });
          }
          atualizada = await this.aplicarDecisao(
            tx,
            ctx,
            atualizada,
            decisao,
            fim,
          );
        }
      }
    }
    if (falou && atualizada.duracaoSegundos !== h.faladoSegundos) {
      // O tempo falado do 3C+ é a duração da ligação (a decisão acima mede só o tempo de relógio).
      atualizada = await tx.ligacao.update({
        where: { id: atualizada.id },
        data: { duracaoSegundos: h.faladoSegundos },
      });
    }
    if (ehEstadoFinal(atualizada.estado) && atualizada.encerradaEm === null) {
      atualizada = await tx.ligacao.update({
        where: { id: atualizada.id },
        data: { encerradaEm: fim },
      });
    }
    if (falou && atualizada.estado === 'ENCERRADA' && atualizada.atendenteId) {
      await registrarPrimeiraInteracao(tx, {
        contatoId: atualizada.contatoId,
        tipo: 'LIGACAO',
        usuarioId: atualizada.atendenteId,
        quando: atualizada.atendidaEm ?? undefined,
      });
    }
    if (
      reabrir &&
      atualizada.estado === 'ENCERRADA' &&
      !atualizada.atividadeId
    ) {
      // Recebida que o evento deu como perdida e o histórico mostrou que foi atendida: faltava a atividade
      // `LIGACAO` (o fechamento como perdida não cria). Só completa o registro; o evento de encerramento
      // antigo não é publicado de novo.
      const atividadeId = await this.garantirAtividade(tx, atualizada);
      if (atividadeId) atualizada = { ...atualizada, atividadeId };
    }
    if (atualizada.atividadeId) {
      await tx.atividade.updateMany({
        where: { id: atualizada.atividadeId },
        data: { descricao: descricaoDaAtividade(atualizada) },
      });
    }
    if (h.qualificacao && ligacao.qualificacaoNome !== h.qualificacao.nome) {
      await this.auditoria.registrar(tx, {
        acao: 'ligacao.qualificada',
        entidade: 'ligacao',
        entidadeId: atualizada.id,
        resumo: `Ligação do 3C+ qualificada como "${h.qualificacao.nome}"`,
        dados: {
          provedor: 'TRESC_PLUS',
          qualificacao: h.qualificacao.nome,
          regra: REGRA_TRESC_PLUS,
        },
        relacionados: { contato: atualizada.contatoId },
      });
    }
    await this.emitirLigacao(tx, ctx, atualizada);
    return h.temGravacao && !atualizada.gravacaoOriginalArquivoId
      ? atualizada.id
      : null;
  }

  // -------------------------------------------------------------------------
  // Gravação (R34.4 + R30)
  // -------------------------------------------------------------------------

  /** Baixa a gravação do 3C+ para o armazenamento e enfileira a transcrição (R30). */
  async baixarGravacao(ligacaoId: string, ultima: boolean): Promise<void> {
    const ligacao = await this.prisma.ligacao.findUnique({
      where: { id: ligacaoId },
    });
    if (
      !ligacao ||
      ligacao.provedor !== 'TRESC_PLUS' ||
      !ligacao.idExterno ||
      ligacao.gravacaoOriginalArquivoId ||
      ligacao.gravacaoRemovidaEm
    ) {
      return;
    }
    const falhar = async (mensagem: string): Promise<void> => {
      await this.prisma.ligacao.update({
        where: { id: ligacaoId },
        data: { gravacaoSituacao: 'FALHOU', gravacaoErro: mensagem },
      });
      this.avisarProcessada(ligacao.atendenteId, ligacaoId, 'falhou');
    };
    try {
      const cliente = await this.conexao.clienteDaEmpresaAtual();
      const audio = await cliente.gravacao(ligacao.idExterno);
      if (!audio) {
        if (!ultima)
          throw new ErroTrescPlus(
            'nao_encontrado',
            'Gravação ainda não disponível no 3C+.',
            404,
          );
        await falhar(
          'O 3C+ não tem a gravação desta ligação (ou ela ainda não ficou pronta).',
        );
        return;
      }
      const limite =
        this.ambiente.transcricao.gravacaoMaxBytes || GRAVACAO_MAX_BYTES_PADRAO;
      const arquivo = await this.arquivos.salvar(
        Readable.fromWeb(audio.corpo as unknown as WebStream),
        {
          nome: `ligacao-3c-${ligacaoId}.${sufixoDaMime(audio.mime)}`,
          mime: audio.mime,
          contexto: 'LIGACAO',
          // Sem dono: só as rotas do áudio (que auditam e limitam o download) entregam o arquivo.
          criadoPorId: null,
          limiteBytes: limite + 1024 * 1024,
        },
      );
      const transcreve = this.whisper.ligado;
      await this.prisma.$transaction(async (tx) => {
        await tx.ligacao.update({
          where: { id: ligacaoId },
          data: {
            gravar: true,
            gravacaoOriginalArquivoId: arquivo.id,
            gravacaoFinalizadaEm: new Date(),
            gravacaoSituacao: 'ENVIANDO',
            gravacaoErro: null,
            transcricaoSituacao: transcreve ? 'PENDENTE' : 'DESATIVADA',
            transcricaoErro: null,
            resumoSituacao: transcreve ? 'PENDENTE' : 'DESATIVADO',
            resumoErro: transcreve
              ? null
              : 'A transcrição está desligada neste servidor.',
          },
        });
        await this.auditoria.registrar(tx, {
          acao: 'ligacao.gravacao-finalizada',
          entidade: 'ligacao',
          entidadeId: ligacaoId,
          resumo: 'Gravação da ligação baixada do 3C+',
          dados: {
            provedor: 'TRESC_PLUS',
            tamanhoBytes: arquivo.tamanho,
            regra: REGRA_TRESC_PLUS,
          },
          relacionados: { contato: ligacao.contatoId },
        });
        await this.transcricao.enfileirarProcessamento(ligacaoId, { tx });
      });
    } catch (erro) {
      const transitoria =
        !(erro instanceof ErroApi) &&
        !(
          erro instanceof ErroTrescPlus &&
          ['token_invalido', 'sem_permissao'].includes(erro.codigo)
        );
      this.logger.warn(
        `Gravação da ligação ${ligacaoId} (3C+): ${erro instanceof Error ? erro.message : String(erro)}`,
      );
      if (transitoria && !ultima) throw erro;
      await falhar(
        erro instanceof ErroTrescPlus || erro instanceof ErroApi
          ? erro.message
          : 'Não foi possível baixar a gravação do 3C+.',
      );
    }
  }

  private avisarProcessada(
    atendenteId: string | null,
    ligacaoId: string,
    gravacao: 'falhou' | 'enviando',
  ): void {
    if (!atendenteId) return;
    this.tempoReal.emitir(salas.usuario(atendenteId), 'ligacao.processada', {
      ligacaoId,
      etapa: 'gravacao',
      gravacao,
      transcricao: null,
      resumo: null,
    });
  }

  // -------------------------------------------------------------------------
  // Reconciliação e limpeza
  // -------------------------------------------------------------------------

  /**
   * Fecha as ligações do 3C+ sem fim há mais de 3 h (eventos perdidos e sem histórico): quem chegou
   * a falar é ENCERRADA; o resto, SEM_RESPOSTA (feita) ou PERDIDA (recebida).
   */
  async fecharPresas(agora: Date = new Date()): Promise<number> {
    const limite = new Date(agora.getTime() - PRAZO_DE_LIGACAO_PRESA_MS);
    const presas = await this.prisma.ligacao.findMany({
      where: {
        provedor: 'TRESC_PLUS',
        estado: { in: ['CHAMANDO', 'TOCANDO', 'EM_ANDAMENTO'] },
        iniciadaEm: { lt: limite },
      },
      select: { id: true, idExterno: true },
      take: 200,
    });
    for (const { id, idExterno } of presas) {
      const ctx = new ContextoDaLigacao();
      await this.prisma.$transaction(async (tx) => {
        // A mesma trava dos eventos (`tresc:<chamada>`): um evento atrasado e o fechamento não se cruzam.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`tresc:${idExterno ?? id}`}, 0))`;
        await tx.$queryRaw`SELECT id FROM ligacoes WHERE id = ${id}::uuid FOR UPDATE`;
        const ligacao = await tx.ligacao.findUniqueOrThrow({ where: { id } });
        // Um evento ou o histórico pode ter fechado a ligação enquanto esperávamos a trava.
        if (ehEstadoFinal(ligacao.estado)) return;
        const decisao = decidirChamada(
          ligacao.estado,
          ligacao.direcao,
          'call-was-finished',
        );
        if (decisao) {
          // Sem histórico, não há duração conhecida: fecha com duração zero (não com as 3 h de espera).
          await this.aplicarDecisao(
            tx,
            ctx,
            ligacao,
            { ...decisao, motivo: 'sem_retorno_do_3c' },
            ligacao.atendidaEm ?? ligacao.iniciadaEm,
            true,
          );
        }
      });
      await ctx.concluir(this.tempoReal);
    }
    return presas.length;
  }

  async limparEventosAntigos(): Promise<number> {
    const { count } = await this.prisma.trescPlusEvento.deleteMany({
      where: {
        recebidoEm: { lt: new Date(Date.now() - DIAS_DE_DEDUPE * 86_400_000) },
      },
    });
    return count;
  }

  // -------------------------------------------------------------------------
  // Ligação feita pelo CRM
  // -------------------------------------------------------------------------

  /**
   * Registra a ligação que o vendedor acabou de discar pelo CRM (`POST /agent/manual_call/dial`).
   * Se o evento `call-was-created` chegou antes da resposta, a linha já existe: completa o negócio.
   */
  async registrarFeita(dados: {
    idExterno: string;
    usuarioId: string;
    contatoId: string;
    negocioId: string | null;
    telefone: string;
    campanhaId: number | null;
    campanhaNome: string | null;
  }): Promise<Ligacao> {
    const ctx = new ContextoDaLigacao();
    const ligacao = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`tresc:${dados.idExterno}`}, 0))`;
      const existente = await this.buscar(tx, dados.idExterno);
      let criada: Ligacao;
      if (existente) {
        // O contato e o negócio escolhidos no CRM prevalecem sobre os inferidos pelo telefone quando o
        // evento `call-was-created` chegou antes da resposta do `dial`.
        const mudouDeContato = existente.contatoId !== dados.contatoId;
        const negocioEscolhido =
          dados.negocioId ?? (mudouDeContato ? null : existente.negocioId);
        criada = await tx.ligacao.update({
          where: { id: existente.id },
          data: {
            contatoId: dados.contatoId,
            negocioId: negocioEscolhido,
            atendenteId: existente.atendenteId ?? dados.usuarioId,
            campanhaId: existente.campanhaId ?? dados.campanhaId,
            campanhaNome: existente.campanhaNome ?? dados.campanhaNome,
            modoChamada: existente.modoChamada ?? 'manual',
          },
        });
      } else {
        criada = await tx.ligacao.create({
          data: {
            provedor: 'TRESC_PLUS',
            idExterno: dados.idExterno,
            contatoId: dados.contatoId,
            negocioId: dados.negocioId,
            direcao: 'FEITA',
            estado: 'CHAMANDO',
            atendenteId: dados.usuarioId,
            telefone: dados.telefone,
            campanhaId: dados.campanhaId,
            campanhaNome: dados.campanhaNome,
            modoChamada: 'manual',
          },
        });
        await this.auditoria.registrar(tx, {
          acao: 'ligacao.iniciada',
          entidade: 'ligacao',
          entidadeId: criada.id,
          resumo: 'Ligação do 3C+ iniciada pelo CRM',
          dados: {
            provedor: 'TRESC_PLUS',
            campanhaId: dados.campanhaId,
            regra: REGRA_TRESC_PLUS,
          },
          relacionados: { contato: dados.contatoId, usuario: dados.usuarioId },
        });
      }
      if (existente) {
        await this.corrigirVinculos(tx, criada, existente);
      }
      // R6.7: a primeira interação só conta quando a ligação é atendida. Se ela já foi atendida antes desta
      // correção (o evento correu na frente), o contato certo é o escolhido no CRM.
      if (existente && criada.atendidaEm && criada.atendenteId) {
        await registrarPrimeiraInteracao(tx, {
          contatoId: criada.contatoId,
          tipo: 'LIGACAO',
          usuarioId: criada.atendenteId,
          quando: criada.atendidaEm,
        });
      }
      await this.emitirLigacao(tx, ctx, criada);
      return criada;
    });
    await ctx.concluir(this.tempoReal);
    return ligacao;
  }

  /** A atividade já criada acompanha o contato e o negócio que o CRM escolheu para a ligação. */
  private async corrigirVinculos(
    tx: Tx,
    ligacao: Ligacao,
    antes: Ligacao,
  ): Promise<void> {
    if (
      !ligacao.atividadeId ||
      (antes.contatoId === ligacao.contatoId &&
        antes.negocioId === ligacao.negocioId)
    ) {
      return;
    }
    const contato = await tx.contato.findUnique({
      where: { id: ligacao.contatoId },
      select: { nome: true, empresaId: true },
    });
    if (!contato) return;
    await tx.atividade.updateMany({
      where: { id: ligacao.atividadeId },
      data: {
        contatoId: ligacao.contatoId,
        negocioId: ligacao.negocioId,
        empresaId: contato.empresaId,
        titulo:
          ligacao.direcao === 'RECEBIDA'
            ? `Ligação recebida de ${contato.nome} (3C+)`
            : `Ligação feita para ${contato.nome} (3C+)`,
      },
    });
  }

  /** `identifier` do discador para um negócio/contato (o próprio id). */
  identifier(id: string): string {
    return identifierDoDiscador(id);
  }
}

// ---------------------------------------------------------------------------
// Apoio
// ---------------------------------------------------------------------------

/** O que o front recebe em `tresc.ligacao`. */
export function cargaDaLigacao(
  ligacao: Ligacao,
  negocioVisivel: boolean,
): Record<string, unknown> {
  return {
    ligacaoId: ligacao.id,
    estado: ligacao.estado,
    direcao: ligacao.direcao,
    telefone: ligacao.telefone,
    contatoId: ligacao.contatoId,
    negocioId: negocioVisivel ? ligacao.negocioId : null,
    campanhaId: ligacao.campanhaId,
    motivo: ligacao.motivo,
    motivoTexto: textoDoMotivo(ligacao.motivo),
    atendidaEm: ligacao.atendidaEm?.toISOString() ?? null,
    encerradaEm: ligacao.encerradaEm?.toISOString() ?? null,
    duracaoSegundos: ligacao.duracaoSegundos,
    qualificacao: ligacao.qualificacaoNome,
  };
}

/** A pausa de um evento `agent-entered-work-break` (`work_break`, `interval` ou `break`). */
function lerPausaDoEvento(dados: Record<string, unknown>): {
  id: number | null;
  nome: string | null;
} {
  for (const chave of [
    'work_break',
    'interval',
    'break',
    'work_break_interval',
  ]) {
    const o = dados[chave];
    if (o && typeof o === 'object') {
      const objeto = o as Record<string, unknown>;
      const id = Number(objeto.id);
      return {
        id: Number.isFinite(id) ? id : null,
        nome: typeof objeto.name === 'string' ? objeto.name : null,
      };
    }
  }
  return { id: null, nome: null };
}

function campanhaDoEventoDeAgente(
  dados: Record<string, unknown>,
): { id: number; nome: string | null } | null {
  const agente =
    dados.agent && typeof dados.agent === 'object'
      ? (dados.agent as Record<string, unknown>)
      : null;
  const candidato = dados.campaign ?? agente?.campaign;
  if (candidato && typeof candidato === 'object') {
    const o = candidato as Record<string, unknown>;
    const id = Number(o.id);
    return Number.isFinite(id)
      ? { id, nome: typeof o.name === 'string' ? o.name : null }
      : null;
  }
  const id = Number(candidato);
  return candidato !== undefined && candidato !== null && Number.isFinite(id)
    ? { id, nome: null }
    : null;
}
