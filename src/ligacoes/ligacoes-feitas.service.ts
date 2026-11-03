import { Injectable, Logger } from '@nestjs/common';
import { AuditoriaService } from '../auditoria/auditoria.service';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import { exigirAtendimento } from '../atendimento/conversas.service';
import { ErroDaGraph } from '../canais/meta/graph-api';
import {
  ConflitoException,
  DadosInvalidosException,
  NaoEncontradoException,
  RegraVioladaException,
  ServicoIndisponivelException,
} from '../comum/erros/excecoes';
import type { Canal } from '../generated/prisma/client';
import { PrismaService, type Tx } from '../prisma/prisma.service';
import { salas } from '../tempo-real/catalogo';
import { ConfiguracaoDeLigacoesService } from './configuracao-ligacoes.service';
import type { ContextoDaLigacao } from './contexto-da-ligacao';
import {
  type ChamadaDoWebhook,
  type StatusDeChamada,
  traduzirErroDeChamada,
} from './formato-chamadas';
import { GraphLigacoes } from './graph-ligacoes';
import { ESTADOS_ATIVOS, REGRA_LIGACOES } from './ligacoes.constantes';
import type { LigacaoDto, LigarDto } from './ligacoes.dto';
import { LigacoesService } from './ligacoes.service';
import { PermissoesDeLigacaoService } from './permissoes-de-ligacao.service';
import { ehTerminal } from './maquina-de-estados';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** O webhook chegou antes de o CRM gravar a ligação: o job tenta de novo. */
export class LigacaoAindaDesconhecida extends Error {
  constructor(idMeta: string) {
    super(`Ligação ${idMeta} ainda não registrada.`);
    this.name = 'LigacaoAindaDesconhecida';
  }
}

/**
 * Ligação feita pelo CRM (R29.3): o navegador manda a oferta SDP; a API confere
 * a permissão e os limites na Meta, manda o `connect` e entrega a resposta SDP
 * (que chega pelo webhook) ao navegador pelo tempo real; os estados vêm dos
 * webhooks de status.
 */
