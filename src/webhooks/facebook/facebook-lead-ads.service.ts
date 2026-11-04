import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { CriptografiaService } from '../../comum/criptografia/criptografia.service';
import {
  NaoAutenticadoException,
  RegraVioladaException,
} from '../../comum/erros/excecoes';
import { FilaService, type Trabalho } from '../../fila/fila.service';
import type {
  ConexaoFacebook,
  OrigemLeadFacebook,
  Prisma,
  WebhookEntrada,
} from '../../generated/prisma/client';
import { LogsTecnicosService } from '../../logs/logs-tecnicos.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  AplicativosService,
  type DelegadoDeAplicativo,
  objetoDe,
} from '../entrada/aplicativos.service';
import type {
  CampoBuscado,
  FormularioDoAplicativo,
} from '../aplicativos/tipos';
import { FILA_PROCESSAR_RECEBIMENTO } from '../webhooks.constantes';
import { ConexoesFacebookService } from './conexoes-facebook.service';
import {
  ErroDaGraph,
  instanteDaMeta,
  marcoDaReconciliacao,
  type LeadDoFacebook,
} from './graph-facebook';
import {
  camposDasPerguntas,
  type LeadgenDoWebhook,
  normalizarLead,
} from './lead-facebook';

/** Fila do lead avisado pelo webhook (busca na Graph e entrega ao processamento comum). */
export const FILA_LEAD_FACEBOOK = 'facebook.lead';
/** Fila da reconciliação periódica dos formulários ativos. */
export const FILA_RECONCILIAR_FACEBOOK = 'facebook.reconciliar';
/** A cada 15 minutos (R32.14). */
export const CRON_DA_RECONCILIACAO = '*/15 * * * *';
/** Folga na janela da reconciliação: leads criados perto da última conferência não escapam. */
export const FOLGA_DA_RECONCILIACAO_MS = 30 * 60_000;
/** Até quando a reconciliação olha para trás (uma integração parada por muito tempo não importa tudo de uma vez). */
export const LIMITE_DA_RECONCILIACAO_MS = 14 * 24 * 3600_000;

const CAMPO_ASSINADO = 'leadgen';

/** Um job: o lead que a Meta avisou para uma integração. */
export interface TrabalhoDoLeadFacebook {
  integracaoId: string;
  leadgenId: string;
  paginaId: string;
  formularioId: string;
  anuncioId: string | null;
}

interface Assinatura {
  readonly conexaoId: string;
  readonly paginaId: string;
  readonly em: string;
}

/** A Meta recusou por falta de permissão (`leads_retrieval`, Leads Access, página sem acesso). */
function ehErroDePermissao(erro: ErroDaGraph): boolean {
  return (
    erro.codigo === 10 ||
    (erro.codigo !== null && erro.codigo >= 200 && erro.codigo <= 299) ||
    (erro.codigo === 100 && erro.subcodigo === 33)
  );
}

const MENSAGEM_DE_PERMISSAO =
  'A Meta recusou a leitura dos leads (permissão leads_retrieval, ou o acesso do CRM em "Leads Access" na Central de Leads, ou função na página): confira essas permissões.';

/**
 * Facebook Lead Ads (R32.14): o lado da integração.
 *
 * - **Assinatura da página** (`subscribed_apps`, campo `leadgen`): feita junto
 *   com a integração (criar, ativar, trocar página ou formulário) e desfeita
 *   quando a integração é excluída ou desativada, se nenhuma outra integração
 *   ativa usa a mesma página. Os campos já assinados pelo app na página (ex.:
 *   mensagens do Messenger) são preservados.
 * - **Webhook** (`object: page`, `field: leadgen`), chamado pelo roteador da Meta
 *   (`WebhookMetaService`): confere `X-Hub-Signature-256` com o segredo do app da
 *   conexão e enfileira um job por integração que usa a página e o formulário.
 * - **Job do lead**: busca o lead na Graph com o token da página, normaliza
 *   (`normalizarLead`) e entrega ao processamento comum (um `WebhookRecebimento`
 *   `RECEBIDO` + a fila `webhooks-entrada.processar`), uma vez só por
 *   `(integração, leadgen_id)` (tabela `leads_facebook`).
 * - **Reconciliação** a cada 15 minutos: lista os leads recentes dos formulários
 *   ativos e entrega os que o webhook não trouxe. Token recusado → "precisa de
 *   atenção" e aviso ao Admin.
 */
