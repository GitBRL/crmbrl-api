import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
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
import type {
  AplicativoDeLogin,
  ConexaoAplicativo,
} from '../../generated/prisma/client';
import { FilaService } from '../../fila/fila.service';
import { LogsTecnicosService } from '../../logs/logs-tecnicos.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  ConexaoRecusadaError,
  CredencialRecusadaError,
  FalhaNoAplicativoError,
} from '../aplicativos/tipos';
import {
  AplicativosService,
  objetoDe,
  type ProvedorDeConexoes,
} from '../entrada/aplicativos.service';
import type { InicioDoLoginDto } from '../facebook/facebook.dto';
import { AppsDeLoginService } from './apps-de-login.service';
import {
  type AplicativoDeConexao,
  type BasesDoOAuth,
  nomeDaConta,
  NOME_DO_SERVICO,
  renovarToken,
  revogarNoRdStation,
  trocarCodigo,
  urlDoDialogo,
} from './clientes-oauth';
import type {
  ConexaoDeAplicativoDto,
  IniciarLoginDeAplicativoDto,
} from './conexoes-aplicativo.dto';
import {
  assinarState,
  dicasDoState,
  lerState,
  type ModoDeLogin,
  novoNonce,
  VALIDADE_DO_STATE_MS,
} from './estado-do-login';
import {
  type AplicativoDoRetorno,
  destinoDoRetorno,
  type ResultadoDoLogin,
} from './retorno-de-login';

const DOMINIO_DO_STATE = 'conexao-aplicativo-oauth-state';
/** Tenta de novo, a cada 15 minutos, remover do RD e do Typeform os webhooks que a exclusão da integração não conseguiu. */
export const FILA_REMOCOES_PENDENTES = 'webhooks.remocoes-pendentes';
const CRON_DAS_REMOCOES_PENDENTES = '*/15 * * * *';
/** O token que vence em menos que isso é renovado antes do uso. */
const FOLGA_DA_VALIDADE_MS = 60_000;

const APLICATIVO_DO_RETORNO: Readonly<
  Record<AplicativoDeConexao, AplicativoDoRetorno>
> = { TYPEFORM: 'typeform', RD_STATION: 'rd-station' };

const APLICATIVO_DA_INTEGRACAO = {
  TYPEFORM: 'TYPEFORM',
  RD_STATION: 'RD_STATION',
} as const;

interface TokensGuardados {
  access: string;
  refresh: string | null;
}

export interface RetornoDaConexao {
  readonly destino: string;
  readonly conexaoId: string | null;
  readonly ok: boolean;
}

function erroDeCampo(campo: string, mensagem: string): DadosInvalidosException {
  const campos = [{ campo, mensagens: [mensagem] }];
  return new DadosInvalidosException(resumirProblemas(campos), { campos });
}

function ehDeConexao(
  aplicativo: AplicativoDeLogin,
): aplicativo is AplicativoDeConexao {
  return aplicativo === 'TYPEFORM' || aplicativo === 'RD_STATION';
}

/**
 * Conexões de aplicativo por login (R32.25 Typeform, R32.26 RD Station): "Entrar com o Typeform" e
 * "Entrar com o RD Station". O `state` é assinado (HMAC), de uso único (o hash fica na conexão),
 * válido por 10 minutos e vinculado ao Admin que iniciou; o retorno público troca o `code`,
 * guarda os tokens cifrados e o nome da conta. O token de acesso é renovado quando vence e uma vez
 * depois de um 401; se a renovação for recusada, a conexão (e as integrações dela) ficam
 * "precisa de atenção" e o CRM pede para conectar de novo.
 */
