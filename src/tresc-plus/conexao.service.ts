import { Inject, Injectable } from '@nestjs/common';
import { AuditoriaService } from '../auditoria/auditoria.service';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import { CriptografiaService } from '../comum/criptografia/criptografia.service';
import {
  DadosInvalidosException,
  RegraVioladaException,
} from '../comum/erros/excecoes';
import { AMBIENTE, type Ambiente } from '../config/ambiente';
import type { TrescPlusConfig } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  ClienteTrescPlus,
  comoObjeto,
  desembrulhar,
  listaDe,
  numeroDe,
  textoDe,
} from './cliente-tresc-plus';
import { ErroTrescPlus, traduzindo } from './erros-tresc-plus';
import {
  hostDaUrl,
  motivoDaUrlRecusada,
  type RegraDeHostsTrescPlus,
} from './hosts-permitidos';
import type {
  AtualizarConexaoDto,
  ConexaoTrescPlusDto,
  ResultadoDoTesteTrescDto,
} from './tresc-plus.dto';
import {
  CAMINHO_SOCKET_PADRAO,
  REGRA_TRESC_PLUS,
  URL_API_PADRAO,
} from './tresc-plus.constantes';

/** O token como a tela vê: só os 4 últimos caracteres. */
export function mascararToken(final: string | null): string | null {
  return final ? `••••${final}` : null;
}

/** Os 4 últimos caracteres do token (nunca guarda mais que isso em claro). */
export function finalDoToken(token: string): string {
  return token.slice(-4);
}

/** Objeto com o usuário de uma resposta do 3C+ (`/me`, `/authenticate`): `{data: {...}}` ou direto. */
export function usuarioDaResposta(corpo: unknown): Record<string, unknown> {
  const interno = comoObjeto(desembrulhar(corpo));
  return interno ?? {};
}

/** Os hosts da API e do socket (o do socket é o da API quando não há URL própria), para detectar troca. */
function hostsEfetivos(urlApi: string, urlSocket: string | null): string {
  const api = hostDaUrl(urlApi || URL_API_PADRAO);
  const socket = urlSocket ? hostDaUrl(urlSocket) : api;
  return `${api ?? ''}|${socket ?? ''}`;
}

type Observador = () => void | Promise<void>;

/**
 * Conexão da empresa com o 3C+ (R34.1): URLs configuráveis, token do gestor cifrado (R10.3) e nunca
 * devolvido inteiro, campanha padrão do modo manual e "Testar conexão" (`GET /me`).
 */
