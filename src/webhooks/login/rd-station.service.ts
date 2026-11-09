import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { CriptografiaService } from '../../comum/criptografia/criptografia.service';
import { RegraVioladaException } from '../../comum/erros/excecoes';
import { AMBIENTE, type Ambiente } from '../../config/ambiente';
import type { Prisma, WebhookEntrada } from '../../generated/prisma/client';
import { LogsTecnicosService } from '../../logs/logs-tecnicos.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  buscarCamposDoRd,
  criarWebhookDoRd,
  type GatilhoDoRd,
  listarWebhooksDoRd,
  removerWebhookDoRd,
} from '../aplicativos/rd-station-api';
import { nomeDoCabecalho } from '../aplicativos/rd-station';
import {
  type CampoBuscado,
  ConexaoRecusadaError,
  CredencialRecusadaError,
  type FormularioDoAplicativo,
} from '../aplicativos/tipos';
import {
  AplicativosService,
  type DelegadoDeAplicativo,
  objetoDe,
} from '../entrada/aplicativos.service';
import { montarEndereco } from '../entrada/endereco';

/** O webhook que o CRM criou no RD (guardado em `configuracao.webhookRegistrado`). */
interface WebhookDoRdRegistrado {
  readonly uuid: string;
  readonly conexaoId: string;
  readonly gatilho: GatilhoDoRd;
  readonly conversoes: readonly string[];
  /** Hash do que foi enviado ao RD (endereço, cabeçalho de autenticação, gatilho): mudou, recria. */
  readonly assinatura: string;
  readonly em: string;
}

function lerRegistrado(valor: unknown): WebhookDoRdRegistrado | null {
  const objeto = objetoDe(valor);
  return typeof objeto.uuid === 'string' &&
    typeof objeto.conexaoId === 'string' &&
    typeof objeto.assinatura === 'string'
    ? {
        uuid: objeto.uuid,
        conexaoId: objeto.conexaoId,
        gatilho:
          objeto.gatilho === 'OPORTUNIDADE' ? 'OPORTUNIDADE' : 'CONVERSAO',
        conversoes: Array.isArray(objeto.conversoes)
          ? objeto.conversoes.filter((c): c is string => typeof c === 'string')
          : [],
        assinatura: objeto.assinatura,
        em: typeof objeto.em === 'string' ? objeto.em : '',
      }
    : null;
}

const MENSAGEM_DA_CRIACAO_RECUSADA =
  'O RD Station não criou o webhook: ele testa o endereço do CRM antes de criar (precisa ser público, com HTTPS, e responder 2xx) e o app precisa ter permissão para webhooks.';

/**
 * RD Station por login (R32.26): o lado da integração. Com uma conexão, o CRM **cria o webhook no
 * RD pela API** ao ativar a integração (gatilho "Conversão" ou "Oportunidade", conversões opcionais, o
 * endereço da integração e, se ela tem chave, o cabeçalho de autenticação), guarda o id e o remove ao
 * desativar ou excluir (404 vale como removido). Sem conexão, a integração segue manual (o Admin cola o
 * endereço no RD). "Buscar campos" lê os campos de contato pela API de campos.
 */
