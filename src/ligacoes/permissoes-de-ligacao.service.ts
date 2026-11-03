import { Injectable, Logger } from '@nestjs/common';
import { AuditoriaService } from '../auditoria/auditoria.service';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import { exigirAtendimento } from '../atendimento/conversas.service';
import { MotorDoAtendimento } from '../atendimento/motor-do-atendimento.service';
import { ErroDaGraph } from '../canais/meta/graph-api';
import { outraFormaDoCelularBr } from '../canais/whatsapp-oficial/entrada-whatsapp-oficial.service';
import type {
  ConteudoOficial,
  RemetenteOficial,
} from '../canais/whatsapp-oficial/eventos-oficial';
import {
  componentesDoEnvio,
  corpoDeTemplate,
  estruturaDoTemplate,
  valoresQueFaltam,
} from '../canais/whatsapp-oficial/formato-meta';
import { GraphWhatsappOficial } from '../canais/whatsapp-oficial/graph-whatsapp-oficial';
import {
  ConflitoException,
  DadosInvalidosException,
  NaoEncontradoException,
  RegraVioladaException,
  ServicoIndisponivelException,
} from '../comum/erros/excecoes';
import {
  type Canal,
  type PermissaoDeLigacao,
  Prisma,
} from '../generated/prisma/client';
import { PrismaService, type Tx } from '../prisma/prisma.service';
import { TempoRealService } from '../tempo-real/tempo-real.service';
import {
  ConfiguracaoDeLigacoesService,
  type CredenciaisDoCanal,
} from './configuracao-ligacoes.service';
import { registrarChaveDeDedupe } from './contexto-da-ligacao';
import {
  corpoDePedidoInterativo,
  type PermissaoNaMeta,
  TEXTO_PADRAO_DO_PEDIDO,
  temComponenteDePermissao,
  traduzirErroDeChamada,
} from './formato-chamadas';
import { GraphLigacoes, type ClienteNaGraph } from './graph-ligacoes';
import type {
  ConsultaDePermissaoDto,
  PedirPermissaoDto,
  PermissaoDeLigacaoDto,
} from './ligacoes.dto';
import { REGRA_LIGACOES } from './ligacoes.constantes';
import {
  avaliarPedido,
  contarSemResposta,
  pedidosQueContam,
  podeLigarSegundoORegistro,
  situacaoExibida,
  VALIDADE_TEMPORARIA_MS,
} from './permissoes';

const JANELA_MS = 24 * 60 * 60 * 1000;

/**
 * Permissão do cliente para ligar (R29.4): o registro por canal e contato, o
 * pedido (mensagem interativa dentro da janela de 24 h; template com o
 * componente de permissão fora dela), os limites da Meta (1 pedido por 24 h e
 * 2 por 7 dias), a resposta do cliente (webhook `messages`), a conferência na
 * Meta antes de ligar (ela não avisa quando a permissão expira) e a revogação
 * depois de 4 ligações seguidas sem resposta.
 */
