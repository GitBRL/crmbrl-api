import { Injectable } from '@nestjs/common';
import { normalizarEmail } from '../../comum/dominio/email';
import { DadosInvalidosException } from '../../comum/erros/excecoes';
import type { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  type CanalComFila,
  ConfiguracaoDeCanais,
} from '../comum/configuracao-de-canais.service';
import { camposBaseDoCanal, definidos } from '../comum/dto-comum';
import { SegredosDoCanal } from '../comum/segredos-do-canal';
import {
  type ConfiguracaoEmail,
  lerConfiguracaoEmail,
  lerEstadoEmail,
  PORTA_PADRAO,
  type SegredosEmail,
  senhaDoSmtp,
} from './configuracao-email';
import { testarImap, testarSmtp } from './conexoes-email';
import { LeitorDeEmail } from './leitor-de-email.service';
import type {
  AtualizarCanalEmailDto,
  CanalEmailDto,
  ConexaoEmailEntradaDto,
  CriarCanalEmailDto,
  TestarCanalEmailDto,
  TesteDeConexaoEmailDto,
} from './email.dto';

const TIPOS = ['EMAIL'] as const;

type EntradaDeConexao = Pick<
  CriarCanalEmailDto,
  'endereco' | 'imap' | 'smtp' | 'ignorarCertificado'
> &
  Partial<Pick<CriarCanalEmailDto, 'nomeRemetente' | 'assinatura'>>;

/**
 * Configuração dos canais de e-mail (Admin, R14): IMAP e SMTP, senhas
 * cifradas (nunca voltam; só mascaradas) e o teste de conexão.
 */
@Injectable()
export class EmailCanaisService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configuracao: ConfiguracaoDeCanais,
    private readonly segredos: SegredosDoCanal,
    private readonly leitor: LeitorDeEmail,
  ) {}

  async listar(): Promise<CanalEmailDto[]> {
    const canais = await this.configuracao.listar(TIPOS);
    return canais.map((canal) => this.paraDto(canal));
  }

  async obter(id: string): Promise<CanalEmailDto> {
    return this.paraDto(await this.configuracao.obter(id, TIPOS));
  }

  async criar(
    dto: CriarCanalEmailDto,
    criadoPorId: string,
  ): Promise<CanalEmailDto> {
    const config = montarConfiguracao(dto);
    const canal = await this.prisma.$transaction(async (tx) => {
      const comuns = await this.configuracao.camposComuns(tx, dto);
      return this.configuracao.criar(tx, {
        ...(comuns as Prisma.CanalUncheckedCreateInput),
        tipo: 'EMAIL',
        nome: dto.nome,
        idExterno: config.endereco,
        configuracao: paraJson(config),
        segredosCifrados: this.segredos.cifrar({
          senhaImap: dto.senha,
          senhaSmtp: dto.senhaSmtp ?? undefined,
        } satisfies Partial<SegredosEmail>),
        criadoPorId,
      });
    });
    // Só as mensagens que chegarem daqui em diante (melhor esforço).
    await this.leitor.marcarInicio(canal);
    return this.obter(canal.id);
  }

  async atualizar(
    id: string,
    dto: AtualizarCanalEmailDto,
  ): Promise<CanalEmailDto> {
    const canal = await this.prisma.$transaction(async (tx) => {
      const antes = await this.configuracao.travar(tx, id, TIPOS);
      const atual = lerConfiguracaoEmail(antes.configuracao, antes.idExterno);
      const comuns = await this.configuracao.camposComuns(tx, dto);
      const config = montarConfiguracao(
        {
          endereco: dto.endereco ?? atual.endereco,
          imap: { ...atual.imap, ...definidos(dto.imap) },
          smtp: { ...atual.smtp, ...definidos(dto.smtp) },
          ignorarCertificado:
            dto.ignorarCertificado ?? atual.ignorarCertificado,
          nomeRemetente:
            dto.nomeRemetente === undefined
              ? atual.nomeRemetente
              : dto.nomeRemetente,
          assinatura:
            dto.assinatura === undefined ? atual.assinatura : dto.assinatura,
        },
        dto.smtp?.usuario === undefined && dto.imap?.usuario !== undefined,
      );
      const dados: Prisma.CanalUncheckedUpdateInput = {
        ...comuns,
        idExterno: config.endereco,
        configuracao: paraJson(config),
      };
      if (dto.senha !== undefined || dto.senhaSmtp !== undefined) {
        const gravados = await this.segredos.ler<SegredosEmail>(antes);
        dados.segredosCifrados = this.segredos.cifrar({
          senhaImap: dto.senha ?? gravados.senhaImap,
          senhaSmtp:
            dto.senhaSmtp === undefined
              ? gravados.senhaSmtp
              : (dto.senhaSmtp ?? undefined),
        });
      }
      // Trocou a caixa: a leitura recomeça (só mensagens novas).
      const trocouCaixa =
        config.endereco !== atual.endereco ||
        config.imap.host !== atual.imap.host ||
        config.imap.porta !== atual.imap.porta ||
        config.imap.usuario !== atual.imap.usuario ||
        config.imap.pasta !== atual.imap.pasta;
      if (trocouCaixa) {
        dados.estado = { ultimaVarreduraEm: new Date().toISOString() };
      }
      const depois = await this.configuracao.atualizar(tx, antes, dados);
      return { depois, trocouCaixa };
    });
    if (canal.trocouCaixa) {
      await this.leitor.marcarInicio(canal.depois);
      return this.obter(id);
    }
    return this.paraDto(canal.depois);
  }

  async excluir(id: string): Promise<void> {
    await this.configuracao.excluir(id, TIPOS);
  }

  /** Testa IMAP e SMTP com a configuração informada (nada é gravado). */
  async testarNovo(
    dto: ConexaoEmailEntradaDto,
  ): Promise<TesteDeConexaoEmailDto> {
    const config = montarConfiguracao({
      endereco: dto.endereco,
      imap: definidos(dto.imap),
      smtp: definidos(dto.smtp),
      ignorarCertificado: dto.ignorarCertificado,
    });
    return this.testar(config, {
      senhaImap: dto.senha,
      senhaSmtp: dto.senhaSmtp ?? undefined,
    });
  }

  /** Testa o canal salvo (o que vier no corpo substitui o gravado, sem gravar). */
  async testarCanal(
    id: string,
    dto: TestarCanalEmailDto,
  ): Promise<TesteDeConexaoEmailDto> {
    const canal = await this.configuracao.obter(id, TIPOS);
    const atual = lerConfiguracaoEmail(canal.configuracao, canal.idExterno);
    const config = montarConfiguracao({
      endereco: dto.endereco ?? atual.endereco,
      imap: { ...atual.imap, ...definidos(dto.imap) },
      smtp: { ...atual.smtp, ...definidos(dto.smtp) },
      ignorarCertificado: dto.ignorarCertificado ?? atual.ignorarCertificado,
    });
    const gravados = await this.segredos.ler<SegredosEmail>(canal);
    const resultado = await this.testar(config, {
      senhaImap: dto.senha ?? gravados.senhaImap,
      senhaSmtp:
        dto.senhaSmtp === undefined
          ? gravados.senhaSmtp
          : (dto.senhaSmtp ?? undefined),
    });
    if (resultado.imap.ok && resultado.smtp.ok) {
      await this.configuracao.registrarErro(canal.id, null);
    }
    return resultado;
  }

  private async testar(
    config: ConfiguracaoEmail,
    segredos: Partial<SegredosEmail>,
  ): Promise<TesteDeConexaoEmailDto> {
    const [imap, smtp] = await Promise.all([
      segredos.senhaImap
        ? testarImap(config, segredos.senhaImap)
        : Promise.resolve({ ok: false, mensagem: 'Informe a senha da caixa.' }),
      testarSmtp(config, senhaDoSmtp(segredos)),
    ]);
    return { imap, smtp };
  }

  private paraDto(canal: CanalComFila): CanalEmailDto {
    const config = lerConfiguracaoEmail(canal.configuracao, canal.idExterno);
    const segredos = this.segredos.lerSemFalhar<SegredosEmail>(canal);
    return {
      ...camposBaseDoCanal(canal),
      endereco: config.endereco,
      nomeRemetente: config.nomeRemetente,
      imap: config.imap,
      smtp: config.smtp,
      ignorarCertificado: config.ignorarCertificado,
      assinatura: config.assinatura,
      senha: segredos ? this.segredos.mascarar(segredos.senhaImap) : '••••••••',
      senhaSmtp: segredos ? this.segredos.mascarar(segredos.senhaSmtp) : null,
      ultimaVarreduraEm: lerEstadoEmail(canal.estado).ultimaVarreduraEm ?? null,
    };
  }
}