@Injectable()
export class FacebookLeadAdsService
  implements OnModuleInit, DelegadoDeAplicativo
{
  private readonly logger = new Logger('FacebookLeadAds');

  constructor(
    private readonly prisma: PrismaService,
    private readonly cripto: CriptografiaService,
    private readonly fila: FilaService,
    private readonly aplicativos: AplicativosService,
    private readonly conexoes: ConexoesFacebookService,
    private readonly logs: LogsTecnicosService,
  ) {}

  /** Desafio do webhook de páginas: o token de verificação é de alguma conexão do Facebook? */
  tokenDeVerificacaoValido(token: string): Promise<boolean> {
    return this.conexoes.tokenDeVerificacaoValido(token);
  }

  async onModuleInit(): Promise<void> {
    this.aplicativos.registrarDelegado('FACEBOOK_LEAD_ADS', this);
    await this.fila.trabalhar<TrabalhoDoLeadFacebook>(
      FILA_LEAD_FACEBOOK,
      (trabalho) => this.processarLead(trabalho),
      {
        concorrencia: 2,
        tentativas: 4,
        intervaloEntreTentativasSegundos: 20,
        esperaExponencial: true,
        prazoDeExecucaoSegundos: 120,
        guardarConcluidosPorSegundos: 24 * 3600,
      },
    );
    await this.fila.trabalhar(
      FILA_RECONCILIAR_FACEBOOK,
      async () => {
        await this.reconciliar();
      },
      { tentativas: 0, prazoDeExecucaoSegundos: 600 },
    );
    await this.fila.agendar(FILA_RECONCILIAR_FACEBOOK, CRON_DA_RECONCILIACAO);
  }

  // -------------------------------------------------------------------------
  // Webhook (chamado pelo roteador da Meta)
  // -------------------------------------------------------------------------

  /**
   * Os `leadgen` de um POST do webhook: confere a assinatura com o segredo do
   * app de cada conexão envolvida e enfileira um job por integração ativa que
   * usa a página e o formulário. Sem integração para o evento: ignora (200).
   * Assinatura que não confere em nenhuma conexão envolvida: 401.
   */
  async receberLeadgens(
    leadgens: readonly LeadgenDoWebhook[],
    bruto: Buffer | undefined,
    assinatura: string | undefined,
  ): Promise<number> {
    if (leadgens.length === 0) {
      return 0;
    }
    const pares = [
      ...new Map(
        leadgens.map(({ paginaId, formularioId }) => [
          `${paginaId}:${formularioId}`,
          { paginaId, formularioId },
        ]),
      ).values(),
    ];
    const integracoes = await this.prisma.webhookEntrada.findMany({
      where: {
        aplicativo: 'FACEBOOK_LEAD_ADS',
        excluidoEm: null,
        ativo: true,
        OR: pares.map(({ paginaId, formularioId }) => ({
          AND: [
            { configuracao: { path: ['paginaId'], equals: paginaId } },
            { configuracao: { path: ['formularioId'], equals: formularioId } },
          ],
        })),
      },
    });
    if (integracoes.length === 0) {
      return 0;
    }
    const idsDasConexoes = [
      ...new Set(
        integracoes.flatMap((integracao) => {
          const id = objetoDe(integracao.configuracao).conexaoId;
          return typeof id === 'string' ? [id] : [];
        }),
      ),
    ];
    const conexoes = await this.prisma.conexaoFacebook.findMany({
      where: { id: { in: idsDasConexoes }, excluidoEm: null },
    });
    const assinadas = new Set<string>();
    for (const conexao of conexoes) {
      const segredo = this.conexoes.appSecretDe(conexao);
      if (
        segredo &&
        bruto &&
        this.cripto.verificarHmac(segredo, bruto, assinatura)
      ) {
        assinadas.add(conexao.id);
      }
    }
    if (assinadas.size === 0) {
      await this.logs.aviso(
        'Meta',
        assinatura
          ? 'Webhook leadgen da Meta com assinatura inválida (X-Hub-Signature-256 não confere com o segredo do app).'
          : 'Webhook leadgen da Meta sem a assinatura X-Hub-Signature-256.',
        { conexoes: idsDasConexoes },
      );
      throw new NaoAutenticadoException(
        assinatura
          ? 'Assinatura inválida: X-Hub-Signature-256 não confere.'
          : 'Assinatura ausente: envie X-Hub-Signature-256.',
      );
    }
    let enfileirados = 0;
    for (const leadgen of leadgens) {
      for (const integracao of integracoes) {
        const config = objetoDe(integracao.configuracao);
        if (
          config.paginaId !== leadgen.paginaId ||
          config.formularioId !== leadgen.formularioId ||
          typeof config.conexaoId !== 'string' ||
          !assinadas.has(config.conexaoId)
        ) {
          continue;
        }
        await this.fila.enviar(
          FILA_LEAD_FACEBOOK,
          {
            integracaoId: integracao.id,
            leadgenId: leadgen.leadgenId,
            paginaId: leadgen.paginaId,
            formularioId: leadgen.formularioId,
            anuncioId: leadgen.anuncioId,
          } satisfies TrabalhoDoLeadFacebook,
          { chaveUnica: `${integracao.id}:${leadgen.leadgenId}` },
        );
        enfileirados++;
      }
    }
    return enfileirados;
  }

  // -------------------------------------------------------------------------
  // Job do lead
  // -------------------------------------------------------------------------

  async processarLead(
    trabalho: Trabalho<TrabalhoDoLeadFacebook>,
  ): Promise<void> {
    const { integracaoId, leadgenId, paginaId, formularioId, anuncioId } =
      trabalho.dados;
    const integracao = await this.integracaoAtiva(integracaoId);
    if (!integracao) {
      return;
    }
    const repetido = await this.prisma.leadFacebook.findUnique({
      where: { webhookId_leadgenId: { webhookId: integracaoId, leadgenId } },
      select: { id: true },
    });
    if (repetido) {
      return;
    }
    const conexao = await this.conexaoDe(integracao);
    if (!conexao) {
      return;
    }
    let lead: LeadDoFacebook;
    try {
      lead = await this.conexoes
        .graph()
        .lead(this.conexoes.tokenDaPagina(conexao, paginaId), leadgenId);
    } catch (erro) {
      if (await this.tratarFalhaDaMeta(erro, integracao, conexao)) {
        // Token ou permissão: a reconciliação traz o lead quando o Admin resolver.
        return;
      }
      throw erro;
    }
    await this.entregar(
      integracao,
      lead.id ? lead : { ...lead, id: leadgenId },
      'WEBHOOK',
      { paginaId, formularioId, anuncioId },
    );
  }

  // -------------------------------------------------------------------------
  // Reconciliação
  // -------------------------------------------------------------------------

  /** Confere os formulários ativos e entrega os leads que o webhook não trouxe. Devolve quantos leads novos entraram. */
  async reconciliar(agora: Date = new Date()): Promise<number> {
    await this.conexoes.limparPendentes();
    const integracoes = await this.prisma.webhookEntrada.findMany({
      where: { aplicativo: 'FACEBOOK_LEAD_ADS', excluidoEm: null, ativo: true },
      orderBy: { criadoEm: 'asc' },
    });
    let novos = 0;
    for (const integracao of integracoes) {
      try {
        novos += await this.reconciliarIntegracao(integracao, agora);
      } catch (erro) {
        await this.logs.erro(
          'FacebookLeadAds',
          `Falha ao reconciliar a integração "${integracao.nome}".`,
          erro,
          { integracaoId: integracao.id },
        );
      }
    }
    return novos;
  }

  private async reconciliarIntegracao(
    integracao: WebhookEntrada,
    agora: Date,
  ): Promise<number> {
    const config = objetoDe(integracao.configuracao);
    const { paginaId, formularioId } = config;
    if (typeof paginaId !== 'string' || typeof formularioId !== 'string') {
      return 0;
    }
    const conexao = await this.conexaoDe(integracao);
    if (!conexao) {
      return 0;
    }
    const referencia =
      this.data(config.reconciliadoAte) ??
      this.data(config.reconciliarDesde) ??
      integracao.criadoEm;
    const desde = new Date(
      Math.max(
        referencia.getTime() - FOLGA_DA_RECONCILIACAO_MS,
        agora.getTime() - LIMITE_DA_RECONCILIACAO_MS,
      ),
    );
    let leads: LeadDoFacebook[];
    let completo: boolean;
    try {
      ({ leads, completo } = await this.conexoes
        .graph()
        .leadsDoFormulario(
          this.conexoes.tokenDaPagina(conexao, paginaId),
          formularioId,
          desde,
        ));
    } catch (erro) {
      if (await this.tratarFalhaDaMeta(erro, integracao, conexao)) {
        return 0;
      }
      throw erro;
    }
    let novos = 0;
    for (const lead of leads) {
      if (
        await this.entregar(integracao, lead, 'RECONCILIACAO', {
          paginaId,
          formularioId,
          anuncioId: null,
        })
      ) {
        novos++;
      }
    }
    await this.aplicativos.limparAtencao(integracao);
    const marco = marcoDaReconciliacao(agora, leads, completo);
    if (!completo) {
      await this.logs.aviso(
        'FacebookLeadAds',
        `A reconciliação da integração "${integracao.nome}" parou no limite de leads por rodada; ${marco ? 'continua do último lead lido na próxima' : 'o marco não avançou'}.`,
        { integracaoId: integracao.id },
      );
    }
    if (marco) {
      await this.gravarConfiguracao(integracao.id, (atual) => ({
        ...atual,
        reconciliadoAte: marco.toISOString(),
      }));
    }
    return novos;
  }

  // -------------------------------------------------------------------------
  // Entrega ao processamento comum
  // -------------------------------------------------------------------------

  /**
   * Registra o lead (uma vez por integração e `leadgen_id`) e cria o
   * recebimento `RECEBIDO` com a fila do processamento comum, na mesma transação.
   * Devolve falso se o lead já tinha sido entregue.
   */
  private async entregar(
    integracao: WebhookEntrada,
    lead: LeadDoFacebook,
    origem: OrigemLeadFacebook,
    contexto: {
      paginaId: string;
      formularioId: string;
      anuncioId: string | null;
    },
  ): Promise<boolean> {
    if (!lead.id) {
      return false;
    }
    const corpo = normalizarLead(lead, contexto);
    const criadoNaMeta = instanteDaMeta(lead.criadoEm);
    const agora = new Date();
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.leadFacebook.createMany({
        data: [
          {
            webhookId: integracao.id,
            leadgenId: lead.id,
            formularioId: contexto.formularioId,
            criadoNaMetaEm: criadoNaMeta,
            origem,
          },
        ],
        skipDuplicates: true,
      });
      if (count === 0) {
        return false;
      }
      const recebimento = await tx.webhookRecebimento.create({
        data: {
          webhookId: integracao.id,
          recebidoEm: agora,
          cabecalhos: {},
          tipoConteudo: 'application/json',
          corpo: corpo as Prisma.InputJsonObject,
          status: 'RECEBIDO',
          mensagem:
            origem === 'WEBHOOK'
              ? 'Lead do Facebook recebido pelo webhook.'
              : 'Lead do Facebook trazido pela reconciliação.',
        },
        select: { id: true },
      });
      await tx.leadFacebook.update({
        where: {
          webhookId_leadgenId: {
            webhookId: integracao.id,
            leadgenId: lead.id,
          },
        },
        data: { recebimentoId: recebimento.id },
      });
      // SQL direto: o último recebimento não é uma alteração da configuração.
      await tx.$executeRaw`
        UPDATE webhooks_entrada SET ultimo_recebimento_em = ${agora}
         WHERE id = ${integracao.id}::uuid`;
      await this.fila.enviar(
        FILA_PROCESSAR_RECEBIMENTO,
        { recebimentoId: recebimento.id },
        { tx },
      );
      return true;
    });
  }

  /**
   * Falha da Meta ao buscar leads: token recusado ou permissão negada marcam
   * "precisa de atenção" (avisam os Admins) e devolvem verdadeiro (não adianta
   * repetir o job); erro passageiro devolve falso (o chamador repete); o resto
   * vai para o log e também devolve verdadeiro.
   */
  private async tratarFalhaDaMeta(
    erro: unknown,
    integracao: WebhookEntrada,
    conexao: ConexaoFacebook,
  ): Promise<boolean> {
    if (!(erro instanceof ErroDaGraph)) {
      return false;
    }
    if (erro.tokenInvalido) {
      await this.conexoes.marcarTokenInvalido(
        conexao.id,
        'O Facebook recusou o token desta conexão (expirado, revogado ou a senha mudou): entre com o Facebook de novo.',
      );
      return true;
    }
    if (ehErroDePermissao(erro)) {
      await this.aplicativos.marcarAtencao(integracao, MENSAGEM_DE_PERMISSAO);
      return true;
    }
    if (erro.passageiro) {
      return false;
    }
    await this.logs.aviso(
      'FacebookLeadAds',
      `A Meta recusou a leitura de leads da integração "${integracao.nome}" (HTTP ${erro.status}, código ${erro.codigo ?? 'n/d'}).`,
      { integracaoId: integracao.id },
    );
    return true;
  }

  // -------------------------------------------------------------------------
  // Delegado do aplicativo (assistente e assinatura)
  // -------------------------------------------------------------------------

  async conferirConfiguracaoNova(
    configuracao: Record<string, unknown>,
  ): Promise<void> {
    const { conexaoId, paginaId, formularioId } = configuracao;
    const faltando = (
      [
        ['conexaoId', conexaoId],
        ['paginaId', paginaId],
        ['formularioId', formularioId],
      ] as const
    )
      .filter(([, valor]) => typeof valor !== 'string')
      .map(([chave]) => chave);
    if (faltando.length > 0) {
      throw new RegraVioladaException(
        'R32.14',
        'Escolha a conexão com o Facebook, a página e o formulário de leads antes de salvar.',
        {
          campos: faltando.map((chave) => ({
            campo: `configuracao.${chave}`,
            mensagens: ['é obrigatório no Facebook Lead Ads'],
          })),
        },
      );
    }
    const conexao = await this.conexoes.carregar(conexaoId as string);
    if (!conexao.tokenCifrado) {
      throw new RegraVioladaException(
        'R32.14',
        'Esta conexão ainda não terminou o login com o Facebook.',
      );
    }
    const formularios = await this.conexoes.comTokenDaPagina(
      conexao,
      paginaId as string,
      (graph, token) => graph.formularios(token, paginaId as string),
    );
    if (!formularios.some(({ id }) => id === formularioId)) {
      throw new RegraVioladaException(
        'R32.14',
        'O formulário escolhido não existe nesta página do Facebook.',
        { formularioId },
      );
    }
  }

  async buscarCampos(integracao: WebhookEntrada): Promise<CampoBuscado[]> {
    const { conexao, paginaId, formularioId } =
      await this.escolhaDa(integracao);
    const perguntas = await this.conexoes.comTokenDaPagina(
      conexao,
      paginaId,
      (graph, token) => graph.perguntas(token, formularioId),
    );
    return camposDasPerguntas(perguntas);
  }

  async listarFormularios(
    integracao: WebhookEntrada,
    busca?: string,
  ): Promise<FormularioDoAplicativo[]> {
    const config = objetoDe(integracao.configuracao);
    if (
      typeof config.conexaoId !== 'string' ||
      typeof config.paginaId !== 'string'
    ) {
      throw new RegraVioladaException(
        'R32.14',
        'Esta integração ainda não tem a conexão e a página escolhidas.',
      );
    }
    const formularios = await this.conexoes.formularios(
      config.conexaoId,
      config.paginaId,
      busca,
    );
    return formularios.map((f) => ({
      id: f.id,
      titulo: f.nome,
      url: null,
      atualizadoEm: f.criadoEm,
    }));
  }

  camposDoFormulario(
    integracao: WebhookEntrada,
    formularioId: string,
  ): Promise<CampoBuscado[]> {
    const config = objetoDe(integracao.configuracao);
    if (
      typeof config.conexaoId !== 'string' ||
      typeof config.paginaId !== 'string'
    ) {
      throw new RegraVioladaException(
        'R32.14',
        'Esta integração ainda não tem a conexão e a página escolhidas.',
      );
    }
    return this.conexoes.camposDoFormulario(
      config.conexaoId,
      config.paginaId,
      formularioId,
    );
  }

  /** A integração mais as escolhas dela, já conferidas. */
  private async escolhaDa(integracao: WebhookEntrada): Promise<{
    conexao: ConexaoFacebook;
    paginaId: string;
    formularioId: string;
  }> {
    const config = objetoDe(integracao.configuracao);
    const { conexaoId, paginaId, formularioId } = config;
    if (
      typeof conexaoId !== 'string' ||
      typeof paginaId !== 'string' ||
      typeof formularioId !== 'string'
    ) {
      throw new RegraVioladaException(
        'R32.14',
        'Esta integração ainda não tem a conexão, a página e o formulário escolhidos.',
      );
    }
    return {
      conexao: await this.conexoes.carregar(conexaoId),
      paginaId,
      formularioId,
    };
  }

  /**
   * Põe a assinatura da página em dia com a integração (R32.14): assina o campo
   * `leadgen` da página escolhida enquanto a integração está ativa e libera a
   * página antiga ou a atual quando ela é desativada, excluída ou trocada (se
   * nenhuma outra integração ativa a usa). Não lança: o resultado fica em
   * `configuracao.assinatura` e `configuracao.assinaturaErro`.
   */
  async sincronizar(
    id: string,
  ): Promise<{ registrado: boolean; erro: string | null }> {
    const integracao = await this.prisma.webhookEntrada.findUnique({
      where: { id },
    });
    if (!integracao || integracao.aplicativo !== 'FACEBOOK_LEAD_ADS') {
      return { registrado: false, erro: null };
    }
    const config = objetoDe(integracao.configuracao);
    const registrada = lerAssinatura(config.assinatura);
    const desejada =
      integracao.excluidoEm === null &&
      integracao.ativo &&
      typeof config.conexaoId === 'string' &&
      typeof config.paginaId === 'string' &&
      typeof config.formularioId === 'string'
        ? { conexaoId: config.conexaoId, paginaId: config.paginaId }
        : null;
    const gravar = (
      assinatura: Assinatura | null,
      erro: string | null,
      extras: Record<string, unknown> = {},
    ) =>
      this.gravarConfiguracao(id, (atual) => {
        const { assinatura: _a, assinaturaErro: _e, ...resto } = atual;
        return {
          ...resto,
          ...extras,
          ...(assinatura ? { assinatura } : {}),
          ...(erro ? { assinaturaErro: erro } : {}),
        };
      });
    let conexao: ConexaoFacebook | null = null;
    try {
      if (
        registrada &&
        (!desejada ||
          registrada.paginaId !== desejada.paginaId ||
          registrada.conexaoId !== desejada.conexaoId)
      ) {
        await this.liberarPagina(registrada.conexaoId, registrada.paginaId, id);
        if (!desejada) {
          await gravar(null, null);
          return { registrado: false, erro: null };
        }
      }
      if (!desejada) {
        await gravar(null, null);
        return { registrado: false, erro: null };
      }
      conexao = await this.conexoes.carregar(desejada.conexaoId);
      const token = this.conexoes.tokenDaPagina(conexao, desejada.paginaId);
      const graph = this.conexoes.graph();
      // O formulário precisa ser da página: sem isso, o webhook nunca casaria com a integração.
      const formularios = await graph.formularios(token, desejada.paginaId);
      const formulario = formularios.find(
        ({ id: formularioId }) => formularioId === config.formularioId,
      );
      if (!formulario) {
        throw new RegraVioladaException(
          'R32.14',
          'O formulário escolhido não existe nesta página do Facebook: escolha outro.',
        );
      }
      const campos = await graph.camposAssinados(
        token,
        desejada.paginaId,
        conexao.appId,
      );
      if (!campos.includes(CAMPO_ASSINADO)) {
        await graph.assinar(token, desejada.paginaId, [
          ...campos,
          CAMPO_ASSINADO,
        ]);
      }
      const paginaNome = this.conexoes
        .segredosDe(conexao)
        .paginas.find(
          ({ id: paginaId }) => paginaId === desejada.paginaId,
        )?.nome;
      const formularioNome = formulario.nome;
      await gravar({ ...desejada, em: new Date().toISOString() }, null, {
        ...(paginaNome ? { paginaNome } : {}),
        ...(formularioNome ? { formularioNome } : {}),
        // Onde a reconciliação começa (só na primeira vez): leads de antes da integração não entram.
        reconciliarDesde:
          typeof config.reconciliarDesde === 'string'
            ? config.reconciliarDesde
            : new Date().toISOString(),
      });
      await this.aplicativos.limparAtencao(integracao);
      return { registrado: true, erro: null };
    } catch (erro) {
      const mensagem = await this.mensagemDaFalha(erro, conexao, integracao);
      await gravar(registrada, mensagem);
      return { registrado: false, erro: mensagem };
    }
  }

  /** A integração foi excluída: libera a página (as falhas só vão para o log, a exclusão segue). */
  async remover(integracao: WebhookEntrada): Promise<void> {
    const registrada = lerAssinatura(
      objetoDe(integracao.configuracao).assinatura,
    );
    if (!registrada) {
      return;
    }
    try {
      await this.liberarPagina(
        registrada.conexaoId,
        registrada.paginaId,
        integracao.id,
      );
    } catch (erro) {
      await this.logs.aviso(
        'FacebookLeadAds',
        `Não foi possível remover a assinatura da página do Facebook da integração "${integracao.nome}": ${erro instanceof Error ? erro.message : 'erro desconhecido'}.`,
        { integracaoId: integracao.id },
      );
    }
  }

  /** Desassina `leadgen` da página se nenhuma outra integração ativa a usa (preserva os outros campos do app). */
  private async liberarPagina(
    conexaoId: string,
    paginaId: string,
    ignorarIntegracaoId: string,
  ): Promise<void> {
    const conexao = await this.prisma.conexaoFacebook.findFirst({
      where: { id: conexaoId, excluidoEm: null },
    });
    if (!conexao) {
      return;
    }
    // A assinatura na Meta é por app e página, não por conexão: outra conexão do mesmo app
    // (ex.: criada de novo em vez de "Reconectar") que usa a página divide a assinatura.
    const doMesmoApp = await this.prisma.conexaoFacebook.findMany({
      where: { appId: conexao.appId, excluidoEm: null },
      select: { id: true },
    });
    const outras = await this.prisma.webhookEntrada.count({
      where: {
        id: { not: ignorarIntegracaoId },
        aplicativo: 'FACEBOOK_LEAD_ADS',
        excluidoEm: null,
        ativo: true,
        AND: [
          {
            OR: [
              ...doMesmoApp.map(({ id }) => ({
                configuracao: { path: ['conexaoId'], equals: id },
              })),
              { configuracao: { path: ['conexaoId'], equals: conexaoId } },
            ],
          },
          { configuracao: { path: ['paginaId'], equals: paginaId } },
        ],
      },
    });
    if (outras > 0) {
      return;
    }
    const token = this.conexoes.tokenDaPagina(conexao, paginaId);
    const graph = this.conexoes.graph();
    const campos = await graph.camposAssinados(token, paginaId, conexao.appId);
    if (!campos.includes(CAMPO_ASSINADO)) {
      return;
    }
    const restantes = campos.filter((campo) => campo !== CAMPO_ASSINADO);
    if (restantes.length > 0) {
      await graph.assinar(token, paginaId, restantes);
    } else {
      await graph.desassinar(token, paginaId);
    }
  }

  private async mensagemDaFalha(
    erro: unknown,
    conexao: ConexaoFacebook | null,
    integracao: WebhookEntrada,
  ): Promise<string> {
    if (erro instanceof ErroDaGraph) {
      if (erro.tokenInvalido && conexao) {
        const motivo =
          'O Facebook recusou o token desta conexão (expirado, revogado ou a senha mudou): entre com o Facebook de novo.';
        await this.conexoes.marcarTokenInvalido(conexao.id, motivo);
        return motivo;
      }
      if (ehErroDePermissao(erro)) {
        await this.aplicativos.marcarAtencao(integracao, MENSAGEM_DE_PERMISSAO);
        return MENSAGEM_DE_PERMISSAO;
      }
      return `Não foi possível assinar a página na Meta: ${erro.message.replace(/\s+/g, ' ').slice(0, 250)}`;
    }
    if (erro instanceof RegraVioladaException) {
      return erro.message;
    }
    this.logger.error(
      `Falha inesperada ao sincronizar a integração ${integracao.id}`,
      erro instanceof Error ? erro.stack : undefined,
    );
    return 'Falha inesperada ao assinar a página na Meta; veja os logs técnicos.';
  }

  // -------------------------------------------------------------------------
  // Apoio
  // -------------------------------------------------------------------------

  private async integracaoAtiva(id: string): Promise<WebhookEntrada | null> {
    return this.prisma.webhookEntrada.findFirst({
      where: {
        id,
        aplicativo: 'FACEBOOK_LEAD_ADS',
        excluidoEm: null,
        ativo: true,
      },
    });
  }

  private async conexaoDe(
    integracao: WebhookEntrada,
  ): Promise<ConexaoFacebook | null> {
    const conexaoId = objetoDe(integracao.configuracao).conexaoId;
    if (typeof conexaoId !== 'string') {
      return null;
    }
    return this.prisma.conexaoFacebook.findFirst({
      where: { id: conexaoId, excluidoEm: null },
    });
  }

  /** Regrava `configuracao` relendo o valor mais novo (os jobs e as edições do Admin não se atropelam). */
  private async gravarConfiguracao(
    id: string,
    alterar: (atual: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const [linha] = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM webhooks_entrada WHERE id = ${id}::uuid FOR UPDATE`;
      if (!linha) {
        return;
      }
      const atual = await tx.webhookEntrada.findUniqueOrThrow({
        where: { id },
        select: { configuracao: true },
      });
      await tx.webhookEntrada.update({
        where: { id },
        data: {
          configuracao: alterar(
            objetoDe(atual.configuracao),
          ) as Prisma.InputJsonObject,
        },
      });
    });
  }

  private data(valor: unknown): Date | null {
    if (typeof valor !== 'string') {
      return null;
    }
    const data = new Date(valor);
    return Number.isNaN(data.getTime()) ? null : data;
  }
}

function lerAssinatura(valor: unknown): Assinatura | null {
  const objeto = objetoDe(valor);
  return typeof objeto.conexaoId === 'string' &&
    typeof objeto.paginaId === 'string'
    ? {
        conexaoId: objeto.conexaoId,
        paginaId: objeto.paginaId,
        em: typeof objeto.em === 'string' ? objeto.em : '',
      }
    : null;
}
