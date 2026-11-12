import { Inject, Injectable } from '@nestjs/common';
import { AuditoriaService } from '../../auditoria/auditoria.service';
import { PREFIXO_DAS_ROTAS, VERSAO_PADRAO_DA_API } from '../../aplicacao';
import type { UsuarioAutenticado } from '../../auth/usuario-autenticado';
import { executarComoAtor } from '../../comum/contexto/contexto-requisicao';
import { CriptografiaService } from '../../comum/criptografia/criptografia.service';
import {
  ConflitoException,
  DadosInvalidosException,
  NaoEncontradoException,
  RegraVioladaException,
} from '../../comum/erros/excecoes';
import { resumirProblemas } from '../../comum/validacao/validacao';
import { AMBIENTE, type Ambiente } from '../../config/ambiente';
import type { ConexaoFacebook } from '../../generated/prisma/client';
import { LogsTecnicosService } from '../../logs/logs-tecnicos.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AplicativosService, objetoDe } from '../entrada/aplicativos.service';
import {
  CredencialRecusadaError,
  FalhaNoAplicativoError,
  type CampoBuscado,
} from '../aplicativos/tipos';
import {
  assinarState,
  dicasDoState,
  lerState,
  type ModoDeLogin,
  novoNonce,
  VALIDADE_DO_STATE_MS,
} from '../login/estado-do-login';
import {
  destinoDoRetorno,
  CAMINHO_DA_TELA_DE_INTEGRACOES,
  type ResultadoDoLogin,
} from '../login/retorno-de-login';
import { AppsDeLoginService } from '../login/apps-de-login.service';
import { ESCOPOS_DO_FACEBOOK } from './escopos';
import type {
  CanalDaMetaDto,
  ConexaoFacebookDto,
  ConectarComTokenDePaginaDto,
  ConfiguracaoDoLoginDto,
  FormularioDoFacebookDto,
  IniciarLoginFacebookDto,
  InicioDoLoginDto,
  PaginaDoFacebookDto,
} from './facebook.dto';
import {
  ClienteDaGraphFacebook,
  ErroDaGraph,
  type PaginaDoFacebook,
} from './graph-facebook';
import { camposDasPerguntas } from './lead-facebook';

export { ESCOPOS_DO_FACEBOOK, VALIDADE_DO_STATE_MS };

/** O domínio do HMAC do `state` do Facebook (separado do das conexões de aplicativo). */
const DOMINIO_DO_STATE = 'facebook-oauth-state';

const FORMATO_DE_ID_DO_FACEBOOK = /^[0-9]{1,40}$/;

export { CAMINHO_DA_TELA_DE_INTEGRACOES };

/** Segredos de uma conexão, decifrados (só dentro da API). */
export interface SegredosDaConexao {
  readonly appSecret: string;
  readonly token: string | null;
  readonly paginas: readonly PaginaDoFacebook[];
}

/** Resultado do retorno do login: o endereço da tela de Integrações com o desfecho nos parâmetros. */
export interface RetornoDoLogin {
  readonly destino: string;
  readonly conexaoId: string | null;
  readonly ok: boolean;
}

function erroDeCampo(campo: string, mensagem: string): DadosInvalidosException {
  const campos = [{ campo, mensagens: [mensagem] }];
  return new DadosInvalidosException(resumirProblemas(campos), { campos });
}

/** Mensagem da Meta sem quebras e com tamanho limitado (ela nunca leva token). */
function mensagemDaMeta(erro: ErroDaGraph): string {
  return erro.message.replace(/\s+/g, ' ').trim().slice(0, 300);
}

/**
 * Conexões com o Facebook (R32.14): o app da Meta (id e segredo), o login
 * ("Entrar com o Facebook" ou token de página) e o acesso às páginas. O token do
 * usuário, o segredo e os tokens das páginas ficam cifrados (R10.3) e nunca
 * saem da API. Várias integrações (uma por formulário) usam a mesma conexão.
 *
 * O login: `iniciarLogin` monta a URL do diálogo (`META_DIALOGO_URL`) com um
 * `state` assinado (HMAC com a chave de criptografia), de uso único (o hash fica
 * na conexão) e válido por 10 minutos; `concluirLogin` (rota pública de retorno)
 * confere o `state`, troca o `code` e o token curto por um de longa duração,
 * guarda as páginas com os tokens delas (que não expiram junto) e devolve o
 * endereço da tela de Integrações com o resultado nos parâmetros.
 */
