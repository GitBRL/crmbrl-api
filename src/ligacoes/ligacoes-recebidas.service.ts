import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { AuditoriaService } from '../auditoria/auditoria.service';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import { AtendimentoService } from '../atendimento/atendimento.service';
import { exigirAtendimento } from '../atendimento/conversas.service';
import { DistribuicaoDaFila } from '../atendimento/distribuicao-fila.service';
import { podeUsarAtendimento } from '../atendimento/visibilidade';
import { ErroDaGraph } from '../canais/meta/graph-api';
import {
  ConflitoException,
  SemPermissaoException,
  ServicoIndisponivelException,
} from '../comum/erros/excecoes';
import { FilaService } from '../fila/fila.service';
import type { Canal } from '../generated/prisma/client';
import { NotificacoesService } from '../notificacoes/notificacoes.service';
import { PrismaService, type Tx } from '../prisma/prisma.service';
import { salas } from '../tempo-real/catalogo';
import { TempoRealService } from '../tempo-real/tempo-real.service';
import {
  ConfiguracaoDeLigacoesService,
  type ConfiguracaoLida,
} from './configuracao-ligacoes.service';
import type { ContextoDaLigacao } from './contexto-da-ligacao';
import {
  type ChamadaDoWebhook,
  type ClienteDaChamada,
  traduzirErroDeChamada,
} from './formato-chamadas';
import { GraphLigacoes } from './graph-ligacoes';
import {
  FILA_TOQUE_ESGOTADO,
  IDADE_MAXIMA_DO_CONNECT_MS,
  REGRA_LIGACOES,
  TIPOS_NOTIFICACAO_LIGACAO,
} from './ligacoes.constantes';
import type { AtenderLigacaoDto, LigacaoDto } from './ligacoes.dto';
import { LigacoesService } from './ligacoes.service';
import { paraLigacaoDto } from './ligacao-dto';

type MotivoDeNaoTocar =
  'fora_do_horario' | 'sem_atendente' | 'ligacoes_desativadas' | 'atrasada';

/**
 * Ligação recebida (R29.2): o webhook `connect` cria a ligação (TOCANDO) e
 * escolhe quem toca; o primeiro atendente a responder leva (trava no banco); o
 * `pre_accept` e o `accept` vão à Meta com a mesma resposta SDP; o tempo de
 * toque esgotado, fora do horário ou sem ninguém livre vira PERDIDA.
 */