@Injectable()
export class RdStationService implements OnModuleInit, DelegadoDeAplicativo {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cripto: CriptografiaService,
    private readonly aplicativos: AplicativosService,
    private readonly logs: LogsTecnicosService,
    @Inject(AMBIENTE) private readonly ambiente: Ambiente,
  ) {}

  onModuleInit(): void {
    this.aplicativos.registrarDelegado('RD_STATION', this);
  }

  private buscar(): typeof fetch {
    return (...argumentos) => globalThis.fetch(...argumentos);
  }

  private base(): string {
    return this.ambiente.integracoes.rdStationUrl;
  }

  // -------------------------------------------------------------------------
  // DelegadoDeAplicativo
  // -------------------------------------------------------------------------

  /** A conexão escolhida já é conferida por `AplicativosService`; o RD não tem página nem formulário. */
  async conferirConfiguracaoNova(): Promise<void> {}

  async buscarCampos(integracao: WebhookEntrada): Promise<CampoBuscado[]> {
    const conexaoId = this.aplicativos.conexaoDaIntegracao(integracao);
    if (!conexaoId) {
      throw new RegraVioladaException(
        'R32.26',
        'Para buscar os campos pela API, entre com o RD Station (escolha uma conexão); no modo manual os campos vêm dos recebimentos.',
      );
    }
    return this.aplicativos
      .provedor()
      .comToken(conexaoId, (token) =>
        buscarCamposDoRd(this.buscar(), this.base(), token),
      );
  }

  async listarFormularios(): Promise<FormularioDoAplicativo[]> {
    return [];
  }

  async camposDoFormulario(): Promise<CampoBuscado[]> {
    return [];
  }

  /**
   * Põe o webhook do RD em dia com a integração: cria ao ativar, recria se o gatilho, as conversões, o
   * endereço ou a chave mudaram e remove ao desativar ou excluir. Não lança: o resultado fica em
   * `configuracao.webhookRegistrado` e `configuracao.webhookErro`.
   */
  async sincronizar(
    id: string,
  ): Promise<{ registrado: boolean; erro: string | null }> {
    // Criar no RD não é idempotente: uma sincronização por integração de cada vez (trava do banco, solta
    // no fim da transação). Quem espera a vez relê a integração e vê o que a anterior deixou.
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`rd-webhook:${id}`}))`;
        return this.sincronizarComTrava(id);
      },
      { timeout: 120_000, maxWait: 60_000 },
    );
  }

  private async sincronizarComTrava(
    id: string,
  ): Promise<{ registrado: boolean; erro: string | null }> {
    const integracao = await this.prisma.webhookEntrada.findUnique({
      where: { id },
    });
    if (!integracao || integracao.aplicativo !== 'RD_STATION') {
      return { registrado: false, erro: null };
    }
    const configuracao = objetoDe(integracao.configuracao);
    const registrado = lerRegistrado(configuracao.webhookRegistrado);
    const conexaoId = this.aplicativos.conexaoDaIntegracao(integracao);
    if (!conexaoId && !registrado) {
      return { registrado: false, erro: null };
    }
    const desejado =
      conexaoId && integracao.ativo && integracao.excluidoEm === null
        ? this.desejado(integracao, conexaoId)
        : null;
    try {
      if (
        registrado &&
        (!desejado || registrado.assinatura !== desejado.assinatura)
      ) {
        await this.aplicativos
          .provedor()
          .comToken(registrado.conexaoId, (token) =>
            removerWebhookDoRd(
              this.buscar(),
              this.base(),
              token,
              registrado.uuid,
            ),
          );
        await this.gravar(id, null, null);
      } else if (registrado && desejado) {
        await this.gravar(id, registrado, null);
        return { registrado: true, erro: null };
      }
      if (!desejado) {
        return { registrado: false, erro: null };
      }
      // O RD pode já ter um webhook para este endereço que o CRM não conhece (a resposta da criação anterior
      // se perdeu, ou foi feito à mão pela API): apaga antes de criar, para não receber cada conversão em dobro.
      await this.removerDoMesmoEndereco(
        desejado.conexaoId,
        desejado.webhook.url,
      );
      let uuid: string;
      try {
        uuid = await this.aplicativos
          .provedor()
          .comToken(desejado.conexaoId, (token) =>
            criarWebhookDoRd(
              this.buscar(),
              this.base(),
              token,
              desejado.webhook,
            ),
          );
      } catch (erro) {
        // 401 depois de renovar o token: o RD recusa criar quando o teste do endereço falha.
        if (
          erro instanceof CredencialRecusadaError &&
          !(erro instanceof ConexaoRecusadaError)
        ) {
          await this.gravar(id, null, MENSAGEM_DA_CRIACAO_RECUSADA);
          return { registrado: false, erro: MENSAGEM_DA_CRIACAO_RECUSADA };
        }
        throw erro;
      }
      await this.gravar(
        id,
        {
          uuid,
          conexaoId: desejado.conexaoId,
          gatilho: desejado.webhook.gatilho,
          conversoes: desejado.webhook.conversoes,
          assinatura: desejado.assinatura,
          em: new Date().toISOString(),
        },
        null,
      );
      await this.aplicativos.limparAtencao(integracao);
      return { registrado: true, erro: null };
    } catch (erro) {
      const mensagem = (await this.aplicativos.traduzirFalha(erro, integracao))
        .mensagem;
      const atual = await this.prisma.webhookEntrada.findUnique({
        where: { id },
        select: { configuracao: true },
      });
      await this.gravar(
        id,
        lerRegistrado(objetoDe(atual?.configuracao).webhookRegistrado),
        mensagem,
      );
      return { registrado: false, erro: mensagem };
    }
  }

  /**
   * Remove o webhook do RD (a integração foi excluída). Se o RD não deixar (fora do ar, conexão recusada),
   * a integração excluída guarda o id e a marca de remoção pendente: o CRM tenta de novo e não deixa
   * excluir a conexão enquanto houver webhook sem remover. Não lança.
   */
  async remover(integracao: WebhookEntrada): Promise<void> {
    const registrado = lerRegistrado(
      objetoDe(integracao.configuracao).webhookRegistrado,
    );
    if (!registrado) {
      return;
    }
    try {
      await this.aplicativos
        .provedor()
        .comToken(registrado.conexaoId, (token) =>
          removerWebhookDoRd(
            this.buscar(),
            this.base(),
            token,
            registrado.uuid,
          ),
        );
      await this.aplicativos.concluirRemocao(integracao.id);
    } catch (erro) {
      await this.aplicativos.marcarRemocaoPendente(integracao.id);
      await this.logs.aviso(
        'Webhooks',
        `Não foi possível remover o webhook do RD Station da integração "${integracao.nome}": ${erro instanceof Error ? erro.message : 'erro desconhecido'}. O CRM tenta de novo.`,
        { integracaoId: integracao.id },
      );
    }
  }

  // -------------------------------------------------------------------------
  // Apoio
  // -------------------------------------------------------------------------

  /** Apaga no RD os webhooks que já apontam para o endereço da integração (o RD recusa endereço repetido por evento). */
  private async removerDoMesmoEndereco(
    conexaoId: string,
    url: string,
  ): Promise<void> {
    if (!url) {
      return;
    }
    const provedor = this.aplicativos.provedor();
    const existentes = await provedor.comToken(conexaoId, (token) =>
      listarWebhooksDoRd(this.buscar(), this.base(), token),
    );
    for (const existente of existentes.filter((w) => w.url === url)) {
      await provedor.comToken(conexaoId, (token) =>
        removerWebhookDoRd(this.buscar(), this.base(), token, existente.uuid),
      );
    }
  }

  /** O webhook que a integração pede ao RD e a assinatura dele (hash, sem guardar o endereço nem a chave). */
  private desejado(integracao: WebhookEntrada, conexaoId: string) {
    const configuracao = objetoDe(integracao.configuracao);
    const gatilho: GatilhoDoRd =
      configuracao.gatilho === 'OPORTUNIDADE' ? 'OPORTUNIDADE' : 'CONVERSAO';
    const conversoes =
      gatilho === 'CONVERSAO' && Array.isArray(configuracao.conversoes)
        ? configuracao.conversoes.filter(
            (c): c is string => typeof c === 'string',
          )
        : [];
    const token = this.aplicativos.lerToken(integracao);
    const url = token ? montarEndereco(this.ambiente.urlPublica, token) : '';
    let chave: string | null = null;
    if (integracao.segredoCifrado) {
      try {
        chave = this.cripto.decifrar(integracao.segredoCifrado);
      } catch {
        chave = null;
      }
    }
    const autenticacao = chave
      ? { cabecalho: nomeDoCabecalho(configuracao), chave }
      : null;
    const assinatura = this.cripto.sha256(
      JSON.stringify([
        conexaoId,
        gatilho,
        conversoes,
        url,
        autenticacao?.cabecalho ?? null,
        autenticacao?.chave ?? null,
      ]),
    );
    return {
      conexaoId,
      assinatura,
      webhook: { gatilho, conversoes, url, autenticacao },
    };
  }

  private async gravar(
    id: string,
    registrado: WebhookDoRdRegistrado | null,
    erro: string | null,
  ): Promise<void> {
    const atual = objetoDe(
      (
        await this.prisma.webhookEntrada.findUniqueOrThrow({
          where: { id },
          select: { configuracao: true },
        })
      ).configuracao,
    );
    const { webhookRegistrado: _antigo, webhookErro: _erro, ...resto } = atual;
    await this.prisma.webhookEntrada.update({
      where: { id },
      data: {
        configuracao: {
          ...resto,
          ...(registrado ? { webhookRegistrado: registrado } : {}),
          ...(erro ? { webhookErro: erro } : {}),
        } as unknown as Prisma.InputJsonObject,
      },
    });
  }
}
