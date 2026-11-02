import { Injectable } from '@nestjs/common';
import { validarHorario } from '../../atendimento/horario';
import { AuditoriaService } from '../../auditoria/auditoria.service';
import { calcularAlteracoes } from '../../comum/dados/sanitizar';
import {
  DadosInvalidosException,
  NaoEncontradoException,
} from '../../comum/erros/excecoes';
import {
  type Canal,
  type FilaAtendimento,
  Prisma,
  type TipoCanal,
} from '../../generated/prisma/client';
import { PrismaService, type Tx } from '../../prisma/prisma.service';
import { ROTULO_DO_TIPO_DE_CANAL } from '../registro-canais';
import type { CamposComunsDoCanalDto } from './dto-comum';

/** Canal com o resumo da fila padrão, como as telas de configuração mostram. */
export type CanalComFila = Canal & {
  filaPadrao: Pick<FilaAtendimento, 'id' | 'nome'> | null;
};

/** Campos que entram no "antes/depois" da auditoria do canal (os segredos vão sem valor). */
const CAMPOS_AUDITADOS = [
  'nome',
  'ativo',
  'idExterno',
  'configuracao',
  'segredosCifrados',
  'filaPadraoId',
  'horarioAtendimento',
  'mensagemForaHorario',
  'pesquisaSatisfacao',
  'mensagemSatisfacao',
] as const;

const INCLUIR_FILA = {
  filaPadrao: { select: { id: true, nome: true } },
} as const;

/**
 * Parte comum da configuração dos canais extras (chat do site, e-mail, Meta):
 * busca por tipo, campos comuns validados (fila padrão, horário), criação,
 * edição e exclusão com auditoria (R3.1), e o registro do último erro técnico.
 * Cada módulo de canal monta a sua `configuracao` e os seus segredos.
 */