@Injectable()
export class PermissoesDeLigacaoService {
  private readonly logger = new Logger('Ligacoes');

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditoria: AuditoriaService,
    private readonly config: ConfiguracaoDeLigacoesService,
    private readonly graph: GraphLigacoes,
    private readonly graphOficial: GraphWhatsappOficial,
    private readonly motor: MotorDoAtendimento,
    private readonly tempoReal: TempoRealService,
  ) {}

  // -------------------------------------------------------------------------
  // Contato e canal
  // -------------------------------------------------------------------------

  /** O telefone do contato (E.164 só com dígitos); sem ele, o BSUID. 422 se não há nenhum dos dois. */
  async destinoDoContato(contatoId: string): Promise<ClienteNaGraph> {
    const contato = await this.prisma.contato.findFirst({
      where: { id: contatoId, excluidoEm: null },
      select: { telefone: true },
    });
    if (!contato) {
      throw new NaoEncontradoException('Contato não encontrado.');
    }
    const identificadores = await this.prisma.contatoIdentificador.findMany({
      where: {
        contatoId,
        tipo: { in: ['WHATSAPP', 'WHATSAPP_BSUID'] },
      },
      orderBy: { ultimoUsoEm: { sort: 'desc', nulls: 'last' } },
    });
    const telefone =
      identificadores.find((item) => item.tipo === 'WHATSAPP')?.valor ??
      contato.telefone;
    const bsuid =
      identificadores.find((item) => item.tipo === 'WHATSAPP_BSUID')?.valor ??
      null;
    if (!telefone && !bsuid) {
      throw new RegraVioladaException(
        REGRA_LIGACOES,
        'O contato não tem telefone nem identificador do WhatsApp para receber a ligação.',
        { motivo: 'contato_sem_whatsapp' },
      );
    }
    return { telefone, bsuid };
  }

  /**
   * O canal oficial de uma ligação ou pedido: o informado; senão o da conversa
   * mais recente do contato (se tiver ligações ativas); senão o único canal com
   * ligações ativas. 422 se não houver ou se houver mais de um sem escolha.
   */
  async resolverCanal(contatoId: string, canalId?: string): Promise<Canal> {
    if (canalId) {
      const canal = await this.config.canalOficial(canalId);
      return this.exigirLigacoesAtivas(canal);
    }
    const ativos = await this.prisma.canal.findMany({
      where: {
        tipo: 'WHATSAPP_OFICIAL',
        ativo: true,
        excluidoEm: null,
        configuracaoLigacoes: { is: { ativa: true } },
      },
      orderBy: { nome: 'asc' },
    });
    if (ativos.length === 0) {
      throw new RegraVioladaException(
        REGRA_LIGACOES,
        'Nenhum canal de WhatsApp oficial está com as ligações ativadas.',
        { motivo: 'ligacoes_desativadas' },
      );
    }
    if (ativos.length === 1) {
      return ativos[0] as Canal;
    }
    const conversa = await this.prisma.conversa.findFirst({
      where: { contatoId, canalId: { in: ativos.map((canal) => canal.id) } },
      orderBy: { ultimaMensagemEm: { sort: 'desc', nulls: 'last' } },
      select: { canalId: true },
    });
    const escolhido = ativos.find((canal) => canal.id === conversa?.canalId);
    if (!escolhido) {
      throw new DadosInvalidosException(
        'Há mais de um canal com ligações ativas: informe o canalId.',
        { campos: [{ campo: 'canalId', mensagens: ['é obrigatório'] }] },
      );
    }
    return escolhido;
  }

  async exigirLigacoesAtivas(canal: Canal): Promise<Canal> {
    const config = await this.config.ler(canal.id);
    if (!canal.ativo || !config.ativa) {
      throw new RegraVioladaException(
        REGRA_LIGACOES,
        `As ligações não estão ativadas no canal "${canal.nome}".`,
        { motivo: 'ligacoes_desativadas' },
      );
    }
    return canal;
  }

  // -------------------------------------------------------------------------
  // Consulta
  // -------------------------------------------------------------------------

  async situacao(
    usuario: UsuarioAutenticado,
    consulta: ConsultaDePermissaoDto,
  ): Promise<PermissaoDeLigacaoDto> {
    exigirAtendimento(usuario);
    const canal = await this.resolverCanal(
      consulta.contatoId,
      consulta.canalId,
    );
    if (consulta.atualizar) {
      const cliente = await this.destinoDoContato(consulta.contatoId);
      const credenciais = await this.config.credenciais(canal);
      const naMeta = await this.consultarNaMeta(credenciais, cliente);
      await this.prisma.$transaction((tx) =>
        this.sincronizar(tx, canal.id, consulta.contatoId, naMeta),
      );
    }
    return this.montarDto(canal, consulta.contatoId);
  }

  async montarDto(
    canal: Canal,
    contatoId: string,
    agora: Date = new Date(),
  ): Promise<PermissaoDeLigacaoDto> {
    const registro = await this.prisma.permissaoDeLigacao.findUnique({
      where: { canalId_contatoId: { canalId: canal.id, contatoId } },
    });
    const pedido = avaliarPedido(registro?.pedidosEm ?? [], agora);
    const janelaAte = await this.janelaAte(canal.id, contatoId);
    const templates = await this.templatesDePermissao(canal.id);
    return {
      contatoId,
      canalId: canal.id,
      situacao: situacaoExibida(registro, agora),
      tipo: registro?.tipo ?? null,
      validaAte: registro?.validaAte?.toISOString() ?? null,
      podeLigar: podeLigarSegundoORegistro(registro, agora),
      pedido: {
        pode: pedido.pode,
        motivo: pedido.motivo,
        liberaEm: pedido.liberaEm?.toISOString() ?? null,
        usoNas24h: pedido.usoNas24h,
        maximo24h: pedido.maximo24h,
        usoNos7d: pedido.usoNos7d,
        maximo7d: pedido.maximo7d,
      },
      ultimoPedidoEm:
        registro && registro.pedidosEm.length > 0
          ? new Date(
              Math.max(...registro.pedidosEm.map((data) => data.getTime())),
            ).toISOString()
          : null,
      respondidaEm: registro?.respondidaEm?.toISOString() ?? null,
      semRespostaSeguidas: registro?.semRespostaSeguidas ?? 0,
      janelaAberta: !!janelaAte && janelaAte > agora,
      temTemplateDePermissao: templates.length > 0,
      consultadaEm: registro?.consultadaEm?.toISOString() ?? null,
      limiteDeLigacoes: textoDoLimiteDeLigacoes(registro?.limitesDaMeta),
    };
  }

  // -------------------------------------------------------------------------
  // Pedido
  // -------------------------------------------------------------------------

  async pedir(
    usuario: UsuarioAutenticado,
    dto: PedirPermissaoDto,
  ): Promise<PermissaoDeLigacaoDto> {
    exigirAtendimento(usuario);
    const canal = await this.resolverCanal(dto.contatoId, dto.canalId);
    const cliente = await this.destinoDoContato(dto.contatoId);
    const credenciais = await this.config.credenciais(canal);
    const agora = new Date();

    const registro = await this.prisma.permissaoDeLigacao.findUnique({
      where: {
        canalId_contatoId: { canalId: canal.id, contatoId: dto.contatoId },
      },
    });
    if (
      situacaoExibida(registro, agora) === 'CONCEDIDA' &&
      registro?.tipo === 'PERMANENTE'
    ) {
      throw new ConflitoException(
        'O cliente já deu permissão permanente: não é preciso pedir.',
        { motivo: 'permissao_ja_existe' },
      );
    }
    this.exigirPedidoDentroDosLimites(registro?.pedidosEm ?? [], agora);

    // A Meta é a fonte da verdade: confere antes de gastar um pedido (se ela não responder, vale o registro local).
    const naMeta = await this.consultarNaMeta(credenciais, cliente).catch(
      (erro: unknown) => {
        if (erro instanceof ServicoIndisponivelException) {
          return null;
        }
        throw erro;
      },
    );
    if (naMeta) {
      await this.prisma.$transaction((tx) =>
        this.sincronizar(tx, canal.id, dto.contatoId, naMeta),
      );
      if (
        naMeta.status === 'permanent' ||
        (naMeta.status === 'temporary' &&
          (!naMeta.expiraEm || naMeta.expiraEm > agora))
      ) {
        throw new ConflitoException(
          'O cliente já autorizou ligações: não é preciso pedir.',
          { motivo: 'permissao_ja_existe' },
        );
      }
      if (naMeta.pedir && !naMeta.pedir.pode) {
        const libera = naMeta.pedir.limites
          .map((limite) => limite.liberaEm)
          .filter((data): data is Date => data !== null)
          .sort((a, b) => b.getTime() - a.getTime())[0];
        throw new RegraVioladaException(
          REGRA_LIGACOES,
          'A Meta não permite outro pedido de permissão para este cliente agora (limite de 1 por 24 horas e 2 por 7 dias).',
          {
            motivo: 'limite_de_pedidos',
            liberaEm: libera?.toISOString() ?? null,
            origem: 'meta',
          },
        );
      }
    }

    const wamid = await this.enviarPedido(
      canal,
      credenciais,
      cliente,
      dto,
      agora,
    );

    await this.prisma.$transaction(async (tx) => {
      const atual = await tx.permissaoDeLigacao.findUnique({
        where: {
          canalId_contatoId: { canalId: canal.id, contatoId: dto.contatoId },
        },
      });
      const pedidos = [
        ...pedidosQueContam(atual?.pedidosEm ?? [], agora),
        agora,
      ];
      await tx.permissaoDeLigacao.upsert({
        where: {
          canalId_contatoId: { canalId: canal.id, contatoId: dto.contatoId },
        },
        create: {
          canalId: canal.id,
          contatoId: dto.contatoId,
          situacao: 'PEDIDA',
          pedidosEm: pedidos,
          ultimoPedidoMensagemId: wamid,
        },
        update: {
          situacao: 'PEDIDA',
          tipo: null,
          validaAte: null,
          pedidosEm: pedidos,
          ultimoPedidoMensagemId: wamid,
          respondidaEm: null,
        },
      });
      await this.auditoria.registrar(tx, {
        acao: 'ligacao.permissao_pedida',
        entidade: 'contato',
        entidadeId: dto.contatoId,
        resumo: 'Permissão para ligar pedida ao cliente pelo WhatsApp',
        dados: { canalId: canal.id, regra: REGRA_LIGACOES },
        relacionados: { contato: dto.contatoId },
      });
      await this.avisarNaConversa(
        tx,
        canal.id,
        dto.contatoId,
        `${usuario.nome} pediu ao cliente permissão para ligar pelo WhatsApp.`,
        { ligacaoPermissao: 'pedida' },
      );
    });
    return this.montarDto(canal, dto.contatoId);
  }

  exigirPedidoDentroDosLimites(pedidosEm: readonly Date[], agora: Date): void {
    const avaliacao = avaliarPedido(pedidosEm, agora);
    if (!avaliacao.pode) {
      throw new RegraVioladaException(
        REGRA_LIGACOES,
        avaliacao.motivo === 'limite_24h'
          ? 'Já foi feito um pedido de permissão a este cliente nas últimas 24 horas: a Meta aceita 1 por dia.'
          : 'Já foram feitos 2 pedidos de permissão a este cliente nos últimos 7 dias: a Meta não aceita mais.',
        {
          motivo: 'limite_de_pedidos',
          limite: avaliacao.motivo,
          liberaEm: avaliacao.liberaEm?.toISOString() ?? null,
          origem: 'crm',
        },
      );
    }
  }

  /** Mensagem interativa dentro da janela de 24 h; fora dela, o template com o componente de permissão. */
  private async enviarPedido(
    canal: Canal,
    credenciais: CredenciaisDoCanal,
    cliente: ClienteNaGraph,
    dto: PedirPermissaoDto,
    agora: Date,
  ): Promise<string> {
    const janelaAte = await this.janelaAte(canal.id, dto.contatoId);
    const dentroDaJanela = !!janelaAte && janelaAte > agora;
    try {
      if (dentroDaJanela) {
        return await this.graphOficial.enviar(
          credenciais.token,
          credenciais.phoneNumberId,
          corpoDePedidoInterativo(
            cliente,
            dto.texto?.trim() || TEXTO_PADRAO_DO_PEDIDO,
          ),
        );
      }
      const templates = await this.templatesDePermissao(canal.id);
      const template = dto.templateId
        ? templates.find((item) => item.id === dto.templateId)
        : templates[0];
      if (!template) {
        throw new RegraVioladaException(
          REGRA_LIGACOES,
          dto.templateId
            ? 'O template escolhido não existe, não está aprovado ou não tem o componente de permissão de ligação.'
            : 'Passaram mais de 24 horas desde a última mensagem do cliente e não há template aprovado com o pedido de permissão de ligação. Crie o template na Meta e sincronize os templates do canal.',
          { motivo: 'sem_template_de_permissao' },
        );
      }
      const estrutura = estruturaDoTemplate(template.componentes);
      const contato = await this.prisma.contato.findUnique({
        where: { id: dto.contatoId },
        select: { nome: true },
      });
      const nome = (contato?.nome ?? '').trim().split(/\s+/)[0] || 'cliente';
      const valores = {
        corpo:
          dto.variaveis ??
          estrutura.corpo.variaveis.map((_, indice) =>
            indice === 0 ? nome : '-',
          ),
        cabecalho: estrutura.cabecalho?.variaveis.map(() => nome),
      };
      const faltas = valoresQueFaltam(estrutura, valores);
      if (faltas.length > 0) {
        throw new DadosInvalidosException(
          `O template pede valores que faltam: ${faltas.join(', ')}.`,
          { campos: [{ campo: 'variaveis', mensagens: faltas }] },
        );
      }
      return await this.graphOficial.enviar(
        credenciais.token,
        credenciais.phoneNumberId,
        corpoDeTemplate(
          cliente,
          template.nome,
          template.idioma,
          componentesDoEnvio(estrutura, valores),
        ),
      );
    } catch (erro) {
      throw this.traduzir(erro);
    }
  }

  private async templatesDePermissao(canalId: string) {
    const aprovados = await this.prisma.whatsappOficialTemplate.findMany({
      where: { canalId, status: 'APPROVED' },
      orderBy: [{ idioma: 'asc' }, { nome: 'asc' }],
    });
    return aprovados
      .filter((template) => temComponenteDePermissao(template.componentes))
      .sort(
        (a, b) => Number(b.idioma === 'pt_BR') - Number(a.idioma === 'pt_BR'),
      );
  }

  // -------------------------------------------------------------------------
  // Antes de ligar
  // -------------------------------------------------------------------------

  /**
   * `GET call_permissions` antes de cada ligação (a Meta não avisa quando a
   * permissão expira) e o limite de ligações feitas. Sem permissão: 422 com o
   * que o front precisa para oferecer o pedido. Sem resposta da Meta: 503 (não
   * liga sem conferir).
   */
  async conferirParaLigar(
    canal: Canal,
    contatoId: string,
    cliente: ClienteNaGraph,
  ): Promise<void> {
    const credenciais = await this.config.credenciais(canal);
    const naMeta = await this.consultarNaMeta(credenciais, cliente);
    const agora = new Date();
    const registro = await this.prisma.$transaction((tx) =>
      this.sincronizar(tx, canal.id, contatoId, naMeta),
    );
    const valida =
      naMeta.status === 'permanent' ||
      (naMeta.status === 'temporary' &&
        (!naMeta.expiraEm || naMeta.expiraEm > agora));
    if (!valida) {
      const dto = await this.montarDto(canal, contatoId, agora);
      throw new RegraVioladaException(
        REGRA_LIGACOES,
        mensagemSemPermissao(dto.situacao),
        {
          motivo: 'sem_permissao',
          situacao: dto.situacao,
          podePedir: dto.pedido.pode,
          liberaPedidoEm: dto.pedido.liberaEm,
          janelaAberta: dto.janelaAberta,
          temTemplateDePermissao: dto.temTemplateDePermissao,
          revogada: registro.situacao === 'REVOGADA',
        },
      );
    }
    if (naMeta.ligar && !naMeta.ligar.pode) {
      const libera = naMeta.ligar.limites
        .map((limite) => limite.liberaEm)
        .filter((data): data is Date => data !== null)
        .sort((a, b) => a.getTime() - b.getTime())[0];
      throw new RegraVioladaException(
        REGRA_LIGACOES,
        'O limite de ligações feitas por este número foi atingido: a Meta libera outras mais tarde.',
        {
          motivo: 'limite_diario',
          liberaEm: libera?.toISOString() ?? null,
          limites: naMeta.ligar.limites.map((limite) => ({
            periodo: limite.periodo,
            maximo: limite.maximo,
            uso: limite.uso,
          })),
        },
      );
    }
  }

  /** `GET call_permissions` com os erros da Meta em português. */
  private async consultarNaMeta(
    credenciais: CredenciaisDoCanal,
    cliente: ClienteNaGraph,
  ): Promise<PermissaoNaMeta> {
    try {
      return await this.graph.permissoes(
        credenciais.token,
        credenciais.phoneNumberId,
        cliente,
      );
    } catch (erro) {
      throw this.traduzir(erro);
    }
  }

  /** Erro da Graph → erro da API em português (passageiro = 503; definitivo = 422 com o código). */
  traduzir(erro: unknown): unknown {
    if (!(erro instanceof ErroDaGraph)) {
      return erro;
    }
    if (erro.passageiro && erro.codigo !== 613) {
      return new ServicoIndisponivelException(
        'A Meta não respondeu agora. Tente de novo em instantes.',
        { motivo: 'meta_indisponivel' },
      );
    }
    const traduzido = traduzirErroDeChamada(
      erro.codigo,
      erro.codigo === null ? erro.message : null,
    );
    return new RegraVioladaException(REGRA_LIGACOES, traduzido.mensagem, {
      motivo: traduzido.motivo,
      codigoDaMeta: erro.codigo,
    });
  }

  // -------------------------------------------------------------------------
  // Registro
  // -------------------------------------------------------------------------

  /** Grava o que a Meta disse (`GET call_permissions`) no registro do canal e contato. */
  async sincronizar(
    tx: Tx,
    canalId: string,
    contatoId: string,
    naMeta: PermissaoNaMeta,
  ): Promise<PermissaoDeLigacao> {
    const atual = await tx.permissaoDeLigacao.findUnique({
      where: { canalId_contatoId: { canalId, contatoId } },
    });
    const dados: Prisma.PermissaoDeLigacaoUncheckedUpdateInput = {
      consultadaEm: new Date(),
      limitesDaMeta: {
        pedir: naMeta.pedir,
        ligar: naMeta.ligar,
      } as unknown as Prisma.InputJsonObject,
    };
    if (naMeta.status === 'permanent') {
      dados.situacao = 'CONCEDIDA';
      dados.tipo = 'PERMANENTE';
      dados.validaAte = null;
    } else if (naMeta.status === 'temporary') {
      dados.situacao = 'CONCEDIDA';
      dados.tipo = 'TEMPORARIA';
      dados.validaAte = naMeta.expiraEm;
    } else if (atual?.situacao === 'CONCEDIDA') {
      // Tinha permissão e a Meta diz que não tem mais: expirou ou foi revogada (4 sem resposta, cliente retirou).
      dados.situacao = atual.semRespostaSeguidas >= 4 ? 'REVOGADA' : 'NENHUMA';
      dados.tipo = null;
      dados.validaAte = null;
    }
    return tx.permissaoDeLigacao.upsert({
      where: { canalId_contatoId: { canalId, contatoId } },
      create: {
        ...(dados as Prisma.PermissaoDeLigacaoUncheckedCreateInput),
        canalId,
        contatoId,
      },
      update: dados,
    });
  }

  /**
   * A resposta do cliente ao pedido (`interactive.call_permission_reply`, campo
   * `messages`): aceitar (temporária por 7 dias ou permanente) ou recusar.
   * Idempotente pelo wamid da resposta.
   */
  async registrarResposta(
    canal: Canal,
    remetente: RemetenteOficial,
    resposta: Extract<ConteudoOficial, { tipo: 'permissao_de_ligacao' }>,
    mensagem: { id: string; em: Date },
  ): Promise<void> {
    const contatoId = await this.contatoDoRemetente(remetente);
    if (!contatoId) {
      this.logger.warn(
        `Resposta de permissão ${mensagem.id} de alguém sem contato no CRM: ignorada.`,
      );
      return;
    }
    const concedida = resposta.resposta === 'accept';
    const validaAte = concedida
      ? resposta.permanente
        ? null
        : (resposta.expiraEm ??
          new Date(mensagem.em.getTime() + VALIDADE_TEMPORARIA_MS))
      : null;
    let conversaId: string | null = null;
    await this.prisma.$transaction(async (tx) => {
      if (
        !(await registrarChaveDeDedupe(tx, `${canal.id}:perm:${mensagem.id}`))
      ) {
        return;
      }
      const dados: Prisma.PermissaoDeLigacaoUncheckedUpdateInput = {
        situacao: concedida ? 'CONCEDIDA' : 'NEGADA',
        tipo: concedida
          ? resposta.permanente
            ? 'PERMANENTE'
            : 'TEMPORARIA'
          : null,
        validaAte,
        respondidaEm: mensagem.em,
        ...(concedida ? { semRespostaSeguidas: 0 } : {}),
      };
      await tx.permissaoDeLigacao.upsert({
        where: { canalId_contatoId: { canalId: canal.id, contatoId } },
        create: {
          ...(dados as Prisma.PermissaoDeLigacaoUncheckedCreateInput),
          canalId: canal.id,
          contatoId,
        },
        update: dados,
      });
      await this.auditoria.registrar(tx, {
        acao: concedida
          ? 'ligacao.permissao_concedida'
          : 'ligacao.permissao_negada',
        entidade: 'contato',
        entidadeId: contatoId,
        resumo: concedida
          ? `Cliente autorizou ligações pelo WhatsApp (${resposta.permanente ? 'permanente' : 'temporária'})`
          : 'Cliente recusou ligações pelo WhatsApp',
        dados: {
          canalId: canal.id,
          permanente: resposta.permanente,
          origem: resposta.origem,
          regra: REGRA_LIGACOES,
        },
        relacionados: { contato: contatoId },
      });
      // A resposta do cliente é uma mensagem dele: abre a janela de 24 h.
      await tx.conversa.updateMany({
        where: {
          canalId: canal.id,
          contatoId,
          status: { not: 'RESOLVIDA' },
          OR: [
            { janelaAte: null },
            { janelaAte: { lt: new Date(mensagem.em.getTime() + JANELA_MS) } },
          ],
        },
        data: { janelaAte: new Date(mensagem.em.getTime() + JANELA_MS) },
      });
      conversaId = await this.avisarNaConversa(
        tx,
        canal.id,
        contatoId,
        concedida
          ? resposta.permanente
            ? 'O cliente autorizou ligações pelo WhatsApp (permanente).'
            : `O cliente autorizou ligações pelo WhatsApp até ${formatarData(validaAte as Date)}.`
          : 'O cliente recusou ligações pelo WhatsApp.',
        { ligacaoPermissao: concedida ? 'concedida' : 'negada' },
      );
    });
    if (conversaId) {
      this.emitirPermissao(canal.id, contatoId, conversaId);
    }
  }

  /** Mais uma ligação feita terminou: conta as sem resposta (4 seguidas revogam) ou zera ao ser atendida. */
  async contarDesfecho(
    tx: Tx,
    canalId: string,
    contatoId: string,
    desfecho: 'atendida' | 'sem_resposta' | 'ignorar',
  ): Promise<void> {
    if (desfecho === 'ignorar') {
      return;
    }
    const atual = await tx.permissaoDeLigacao.findUnique({
      where: { canalId_contatoId: { canalId, contatoId } },
    });
    if (!atual && desfecho === 'atendida') {
      return;
    }
    const { total, revoga } = contarSemResposta(
      atual?.semRespostaSeguidas ?? 0,
      desfecho,
    );
    const dados: Prisma.PermissaoDeLigacaoUncheckedUpdateInput = {
      semRespostaSeguidas: total,
      ...(desfecho === 'atendida' ? { pedidosEm: [] } : {}),
      ...(revoga ? { situacao: 'REVOGADA', tipo: null, validaAte: null } : {}),
    };
    await tx.permissaoDeLigacao.upsert({
      where: { canalId_contatoId: { canalId, contatoId } },
      create: {
        ...(dados as Prisma.PermissaoDeLigacaoUncheckedCreateInput),
        canalId,
        contatoId,
      },
      update: dados,
    });
    if (revoga && atual?.situacao !== 'REVOGADA') {
      await this.auditoria.registrar(tx, {
        acao: 'ligacao.permissao_revogada',
        entidade: 'contato',
        entidadeId: contatoId,
        resumo:
          'Permissão para ligar revogada: 4 ligações seguidas sem resposta',
        dados: { canalId, regra: REGRA_LIGACOES },
        relacionados: { contato: contatoId },
      });
    }
  }

  // -------------------------------------------------------------------------
  // Apoio
  // -------------------------------------------------------------------------

  /** O contato de quem respondeu: pelo telefone (e a outra forma do celular brasileiro) ou pelo BSUID. */
  private async contatoDoRemetente(
    remetente: RemetenteOficial,
  ): Promise<string | null> {
    const candidatos: Array<{
      tipo: 'WHATSAPP' | 'WHATSAPP_BSUID';
      valor: string;
    }> = [];
    if (remetente.telefone) {
      candidatos.push({ tipo: 'WHATSAPP', valor: remetente.telefone });
      const outra = outraFormaDoCelularBr(remetente.telefone);
      if (outra) {
        candidatos.push({ tipo: 'WHATSAPP', valor: outra });
      }
    }
    if (remetente.bsuid) {
      candidatos.push({ tipo: 'WHATSAPP_BSUID', valor: remetente.bsuid });
    }
    for (const candidato of candidatos) {
      const achado = await this.prisma.contatoIdentificador.findUnique({
        where: { tipo_valor: candidato },
        select: { contatoId: true, contato: { select: { excluidoEm: true } } },
      });
      if (achado && !achado.contato.excluidoEm) {
        return achado.contatoId;
      }
    }
    for (const telefone of candidatos
      .filter((c) => c.tipo === 'WHATSAPP')
      .map((c) => c.valor)) {
      const contato = await this.prisma.contato.findFirst({
        where: { telefone, excluidoEm: null },
        select: { id: true },
      });
      if (contato) {
        return contato.id;
      }
    }
    return null;
  }

  private async janelaAte(
    canalId: string,
    contatoId: string,
  ): Promise<Date | null> {
    const conversas = await this.prisma.conversa.findMany({
      where: { canalId, contatoId, janelaAte: { not: null } },
      select: { janelaAte: true },
      orderBy: { janelaAte: 'desc' },
      take: 1,
    });
    return conversas[0]?.janelaAte ?? null;
  }

  /** Aviso do sistema na conversa em aberto do contato no canal (se houver); devolve o id da conversa. */
  private async avisarNaConversa(
    tx: Tx,
    canalId: string,
    contatoId: string,
    texto: string,
    metadados: Prisma.InputJsonObject,
  ): Promise<string | null> {
    const conversa = await tx.conversa.findFirst({
      where: { canalId, contatoId, status: { not: 'RESOLVIDA' } },
      select: {
        id: true,
        canalId: true,
        responsavelId: true,
        fila: { select: { area: true } },
      },
    });
    if (!conversa) {
      return null;
    }
    await this.motor.avisoDeSistema(tx, conversa, texto, metadados);
    return conversa.id;
  }

  private emitirPermissao(
    canalId: string,
    contatoId: string,
    conversaId: string,
  ): void {
    this.montarDtoSemFalhar(canalId, contatoId)
      .then((dto) => {
        if (dto) {
          this.tempoReal.emitir(
            `conversa:${conversaId}`,
            'ligacao.permissao',
            dto,
          );
        }
      })
      .catch(() => undefined);
  }

  private async montarDtoSemFalhar(
    canalId: string,
    contatoId: string,
  ): Promise<PermissaoDeLigacaoDto | null> {
    const canal = await this.prisma.canal.findUnique({
      where: { id: canalId },
    });
    return canal ? this.montarDto(canal, contatoId) : null;
  }
}

