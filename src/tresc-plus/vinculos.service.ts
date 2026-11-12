import { Injectable } from '@nestjs/common';
import { AuditoriaService } from '../auditoria/auditoria.service';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import { CriptografiaService } from '../comum/criptografia/criptografia.service';
import {
  ConflitoException,
  NaoEncontradoException,
  RegraVioladaException,
} from '../comum/erros/excecoes';
import type { TrescPlusVinculo } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ClienteTrescPlus, numeroDe, textoDe } from './cliente-tresc-plus';
import {
  ConexaoTrescPlusService,
  finalDoToken,
  mascararToken,
  usuarioDaResposta,
} from './conexao.service';
import { ErroTrescPlus } from './erros-tresc-plus';
import { REGRA_TRESC_PLUS } from './tresc-plus.constantes';
import type { VincularDto, VinculoDto } from './tresc-plus.dto';

/**
 * Vínculo do vendedor com o 3C+ (R34.2): e-mail/ramal e senha vão para `POST /authenticate` uma única
 * vez; o CRM guarda só o `api_token` (cifrado), o ramal e o id do usuário no 3C+. A senha nunca é
 * guardada, registrada em log ou auditoria.
 */
@Injectable()
export class VinculosTrescPlusService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cripto: CriptografiaService,
    private readonly auditoria: AuditoriaService,
    private readonly conexao: ConexaoTrescPlusService,
  ) {}

  paraDto(vinculo: TrescPlusVinculo | null): VinculoDto {
    if (!vinculo) return { vinculado: false };
    return {
      vinculado: true,
      usuarioId: vinculo.usuarioId,
      ramal: vinculo.ramal,
      nome3c: vinculo.nome3c,
      trescUsuarioId: vinculo.trescUsuarioId,
      token: mascararToken(vinculo.tokenFinal) ?? undefined,
      vinculadoEm: vinculo.vinculadoEm.toISOString(),
    };
  }

  async doUsuario(usuarioId: string): Promise<TrescPlusVinculo | null> {
    return this.prisma.trescPlusVinculo.findUnique({ where: { usuarioId } });
  }

  /** O vínculo ou 422 pedindo para conectar (R34.2). */
  async exigir(usuarioId: string): Promise<TrescPlusVinculo> {
    const vinculo = await this.doUsuario(usuarioId);
    if (!vinculo) {
      throw new RegraVioladaException(
        REGRA_TRESC_PLUS,
        'Conecte seu usuário ao 3C+ antes de usar o discador (Meu perfil, Conectar ao 3C+).',
        { motivo: 'sem_vinculo' },
      );
    }
    return vinculo;
  }

  async obter(usuario: UsuarioAutenticado): Promise<VinculoDto> {
    return this.paraDto(await this.doUsuario(usuario.id));
  }

  async listar(): Promise<Array<VinculoDto & { usuarioNome: string }>> {
    const vinculos = await this.prisma.trescPlusVinculo.findMany({
      include: { usuario: { select: { nome: true } } },
      orderBy: { vinculadoEm: 'desc' },
    });
    return vinculos.map((v) =>
      Object.assign({}, this.paraDto(v), { usuarioNome: v.usuario.nome }),
    );
  }

  /** Cliente HTTP com o token do vendedor. */
  async clienteDo(vinculo: TrescPlusVinculo): Promise<ClienteTrescPlus> {
    return this.conexao.clienteDoVendedor(
      await this.conexao.ler(),
      vinculo.tokenCifrado,
    );
  }

  async vincular(
    usuario: UsuarioAutenticado,
    dto: VincularDto,
  ): Promise<VinculoDto> {
    const config = await this.conexao.ler();
    if (!config.ativa) {
      throw new RegraVioladaException(
        REGRA_TRESC_PLUS,
        'A integração com o 3C+ não está ativa. Peça ao Admin para ativá-la em Configurações, Integrações.',
        { motivo: 'integracao_inativa' },
      );
    }
    let corpo: unknown;
    try {
      corpo = await new ClienteTrescPlus({
        baseUrl: config.urlApi,
      }).authenticate(dto.usuario, dto.senha);
    } catch (erro) {
      if (
        erro instanceof ErroTrescPlus &&
        (erro.status === 401 || erro.status === 422 || erro.status === 403)
      ) {
        // Credencial errada: mensagem própria (sem repetir o que o 3C+ devolveu).
        throw new RegraVioladaException(
          REGRA_TRESC_PLUS,
          'O 3C+ não aceitou o usuário e a senha. Confira os dados e tente de novo.',
          { motivo: 'credenciais_invalidas' },
        );
      }
      if (erro instanceof ErroTrescPlus) throw erro.paraErroApi();
      throw erro;
    }
    const dados = usuarioDaResposta(corpo);
    const token = textoDe(dados.api_token);
    const trescUsuarioId = numeroDe(dados.id);
    if (!token || trescUsuarioId === null) {
      throw new RegraVioladaException(
        REGRA_TRESC_PLUS,
        'O 3C+ respondeu sem o token do usuário. Tente de novo ou fale com o suporte.',
        { motivo: 'resposta_inesperada' },
      );
    }
    const outro = await this.prisma.trescPlusVinculo.findFirst({
      where: { trescUsuarioId, NOT: { usuarioId: usuario.id } },
      select: { id: true },
    });
    if (outro) {
      throw new ConflitoException(
        'Este usuário do 3C+ já está conectado a outra pessoa do CRM.',
        {
          regra: REGRA_TRESC_PLUS,
        },
      );
    }
    const ramal = textoDe(dados.extension) ?? textoDe(dados.extension_number);
    const nome = textoDe(dados.name) ?? textoDe(dados.email);
    const gravados = {
      trescUsuarioId,
      nome3c: nome,
      ramal,
      tokenCifrado: this.cripto.cifrar(token),
      tokenFinal: finalDoToken(token),
    };
    const vinculo = await this.prisma.$transaction(async (tx) => {
      const gravado = await tx.trescPlusVinculo.upsert({
        where: { usuarioId: usuario.id },
        create: { usuarioId: usuario.id, ...gravados },
        update: {
          ...gravados,
          estado: 'desconectado',
          estadoDesde: new Date(),
          campanhaId: null,
          campanhaNome: null,
          modo: null,
          pausaId: null,
          pausaNome: null,
          vinculadoEm: new Date(),
        },
      });
      await this.auditoria.registrar(tx, {
        acao: 'tresc-plus.vinculo-criado',
        entidade: 'tresc_plus_vinculo',
        entidadeId: gravado.id,
        resumo: `${usuario.nome} conectou o usuário ao 3C+`,
        dados: { regra: REGRA_TRESC_PLUS, trescUsuarioId, ramal },
        relacionados: { usuario: usuario.id },
      });
      return gravado;
    });
    return this.paraDto(vinculo);
  }

  /** O próprio vendedor desconecta, ou o Admin desvincula (`quem` ≠ dono). */
  async desvincular(
    quem: UsuarioAutenticado,
    usuarioId: string,
  ): Promise<void> {
    const vinculo = await this.doUsuario(usuarioId);
    if (!vinculo) {
      throw new NaoEncontradoException(
        'Este usuário não está conectado ao 3C+.',
      );
    }
    // Sai da campanha no 3C+ (melhor esforço) para não deixar o agente logado sem o CRM.
    if (vinculo.campanhaId !== null) {
      try {
        await (await this.clienteDo(vinculo)).sairDaCampanha();
      } catch {
        // O token pode já ter expirado: o vínculo sai do mesmo jeito.
      }
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.trescPlusVinculo.delete({ where: { id: vinculo.id } });
      await this.auditoria.registrar(tx, {
        acao: 'tresc-plus.vinculo-removido',
        entidade: 'tresc_plus_vinculo',
        entidadeId: vinculo.id,
        resumo:
          quem.id === usuarioId
            ? `${quem.nome} desconectou o usuário do 3C+`
            : `${quem.nome} desvinculou um usuário do 3C+`,
        dados: {
          regra: REGRA_TRESC_PLUS,
          trescUsuarioId: vinculo.trescUsuarioId,
        },
        relacionados: { usuario: usuarioId },
      });
    });
  }
}