@Injectable()
export class ConexoesFacebookService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cripto: CriptografiaService,
    private readonly auditoria: AuditoriaService,
    private readonly aplicativos: AplicativosService,
    private readonly logs: LogsTecnicosService,
    private readonly apps: AppsDeLoginService,
    @Inject(AMBIENTE) private readonly ambiente: Ambiente,
  ) {}

  /** `appSecret`: chave do app que emitiu os tokens das chamadas (vira `appsecret_proof`). */
  graph(appSecret: string | null = null): ClienteDaGraphFacebook {
    return new ClienteDaGraphFacebook({
      buscar: (...argumentos) => globalThis.fetch(...argumentos),
      graphUrl: this.ambiente.meta.graphUrl,
      versao: this.ambiente.meta.graphVersao,
      appSecret,
    });
  }

  /** A Graph com a chave secreta do app da conexão. */
  graphDaConexao(
    conexao: Pick<ConexaoFacebook, 'appSecretCifrado'>,
  ): ClienteDaGraphFacebook {
    return this.graph(this.appSecretDe(conexao));
  }

  enderecoDeRetorno(): string {
    return `${this.ambiente.urlPublica}/${PREFIXO_DAS_ROTAS}/v${VERSAO_PADRAO_DA_API}/publico/facebook/oauth/retorno`;
  }

  async configuracaoDoLogin(): Promise<ConfiguracaoDoLoginDto> {
    return {
      appCadastrado: (await this.apps.obter('META')) !== null,
      enderecoDeRetorno: this.enderecoDeRetorno(),
      escopos: [...ESCOPOS_DO_FACEBOOK],
      versaoDaGraph: this.ambiente.meta.graphVersao,
      enderecoPublicoHttps: this.ambiente.urlPublica.startsWith('https://'),
    };
  }

  // -------------------------------------------------------------------------
  // Canais com app da Meta (reaproveitar)
  // -------------------------------------------------------------------------

  async canaisReaproveitaveis(): Promise<CanalDaMetaDto[]> {
    const canais = await this.prisma.canal.findMany({
      where: {
        tipo: { in: ['MESSENGER', 'INSTAGRAM'] },
        excluidoEm: null,
        segredosCifrados: { not: null },
      },
      orderBy: { nome: 'asc' },
    });
    return canais.flatMap((canal) => {
      const appId = objetoDe(canal.configuracao).appId;
      const { appSecret } = this.segredosDoCanal(canal.segredosCifrados);
      return typeof appId === 'string' && appId && appSecret
        ? [
            {
              id: canal.id,
              nome: canal.nome,
              tipo: canal.tipo,
              appId,
            },
          ]
        : [];
    });
  }

  private segredosDoCanal(cifrado: string | null): { appSecret?: string } {
    if (!cifrado) {
      return {};
    }
    try {
      const valor = objetoDe(JSON.parse(this.cripto.decifrar(cifrado)));
      return typeof valor.appSecret === 'string' && valor.appSecret
        ? { appSecret: valor.appSecret }
        : {};
    } catch {
      return {};
    }
  }

  /**
   * O app: o das Configurações (R32.24, quando nada é informado), o do canal escolhido ou o digitado
   * (os dois últimos seguem aceitos na API por compatibilidade).
   */
  private async resolverApp(dto: {
    canalId?: string;
    appId?: string;
    appSecret?: string;
  }): Promise<{
    appId: string;
    appSecret: string;
    canalId: string | null;
    dasConfiguracoes: boolean;
  }> {
    if (!dto.canalId && !dto.appId && !dto.appSecret) {
      const app = await this.apps.exigir('META');
      return {
        appId: app.clientId,
        appSecret: app.segredo,
        canalId: null,
        dasConfiguracoes: true,
      };
    }
    if (dto.canalId) {
      if (dto.appId || dto.appSecret) {
        throw erroDeCampo(
          'canalId',
          'não combine com appId e appSecret: o app vem do canal',
        );
      }
      const canal = await this.prisma.canal.findFirst({
        where: {
          id: dto.canalId,
          tipo: { in: ['MESSENGER', 'INSTAGRAM'] },
          excluidoEm: null,
        },
      });
      if (!canal) {
        throw new NaoEncontradoException('Canal não encontrado.');
      }
      const appId = objetoDe(canal.configuracao).appId;
      const { appSecret } = this.segredosDoCanal(canal.segredosCifrados);
      if (typeof appId !== 'string' || !appId || !appSecret) {
        throw new RegraVioladaException(
          'R32.14',
          'Este canal não tem o ID e o segredo do app da Meta guardados: informe-os aqui.',
        );
      }
      return { appId, appSecret, canalId: canal.id, dasConfiguracoes: false };
    }
    if (!dto.appId) {
      throw erroDeCampo(
        'appId',
        'é obrigatório (ou escolha um canal com `canalId`)',
      );
    }
    if (!dto.appSecret) {
      throw erroDeCampo(
        'appSecret',
        'é obrigatório (ou escolha um canal com `canalId`)',
      );
    }
    if (!FORMATO_DE_ID_DO_FACEBOOK.test(dto.appId)) {
      throw erroDeCampo('appId', 'deve ser o ID numérico do app da Meta');
    }
    return {
      appId: dto.appId,
      appSecret: dto.appSecret,
      canalId: null,
      dasConfiguracoes: false,
    };
  }

  // -------------------------------------------------------------------------
  // Login ("Entrar com o Facebook")
  // -------------------------------------------------------------------------

  async iniciarLogin(
    usuario: UsuarioAutenticado,
    dto: IniciarLoginFacebookDto,
  ): Promise<InicioDoLoginDto> {
    let conexao: ConexaoFacebook;
    if (dto.conexaoId) {
      if (dto.appId || dto.appSecret || dto.canalId) {
        throw erroDeCampo(
          'conexaoId',
          'não combine com appId, appSecret ou canalId: a reconexão usa o app da conexão',
        );
      }
      conexao = await this.carregar(dto.conexaoId);
      if (conexao.tipo === 'PAGINA') {
        throw new RegraVioladaException(
          'R32.14',
          'Esta conexão usa um token de página colado: para trocá-lo, crie outra conexão com o token novo.',
        );
      }
    } else {
      const app = await this.resolverApp(dto);
      conexao = await this.prisma.$transaction(async (tx) => {
        const criada = await tx.conexaoFacebook.create({
          data: {
            nome: dto.nome ?? `Facebook (app ${app.appId})`,
            tipo: 'USUARIO',
            appId: app.appId,
            appSecretCifrado: this.cripto.cifrar(app.appSecret),
            tokenVerificacaoCifrado: this.cripto.cifrar(
              this.cripto.gerarToken(24),
            ),
            canalOrigemId: app.canalId,
            appDasConfiguracoes: app.dasConfiguracoes,
            criadoPorId: usuario.id,
          },
        });
        await this.auditoria.registrar(tx, {
          acao: 'conexao_facebook.criada',
          entidade: 'conexao_facebook',
          entidadeId: criada.id,
          resumo: `Conexão com o Facebook "${criada.nome}" criada (login em andamento)`,
          dados: {
            appId: app.appId,
            canal: app.canalId,
            appDasConfiguracoes: app.dasConfiguracoes,
          },
        });
        return criada;
      });
    }
    const modo: ModoDeLogin = dto.modo ?? 'pagina';
    const nonce = novoNonce(usuario.id, modo);
    const expiraEm = new Date(Date.now() + VALIDADE_DO_STATE_MS);
    await this.prisma.conexaoFacebook.update({
      where: { id: conexao.id },
      data: {
        estadoHash: this.cripto.sha256(nonce),
        estadoExpiraEm: expiraEm,
        criadoPorId: conexao.criadoPorId ?? usuario.id,
        ...(dto.nome ? { nome: dto.nome } : {}),
      },
    });
    const state = assinarState(
      this.ambiente.chaveCriptografia,
      DOMINIO_DO_STATE,
      conexao.id,
      nonce,
      Math.floor(expiraEm.getTime() / 1000),
    );
    const parametros = new URLSearchParams({
      client_id: conexao.appId,
      redirect_uri: this.enderecoDeRetorno(),
      state,
      scope: ESCOPOS_DO_FACEBOOK.join(','),
      response_type: 'code',
      // Em janela, o diálogo compacto (R32.23).
      ...(modo === 'janela' ? { display: 'popup' } : {}),
    });
    return {
      conexaoId: conexao.id,
      urlDialogo: `${this.ambiente.meta.dialogoUrl}/${this.ambiente.meta.graphVersao}/dialog/oauth?${parametros.toString()}`,
      expiraEm: expiraEm.toISOString(),
      enderecoDeRetorno: this.enderecoDeRetorno(),
    };
  }

  /**
   * O retorno do diálogo (rota pública): nunca lança; o desfecho vai nos
   * parâmetros do endereço da tela de Integrações:
   * `?facebook=conectado|cancelado|erro&conexao=<id>&motivo=<código>&mensagem=<texto>`.
   */
  async concluirLogin(consulta: {
    code?: unknown;
    state?: unknown;
    error?: unknown;
    error_description?: unknown;
  }): Promise<RetornoDoLogin> {
    const state = lerState(
      this.ambiente.chaveCriptografia,
      DOMINIO_DO_STATE,
      consulta.state,
    );
    if (state === 'invalido' || state === 'vencido') {
      return this.retorno(
        dicasDoState(consulta.state).modo,
        'erro',
        null,
        `state_${state}`,
      );
    }
    const modo = state.modo;
    const conexao = await this.prisma.conexaoFacebook.findFirst({
      where: { id: state.conexaoId, excluidoEm: null },
    });
    if (!conexao) {
      return this.retorno(modo, 'erro', null, 'state_invalido');
    }
    // Uso único: consumir é atômico (dois retornos com o mesmo state: só um passa).
    const { count } = await this.prisma.conexaoFacebook.updateMany({
      where: {
        id: conexao.id,
        estadoHash: this.cripto.sha256(state.nonce),
        estadoExpiraEm: { gt: new Date() },
      },
      data: { estadoHash: null, estadoExpiraEm: null },
    });
    if (count === 0) {
      return this.retorno(modo, 'erro', conexao.id, 'state_usado');
    }
    // O ator é o Admin que iniciou o login (vai no state assinado), não o criador da conexão.
    const ator = await this.atorDoLogin(state.usuarioId);
    if (!ator) {
      return this.retorno(modo, 'erro', conexao.id, 'state_invalido');
    }
    return executarComoAtor(ator, async () => {
      if (typeof consulta.error === 'string' && consulta.error) {
        await this.logs.aviso(
          'Facebook',
          `Login do Facebook não concluído na conexão "${conexao.nome}" (${consulta.error.slice(0, 60)}).`,
          { conexaoId: conexao.id },
        );
        return this.retorno(
          modo,
          'cancelado',
          conexao.id,
          consulta.error.slice(0, 60),
        );
      }
      const codigo =
        typeof consulta.code === 'string' ? consulta.code.trim() : '';
      if (!codigo) {
        return this.retorno(modo, 'erro', conexao.id, 'sem_codigo');
      }
      try {
        const segredos = this.segredosDe(conexao);
        const graph = this.graph(segredos.appSecret);
        const curto = await graph.trocarCodigo(
          conexao.appId,
          segredos.appSecret,
          this.enderecoDeRetorno(),
          codigo,
        );
        const longo = await graph.tokenDeLongaDuracao(
          conexao.appId,
          segredos.appSecret,
          curto.token,
        );
        const [eu, paginas] = await Promise.all([
          graph.eu(longo.token),
          graph.paginas(longo.token),
        ]);
        await this.gravarLogin(conexao, {
          token: longo.token,
          expiraEmSegundos: longo.expiraEmSegundos,
          usuario: eu,
          paginas,
        });
        return this.retorno(modo, 'conectado', conexao.id, null);
      } catch (erro) {
        if (erro instanceof ErroDaGraph) {
          await this.logs.aviso(
            'Facebook',
            `A Meta recusou o login da conexão "${conexao.nome}" (código ${erro.codigo ?? erro.status}).`,
            { conexaoId: conexao.id },
          );
          return this.retorno(
            modo,
            'erro',
            conexao.id,
            'meta_recusou',
            mensagemDaMeta(erro),
          );
        }
        throw erro;
      }
    });
  }

  private retorno(
    modo: ModoDeLogin,
    resultado: ResultadoDoLogin,
    conexaoId: string | null,
    motivo: string | null,
    mensagem?: string,
  ): RetornoDoLogin {
    return {
      destino: destinoDoRetorno(this.ambiente.urlPublica, modo, {
        aplicativo: 'facebook',
        resultado,
        conexaoId,
        motivo,
        mensagem: mensagem ?? null,
      }),
      conexaoId,
      ok: resultado === 'conectado',
    };
  }

  /** O Admin que iniciou o login, se ainda ativo; senão `null` (o retorno é recusado). */
  private async atorDoLogin(usuarioId: string) {
    const usuario = await this.prisma.usuario.findFirst({
      where: { id: usuarioId, ativo: true, papel: 'ADMIN' },
      select: { id: true, nome: true, papel: true },
    });
    return usuario ? { tipoAtor: 'USUARIO' as const, usuario } : null;
  }

  private async gravarLogin(
    conexao: ConexaoFacebook,
    login: {
      token: string;
      expiraEmSegundos: number | null;
      usuario: { id: string; nome: string };
      paginas: readonly PaginaDoFacebook[];
    },
  ): Promise<void> {
    const nomeAutomatico = /^Facebook \(app \d+\)$/.test(conexao.nome);
    await this.prisma.$transaction(async (tx) => {
      await tx.conexaoFacebook.update({
        where: { id: conexao.id },
        data: {
          tokenCifrado: this.cripto.cifrar(login.token),
          paginasCifradas: this.cifrarPaginas(login.paginas),
          usuarioFacebookId: login.usuario.id || null,
          usuarioFacebookNome: login.usuario.nome || null,
          expiraEm: login.expiraEmSegundos
            ? new Date(Date.now() + login.expiraEmSegundos * 1000)
            : null,
          conectadaEm: new Date(),
          precisaAtencao: false,
          atencaoMotivo: null,
          atencaoEm: null,
          ...(nomeAutomatico && login.usuario.nome
            ? { nome: `Facebook de ${login.usuario.nome}` }
            : {}),
        },
      });
      await this.auditoria.registrar(tx, {
        acao: 'conexao_facebook.conectada',
        entidade: 'conexao_facebook',
        entidadeId: conexao.id,
        resumo: `Conexão com o Facebook "${conexao.nome}" conectada (${login.paginas.length} página(s))`,
        dados: {
          usuarioFacebook: login.usuario.id,
          paginas: login.paginas.map(({ id }) => id),
        },
      });
    });
    await this.retomarIntegracoes(conexao.id);
  }

  /** Login novo: as integrações da conexão voltam a funcionar (atenção limpa, assinatura conferida). */
  private async retomarIntegracoes(conexaoId: string): Promise<void> {
    const integracoes = await this.integracoesDaConexao(conexaoId);
    for (const integracao of integracoes) {
      await this.aplicativos.limparAtencao(integracao);
      await this.aplicativos.sincronizarComAFerramenta(integracao.id);
    }
  }

  // -------------------------------------------------------------------------
  // Token de página colado
  // -------------------------------------------------------------------------

  async conectarComTokenDePagina(
    usuario: UsuarioAutenticado,
    dto: ConectarComTokenDePaginaDto,
  ): Promise<ConexaoFacebookDto> {
    const app = await this.resolverApp(dto);
    if (dto.paginaId && !FORMATO_DE_ID_DO_FACEBOOK.test(dto.paginaId)) {
      throw erroDeCampo('paginaId', 'deve ser o ID numérico da página');
    }
    let pagina: { id: string; nome: string; categoria: string | null };
    try {
      pagina = dto.paginaId
        ? await this.graph(app.appSecret).pagina(dto.tokenPagina, dto.paginaId)
        : {
            ...(await this.graph(app.appSecret).eu(dto.tokenPagina)),
            categoria: null,
          };
    } catch (erro) {
      throw this.traduzirErroDoToken(erro);
    }
    if (!FORMATO_DE_ID_DO_FACEBOOK.test(pagina.id)) {
      throw new RegraVioladaException(
        'R32.14',
        'A Meta não identificou a página dona deste token: informe também o ID da página.',
      );
    }
    const criada = await this.prisma.$transaction(async (tx) => {
      const conexao = await tx.conexaoFacebook.create({
        data: {
          nome: dto.nome ?? `Página ${pagina.nome}`,
          tipo: 'PAGINA',
          appId: app.appId,
          appSecretCifrado: this.cripto.cifrar(app.appSecret),
          tokenVerificacaoCifrado: this.cripto.cifrar(
            this.cripto.gerarToken(24),
          ),
          tokenCifrado: this.cripto.cifrar(dto.tokenPagina),
          paginasCifradas: this.cifrarPaginas([
            { ...pagina, token: dto.tokenPagina },
          ]),
          canalOrigemId: app.canalId,
          appDasConfiguracoes: app.dasConfiguracoes,
          conectadaEm: new Date(),
          criadoPorId: usuario.id,
        },
      });
      await this.auditoria.registrar(tx, {
        acao: 'conexao_facebook.criada',
        entidade: 'conexao_facebook',
        entidadeId: conexao.id,
        resumo: `Conexão com o Facebook "${conexao.nome}" criada por token de página (${pagina.nome})`,
        dados: {
          appId: app.appId,
          pagina: pagina.id,
          canal: app.canalId,
          appDasConfiguracoes: app.dasConfiguracoes,
        },
      });
      return conexao;
    });
    return await this.paraDto(criada, 0);
  }

  // -------------------------------------------------------------------------
  // Consulta
  // -------------------------------------------------------------------------

  async listar(): Promise<ConexaoFacebookDto[]> {
    const conexoes = await this.prisma.conexaoFacebook.findMany({
      where: { excluidoEm: null },
      orderBy: { criadoEm: 'asc' },
    });
    const contagens = await this.contarIntegracoes(
      conexoes.map(({ id }) => id),
    );
    return Promise.all(
      conexoes.map((conexao) =>
        this.paraDto(conexao, contagens.get(conexao.id) ?? 0),
      ),
    );
  }

  async detalhar(id: string): Promise<ConexaoFacebookDto> {
    const conexao = await this.carregar(id);
    const contagens = await this.contarIntegracoes([id]);
    return await this.paraDto(conexao, contagens.get(id) ?? 0);
  }

  async paginas(
    id: string,
    atualizar: boolean,
  ): Promise<PaginaDoFacebookDto[]> {
    let conexao = await this.carregar(id);
    if (atualizar) {
      conexao = await this.atualizarPaginas(conexao);
    }
    return this.segredosDe(conexao).paginas.map(
      ({ id: paginaId, nome, categoria }) => ({
        id: paginaId,
        nome,
        categoria,
      }),
    );
  }

  async formularios(
    id: string,
    paginaId: string,
    busca?: string,
  ): Promise<FormularioDoFacebookDto[]> {
    const conexao = await this.carregar(id);
    const formularios = await this.comTokenDaPagina(
      conexao,
      paginaId,
      (graph, token) => graph.formularios(token, paginaId),
    );
    const termo = busca?.trim().toLowerCase();
    return formularios
      .filter((f) => !termo || f.nome.toLowerCase().includes(termo))
      .map((f) => ({ ...f }));
  }

  async perguntas(
    id: string,
    paginaId: string,
    formularioId: string,
  ): Promise<CampoBuscado[]> {
    if (!FORMATO_DE_ID_DO_FACEBOOK.test(formularioId)) {
      throw erroDeCampo('formularioId', 'identificador de formulário inválido');
    }
    const conexao = await this.carregar(id);
    const perguntas = await this.comTokenDaPagina(
      conexao,
      paginaId,
      (graph, token) => graph.perguntas(token, formularioId),
    );
    return camposDasPerguntas(perguntas);
  }

  /** As perguntas de um formulário de uma conexão como campos do assistente (usado pela integração). */
  async camposDoFormulario(
    conexaoId: string,
    paginaId: string,
    formularioId: string,
  ): Promise<CampoBuscado[]> {
    return this.perguntas(conexaoId, paginaId, formularioId);
  }

  // -------------------------------------------------------------------------
  // Alteração
  // -------------------------------------------------------------------------

  /** Pergunta de novo à Meta quais páginas o usuário administra (e renova os tokens delas). */
  async atualizarPaginas(conexao: ConexaoFacebook): Promise<ConexaoFacebook> {
    const segredos = this.segredosDe(conexao);
    if (conexao.tipo === 'PAGINA' || !segredos.token) {
      if (!segredos.token) {
        throw new RegraVioladaException(
          'R32.14',
          'Esta conexão ainda não terminou o login com o Facebook.',
        );
      }
      return conexao;
    }
    let paginas: PaginaDoFacebook[];
    try {
      paginas = await this.graph(segredos.appSecret).paginas(segredos.token);
    } catch (erro) {
      throw await this.traduzirFalha(erro, conexao);
    }
    return this.prisma.conexaoFacebook.update({
      where: { id: conexao.id },
      data: { paginasCifradas: this.cifrarPaginas(paginas) },
    });
  }

  async atualizarPaginasPorId(id: string): Promise<ConexaoFacebookDto> {
    const conexao = await this.atualizarPaginas(await this.carregar(id));
    const contagens = await this.contarIntegracoes([id]);
    return await this.paraDto(conexao, contagens.get(id) ?? 0);
  }

  async excluir(id: string): Promise<void> {
    const conexao = await this.carregar(id);
    const usadas = (await this.contarIntegracoes([id])).get(id) ?? 0;
    if (usadas > 0) {
      throw new ConflitoException(
        `Esta conexão é usada por ${usadas} integração(ões): exclua-as ou troque a conexão delas antes.`,
        { regra: 'R32.14', integracoes: usadas },
      );
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.conexaoFacebook.update({
        where: { id },
        data: {
          excluidoEm: new Date(),
          tokenCifrado: null,
          paginasCifradas: null,
          estadoHash: null,
          estadoExpiraEm: null,
        },
      });
      await this.auditoria.registrar(tx, {
        acao: 'conexao_facebook.excluida',
        entidade: 'conexao_facebook',
        entidadeId: id,
        resumo: `Conexão com o Facebook "${conexao.nome}" excluída (os tokens foram apagados)`,
      });
    });
  }

  /** Remove conexões cujo login nunca terminou (o diálogo foi fechado), com mais de um dia. */
  async limparPendentes(): Promise<number> {
    const { count } = await this.prisma.conexaoFacebook.deleteMany({
      where: {
        tokenCifrado: null,
        conectadaEm: null,
        criadoEm: { lt: new Date(Date.now() - 24 * 3600_000) },
      },
    });
    return count;
  }

  // -------------------------------------------------------------------------
  // Acesso às páginas (usado pelo serviço do aplicativo)
  // -------------------------------------------------------------------------

  async carregar(id: string): Promise<ConexaoFacebook> {
    const conexao = await this.prisma.conexaoFacebook.findFirst({
      where: { id, excluidoEm: null },
    });
    if (!conexao) {
      throw new NaoEncontradoException(
        'Conexão com o Facebook não encontrada.',
      );
    }
    return conexao;
  }

  segredosDe(
    conexao: Pick<
      ConexaoFacebook,
      'appSecretCifrado' | 'tokenCifrado' | 'paginasCifradas'
    >,
  ): SegredosDaConexao {
    let appSecret: string;
    try {
      appSecret = this.cripto.decifrar(conexao.appSecretCifrado);
    } catch {
      throw new RegraVioladaException(
        'R32.14',
        'Os segredos desta conexão não podem ser lidos (a CHAVE_CRIPTOGRAFIA mudou?): crie a conexão de novo.',
      );
    }
    let token: string | null = null;
    if (conexao.tokenCifrado) {
      try {
        token = this.cripto.decifrar(conexao.tokenCifrado);
      } catch {
        token = null;
      }
    }
    return {
      appSecret,
      token,
      paginas: this.lerPaginas(conexao.paginasCifradas),
    };
  }

  /** Só o segredo do app, ou `null` se não puder ser lido (conferência da assinatura do webhook). */
  appSecretDe(
    conexao: Pick<ConexaoFacebook, 'appSecretCifrado'>,
  ): string | null {
    try {
      return this.cripto.decifrar(conexao.appSecretCifrado);
    } catch {
      return null;
    }
  }

  /** O token da página; falha se a página não está (mais) na conexão. */
  tokenDaPagina(conexao: ConexaoFacebook, paginaId: string): string {
    const pagina = this.segredosDe(conexao).paginas.find(
      ({ id }) => id === paginaId,
    );
    if (!pagina) {
      throw new RegraVioladaException(
        'R32.14',
        'A página não está mais disponível nesta conexão: atualize as páginas ou entre com o Facebook de novo.',
        { paginaId },
      );
    }
    return pagina.token;
  }

  /**
   * Chama a Graph com o token da página; token recusado marca a conexão e as
   * integrações dela como "precisa de atenção" e vira 422; outra falha, 422 com
   * a mensagem da Meta.
   */
  async comTokenDaPagina<T>(
    conexao: ConexaoFacebook,
    paginaId: string,
    chamada: (graph: ClienteDaGraphFacebook, token: string) => Promise<T>,
  ): Promise<T> {
    if (!FORMATO_DE_ID_DO_FACEBOOK.test(paginaId)) {
      throw erroDeCampo('paginaId', 'deve ser o ID numérico da página');
    }
    const token = this.tokenDaPagina(conexao, paginaId);
    try {
      return await chamada(this.graphDaConexao(conexao), token);
    } catch (erro) {
      throw await this.traduzirFalha(erro, conexao);
    }
  }

  /** `ErroDaGraph` → o erro de domínio (e a atenção, se o token foi recusado). */
  async traduzirFalha(
    erro: unknown,
    conexao: ConexaoFacebook,
  ): Promise<RegraVioladaException> {
    if (erro instanceof ErroDaGraph) {
      if (erro.tokenInvalido) {
        const motivo =
          'O Facebook recusou o token desta conexão (expirado, revogado ou a senha mudou): entre com o Facebook de novo.';
        await this.marcarTokenInvalido(conexao.id, motivo);
        return new RegraVioladaException('R32.14', motivo, {
          precisaAtencao: true,
        });
      }
      return new RegraVioladaException('R32.14', mensagemDaMeta(erro));
    }
    if (
      erro instanceof CredencialRecusadaError ||
      erro instanceof FalhaNoAplicativoError
    ) {
      return new RegraVioladaException('R32.14', erro.message);
    }
    throw erro;
  }

  private traduzirErroDoToken(erro: unknown): RegraVioladaException {
    if (erro instanceof ErroDaGraph) {
      return new RegraVioladaException(
        'R32.14',
        erro.tokenInvalido
          ? 'O Facebook recusou o token da página (expirado, revogado ou inválido).'
          : mensagemDaMeta(erro),
      );
    }
    throw erro;
  }

  /** Marca a conexão e as integrações dela como "precisa de atenção" (e avisa os Admins, uma vez por ocorrência). */
  async marcarTokenInvalido(conexaoId: string, motivo: string): Promise<void> {
    const conexao = await this.prisma.conexaoFacebook.findFirst({
      where: { id: conexaoId, excluidoEm: null },
    });
    if (!conexao) {
      return;
    }
    if (!conexao.precisaAtencao) {
      await this.prisma.$transaction(async (tx) => {
        await tx.conexaoFacebook.update({
          where: { id: conexaoId },
          data: {
            precisaAtencao: true,
            atencaoMotivo: motivo,
            atencaoEm: new Date(),
          },
        });
        await this.auditoria.registrar(tx, {
          acao: 'conexao_facebook.precisa_atencao',
          entidade: 'conexao_facebook',
          entidadeId: conexaoId,
          resumo: `Conexão com o Facebook "${conexao.nome}" precisa de atenção: ${motivo}`,
        });
      });
    }
    for (const integracao of await this.integracoesDaConexao(conexaoId)) {
      await this.aplicativos.marcarAtencao(integracao, motivo);
    }
  }

  /** As integrações do Facebook (ativas, não excluídas) que usam a conexão. */
  async integracoesDaConexao(conexaoId: string) {
    return this.prisma.webhookEntrada.findMany({
      where: {
        aplicativo: 'FACEBOOK_LEAD_ADS',
        excluidoEm: null,
        ativo: true,
        configuracao: { path: ['conexaoId'], equals: conexaoId },
      },
    });
  }

  private async contarIntegracoes(
    ids: readonly string[],
  ): Promise<Map<string, number>> {
    const integracoes = await this.prisma.webhookEntrada.findMany({
      where: { aplicativo: 'FACEBOOK_LEAD_ADS', excluidoEm: null },
      select: { configuracao: true },
    });
    const contagens = new Map<string, number>();
    for (const { configuracao } of integracoes) {
      const conexaoId = objetoDe(configuracao).conexaoId;
      if (typeof conexaoId === 'string' && ids.includes(conexaoId)) {
        contagens.set(conexaoId, (contagens.get(conexaoId) ?? 0) + 1);
      }
    }
    return contagens;
  }

  // -------------------------------------------------------------------------
  // Páginas cifradas e `state`
  // -------------------------------------------------------------------------

  private cifrarPaginas(paginas: readonly PaginaDoFacebook[]): string {
    return this.cripto.cifrar(JSON.stringify(paginas));
  }

  private lerPaginas(cifrado: string | null): PaginaDoFacebook[] {
    if (!cifrado) {
      return [];
    }
    try {
      const valor: unknown = JSON.parse(this.cripto.decifrar(cifrado));
      return (Array.isArray(valor) ? valor : []).flatMap((item) => {
        const pagina = objetoDe(item);
        return typeof pagina.id === 'string' && typeof pagina.token === 'string'
          ? [
              {
                id: pagina.id,
                nome: typeof pagina.nome === 'string' ? pagina.nome : pagina.id,
                categoria:
                  typeof pagina.categoria === 'string'
                    ? pagina.categoria
                    : null,
                token: pagina.token,
              },
            ]
          : [];
      });
    } catch {
      return [];
    }
  }

  // -------------------------------------------------------------------------
  // DTO
  // -------------------------------------------------------------------------

  /** Endereço do webhook de páginas para o painel do app da Meta (o mesmo do Instagram e do Messenger). */
  get urlDoWebhook(): string {
    return `${this.ambiente.urlPublica}/${PREFIXO_DAS_ROTAS}/v${VERSAO_PADRAO_DA_API}/publico/meta/webhook`;
  }

  /**
   * O token de verificação do webhook da conexão. Conexões anteriores a ele
   * ganham um na primeira leitura (uma vez; auditado).
   */
  private async tokenDeVerificacaoDe(
    conexao: ConexaoFacebook,
  ): Promise<string> {
    if (conexao.tokenVerificacaoCifrado) {
      try {
        return this.cripto.decifrar(conexao.tokenVerificacaoCifrado);
      } catch {
        return '';
      }
    }
    const novo = this.cripto.gerarToken(24);
    const gravou = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.conexaoFacebook.updateMany({
        where: { id: conexao.id, tokenVerificacaoCifrado: null },
        data: { tokenVerificacaoCifrado: this.cripto.cifrar(novo) },
      });
      if (count > 0) {
        await this.auditoria.registrar(tx, {
          acao: 'conexao_facebook.token_verificacao_gerado',
          entidade: 'conexao_facebook',
          entidadeId: conexao.id,
          resumo: `Token de verificação do webhook gerado para a conexão com o Facebook "${conexao.nome}"`,
          dados: {},
        });
      }
      return count > 0;
    });
    if (gravou) {
      return novo;
    }
    const atual = await this.prisma.conexaoFacebook.findUnique({
      where: { id: conexao.id },
    });
    try {
      return atual?.tokenVerificacaoCifrado
        ? this.cripto.decifrar(atual.tokenVerificacaoCifrado)
        : '';
    } catch {
      return '';
    }
  }

  /**
   * O `hub.verify_token` do desafio GET vale se é o do app da Meta das Configurações (R32.22) ou o de
   * alguma conexão do Facebook ativa (tempo constante).
   */
  async tokenDeVerificacaoValido(token: string): Promise<boolean> {
    const conexoes = await this.prisma.conexaoFacebook.findMany({
      where: { excluidoEm: null, tokenVerificacaoCifrado: { not: null } },
      select: { tokenVerificacaoCifrado: true },
    });
    let valido = await this.apps.tokenDeVerificacaoValido(token);
    for (const { tokenVerificacaoCifrado } of conexoes) {
      try {
        const guardado = this.cripto.decifrar(tokenVerificacaoCifrado ?? '');
        if (guardado && this.cripto.compararSeguro(guardado, token)) {
          valido = true;
        }
      } catch {
        // segredo ilegível (chave mudou): não vale.
      }
    }
    return valido;
  }

  private async paraDto(
    conexao: ConexaoFacebook,
    integracoes: number,
  ): Promise<ConexaoFacebookDto> {
    const segredos = this.lerSegredosParaDto(conexao);
    const tokenVerificacao = await this.tokenDeVerificacaoDe(conexao);
    return {
      id: conexao.id,
      nome: conexao.nome,
      tipo: conexao.tipo,
      appId: conexao.appId,
      appSecretMascarado: segredos.appSecret
        ? this.cripto.mascarar(segredos.appSecret)
        : '••••••••',
      conectada: conexao.tokenCifrado !== null,
      usuarioFacebook: conexao.usuarioFacebookId
        ? {
            id: conexao.usuarioFacebookId,
            nome: conexao.usuarioFacebookNome ?? conexao.usuarioFacebookId,
          }
        : null,
      expiraEm: conexao.expiraEm?.toISOString() ?? null,
      conectadaEm: conexao.conectadaEm?.toISOString() ?? null,
      canalOrigemId: conexao.canalOrigemId,
      appDasConfiguracoes: conexao.appDasConfiguracoes,
      paginas: segredos.paginas.map(({ id, nome, categoria }) => ({
        id,
        nome,
        categoria,
      })),
      integracoes,
      webhook: {
        url: this.urlDoWebhook,
        tokenVerificacao,
        campos: ['leadgen'],
      },
      precisaAtencao: conexao.precisaAtencao,
      atencaoMotivo: conexao.atencaoMotivo,
      criadoEm: conexao.criadoEm.toISOString(),
    };
  }

  private lerSegredosParaDto(conexao: ConexaoFacebook): {
    appSecret: string | null;
    paginas: readonly PaginaDoFacebook[];
  } {
    return {
      appSecret: this.appSecretDe(conexao),
      paginas: this.lerPaginas(conexao.paginasCifradas),
    };
  }
}
