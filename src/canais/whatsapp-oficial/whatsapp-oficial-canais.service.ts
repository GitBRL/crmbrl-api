import { Inject, Injectable } from '@nestjs/common';
import { CriptografiaService } from '../../comum/criptografia/criptografia.service';
import { AMBIENTE, type Ambiente } from '../../config/ambiente';
import type { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  type CanalComFila,
  ConfiguracaoDeCanais,
} from '../comum/configuracao-de-canais.service';
import { camposBaseDoCanal } from '../comum/dto-comum';
import { SegredosDoCanal } from '../comum/segredos-do-canal';
import { ErroDaGraph } from '../meta/graph-api';
import {
  CAMPOS_DO_WEBHOOK_OFICIAL,
  type ConfiguracaoOficial,
  lerConfiguracaoOficial,
  type SegredosOficiais,
} from './formato-meta';
import { GraphWhatsappOficial } from './graph-whatsapp-oficial';
import { templateParaDto } from './template-dto';
import { TemplatesOficiaisService } from './templates-oficiais.service';
import type {
  AtualizarCanalOficialDto,
  CanalOficialDto,
  CriarCanalOficialDto,
  SincronizacaoDeTemplatesDto,
  TesteDoCanalOficialDto,
  TokenDeVerificacaoOficialDto,
} from './whatsapp-oficial.dto';

const TIPOS = ['WHATSAPP_OFICIAL'] as const;

/** `canais.estado`: o que o teste de conexão aprendeu sobre o número. */
interface EstadoOficial {
  numero?: {
    exibido?: string | null;
    nomeVerificado?: string | null;
    qualidade?: string | null;
    conferidoEm?: string;
  };
  templatesSincronizadosEm?: string;
}

/**
 * Configuração dos canais de WhatsApp oficial (Admin, R28): ids da Meta, token e
 * app secret cifrados (só mascarados na tela), verify token gerado pelo CRM,
 * "Testar conexão" pela Graph e a sincronização dos templates.
 */
