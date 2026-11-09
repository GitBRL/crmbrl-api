import { Inject, Injectable } from '@nestjs/common';
import { AuditoriaService } from '../../auditoria/auditoria.service';
import { CriptografiaService } from '../../comum/criptografia/criptografia.service';
import {
  DadosInvalidosException,
  NaoEncontradoException,
  RegraVioladaException,
} from '../../comum/erros/excecoes';
import { resumirProblemas } from '../../comum/validacao/validacao';
import { AMBIENTE, type Ambiente } from '../../config/ambiente';
import type {
  AplicativoIntegracao,
  Prisma,
  WebhookEntrada,
} from '../../generated/prisma/client';
import { LogsTecnicosService } from '../../logs/logs-tecnicos.service';
import { NotificacoesService } from '../../notificacoes/notificacoes.service';
import { TIPOS_NOTIFICACAO } from '../../notificacoes/tipos-notificacao';
import { PrismaService } from '../../prisma/prisma.service';
import { validarProdutos, validarTabelaDeEventos } from '../aplicativos/cursos';
import { adaptadorDe, definicaoDe } from '../aplicativos/registro';
import {
  type AdaptadorDeAplicativo,
  type CampoBuscado,
  type ContextoHttp,
  type Credencial,
  CredencialRecusadaError,
  FalhaNoAplicativoError,
  type FormularioDoAplicativo,
} from '../aplicativos/tipos';
import {
  buscarCamposDoFormulario,
  listarFormulariosDoTypeform,
  registrarWebhookDoTypeform,
  removerWebhookDoTypeform,
} from '../aplicativos/typeform';
import { verificarDestino } from '../saida/protecao-ssrf';
import { montarEndereco } from './endereco';

/** Chaves de `configuracao` que o Admin edita; as demais são do sistema. */
export const CHAVES_EDITAVEIS_DA_CONFIGURACAO = [
  'formularioId',
  'cabecalhoDeAutenticacao',
  // Facebook Lead Ads (R32.14): a conexão, a página e o formulário (`formularioId`, acima).
  'conexaoId',
  'paginaId',
  // RD Station com conexão (R32.26): o gatilho do webhook criado no RD e as conversões (vazio = todas).
  'gatilho',
  'conversoes',
  // Plataformas de curso (R32.15): a tabela de eventos e o filtro por produto.
  'eventos',
  'produtos',
] as const;

const FORMATO_DO_ID_DO_FORMULARIO = /^[A-Za-z0-9_-]{1,100}$/;
const FORMATO_DO_ID_DO_FACEBOOK = /^[0-9]{1,40}$/;
const FORMATO_DO_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const GATILHOS_DO_RD = ['CONVERSAO', 'OPORTUNIDADE'] as const;
const FORMATO_DO_CABECALHO = /^[A-Za-z0-9-]{1,100}$/;

export interface ResultadoDoTeste {
  readonly valida: boolean;
  readonly mensagem: string;
}

/** O estado do webhook que o CRM registrou no aplicativo (guardado em `configuracao.webhookRegistrado`). */
interface WebhookRegistrado {
  readonly formularioId: string;
  readonly tag: string;
  readonly ativo: boolean;
  readonly em: string;
}

/**
 * O que o aplicativo faz por conta própria quando não é só "receber um corpo"
 * (Facebook Lead Ads, R32.14): buscar campos e formulários, validar a escolha
 * e manter a assinatura na ferramenta. Registrado no início da aplicação pelo
 * serviço do aplicativo (sem dependência circular com este).
 */
export interface DelegadoDeAplicativo {
  /** Confere a configuração de uma integração nova (conexão, página e formulário escolhidos). */
  conferirConfiguracaoNova(
    configuracao: Record<string, unknown>,
  ): Promise<void>;
  buscarCampos(integracao: WebhookEntrada): Promise<CampoBuscado[]>;
  listarFormularios(
    integracao: WebhookEntrada,
    busca?: string,
  ): Promise<FormularioDoAplicativo[]>;
  camposDoFormulario(
    integracao: WebhookEntrada,
    formularioId: string,
  ): Promise<CampoBuscado[]>;
  /** Põe a assinatura da ferramenta em dia com a integração (ativa, formulário, exclusão…). Não lança. */
  sincronizar(
    id: string,
  ): Promise<{ registrado: boolean; erro: string | null }>;
  /** Remove o que o CRM registrou na ferramenta (a integração foi excluída). Não lança. */
  remover(integracao: WebhookEntrada): Promise<void>;
}

/**
 * As conexões por login (R32.25 e R32.26), registradas no início da aplicação pelo serviço delas
 * (sem dependência circular com este): confere a conexão escolhida e chama o serviço com o token
 * dela (renovado quando vence e uma vez depois de um 401).
 */
export interface ProvedorDeConexoes {
  /** A conexão existe, é do aplicativo e terminou o login; senão lança 404 ou 422. */
  conferirConexao(
    aplicativo: 'TYPEFORM' | 'RD_STATION',
    conexaoId: string,
  ): Promise<void>;
  comToken<T>(
    conexaoId: string,
    chamada: (token: string) => Promise<T>,
  ): Promise<T>;
}