function mensagemSemPermissao(situacao: string): string {
  switch (situacao) {
    case 'NEGADA':
      return 'O cliente recusou ligações pelo WhatsApp. Só ele pode mudar isso: um novo pedido pode ser feito quando os limites da Meta permitirem.';
    case 'REVOGADA':
      return 'A permissão para ligar foi revogada (4 ligações seguidas sem resposta). Peça uma nova permissão ao cliente.';
    case 'EXPIRADA':
      return 'A permissão temporária do cliente expirou (vale 7 dias). Peça uma nova.';
    case 'PEDIDA':
      return 'O cliente ainda não respondeu ao pedido de permissão para ligar.';
    default:
      return 'O cliente ainda não autorizou ligações neste número: peça permissão antes de ligar.';
  }
}

function formatarData(data: Date): string {
  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'America/Sao_Paulo',
  }).format(data);
}

/** "5 por 24 h" a partir dos limites de `start_call` guardados da última consulta (LACUNA 9: nunca fixo). */
function textoDoLimiteDeLigacoes(limites: unknown): string | null {
  const ligar = (limites as { ligar?: { limites?: unknown } } | null)?.ligar;
  const primeiro = (Array.isArray(ligar?.limites) ? ligar.limites : [])[0] as
    | { periodo?: string; maximo?: number | null; uso?: number | null }
    | undefined;
  if (!primeiro || primeiro.maximo == null) {
    return null;
  }
  const periodo =
    primeiro.periodo === 'PT24H' ? '24 h' : (primeiro.periodo ?? '');
  return `${primeiro.uso ?? 0} de ${primeiro.maximo} em ${periodo}`.trim();
}
