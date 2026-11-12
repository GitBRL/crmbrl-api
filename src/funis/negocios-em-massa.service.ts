import { HttpException, Injectable } from '@nestjs/common';
import { AtividadesService } from '../atividades/atividades.service';
import { AuditoriaService } from '../auditoria/auditoria.service';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import { normalizarEtiquetas } from '../comum/dominio/etiquetas';
import {
  DadosInvalidosException,
  ErroApi,
  NaoEncontradoException,
  RegraVioladaException,
  SemPermissaoException,
} from '../comum/erros/excecoes';
import { ContatosService } from '../contatos/contatos.service';
import { PrismaService } from '../prisma/prisma.service';
import { funisAcessiveis } from './acessos-no-banco';
import type { AcessoAosFunis } from './acesso-funis';
import {
  type AcaoEmMassaDto,
  type FalhaEmMassaDto,
  type ResultadoEmMassaDto,
} from './dto/negocios-em-massa.dto';
import {
  type DadosValidados,
  validarDadosEmMassa,
} from './negocios-em-massa.dados';
import { NegociosService } from './negocios.service';
import { DiscadorTrescPlusService } from '../tresc-plus/discador.service';

interface NegocioAlvo {
  id: string;
  titulo: string;
  funilId: string;
  etapaId: string;
  responsavelId: string | null;
  contatoId: string;
  empresaId: string | null;
}

/**
 * Ações em massa nos negócios do quadro (R5.16): cada negócio passa pelo
 * serviço de domínio da ação (mesmas regras, auditoria, eventos e automações),
 * na própria transação — sucesso parcial é normal. O que a pessoa não vê entra
 * nas falhas como 404; no fim, uma auditoria-resumo `negocio.acao_em_massa`.
 */
