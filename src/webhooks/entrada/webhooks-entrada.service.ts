import { Inject, Injectable } from '@nestjs/common';
import { AuditoriaService } from '../../auditoria/auditoria.service';
import type { UsuarioAutenticado } from '../../auth/usuario-autenticado';
import { CriptografiaService } from '../../comum/criptografia/criptografia.service';
import { calcularAlteracoes } from '../../comum/dados/sanitizar';
import { normalizarEtiquetas } from '../../comum/dominio/etiquetas';
import { rotuloDaArea } from '../../comum/dominio/papeis';
import {
  ConflitoException,
  DadosInvalidosException,
  NaoEncontradoException,
  RegraVioladaException,
} from '../../comum/erros/excecoes';
import {
  montarPagina,
  type Pagina,
  paraSkipTake,
} from '../../comum/paginacao/paginacao';
import {
  type ProblemaDeCampo,
  resumirProblemas,
} from '../../comum/validacao/validacao';
import { AMBIENTE, type Ambiente } from '../../config/ambiente';
import { podeSerResponsavelNoFunil } from '../../funis/acessos-no-banco';
import type {
  AplicativoIntegracao,
  EstrategiaDistribuicao,
  Etapa,
  Funil,
  ModeloMapeamento,
  ModoIntegracao,
  Prisma,
  WebhookEntrada,
} from '../../generated/prisma/client';
import { PrismaService, type Tx } from '../../prisma/prisma.service';
import { travarChave } from '../../prisma/travas';
import {
  completarConfiguracaoDeCurso,
  etapasDosEventos,
  semEtapasDosEventos,
} from '../aplicativos/cursos';
import {
  adaptadorDe,
  catalogoDeAplicativos,
  definicaoDe,
} from '../aplicativos/registro';
import type {
  CampoBuscado,
  Credencial,
  RegraDoEvento,
} from '../aplicativos/tipos';
import {
  EtapaDoWebhookDto,
  FunilDoWebhookDto,
  UsuarioDoWebhookDto,
} from '../dto-comum';
import {
  BYTES_DO_SEGREDO,
  BYTES_DO_TOKEN,
  TAMANHO_DO_PREFIXO_DO_TOKEN,
  TRAVA_NOME_ENTRADA,
} from '../webhooks.constantes';
import type {
  PreviaDeMapeamentoDto,
  ResultadoDaPreviaDto,
} from './dto/previa.dto';
import type { PreviaDoWebhookDto } from './dto/recebimento.dto';
import type {
  AtualizarWebhookEntradaDto,
  CriarWebhookEntradaDto,
  DefinirSegredoEntradaDto,
  FiltroIntegracoesDto,
  ModelosDeMapeamentoDto,
  SegredoDefinidoDto,
  TokenRegeneradoDto,
  WebhookEntradaCriadoDto,
  WebhookEntradaDto,
} from './dto/webhook-entrada.dto';
import type {
  AplicativoDto,
  CatalogoDeAplicativosDto,
  EnderecoDaIntegracaoDto,
  RegraDoEventoDto,
} from './dto/integracao.dto';
import type { CredencialDaIntegracaoDto } from './dto/webhook-entrada.dto';
import { AplicativosService, objetoDe } from './aplicativos.service';
import { montarEndereco } from './endereco';
import {
  aplicarMapeamento,
  DESTINO_ETIQUETAS,
  type Mapeamento,
  MODELOS_PRONTOS,
  validarMapeamento,
} from './mapeamento';
import { mapeamentoDaIntegracao } from './mapeamento-da-integracao';

export { CAMINHO_DO_ENDERECO } from './endereco';

/** Campos comparados na auditoria da edição (R3.1). Segredo e token ficam de fora. */
const CAMPOS_AUDITADOS = [
  'nome',
  'funilId',
  'etapaId',
  'estrategia',
  'responsavelFixoId',
  'modeloMapeamento',
  'mapeamento',
  'etiquetasFixas',
  'ativo',
  'aplicativo',
  'alvo',
  'modo',
  'statusInicial',
  'motivoPerdaPadrao',
] as const satisfies readonly (keyof WebhookEntrada)[];

const DESCRICOES_DOS_DESTINOS: Readonly<Record<string, string>> = {
  nome: 'Nome do contato (obrigatório).',
  email: 'E-mail do contato (gravado em minúsculas).',
  telefone: 'Telefone do contato (E.164, só dígitos; DDD validado).',
  empresa: 'Nome da empresa: vincula à empresa com o mesmo nome ou cria uma.',
  cargo: 'Cargo do contato.',
  titulo: 'Título do negócio (padrão: o nome do contato).',
  valor:
    'Valor do negócio em reais (aceita "1500", "1.500,00", "R$ 1.500,00").',
  valorRecorrente: 'Valor recorrente mensal do negócio, em reais.',
  'utm.source': 'UTM source da origem.',
  'utm.medium': 'UTM medium da origem.',
  'utm.campaign': 'UTM campaign da origem.',
  'utm.term': 'UTM term da origem.',
  'utm.content': 'UTM content da origem.',
  [DESTINO_ETIQUETAS]:
    'Etiquetas do contato (lista ou texto separado por vírgula; somam-se às fixas).',
  etapa:
    'Etapa do negócio: o nome (sem diferenciar maiúsculas e acentos) ou a posição de 1 a n no funil. Valor desconhecido vira aviso.',
  dono: 'Dono do negócio: o e-mail ou o identificador nas integrações de um usuário ativo da área do funil.',
  status:
    'Status do negócio: aberto, ganho ou perdido (também open, won, lost). A perda usa o motivo mapeado ou o padrão da integração (R5.5).',
  motivoPerda: 'Motivo da perda, quando o status for perdido.',
  'negocio.camposPersonalizados.<chave>': 'Campo personalizado do negócio.',
  'camposPersonalizados.<chave>': 'Campo personalizado do contato.',
};

type WebhookCompleto = WebhookEntrada & {
  funil: Funil;
  etapa: Etapa;
  responsavelFixo: { id: string; nome: string } | null;
  criadoPor: { id: string; nome: string } | null;
};

const INCLUIR_NO_WEBHOOK = {
  funil: true,
  etapa: true,
  responsavelFixo: { select: { id: true, nome: true } },
  criadoPor: { select: { id: true, nome: true } },
} as const satisfies Prisma.WebhookEntradaInclude;

/**
 * Pontos de entrada de leads (R8.1–R8.3), só para o Admin (§12): cadastro,
 * token da URL (só o hash fica no banco; o endereço completo aparece ao criar
 * e ao regenerar), segredo HMAC opcional (cifrado, R10.3), mapeamento e a
 * prévia dele sobre um corpo de exemplo.
 *
 * Toda alteração vai numa transação com a auditoria (R3.1).
 */
