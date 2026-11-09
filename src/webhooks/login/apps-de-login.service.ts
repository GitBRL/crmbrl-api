import { Inject, Injectable } from '@nestjs/common';
import { AuditoriaService } from '../../auditoria/auditoria.service';
import { PREFIXO_DAS_ROTAS, VERSAO_PADRAO_DA_API } from '../../aplicacao';
import type { UsuarioAutenticado } from '../../auth/usuario-autenticado';
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
  AplicativoIntegracao,
  Prisma,
} from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AplicativosService, objetoDe } from '../entrada/aplicativos.service';
import { ESCOPOS_DO_FACEBOOK } from '../facebook/escopos';
import {
  ClienteDaGraphFacebook,
  ErroDaGraph,
} from '../facebook/graph-facebook';
import type { AppDeLoginDto, GravarAppDeLoginDto } from './apps-de-login.dto';
import { ESCOPOS_DO_TYPEFORM } from './clientes-oauth';

const NOME_DO_APP: Readonly<Record<AplicativoDeLogin, string>> = {
  META: 'Meta (Facebook, Instagram e Messenger)',
  TYPEFORM: 'Typeform',
  RD_STATION: 'RD Station',
};

/** "O app da Meta", "O app do Typeform", "O app do RD Station". */
const ARTIGO_DO_APP: Readonly<Record<AplicativoDeLogin, string>> = {
  META: 'da Meta',
  TYPEFORM: 'do Typeform',
  RD_STATION: 'do RD Station',
};

const FORMATO_DO_ID_DA_META = /^[0-9]{1,40}$/;
const FORMATO_DO_CLIENT_ID = /^[A-Za-z0-9._~-]{1,200}$/;

export const MOTIVO_DA_TROCA_DE_APP =
  'O app de login mudou nas Configurações: conecte de novo.';

/** O app de um serviço, decifrado (só dentro da API). */
export interface AppDecifrado {
  readonly clientId: string;
  readonly segredo: string;
  readonly tokenVerificacao: string | null;
}

export interface EmUsoDoApp {
  readonly conexoes: number;
  readonly canais: number;
  readonly integracoes: number;
}

function erroDeCampo(campo: string, mensagem: string): DadosInvalidosException {
  const campos = [{ campo, mensagens: [mensagem] }];
  return new DadosInvalidosException(resumirProblemas(campos), { campos });
}

const APLICATIVO_DA_INTEGRACAO: Readonly<
  Record<AplicativoDeLogin, AplicativoIntegracao>
> = {
  META: 'FACEBOOK_LEAD_ADS',
  TYPEFORM: 'TYPEFORM',
  RD_STATION: 'RD_STATION',
};

/**
 * Apps de login (R32.22): o app de cada serviço (Meta, Typeform, RD Station) é cadastrado uma vez
 * pelo Admin em Configurações; o segredo fica cifrado (R10.3) e nunca volta. As conexões do
 * Facebook e os canais Messenger e Instagram criados com o app da Meta **copiam** o ID e o
 * segredo (e ganham a marca `appDasConfiguracoes`), como já faziam; trocar o segredo atualiza as
 * cópias marcadas na mesma transação. Trocar o ID de um app em uso exige confirmação e deixa
 * as conexões e os canais dele "precisam de atenção".
 */