@Injectable()
export class ConfiguracaoDeCanais {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditoria: AuditoriaService,
  ) {}

  /** Canais (não excluídos) dos tipos, por nome. */
  listar(tipos: readonly TipoCanal[]): Promise<CanalComFila[]> {
    return this.prisma.canal.findMany({
      where: { tipo: { in: [...tipos] }, excluidoEm: null },
      include: INCLUIR_FILA,
      orderBy: [{ nome: 'asc' }, { criadoEm: 'asc' }],
    });
  }

  /** O canal (não excluído) de um dos tipos; 404 se não existe ou é de outro tipo. */
  async obter(
    id: string,
    tipos: readonly TipoCanal[],
    tx: Tx = this.prisma,
  ): Promise<CanalComFila> {
    const canal = await tx.canal.findFirst({
      where: { id, tipo: { in: [...tipos] }, excluidoEm: null },
      include: INCLUIR_FILA,
    });
    if (!canal) {
      throw new NaoEncontradoException('Canal não encontrado.');
    }
    return canal;
  }

  /** Trava o canal para editar (`FOR UPDATE`) e o devolve. */
  async travar(
    tx: Tx,
    id: string,
    tipos: readonly TipoCanal[],
  ): Promise<CanalComFila> {
    await tx.$queryRaw`SELECT id FROM canais WHERE id = ${id}::uuid FOR UPDATE`;
    return this.obter(id, tipos, tx);
  }

  /**
   * Converte os campos comuns do DTO para gravar, conferindo a fila padrão
   * (existe e está ativa) e o horário (formato e fuso). Campos ausentes ficam
   * de fora (na edição, não mudam).
   */
  async camposComuns(
    tx: Tx,
    dto: Partial<CamposComunsDoCanalDto>,
  ): Promise<Prisma.CanalUncheckedUpdateInput> {
    const dados: Prisma.CanalUncheckedUpdateInput = {};
    if (dto.nome !== undefined) {
      dados.nome = dto.nome;
    }
    if (dto.ativo !== undefined) {
      dados.ativo = dto.ativo;
    }
    if (dto.filaPadraoId !== undefined) {
      if (dto.filaPadraoId !== null) {
        const fila = await tx.filaAtendimento.findFirst({
          where: { id: dto.filaPadraoId, excluidoEm: null },
          select: { ativa: true },
        });
        if (!fila) {
          throw new DadosInvalidosException(
            'Fila de atendimento não encontrada.',
            {
              campos: [
                { campo: 'filaPadraoId', mensagens: ['fila não encontrada'] },
              ],
            },
          );
        }
        if (!fila.ativa) {
          throw new DadosInvalidosException(
            'A fila escolhida está desativada: escolha uma fila ativa.',
            {
              campos: [
                { campo: 'filaPadraoId', mensagens: ['fila desativada'] },
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
    return dados;
  }

  /** Cria o canal com a auditoria `canal.criado`. */
  async criar(
    tx: Tx,
    dados: Prisma.CanalUncheckedCreateInput,
  ): Promise<CanalComFila> {
    const canal = await tx.canal.create({ data: dados, include: INCLUIR_FILA });
    await this.auditoria.registrar(tx, {
      acao: 'canal.criado',
      entidade: 'canal',
      entidadeId: canal.id,
      resumo: `Canal de ${ROTULO_DO_TIPO_DE_CANAL[canal.tipo]} "${canal.nome}" criado`,
      dados: {
        tipo: canal.tipo,
        alteracoes: calcularAlteracoes({}, canal, CAMPOS_AUDITADOS),
      },
    });
    return canal;
  }

  /** Grava a edição e audita `canal.atualizado` (só se algo mudou). */
  async atualizar(
    tx: Tx,
    antes: Canal,
    dados: Prisma.CanalUncheckedUpdateInput,
  ): Promise<CanalComFila> {
    const depois = await tx.canal.update({
      where: { id: antes.id },
      data: dados,
      include: INCLUIR_FILA,
    });
    const alteracoes = calcularAlteracoes(antes, depois, CAMPOS_AUDITADOS);
    if (Object.keys(alteracoes).length > 0) {
      await this.auditoria.registrar(tx, {
        acao: 'canal.atualizado',
        entidade: 'canal',
        entidadeId: depois.id,
        resumo: `Canal de ${ROTULO_DO_TIPO_DE_CANAL[depois.tipo]} "${depois.nome}" alterado`,
        dados: { tipo: depois.tipo, alteracoes },
      });
    }
    return depois;
  }

  /**
   * Exclusão lógica: o canal some das telas, para de receber e enviar e libera
   * o identificador externo. As conversas ficam (histórico).
   */
  async excluir(id: string, tipos: readonly TipoCanal[]): Promise<Canal> {
    return this.prisma.$transaction(async (tx) => {
      const canal = await this.travar(tx, id, tipos);
      const excluido = await tx.canal.update({
        where: { id },
        data: { excluidoEm: new Date(), ativo: false },
      });
      await this.auditoria.registrar(tx, {
        acao: 'canal.excluido',
        entidade: 'canal',
        entidadeId: id,
        resumo: `Canal de ${ROTULO_DO_TIPO_DE_CANAL[canal.tipo]} "${canal.nome}" excluído`,
        dados: { tipo: canal.tipo },
      });
      return excluido;
    });
  }

  /**
   * Registra (ou limpa, com `null`) o último erro técnico do canal. SQL direto:
   * não é uma alteração da configuração (não mexe em `atualizado_em`).
   */
  async registrarErro(canalId: string, erro: string | null): Promise<void> {
    if (erro) {
      await this.prisma.$executeRaw`
        UPDATE canais
           SET ultimo_erro = ${erro.slice(0, 1000)}, ultimo_erro_em = ${new Date()}
         WHERE id = ${canalId}::uuid`;
      return;
    }
    await this.prisma.$executeRaw`
      UPDATE canais SET ultimo_erro = NULL, ultimo_erro_em = NULL
       WHERE id = ${canalId}::uuid AND ultimo_erro IS NOT NULL`;
  }

  /**
   * Acrescenta chaves ao `estado` técnico do canal (cursor do IMAP, última
   * varredura…), sem mexer em `atualizado_em`.
   */
  async atualizarEstado(
    canalId: string,
    parcial: Record<string, unknown>,
    tx: Tx = this.prisma,
  ): Promise<void> {
    await tx.$executeRaw`
      UPDATE canais
         SET estado = COALESCE(estado, '{}'::jsonb) || ${JSON.stringify(parcial)}::jsonb
       WHERE id = ${canalId}::uuid`;
  }
}
