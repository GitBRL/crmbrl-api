import { Inject, Injectable } from '@nestjs/common';
import { CriptografiaService } from '../../comum/criptografia/criptografia.service';
import { DadosInvalidosException } from '../../comum/erros/excecoes';
import { AMBIENTE, type Ambiente } from '../../config/ambiente';
import type { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  type CanalComFila,
  ConfiguracaoDeCanais,
} from '../comum/configuracao-de-canais.service';
import { camposBaseDoCanal } from '../comum/dto-comum';
import { SegredosDoCanal } from '../comum/segredos-do-canal';
import { ROTULO_DO_TIPO_DE_CANAL } from '../registro-canais';
import {
  CAMPOS_DO_WEBHOOK,
  type ConfiguracaoMeta,
  idDoCanalNaMeta,
  lerConfiguracaoMeta,
  type SegredosMeta,
  TIPOS_META,
  type TipoCanalMeta,
} from './eventos-meta';
import { ErroDaGraph, GraphApi } from './graph-api';
import type {
  AtualizarCanalMetaDto,
  CanalMetaDto,
  CriarCanalMetaDto,
  TesteDoCanalMetaDto,
  TokenDeVerificacaoDto,
} from './meta.dto';

/**
 * Configuração dos canais de Instagram e Messenger (Admin, R14): ids da Meta,
 * app secret e token de página cifrados (só mascarados na tela), o token de
 * verificação do webhook gerado pelo CRM e o teste do token pela Graph API.
 */
