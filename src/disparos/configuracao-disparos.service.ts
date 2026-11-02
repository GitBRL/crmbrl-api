import { Injectable } from '@nestjs/common';
import { AuditoriaService } from '../auditoria/auditoria.service';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import { ehDiretoria } from '../comum/dominio/papeis';
import { SemPermissaoException } from '../comum/erros/excecoes';
import { PrismaService } from '../prisma/prisma.service';
import {
  CHAVE_CONFIGURACAO_DISPAROS,
  type ConfiguracaoDisparos,
  lerConfiguracaoDisparos,
} from './configuracao-disparos';
import type { AtualizarConfiguracaoDisparosDto } from './disparos.dto';

/** Configuração do módulo (`configuracoes.disparos`): aprovação, palavras de saída e confirmação. */
@Injectable()
export class ConfiguracaoDisparosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditoria: AuditoriaService,
  ) {}

  async obter(): Promise<ConfiguracaoDisparos> {
    const linha = await this.prisma.configuracao.findUnique({
      where: { chave: CHAVE_CONFIGURACAO_DISPAROS },
    });
    return lerConfiguracaoDisparos(linha?.valor);
  }

  /** Só Admin e C-level alteram. */
  async atualizar(
    usuario: UsuarioAutenticado,
    dto: AtualizarConfiguracaoDisparosDto,
  ): Promise<ConfiguracaoDisparos> {
    if (!ehDiretoria(usuario.papel)) {
      throw new SemPermissaoException(
        'Só Admin e C-level alteram a configuração dos disparos.',
      );
    }
    return this.prisma.$transaction(async (tx) => {
      const linha = await tx.configuracao.findUnique({
        where: { chave: CHAVE_CONFIGURACAO_DISPAROS },
      });
      const antes = lerConfiguracaoDisparos(linha?.valor);
      const depois = lerConfiguracaoDisparos({
        aprovacaoDoLider: dto.aprovacaoDoLider ?? antes.aprovacaoDoLider,
        palavrasDeSaida: dto.palavrasDeSaida ?? antes.palavrasDeSaida,
        mensagemDeSaida: dto.mensagemDeSaida ?? antes.mensagemDeSaida,
      });
      await tx.configuracao.upsert({
        where: { chave: CHAVE_CONFIGURACAO_DISPAROS },
        create: {
          chave: CHAVE_CONFIGURACAO_DISPAROS,
          valor: { ...depois },
          atualizadoPorId: usuario.id,
        },
        update: { valor: { ...depois }, atualizadoPorId: usuario.id },
      });
      await this.auditoria.registrar(tx, {
        acao: 'disparos.configuracao_atualizada',
        entidade: 'configuracao',
        entidadeId: null,
        resumo: `${usuario.nome} alterou a configuração dos disparos`,
        dados: { antes, depois, regra: 'R17' },
      });
      return depois;
    });
  }
}
