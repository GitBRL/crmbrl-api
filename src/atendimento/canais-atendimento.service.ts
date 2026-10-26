import { Injectable } from '@nestjs/common';
import { AuditoriaService } from '../auditoria/auditoria.service';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import {
  RegistroCanais,
  ROTULO_DO_TIPO_DE_CANAL,
} from '../canais/registro-canais';
import { calcularAlteracoes } from '../comum/dados/sanitizar';
import { ehDiretoria } from '../comum/dominio/papeis';
import {
  DadosInvalidosException,
  NaoEncontradoException,
  SemPermissaoException,
} from '../comum/erros/excecoes';
import {
  type Canal,
  type FilaAtendimento,
  Prisma,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { REGRA_ATENDIMENTO } from './atendimento.constantes';
import { exigirAtendimento } from './conversas.service';
import { iso, ResumoFilaDto } from './dto/comum.dto';
import type {
  AtualizarAtendimentoDoCanalDto,
  CanalDoAtendimentoDto,
} from './dto/canal-atendimento.dto';
import { lerHorario, situacaoDoHorario, validarHorario } from './horario';
import { PERGUNTA_PADRAO_DA_PESQUISA } from './satisfacao';

type CanalComFila = Canal & { filaPadrao: FilaAtendimento | null };

const CAMPOS_AUDITADOS = [
  'filaPadraoId',
  'horarioAtendimento',
  'mensagemForaHorario',
  'pesquisaSatisfacao',
  'mensagemSatisfacao',
] as const;

/**
 * A parte de atendimento dos canais (R12): fila padrão das conversas novas,
 * horário de atendimento com a resposta automática de fora do horário e a
 * pesquisa de satisfação. A criação dos canais e as credenciais ficam nos
 * módulos de cada canal; aqui, a lista de todos (para filtros) e o ajuste
 * desses campos — por Admin e C-level.
 */
@Injectable()
export class CanaisDoAtendimentoService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditoria: AuditoriaService,
    private readonly registro: RegistroCanais,
  ) {}

  async listar(usuario: UsuarioAutenticado): Promise<CanalDoAtendimentoDto[]> {
    exigirAtendimento(usuario);
    const canais = await this.prisma.canal.findMany({
      where: { excluidoEm: null },
      include: { filaPadrao: true },
      orderBy: [{ tipo: 'asc' }, { nome: 'asc' }, { id: 'asc' }],
    });
    const emAberto = await this.prisma.conversa.groupBy({
      by: ['canalId'],
      where: { status: { not: 'RESOLVIDA' } },
      _count: { _all: true },
    });
    const porCanal = new Map(
      emAberto.map((grupo) => [grupo.canalId, grupo._count._all]),
    );
    return canais.map((canal) =>
      this.paraDto(usuario, canal, porCanal.get(canal.id) ?? 0),
    );
  }

  async detalhar(
    usuario: UsuarioAutenticado,
    id: string,
  ): Promise<CanalDoAtendimentoDto> {
    exigirAtendimento(usuario);
    const canal = await this.obter(id);
    return this.paraDto(usuario, canal, await this.emAberto(id));
  }

  async atualizar(
    usuario: UsuarioAutenticado,
    id: string,
    dto: AtualizarAtendimentoDoCanalDto,
  ): Promise<CanalDoAtendimentoDto> {
    exigirAtendimento(usuario);
    if (!ehDiretoria(usuario.papel)) {
      throw new SemPermissaoException(
        'Só Admin e C-level alteram a configuração de atendimento dos canais.',
        { regra: REGRA_ATENDIMENTO },
      );
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM canais WHERE id = ${id}::uuid FOR UPDATE`;
      const antes = await tx.canal.findFirst({
        where: { id, excluidoEm: null },
      });
      if (!antes) {
        throw new NaoEncontradoException('Canal não encontrado.');
      }
      const dados: Prisma.CanalUncheckedUpdateInput = {};
      if (dto.filaPadraoId !== undefined) {
        if (dto.filaPadraoId !== null) {
          const fila = await tx.filaAtendimento.findFirst({
            where: { id: dto.filaPadraoId, excluidoEm: null },
            select: { ativa: true },
          });
          if (!fila || !fila.ativa) {
            throw new DadosInvalidosException(
              fila
                ? 'A fila escolhida está desativada: escolha uma fila ativa.'
                : 'Fila de atendimento não encontrada.',
              {
                campos: [
                  {
                    campo: 'filaPadraoId',
                    mensagens: [
                      fila ? 'fila desativada' : 'fila não encontrada',
                    ],
                  },
                ],
              },
            );
          }
        }
        dados.filaPadraoId = dto.filaPadraoId;
      }
      if (dto.horarioAtendimento !== undefined) {
        if (dto.horarioAtendimento === null) {
          dados.horarioAtendimento = Prisma.DbNull;
        } else {
          const lido = validarHorario(dto.horarioAtendimento);
          if (lido.erros) {
            throw new DadosInvalidosException(lido.erros[0], {
              campos: [{ campo: 'horarioAtendimento', mensagens: lido.erros }],
            });
          }
          dados.horarioAtendimento =
            lido.horario as unknown as Prisma.InputJsonObject;
        }
      }
      if (dto.mensagemForaHorario !== undefined) {
        dados.mensagemForaHorario = dto.mensagemForaHorario;
      }
      if (dto.pesquisaSatisfacao !== undefined) {
        dados.pesquisaSatisfacao = dto.pesquisaSatisfacao;
      }
      if (dto.mensagemSatisfacao !== undefined) {
        dados.mensagemSatisfacao = dto.mensagemSatisfacao;
      }
      const depois = await tx.canal.update({ where: { id }, data: dados });
      const alteracoes = calcularAlteracoes(antes, depois, CAMPOS_AUDITADOS);
      if (Object.keys(alteracoes).length > 0) {
        await this.auditoria.registrar(tx, {
          acao: 'canal.atualizado',
          entidade: 'canal',
          entidadeId: id,
          resumo: `Atendimento do canal de ${ROTULO_DO_TIPO_DE_CANAL[depois.tipo]} "${depois.nome}" alterado`,
          dados: { tipo: depois.tipo, alteracoes },
        });
      }
    });
    return this.detalhar(usuario, id);
  }

  // -------------------------------------------------------------------------

  private async obter(id: string): Promise<CanalComFila> {
    const canal = await this.prisma.canal.findFirst({
      where: { id, excluidoEm: null },
      include: { filaPadrao: true },
    });
    if (!canal) {
      throw new NaoEncontradoException('Canal não encontrado.');
    }
    return canal;
  }

  private emAberto(canalId: string): Promise<number> {
    return this.prisma.conversa.count({
      where: { canalId, status: { not: 'RESOLVIDA' } },
    });
  }

  private paraDto(
    usuario: UsuarioAutenticado,
    canal: CanalComFila,
    conversasEmAberto: number,
  ): CanalDoAtendimentoDto {
    const horario = lerHorario(canal.horarioAtendimento);
    const situacao = situacaoDoHorario(horario);
    const fila =
      canal.filaPadrao && !canal.filaPadrao.excluidoEm
        ? canal.filaPadrao
        : null;
    return {
      id: canal.id,
      tipo: canal.tipo,
      nome: canal.nome,
      ativo: canal.ativo,
      disponivel: this.registro.buscar(canal.tipo) !== undefined,
      filaPadrao: ResumoFilaDto.ouNulo(fila),
      horarioAtendimento: horario,
      situacaoHorario: {
        aberto: situacao.aberto,
        proximaAbertura: iso(situacao.proximaAbertura),
        proximoFechamento: iso(situacao.proximoFechamento),
      },
      mensagemForaHorario: canal.mensagemForaHorario,
      pesquisaSatisfacao: canal.pesquisaSatisfacao,
      mensagemSatisfacao: canal.mensagemSatisfacao,
      perguntaPadrao: PERGUNTA_PADRAO_DA_PESQUISA,
      conversasEmAberto,
      ultimoErro: canal.ultimoErro,
      ultimoErroEm: iso(canal.ultimoErroEm),
      podeEditar: ehDiretoria(usuario.papel),
    };
  }
}