@Injectable()
export class LigacoesFeitasService {
  private readonly logger = new Logger('Ligacoes');

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditoria: AuditoriaService,
    private readonly config: ConfiguracaoDeLigacoesService,
    private readonly permissoes: PermissoesDeLigacaoService,
    private readonly nucleo: LigacoesService,
    private readonly graph: GraphLigacoes,
  ) {}

  async ligar(usuario: UsuarioAutenticado, dto: LigarDto): Promise<LigacaoDto> {
    exigirAtendimento(usuario);
    const canal = await this.permissoes.resolverCanal(
      dto.contatoId,
      dto.canalId,
    );
    const config = await this.config.ler(canal.id);
    if (!config.botaoVisivel) {
      throw new RegraVioladaException(
        REGRA_LIGACOES,
        'O botão de ligar para o cliente está desligado neste canal.',
        { motivo: 'botao_desligado' },
      );
    }
    const cliente = await this.permissoes.destinoDoContato(dto.contatoId);
    await this.exigirLivre(usuario.id, dto.contatoId, canal.id);
    const atividadeId = await this.validarAtividade(dto.atividadeId);

    // A Meta é conferida antes de cada ligação: ela não avisa quando a permissão expira (R29.4).
    await this.permissoes.conferirParaLigar(canal, dto.contatoId, cliente);

    const conversa = await this.prisma.conversa.findFirst({
      where: {
        canalId: canal.id,
        contatoId: dto.contatoId,
        status: { not: 'RESOLVIDA' },
      },
      select: { id: true },
    });
    let criada;
    try {
      criada = await this.nucleo.executar(async (tx) => {
        const ligacao = await tx.ligacao.create({
          data: {
            canalId: canal.id,
            contatoId: dto.contatoId,
            conversaId: conversa?.id ?? null,
            direcao: 'FEITA',
            estado: 'CHAMANDO',
            atendenteId: usuario.id,
            telefone: cliente.telefone,
            bsuid: cliente.bsuid,
            ofertaSdp: dto.sdp,
            atividadeId,
            gravar: config.gravar,
          },
        });
        await this.auditoria.registrar(tx, {
          acao: 'ligacao.iniciada',
          entidade: 'ligacao',
          entidadeId: ligacao.id,
          resumo: `Ligação do WhatsApp iniciada por ${usuario.nome}`,
          dados: { canalId: canal.id, regra: REGRA_LIGACOES },
          relacionados: { contato: dto.contatoId, usuario: usuario.id },
        });
        return ligacao;
      });
    } catch (erro) {
      throw this.nucleo.traduzirUnicidade(erro);
    }

    const idMeta = await this.conectar(canal, criada.id, cliente, dto.sdp);
    // O webhook pode ter chegado antes desta linha (o id opaco o liga à ligação): só grava se ainda faltar.
    await this.prisma.ligacao.updateMany({
      where: { id: criada.id, idMeta: null },
      data: { idMeta },
    });
    const atual = await this.nucleo.carregar(this.prisma, criada.id);
    if (ehTerminal(atual.estado)) {
      // O atendente cancelou enquanto o connect ainda estava a caminho: a Meta precisa do terminate.
      await this.nucleo
        .agirNaMeta(canal.id, 'terminate', idMeta)
        .catch(() => undefined);
    } else {
      await this.nucleo.agendarVigia(criada.id);
    }
    return this.nucleo.obter(usuario, criada.id);
  }

  /** `connect` na Meta; erro vira ligação FALHOU e uma resposta em português. */
  private async conectar(
    canal: Canal,
    ligacaoId: string,
    cliente: { telefone: string | null; bsuid: string | null },
    sdp: string,
  ): Promise<string> {
    try {
      const { token, phoneNumberId } = await this.config.credenciais(canal);
      return await this.graph.conectar(
        token,
        phoneNumberId,
        cliente,
        sdp,
        ligacaoId,
      );
    } catch (erro) {
      const daGraph = erro instanceof ErroDaGraph ? erro : null;
      const traduzido = traduzirErroDeChamada(
        daGraph?.codigo ?? null,
        daGraph?.message,
      );
      await this.nucleo.executar((tx, ctx) =>
        this.nucleo.transicionar(
          tx,
          ctx,
          ligacaoId,
          { tipo: 'falhou', motivo: 'falha_ao_ligar' },
          {
            erroCodigo: daGraph?.codigo ?? null,
            erroMensagem: daGraph ? traduzido.mensagem : null,
          },
        ),
      );
      if (!daGraph) {
        throw erro;
      }
      if (daGraph.passageiro) {
        throw new ServicoIndisponivelException(
          'A Meta não respondeu ao iniciar a ligação. Tente de novo em instantes.',
          { motivo: 'meta_indisponivel' },
        );
      }
      throw new RegraVioladaException(REGRA_LIGACOES, traduzido.mensagem, {
        motivo: traduzido.motivo,
        codigoDaMeta: daGraph.codigo,
      });
    }
  }

  /** Uma ligação por atendente e uma por cliente (a Meta recusa duplicada, 138003). */
  private async exigirLivre(
    usuarioId: string,
    contatoId: string,
    canalId: string,
  ): Promise<void> {
    const ativa = await this.prisma.ligacao.findFirst({
      where: {
        estado: { in: [...ESTADOS_ATIVOS] },
        OR: [{ atendenteId: usuarioId }, { contatoId, canalId }],
      },
      select: { atendenteId: true, contatoId: true },
    });
    if (!ativa) {
      return;
    }
    if (ativa.atendenteId === usuarioId) {
      throw new ConflitoException(
        'Você já está em uma ligação: encerre-a antes de ligar de novo.',
        { motivo: 'ja_em_ligacao' },
      );
    }
    throw new ConflitoException(
      'Já existe uma ligação em andamento com este cliente.',
      { motivo: 'ligacao_duplicada' },
    );
  }

  private async validarAtividade(
    atividadeId: string | undefined,
  ): Promise<string | null> {
    if (!atividadeId) {
      return null;
    }
    const atividade = await this.prisma.atividade.findFirst({
      where: { id: atividadeId },
      select: { id: true, tipo: true, status: true },
    });
    if (!atividade) {
      throw new NaoEncontradoException('Atividade não encontrada.');
    }
    if (atividade.tipo !== 'LIGACAO' || atividade.status !== 'PENDENTE') {
      throw new DadosInvalidosException(
        'A atividade precisa ser uma ligação pendente.',
        {
          campos: [
            { campo: 'atividadeId', mensagens: ['não é uma ligação pendente'] },
          ],
        },
      );
    }
    return atividade.id;
  }

  // -------------------------------------------------------------------------
  // Webhooks (dentro da transação do webhook, com a chave de dedupe gravada)
  // -------------------------------------------------------------------------

  /** A ligação de um webhook: pelo `wacid`, ou (se o `connect` ainda não gravou o id) pelo dado opaco. */
  async acharPorWebhook(
    tx: Tx,
    canalId: string,
    idMeta: string,
    dadosOpacos: string | null,
  ): Promise<{ id: string } | null> {
    const pelaMeta = await tx.ligacao.findUnique({
      where: { canalId_idMeta: { canalId, idMeta } },
      select: { id: true },
    });
    if (pelaMeta) {
      return pelaMeta;
    }
    if (dadosOpacos && UUID.test(dadosOpacos)) {
      const pelaOpaca = await tx.ligacao.findFirst({
        where: { id: dadosOpacos, canalId, direcao: 'FEITA', idMeta: null },
        select: { id: true },
      });
      if (pelaOpaca) {
        await tx.ligacao.update({
          where: { id: pelaOpaca.id },
          data: { idMeta },
        });
        return pelaOpaca;
      }
    }
    return null;
  }

  /** Webhook `connect` com a resposta SDP da Meta: vai ao navegador do atendente. */
  async aplicarRespostaSdp(
    tx: Tx,
    ctx: ContextoDaLigacao,
    canal: Canal,
    chamada: ChamadaDoWebhook,
  ): Promise<void> {
    const achada = await this.acharPorWebhook(
      tx,
      canal.id,
      chamada.id,
      chamada.dadosOpacos,
    );
    if (!achada) {
      throw new LigacaoAindaDesconhecida(chamada.id);
    }
    const ligacao = await this.nucleo.carregar(tx, achada.id);
    if (
      !chamada.sdp ||
      ehTerminal(ligacao.estado) ||
      ligacao.direcao !== 'FEITA' ||
      !ligacao.atendenteId
    ) {
      return;
    }
    await tx.ligacao.update({
      where: { id: ligacao.id },
      data: { respostaSdp: chamada.sdp },
    });
    ctx.emitir(salas.usuario(ligacao.atendenteId), 'ligacao.resposta_sdp', {
      ligacaoId: ligacao.id,
      sdp: chamada.sdp,
    });
  }

  /** Webhook de status: `RINGING`, `ACCEPTED` ou `REJECTED`. */
  async aplicarStatus(
    tx: Tx,
    ctx: ContextoDaLigacao,
    canal: Canal,
    status: StatusDeChamada,
  ): Promise<void> {
    const achada = await this.acharPorWebhook(
      tx,
      canal.id,
      status.id,
      status.dadosOpacos,
    );
    if (!achada) {
      throw new LigacaoAindaDesconhecida(status.id);
    }
    const quando = status.quando ?? undefined;
    switch (status.status) {
      case 'RINGING':
        await this.nucleo.transicionar(
          tx,
          ctx,
          achada.id,
          { tipo: 'tocando_no_cliente' },
          { quando },
        );
        break;
      case 'ACCEPTED':
        await this.nucleo.transicionar(
          tx,
          ctx,
          achada.id,
          { tipo: 'cliente_atendeu' },
          { quando, inicioNaMeta: status.quando },
        );
        break;
      case 'REJECTED':
        await this.nucleo.transicionar(
          tx,
          ctx,
          achada.id,
          { tipo: 'cliente_recusou' },
          { quando },
        );
        break;
      default:
        this.logger.debug?.(
          `Status de chamada "${status.status}" ignorado (${status.id}).`,
        );
    }
  }
}