@Injectable()
export class ConexoesAplicativoService
  implements OnModuleInit, ProvedorDeConexoes
{
  constructor(
    private readonly prisma: PrismaService,
    private readonly cripto: CriptografiaService,
    private readonly auditoria: AuditoriaService,
    private readonly aplicativos: AplicativosService,
    private readonly apps: AppsDeLoginService,
    private readonly logs: LogsTecnicosService,
    private readonly fila: FilaService,
    @Inject(AMBIENTE) private readonly ambiente: Ambiente,
  ) {}

  async onModuleInit(): Promise<void> {
    this.aplicativos.registrarProvedorDeConexoes(this);
    await this.fila.trabalhar(
      FILA_REMOCOES_PENDENTES,
      async () => {
        await this.aplicativos.refazerRemocoesPendentes();
      },
      { tentativas: 0, prazoDeExecucaoSegundos: 600 },
    );
    await this.fila.agendar(
      FILA_REMOCOES_PENDENTES,
      CRON_DAS_REMOCOES_PENDENTES,
    );
  }

  bases(): BasesDoOAuth {
    const { integracoes } = this.ambiente;
    return {
      typeformDialogoUrl: integracoes.typeformDialogoUrl,
      typeformApiUrl: integracoes.typeformUrl,
      rdStationDialogoUrl: integracoes.rdStationDialogoUrl,
      rdStationApiUrl: integracoes.rdStationUrl,
    };
  }

  private buscar(): typeof fetch {
    return (...argumentos) => globalThis.fetch(...argumentos);
  }

  enderecoDeRetorno(): string {
    return `${this.ambiente.urlPublica}/${PREFIXO_DAS_ROTAS}/v${VERSAO_PADRAO_DA_API}/publico/conexoes/oauth/retorno`;
  }

  // -------------------------------------------------------------------------
  // Login
  // -------------------------------------------------------------------------

  async iniciarLogin(
    usuario: UsuarioAutenticado,
    dto: IniciarLoginDeAplicativoDto,
  ): Promise<InicioDoLoginDto> {
    const app = await this.apps.exigir(dto.aplicativo);
    await this.limparPendentes();
    let conexao: ConexaoAplicativo;
    if (dto.conexaoId) {
      conexao = await this.carregar(dto.conexaoId);
      if (conexao.aplicativo !== dto.aplicativo) {
        throw erroDeCampo(
          'conexaoId',
          `esta conexão é do ${NOME_DO_SERVICO[conexao.aplicativo as AplicativoDeConexao]}, não do ${NOME_DO_SERVICO[dto.aplicativo]}`,
        );
      }
    } else {
      conexao = await this.prisma.$transaction(async (tx) => {
        const criada = await tx.conexaoAplicativo.create({
          data: {
            aplicativo: dto.aplicativo,
            nome: dto.nome ?? NOME_DO_SERVICO[dto.aplicativo],
            criadoPorId: usuario.id,
          },
        });
        await this.auditoria.registrar(tx, {
          acao: 'conexao_aplicativo.criada',
          entidade: 'conexao_aplicativo',
          entidadeId: criada.id,
          resumo: `Conexão com o ${NOME_DO_SERVICO[dto.aplicativo]} "${criada.nome}" criada (login em andamento)`,
          dados: { aplicativo: dto.aplicativo },
        });
        return criada;
      });
    }
    const modo: ModoDeLogin = dto.modo ?? 'pagina';
    const nonce = novoNonce(
      usuario.id,
      modo,
      APLICATIVO_DO_RETORNO[dto.aplicativo],
    );
    const expiraEm = new Date(Date.now() + VALIDADE_DO_STATE_MS);
    await this.prisma.conexaoAplicativo.update({
      where: { id: conexao.id },
      data: {
        estadoHash: this.cripto.sha256(nonce),
        estadoExpiraEm: expiraEm,
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
    return {
      conexaoId: conexao.id,
      urlDialogo: urlDoDialogo(dto.aplicativo, this.bases(), {
        clientId: app.clientId,
        redirectUri: this.enderecoDeRetorno(),
        state,
      }),
      expiraEm: expiraEm.toISOString(),
      enderecoDeRetorno: this.enderecoDeRetorno(),
    };
  }

  /**
   * O retorno do diálogo (rota pública): nunca lança; o desfecho vai nos parâmetros do endereço do
   * front (`/retorno-login?app=…&resultado=…` em janela, `/integracoes?typeform=…` em página).
   */
  async concluirLogin(consulta: {
    code?: unknown;
    state?: unknown;
    error?: unknown;
  }): Promise<RetornoDaConexao> {
    const state = lerState(
      this.ambiente.chaveCriptografia,
      DOMINIO_DO_STATE,
      consulta.state,
    );
    if (state === 'invalido' || state === 'vencido') {
      const dicas = dicasDoState(consulta.state);
      return this.retorno(
        dicas.modo,
        (dicas.aplicativo as AplicativoDoRetorno | null) ?? 'typeform',
        'erro',
        null,
        `state_${state}`,
      );
    }
    const modo = state.modo;
    const conexao = await this.prisma.conexaoAplicativo.findFirst({
      where: { id: state.conexaoId, excluidoEm: null },
    });
    if (!conexao || !ehDeConexao(conexao.aplicativo)) {
      return this.retorno(
        modo,
        (state.aplicativo as AplicativoDoRetorno | null) ?? 'typeform',
        'erro',
        null,
        'state_invalido',
      );
    }
    const aplicativo = conexao.aplicativo;
    const app = APLICATIVO_DO_RETORNO[aplicativo];
    // Uso único: consumir é atômico (dois retornos com o mesmo state: só um passa).
    const { count } = await this.prisma.conexaoAplicativo.updateMany({
      where: {
        id: conexao.id,
        estadoHash: this.cripto.sha256(state.nonce),
        estadoExpiraEm: { gt: new Date() },
      },
      data: { estadoHash: null, estadoExpiraEm: null },
    });
    if (count === 0) {
      return this.retorno(modo, app, 'erro', conexao.id, 'state_usado');
    }
    // O ator é o Admin que iniciou o login (vai no state assinado), não o criador da conexão.
    const admin = await this.prisma.usuario.findFirst({
      where: { id: state.usuarioId, ativo: true, papel: 'ADMIN' },
      select: { id: true, nome: true, papel: true },
    });
    if (!admin) {
      return this.retorno(modo, app, 'erro', conexao.id, 'state_invalido');
    }
    return executarComoAtor(
      { tipoAtor: 'USUARIO', usuario: admin },
      async () => {
        if (typeof consulta.error === 'string' && consulta.error) {
          await this.logs.aviso(
            NOME_DO_SERVICO[aplicativo],
            `Login do ${NOME_DO_SERVICO[aplicativo]} não concluído na conexão "${conexao.nome}" (${consulta.error.slice(0, 60)}).`,
            { conexaoId: conexao.id },
          );
          return this.retorno(
            modo,
            app,
            'cancelado',
            conexao.id,
            consulta.error.slice(0, 60),
          );
        }
        const codigo =
          typeof consulta.code === 'string' ? consulta.code.trim() : '';
        if (!codigo) {
          return this.retorno(modo, app, 'erro', conexao.id, 'sem_codigo');
        }
        const appDoServico = await this.apps.obter(aplicativo);
        if (!appDoServico) {
          return this.retorno(
            modo,
            app,
            'erro',
            conexao.id,
            'app_nao_cadastrado',
          );
        }
        try {
          const tokens = await trocarCodigo(
            aplicativo,
            this.bases(),
            this.buscar(),
            appDoServico,
            this.enderecoDeRetorno(),
            codigo,
          );
          const conta = await nomeDaConta(
            aplicativo,
            this.bases(),
            this.buscar(),
            tokens.access,
          );
          await this.gravarLogin(conexao, aplicativo, tokens, conta);
          return this.retorno(modo, app, 'conectado', conexao.id, null);
        } catch (erro) {
          if (erro instanceof CredencialRecusadaError) {
            await this.logs.aviso(
              NOME_DO_SERVICO[aplicativo],
              `O ${NOME_DO_SERVICO[aplicativo]} recusou o login da conexão "${conexao.nome}".`,
              { conexaoId: conexao.id },
            );
            return this.retorno(
              modo,
              app,
              'erro',
              conexao.id,
              'servico_recusou',
              `O ${NOME_DO_SERVICO[aplicativo]} recusou o login: confira o ID, o segredo e o endereço de retorno do app em Configurações > Apps de login.`,
            );
          }
          if (erro instanceof FalhaNoAplicativoError) {
            return this.retorno(
              modo,
              app,
              'erro',
              conexao.id,
              'servico_indisponivel',
              erro.message.slice(0, 300),
            );
          }
          throw erro;
        }
      },
    );
  }

  private retorno(
    modo: ModoDeLogin,
    aplicativo: AplicativoDoRetorno,
    resultado: ResultadoDoLogin,
    conexaoId: string | null,
    motivo: string | null,
    mensagem?: string,
  ): RetornoDaConexao {
    return {
      destino: destinoDoRetorno(this.ambiente.urlPublica, modo, {
        aplicativo,
        resultado,
        conexaoId,
        motivo,
        mensagem: mensagem ?? null,
      }),
      conexaoId,
      ok: resultado === 'conectado',
    };
  }

  private async gravarLogin(
    conexao: ConexaoAplicativo,
    aplicativo: AplicativoDeConexao,
    tokens: {
      access: string;
      refresh: string | null;
      expiraEmSegundos: number | null;
    },
    conta: string | null,
  ): Promise<void> {
    const nomeAutomatico = conexao.nome === NOME_DO_SERVICO[aplicativo];
    await this.prisma.$transaction(async (tx) => {
      await tx.conexaoAplicativo.update({
        where: { id: conexao.id },
        data: {
          tokensCifrados: this.cifrarTokens({
            access: tokens.access,
            refresh: tokens.refresh,
          }),
          expiraEm: tokens.expiraEmSegundos
            ? new Date(Date.now() + tokens.expiraEmSegundos * 1000)
            : null,
          conta,
          conectadaEm: new Date(),
          precisaAtencao: false,
          atencaoMotivo: null,
          atencaoEm: null,
          ...(nomeAutomatico && conta
            ? { nome: `${NOME_DO_SERVICO[aplicativo]} de ${conta}` }
            : {}),
        },
      });
      await this.auditoria.registrar(tx, {
        acao: 'conexao_aplicativo.conectada',
        entidade: 'conexao_aplicativo',
        entidadeId: conexao.id,
        resumo: `Conexão com o ${NOME_DO_SERVICO[aplicativo]} "${conexao.nome}" conectada`,
        dados: { aplicativo, conta },
      });
    });
    // Login novo: as integrações da conexão voltam a funcionar (atenção limpa, webhook em dia).
    for (const integracao of await this.integracoesDaConexao(
      conexao.id,
      aplicativo,
    )) {
      await this.aplicativos.limparAtencao(integracao);
      await this.aplicativos.sincronizarComAFerramenta(integracao.id);
    }
  }

  // -------------------------------------------------------------------------
  // Consulta e exclusão
  // -------------------------------------------------------------------------

  async listar(
    aplicativo?: AplicativoDeConexao,
  ): Promise<ConexaoDeAplicativoDto[]> {
    const conexoes = await this.prisma.conexaoAplicativo.findMany({
      where: { excluidoEm: null, ...(aplicativo ? { aplicativo } : {}) },
      orderBy: { criadoEm: 'asc' },
    });
    return Promise.all(conexoes.map((conexao) => this.paraDto(conexao)));
  }

  async detalhar(id: string): Promise<ConexaoDeAplicativoDto> {
    return this.paraDto(await this.carregar(id));
  }

  async excluir(id: string, descartarPendencias = false): Promise<void> {
    const conexao = await this.carregar(id);
    const aplicativo = conexao.aplicativo as AplicativoDeConexao;
    const usadas = (await this.integracoesDaConexao(id, aplicativo, false))
      .length;
    if (usadas > 0) {
      throw new ConflitoException(
        `Esta conexão é usada por ${usadas} integração(ões): exclua-as ou troque a conexão delas antes.`,
        { regra: 'R32.25', integracoes: usadas },
      );
    }
    // Sem a conexão o CRM perde a chave para apagar os webhooks que ele criou no serviço: tenta de novo
    // as remoções que falharam e, se ainda houver, só exclui com a confirmação do Admin.
    const pendentes = await this.aplicativos.refazerRemocoesPendentes(id);
    if (pendentes.length > 0 && !descartarPendencias) {
      throw new ConflitoException(
        `O CRM ainda não conseguiu remover do ${NOME_DO_SERVICO[aplicativo]} ${pendentes.length} webhook(s) de integrações excluídas (${pendentes.map((p) => `"${p.nome}"`).join(', ')}). Tente de novo mais tarde ou apague-os no ${NOME_DO_SERVICO[aplicativo]} e confirme a exclusão da conexão.`,
        { regra: 'R32.26', pendencias: pendentes },
      );
    }
    for (const pendente of pendentes) {
      // Confirmado pelo Admin: o webhook fica no serviço e o CRM para de tentar.
      await this.aplicativos.concluirRemocao(pendente.integracaoId);
      await this.logs.aviso(
        'Webhooks',
        `A conexão com o ${NOME_DO_SERVICO[aplicativo]} "${conexao.nome}" foi excluída com o webhook da integração "${pendente.nome}" ainda no serviço (id ${pendente.webhookId ?? 'desconhecido'}).`,
        { integracaoId: pendente.integracaoId },
      );
    }
    const tokens = this.lerTokens(conexao);
    await this.prisma.$transaction(async (tx) => {
      await tx.conexaoAplicativo.update({
        where: { id },
        data: {
          excluidoEm: new Date(),
          tokensCifrados: null,
          estadoHash: null,
          estadoExpiraEm: null,
        },
      });
      await this.auditoria.registrar(tx, {
        acao: 'conexao_aplicativo.excluida',
        entidade: 'conexao_aplicativo',
        entidadeId: id,
        resumo: `Conexão com o ${NOME_DO_SERVICO[aplicativo]} "${conexao.nome}" excluída (os tokens foram apagados)`,
        dados: { aplicativo },
      });
    });
    // O RD Station tem revogação; o Typeform não (o acesso se tira na conta dele). Melhor esforço.
    if (aplicativo === 'RD_STATION' && tokens) {
      await revogarNoRdStation(this.bases(), this.buscar(), tokens);
    }
  }

  /** Remove conexões cujo login nunca terminou (a janela foi fechada), com mais de um dia. */
  async limparPendentes(): Promise<number> {
    const { count } = await this.prisma.conexaoAplicativo.deleteMany({
      where: {
        tokensCifrados: null,
        conectadaEm: null,
        criadoEm: { lt: new Date(Date.now() - 24 * 3600_000) },
      },
    });
    return count;
  }

  // -------------------------------------------------------------------------
  // Para as integrações (ProvedorDeConexoes)
  // -------------------------------------------------------------------------

  async conferirConexao(
    aplicativo: AplicativoDeConexao,
    conexaoId: string,
  ): Promise<void> {
    const conexao = await this.prisma.conexaoAplicativo.findFirst({
      where: { id: conexaoId, excluidoEm: null },
    });
    if (!conexao || conexao.aplicativo !== aplicativo) {
      throw new NaoEncontradoException(
        `Conexão com o ${NOME_DO_SERVICO[aplicativo]} não encontrada.`,
      );
    }
    if (!conexao.tokensCifrados) {
      throw new RegraVioladaException(
        'R32.25',
        `Esta conexão ainda não terminou o login com o ${NOME_DO_SERVICO[aplicativo]}: entre de novo.`,
        { conexaoId },
      );
    }
  }

  /**
   * Chama o serviço com o token da conexão: renova o token se venceu e, depois de um 401, renova e
   * tenta uma vez mais. Renovação recusada → a conexão fica "precisa de atenção" e a chamada
   * falha com `CredencialRecusadaError`.
   */
  async comToken<T>(
    conexaoId: string,
    chamada: (token: string) => Promise<T>,
  ): Promise<T> {
    let acesso = await this.tokenDeAcesso(conexaoId, null);
    try {
      return await chamada(acesso);
    } catch (erro) {
      if (!(erro instanceof CredencialRecusadaError)) {
        throw erro;
      }
      acesso = await this.tokenDeAcesso(conexaoId, acesso);
      return await chamada(acesso);
    }
  }

  /** O token de acesso válido (renova se venceu). `recusado`: o token que o serviço acabou de recusar (renova de qualquer jeito). */
  private async tokenDeAcesso(
    conexaoId: string,
    recusado: string | null,
  ): Promise<string> {
    const conexao = await this.carregarParaUso(conexaoId);
    const tokens = this.lerTokens(conexao);
    if (!tokens) {
      throw await this.recusar(
        conexao,
        `O acesso ao ${NOME_DO_SERVICO[conexao.aplicativo as AplicativoDeConexao]} não pode ser lido: conecte de novo.`,
      );
    }
    if (recusado === null && !this.venceu(conexao)) {
      return tokens.access;
    }
    return this.renovar(conexao, recusado);
  }

  private venceu(conexao: Pick<ConexaoAplicativo, 'expiraEm'>): boolean {
    return (
      conexao.expiraEm !== null &&
      conexao.expiraEm.getTime() - Date.now() < FOLGA_DA_VALIDADE_MS
    );
  }

  private async renovar(
    conexao: ConexaoAplicativo,
    recusado: string | null,
  ): Promise<string> {
    const aplicativo = conexao.aplicativo as AplicativoDeConexao;
    const servico = NOME_DO_SERVICO[aplicativo];
    // O refresh do Typeform é de uso único (a renovação invalida o anterior): só uma renovação por vez.
    const resultado = await this.prisma.$transaction(
      async (tx): Promise<{ acesso: string } | { recusada: string }> => {
        // Esperar a vez tem prazo (sobra tempo para a chamada ao serviço e a gravação dentro da transação).
        try {
          await tx.$executeRaw`SET LOCAL lock_timeout = '20s'`;
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`conexao-aplicativo:${conexao.id}`}))`;
        } catch {
          throw new FalhaNoAplicativoError(
            `Outra renovação do acesso ao ${servico} está demorando: tente de novo em instantes.`,
          );
        }
        const atual = await tx.conexaoAplicativo.findFirst({
          where: { id: conexao.id, excluidoEm: null },
        });
        const tokens = atual ? this.lerTokens(atual) : null;
        if (!atual || !tokens) {
          return {
            recusada: `O acesso ao ${servico} não pode ser lido: conecte de novo.`,
          };
        }
        // Outra chamada pode ter renovado enquanto esta esperava a vez.
        const jaRenovada =
          recusado !== null ? tokens.access !== recusado : !this.venceu(atual);
        if (jaRenovada) {
          return { acesso: tokens.access };
        }
        if (!tokens.refresh) {
          return {
            recusada: `O ${servico} não deu permissão para renovar o acesso: conecte de novo.`,
          };
        }
        const app = await this.apps.obter(aplicativo);
        if (!app) {
          return {
            recusada: `O app do ${servico} não está mais cadastrado: cadastre-o em Configurações > Apps de login e conecte de novo.`,
          };
        }
        try {
          const novos = await renovarToken(
            aplicativo,
            this.bases(),
            this.buscar(),
            app,
            tokens.refresh,
          );
          // Só grava se a conexão continua como foi lida: um login novo, a troca do app das Configurações ou
          // a exclusão durante a chamada valem mais que esta renovação (o resultado dela é descartado).
          const { count } = await tx.conexaoAplicativo.updateMany({
            where: {
              id: atual.id,
              excluidoEm: null,
              tokensCifrados: atual.tokensCifrados,
            },
            data: {
              tokensCifrados: this.cifrarTokens({
                access: novos.access,
                refresh: novos.refresh ?? tokens.refresh,
              }),
              expiraEm: novos.expiraEmSegundos
                ? new Date(Date.now() + novos.expiraEmSegundos * 1000)
                : null,
              precisaAtencao: false,
              atencaoMotivo: null,
              atencaoEm: null,
            },
          });
          if (count === 0) {
            const agora = await tx.conexaoAplicativo.findFirst({
              where: { id: atual.id, excluidoEm: null },
            });
            const vigentes = agora ? this.lerTokens(agora) : null;
            return vigentes
              ? { acesso: vigentes.access }
              : {
                  recusada:
                    agora?.atencaoMotivo ??
                    `O acesso ao ${servico} mudou durante a renovação: conecte de novo.`,
                };
          }
          return { acesso: novos.access };
        } catch (erro) {
          if (erro instanceof CredencialRecusadaError) {
            return {
              recusada: `O ${servico} recusou renovar o acesso (revogado ou expirado): conecte o ${servico} de novo.`,
            };
          }
          throw erro;
        }
      },
      { timeout: 60_000, maxWait: 10_000 },
    );
    if ('acesso' in resultado) {
      return resultado.acesso;
    }
    throw await this.recusar(conexao, resultado.recusada);
  }

  /** Marca a conexão e as integrações dela como "precisa de atenção" e devolve o erro de credencial recusada. */
  private async recusar(
    conexao: ConexaoAplicativo,
    motivo: string,
  ): Promise<ConexaoRecusadaError> {
    const aplicativo = conexao.aplicativo as AplicativoDeConexao;
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.conexaoAplicativo.updateMany({
        where: { id: conexao.id, precisaAtencao: false },
        data: {
          precisaAtencao: true,
          atencaoMotivo: motivo,
          atencaoEm: new Date(),
        },
      });
      if (count > 0) {
        await this.auditoria.registrar(tx, {
          acao: 'conexao_aplicativo.precisa_atencao',
          entidade: 'conexao_aplicativo',
          entidadeId: conexao.id,
          resumo: `Conexão com o ${NOME_DO_SERVICO[aplicativo]} "${conexao.nome}" precisa de atenção: ${motivo}`,
        });
      }
    });
    for (const integracao of await this.integracoesDaConexao(
      conexao.id,
      aplicativo,
    )) {
      await this.aplicativos.marcarAtencao(integracao, motivo);
    }
    return new ConexaoRecusadaError(motivo);
  }

  /** As integrações (ativas ou não, não excluídas) que usam a conexão; `soAtivas` restringe às ativas. */
  async integracoesDaConexao(
    conexaoId: string,
    aplicativo: AplicativoDeConexao,
    soAtivas = true,
  ) {
    return this.prisma.webhookEntrada.findMany({
      where: {
        aplicativo: APLICATIVO_DA_INTEGRACAO[aplicativo],
        excluidoEm: null,
        ...(soAtivas ? { ativo: true } : {}),
        configuracao: { path: ['conexaoId'], equals: conexaoId },
      },
    });
  }

  // -------------------------------------------------------------------------
  // Apoio
  // -------------------------------------------------------------------------

  private async carregar(id: string): Promise<ConexaoAplicativo> {
    const conexao = await this.prisma.conexaoAplicativo.findFirst({
      where: { id, excluidoEm: null },
    });
    if (!conexao) {
      throw new NaoEncontradoException('Conexão não encontrada.');
    }
    return conexao;
  }

  /** Para uso por uma integração: a conexão que sumiu ou ainda não conectou vira "conecte de novo". */
  private async carregarParaUso(id: string): Promise<ConexaoAplicativo> {
    const conexao = await this.prisma.conexaoAplicativo.findFirst({
      where: { id, excluidoEm: null },
    });
    if (!conexao) {
      throw new RegraVioladaException(
        'R32.25',
        'A conexão desta integração não existe mais: escolha outra ou conecte de novo.',
        { conexaoId: id },
      );
    }
    if (!conexao.tokensCifrados) {
      throw new ConexaoRecusadaError(
        conexao.atencaoMotivo ??
          `Esta conexão ainda não terminou o login com o ${NOME_DO_SERVICO[conexao.aplicativo as AplicativoDeConexao]}: entre de novo.`,
      );
    }
    return conexao;
  }

  private cifrarTokens(tokens: TokensGuardados): string {
    return this.cripto.cifrar(JSON.stringify(tokens));
  }

  private lerTokens(
    conexao: Pick<ConexaoAplicativo, 'tokensCifrados'>,
  ): TokensGuardados | null {
    if (!conexao.tokensCifrados) {
      return null;
    }
    try {
      const valor = objetoDe(
        JSON.parse(this.cripto.decifrar(conexao.tokensCifrados)),
      );
      return typeof valor.access === 'string' && valor.access
        ? {
            access: valor.access,
            refresh:
              typeof valor.refresh === 'string' && valor.refresh
                ? valor.refresh
                : null,
          }
        : null;
    } catch {
      return null;
    }
  }

  private async paraDto(
    conexao: ConexaoAplicativo,
  ): Promise<ConexaoDeAplicativoDto> {
    const aplicativo = conexao.aplicativo as AplicativoDeConexao;
    return {
      id: conexao.id,
      aplicativo,
      nome: conexao.nome,
      conta: conexao.conta,
      conectada: conexao.tokensCifrados !== null,
      conectadaEm: conexao.conectadaEm?.toISOString() ?? null,
      expiraEm: conexao.expiraEm?.toISOString() ?? null,
      integracoes: (
        await this.integracoesDaConexao(conexao.id, aplicativo, false)
      ).length,
      precisaAtencao: conexao.precisaAtencao,
      atencaoMotivo: conexao.atencaoMotivo,
      criadoEm: conexao.criadoEm.toISOString(),
    };
  }
}
