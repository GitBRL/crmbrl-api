/**
 * Sugestões de atividade do resumo (R30): só viram atividade com a confirmação do usuário.
 * Confirmar cria a atividade do contato (pelo `AtividadesService`, com as regras e a auditoria de
 * sempre) e marca a sugestão; descartar só marca. Cada sugestão vale uma vez.
 */
import { Injectable } from '@nestjs/common';
import { AtividadesService } from '../../atividades/atividades.service';
import type { CriarAtividadeDto } from '../../atividades/dto/criar-atividade.dto';
import { AuditoriaService } from '../../auditoria/auditoria.service';
import type { UsuarioAutenticado } from '../../auth/usuario-autenticado';
import {
  ConflitoException,
  DadosInvalidosException,
  NaoEncontradoException,
} from '../../comum/erros/excecoes';
import type { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  REGRA_TRANSCRICAO,
  type ResumoGravado,
  type SugestaoDeAtividade,
} from '../../transcricao/transcricao.constantes';
import type {
  ConfirmarSugestaoDto,
  ConteudoDoResumoDto,
  RespostaDeSugestaoDto,
} from './gravacao.dto';
import { LeituraDaGravacaoService } from './leitura-gravacao.service';

/** O vencimento padrão: às 18h de Brasília (21h UTC), daqui a `dias` dias; se já passou, daqui a 1 h. */
export function vencimentoSugerido(prazoEmDias: number, agora: Date): Date {
  const base = new Date(agora.getTime() - 3 * 3_600_000);
  const alvo = new Date(
    Date.UTC(
      base.getUTCFullYear(),
      base.getUTCMonth(),
      base.getUTCDate() + prazoEmDias,
      21,
      0,
      0,
    ),
  );
  return alvo.getTime() > agora.getTime()
    ? alvo
    : new Date(agora.getTime() + 3_600_000);
}

function conteudoDe(resumo: ResumoGravado): ConteudoDoResumoDto {
  return {
    assunto: resumo.assunto,
    pontosPrincipais: resumo.pontosPrincipais,
    combinados: resumo.combinados,
    proximosPassos: resumo.proximosPassos,
    sentimento: resumo.sentimento,
    sentimentoMotivo: resumo.sentimentoMotivo,
    sugestoes: resumo.sugestoes.map((s) => ({
      id: s.id,
      titulo: s.titulo,
      descricao: s.descricao,
      tipo: s.tipo,
      prazoEmDias: s.prazoEmDias,
      atividadeId: s.atividadeId,
      descartadaEm: s.descartadaEm,
    })),
    modelo: resumo.modelo,
  };
}