@Injectable()
export class LigacoesRecebidasService implements OnModuleInit {
  private readonly logger = new Logger('Ligacoes');

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditoria: AuditoriaService,
    private readonly fila: FilaService,
    private readonly tempoReal: TempoRealService,
    private readonly notificacoes: NotificacoesService,
    private readonly atendimento: AtendimentoService,
    private readonly distribuicao: DistribuicaoDaFila,
    private readonly config: ConfiguracaoDeLigacoesService,
    private readonly nucleo: LigacoesService,
    private readonly graph: GraphLigacoes,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.fila.trabalhar<{ ligacaoId: string }>(
      FILA_TOQUE_ESGOTADO,
      (trabalho) => this.toqueEsgotado(trabalho.dados.ligacaoId),
      { tentativas: 3, intervaloEntreTentativasSegundos: 2 },
    );
  }

  // -------------------------------------------------------------------------
  // Chegada (webhook connect com a oferta SDP da Meta)
  // -------------------------------------------------------------------------

  /** Roda dentro da transação do webhook (já com a chave de dedupe gravada). */
  async receber(
    tx: Tx,
    ctx: ContextoDaLigacao,
    canal: Canal,
    chamada: ChamadaDoWebhook,
    cliente: ClienteDaChamada,
  ): Promise<void> {
    if (!chamada.sdp) {
      this.logger.warn(`connect ${chamada.id} sem oferta SDP: ignorado.`);
      return;
    }
    if (!cliente.telefone && !cliente.bsuid) {
      this.logger.warn(
        `connect ${chamada.id} sem telefone nem BSUID: ignorado.`,
      );
      return;
    }
    const existente = await tx.ligacao.findUnique({
      where: { canalId_idMeta: { canalId: canal.id, idMeta: chamada.id } },
      select: { id: true },
    });
    if (existente) {
      return;
    }
    const agora = new Date();
    const quando = chamada.quando ?? agora;
    const { contato, conversa } = await this.atendimento.conversaDaLigacao(
      tx,
      canal.id,
      cliente.telefone
        ? {
            tipo: 'WHATSAPP',
            valor: cliente.telefone,
            ...(cliente.nome ? { nome: cliente.nome } : {}),
          }
        : {
            tipo: 'WHATSAPP_BSUID',
            valor: cliente.bsuid as string,
            ...(cliente.nome ? { nome: cliente.nome } : {}),
          },
      quando,
    );
    const config = await this.config.ler(canal.id);

    let bloqueio: MotivoDeNaoTocar | null = null;
    let candidatos: string[] = [];
    if (agora.getTime() - quando.getTime() > IDADE_MAXIMA_DO_CONNECT_MS) {
      bloqueio = 'atrasada';
    } else if (!config.ativa) {
      bloqueio = 'ligacoes_desativadas';
    } else if (!this.config.dentroDoHorario(canal, config, agora)) {
      bloqueio = 'fora_do_horario';
    } else {
      candidatos = await this.quemToca(tx, canal, config, {
        conversaResponsavelId: conversa.responsavelId,
        contatoResponsavelId:
          (
            await tx.contato.findUnique({
              where: { id: contato.id },
              select: { responsavelId: true },
            })
          )?.responsavelId ?? null,
        filaId: conversa.filaId,
      });
      if (candidatos.length === 0) {
        bloqueio = 'sem_atendente';
      }
    }

    const expiraEm = new Date(
      agora.getTime() + config.tempoDeToqueSegundos * 1000,
    );
    const criada = await tx.ligacao.create({
      data: {
        canalId: canal.id,
        contatoId: contato.id,
        conversaId: conversa.id,
        direcao: 'RECEBIDA',
        estado: 'TOCANDO',
        idMeta: chamada.id,
        telefone: cliente.telefone,
        bsuid: cliente.bsuid,
        ofertaSdp: chamada.sdp,
        expiraEm,
        iniciadaEm: quando,
        tocouEm: bloqueio ? null : agora,
        gravar: config.gravar,
        tocouPara: candidatos,
      },
    });
    await this.auditoria.registrar(tx, {
      acao: 'ligacao.recebida',
      entidade: 'ligacao',
      entidadeId: criada.id,
      resumo: `Ligação do WhatsApp recebida de "${contato.nome}"`,
      dados: {
        canalId: canal.id,
        idMeta: chamada.id,
        tocouPara: candidatos.length,
        bloqueio,
        regra: REGRA_LIGACOES,
      },
      relacionados: { contato: contato.id },
    });

    if (bloqueio) {
      await this.nucleo.transicionar(tx, ctx, criada.id, {
        tipo: 'nao_pode_tocar',
        motivo: bloqueio,
      });
      if (bloqueio !== 'atrasada') {
        // A Meta ainda espera a resposta: recusa já, sem esperar o tempo dela estourar.
        ctx.aposCommit(() =>
          this.nucleo.agirNaMeta(canal.id, 'reject', chamada.id),
        );
      }
      return;
    }

    await this.fila.enviar(
      FILA_TOQUE_ESGOTADO,
      { ligacaoId: criada.id },
      { tx, executarEm: expiraEm },
    );
    const carga = {
      ligacaoId: criada.id,
      contato: {
        id: contato.id,
        nome: contato.nome,
        telefone: cliente.telefone ?? contato.telefone,
        empresa: await this.nomeDaEmpresa(tx, contato.empresaId),
      },
      canal: { id: canal.id, nome: canal.nome },
      ofertaSdp: chamada.sdp,
      expiraEm: expiraEm.toISOString(),
      conversaId: conversa.id,
    };
    for (const usuarioId of candidatos) {
      ctx.emitir(salas.usuario(usuarioId), 'ligacao.tocando', carga);
    }
    await this.notificacoes.notificarVarios(tx, candidatos, {
      tipo: TIPOS_NOTIFICACAO_LIGACAO.TOCANDO,
      titulo: `Ligação de ${contato.nome}`,
      texto: 'Toque para atender a ligação do WhatsApp.',
      link: `/atendimento?ligacao=${criada.id}`,
      dados: { ligacaoId: criada.id, contatoId: contato.id },
    });
  }

  private async nomeDaEmpresa(
    tx: Tx,
    empresaId: string | null,
  ): Promise<string | null> {
    if (!empresaId) {
      return null;
    }
    return (
      (
        await tx.empresa.findUnique({
          where: { id: empresaId },
          select: { nome: true },
        })
      )?.nome ?? null
    );
  }

  /**
   * Quem toca: o responsável da conversa ou do contato, se estiver online e
   * livre; senão, todos os atendentes online e livres da fila de ligações.
   * "Livre" = sem ligação em andamento.
   */
  private async quemToca(
    tx: Tx,
    canal: Canal,
    config: ConfiguracaoLida,
    quem: {
      conversaResponsavelId: string | null;
      contatoResponsavelId: string | null;
      filaId: string | null;
    },
  ): Promise<string[]> {
    const online = new Set(await this.tempoReal.usuariosConectados());
    const aptos = async (ids: readonly string[]): Promise<string[]> => {
      const unicos = [...new Set(ids)].filter((id) => online.has(id));
      if (unicos.length === 0) {
        return [];
      }
      const [usuarios, ocupados] = await Promise.all([
        tx.usuario.findMany({
          where: { id: { in: unicos }, ativo: true },
          select: { id: true, papel: true },
        }),
        tx.ligacao.findMany({
          where: {
            atendenteId: { in: unicos },
            estado: { in: ['CHAMANDO', 'TOCANDO', 'EM_ANDAMENTO'] },
          },
          select: { atendenteId: true },
        }),
      ]);
      const ocupadosIds = new Set(ocupados.map((item) => item.atendenteId));
      return usuarios
        .filter(
          (usuario) =>
            podeUsarAtendimento(usuario.papel) && !ocupadosIds.has(usuario.id),
        )
        .map((usuario) => usuario.id);
    };

    const responsaveis = await aptos(
      [quem.conversaResponsavelId, quem.contatoResponsavelId].filter(
        (id): id is string => !!id,
      ),
    );
    const primeiro = [quem.conversaResponsavelId, quem.contatoResponsavelId]
      .filter((id): id is string => !!id)
      .find((id) => responsaveis.includes(id));
    if (primeiro) {
      return [primeiro];
    }
    const filaId = config.filaId ?? canal.filaPadraoId ?? quem.filaId;
    if (!filaId) {
      return [];
    }
    const fila = await tx.filaAtendimento.findFirst({
      where: { id: filaId, ativa: true, excluidoEm: null },
    });
    if (!fila) {
      return [];
    }
    const situacao = await this.distribuicao.situacao(tx, fila);
    return aptos(situacao.participantes.elegiveis.map((usuario) => usuario.id));
  }

  // -------------------------------------------------------------------------
  // Atender
  // -------------------------------------------------------------------------

  /**
   * O primeiro POST de atender leva a ligação: a trava é a linha da ligação
   * (os outros recebem 409 e `deixou_de_tocar`). Depois, `pre_accept` e `accept`
   * com a MESMA resposta SDP; só então a ligação entra em andamento.
   */
  async atender(
    usuario: UsuarioAutenticado,
    id: string,
    dto: AtenderLigacaoDto,
  ): Promise<LigacaoDto> {
    exigirAtendimento(usuario);
    let reivindicada;
    try {
      reivindicada = await this.nucleo.executar(async (tx, ctx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`ligacao:${id}`}, 0))`;
        const atual = await this.nucleo.carregar(tx, id);
        if (atual.direcao !== 'RECEBIDA') {
          throw new ConflitoException(
            'Só ligações recebidas são atendidas: para uma ligação feita, aguarde o cliente.',
            { motivo: 'ligacao_feita' },
          );
        }
        if (atual.estado !== 'TOCANDO') {
          throw new ConflitoException(
            atual.estado === 'EM_ANDAMENTO'
              ? 'A ligação já está em andamento.'
              : 'A ligação já terminou.',
            { motivo: 'ligacao_encerrada', estado: atual.estado },
          );
        }
        if (atual.atendenteId) {
          throw new ConflitoException(
            atual.atendenteId === usuario.id
              ? 'Você já está atendendo esta ligação.'
              : `Esta ligação já foi atendida por ${atual.atendente?.nome ?? 'outro atendente'}.`,
            {
              motivo:
                atual.atendenteId === usuario.id
                  ? 'ja_atendida_por_voce'
                  : 'atendida_por_outro',
              atendidaPor: atual.atendente,
            },
          );
        }
        if (!atual.tocouPara.includes(usuario.id)) {
          throw new SemPermissaoException('Esta ligação não tocou para você.', {
            regra: REGRA_LIGACOES,
            motivo: 'nao_chamado',
          });
        }
        if (atual.expiraEm && atual.expiraEm.getTime() <= Date.now()) {
          throw new ConflitoException(
            'O tempo de toque desta ligação acabou.',
            { motivo: 'tempo_esgotado' },
          );
        }
        await tx.ligacao.update({
          where: { id },
          data: { atendenteId: usuario.id },
        });
        for (const outro of atual.tocouPara.filter((x) => x !== usuario.id)) {
          ctx.emitir(salas.usuario(outro), 'ligacao.deixou_de_tocar', {
            ligacaoId: id,
            motivo: 'atendida_por_outro',
            atendidaPor: { id: usuario.id, nome: usuario.nome },
          });
        }
        await this.nucleo.limparAvisosDeToque(tx, ctx, id, atual.tocouPara);
        return atual;
      });
    } catch (erro) {
      throw this.nucleo.traduzirUnicidade(erro);
    }

    try {
      const canal = await this.config.canalOficial(reivindicada.canalId);
      const { token, phoneNumberId } = await this.config.credenciais(canal);
      const idMeta = reivindicada.idMeta as string;
      await this.graph.agir(
        token,
        phoneNumberId,
        'pre_accept',
        idMeta,
        dto.sdp,
      );
      if (this.nucleo.esperaPreAceiteMs > 0) {
        await new Promise((resolver) =>
          setTimeout(resolver, this.nucleo.esperaPreAceiteMs),
        );
      }
      await this.graph.agir(token, phoneNumberId, 'accept', idMeta, dto.sdp);
    } catch (erro) {
      await this.falharAoAtender(id, erro);
    }

    const resultado = await this.nucleo.executar(async (tx, ctx) => {
      const r = await this.nucleo.transicionar(tx, ctx, id, {
        tipo: 'atendida_pelo_atendente',
      });
      if (r.aplicada) {
        await this.auditoria.registrar(tx, {
          acao: 'ligacao.atendida',
          entidade: 'ligacao',
          entidadeId: id,
          resumo: `Ligação de "${r.ligacao.contato.nome}" atendida por ${usuario.nome}`,
          dados: { canalId: r.ligacao.canalId, regra: REGRA_LIGACOES },
          relacionados: { contato: r.ligacao.contatoId, usuario: usuario.id },
        });
      }
      return r;
    });
    if (!resultado.aplicada) {
      throw new ConflitoException(
        'O cliente desligou antes de a ligação ser atendida.',
        { motivo: 'ligacao_encerrada', estado: resultado.ligacao.estado },
      );
    }
    return paraLigacaoDto(resultado.ligacao, usuario.id);
  }

  /** A Meta recusou o `pre_accept`/`accept`: a ligação falha e o atendente recebe o motivo em português. */
  private async falharAoAtender(id: string, erro: unknown): Promise<never> {
    const daGraph = erro instanceof ErroDaGraph ? erro : null;
    const traduzido = daGraph
      ? traduzirErroDeChamada(
          daGraph.codigo,
          daGraph.codigo === null ? daGraph.message : daGraph.message,
        )
      : null;
    await this.nucleo.executar((tx, ctx) =>
      this.nucleo.transicionar(
        tx,
        ctx,
        id,
        { tipo: 'falhou', motivo: 'falha_ao_atender' },
        {
          erroCodigo: daGraph?.codigo ?? null,
          erroMensagem: traduzido?.mensagem ?? null,
        },
      ),
    );
    if (daGraph?.passageiro) {
      throw new ServicoIndisponivelException(
        'A Meta não respondeu ao atender a ligação. Ela foi encerrada.',
        { motivo: 'meta_indisponivel' },
      );
    }
    throw new ConflitoException(
      'A Meta não aceitou a ligação: ela pode já ter terminado ou expirado.',
      {
        motivo: 'meta_recusou',
        codigoDaMeta: daGraph?.codigo ?? null,
      },
    );
  }

  // -------------------------------------------------------------------------
  // Recusar
  // -------------------------------------------------------------------------

  /**
   * O atendente recusa a ligação que toca para ele (R29.2): ela some só para ele e os outros
   * continuam ouvindo. Se todos os chamados recusarem, a ligação é rejeitada na Meta na hora
   * (sem esperar o tempo de toque) e vira PERDIDA (`recusada_pelos_atendentes`). Idempotente.
   */
  async recusar(usuario: UsuarioAutenticado, id: string): Promise<LigacaoDto> {
    exigirAtendimento(usuario);
    const ligacao = await this.nucleo.executar(async (tx, ctx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`ligacao:${id}`}, 0))`;
      const atual = await this.nucleo.carregar(tx, id);
      if (atual.direcao !== 'RECEBIDA') {
        throw new ConflitoException(
          'Só ligações recebidas podem ser recusadas.',
          { motivo: 'ligacao_feita' },
        );
      }
      if (!atual.tocouPara.includes(usuario.id)) {
        throw new SemPermissaoException('Esta ligação não tocou para você.', {
          regra: REGRA_LIGACOES,
          motivo: 'nao_chamado',
        });
      }
      if (atual.estado !== 'TOCANDO' || atual.atendenteId) {
        throw new ConflitoException(
          atual.estado === 'TOCANDO' || atual.estado === 'EM_ANDAMENTO'
            ? 'A ligação já foi atendida.'
            : 'A ligação já terminou.',
          { motivo: 'ligacao_encerrada', estado: atual.estado },
        );
      }
      if (atual.recusadaPor.includes(usuario.id)) {
        return atual;
      }
      const recusadaPor = [...atual.recusadaPor, usuario.id];
      await tx.ligacao.update({ where: { id }, data: { recusadaPor } });
      await this.auditoria.registrar(tx, {
        acao: 'ligacao.recusada_por_atendente',
        entidade: 'ligacao',
        entidadeId: id,
        resumo: `${usuario.nome} recusou a ligação de "${atual.contato.nome}"`,
        dados: { canalId: atual.canalId, regra: REGRA_LIGACOES },
        relacionados: { contato: atual.contatoId, usuario: usuario.id },
      });
      const todos = atual.tocouPara.every((alvo) => recusadaPor.includes(alvo));
      if (!todos) {
        ctx.emitir(salas.usuario(usuario.id), 'ligacao.deixou_de_tocar', {
          ligacaoId: id,
          motivo: 'recusada_por_voce',
        });
        await this.nucleo.limparAvisosDeToque(tx, ctx, id, [usuario.id]);
        return { ...atual, recusadaPor };
      }
      const resultado = await this.nucleo.transicionar(tx, ctx, id, {
        tipo: 'recusada_por_todos',
      });
      if (resultado.aplicada && atual.idMeta) {
        const idMeta = atual.idMeta;
        ctx.aposCommit(() =>
          this.nucleo.agirNaMeta(atual.canalId, 'reject', idMeta),
        );
      }
      return resultado.ligacao;
    });
    return paraLigacaoDto(ligacao, usuario.id, usuario.papel);
  }

  // -------------------------------------------------------------------------
  // Tempo de toque esgotado
  // -------------------------------------------------------------------------

  /** Job: ninguém atendeu a tempo. Recusa na Meta e vira PERDIDA. */
  async toqueEsgotado(ligacaoId: string): Promise<void> {
    await this.nucleo.executar(async (tx, ctx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`ligacao:${ligacaoId}`}, 0))`;
      const atual = await this.nucleo.carregar(tx, ligacaoId);
      if (
        atual.direcao !== 'RECEBIDA' ||
        atual.estado !== 'TOCANDO' ||
        atual.atendenteId
      ) {
        // Já atendida (o accept está em curso) ou terminada: a Meta fecha pelo `terminate`.
        return;
      }
      const resultado = await this.nucleo.transicionar(tx, ctx, ligacaoId, {
        tipo: 'tempo_de_toque_esgotado',
      });
      if (resultado.aplicada && atual.idMeta) {
        const idMeta = atual.idMeta;
        ctx.aposCommit(() =>
          this.nucleo.agirNaMeta(atual.canalId, 'reject', idMeta),
        );
      }
    });
  }
}