@Injectable()
export class AppsDeLoginService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cripto: CriptografiaService,
    private readonly auditoria: AuditoriaService,
    private readonly aplicativos: AplicativosService,
    @Inject(AMBIENTE) private readonly ambiente: Ambiente,
  ) {}

  // -------------------------------------------------------------------------
  // Leitura interna (para o login e as conexões)
  // -------------------------------------------------------------------------

  /** O app decifrado, ou `null` se não foi cadastrado (ou se a chave de criptografia mudou). */
  async obter(aplicativo: AplicativoDeLogin): Promise<AppDecifrado | null> {
    const app = await this.prisma.appDeLogin.findUnique({
      where: { aplicativo },
    });
    if (!app) {
      return null;
    }
    try {
      return {
        clientId: app.clientId,
        segredo: this.cripto.decifrar(app.segredoCifrado),
        tokenVerificacao: app.tokenVerificacaoCifrado
          ? this.cripto.decifrar(app.tokenVerificacaoCifrado)
          : null,
      };
    } catch {
      return null;
    }
  }

  /** O app, ou 422 com a orientação de cadastrá-lo. */
  async exigir(aplicativo: AplicativoDeLogin): Promise<AppDecifrado> {
    const app = await this.obter(aplicativo);
    if (!app) {
      throw new RegraVioladaException(
        'R32.22',
        `O app ${ARTIGO_DO_APP[aplicativo]} ainda não foi cadastrado. Cadastre-o em Configurações > Apps de login.`,
        { aplicativo, appNaoCadastrado: true },
      );
    }
    return app;
  }

  /** O `hub.verify_token` do desafio GET do webhook de páginas vale se é o do app da Meta (tempo constante). */
  async tokenDeVerificacaoValido(token: string): Promise<boolean> {
    const app = await this.obter('META');
    return (
      app?.tokenVerificacao != null &&
      app.tokenVerificacao !== '' &&
      this.cripto.compararSeguro(app.tokenVerificacao, token)
    );
  }

  // -------------------------------------------------------------------------
  // Configurações (só Admin)
  // -------------------------------------------------------------------------

  async listar(): Promise<AppDeLoginDto[]> {
    return Promise.all(
      (['META', 'TYPEFORM', 'RD_STATION'] as const).map((aplicativo) =>
        this.paraDto(aplicativo),
      ),
    );
  }

  async detalhar(aplicativo: AplicativoDeLogin): Promise<AppDeLoginDto> {
    return this.paraDto(aplicativo);
  }

  async gravar(
    usuario: UsuarioAutenticado,
    aplicativo: AplicativoDeLogin,
    dto: GravarAppDeLoginDto,
  ): Promise<AppDeLoginDto> {
    const clientId = dto.clientId.trim();
    if (
      !(
        aplicativo === 'META' ? FORMATO_DO_ID_DA_META : FORMATO_DO_CLIENT_ID
      ).test(clientId)
    ) {
      throw erroDeCampo(
        'clientId',
        aplicativo === 'META'
          ? 'deve ser o ID numérico do app da Meta'
          : 'deve ter só letras, números, ponto, hífen e sublinhado',
      );
    }
    const atual = await this.prisma.appDeLogin.findUnique({
      where: { aplicativo },
    });
    const decifrado = atual ? await this.obter(aplicativo) : null;
    const segredoNovo = dto.segredo?.trim() || undefined;
    if (!atual && !segredoNovo) {
      throw erroDeCampo('segredo', 'é obrigatório na primeira gravação');
    }
    const trocouId = atual !== null && atual.clientId !== clientId;
    if (trocouId && !segredoNovo) {
      throw erroDeCampo(
        'segredo',
        'informe também o segredo ao trocar o ID: o segredo guardado é do app anterior',
      );
    }
    const segredo = segredoNovo ?? decifrado?.segredo;
    if (!segredo) {
      // O segredo guardado não pode ser lido (a CHAVE_CRIPTOGRAFIA mudou?): precisa ser informado de novo.
      throw erroDeCampo(
        'segredo',
        'o segredo guardado não pode ser lido: informe-o de novo',
      );
    }
    const mudouSegredo =
      segredoNovo !== undefined &&
      (decifrado === null || segredoNovo !== decifrado.segredo);
    if (atual && !trocouId && !mudouSegredo) {
      return this.paraDto(aplicativo);
    }
    const emUso = await this.emUso(aplicativo);
    const temUso = emUso.conexoes + emUso.canais + emUso.integracoes > 0;
    if (trocouId && temUso && dto.confirmarTroca !== true) {
      throw new ConflitoException(
        `Este app está em uso (${emUso.conexoes} conexão(ões), ${emUso.canais} canal(is), ${emUso.integracoes} integração(ões)). Trocar o ID deixa tudo isso "precisa de atenção" até conectar de novo: confirme a troca para continuar.`,
        { regra: 'R32.22', emUso, confirmarTroca: true },
      );
    }
    if (aplicativo === 'META') {
      await this.conferirParComAMeta(clientId, segredo);
    }
    const marcadas = await this.prisma.$transaction(async (tx) => {
      const tokenVerificacaoCifrado =
        aplicativo === 'META'
          ? (atual?.tokenVerificacaoCifrado ??
            this.cripto.cifrar(this.cripto.gerarToken(24)))
          : null;
      await tx.appDeLogin.upsert({
        where: { aplicativo },
        create: {
          aplicativo,
          clientId,
          segredoCifrado: this.cripto.cifrar(segredo),
          tokenVerificacaoCifrado,
          atualizadoPorId: usuario.id,
        },
        update: {
          clientId,
          ...(segredoNovo
            ? { segredoCifrado: this.cripto.cifrar(segredoNovo) }
            : {}),
          tokenVerificacaoCifrado,
          atualizadoPorId: usuario.id,
        },
      });
      const propagadas =
        atual && (mudouSegredo || trocouId)
          ? await this.propagar(tx, aplicativo, clientId, segredo, trocouId)
          : { conexoes: [] as string[], canais: 0 };
      await this.auditoria.registrar(tx, {
        acao: atual ? 'app_de_login.atualizado' : 'app_de_login.configurado',
        entidade: 'app_de_login',
        entidadeId: aplicativo,
        resumo: atual
          ? `App de login ${NOME_DO_APP[aplicativo]} atualizado (${[
              trocouId ? 'ID' : null,
              mudouSegredo ? 'segredo' : null,
            ]
              .filter(Boolean)
              .join(' e ')})`
          : `App de login ${NOME_DO_APP[aplicativo]} configurado`,
        // Só os nomes dos campos e as contagens: nunca o ID, o segredo nem o token.
        dados: atual
          ? {
              campos: [
                ...(trocouId ? ['clientId'] : []),
                ...(mudouSegredo ? ['segredo'] : []),
              ],
              confirmouTroca: trocouId && temUso,
              conexoes: propagadas.conexoes.length,
              canais: propagadas.canais,
            }
          : { campos: ['clientId', 'segredo'] },
      });
      return propagadas.conexoes;
    });
    if (trocouId && marcadas.length > 0) {
      await this.marcarIntegracoes(aplicativo, marcadas);
    }
    return this.paraDto(aplicativo);
  }

  async remover(aplicativo: AplicativoDeLogin): Promise<void> {
    const atual = await this.prisma.appDeLogin.findUnique({
      where: { aplicativo },
    });
    if (!atual) {
      throw new NaoEncontradoException(
        `O app ${ARTIGO_DO_APP[aplicativo]} não está cadastrado.`,
      );
    }
    const emUso = await this.emUso(aplicativo);
    if (emUso.conexoes + emUso.canais + emUso.integracoes > 0) {
      throw new ConflitoException(
        `Este app está em uso (${emUso.conexoes} conexão(ões), ${emUso.canais} canal(is), ${emUso.integracoes} integração(ões)): exclua-os ou troque o app deles antes de remover.`,
        { regra: 'R32.22', emUso },
      );
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.appDeLogin.delete({ where: { aplicativo } });
      await this.auditoria.registrar(tx, {
        acao: 'app_de_login.removido',
        entidade: 'app_de_login',
        entidadeId: aplicativo,
        resumo: `App de login ${NOME_DO_APP[aplicativo]} removido`,
      });
    });
  }

  // -------------------------------------------------------------------------
  // Meta: conferência do par e propagação para as cópias
  // -------------------------------------------------------------------------

  /** O par ID + segredo vale na Graph? Recusado: 422 com mensagem clara. */
  private async conferirParComAMeta(
    appId: string,
    segredo: string,
  ): Promise<void> {
    const graph = new ClienteDaGraphFacebook({
      buscar: (...argumentos) => globalThis.fetch(...argumentos),
      graphUrl: this.ambiente.meta.graphUrl,
      versao: this.ambiente.meta.graphVersao,
    });
    try {
      await graph.validarApp(appId, segredo);
    } catch (erro) {
      if (erro instanceof ErroDaGraph) {
        throw new RegraVioladaException(
          'R32.22',
          erro.status >= 400 && erro.status < 500
            ? 'A Meta não reconheceu este par: confira o ID e o segredo do app (Configurações do app > Básico).'
            : 'Não foi possível conferir o app na Meta agora. Tente de novo em instantes.',
          { campo: 'segredo' },
        );
      }
      throw erro;
    }
  }

  /**
   * Leva o app novo às cópias marcadas e, na troca do ID, as deixa "precisa de atenção":
   * conexões do Facebook e canais Messenger/Instagram (Meta) ou as conexões de aplicativo
   * (Typeform e RD Station, que leem o app das Configurações na hora e perdem os tokens do app antigo).
   * Devolve as conexões do Facebook ou de aplicativo atingidas (para marcar as integrações).
   */
  private async propagar(
    tx: Prisma.TransactionClient,
    aplicativo: AplicativoDeLogin,
    clientId: string,
    segredo: string,
    trocouId: boolean,
  ): Promise<{ conexoes: string[]; canais: number }> {
    const agora = new Date();
    if (aplicativo !== 'META') {
      if (!trocouId) {
        return { conexoes: [], canais: 0 };
      }
      const conexoes = await tx.conexaoAplicativo.findMany({
        where: { aplicativo, excluidoEm: null },
        select: { id: true },
      });
      await tx.conexaoAplicativo.updateMany({
        where: { aplicativo, excluidoEm: null },
        data: {
          tokensCifrados: null,
          expiraEm: null,
          precisaAtencao: true,
          atencaoMotivo: MOTIVO_DA_TROCA_DE_APP,
          atencaoEm: agora,
        },
      });
      return { conexoes: conexoes.map(({ id }) => id), canais: 0 };
    }
    const conexoes = await tx.conexaoFacebook.findMany({
      where: { appDasConfiguracoes: true, excluidoEm: null },
      select: { id: true },
    });
    await tx.conexaoFacebook.updateMany({
      where: { appDasConfiguracoes: true, excluidoEm: null },
      data: {
        appId: clientId,
        appSecretCifrado: this.cripto.cifrar(segredo),
        ...(trocouId
          ? {
              precisaAtencao: true,
              atencaoMotivo: MOTIVO_DA_TROCA_DE_APP,
              atencaoEm: agora,
            }
          : {}),
      },
    });
    const canais = await tx.canal.findMany({
      where: {
        tipo: { in: ['MESSENGER', 'INSTAGRAM'] },
        excluidoEm: null,
        configuracao: { path: ['appDasConfiguracoes'], equals: true },
      },
    });
    for (const canal of canais) {
      let segredos: Record<string, unknown> = {};
      try {
        if (canal.segredosCifrados) {
          segredos = objetoDe(
            JSON.parse(this.cripto.decifrar(canal.segredosCifrados)),
          );
        }
      } catch {
        segredos = {};
      }
      await tx.canal.update({
        where: { id: canal.id },
        data: {
          configuracao: {
            ...objetoDe(canal.configuracao),
            appId: clientId,
          } as Prisma.InputJsonObject,
          segredosCifrados: this.cripto.cifrar(
            JSON.stringify({ ...segredos, appSecret: segredo }),
          ),
          ...(trocouId
            ? { ultimoErro: MOTIVO_DA_TROCA_DE_APP, ultimoErroEm: agora }
            : {}),
        },
      });
    }
    return { conexoes: conexoes.map(({ id }) => id), canais: canais.length };
  }

  /** As integrações das conexões atingidas pela troca do app ficam "precisa de atenção" (avisa os Admins). */
  private async marcarIntegracoes(
    aplicativo: AplicativoDeLogin,
    conexaoIds: readonly string[],
  ): Promise<void> {
    const integracoes = await this.prisma.webhookEntrada.findMany({
      where: {
        aplicativo: APLICATIVO_DA_INTEGRACAO[aplicativo],
        excluidoEm: null,
        ativo: true,
      },
    });
    for (const integracao of integracoes) {
      const conexaoId = objetoDe(integracao.configuracao).conexaoId;
      if (typeof conexaoId === 'string' && conexaoIds.includes(conexaoId)) {
        await this.aplicativos.marcarAtencao(
          integracao,
          MOTIVO_DA_TROCA_DE_APP,
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // Uso e DTO
  // -------------------------------------------------------------------------

  async emUso(aplicativo: AplicativoDeLogin): Promise<EmUsoDoApp> {
    let conexaoIds: string[];
    let canais = 0;
    if (aplicativo === 'META') {
      conexaoIds = (
        await this.prisma.conexaoFacebook.findMany({
          where: { appDasConfiguracoes: true, excluidoEm: null },
          select: { id: true },
        })
      ).map(({ id }) => id);
      canais = await this.prisma.canal.count({
        where: {
          tipo: { in: ['MESSENGER', 'INSTAGRAM'] },
          excluidoEm: null,
          configuracao: { path: ['appDasConfiguracoes'], equals: true },
        },
      });
    } else {
      conexaoIds = (
        await this.prisma.conexaoAplicativo.findMany({
          where: { aplicativo, excluidoEm: null },
          select: { id: true },
        })
      ).map(({ id }) => id);
    }
    const integracoes =
      conexaoIds.length === 0
        ? []
        : await this.prisma.webhookEntrada.findMany({
            where: {
              aplicativo: APLICATIVO_DA_INTEGRACAO[aplicativo],
              excluidoEm: null,
            },
            select: { configuracao: true },
          });
    const usadas = integracoes.filter(({ configuracao }) => {
      const conexaoId = objetoDe(configuracao).conexaoId;
      return typeof conexaoId === 'string' && conexaoIds.includes(conexaoId);
    });
    return {
      conexoes: conexaoIds.length,
      canais,
      integracoes: usadas.length,
    };
  }

  private enderecoDeRetorno(aplicativo: AplicativoDeLogin): string {
    const caminho =
      aplicativo === 'META'
        ? 'publico/facebook/oauth/retorno'
        : 'publico/conexoes/oauth/retorno';
    return `${this.ambiente.urlPublica}/${PREFIXO_DAS_ROTAS}/v${VERSAO_PADRAO_DA_API}/${caminho}`;
  }

  private async paraDto(aplicativo: AplicativoDeLogin): Promise<AppDeLoginDto> {
    const app = await this.prisma.appDeLogin.findUnique({
      where: { aplicativo },
    });
    const decifrado = app ? await this.obter(aplicativo) : null;
    const atualizadoPor = app?.atualizadoPorId
      ? await this.prisma.usuario.findUnique({
          where: { id: app.atualizadoPorId },
          select: { id: true, nome: true },
        })
      : null;
    return {
      aplicativo,
      nome: NOME_DO_APP[aplicativo],
      configurado: app !== null,
      clientId: app?.clientId ?? null,
      segredoMascarado: app
        ? decifrado
          ? this.cripto.mascarar(decifrado.segredo)
          : '••••••••'
        : null,
      enderecoDeRetorno: this.enderecoDeRetorno(aplicativo),
      emUso: await this.emUso(aplicativo),
      escopos:
        aplicativo === 'META'
          ? [...ESCOPOS_DO_FACEBOOK]
          : aplicativo === 'TYPEFORM'
            ? [...ESCOPOS_DO_TYPEFORM]
            : [],
      webhook:
        aplicativo === 'META' && decifrado
          ? {
              url: `${this.ambiente.urlPublica}/${PREFIXO_DAS_ROTAS}/v${VERSAO_PADRAO_DA_API}/publico/meta/webhook`,
              tokenVerificacao: decifrado?.tokenVerificacao ?? '',
              campos: ['leadgen'],
            }
          : null,
      atualizadoEm: app?.atualizadoEm.toISOString() ?? null,
      atualizadoPor: atualizadoPor
        ? { id: atualizadoPor.id, nome: atualizadoPor.nome }
        : null,
    };
  }
}