@Injectable()
export class SugestoesDeAtividadeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly leitura: LeituraDaGravacaoService,
    private readonly atividades: AtividadesService,
    private readonly auditoria: AuditoriaService,
  ) {}

  /** Cria a atividade da sugestão (os campos do corpo ajustam o que o usuário editou). */
  async confirmar(
    usuario: UsuarioAutenticado,
    ligacaoId: string,
    sugestaoId: string,
    dto: ConfirmarSugestaoDto,
  ): Promise<RespostaDeSugestaoDto> {
    const ligacao = await this.leitura.ligacaoVisivel(usuario, ligacaoId);
    const sugestao = await this.reservar(ligacaoId, sugestaoId);
    try {
      const tipo = dto.tipo ?? sugestao.tipo;
      const agora = new Date();
      const vence = dto.venceEm
        ? new Date(dto.venceEm)
        : vencimentoSugerido(sugestao.prazoEmDias, agora);
      if (Number.isNaN(vence.getTime())) {
        throw new DadosInvalidosException('Data de vencimento inválida.', {
          campos: [{ campo: 'venceEm', mensagens: ['use o formato ISO 8601'] }],
        });
      }
      const corpo = {
        tipo,
        titulo: dto.titulo ?? sugestao.titulo,
        descricao:
          dto.descricao ??
          `${sugestao.descricao}\n\nSugerida pelo resumo da ligação de ${ligacao.iniciadaEm.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })}.`.trim(),
        contatoId: ligacao.contatoId,
        responsavelId: dto.responsavelId,
        ...(tipo === 'REUNIAO'
          ? {
              inicioEm: vence.toISOString(),
              fimEm: dto.fimEm
                ? new Date(dto.fimEm).toISOString()
                : new Date(vence.getTime() + 3_600_000).toISOString(),
            }
          : { venceEm: vence.toISOString() }),
      } as unknown as CriarAtividadeDto;
      const atividade = await this.atividades.criar(usuario, corpo);
      const resumo = await this.marcar(ligacaoId, sugestaoId, {
        atividadeId: atividade.id,
        reservadaEm: null,
      });
      await this.prisma.$transaction((tx) =>
        this.auditoria.registrar(tx, {
          acao: 'ligacao.sugestao-confirmada',
          entidade: 'ligacao',
          entidadeId: ligacaoId,
          resumo: 'Sugestão de atividade do resumo confirmada',
          dados: { regra: REGRA_TRANSCRICAO, atividadeId: atividade.id, tipo },
          relacionados: { contato: ligacao.contatoId, atividade: atividade.id },
        }),
      );
      return {
        sugestaoId,
        atividadeId: atividade.id,
        resumo: conteudoDe(resumo),
      };
    } catch (erro) {
      await this.marcar(ligacaoId, sugestaoId, { reservadaEm: null }).catch(
        () => undefined,
      );
      throw erro;
    }
  }

  async descartar(
    usuario: UsuarioAutenticado,
    ligacaoId: string,
    sugestaoId: string,
  ): Promise<RespostaDeSugestaoDto> {
    const ligacao = await this.leitura.ligacaoVisivel(usuario, ligacaoId);
    await this.reservar(ligacaoId, sugestaoId);
    const resumo = await this.marcar(ligacaoId, sugestaoId, {
      descartadaEm: new Date().toISOString(),
      reservadaEm: null,
    });
    await this.prisma.$transaction((tx) =>
      this.auditoria.registrar(tx, {
        acao: 'ligacao.sugestao-descartada',
        entidade: 'ligacao',
        entidadeId: ligacaoId,
        resumo: 'Sugestão de atividade do resumo descartada',
        dados: { regra: REGRA_TRANSCRICAO },
        relacionados: { contato: ligacao.contatoId },
      }),
    );
    return { sugestaoId, atividadeId: null, resumo: conteudoDe(resumo) };
  }

  /**
   * Trava a ligação e reserva a sugestão (`reservadaEm`) para duas confirmações juntas não criarem
   * duas atividades. 409 se já foi confirmada, descartada ou está sendo confirmada.
   */
  private async reservar(
    ligacaoId: string,
    sugestaoId: string,
  ): Promise<SugestaoDeAtividade & { reservadaEm?: string | null }> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM ligacoes WHERE id = ${ligacaoId}::uuid FOR UPDATE`;
      const ligacao = await tx.ligacao.findUniqueOrThrow({
        where: { id: ligacaoId },
        select: { resumo: true },
      });
      const resumo = ligacao.resumo as unknown as ResumoGravado | null;
      const sugestao = resumo?.sugestoes.find((s) => s.id === sugestaoId) as
        (SugestaoDeAtividade & { reservadaEm?: string | null }) | undefined;
      if (!resumo || !sugestao) {
        throw new NaoEncontradoException('Sugestão não encontrada.');
      }
      const reservaViva =
        sugestao.reservadaEm &&
        Date.now() - new Date(sugestao.reservadaEm).getTime() < 60_000;
      if (sugestao.atividadeId || sugestao.descartadaEm || reservaViva) {
        throw new ConflitoException(
          sugestao.atividadeId
            ? 'Esta sugestão já virou uma atividade.'
            : sugestao.descartadaEm
              ? 'Esta sugestão já foi descartada.'
              : 'Esta sugestão está sendo confirmada.',
          { regra: REGRA_TRANSCRICAO, motivo: 'sugestao_ja_tratada' },
        );
      }
      sugestao.reservadaEm = new Date().toISOString();
      await tx.ligacao.update({
        where: { id: ligacaoId },
        data: { resumo: resumo as unknown as Prisma.InputJsonValue },
      });
      return { ...sugestao };
    });
  }

  /** Atualiza campos da sugestão (sob trava) e devolve o resumo. */
  private async marcar(
    ligacaoId: string,
    sugestaoId: string,
    campos: Partial<
      Pick<SugestaoDeAtividade, 'atividadeId' | 'descartadaEm'>
    > & { reservadaEm?: null },
  ): Promise<ResumoGravado> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM ligacoes WHERE id = ${ligacaoId}::uuid FOR UPDATE`;
      const ligacao = await tx.ligacao.findUniqueOrThrow({
        where: { id: ligacaoId },
        select: { resumo: true },
      });
      const resumo = ligacao.resumo as unknown as ResumoGravado;
      const sugestao = resumo.sugestoes.find((s) => s.id === sugestaoId) as
        (SugestaoDeAtividade & { reservadaEm?: string | null }) | undefined;
      if (!sugestao) {
        throw new NaoEncontradoException('Sugestão não encontrada.');
      }
      Object.assign(sugestao, campos);
      if (campos.reservadaEm === null) {
        delete sugestao.reservadaEm;
      }
      await tx.ligacao.update({
        where: { id: ligacaoId },
        data: { resumo: resumo as unknown as Prisma.InputJsonValue },
      });
      return resumo;
    });
  }
}