@Injectable()
export class WebhooksEntradaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditoria: AuditoriaService,
    private readonly cripto: CriptografiaService,
    private readonly aplicativos: AplicativosService,
    @Inject(AMBIENTE) private readonly ambiente: Ambiente,
  ) {}

  // -------------------------------------------------------------------------
  // Consulta
  // -------------------------------------------------------------------------

  async listar(
    filtro: FiltroIntegracoesDto,
  ): Promise<Pagina<WebhookEntradaDto>> {
    const where: Prisma.WebhookEntradaWhereInput = {
      excluidoEm: null,
      ...(filtro.ativo === undefined ? {} : { ativo: filtro.ativo }),
      ...(filtro.aplicativo?.length
        ? { aplicativo: { in: filtro.aplicativo } }
        : {}),
      ...(filtro.funilId ? { funilId: filtro.funilId } : {}),
      ...(filtro.precisaAtencao === undefined
        ? {}
        : { precisaAtencao: filtro.precisaAtencao }),
      ...(filtro.busca
        ? { nome: { contains: filtro.busca, mode: 'insensitive' } }
        : {}),
    };
    const [webhooks, total] = await Promise.all([
      this.prisma.webhookEntrada.findMany({
        where,
        include: INCLUIR_NO_WEBHOOK,
        orderBy: [{ nome: 'asc' }, { id: 'asc' }],
        ...paraSkipTake(filtro),
      }),
      this.prisma.webhookEntrada.count({ where }),
    ]);
    const contagens = await this.contarRecebimentos(
      webhooks.map(({ id }) => id),
    );
    return montarPagina(
      webhooks.map((webhook) => this.paraDto(webhook, contagens)),
      total,
      filtro,
    );
  }

  async detalhar(id: string): Promise<WebhookEntradaDto> {
    const webhook = await this.prisma.webhookEntrada.findFirst({
      where: { id, excluidoEm: null },
      include: INCLUIR_NO_WEBHOOK,
    });
    if (!webhook) {
      throw new NaoEncontradoException('Webhook de entrada não encontrado.');
    }
    return this.paraDto(webhook, await this.contarRecebimentos([id]));
  }

  modelos(): ModelosDeMapeamentoDto {
    return {
      modelos: Object.values(MODELOS_PRONTOS).map((definicao) => ({
        modelo: definicao.modelo,
        nome: definicao.nome,
        descricao: definicao.descricao,
        mapeamento: copiarMapeamento(definicao.mapeamento),
        exemplo: { ...definicao.exemplo },
      })),
      destinos: Object.entries(DESCRICOES_DOS_DESTINOS).map(
        ([destino, descricao]) => ({ destino, descricao }),
      ),
    };
  }

  // -------------------------------------------------------------------------
  // Alteração
  // -------------------------------------------------------------------------

  async criar(
    usuario: UsuarioAutenticado,
    dto: CriarWebhookEntradaDto,
  ): Promise<WebhookEntradaCriadoDto> {
    if (dto.segredo !== undefined && dto.gerarSegredo) {
      throw erroDeCampo('gerarSegredo', 'não combine com `segredo`');
    }
    const aplicativo = dto.aplicativo ?? 'WEBHOOK';
    const adaptador = this.aplicativos.adaptador(aplicativo);
    const definicao = adaptador.definicao;
    const alvo = dto.alvo ?? 'NEGOCIO';
    const modo = dto.modo ?? 'CRIAR_OU_ATUALIZAR';
    const modelo =
      dto.modeloMapeamento ??
      (aplicativo === 'WEBHOOK' ? 'GENERICO' : 'DO_APLICATIVO');
    this.garantirModeloDoAplicativo(aplicativo, modelo);
    const mapeamento = this.mapeamentoParaGravar(
      modelo,
      dto.mapeamento,
      null,
      modo,
    );
    const statusInicial = dto.statusInicial ?? 'ABERTO';
    const motivoPerdaPadrao = dto.motivoPerdaPadrao?.trim() || null;
    if (statusInicial === 'PERDIDO' && !motivoPerdaPadrao) {
      throw erroDeCampo(
        'motivoPerdaPadrao',
        'é obrigatório com o status inicial PERDIDO (a perda exige motivo, R5.5)',
      );
    }
    const token = this.cripto.gerarToken(BYTES_DO_TOKEN);
    const segredo = this.segredoDaCriacao(
      definicao.autenticidade.segredo,
      definicao.nome,
      dto,
    );
    // Typeform por login (R32.25): a credencial é o token pessoal OU a conexão, nunca os dois.
    const usaConexao =
      aplicativo === 'TYPEFORM' &&
      typeof dto.configuracao?.conexaoId === 'string';
    if (usaConexao && dto.credencial !== undefined) {
      throw erroDeCampo(
        'credencial',
        'não combine com `configuracao.conexaoId`: use o token pessoal ou a conexão do Typeform',
      );
    }
    const credencial = usaConexao
      ? null
      : await this.aplicativos.validarCredencial(
          aplicativo,
          dto.credencial,
          null,
          true,
        );
    const configuracao = completarConfiguracaoDeCurso(
      definicao,
      this.aplicativos.validarConfiguracao(
        aplicativo,
        dto.configuracao ?? {},
        {},
      ),
    );
    await this.aplicativos.conferirConfiguracaoNova(aplicativo, configuracao);
    const estrategia = dto.estrategia ?? 'RODIZIO';
    const ativo = dto.ativo ?? true;

    const id = await this.prisma.$transaction(async (tx) => {
      await this.garantirNomeLivre(tx, dto.nome);
      const { funil, etapa } = await this.resolverEntrada(
        tx,
        dto.funilId,
        dto.etapaId,
      );
      if (ativo) {
        garantirFunilAtivo(funil);
      }
      await this.conferirEtapasDosEventos(tx, funil.id, configuracao);
      const responsavelFixoId = await this.resolverResponsavelFixo(
        tx,
        estrategia,
        dto.responsavelFixoId ?? null,
        funil,
      );
      const webhook = await tx.webhookEntrada.create({
        data: {
          nome: dto.nome,
          tokenHash: this.cripto.sha256(token),
          tokenPrefixo: token.slice(0, TAMANHO_DO_PREFIXO_DO_TOKEN),
          tokenCifrado: this.cripto.cifrar(token),
          funilId: funil.id,
          etapaId: etapa.id,
          estrategia,
          responsavelFixoId,
          modeloMapeamento: modelo,
          mapeamento,
          etiquetasFixas: normalizarEtiquetas(dto.etiquetasFixas),
          segredoCifrado: segredo ? this.cripto.cifrar(segredo.valor) : null,
          ativo,
          criadoPorId: usuario.id,
          aplicativo,
          alvo,
          modo,
          statusInicial,
          motivoPerdaPadrao,
          credencialCifrada: this.aplicativos.cifrarCredencial(credencial),
          configuracao: configuracao as Prisma.InputJsonObject,
        },
      });
      await this.auditoria.registrar(tx, {
        acao: 'webhook_entrada.criado',
        entidade: 'webhook_entrada',
        entidadeId: webhook.id,
        resumo: `${definicao.nome === 'Webhook' ? 'Webhook de entrada' : `Integração ${definicao.nome}`} "${webhook.nome}" criada (${funil.nome} / ${etapa.nome})`,
        dados: {
          alteracoes: calcularAlteracoes({}, webhook, CAMPOS_AUDITADOS),
          prefixo: webhook.tokenPrefixo,
          hmac: segredo ? segredo.origem : 'sem',
          credencial: credencial ? Object.keys(credencial) : [],
        },
        relacionados: { funil: funil.id },
      });
      return webhook.id;
    });

    if (this.aplicativos.registraNaFerramenta(aplicativo)) {
      await this.aplicativos.sincronizarComAFerramenta(id);
    }
    return {
      webhook: await this.detalhar(id),
      url: this.endereco(token),
      ...(dto.gerarSegredo && segredo ? { segredo: segredo.valor } : {}),
    };
  }

  async atualizar(
    id: string,
    dto: AtualizarWebhookEntradaDto,
  ): Promise<WebhookEntradaDto> {
    // A credencial é conferida antes da transação (a URL da conta passa pela proteção SSRF).
    const atual = await this.prisma.webhookEntrada.findFirst({
      where: { id, excluidoEm: null },
    });
    if (!atual) {
      throw new NaoEncontradoException('Webhook de entrada não encontrado.');
    }
    // Typeform por login (R32.25): token pessoal OU conexão. Escolher a conexão apaga o token; voltar ao token exige informá-lo.
    const conexaoDepois =
      atual.aplicativo === 'TYPEFORM'
        ? dto.configuracao?.conexaoId !== undefined
          ? dto.configuracao.conexaoId
          : objetoDe(atual.configuracao).conexaoId
        : null;
    if (
      atual.aplicativo === 'TYPEFORM' &&
      conexaoDepois !== null &&
      conexaoDepois !== undefined &&
      dto.credencial !== undefined
    ) {
      throw erroDeCampo(
        'credencial',
        'não combine com a conexão do Typeform: use o token pessoal ou a conexão',
      );
    }
    const trocaParaConexao =
      atual.aplicativo === 'TYPEFORM' &&
      typeof conexaoDepois === 'string' &&
      atual.credencialCifrada !== null;
    if (
      atual.aplicativo === 'TYPEFORM' &&
      dto.configuracao?.conexaoId === null &&
      dto.credencial === undefined &&
      atual.credencialCifrada === null
    ) {
      throw erroDeCampo(
        'credencial',
        'sem a conexão, informe o token pessoal do Typeform',
      );
    }
    const credencial =
      dto.credencial !== undefined
        ? await this.aplicativos.validarCredencial(
            atual.aplicativo,
            dto.credencial,
            this.aplicativos.lerCredencialGuardada(atual),
            true,
          )
        : trocaParaConexao
          ? null
          : undefined;
    if (
      dto.configuracao !== undefined &&
      (atual.aplicativo === 'FACEBOOK_LEAD_ADS' ||
        atual.aplicativo === 'TYPEFORM' ||
        atual.aplicativo === 'RD_STATION')
    ) {
      // A escolha nova (conexão, página, formulário) precisa existir na Meta; falha antes de gravar.
      await this.aplicativos.conferirConfiguracaoNova(
        atual.aplicativo,
        this.aplicativos.validarConfiguracao(
          atual.aplicativo,
          dto.configuracao,
          objetoDe(atual.configuracao),
        ),
      );
    }
    let sincronizarTypeform = false;

    await this.prisma.$transaction(async (tx) => {
      const antes = await this.travarAtivo(tx, id);
      const dados: Prisma.WebhookEntradaUncheckedUpdateInput = {};

      if (dto.nome !== undefined && dto.nome !== antes.nome) {
        await this.garantirNomeLivre(tx, dto.nome, id);
        dados.nome = dto.nome;
      }

      const mudouEntrada =
        (dto.funilId !== undefined && dto.funilId !== antes.funilId) ||
        (dto.etapaId !== undefined && dto.etapaId !== antes.etapaId);
      const { funil, etapa } = mudouEntrada
        ? await this.resolverEntrada(
            tx,
            dto.funilId ?? antes.funilId,
            dto.funilId !== undefined && dto.funilId !== antes.funilId
              ? dto.etapaId
              : (dto.etapaId ?? antes.etapaId),
          )
        : await this.entradaAtual(tx, antes);
      dados.funilId = funil.id;
      dados.etapaId = etapa.id;

      const estrategia = dto.estrategia ?? antes.estrategia;
      const responsavelPedido =
        dto.responsavelFixoId !== undefined
          ? dto.responsavelFixoId
          : estrategia === 'RESPONSAVEL_FIXO'
            ? antes.responsavelFixoId
            : null;
      const revalidar =
        dto.estrategia !== undefined ||
        dto.responsavelFixoId !== undefined ||
        funil.id !== antes.funilId;
      dados.estrategia = estrategia;
      dados.responsavelFixoId = revalidar
        ? await this.resolverResponsavelFixo(
            tx,
            estrategia,
            responsavelPedido,
            funil,
          )
        : antes.responsavelFixoId;

      const modo = dto.modo ?? antes.modo;
      dados.alvo = dto.alvo ?? antes.alvo;
      dados.modo = modo;
      const statusInicial = dto.statusInicial ?? antes.statusInicial;
      const motivoPerdaPadrao =
        dto.motivoPerdaPadrao !== undefined
          ? dto.motivoPerdaPadrao?.trim() || null
          : antes.motivoPerdaPadrao;
      if (statusInicial === 'PERDIDO' && !motivoPerdaPadrao) {
        throw erroDeCampo(
          'motivoPerdaPadrao',
          'é obrigatório com o status inicial PERDIDO (a perda exige motivo, R5.5)',
        );
      }
      dados.statusInicial = statusInicial;
      dados.motivoPerdaPadrao = motivoPerdaPadrao;

      if (dto.modeloMapeamento !== undefined || dto.mapeamento !== undefined) {
        const modelo =
          dto.modeloMapeamento ??
          (dto.mapeamento !== undefined
            ? 'PERSONALIZADO'
            : antes.modeloMapeamento);
        this.garantirModeloDoAplicativo(antes.aplicativo, modelo);
        dados.modeloMapeamento = modelo;
        dados.mapeamento = this.mapeamentoParaGravar(
          modelo,
          dto.mapeamento,
          antes,
          modo,
        );
      } else if (
        antes.modeloMapeamento === 'PERSONALIZADO' &&
        dto.modo !== undefined
      ) {
        // Mudar o modo muda a exigência do nome: o mapeamento salvo precisa continuar valendo.
        this.validarOuFalhar(
          mapeamentoDaIntegracao(antes),
          modo !== 'ATUALIZAR',
        );
      }
      if (dto.etiquetasFixas !== undefined) {
        dados.etiquetasFixas = normalizarEtiquetas(dto.etiquetasFixas);
      }
      if (credencial !== undefined) {
        dados.credencialCifrada = this.aplicativos.cifrarCredencial(credencial);
        // Credencial nova: a situação "precisa de atenção" recomeça.
        dados.precisaAtencao = false;
        dados.atencaoMotivo = null;
        dados.atencaoEm = null;
      }
      if (dto.configuracao !== undefined) {
        dados.configuracao = this.aplicativos.validarConfiguracao(
          antes.aplicativo,
          dto.configuracao,
          objetoDe(antes.configuracao),
        ) as Prisma.InputJsonObject;
      }
      // Plataformas de curso: as etapas escolhidas na tabela de eventos são do funil da integração.
      if (
        adaptadorDe(antes.aplicativo)?.definicao.eventos &&
        (dto.configuracao?.eventos !== undefined || funil.id !== antes.funilId)
      ) {
        const vigente = objetoDe(dados.configuracao ?? antes.configuracao);
        const configuracaoDoFunil =
          dto.configuracao?.eventos === undefined && funil.id !== antes.funilId
            ? semEtapasDosEventos(vigente)
            : vigente;
        dados.configuracao = configuracaoDoFunil as Prisma.InputJsonObject;
        await this.conferirEtapasDosEventos(tx, funil.id, configuracaoDoFunil);
      }
      const ativo = dto.ativo ?? antes.ativo;
      if (ativo && (dto.ativo === true || mudouEntrada)) {
        garantirFunilAtivo(funil);
      }
      dados.ativo = ativo;

      const depois = await tx.webhookEntrada.update({
        where: { id },
        data: dados,
      });
      sincronizarTypeform =
        (antes.aplicativo === 'TYPEFORM' &&
          (depois.ativo !== antes.ativo ||
            credencial !== undefined ||
            JSON.stringify(objetoDe(depois.configuracao).formularioId) !==
              JSON.stringify(objetoDe(antes.configuracao).formularioId) ||
            JSON.stringify(objetoDe(depois.configuracao).conexaoId) !==
              JSON.stringify(objetoDe(antes.configuracao).conexaoId))) ||
        (antes.aplicativo === 'RD_STATION' &&
          (depois.ativo !== antes.ativo ||
            [
              'conexaoId',
              'gatilho',
              'conversoes',
              'cabecalhoDeAutenticacao',
            ].some(
              (chave) =>
                JSON.stringify(objetoDe(depois.configuracao)[chave]) !==
                JSON.stringify(objetoDe(antes.configuracao)[chave]),
            ))) ||
        (antes.aplicativo === 'FACEBOOK_LEAD_ADS' &&
          (depois.ativo !== antes.ativo ||
            ['conexaoId', 'paginaId', 'formularioId'].some(
              (chave) =>
                JSON.stringify(objetoDe(depois.configuracao)[chave]) !==
                JSON.stringify(objetoDe(antes.configuracao)[chave]),
            )));
      const alteracoes = calcularAlteracoes(antes, depois, CAMPOS_AUDITADOS);
      if (credencial !== undefined) {
        // Só os nomes dos campos: nunca o valor da credencial.
        alteracoes.credencial = {
          antes: antes.credencialCifrada ? 'configurada' : 'sem',
          depois: credencial === null ? 'removida' : 'trocada',
        };
      }
      if (
        dto.configuracao !== undefined &&
        JSON.stringify(objetoDe(depois.configuracao).formularioId) !==
          JSON.stringify(objetoDe(antes.configuracao).formularioId)
      ) {
        alteracoes.formularioId = {
          antes: textoOuNulo(objetoDe(antes.configuracao).formularioId),
          depois: textoOuNulo(objetoDe(depois.configuracao).formularioId),
        };
      }
      if (Object.keys(alteracoes).length > 0) {
        await this.auditoria.registrar(tx, {
          acao: 'webhook_entrada.atualizado',
          entidade: 'webhook_entrada',
          entidadeId: id,
          resumo: resumoDaEdicao(depois.nome, antes, depois),
          dados: { alteracoes },
          relacionados: { funil: depois.funilId },
        });
      }
    });
    if (sincronizarTypeform) {
      await this.aplicativos.sincronizarComAFerramenta(id);
    }
    return this.detalhar(id);
  }

  /** Exclusão lógica: o endereço passa a responder 404; os recebimentos ficam (R8.6). O webhook do Typeform é removido. */
  async excluir(id: string): Promise<void> {
    const webhook = await this.prisma.$transaction(async (tx) => {
      const antes = await this.travarAtivo(tx, id);
      await tx.webhookEntrada.update({
        where: { id },
        data: { excluidoEm: new Date(), ativo: false },
      });
      await this.auditoria.registrar(tx, {
        acao: 'webhook_entrada.excluido',
        entidade: 'webhook_entrada',
        entidadeId: id,
        resumo: `Webhook de entrada "${antes.nome}" excluído`,
        dados: { prefixo: antes.tokenPrefixo },
        relacionados: { funil: antes.funilId },
      });
      return antes;
    });
    await this.aplicativos.removerDaFerramenta(webhook);
  }

  /** Token novo (R8.2): o endereço antigo para de funcionar na hora (e o webhook do Typeform é registrado de novo). */
  async regenerarToken(id: string): Promise<TokenRegeneradoDto> {
    const token = this.cripto.gerarToken(BYTES_DO_TOKEN);
    let aplicativo = 'WEBHOOK' as AplicativoIntegracao;
    await this.prisma.$transaction(async (tx) => {
      const webhook = await this.travarAtivo(tx, id);
      aplicativo = webhook.aplicativo;
      const prefixoNovo = token.slice(0, TAMANHO_DO_PREFIXO_DO_TOKEN);
      await tx.webhookEntrada.update({
        where: { id },
        data: {
          tokenHash: this.cripto.sha256(token),
          tokenPrefixo: prefixoNovo,
          tokenCifrado: this.cripto.cifrar(token),
        },
      });
      await this.auditoria.registrar(tx, {
        acao: 'webhook_entrada.token_regenerado',
        entidade: 'webhook_entrada',
        entidadeId: id,
        resumo: `Endereço do webhook de entrada "${webhook.nome}" regenerado (o anterior deixou de valer)`,
        dados: { prefixoAnterior: webhook.tokenPrefixo, prefixoNovo },
        relacionados: { funil: webhook.funilId },
      });
    });
    if (aplicativo === 'TYPEFORM') {
      await this.aplicativos.sincronizarWebhookDoTypeform(id);
    } else if (aplicativo === 'RD_STATION') {
      // O endereço novo precisa ir para o webhook que o CRM criou no RD (R32.26).
      await this.aplicativos.sincronizarComAFerramenta(id);
    }
    return { webhook: await this.detalhar(id), url: this.endereco(token) };
  }

  /** O endereço completo, para reabrir o assistente (R32.1). Só nas integrações com o token guardado cifrado. */
  async enderecoCompleto(id: string): Promise<EnderecoDaIntegracaoDto> {
    const webhook = await this.prisma.webhookEntrada.findFirst({
      where: { id, excluidoEm: null },
    });
    if (!webhook) {
      throw new NaoEncontradoException('Webhook de entrada não encontrado.');
    }
    const token = this.aplicativos.lerToken(webhook);
    if (!token) {
      throw new RegraVioladaException(
        'R32.1',
        'O endereço completo desta integração não pode ser mostrado de novo (criada antes da Onda H): regenere o token para obter um endereço novo.',
      );
    }
    return { url: this.endereco(token) };
  }

  /** Define (ou gera) o segredo (R8.3), cifrado no banco (R10.3). Não vale para os aplicativos que não usam segredo. */
  async definirSegredo(
    id: string,
    dto: DefinirSegredoEntradaDto,
  ): Promise<SegredoDefinidoDto> {
    const gerado = dto.segredo === undefined;
    const segredo = dto.segredo ?? this.cripto.gerarToken(BYTES_DO_SEGREDO);
    let aplicativo = 'WEBHOOK' as AplicativoIntegracao;
    await this.prisma.$transaction(async (tx) => {
      const webhook = await this.travarAtivo(tx, id);
      aplicativo = webhook.aplicativo;
      const modoDoSegredo = definicaoDe(webhook.aplicativo)?.autenticidade
        .segredo;
      if (modoDoSegredo === 'NAO_USA') {
        throw new RegraVioladaException(
          'R32.2',
          `O aplicativo ${definicaoDe(webhook.aplicativo)?.nome ?? webhook.aplicativo} não usa segredo.`,
        );
      }
      if (modoDoSegredo === 'GERADO_PELO_CRM' && !gerado) {
        throw erroDeCampo(
          'segredo',
          'o segredo deste aplicativo é gerado pelo CRM e registrado nele; envie o corpo vazio para gerar um novo',
        );
      }
      await tx.webhookEntrada.update({
        where: { id },
        data: { segredoCifrado: this.cripto.cifrar(segredo) },
      });
      await this.auditoria.registrar(tx, {
        acao: 'webhook_entrada.segredo_definido',
        entidade: 'webhook_entrada',
        entidadeId: id,
        resumo: `Segredo HMAC do webhook de entrada "${webhook.nome}" ${webhook.segredoCifrado ? 'trocado' : 'definido'}: as chamadas passam a exigir X-Assinatura`,
        dados: { hmac: gerado ? 'gerado' : 'informado' },
        relacionados: { funil: webhook.funilId },
      });
    });
    if (aplicativo === 'TYPEFORM') {
      // O segredo novo precisa ir para o webhook do formulário.
      await this.aplicativos.sincronizarWebhookDoTypeform(id);
    } else if (aplicativo === 'RD_STATION') {
      // A chave nova vira o cabeçalho do webhook criado no RD (R32.26).
      await this.aplicativos.sincronizarComAFerramenta(id);
    }
    return {
      webhook: await this.detalhar(id),
      ...(gerado && aplicativo !== 'TYPEFORM' ? { segredo } : {}),
    };
  }

  async removerSegredo(id: string): Promise<WebhookEntradaDto> {
    let sincronizarRd = false;
    await this.prisma.$transaction(async (tx) => {
      const webhook = await this.travarAtivo(tx, id);
      if (!webhook.segredoCifrado) {
        return;
      }
      sincronizarRd = webhook.aplicativo === 'RD_STATION';
      if (
        definicaoDe(webhook.aplicativo)?.autenticidade.segredo ===
        'GERADO_PELO_CRM'
      ) {
        throw new RegraVioladaException(
          'R32.2',
          'O segredo deste aplicativo é obrigatório (o Typeform assina todo envio): gere um novo em vez de remover.',
        );
      }
      await tx.webhookEntrada.update({
        where: { id },
        data: { segredoCifrado: null },
      });
      await this.auditoria.registrar(tx, {
        acao: 'webhook_entrada.segredo_removido',
        entidade: 'webhook_entrada',
        entidadeId: id,
        resumo: `Segredo HMAC do webhook de entrada "${webhook.nome}" removido: as chamadas deixam de exigir assinatura`,
        relacionados: { funil: webhook.funilId },
      });
    });
    if (sincronizarRd) {
      // O webhook criado no RD deixa de levar o cabeçalho de autenticação (R32.26).
      await this.aplicativos.sincronizarComAFerramenta(id);
    }
    return this.detalhar(id);
  }

  // -------------------------------------------------------------------------
  // Prévia do mapeamento
  // -------------------------------------------------------------------------

  /** Aplica uma configuração (ainda não salva) a um corpo de exemplo, sem gravar nada. */
  previa(dto: PreviaDeMapeamentoDto): ResultadoDaPreviaDto {
    const aplicativo = dto.aplicativo ?? 'WEBHOOK';
    const modo = dto.modo ?? 'CRIAR_OU_ATUALIZAR';
    const modelo =
      dto.modeloMapeamento ??
      (aplicativo === 'WEBHOOK' ? 'GENERICO' : 'DO_APLICATIVO');
    if (modelo !== 'PERSONALIZADO' && dto.mapeamento !== undefined) {
      throw erroDeCampo(
        'mapeamento',
        'só vale com modeloMapeamento PERSONALIZADO',
      );
    }
    this.garantirModeloDoAplicativo(aplicativo, modelo);
    const mapeamento =
      modelo === 'PERSONALIZADO'
        ? this.validarOuFalhar(dto.mapeamento, modo !== 'ATUALIZAR')
        : mapeamentoDaIntegracao({
            modeloMapeamento: modelo,
            mapeamento: null,
            aplicativo,
          });
    return montarPrevia(
      aplicativo,
      mapeamento,
      dto.exemplo,
      normalizarEtiquetas(dto.etiquetasFixas),
      modo,
    );
  }

  /** A prévia com a configuração salva do ponto, sobre um exemplo ou um recebimento dele. */
  async previaDoWebhook(
    id: string,
    dto: PreviaDoWebhookDto,
  ): Promise<ResultadoDaPreviaDto> {
    if ((dto.exemplo === undefined) === (dto.recebimentoId === undefined)) {
      throw new DadosInvalidosException(
        'Informe `exemplo` ou `recebimentoId` (um dos dois).',
        {
          campos: [
            {
              campo: 'exemplo',
              mensagens: ['informe exemplo ou recebimentoId'],
            },
          ],
        },
      );
    }
    const webhook = await this.prisma.webhookEntrada.findFirst({
      where: { id, excluidoEm: null },
    });
    if (!webhook) {
      throw new NaoEncontradoException('Webhook de entrada não encontrado.');
    }
    let corpo: unknown = dto.exemplo;
    if (dto.recebimentoId) {
      const recebimento = await this.prisma.webhookRecebimento.findFirst({
        where: { id: dto.recebimentoId, webhookId: id },
        select: { corpo: true },
      });
      if (!recebimento) {
        throw new NaoEncontradoException('Recebimento não encontrado.');
      }
      if (recebimento.corpo === null) {
        throw new RegraVioladaException(
          'R8.6',
          'Este recebimento não tem o corpo guardado (grande demais, tipo não suportado ou apagado na anonimização).',
        );
      }
      corpo = recebimento.corpo;
    }
    return montarPrevia(
      webhook.aplicativo,
      mapeamentoDaIntegracao(webhook),
      corpo,
      webhook.etiquetasFixas,
      webhook.modo,
    );
  }

  // -------------------------------------------------------------------------
  // Apoio
  // -------------------------------------------------------------------------

  /** Endereço completo (R8.2): `URL_PUBLICA/api/v1/webhooks/entrada/<token>`. */
  endereco(token: string): string {
    return montarEndereco(this.ambiente.urlPublica, token);
  }

  private paraDto(
    webhook: WebhookCompleto,
    contagens: ReadonlyMap<string, { total: number; erros: number }>,
  ): WebhookEntradaDto {
    return {
      id: webhook.id,
      nome: webhook.nome,
      tokenPrefixo: webhook.tokenPrefixo,
      enderecoMascarado: `${this.endereco(webhook.tokenPrefixo)}…`,
      funil: FunilDoWebhookDto.de(webhook.funil),
      etapa: EtapaDoWebhookDto.de(webhook.etapa),
      estrategia: webhook.estrategia,
      responsavelFixo: UsuarioDoWebhookDto.de(webhook.responsavelFixo),
      modeloMapeamento: webhook.modeloMapeamento,
      mapeamento: copiarMapeamento(mapeamentoDaIntegracao(webhook)),
      etiquetasFixas: webhook.etiquetasFixas,
      exigeAssinatura: webhook.segredoCifrado !== null,
      segredoMascarado: this.mascararSegredo(webhook.segredoCifrado),
      aplicativo: webhook.aplicativo,
      aplicativoNome:
        definicaoDe(webhook.aplicativo)?.nome ?? webhook.aplicativo,
      alvo: webhook.alvo,
      modo: webhook.modo,
      statusInicial: webhook.statusInicial,
      motivoPerdaPadrao: webhook.motivoPerdaPadrao,
      credencial: this.credencialMascarada(webhook),
      configuracao: configuracaoPublica(webhook.configuracao),
      camposBuscados: camposBuscadosDe(webhook.configuracao),
      camposBuscadosEm: textoOuNulo(
        objetoDe(webhook.configuracao).camposBuscadosEm,
      ),
      situacao: !webhook.ativo
        ? 'INATIVA'
        : webhook.precisaAtencao
          ? 'PRECISA_ATENCAO'
          : 'ATIVA',
      precisaAtencao: webhook.precisaAtencao,
      atencaoMotivo: webhook.atencaoMotivo,
      atencaoEm: webhook.atencaoEm?.toISOString() ?? null,
      enderecoDisponivel: webhook.tokenCifrado !== null,
      ativo: webhook.ativo,
      ultimoRecebimentoEm: webhook.ultimoRecebimentoEm?.toISOString() ?? null,
      recebimentos24h: contagens.get(webhook.id) ?? { total: 0, erros: 0 },
      criadoPor: UsuarioDoWebhookDto.de(webhook.criadoPor),
      criadoEm: webhook.criadoEm.toISOString(),
      atualizadoEm: webhook.atualizadoEm.toISOString(),
    };
  }

  /** A credencial para a tela: segredos mascarados (R10.3), o resto como está. */
  private credencialMascarada(
    webhook: WebhookEntrada,
  ): CredencialDaIntegracaoDto {
    const campos = definicaoDe(webhook.aplicativo)?.credencial ?? [];
    const credencial: Credencial | null =
      this.aplicativos.lerCredencialGuardada(webhook);
    return {
      configurada: webhook.credencialCifrada !== null,
      campos: campos.map((campo) => {
        const valor = credencial?.[campo.chave];
        return {
          chave: campo.chave,
          rotulo: campo.rotulo,
          secreto: campo.secreto,
          valor:
            valor === undefined
              ? webhook.credencialCifrada !== null && credencial === null
                ? '••••••••'
                : null
              : campo.secreto
                ? this.cripto.mascarar(valor)
                : valor,
        };
      }),
    };
  }

  /** O catálogo para o assistente (R32.1). */
  catalogo(): CatalogoDeAplicativosDto {
    return {
      aplicativos: catalogoDeAplicativos().map((definicao): AplicativoDto => ({
        ...definicao,
        login: definicao.login ?? null,
        credencial: definicao.credencial
          ? definicao.credencial.map((campo) => ({ ...campo }))
          : null,
        passoAPasso: {
          titulo: definicao.passoAPasso.titulo,
          passos: [...definicao.passoAPasso.passos],
        },
        modelo: definicao.modelo
          ? {
              nome: definicao.modelo.nome,
              descricao: definicao.modelo.descricao,
              mapeamento: copiarMapeamento(definicao.modelo.mapeamento),
              exemplo: { ...definicao.modelo.exemplo },
            }
          : null,
        dicas: [...definicao.dicas],
        eventos: definicao.eventos
          ? {
              eventos: definicao.eventos.eventos.map((e) => ({
                ...e,
                padrao: copiarRegra(e.padrao),
              })),
              modelos: definicao.eventos.modelos.map((m) => ({
                ...m,
                regras: Object.fromEntries(
                  Object.entries(m.regras).map(([codigo, regra]) => [
                    codigo,
                    copiarRegra(regra),
                  ]),
                ),
              })),
              filtroPorProduto: definicao.eventos.filtroPorProduto,
            }
          : null,
        tiposDeConteudo: [...definicao.tiposDeConteudo],
        autenticidade: { ...definicao.autenticidade },
      })),
      destinos: Object.entries(DESCRICOES_DOS_DESTINOS).map(
        ([destino, descricao]) => ({ destino, descricao }),
      ),
    };
  }

  /** O modelo pronto (WEBHOOK) ou o do aplicativo (`DO_APLICATIVO`) só vale no aplicativo certo. */
  private garantirModeloDoAplicativo(
    aplicativo: AplicativoIntegracao,
    modelo: ModeloMapeamento,
  ): void {
    if (modelo === 'DO_APLICATIVO') {
      if (
        !adaptadorDe(aplicativo)?.definicao.modelo ||
        aplicativo === 'WEBHOOK'
      ) {
        throw erroDeCampo(
          'modeloMapeamento',
          'DO_APLICATIVO só vale nos aplicativos com modelo pronto (o Webhook usa GENERICO ou DISPAROS_BRL)',
        );
      }
      return;
    }
    if (modelo !== 'PERSONALIZADO' && aplicativo !== 'WEBHOOK') {
      throw erroDeCampo(
        'modeloMapeamento',
        `${modelo} só vale no aplicativo Webhook: use DO_APLICATIVO ou PERSONALIZADO`,
      );
    }
  }

  /** O segredo da criação, conforme o aplicativo (R32.2): informado, gerado a pedido, gerado pelo CRM ou proibido. */
  private segredoDaCriacao(
    modo: 'NAO_USA' | 'OPCIONAL' | 'GERADO_PELO_CRM' | 'OBRIGATORIO',
    nomeDoAplicativo: string,
    dto: CriarWebhookEntradaDto,
  ): { valor: string; origem: 'gerado' | 'informado' } | null {
    const pediu = dto.segredo !== undefined || dto.gerarSegredo === true;
    if (modo === 'NAO_USA') {
      if (pediu) {
        throw erroDeCampo(
          dto.segredo !== undefined ? 'segredo' : 'gerarSegredo',
          `o aplicativo ${nomeDoAplicativo} não usa segredo`,
        );
      }
      return null;
    }
    if (modo === 'GERADO_PELO_CRM') {
      if (dto.segredo !== undefined) {
        throw erroDeCampo(
          'segredo',
          `o segredo do ${nomeDoAplicativo} é gerado pelo CRM e registrado nele`,
        );
      }
      return {
        valor: this.cripto.gerarToken(BYTES_DO_SEGREDO),
        origem: 'gerado',
      };
    }
    if (dto.gerarSegredo) {
      return {
        valor: this.cripto.gerarToken(BYTES_DO_SEGREDO),
        origem: 'gerado',
      };
    }
    return dto.segredo !== undefined
      ? { valor: dto.segredo, origem: 'informado' }
      : null;
  }

  private mascararSegredo(cifrado: string | null): string | null {
    if (!cifrado) {
      return null;
    }
    try {
      return this.cripto.mascarar(this.cripto.decifrar(cifrado));
    } catch {
      // Chave de criptografia trocada: o segredo não pode ser lido.
      return '••••••••';
    }
  }

  private async contarRecebimentos(
    ids: readonly string[],
  ): Promise<Map<string, { total: number; erros: number }>> {
    const contagens = new Map<string, { total: number; erros: number }>();
    if (ids.length === 0) {
      return contagens;
    }
    const grupos = await this.prisma.webhookRecebimento.groupBy({
      by: ['webhookId', 'status'],
      where: {
        webhookId: { in: [...ids] },
        recebidoEm: { gte: new Date(Date.now() - 24 * 3_600_000) },
      },
      _count: { _all: true },
    });
    for (const grupo of grupos) {
      const atual = contagens.get(grupo.webhookId) ?? { total: 0, erros: 0 };
      atual.total += grupo._count._all;
      if (grupo.status === 'ERRO') {
        atual.erros += grupo._count._all;
      }
      contagens.set(grupo.webhookId, atual);
    }
    return contagens;
  }

  /** Trava a linha do ponto (não excluído) até o fim da transação; 404 se não existir. */
  private async travarAtivo(tx: Tx, id: string): Promise<WebhookEntrada> {
    const [linha] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM webhooks_entrada
       WHERE id = ${id}::uuid AND excluido_em IS NULL
         FOR UPDATE`;
    if (!linha) {
      throw new NaoEncontradoException('Webhook de entrada não encontrado.');
    }
    return tx.webhookEntrada.findUniqueOrThrow({ where: { id } });
  }

  /** Nome único entre os pontos não excluídos (sem diferenciar maiúsculas). */
  private async garantirNomeLivre(
    tx: Tx,
    nome: string,
    exceto?: string,
  ): Promise<void> {
    await travarChave(tx, TRAVA_NOME_ENTRADA, nome.toLocaleLowerCase('pt-BR'));
    const outro = await tx.webhookEntrada.findFirst({
      where: {
        nome: { equals: nome, mode: 'insensitive' },
        excluidoEm: null,
        ...(exceto ? { NOT: { id: exceto } } : {}),
      },
      select: { id: true },
    });
    if (outro) {
      throw new ConflitoException(
        'Já existe um webhook de entrada com esse nome.',
        { campos: ['nome'], webhookId: outro.id },
      );
    }
  }

  /**
   * Funil e etapa de entrada (R8.1): padrão Marketing / Novo lead; num funil
   * escolhido sem etapa, a primeira etapa aberta. A etapa precisa ser do
   * funil (R5.4) e não pode ser a de perda (R5.5, que exige motivo).
   */
  /** Plataformas de curso: a etapa de um evento `ABRIR` existe no funil da integração e é aberta. */
  private async conferirEtapasDosEventos(
    tx: Tx,
    funilId: string,
    configuracao: Record<string, unknown>,
  ): Promise<void> {
    const ids = etapasDosEventos(configuracao);
    if (ids.length === 0) {
      return;
    }
    const etapas = await tx.etapa.findMany({
      where: { id: { in: ids }, funilId },
      select: { id: true, tipo: true },
    });
    for (const id of ids) {
      const etapa = etapas.find((candidata) => candidata.id === id);
      if (!etapa) {
        throw erroDeCampo(
          'configuracao.eventos',
          `a etapa ${id} não pertence ao funil da integração`,
        );
      }
      if (etapa.tipo !== 'ABERTA') {
        throw erroDeCampo(
          'configuracao.eventos',
          'a etapa de um evento "abrir negócio" deve ser uma etapa aberta (não a de ganho nem a de perda)',
        );
      }
    }
  }

  private async resolverEntrada(
    tx: Tx,
    funilId: string | undefined,
    etapaId: string | undefined,
  ): Promise<{ funil: Funil; etapa: Etapa }> {
    const funil = funilId
      ? await tx.funil.findFirst({ where: { id: funilId, excluidoEm: null } })
      : await tx.funil.findFirst({
          where: { area: 'MARKETING', base: true, excluidoEm: null },
        });
    if (!funil) {
      throw new RegraVioladaException(
        'R8.1',
        funilId
          ? 'O funil de entrada não existe ou foi excluído.'
          : 'O funil-base de Marketing não foi encontrado: informe o funil de entrada.',
        { funilId: funilId ?? null },
      );
    }
    let etapa: Etapa | null;
    if (etapaId) {
      etapa = await tx.etapa.findFirst({
        where: { id: etapaId, funilId: funil.id },
      });
      if (!etapa) {
        throw new RegraVioladaException(
          'R5.4',
          `A etapa de entrada não pertence ao funil ${funil.nome}.`,
          { funilId: funil.id, etapaId },
        );
      }
    } else {
      etapa =
        (funil.base && funil.area === 'MARKETING'
          ? await tx.etapa.findFirst({
              where: { funilId: funil.id, chave: 'novo_lead' },
            })
          : null) ??
        (await tx.etapa.findFirst({
          where: { funilId: funil.id, tipo: 'ABERTA' },
          orderBy: [{ ordem: 'asc' }, { id: 'asc' }],
        }));
      if (!etapa) {
        throw new RegraVioladaException(
          'R5.2',
          `O funil ${funil.nome} não tem etapa aberta para receber leads.`,
          { funilId: funil.id },
        );
      }
    }
    if (etapa.tipo === 'PERDIDO') {
      throw new RegraVioladaException(
        'R5.5',
        'A etapa de entrada não pode ser a de perda (ela exige motivo).',
        { etapaId: etapa.id },
      );
    }
    return { funil, etapa };
  }

  private async entradaAtual(
    tx: Tx,
    webhook: WebhookEntrada,
  ): Promise<{ funil: Funil; etapa: Etapa }> {
    const funil = await tx.funil.findUniqueOrThrow({
      where: { id: webhook.funilId },
    });
    const etapa = await tx.etapa.findUniqueOrThrow({
      where: { id: webhook.etapaId },
    });
    return { funil, etapa };
  }

  /**
   * Responsável fixo (R8.1, R5.8): só com `RESPONSAVEL_FIXO`, e precisa ser um
   * usuário ativo que pode ser responsável no funil (da área, C-level ou Admin).
   */
  private async resolverResponsavelFixo(
    tx: Tx,
    estrategia: EstrategiaDistribuicao,
    responsavelFixoId: string | null,
    funil: Funil,
  ): Promise<string | null> {
    if (estrategia !== 'RESPONSAVEL_FIXO') {
      if (responsavelFixoId) {
        throw erroDeCampo(
          'responsavelFixoId',
          'só vale com a distribuição RESPONSAVEL_FIXO',
        );
      }
      return null;
    }
    if (!responsavelFixoId) {
      throw erroDeCampo(
        'responsavelFixoId',
        'é obrigatório com a distribuição RESPONSAVEL_FIXO',
      );
    }
    const usuario = await tx.usuario.findUnique({
      where: { id: responsavelFixoId },
      select: { id: true, ativo: true, papel: true, area: true },
    });
    if (!usuario?.ativo) {
      throw new RegraVioladaException(
        'R8.1',
        'O responsável fixo precisa ser um usuário ativo.',
        { responsavelFixoId },
      );
    }
    if (!(await podeSerResponsavelNoFunil(tx, funil, usuario))) {
      throw new RegraVioladaException(
        'R8.1',
        `O responsável fixo precisa atuar no funil ${funil.nome}: ser de ${rotuloDaArea(funil.area)} (no funil restrito, líder ou da lista), ter acesso como membro ou gestor, ou ser C-level/Admin (R5.13).`,
        { responsavelFixoId, area: funil.area },
      );
    }
    return usuario.id;
  }

  /**
   * O que vai para a coluna `mapeamento`: `{}` nos modelos prontos (o mapeamento
   * vem do código); no `PERSONALIZADO`, o enviado (validado) ou — numa edição
   * que só troca o modelo — o que valia antes, como ponto de partida.
   */
  private mapeamentoParaGravar(
    modelo: ModeloMapeamento,
    enviado: Record<string, unknown> | undefined,
    antes: WebhookEntrada | null,
    modo: ModoIntegracao,
  ): Prisma.InputJsonObject {
    if (modelo !== 'PERSONALIZADO') {
      if (enviado !== undefined) {
        throw erroDeCampo(
          'mapeamento',
          'só vale com modeloMapeamento PERSONALIZADO',
        );
      }
      return {};
    }
    const exigirNome = modo !== 'ATUALIZAR';
    if (enviado !== undefined) {
      return paraJson(this.validarOuFalhar(enviado, exigirNome));
    }
    if (!antes) {
      throw erroDeCampo(
        'mapeamento',
        'é obrigatório com o modelo PERSONALIZADO',
      );
    }
    return paraJson(
      this.validarOuFalhar(mapeamentoDaIntegracao(antes), exigirNome),
    );
  }

  private validarOuFalhar(entrada: unknown, exigirNome = true): Mapeamento {
    const resultado = validarMapeamento(entrada, 'mapeamento', { exigirNome });
    if (!resultado.valido) {
      throw new DadosInvalidosException(resumirProblemas(resultado.problemas), {
        regra: 'R8.1',
        campos: resultado.problemas,
      });
    }
    return resultado.mapeamento;
  }
}

function montarPrevia(
  aplicativo: AplicativoIntegracao,
  mapeamento: Mapeamento,
  corpo: unknown,
  etiquetasFixas: readonly string[],
  modo: ModoIntegracao,
): ResultadoDaPreviaDto {
  const itens = adaptadorDe(aplicativo)?.normalizarCorpo(corpo) ?? [
    { corpo, rotulo: null },
  ];
  const lead = aplicarMapeamento(
    mapeamento,
    itens[0]?.corpo ?? {},
    etiquetasFixas,
    {
      exigirNome: modo !== 'ATUALIZAR',
    },
  );
  return {
    valido: lead.ignorado === null && lead.problemas.length === 0,
    ignorado: lead.ignorado,
    problemas: [...lead.problemas],
    avisos: [...lead.avisos],
    contato: {
      ...lead.contato,
      etiquetas: lead.etiquetas,
      camposPersonalizados: lead.camposPersonalizados,
    },
    negocio: { ...lead.negocio },
    utm: lead.utm,
    encontrados: lead.encontrados.map((campo) => ({ ...campo })),
    atualizacoes: { ...lead.atualizacoes },
    camposDoNegocio: lead.camposDoNegocio,
    itens: itens.length,
  };
}

function copiarRegra(regra: RegraDoEvento): RegraDoEventoDto {
  return {
    acao: regra.acao,
    etapaId: regra.etapaId ?? null,
    motivoPerda: regra.motivoPerda ?? null,
    etiquetas: [...regra.etiquetas],
  };
}

/** `configuracao` para a tela, sem a lista de campos buscados (que vem à parte). */
function configuracaoPublica(valor: Prisma.JsonValue): Record<string, unknown> {
  const {
    camposBuscados: _campos,
    camposBuscadosEm: _em,
    ...resto
  } = objetoDe(valor);
  return resto;
}

function camposBuscadosDe(valor: Prisma.JsonValue): CampoBuscado[] | null {
  const lista = objetoDe(valor).camposBuscados;
  if (!Array.isArray(lista)) {
    return null;
  }
  return lista.flatMap((campo) => {
    const c = objetoDe(campo);
    return typeof c.caminho === 'string' && typeof c.rotulo === 'string'
      ? [
          {
            caminho: c.caminho,
            rotulo: c.rotulo,
            tipo: typeof c.tipo === 'string' ? c.tipo : null,
          },
        ]
      : [];
  });
}

function textoOuNulo(valor: unknown): string | null {
  return typeof valor === 'string' ? valor : null;
}

function garantirFunilAtivo(funil: Funil): void {
  if (!funil.ativo) {
    throw new RegraVioladaException(
      'R5.1',
      `O funil ${funil.nome} está arquivado e não recebe negócios: reative-o ou escolha outro.`,
      { funilId: funil.id },
    );
  }
}

function copiarMapeamento(mapeamento: Mapeamento) {
  return {
    campos: mapeamento.campos.map((regra) => ({ ...regra })),
    ignorarQuando: mapeamento.ignorarQuando.map((condicao) => ({
      ...condicao,
    })),
  };
}

function paraJson(mapeamento: Mapeamento): Prisma.InputJsonObject {
  return copiarMapeamento(mapeamento) as unknown as Prisma.InputJsonObject;
}

function erroDeCampo(campo: string, mensagem: string): DadosInvalidosException {
  const campos: ProblemaDeCampo[] = [{ campo, mensagens: [mensagem] }];
  return new DadosInvalidosException(resumirProblemas(campos), { campos });
}

function resumoDaEdicao(
  nome: string,
  antes: WebhookEntrada,
  depois: WebhookEntrada,
): string {
  if (antes.ativo !== depois.ativo) {
    return `Webhook de entrada "${nome}" ${depois.ativo ? 'reativado' : 'desativado'}`;
  }
  return `Webhook de entrada "${nome}" alterado`;
}