@Injectable()
export class NegociosEmMassaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly negocios: NegociosService,
    private readonly contatos: ContatosService,
    private readonly atividades: AtividadesService,
    private readonly auditoria: AuditoriaService,
    private readonly discador: DiscadorTrescPlusService,
  ) {}

  async executar(
    usuario: UsuarioAutenticado,
    dto: AcaoEmMassaDto,
  ): Promise<ResultadoEmMassaDto> {
    const dados = validarDadosEmMassa(dto.acao, dto.dados);
    if (dados.acao === 'MOVER' && !dados.motivoPerda) {
      const etapa = await this.prisma.etapa.findUnique({
        where: { id: dados.etapaId },
        select: { tipo: true },
      });
      if (etapa?.tipo === 'PERDIDO') {
        throw new DadosInvalidosException(
          'Dados inválidos — dados.motivoPerda: é obrigatório para uma etapa de perda.',
          {
            campos: [
              {
                campo: 'dados.motivoPerda',
                mensagens: ['é obrigatório para uma etapa de perda'],
              },
            ],
          },
        );
      }
    }

    if (dados.acao === 'DISCADOR') {
      return this.enviarAoDiscador(usuario, dto, dados);
    }

    const encontrados = await this.prisma.negocio.findMany({
      where: { id: { in: dto.negocioIds }, excluidoEm: null },
      select: {
        id: true,
        titulo: true,
        funilId: true,
        etapaId: true,
        responsavelId: true,
        contatoId: true,
        empresaId: true,
      },
    });
    const porId = new Map(encontrados.map((n) => [n.id, n]));
    const acesso = await funisAcessiveis(this.prisma, usuario);
    const falhas: FalhaEmMassaDto[] = [];
    let sucesso = 0;

    // Em série: negócios do mesmo contato (etiquetas) e a posição no quadro.
    for (const id of dto.negocioIds) {
      const alvo = porId.get(id);
      if (!alvo || !acesso.podeVerNegocio(alvo)) {
        falhas.push({
          negocioId: id,
          titulo: null,
          statusCode: 404,
          regra: null,
          mensagem: 'Negócio não encontrado.',
        });
        continue;
      }
      try {
        await this.aplicar(usuario, acesso, alvo, dados);
        sucesso += 1;
      } catch (erro) {
        falhas.push(this.falhaDe(alvo, erro));
      }
    }

    await this.prisma.$transaction((tx) =>
      this.auditoria.registrar(tx, {
        acao: 'negocio.acao_em_massa',
        entidade: 'negocio',
        resumo: `Ação em massa ${dto.acao}: ${sucesso} de ${dto.negocioIds.length} negócios atualizados`,
        dados: {
          acao: dto.acao,
          total: dto.negocioIds.length,
          sucesso,
          falhas: falhas.length,
        },
      }),
    );
    return { total: dto.negocioIds.length, sucesso, falhas };
  }

  /**
   * R34.6: `DISCADOR` envia todos os negócios de uma vez ao 3C+ (um `mailing.json`), só Admin, C-level
   * e líder (403 para os demais). `sucesso` = importados; `falhas` = os que ficaram de fora (sem
   * telefone, sem acesso, filtrados pelo 3C+), com o motivo.
   */
  private async enviarAoDiscador(
    usuario: UsuarioAutenticado,
    dto: AcaoEmMassaDto,
    dados: Extract<DadosValidados, { acao: 'DISCADOR' }>,
  ): Promise<ResultadoEmMassaDto> {
    const relatorio = await this.discador.enviar(usuario, {
      campanhaId: dados.campanhaId,
      listaId: dados.listaId,
      nomeLista: dados.nomeLista,
      negocioIds: dto.negocioIds,
    });
    const titulos = new Map(
      (
        await this.prisma.negocio.findMany({
          where: { id: { in: dto.negocioIds } },
          select: { id: true, titulo: true },
        })
      ).map((n) => [n.id, n.titulo]),
    );
    const falhas: FalhaEmMassaDto[] = [];
    for (const detalhe of relatorio.detalhes) {
      if (detalhe.identifier === null) continue;
      falhas.push({
        negocioId: detalhe.identifier,
        titulo: titulos.get(detalhe.identifier) ?? null,
        statusCode: 422,
        regra: 'R34',
        mensagem: detalhe.motivo,
      });
    }
    // Filtrados pelo 3C+ sem identificar o número entram só no relatório (`discador.detalhes`).
    const sucesso = relatorio.importados;
    await this.prisma.$transaction((tx) =>
      this.auditoria.registrar(tx, {
        acao: 'negocio.acao_em_massa',
        entidade: 'negocio',
        resumo: `Ação em massa DISCADOR: ${relatorio.importados} de ${dto.negocioIds.length} negócios importados no 3C+`,
        dados: {
          acao: dto.acao,
          total: dto.negocioIds.length,
          sucesso,
          falhas: falhas.length,
          campanhaId: dados.campanhaId,
        },
      }),
    );
    return {
      total: dto.negocioIds.length,
      sucesso,
      falhas,
      discador: relatorio,
    };
  }

  private async aplicar(
    usuario: UsuarioAutenticado,
    acesso: AcessoAosFunis,
    alvo: NegocioAlvo,
    dados: DadosValidados,
  ): Promise<void> {
    switch (dados.acao) {
      case 'MOVER':
        await this.negocios.mover(usuario, alvo.id, {
          etapaId: dados.etapaId,
          motivoPerda: dados.motivoPerda,
        });
        return;
      case 'GANHAR':
        await this.negocios.mover(usuario, alvo.id, {
          etapaId: await this.etapaDeFechamento(alvo, 'GANHO'),
        });
        return;
      case 'PERDER':
        await this.negocios.mover(usuario, alvo.id, {
          etapaId: await this.etapaDeFechamento(alvo, 'PERDIDO'),
          motivoPerda: dados.motivoPerda,
        });
        return;
      case 'RESPONSAVEL':
        await this.negocios.atualizar(usuario, alvo.id, {
          responsavelId: dados.responsavelId,
        });
        return;
      case 'EXCLUIR':
        await this.negocios.excluir(usuario, alvo.id);
        return;
      case 'DISCADOR':
        return; // tratada em `enviarAoDiscador`, antes do laço
      case 'ETIQUETAR':
      case 'DESETIQUETAR':
        this.exigirAcao(acesso, alvo);
        await this.etiquetar(usuario, alvo, dados);
        return;
      case 'ATIVIDADE':
        this.exigirAcao(acesso, alvo);
        await this.atividades.criar(usuario, {
          tipo: dados.tipo,
          titulo: dados.titulo,
          descricao: dados.descricao,
          venceEm: dados.vencimento,
          negocioId: alvo.id,
          responsavelId: alvo.responsavelId ?? usuario.id,
        });
        return;
    }
  }

  /** Etapa de ganho ou de perda do funil do negócio (a primeira, pela ordem). */
  private async etapaDeFechamento(
    alvo: NegocioAlvo,
    tipo: 'GANHO' | 'PERDIDO',
  ): Promise<string> {
    const etapa = await this.prisma.etapa.findFirst({
      where: { funilId: alvo.funilId, tipo },
      orderBy: { ordem: 'asc' },
      select: { id: true },
    });
    if (!etapa) {
      throw new RegraVioladaException(
        'R5.4',
        `O funil deste negócio não tem etapa de ${tipo === 'GANHO' ? 'ganho' : 'perda'}.`,
        { funilId: alvo.funilId },
      );
    }
    return etapa.id;
  }

  private async etiquetar(
    usuario: UsuarioAutenticado,
    alvo: NegocioAlvo,
    dados: Extract<DadosValidados, { etiquetas: string[] }>,
  ): Promise<void> {
    const contato = await this.prisma.contato.findFirst({
      where: { id: alvo.contatoId, excluidoEm: null },
      select: { etiquetas: true },
    });
    if (!contato) {
      throw new NaoEncontradoException('Contato não encontrado.');
    }
    const chave = (e: string) => e.toLocaleLowerCase('pt-BR');
    let novas: string[];
    if (dados.acao === 'ETIQUETAR') {
      novas = normalizarEtiquetas([...contato.etiquetas, ...dados.etiquetas]);
    } else {
      const remover = new Set(dados.etiquetas.map(chave));
      novas = contato.etiquetas.filter((e) => !remover.has(chave(e)));
    }
    if (novas.length === contato.etiquetas.length) {
      const iguais = novas.every((e, i) => e === contato.etiquetas[i]);
      if (iguais) {
        return;
      }
    }
    await this.contatos.atualizar(usuario, alvo.contatoId, {
      etiquetas: novas,
    });
  }

  /** R5.12: quem só vê (ou o membro, em negócio alheio) não age. */
  private exigirAcao(acesso: AcessoAosFunis, alvo: NegocioAlvo): void {
    if (!acesso.podeAgirNoNegocio(alvo)) {
      throw new SemPermissaoException(
        acesso.nivel(alvo.funilId) === 'MEMBRO'
          ? 'Você só pode ver este negócio: neste funil você edita e move só os seus e os sem responsável.'
          : 'Você só pode ver os negócios deste funil: não pode editar, mover nem assumir.',
        { regra: 'R5.12' },
      );
    }
  }

  private falhaDe(alvo: NegocioAlvo, erro: unknown): FalhaEmMassaDto {
    if (erro instanceof ErroApi) {
      const regra = erro.detalhes?.regra;
      return {
        negocioId: alvo.id,
        titulo: alvo.titulo,
        statusCode: erro.getStatus(),
        regra: typeof regra === 'string' ? regra : null,
        mensagem: erro.mensagem,
      };
    }
    if (erro instanceof HttpException) {
      return {
        negocioId: alvo.id,
        titulo: alvo.titulo,
        statusCode: erro.getStatus(),
        regra: null,
        mensagem: erro.message,
      };
    }
    return {
      negocioId: alvo.id,
      titulo: alvo.titulo,
      statusCode: 500,
      regra: null,
      mensagem: 'Não foi possível atualizar este negócio.',
    };
  }
}