@Injectable()
export class WhatsappOficialCanaisService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cripto: CriptografiaService,
    private readonly configuracao: ConfiguracaoDeCanais,
    private readonly segredos: SegredosDoCanal,
    private readonly graph: GraphWhatsappOficial,
    private readonly templates: TemplatesOficiaisService,
    @Inject(AMBIENTE) private readonly ambiente: Ambiente,
  ) {}

  async listar(): Promise<CanalOficialDto[]> {
    const canais = await this.configuracao.listar(TIPOS);
    return Promise.all(canais.map((canal) => this.paraDto(canal)));
  }

  async obter(id: string): Promise<CanalOficialDto> {
    return this.paraDto(await this.configuracao.obter(id, TIPOS));
  }

  async criar(
    dto: CriarCanalOficialDto,
    criadoPorId: string,
  ): Promise<CanalOficialDto> {
    const config: ConfiguracaoOficial = {
      phoneNumberId: dto.phoneNumberId,
      wabaId: dto.wabaId,
      numeroExibido: dto.numeroExibido ?? null,
    };
    const canal = await this.prisma.$transaction(async (tx) => {
      const comuns = await this.configuracao.camposComuns(tx, dto);
      return this.configuracao.criar(tx, {
        ...(comuns as Prisma.CanalUncheckedCreateInput),
        tipo: 'WHATSAPP_OFICIAL',
        nome: dto.nome,
        idExterno: config.phoneNumberId,
        configuracao: config as unknown as Prisma.InputJsonObject,
        segredosCifrados: this.segredos.cifrar({
          token: dto.token,
          appSecret: dto.appSecret,
          tokenVerificacao: this.cripto.gerarToken(24),
        } satisfies SegredosOficiais),
        criadoPorId,
      });
    });
    return this.paraDto(canal);
  }

  async atualizar(
    id: string,
    dto: AtualizarCanalOficialDto,
  ): Promise<CanalOficialDto> {
    const canal = await this.prisma.$transaction(async (tx) => {
      const antes = await this.configuracao.travar(tx, id, TIPOS);
      const atual = lerConfiguracaoOficial(antes.configuracao);
      const config: ConfiguracaoOficial = {
        phoneNumberId: dto.phoneNumberId ?? atual.phoneNumberId,
        wabaId: dto.wabaId ?? atual.wabaId,
        numeroExibido:
          dto.numeroExibido === undefined
            ? atual.numeroExibido
            : dto.numeroExibido,
      };
      const comuns = await this.configuracao.camposComuns(tx, dto);
      const dados: Prisma.CanalUncheckedUpdateInput = {
        ...comuns,
        idExterno: config.phoneNumberId,
        configuracao: config as unknown as Prisma.InputJsonObject,
      };
      if (dto.token !== undefined || dto.appSecret !== undefined) {
        const gravados = await this.segredos.ler<SegredosOficiais>(antes);
        dados.segredosCifrados = this.segredos.cifrar({
          ...gravados,
          ...(dto.token !== undefined ? { token: dto.token } : {}),
          ...(dto.appSecret !== undefined ? { appSecret: dto.appSecret } : {}),
        });
        if (dto.token !== undefined) {
          dados.ultimoErro = null;
          dados.ultimoErroEm = null;
        }
      }
      return this.configuracao.atualizar(tx, antes, dados);
    });
    return this.paraDto(canal);
  }

  async excluir(id: string): Promise<void> {
    await this.configuracao.excluir(id, TIPOS);
  }

  /** Gera outro verify token (o painel da Meta precisa do novo). */
  async regenerarTokenDeVerificacao(
    id: string,
  ): Promise<TokenDeVerificacaoOficialDto> {
    const tokenVerificacao = this.cripto.gerarToken(24);
    await this.prisma.$transaction(async (tx) => {
      const antes = await this.configuracao.travar(tx, id, TIPOS);
      const gravados = await this.segredos.ler<SegredosOficiais>(antes);
      await this.configuracao.atualizar(tx, antes, {
        segredosCifrados: this.segredos.cifrar({
          ...gravados,
          tokenVerificacao,
        }),
      });
    });
    return { tokenVerificacao };
  }

  /**
   * "Testar conexão": lê o número pela Graph (`display_phone_number`,
   * `verified_name`, `quality_rating`). Sucesso limpa o erro do canal e guarda
   * o que a Meta informou; falha grava o motivo (estado `ERRO`).
   */
  async testar(id: string): Promise<TesteDoCanalOficialDto> {
    const canal = await this.configuracao.obter(id, TIPOS);
    const { phoneNumberId } = lerConfiguracaoOficial(canal.configuracao);
    const { token } = await this.segredos.ler<SegredosOficiais>(canal);
    const falhar = async (
      mensagem: string,
    ): Promise<TesteDoCanalOficialDto> => {
      await this.configuracao.registrarErro(canal.id, mensagem);
      return {
        ok: false,
        mensagem,
        numeroExibido: null,
        nomeVerificado: null,
        qualidade: null,
      };
    };
    if (!token) {
      return falhar('Informe o token do canal.');
    }
    try {
      const dados = await this.graph.dadosDoNumero(token, phoneNumberId);
      const numeroExibido = dados.display_phone_number ?? null;
      const nomeVerificado = dados.verified_name ?? null;
      const qualidade = dados.quality_rating ?? null;
      await this.configuracao.atualizarEstado(canal.id, {
        numero: {
          exibido: numeroExibido,
          nomeVerificado,
          qualidade,
          conferidoEm: new Date().toISOString(),
        },
      });
      await this.configuracao.registrarErro(canal.id, null);
      return {
        ok: true,
        mensagem: `Conectado ao número ${numeroExibido ?? phoneNumberId}${nomeVerificado ? ` (${nomeVerificado})` : ''}.`,
        numeroExibido,
        nomeVerificado,
        qualidade,
      };
    } catch (erro) {
      return falhar(
        erro instanceof ErroDaGraph && erro.tokenInvalido
          ? 'O token do canal é inválido ou expirou.'
          : `A Graph API não confirmou o número: ${erro instanceof Error ? erro.message : String(erro)}`,
      );
    }
  }

  async sincronizarTemplates(id: string): Promise<SincronizacaoDeTemplatesDto> {
    const canal = await this.configuracao.obter(id, TIPOS);
    const resultado = await this.templates.sincronizar(canal);
    const itens = await this.templates.listar(canal.id);
    return {
      total: resultado.total,
      aprovados: resultado.aprovados,
      sincronizadoEm: resultado.sincronizadoEm.toISOString(),
      itens: itens.map((item) => templateParaDto(item)),
    };
  }

  async listarTemplates(id: string) {
    const canal = await this.configuracao.obter(id, TIPOS);
    return (await this.templates.listar(canal.id)).map((item) =>
      templateParaDto(item),
    );
  }

  /** Endereço do webhook para o painel da Meta (o mesmo do Instagram e do Messenger). */
  get urlDoWebhook(): string {
    return `${this.ambiente.urlPublica}/api/v1/publico/meta/webhook`;
  }

  private async paraDto(canal: CanalComFila): Promise<CanalOficialDto> {
    const config = lerConfiguracaoOficial(canal.configuracao);
    const segredos = this.segredos.lerSemFalhar<SegredosOficiais>(canal);
    const estado = (canal.estado ?? {}) as EstadoOficial;
    const total = await this.prisma.whatsappOficialTemplate.count({
      where: { canalId: canal.id },
    });
    const aprovados = await this.prisma.whatsappOficialTemplate.count({
      where: { canalId: canal.id, status: 'APPROVED' },
    });
    const conferidoEm = estado.numero?.conferidoEm ?? null;
    return {
      ...camposBaseDoCanal(canal),
      tipo: 'WHATSAPP_OFICIAL',
      phoneNumberId: config.phoneNumberId,
      wabaId: config.wabaId,
      numeroExibido: config.numeroExibido ?? estado.numero?.exibido ?? null,
      token: segredos ? this.segredos.mascarar(segredos.token) : '••••••••',
      appSecret: segredos
        ? this.segredos.mascarar(segredos.appSecret)
        : '••••••••',
      webhook: {
        url: this.urlDoWebhook,
        tokenVerificacao: segredos?.tokenVerificacao ?? '',
        campos: [...CAMPOS_DO_WEBHOOK_OFICIAL],
      },
      estado: {
        situacao: canal.ultimoErro
          ? 'ERRO'
          : conferidoEm
            ? 'CONECTADO'
            : 'NAO_TESTADO',
        motivo: canal.ultimoErro,
        conferidoEm,
        nomeVerificado: estado.numero?.nomeVerificado ?? null,
        qualidade: estado.numero?.qualidade ?? null,
      },
      templates: {
        total,
        aprovados,
        sincronizadoEm:
          (await this.templates.ultimaSincronizacao(canal.id))?.toISOString() ??
          null,
      },
    };
  }
}