/**
 * Configuração completa a partir da tela: endereço normalizado, portas
 * padrão pela segurança, SMTP com o host/usuário do IMAP quando não vierem.
 */
export function montarConfiguracao(
  entrada: EntradaDeConexao,
  usuarioSmtpSegueImap = false,
): ConfiguracaoEmail {
  const endereco = normalizarEmail(entrada.endereco);
  const imap = entrada.imap ?? {};
  const smtp = entrada.smtp ?? {};
  const host = imap.host?.trim();
  if (!host) {
    throw new DadosInvalidosException('Informe o servidor IMAP.', {
      campos: [{ campo: 'imap.host', mensagens: ['é obrigatório'] }],
    });
  }
  const tls = imap.tls ?? true;
  const seguranca = smtp.seguranca ?? 'TLS';
  const usuarioImap = imap.usuario?.trim() || endereco;
  return {
    endereco,
    nomeRemetente: entrada.nomeRemetente ?? null,
    imap: {
      host,
      porta:
        imap.porta ?? (tls ? PORTA_PADRAO.imap.tls : PORTA_PADRAO.imap.aberta),
      tls,
      usuario: usuarioImap,
      pasta: imap.pasta?.trim() || 'INBOX',
    },
    smtp: {
      host: smtp.host?.trim() || host,
      porta: smtp.porta ?? PORTA_PADRAO.smtp[seguranca],
      seguranca,
      usuario: usuarioSmtpSegueImap
        ? usuarioImap
        : smtp.usuario?.trim() || usuarioImap,
    },
    ignorarCertificado: entrada.ignorarCertificado ?? false,
    assinatura: entrada.assinatura ?? null,
  };
}

function paraJson(config: ConfiguracaoEmail): Prisma.InputJsonObject {
  // O endereço fica só no `idExterno`.
  const { endereco: _endereco, ...resto } = config;
  return resto as unknown as Prisma.InputJsonObject;
}