@Injectable()
export class MetaCanaisService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cripto: CriptografiaService,
    private readonly configuracao: ConfiguracaoDeCanais,
    private readonly segredos: SegredosDoCanal,
    private readonly graph: GraphApi,
    @Inject(AMBIENTE) private readonly ambiente: Ambiente,
  ) {}

  async listar(): Promise<CanalMetaDto[]> {
    const canais = await this.configuracao.listar(TIPOS_META);
    return canais.map((canal) => this.paraDto(canal));
  }

  async obter(id: string): Promise<CanalMetaDto> {
    return this.paraDto(await this.configuracao.obter(id, TIPOS_META));
  }

  async criar(
    dto: CriarCanalMetaDto,
    criadoPorId: string,
  ): Promise<CanalMetaDto> {
    const config = validar(dto.tipo, {
      appId: dto.appId,
      pageId: dto.pageId,
      instagramId: dto.instagramId ?? null,
    });
    const canal = await this.prisma.$transaction(async (tx) => {
      const comuns = await this.configuracao.camposComuns(tx, dto);
      return this.configuracao.criar(tx, {
        ...(comuns as Prisma.CanalUncheckedCreateInput),
        tipo: dto.tipo,
        nome: dto.nome,
        idExterno: idDoCanalNaMeta(dto.tipo, config),
        configuracao: config as unknown as Prisma.InputJsonObject,
        segredosCifrados: this.segredos.cifrar({
          appSecret: dto.appSecret,
          tokenPagina: dto.tokenPagina,
          tokenVerificacao: this.novoTokenDeVerificacao(),
        } satisfies SegredosMeta),
        criadoPorId,
      });
    });
    return this.paraDto(canal);
  }

  async atualizar(
    id: string,
    dto: AtualizarCanalMetaDto,
  ): Promise<CanalMetaDto> {
    const canal = await this.prisma.$transaction(async (tx) => {
      const antes = await this.configuracao.travar(tx, id, TIPOS_META);
      const tipo = antes.tipo as TipoCanalMeta;
      const atual = lerConfiguracaoMeta(antes.configuracao);
      const config = validar(tipo, {
        appId: dto.appId ?? atual.appId,
        pageId: dto.pageId ?? atual.pageId,
        instagramId:
          dto.instagramId === undefined ? atual.instagramId : dto.instagramId,
      });
      const comuns = await this.configuracao.camposComuns(tx, dto);
      const dados: Prisma.CanalUncheckedUpdateInput = {
        ...comuns,
        idExterno: idDoCanalNaMeta(tipo, config),
        configuracao: config as unknown as Prisma.InputJsonObject,
      };
      if (dto.appSecret !== undefined || dto.tokenPagina !== undefined) {
        const gravados = await this.segredos.ler<SegredosMeta>(antes);
        dados.segredosCifrados = this.segredos.cifrar({
          ...gravados,
          ...(dto.appSecret !== undefined ? { appSecret: dto.appSecret } : {}),
          ...(dto.tokenPagina !== undefined
            ? { tokenPagina: dto.tokenPagina }
            : {}),
        });
        if (dto.tokenPagina !== undefined) {
          dados.ultimoErro = null;
          dados.ultimoErroEm = null;
        }
      }
      return this.configuracao.atualizar(tx, antes, dados);
    });
    return this.paraDto(canal);
  }

  async excluir(id: string): Promise<void> {
    await this.configuracao.excluir(id, TIPOS_META);
  }

  /** Gera outro token de verificação (o painel da Meta precisa do novo). */
  async regenerarTokenDeVerificacao(
    id: string,
  ): Promise<TokenDeVerificacaoDto> {
    const tokenVerificacao = this.novoTokenDeVerificacao();
    await this.prisma.$transaction(async (tx) => {
      const antes = await this.configuracao.travar(tx, id, TIPOS_META);
      const gravados = await this.segredos.ler<SegredosMeta>(antes);
      await this.configuracao.atualizar(tx, antes, {
        segredosCifrados: this.segredos.cifrar({
          ...gravados,
          tokenVerificacao,
        }),
      });
    });
    return { tokenVerificacao };
  }

  /** Confere o token de página lendo a página (ou a conta do Instagram) pela Graph. */
  async testar(id: string): Promise<TesteDoCanalMetaDto> {
    const canal = await this.configuracao.obter(id, TIPOS_META);
    const tipo = canal.tipo as TipoCanalMeta;
    const config = lerConfiguracaoMeta(canal.configuracao);
    const { tokenPagina } = await this.segredos.ler<SegredosMeta>(canal);
    if (!tokenPagina) {
      return { ok: false, mensagem: 'Informe o token da página.', nome: null };
    }
    const alvo = idDoCanalNaMeta(tipo, config);
    try {
      const objeto = await this.graph.obter<{
        name?: string;
        username?: string;
      }>(
        tokenPagina,
        alvo,
        tipo === 'INSTAGRAM' ? ['id', 'name', 'username'] : ['id', 'name'],
      );
      const nome = objeto.name ?? objeto.username ?? null;
      await this.configuracao.registrarErro(canal.id, null);
      return {
        ok: true,
        mensagem:
          tipo === 'INSTAGRAM'
            ? `Conectado à conta do Instagram${nome ? ` "${nome}"` : ''}.`
            : `Conectado à página${nome ? ` "${nome}"` : ''}.`,
        nome,
      };
    } catch (erro) {
      const mensagem =
        erro instanceof ErroDaGraph && erro.tokenInvalido
          ? 'O token da página é inválido ou expirou.'
          : `A Graph API não confirmou o ${ROTULO_DO_TIPO_DE_CANAL[tipo]}: ${erro instanceof Error ? erro.message : String(erro)}`;
      return { ok: false, mensagem, nome: null };
    }
  }

  /** Endereço do webhook para o painel da Meta. */
  get urlDoWebhook(): string {
    return `${this.ambiente.urlPublica}/api/v1/publico/meta/webhook`;
  }

  private novoTokenDeVerificacao(): string {
    return this.cripto.gerarToken(24);
  }

  private paraDto(canal: CanalComFila): CanalMetaDto {
    const config = lerConfiguracaoMeta(canal.configuracao);
    const segredos = this.segredos.lerSemFalhar<SegredosMeta>(canal);
    return {
      ...camposBaseDoCanal(canal),
      appId: config.appId,
      pageId: config.pageId,
      instagramId: config.instagramId,
      appSecret: segredos
        ? this.segredos.mascarar(segredos.appSecret)
        : '••••••••',
      tokenPagina: segredos
        ? this.segredos.mascarar(segredos.tokenPagina)
        : '••••••••',
      webhook: {
        url: this.urlDoWebhook,
        tokenVerificacao: segredos?.tokenVerificacao ?? '',
        campos: [...CAMPOS_DO_WEBHOOK],
      },
    };
  }
}

function validar(
  tipo: TipoCanalMeta,
  config: ConfiguracaoMeta,
): ConfiguracaoMeta {
  if (tipo === 'INSTAGRAM' && !config.instagramId) {
    throw new DadosInvalidosException(
      'Informe o id da conta profissional do Instagram.',
      {
        campos: [
          { campo: 'instagramId', mensagens: ['é obrigatório no Instagram'] },
        ],
      },
    );
  }
  return {
    appId: config.appId,
    pageId: config.pageId,
    instagramId: tipo === 'INSTAGRAM' ? config.instagramId : null,
  };
}