/** Um webhook que o CRM criou na ferramenta e ainda não conseguiu remover (a integração já foi excluída). */
export interface PendenciaDeRemocao {
  readonly integracaoId: string;
  readonly nome: string;
  readonly aplicativo: AplicativoIntegracao;
  /** O id do webhook na ferramenta (RD: uuid; Typeform: a etiqueta), para apagar à mão. */
  readonly webhookId: string | null;
}

/** O id do webhook guardado na integração (RD: `uuid`; Typeform: `tag`). */
function webhookIdGuardado(integracao: WebhookEntrada): string | null {
  const registrado = objetoDe(
    objetoDe(integracao.configuracao).webhookRegistrado,
  );
  const id = registrado.uuid ?? registrado.tag;
  return typeof id === 'string' ? id : null;
}

export function objetoDe(valor: unknown): Record<string, unknown> {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor)
    ? (valor as Record<string, unknown>)
    : {};
}

/**
 * Operações das integrações que falam com o aplicativo (R32.9): validar,
 * guardar e testar a credencial, buscar campos, listar formulários e registrar o
 * webhook no Typeform. Credencial recusada → a integração "precisa de atenção"
 * e os Admins são avisados (uma vez por ocorrência).
 */
@Injectable()
export class AplicativosService {
  private readonly delegados = new Map<
    AplicativoIntegracao,
    DelegadoDeAplicativo
  >();
  private provedorDeConexoes: ProvedorDeConexoes | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly cripto: CriptografiaService,
    private readonly auditoria: AuditoriaService,
    private readonly notificacoes: NotificacoesService,
    private readonly logs: LogsTecnicosService,
    @Inject(AMBIENTE) private readonly ambiente: Ambiente,
  ) {}

  registrarDelegado(
    aplicativo: AplicativoIntegracao,
    delegado: DelegadoDeAplicativo,
  ): void {
    this.delegados.set(aplicativo, delegado);
  }

  registrarProvedorDeConexoes(provedor: ProvedorDeConexoes): void {
    this.provedorDeConexoes = provedor;
  }

  /** As conexões por login (sempre registradas pelo módulo; o erro é de montagem, não do usuário). */
  provedor(): ProvedorDeConexoes {
    if (!this.provedorDeConexoes) {
      throw new RegraVioladaException(
        'R32.25',
        'As conexões por login não estão disponíveis.',
      );
    }
    return this.provedorDeConexoes;
  }

  /** O `conexaoId` de uma integração do Typeform ou do RD Station que usa uma conexão por login; senão `null`. */
  conexaoDaIntegracao(
    integracao: Pick<WebhookEntrada, 'aplicativo' | 'configuracao'>,
  ): string | null {
    if (
      integracao.aplicativo !== 'TYPEFORM' &&
      integracao.aplicativo !== 'RD_STATION'
    ) {
      return null;
    }
    const conexaoId = objetoDe(integracao.configuracao).conexaoId;
    return typeof conexaoId === 'string' && conexaoId !== '' ? conexaoId : null;
  }

  /** Executa com a credencial da integração: o token da conexão (com renovação) ou o token pessoal guardado. */
  private async comCredencial<T>(
    integracao: WebhookEntrada,
    adaptador: AdaptadorDeAplicativo,
    chamada: (credencial: Credencial) => Promise<T>,
  ): Promise<T> {
    const conexaoId = this.conexaoDaIntegracao(integracao);
    if (conexaoId) {
      return this.provedor().comToken(conexaoId, (token) => chamada({ token }));
    }
    return chamada(this.credencialObrigatoria(integracao, adaptador));
  }

  adaptador(aplicativo: AplicativoIntegracao): AdaptadorDeAplicativo {
    const adaptador = adaptadorDe(aplicativo);
    if (!adaptador) {
      throw new RegraVioladaException(
        'R32.1',
        `O aplicativo ${definicaoDe(aplicativo)?.nome ?? aplicativo} ainda não está disponível.`,
        { aplicativo },
      );
    }
    return adaptador;
  }

  contextoHttp(): ContextoHttp {
    return {
      buscar: (...argumentos) => globalThis.fetch(...argumentos),
      typeformUrl: this.ambiente.integracoes.typeformUrl,
      manychatUrl: this.ambiente.integracoes.manychatUrl,
      verificarEndereco: async (endereco) => {
        const verificado = await verificarDestino(endereco, {
          producao: this.ambiente.producao,
          permitirRedeInterna: this.ambiente.webhooksPermitirRedeInterna,
        });
        if (!verificado.permitido) {
          throw new FalhaNoAplicativoError(
            `Endereço da conta recusado: ${verificado.mensagem}`,
          );
        }
        return verificado.url.toString();
      },
    };
  }

  // -------------------------------------------------------------------------
  // Credencial guardada
  // -------------------------------------------------------------------------

  /**
   * Confere e normaliza a credencial enviada (mesclada com a atual: na edição,
   * só os campos enviados mudam). A URL da conta passa pela proteção SSRF (R9.1).
   * Devolve `null` se o aplicativo não tem credencial.
   */
  async validarCredencial(
    aplicativo: AplicativoIntegracao,
    enviada: Record<string, unknown> | undefined,
    atual: Credencial | null,
    obrigatoria: boolean,
  ): Promise<Credencial | null> {
    const adaptador = this.adaptador(aplicativo);
    const campos = adaptador.definicao.credencial;
    if (!campos || !adaptador.lerCredencial) {
      if (enviada !== undefined) {
        throw erroDeCampo(
          'credencial',
          `o aplicativo ${adaptador.definicao.nome} não usa credencial`,
        );
      }
      return null;
    }
    if (enviada === undefined && !atual) {
      if (obrigatoria) {
        throw erroDeCampo(
          'credencial',
          `é obrigatória para ${adaptador.definicao.nome}: ${campos.map((c) => c.rotulo).join(', ')}`,
        );
      }
      return null;
    }
    if (enviada === undefined) {
      return atual;
    }
    const conhecidas = new Set(campos.map(({ chave }) => chave));
    const desconhecidas = Object.keys(enviada).filter(
      (c) => !conhecidas.has(c),
    );
    if (desconhecidas.length > 0) {
      throw erroDeCampo(
        `credencial.${desconhecidas[0]}`,
        `não é um campo da credencial (use ${[...conhecidas].join(', ')})`,
      );
    }
    const resultado = adaptador.lerCredencial({ ...atual, ...enviada });
    if ('problemas' in resultado) {
      const problemas = resultado.problemas.map(({ campo, mensagem }) => ({
        campo,
        mensagens: [mensagem],
      }));
      throw new DadosInvalidosException(resumirProblemas(problemas), {
        campos: problemas,
      });
    }
    // Um campo não secreto (como a URL da conta) define para onde o segredo
    // vai: ao trocá-lo, o segredo guardado não pode ser reaproveitado (R10.3).
    if (atual) {
      const mudou = campos.find(
        (campo) =>
          !campo.secreto &&
          resultado.credencial[campo.chave] !== atual[campo.chave],
      );
      const semSegredoNovo = campos.find(
        (campo) => campo.secreto && enviada[campo.chave] === undefined,
      );
      if (mudou && semSegredoNovo) {
        throw erroDeCampo(
          `credencial.${semSegredoNovo.chave}`,
          `informe também ${semSegredoNovo.rotulo} ao trocar ${mudou.rotulo}: o valor guardado não é reaproveitado para outro destino`,
        );
      }
    }
    if (aplicativo === 'ACTIVE_CAMPAIGN') {
      const verificado = await verificarDestino(resultado.credencial.urlConta, {
        producao: this.ambiente.producao,
        permitirRedeInterna: this.ambiente.webhooksPermitirRedeInterna,
      });
      if (!verificado.permitido) {
        throw new RegraVioladaException('R9.1', verificado.mensagem, {
          campos: [
            { campo: 'credencial.urlConta', mensagens: [verificado.mensagem] },
          ],
        });
      }
    }
    return resultado.credencial;
  }

  cifrarCredencial(credencial: Credencial | null): string | null {
    return credencial ? this.cripto.cifrar(JSON.stringify(credencial)) : null;
  }

  /** A credencial decifrada, ou `null` se não há (ou se a chave de criptografia mudou). */
  lerCredencialGuardada(
    integracao: Pick<WebhookEntrada, 'credencialCifrada'>,
  ): Credencial | null {
    if (!integracao.credencialCifrada) {
      return null;
    }
    try {
      const valor: unknown = JSON.parse(
        this.cripto.decifrar(integracao.credencialCifrada),
      );
      const objeto = objetoDe(valor);
      return Object.fromEntries(
        Object.entries(objeto).filter(
          (entrada): entrada is [string, string] =>
            typeof entrada[1] === 'string',
        ),
      );
    } catch {
      return null;
    }
  }

  /** `configuracao` do Admin: só as chaves conhecidas e bem formadas; `null` remove a chave. */
  validarConfiguracao(
    aplicativo: AplicativoIntegracao,
    enviada: Record<string, unknown>,
    atual: Record<string, unknown>,
  ): Record<string, unknown> {
    const resultado = { ...atual };
    for (const [chave, valor] of Object.entries(enviada)) {
      if (
        !(CHAVES_EDITAVEIS_DA_CONFIGURACAO as readonly string[]).includes(chave)
      ) {
        throw erroDeCampo(
          `configuracao.${chave}`,
          `não é uma configuração editável (use ${CHAVES_EDITAVEIS_DA_CONFIGURACAO.join(', ')})`,
        );
      }
      if (valor === null) {
        delete resultado[chave];
        continue;
      }
      if (chave === 'conexaoId' || chave === 'paginaId') {
        const conexaoPorLogin =
          chave === 'conexaoId' &&
          (aplicativo === 'TYPEFORM' || aplicativo === 'RD_STATION');
        if (aplicativo !== 'FACEBOOK_LEAD_ADS' && !conexaoPorLogin) {
          throw erroDeCampo(
            `configuracao.${chave}`,
            chave === 'conexaoId'
              ? 'só vale para o Facebook Lead Ads, o Typeform e o RD Station'
              : 'só vale para o Facebook Lead Ads',
          );
        }
        const formato =
          chave === 'conexaoId' ? FORMATO_DO_UUID : FORMATO_DO_ID_DO_FACEBOOK;
        if (typeof valor !== 'string' || !formato.test(valor)) {
          throw erroDeCampo(
            `configuracao.${chave}`,
            chave === 'conexaoId'
              ? 'deve ser o identificador da conexão'
              : 'deve ser o identificador (numérico) da página do Facebook',
          );
        }
      }
      if (chave === 'gatilho' || chave === 'conversoes') {
        if (aplicativo !== 'RD_STATION') {
          throw erroDeCampo(
            `configuracao.${chave}`,
            'só vale para o RD Station',
          );
        }
        if (chave === 'gatilho') {
          if (
            typeof valor !== 'string' ||
            !(GATILHOS_DO_RD as readonly string[]).includes(valor)
          ) {
            throw erroDeCampo(
              'configuracao.gatilho',
              `deve ser um destes valores: ${GATILHOS_DO_RD.join(', ')}`,
            );
          }
        } else {
          const lista = Array.isArray(valor) ? (valor as unknown[]) : null;
          if (
            !lista ||
            lista.length > 50 ||
            lista.some(
              (item) =>
                typeof item !== 'string' ||
                item.trim() === '' ||
                item.length > 100,
            )
          ) {
            throw erroDeCampo(
              'configuracao.conversoes',
              'deve ser uma lista de até 50 identificadores de conversão (textos de até 100 caracteres)',
            );
          }
          resultado.conversoes = [
            ...new Set(lista.map((item) => (item as string).trim())),
          ];
          continue;
        }
      }
      if (chave === 'formularioId') {
        if (aplicativo !== 'TYPEFORM' && aplicativo !== 'FACEBOOK_LEAD_ADS') {
          throw erroDeCampo(
            'configuracao.formularioId',
            'só vale para o Typeform e o Facebook Lead Ads',
          );
        }
        if (
          typeof valor !== 'string' ||
          !(
            aplicativo === 'FACEBOOK_LEAD_ADS'
              ? FORMATO_DO_ID_DO_FACEBOOK
              : FORMATO_DO_ID_DO_FORMULARIO
          ).test(valor)
        ) {
          throw erroDeCampo(
            'configuracao.formularioId',
            'deve ser o identificador do formulário (letras, números, - e _)',
          );
        }
      }
      if (chave === 'cabecalhoDeAutenticacao') {
        if (aplicativo !== 'RD_STATION') {
          throw erroDeCampo(
            'configuracao.cabecalhoDeAutenticacao',
            'só vale para o RD Station',
          );
        }
        if (typeof valor !== 'string' || !FORMATO_DO_CABECALHO.test(valor)) {
          throw erroDeCampo(
            'configuracao.cabecalhoDeAutenticacao',
            'deve ser um nome de cabeçalho HTTP (letras, números e hífen)',
          );
        }
      }
      if (chave === 'eventos' || chave === 'produtos') {
        const adaptador = adaptadorDe(aplicativo);
        if (!adaptador?.definicao.eventos) {
          throw erroDeCampo(
            `configuracao.${chave}`,
            'só vale nas plataformas de curso (Hotmart, Kiwify e Eduzz)',
          );
        }
        const conferido =
          chave === 'eventos'
            ? validarTabelaDeEventos(valor)
            : validarProdutos(valor);
        if ('problema' in conferido) {
          throw erroDeCampo(`configuracao.${chave}`, conferido.problema);
        }
        resultado[chave] = conferido.valor;
        continue;
      }
      resultado[chave] = valor;
    }
    return resultado;
  }

  // -------------------------------------------------------------------------
  // Teste, busca de campos e formulários
  // -------------------------------------------------------------------------

  /** Testa uma credencial ainda não guardada (o assistente, antes de criar). Não grava nada. */
  async testarSemGuardar(
    aplicativo: AplicativoIntegracao,
    enviada: Record<string, unknown>,
  ): Promise<ResultadoDoTeste> {
    const credencial = await this.validarCredencial(
      aplicativo,
      enviada,
      null,
      true,
    );
    return this.chamarTeste(this.adaptador(aplicativo), credencial);
  }

  /** Testa a credencial guardada; recusada → "precisa de atenção"; válida → limpa a atenção. */
  async testarDaIntegracao(id: string): Promise<ResultadoDoTeste> {
    const integracao = await this.carregar(id);
    const adaptador = this.adaptador(integracao.aplicativo);
    const conexaoId = this.conexaoDaIntegracao(integracao);
    const credencial = conexaoId
      ? null
      : this.credencialObrigatoria(integracao, adaptador);
    const resultado = await this.chamarTeste(
      adaptador,
      credencial,
      integracao,
      conexaoId,
    );
    if (resultado.valida) {
      await this.limparAtencao(integracao);
    }
    return resultado;
  }

  /** "Buscar campos da integração": pela credencial; guarda o resultado em `configuracao.camposBuscados`. */
  async buscarCampos(
    id: string,
  ): Promise<{ campos: CampoBuscado[]; buscadosEm: string }> {
    const integracao = await this.carregar(id);
    const adaptador = this.adaptador(integracao.aplicativo);
    const delegado = this.delegados.get(integracao.aplicativo);
    if (!adaptador.buscarCampos && !delegado) {
      throw new RegraVioladaException(
        'R32.8',
        `O aplicativo ${adaptador.definicao.nome} não busca campos: os campos vêm dos recebimentos.`,
      );
    }
    let campos: CampoBuscado[];
    try {
      campos = delegado
        ? await delegado.buscarCampos(integracao)
        : await this.comCredencial(integracao, adaptador, (credencial) =>
            adaptador.buscarCampos!(
              credencial,
              objetoDe(integracao.configuracao),
              this.contextoHttp(),
            ),
          );
    } catch (erro) {
      throw await this.traduzirFalha(erro, integracao);
    }
    await this.limparAtencao(integracao);
    const buscadosEm = new Date().toISOString();
    await this.prisma.webhookEntrada.update({
      where: { id },
      data: {
        configuracao: {
          ...objetoDe(integracao.configuracao),
          camposBuscados: campos,
          camposBuscadosEm: buscadosEm,
        } as unknown as Prisma.InputJsonObject,
      },
    });
    return { campos, buscadosEm };
  }

  async listarFormularios(
    id: string,
    busca?: string,
  ): Promise<FormularioDoAplicativo[]> {
    const integracao = await this.carregar(id);
    const adaptador = this.adaptador(integracao.aplicativo);
    if (!adaptador.definicao.escolheFormulario) {
      throw new RegraVioladaException(
        'R32.8',
        `O aplicativo ${adaptador.definicao.nome} não tem formulários para escolher.`,
      );
    }
    const delegado = this.delegados.get(integracao.aplicativo);
    try {
      const formularios = delegado
        ? await delegado.listarFormularios(integracao, busca)
        : await this.comCredencial(integracao, adaptador, (credencial) =>
            listarFormulariosDoTypeform(credencial, this.contextoHttp(), busca),
          );
      await this.limparAtencao(integracao);
      return formularios;
    } catch (erro) {
      throw await this.traduzirFalha(erro, integracao);
    }
  }

  async camposDoFormulario(
    id: string,
    formularioId: string,
  ): Promise<CampoBuscado[]> {
    const integracao = await this.carregar(id);
    const adaptador = this.adaptador(integracao.aplicativo);
    if (!adaptador.definicao.escolheFormulario) {
      throw new RegraVioladaException(
        'R32.8',
        `O aplicativo ${adaptador.definicao.nome} não tem formulários para escolher.`,
      );
    }
    if (!FORMATO_DO_ID_DO_FORMULARIO.test(formularioId)) {
      throw erroDeCampo('formularioId', 'identificador de formulário inválido');
    }
    const delegado = this.delegados.get(integracao.aplicativo);
    try {
      return delegado
        ? await delegado.camposDoFormulario(integracao, formularioId)
        : await this.comCredencial(integracao, adaptador, (credencial) =>
            buscarCamposDoFormulario(
              credencial,
              this.contextoHttp(),
              formularioId,
            ),
          );
    } catch (erro) {
      throw await this.traduzirFalha(erro, integracao);
    }
  }

  // -------------------------------------------------------------------------
  // Webhook do Typeform
  // -------------------------------------------------------------------------

  /** O aplicativo registra algo na ferramenta (Typeform: webhook; Facebook: assinatura da página)? */
  registraNaFerramenta(aplicativo: AplicativoIntegracao): boolean {
    return aplicativo === 'TYPEFORM' || this.delegados.has(aplicativo);
  }

  /** Põe o que o CRM registrou na ferramenta em dia com a integração (Typeform ou Facebook). */
  async sincronizarComAFerramenta(
    id: string,
  ): Promise<{ registrado: boolean; erro: string | null }> {
    const integracao = await this.prisma.webhookEntrada.findUnique({
      where: { id },
      select: { aplicativo: true },
    });
    const delegado = integracao
      ? this.delegados.get(integracao.aplicativo)
      : undefined;
    return delegado
      ? delegado.sincronizar(id)
      : this.sincronizarWebhookDoTypeform(id);
  }

  /** Remove da ferramenta o que o CRM registrou (a integração foi excluída). */
  async removerDaFerramenta(integracao: WebhookEntrada): Promise<void> {
    const delegado = this.delegados.get(integracao.aplicativo);
    if (delegado) {
      await delegado.remover(integracao);
      return;
    }
    await this.removerWebhookDoTypeform(integracao);
  }

  /**
   * A remoção na ferramenta falhou (fora do ar, conexão recusada…): a integração, já excluída, guarda o id do
   * webhook e a marca `webhookRemocaoPendente`, para tentar de novo (job periódico e exclusão da conexão).
   */
  async marcarRemocaoPendente(id: string): Promise<void> {
    await this.atualizarConfiguracao(id, (resto) => ({
      ...resto,
      webhookRemocaoPendente: true,
    }));
  }

  /** O webhook foi removido da ferramenta: some o id guardado e a marca de pendência. */
  async concluirRemocao(id: string): Promise<void> {
    await this.atualizarConfiguracao(id, (resto) => {
      const {
        webhookRegistrado: _registrado,
        webhookRemocaoPendente: _pendente,
        ...limpo
      } = resto;
      return limpo;
    });
  }

  /**
   * Tenta de novo as remoções que falharam (de uma conexão, ou de todas) e devolve as que continuam
   * pendentes, com o que o Admin precisa saber para apagar o webhook na ferramenta à mão.
   */
  async refazerRemocoesPendentes(
    conexaoId?: string,
  ): Promise<PendenciaDeRemocao[]> {
    const integracoes = await this.prisma.webhookEntrada.findMany({
      where: {
        excluidoEm: { not: null },
        aplicativo: { in: ['TYPEFORM', 'RD_STATION'] },
        AND: [
          { configuracao: { path: ['webhookRemocaoPendente'], equals: true } },
          ...(conexaoId
            ? [{ configuracao: { path: ['conexaoId'], equals: conexaoId } }]
            : []),
        ],
      },
      orderBy: { criadoEm: 'asc' },
      take: 200,
    });
    const restantes: PendenciaDeRemocao[] = [];
    for (const integracao of integracoes) {
      await this.removerDaFerramenta(integracao);
      const atual = await this.prisma.webhookEntrada.findUnique({
        where: { id: integracao.id },
        select: { configuracao: true },
      });
      if (objetoDe(atual?.configuracao).webhookRemocaoPendente === true) {
        restantes.push({
          integracaoId: integracao.id,
          nome: integracao.nome,
          aplicativo: integracao.aplicativo,
          webhookId: webhookIdGuardado(integracao),
        });
      }
    }
    return restantes;
  }

  private async atualizarConfiguracao(
    id: string,
    alterar: (atual: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<void> {
    const linha = await this.prisma.webhookEntrada.findUnique({
      where: { id },
      select: { configuracao: true },
    });
    if (!linha) {
      return;
    }
    await this.prisma.webhookEntrada.update({
      where: { id },
      data: {
        configuracao: alterar(
          objetoDe(linha.configuracao),
        ) as unknown as Prisma.InputJsonObject,
      },
    });
  }

  /** Confere a configuração de uma integração nova (aplicativos com escolhas próprias). */
  async conferirConfiguracaoNova(
    aplicativo: AplicativoIntegracao,
    configuracao: Record<string, unknown>,
  ): Promise<void> {
    await this.delegados
      .get(aplicativo)
      ?.conferirConfiguracaoNova(configuracao);
    // Typeform e RD Station por login: a conexão escolhida existe, é do aplicativo e já conectou.
    const conexaoId = configuracao.conexaoId;
    if (
      (aplicativo === 'TYPEFORM' || aplicativo === 'RD_STATION') &&
      typeof conexaoId === 'string'
    ) {
      await this.provedor().conferirConexao(aplicativo, conexaoId);
    }
  }

  /**
   * Põe o webhook do formulário em dia com a integração (R32.9): registra no
   * formulário escolhido, com o segredo e o endereço (habilitado só com a
   * integração ativa); se o formulário mudou, remove o webhook do antigo. Não
   * lança: o resultado fica em `configuracao.webhookRegistrado` e
   * `configuracao.webhookErro` (e a credencial recusada marca a atenção).
   */
  async sincronizarWebhookDoTypeform(
    id: string,
  ): Promise<{ registrado: boolean; erro: string | null }> {
    const integracao = await this.prisma.webhookEntrada.findUnique({
      where: { id },
    });
    if (!integracao || integracao.aplicativo !== 'TYPEFORM') {
      return { registrado: false, erro: null };
    }
    const configuracao = objetoDe(integracao.configuracao);
    const registrado = lerRegistrado(configuracao.webhookRegistrado);
    const desejado =
      integracao.excluidoEm === null &&
      typeof configuracao.formularioId === 'string'
        ? configuracao.formularioId
        : null;
    const conexaoId = this.conexaoDaIntegracao(integracao);
    const credencial = conexaoId
      ? null
      : this.lerCredencialGuardada(integracao);
    const http = this.contextoHttp();
    /** O token pessoal guardado, ou o da conexão (renovado quando vence e depois de um 401). */
    const executar = <T>(
      chamada: (cred: Credencial) => Promise<T>,
    ): Promise<T> =>
      conexaoId
        ? this.provedor().comToken(conexaoId, (token) => chamada({ token }))
        : chamada(credencial as Credencial);
    const gravar = async (
      novo: WebhookRegistrado | null,
      erro: string | null,
    ): Promise<void> => {
      const atual = objetoDe(
        (
          await this.prisma.webhookEntrada.findUniqueOrThrow({
            where: { id },
            select: { configuracao: true },
          })
        ).configuracao,
      );
      const {
        webhookRegistrado: _antigo,
        webhookErro: _erro,
        ...resto
      } = atual;
      await this.prisma.webhookEntrada.update({
        where: { id },
        data: {
          configuracao: {
            ...resto,
            ...(novo ? { webhookRegistrado: novo } : {}),
            ...(erro ? { webhookErro: erro } : {}),
          } as unknown as Prisma.InputJsonObject,
        },
      });
    };
    if (!credencial && !conexaoId) {
      const erro =
        'Sem credencial do Typeform legível: informe o token novamente.';
      if (desejado) {
        await gravar(registrado, erro);
      }
      return { registrado: false, erro: desejado ? erro : null };
    }
    try {
      if (registrado && registrado.formularioId !== desejado) {
        await executar((cred) =>
          removerWebhookDoTypeform(
            cred,
            http,
            registrado.formularioId,
            registrado.tag,
          ),
        );
      }
      if (!desejado) {
        await gravar(null, null);
        return { registrado: false, erro: null };
      }
      const token = this.lerToken(integracao);
      if (!token || !integracao.segredoCifrado) {
        const erro =
          'O endereço desta integração não pode ser lido (criada antes da Onda H): regenere o token para registrar o webhook.';
        await gravar(null, erro);
        return { registrado: false, erro };
      }
      const tag = registrado?.tag ?? tagDoWebhook(integracao.id);
      const segredoDoWebhook = this.cripto.decifrar(integracao.segredoCifrado);
      await executar((cred) =>
        registrarWebhookDoTypeform(cred, http, {
          formularioId: desejado,
          tag,
          url: montarEndereco(this.ambiente.urlPublica, token),
          segredo: segredoDoWebhook,
          ativo: integracao.ativo,
        }),
      );
      await gravar(
        {
          formularioId: desejado,
          tag,
          ativo: integracao.ativo,
          em: new Date().toISOString(),
        },
        null,
      );
      await this.limparAtencao(integracao);
      return { registrado: true, erro: null };
    } catch (erro) {
      const traduzido = await this.traduzirFalha(erro, integracao);
      const mensagem = traduzido.mensagem;
      await gravar(registrado, mensagem);
      return { registrado: false, erro: mensagem };
    }
  }

  /** Remove o webhook do formulário (a integração foi excluída). Falhas só vão para o log: a exclusão segue. */
  async removerWebhookDoTypeform(integracao: WebhookEntrada): Promise<void> {
    if (integracao.aplicativo !== 'TYPEFORM') {
      return;
    }
    const registrado = lerRegistrado(
      objetoDe(integracao.configuracao).webhookRegistrado,
    );
    const conexaoId = this.conexaoDaIntegracao(integracao);
    const credencial = conexaoId
      ? null
      : this.lerCredencialGuardada(integracao);
    if (!registrado || (!credencial && !conexaoId)) {
      return;
    }
    try {
      const http = this.contextoHttp();
      const remover = (cred: Credencial) =>
        removerWebhookDoTypeform(
          cred,
          http,
          registrado.formularioId,
          registrado.tag,
        );
      if (conexaoId) {
        await this.provedor().comToken(conexaoId, (token) =>
          remover({ token }),
        );
      } else {
        await remover(credencial as Credencial);
      }
      await this.concluirRemocao(integracao.id);
    } catch (erro) {
      await this.marcarRemocaoPendente(integracao.id);
      await this.logs.aviso(
        'Webhooks',
        `Não foi possível remover o webhook do formulário do Typeform da integração "${integracao.nome}": ${erro instanceof Error ? erro.message : 'erro desconhecido'}. O CRM tenta de novo.`,
        { integracaoId: integracao.id },
      );
    }
  }

  /** O token do endereço, decifrado (nulo nos pontos antigos ou se a chave de criptografia mudou). */
  lerToken(integracao: Pick<WebhookEntrada, 'tokenCifrado'>): string | null {
    if (!integracao.tokenCifrado) {
      return null;
    }
    try {
      return this.cripto.decifrar(integracao.tokenCifrado);
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Situação "precisa de atenção" (R32.9)
  // -------------------------------------------------------------------------

  async marcarAtencao(
    integracao: WebhookEntrada,
    motivo: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.webhookEntrada.updateMany({
        where: { id: integracao.id, precisaAtencao: false },
        data: {
          precisaAtencao: true,
          atencaoMotivo: motivo,
          atencaoEm: new Date(),
        },
      });
      if (count === 0) {
        await tx.webhookEntrada.updateMany({
          where: { id: integracao.id },
          data: { atencaoMotivo: motivo, atencaoEm: new Date() },
        });
        return;
      }
      await this.auditoria.registrar(tx, {
        acao: 'webhook_entrada.precisa_atencao',
        entidade: 'webhook_entrada',
        entidadeId: integracao.id,
        resumo: `Integração "${integracao.nome}" precisa de atenção: ${motivo}`,
        dados: { aplicativo: integracao.aplicativo },
        relacionados: { funil: integracao.funilId },
      });
      await this.notificacoes.notificarAdmins(tx, {
        tipo: TIPOS_NOTIFICACAO.INTEGRACAO_PRECISA_ATENCAO,
        titulo: `A integração "${integracao.nome}" precisa de atenção`,
        texto: `${motivo} Atualize a credencial para voltar a funcionar.`,
        link: `/integracoes?integracao=${integracao.id}`,
        dados: {
          integracaoId: integracao.id,
          aplicativo: integracao.aplicativo,
        },
      });
    });
  }

  async limparAtencao(
    integracao: Pick<
      WebhookEntrada,
      'id' | 'nome' | 'precisaAtencao' | 'funilId'
    >,
  ): Promise<void> {
    if (!integracao.precisaAtencao) {
      return;
    }
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.webhookEntrada.updateMany({
        where: { id: integracao.id, precisaAtencao: true },
        data: { precisaAtencao: false, atencaoMotivo: null, atencaoEm: null },
      });
      if (count > 0) {
        await this.auditoria.registrar(tx, {
          acao: 'webhook_entrada.atencao_resolvida',
          entidade: 'webhook_entrada',
          entidadeId: integracao.id,
          resumo: `Integração "${integracao.nome}" voltou a funcionar (credencial aceita)`,
          relacionados: { funil: integracao.funilId },
        });
      }
    });
  }

  // -------------------------------------------------------------------------
  // Apoio
  // -------------------------------------------------------------------------

  private async carregar(id: string): Promise<WebhookEntrada> {
    const integracao = await this.prisma.webhookEntrada.findFirst({
      where: { id, excluidoEm: null },
    });
    if (!integracao) {
      throw new NaoEncontradoException('Integração não encontrada.');
    }
    return integracao;
  }

  private credencialObrigatoria(
    integracao: WebhookEntrada,
    adaptador: AdaptadorDeAplicativo,
  ): Credencial {
    if (!adaptador.definicao.credencial) {
      throw new RegraVioladaException(
        'R32.8',
        `O aplicativo ${adaptador.definicao.nome} não usa credencial.`,
      );
    }
    const credencial = this.lerCredencialGuardada(integracao);
    if (!credencial) {
      throw new RegraVioladaException(
        'R32.8',
        integracao.credencialCifrada
          ? 'A credencial guardada não pode ser lida (a CHAVE_CRIPTOGRAFIA mudou?): informe-a novamente.'
          : 'Esta integração não tem credencial: informe-a primeiro.',
      );
    }
    return credencial;
  }

  private async chamarTeste(
    adaptador: AdaptadorDeAplicativo,
    credencial: Credencial | null,
    integracao?: WebhookEntrada,
    conexaoId: string | null = null,
  ): Promise<ResultadoDoTeste> {
    if (!adaptador.testarCredencial || (!credencial && !conexaoId)) {
      throw new RegraVioladaException(
        'R32.8',
        `O aplicativo ${adaptador.definicao.nome} não usa credencial.`,
      );
    }
    try {
      const testar = adaptador.testarCredencial.bind(adaptador);
      if (conexaoId) {
        await this.provedor().comToken(conexaoId, (token) =>
          testar({ token }, this.contextoHttp()),
        );
      } else {
        await testar(credencial as Credencial, this.contextoHttp());
      }
      return { valida: true, mensagem: 'Credencial aceita.' };
    } catch (erro) {
      if (erro instanceof CredencialRecusadaError) {
        if (integracao) {
          await this.marcarAtencao(integracao, erro.message);
        }
        return { valida: false, mensagem: erro.message };
      }
      if (erro instanceof FalhaNoAplicativoError) {
        return { valida: false, mensagem: erro.message };
      }
      throw erro;
    }
  }

  /** Credencial recusada → marca a atenção e responde 422; outra falha → 422 com a mensagem. */
  async traduzirFalha(
    erro: unknown,
    integracao: WebhookEntrada,
  ): Promise<RegraVioladaException> {
    if (erro instanceof CredencialRecusadaError) {
      await this.marcarAtencao(integracao, erro.message);
      return new RegraVioladaException('R32.9', erro.message, {
        precisaAtencao: true,
      });
    }
    if (erro instanceof FalhaNoAplicativoError) {
      return new RegraVioladaException('R32.8', erro.message);
    }
    throw erro;
  }
}

function erroDeCampo(campo: string, mensagem: string): DadosInvalidosException {
  const campos = [{ campo, mensagens: [mensagem] }];
  return new DadosInvalidosException(resumirProblemas(campos), { campos });
}

/** A tag do webhook no Typeform (letras, números, - e _): estável para a integração. */
export function tagDoWebhook(integracaoId: string): string {
  return `crmbrl-${integracaoId.replace(/-/g, '').slice(0, 16)}`;
}

function lerRegistrado(valor: unknown): WebhookRegistrado | null {
  const objeto = objetoDe(valor);
  return typeof objeto.formularioId === 'string' &&
    typeof objeto.tag === 'string'
    ? {
        formularioId: objeto.formularioId,
        tag: objeto.tag,
        ativo: objeto.ativo === true,
        em: typeof objeto.em === 'string' ? objeto.em : '',
      }
    : null;
}
