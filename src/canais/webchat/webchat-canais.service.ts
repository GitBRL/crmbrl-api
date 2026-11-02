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
import {
  type EntradaDaConfiguracaoWebchat,
  lerConfiguracaoWebchat,
  montarConfiguracaoWebchat,
  trechoDeInstalacao,
  type ConfiguracaoWebchat,
} from './configuracao-webchat';
import type {
  AtualizarCanalWebchatDto,
  CanalWebchatDto,
  CriarCanalWebchatDto,
} from './webchat.dto';

const TIPOS = ['WEBCHAT'] as const;

/**
 * Configuração dos canais de chat do site (Admin, R14): domínios, aparência,
 * formulário inicial, chave pública e o trecho de instalação.
 */
@Injectable()
export class WebchatCanaisService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cripto: CriptografiaService,
    private readonly configuracao: ConfiguracaoDeCanais,
    @Inject(AMBIENTE) private readonly ambiente: Ambiente,
  ) {}

  async listar(): Promise<CanalWebchatDto[]> {
    const canais = await this.configuracao.listar(TIPOS);
    return canais.map((canal) => this.paraDto(canal));
  }

  async obter(id: string): Promise<CanalWebchatDto> {
    return this.paraDto(await this.configuracao.obter(id, TIPOS));
  }

  async criar(
    dto: CriarCanalWebchatDto,
    criadoPorId: string,
  ): Promise<CanalWebchatDto> {
    const configuracao = this.montar(dto);
    const canal = await this.prisma.$transaction(async (tx) => {
      const comuns = await this.configuracao.camposComuns(tx, dto);
      return this.configuracao.criar(tx, {
        ...(comuns as Prisma.CanalUncheckedCreateInput),
        tipo: 'WEBCHAT',
        nome: dto.nome,
        idExterno: `wc_${this.cripto.gerarToken(18)}`,
        configuracao: configuracao as unknown as Prisma.InputJsonObject,
        criadoPorId,
      });
    });
    return this.paraDto(canal);
  }

  async atualizar(
    id: string,
    dto: AtualizarCanalWebchatDto,
  ): Promise<CanalWebchatDto> {
    const canal = await this.prisma.$transaction(async (tx) => {
      const antes = await this.configuracao.travar(tx, id, TIPOS);
      const comuns = await this.configuracao.camposComuns(tx, dto);
      const configuracao = this.montar(
        dto,
        lerConfiguracaoWebchat(antes.configuracao),
      );
      return this.configuracao.atualizar(tx, antes, {
        ...comuns,
        configuracao: configuracao as unknown as Prisma.InputJsonObject,
      });
    });
    return this.paraDto(canal);
  }

  async excluir(id: string): Promise<void> {
    await this.configuracao.excluir(id, TIPOS);
  }

  /** Endereço do script do widget (base do trecho de instalação). */
  get urlDoWidget(): string {
    return `${this.ambiente.urlPublica}/api/v1/publico/webchat/widget.js`;
  }

  private montar(
    dto: CriarCanalWebchatDto | AtualizarCanalWebchatDto,
    atual?: ConfiguracaoWebchat,
  ): ConfiguracaoWebchat {
    const entrada: EntradaDaConfiguracaoWebchat = {
      dominios: dto.dominios,
      aparencia: dto.aparencia,
      contato: dto.contato,
      textoConsentimento: dto.textoConsentimento,
      urlPrivacidade: dto.urlPrivacidade,
      permitirAnexos: dto.permitirAnexos,
    };
    const resultado = montarConfiguracaoWebchat(entrada, atual);
    if (resultado.problemas) {
      throw new DadosInvalidosException(resultado.problemas[0].mensagem, {
        campos: resultado.problemas.map(({ campo, mensagem }) => ({
          campo,
          mensagens: [mensagem],
        })),
      });
    }
    return resultado.configuracao;
  }

  private paraDto(canal: CanalComFila): CanalWebchatDto {
    const configuracao = lerConfiguracaoWebchat(canal.configuracao);
    const chave = canal.idExterno ?? '';
    return {
      ...camposBaseDoCanal(canal),
      chavePublica: chave,
      dominios: configuracao.dominios,
      aparencia: configuracao.aparencia,
      contato: configuracao.contato,
      textoConsentimento: configuracao.textoConsentimento,
      urlPrivacidade: configuracao.urlPrivacidade,
      permitirAnexos: configuracao.permitirAnexos,
      instalacao: {
        urlDoWidget: this.urlDoWidget,
        trecho: trechoDeInstalacao(this.urlDoWidget, chave),
      },
    };
  }
}