@Injectable()
export class ConexaoTrescPlusService {
  private readonly observadores: Observador[] = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly cripto: CriptografiaService,
    private readonly auditoria: AuditoriaService,
    @Inject(AMBIENTE) private readonly ambiente: Ambiente,
  ) {}

  /** Regra de hosts permitidos (padrão + `TRESC_PLUS_HOSTS_PERMITIDOS`). */
  private get regraDeHosts(): RegraDeHostsTrescPlus {
    return {
      producao: this.ambiente.producao,
      extras: this.ambiente.trescPlus.hostsPermitidos,
    };
  }

  /**
   * Antes de mandar o token (do gestor ou do vendedor) para o endereço guardado: o host precisa estar na
   * lista de permitidos (R34.1). Protege contra endereço gravado antes da regra ou mudança da lista.
   */
  exigirEnderecoPermitido(
    config: Pick<TrescPlusConfig, 'urlApi' | 'urlSocket'>,
  ): void {
    const motivo =
      motivoDaUrlRecusada(
        config.urlApi || URL_API_PADRAO,
        ['http:', 'https:'],
        this.regraDeHosts,
      ) ??
      (config.urlSocket
        ? motivoDaUrlRecusada(
            config.urlSocket,
            ['http:', 'https:', 'ws:', 'wss:'],
            this.regraDeHosts,
          )
        : null);
    if (motivo) {
      throw new RegraVioladaException(
        REGRA_TRESC_PLUS,
        `O endereço do 3C+ configurado não é aceito (${motivo}). O Admin precisa corrigi-lo em Configurações, Integrações.`,
        { motivo: 'endereco_nao_permitido' },
      );
    }
  }

  /** Quem quer saber quando a conexão muda (o ouvinte reconecta). */
  aoMudar(observador: Observador): void {
    this.observadores.push(observador);
  }

  private async avisarMudanca(): Promise<void> {
    for (const observador of this.observadores) await observador();
  }

  /** A linha de configuração (criada vazia na primeira leitura). */
  async ler(): Promise<TrescPlusConfig> {
    return this.prisma.trescPlusConfig.upsert({
      where: { id: 1 },
      create: { id: 1 },
      update: {},
    });
  }

  async obter(): Promise<ConexaoTrescPlusDto> {
    return this.paraDto(await this.ler());
  }

  paraDto(config: TrescPlusConfig): ConexaoTrescPlusDto {
    return {
      ativa: config.ativa,
      urlApi: config.urlApi,
      urlSocket: config.urlSocket,
      caminhoSocket: config.caminhoSocket,
      formatoEnvelope:
        config.formatoEnvelope as ConexaoTrescPlusDto['formatoEnvelope'],
      tokenConfigurado: config.tokenCifrado !== null,
      token: mascararToken(config.tokenFinal),
      campanhaPadrao:
        config.campanhaPadraoId !== null
          ? { id: config.campanhaPadraoId, nome: config.campanhaPadraoNome }
          : null,
      teste: config.testadaEm
        ? {
            em: config.testadaEm.toISOString(),
            ok: config.testeOk ?? false,
            mensagem: config.testeMensagem,
          }
        : null,
      ouvinte: {
        estado: config.ouvinteEstado,
        em: config.ouvinteEm?.toISOString() ?? null,
      },
      reconciliadaEm: config.reconciliadaEm?.toISOString() ?? null,
    };
  }

  async atualizar(
    usuario: UsuarioAutenticado,
    dto: AtualizarConexaoDto,
  ): Promise<ConexaoTrescPlusDto> {
    const atual = await this.ler();
    const dados: Parameters<
      PrismaService['trescPlusConfig']['update']
    >[0]['data'] = {
      atualizadoPorId: usuario.id,
    };
    if (dto.urlApi !== undefined) {
      const motivo = motivoDaUrlRecusada(
        dto.urlApi,
        ['http:', 'https:'],
        this.regraDeHosts,
      );
      if (motivo) {
        throw new DadosInvalidosException(
          `Dados inválidos — urlApi: ${motivo}. Informe um endereço completo, como https://3c.plus/api/v1.`,
          { campos: [{ campo: 'urlApi', mensagens: [motivo] }] },
        );
      }
      dados.urlApi = dto.urlApi.replace(/\/+$/, '');
    }
    if (dto.urlSocket !== undefined) {
      if (dto.urlSocket === null || dto.urlSocket.trim() === '') {
        dados.urlSocket = null;
      } else {
        const motivo = motivoDaUrlRecusada(
          dto.urlSocket.trim(),
          ['http:', 'https:', 'ws:', 'wss:'],
          this.regraDeHosts,
        );
        if (motivo) {
          throw new DadosInvalidosException(
            `Dados inválidos — urlSocket: ${motivo}.`,
            { campos: [{ campo: 'urlSocket', mensagens: [motivo] }] },
          );
        }
        dados.urlSocket = dto.urlSocket.trim().replace(/\/+$/, '');
      }
    }
    if (dto.caminhoSocket !== undefined) {
      dados.caminhoSocket = dto.caminhoSocket.trim() || CAMINHO_SOCKET_PADRAO;
    }
    if (dto.formatoEnvelope !== undefined)
      dados.formatoEnvelope = dto.formatoEnvelope;
    // Trocou o host da API ou do socket: o token guardado não pode seguir para o novo destino (R34.1). O Admin
    // precisa informar o token de novo e os vendedores conectam de novo.
    const urlApiNova =
      typeof dados.urlApi === 'string' ? dados.urlApi : atual.urlApi;
    const urlSocketNova =
      dados.urlSocket === undefined
        ? atual.urlSocket
        : typeof dados.urlSocket === 'string'
          ? dados.urlSocket
          : null;
    const hostMudou =
      hostsEfetivos(urlApiNova, urlSocketNova) !==
      hostsEfetivos(atual.urlApi, atual.urlSocket);
    const tokenNovo = dto.token !== undefined && dto.token.trim() !== '';
    if (dto.limparToken || (hostMudou && !tokenNovo)) {
      dados.tokenCifrado = null;
      dados.tokenFinal = null;
      dados.ativa = false;
    }
    if (tokenNovo && dto.token !== undefined) {
      const token = dto.token.trim();
      dados.tokenCifrado = this.cripto.cifrar(token);
      dados.tokenFinal = finalDoToken(token);
    }
    if (dto.campanhaPadraoId !== undefined) {
      dados.campanhaPadraoId = dto.campanhaPadraoId;
      dados.campanhaPadraoNome =
        dto.campanhaPadraoId === null ? null : (dto.campanhaPadraoNome ?? null);
    }
    if (dto.ativa !== undefined) {
      const temToken =
        dados.tokenCifrado !== undefined
          ? dados.tokenCifrado
          : atual.tokenCifrado;
      if (dto.ativa && !temToken) {
        throw new RegraVioladaException(
          REGRA_TRESC_PLUS,
          'Informe o token do gestor do 3C+ antes de ativar a integração.',
        );
      }
      dados.ativa = dto.ativa;
    }
    const nova = await this.prisma.$transaction(async (tx) => {
      const gravada = await tx.trescPlusConfig.update({
        where: { id: 1 },
        data: dados,
      });
      if (hostMudou) {
        const vinculos = await tx.trescPlusVinculo.findMany({
          select: { id: true, usuarioId: true, trescUsuarioId: true },
        });
        for (const vinculo of vinculos) {
          await tx.trescPlusVinculo.delete({ where: { id: vinculo.id } });
          await this.auditoria.registrar(tx, {
            acao: 'tresc-plus.vinculo-removido',
            entidade: 'tresc_plus_vinculo',
            entidadeId: vinculo.id,
            resumo:
              'Vínculo com o 3C+ desfeito: o endereço do 3C+ da empresa mudou',
            dados: {
              regra: REGRA_TRESC_PLUS,
              motivo: 'endereco_trocado',
              trescUsuarioId: vinculo.trescUsuarioId,
            },
            relacionados: { usuario: vinculo.usuarioId },
          });
        }
      }
      await this.auditoria.registrar(tx, {
        acao: 'tresc-plus.conexao-atualizada',
        entidade: 'tresc_plus',
        resumo: 'Conexão com o 3C+ atualizada',
        dados: {
          regra: REGRA_TRESC_PLUS,
          ativa: gravada.ativa,
          urlApi: gravada.urlApi,
          urlSocket: gravada.urlSocket,
          tokenAlterado:
            dto.token !== undefined ||
            dto.limparToken === true ||
            dados.tokenCifrado === null,
          enderecoTrocado: hostMudou,
          campanhaPadraoId: gravada.campanhaPadraoId,
        },
      });
      return gravada;
    });
    await this.avisarMudanca();
    return this.paraDto(nova);
  }

  /** `GET /me` com o token do gestor. Grava o resultado e devolve uma mensagem clara. */
  async testar(): Promise<ResultadoDoTesteTrescDto> {
    const config = await this.ler();
    let resultado: ResultadoDoTesteTrescDto;
    if (!config.tokenCifrado) {
      resultado = {
        ok: false,
        mensagem: 'Informe o token do gestor do 3C+.',
        usuario: null,
      };
    } else {
      try {
        const me = usuarioDaResposta(await this.clienteDaEmpresa(config).me());
        const papel = textoDe(me.role);
        const nome = textoDe(me.name) ?? textoDe(me.email);
        const gestor = papel === null || /manager|gestor|admin/i.test(papel);
        resultado = {
          ok: true,
          mensagem: gestor
            ? `Conectado ao 3C+${nome ? ` como ${nome}` : ''}.`
            : `O token funciona, mas é de ${papel}: algumas rotas (listar chamadas, discador) exigem token de gestor.`,
          usuario: { id: numeroDe(me.id), nome, papel },
        };
      } catch (erro) {
        if (!(erro instanceof ErroTrescPlus)) throw erro;
        resultado = { ok: false, mensagem: erro.message, usuario: null };
      }
    }
    await this.prisma.trescPlusConfig.update({
      where: { id: 1 },
      data: {
        testadaEm: new Date(),
        testeOk: resultado.ok,
        testeMensagem: resultado.mensagem,
      },
    });
    return resultado;
  }

  /** O cliente HTTP com o token do gestor. Sem token, 422 claro. */
  clienteDaEmpresa(config?: TrescPlusConfig): ClienteTrescPlus {
    if (!config) throw new Error('Use `clienteDaEmpresaAtual()`.');
    if (!config.tokenCifrado) {
      throw new RegraVioladaException(
        REGRA_TRESC_PLUS,
        'A integração com o 3C+ ainda não foi configurada: o Admin precisa informar o token do gestor.',
      );
    }
    this.exigirEnderecoPermitido(config);
    return new ClienteTrescPlus({
      baseUrl: config.urlApi || URL_API_PADRAO,
      token: this.cripto.decifrar(config.tokenCifrado),
    });
  }

  async clienteDaEmpresaAtual(): Promise<ClienteTrescPlus> {
    return this.clienteDaEmpresa(await this.ler());
  }

  /** Cliente com o token de um vendedor (decifrado só aqui, na hora de usar). */
  clienteDoVendedor(
    config: Pick<TrescPlusConfig, 'urlApi' | 'urlSocket'>,
    tokenCifrado: string,
  ): ClienteTrescPlus {
    this.exigirEnderecoPermitido(config);
    return new ClienteTrescPlus({
      baseUrl: config.urlApi || URL_API_PADRAO,
      token: this.cripto.decifrar(tokenCifrado),
    });
  }

  /** Token do gestor decifrado (só o ouvinte usa, para a query do socket). */
  tokenDaEmpresa(config: TrescPlusConfig): string | null {
    if (!config.tokenCifrado) return null;
    try {
      return this.cripto.decifrar(config.tokenCifrado);
    } catch {
      return null;
    }
  }

  async registrarEstadoDoOuvinte(estado: string): Promise<void> {
    await this.prisma.trescPlusConfig
      .update({
        where: { id: 1 },
        data: { ouvinteEstado: estado, ouvinteEm: new Date() },
      })
      .catch(() => undefined);
  }

  /** Lista de campanhas (com o token do gestor), para escolher a padrão e para o discador. */
  async campanhas(): Promise<
    Array<{ id: number; nome: string; pausada: boolean | null }>
  > {
    const corpo = await traduzindo(async () =>
      (await this.clienteDaEmpresaAtual()).campanhas(),
    );
    return listaDe(corpo).flatMap((item) => {
      const c = comoObjeto(item);
      const id = c ? numeroDe(c.id) : null;
      if (!c || id === null) return [];
      return [
        {
          id,
          nome: textoDe(c.name) ?? `Campanha ${id}`,
          pausada: typeof c.paused === 'boolean' ? c.paused : null,
        },
      ];
    });
  }
}
