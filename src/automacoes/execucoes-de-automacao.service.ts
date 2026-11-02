import { Injectable } from '@nestjs/common';
import { AuditoriaService } from '../auditoria/auditoria.service';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import {
  DadosInvalidosException,
  NaoEncontradoException,
  RegraVioladaException,
} from '../comum/erros/excecoes';
import { montarPagina, paraSkipTake } from '../comum/paginacao/paginacao';
import type { DefinicaoDePassos } from '../comum/passos/definicao';
import { PassosService } from '../comum/passos/passos.service';
import type { Execucao, Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { REGRA_AUTOMACOES } from './automacoes.constantes';
import { FiltroExecucoesDto } from './automacoes.dto';
import { AutomacoesService } from './automacoes.service';
import {
  type EntidadeDeAutomacao,
  IniciadorDeExecucao,
} from './iniciador-de-execucao.service';
import { filtroDeAutomacoesVisiveis } from './permissoes-automacoes';

type ExecucaoComContato = Execucao & {
  contato: { id: string; nome: string } | null;
};

export interface ExecucaoDeAutomacaoDto {
  id: string;
  automacaoId: string | null;
  automacaoNome: string;
  automacaoVersao: number | null;
  status: string;
  entidade: string | null;
  entidadeId: string | null;
  contato: { id: string; nome: string } | null;
  negocioId: string | null;
  conversaId: string | null;
  teste: boolean;
  passoAtualId: string | null;
  aguardandoAte: string | null;
  motivoFim: string | null;
  erro: string | null;
  passosExecutados: number;
  iniciadaEm: string;
  concluidaEm: string | null;
}

export interface PassoDaExecucaoDto {
  ordem: number;
  passoId: string;
  tipo: string;
  rotulo: string | null;
  visita: number;
  status: string;
  tentativas: number;
  /** `{ decisao, saida }` do passo (em teste: o que seria feito). */
  resultado: unknown;
  erro: string | null;
  iniciadoEm: string;
  concluidoEm: string | null;
}

/**
 * Histórico das execuções (por automação e por entidade), reexecutar passo com
 * erro, cancelar e modo teste (R19): o teste roda a automação sobre uma entidade
 * escolhida sem efeitos externos (mensagens e ações simuladas, esperas puladas).
 */
@Injectable()
export class ExecucoesDeAutomacao {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passos: PassosService,
    private readonly automacoes: AutomacoesService,
    private readonly iniciador: IniciadorDeExecucao,
    private readonly auditoria: AuditoriaService,
  ) {}

  private montar(e: ExecucaoComContato): ExecucaoDeAutomacaoDto {
    return {
      id: e.id,
      automacaoId: e.automacaoId,
      automacaoNome: e.nome,
      automacaoVersao: e.automacaoVersao,
      status: e.status,
      entidade: e.entidade,
      entidadeId: e.entidadeId,
      contato: e.contato,
      negocioId: e.negocioId,
      conversaId: e.conversaId,
      teste: e.teste,
      passoAtualId: e.passoAtualId,
      aguardandoAte: e.aguardandoAte?.toISOString() ?? null,
      motivoFim: e.motivoFim,
      erro: e.erro,
      passosExecutados: e.passosExecutados,
      iniciadaEm: e.iniciadaEm.toISOString(),
      concluidaEm: e.concluidaEm?.toISOString() ?? null,
    };
  }

  async listar(usuario: UsuarioAutenticado, filtro: FiltroExecucoesDto) {
    this.automacoes.exigirUso(usuario);
    if (filtro.automacaoId) {
      await this.automacoes.obter(usuario, filtro.automacaoId);
    }
    const where: Prisma.ExecucaoWhereInput = {
      tipo: 'AUTOMACAO',
      automacao: {
        is: { excluidoEm: null, ...filtroDeAutomacoesVisiveis(usuario) },
      },
      teste: filtro.teste ?? false,
      ...(filtro.automacaoId ? { automacaoId: filtro.automacaoId } : {}),
      ...(filtro.entidade ? { entidade: filtro.entidade } : {}),
      ...(filtro.entidadeId ? { entidadeId: filtro.entidadeId } : {}),
      ...(filtro.contatoId ? { contatoId: filtro.contatoId } : {}),
      ...(filtro.status?.length ? { status: { in: filtro.status } } : {}),
    };
    const [total, linhas] = await Promise.all([
      this.prisma.execucao.count({ where }),
      this.prisma.execucao.findMany({
        where,
        orderBy: { criadoEm: 'desc' },
        include: { contato: { select: { id: true, nome: true } } },
        ...paraSkipTake(filtro),
      }),
    ]);
    return montarPagina(
      linhas.map((l) => this.montar(l)),
      total,
      filtro,
    );
  }

  private async carregar(
    usuario: UsuarioAutenticado,
    id: string,
  ): Promise<ExecucaoComContato> {
    this.automacoes.exigirUso(usuario);
    const execucao = await this.prisma.execucao.findFirst({
      where: {
        id,
        tipo: 'AUTOMACAO',
        automacao: {
          is: { excluidoEm: null, ...filtroDeAutomacoesVisiveis(usuario) },
        },
      },
      include: { contato: { select: { id: true, nome: true } } },
    });
    if (!execucao) {
      throw new NaoEncontradoException('Execução não encontrada.');
    }
    return execucao;
  }

  async detalhar(usuario: UsuarioAutenticado, id: string) {
    const execucao = await this.carregar(usuario, id);
    const historico = await this.prisma.execucaoPasso.findMany({
      where: { execucaoId: id },
      orderBy: { ordem: 'asc' },
    });
    const rotulos = new Map<string, string | null>();
    const visitar = (passos: DefinicaoDePassos['passos']) => {
      for (const p of passos) {
        rotulos.set(p.id, p.rotulo ?? null);
        for (const r of p.ramos ?? []) {
          visitar(r.passos);
        }
      }
    };
    visitar((execucao.definicao as unknown as DefinicaoDePassos).passos ?? []);
    return {
      ...this.montar(execucao),
      variaveis: execucao.variaveis,
      contexto: execucao.contexto,
      definicao: execucao.definicao,
      passos: historico.map((p): PassoDaExecucaoDto => ({
        ordem: p.ordem,
        passoId: p.passoId,
        tipo: p.tipo,
        rotulo: rotulos.get(p.passoId) ?? null,
        visita: p.visita,
        status: p.status,
        tentativas: p.tentativas,
        resultado: p.resultado,
        erro: p.erro,
        iniciadoEm: p.iniciadoEm.toISOString(),
        concluidoEm: p.concluidoEm?.toISOString() ?? null,
      })),
    };
  }

  /** Reexecuta o passo com erro (a execução FALHOU volta ao passo que falhou). */
  async reexecutar(usuario: UsuarioAutenticado, id: string) {
    const execucao = await this.carregar(usuario, id);
    if (execucao.status !== 'FALHOU' || !execucao.passoAtualId) {
      throw new RegraVioladaException(
        REGRA_AUTOMACOES,
        'Só se reexecuta o passo de uma execução que falhou.',
        { status: execucao.status },
      );
    }
    const reaberta = await this.passos.reexecutarPasso(id);
    if (reaberta) {
      await this.prisma.$transaction((tx) =>
        this.auditoria.registrar(tx, {
          acao: 'automacao.passo_reexecutado',
          entidade: 'automacao',
          entidadeId: execucao.automacaoId,
          resumo: `${usuario.nome} reexecutou o passo "${execucao.passoAtualId}" da automação "${execucao.nome}"`,
          dados: { execucaoId: id, passoId: execucao.passoAtualId },
          relacionados: { contato: execucao.contatoId },
        }),
      );
    }
    return this.detalhar(usuario, id);
  }

  async cancelar(usuario: UsuarioAutenticado, id: string) {
    const execucao = await this.carregar(usuario, id);
    const cancelou = await this.passos.cancelar(id, 'cancelada_manualmente');
    if (!cancelou) {
      throw new RegraVioladaException(
        REGRA_AUTOMACOES,
        'A execução já terminou.',
        { status: execucao.status },
      );
    }
    return this.detalhar(usuario, id);
  }

  /**
   * Modo teste (R19): roda a automação sobre a entidade escolhida, sem efeitos
   * externos. Devolve se as condições valeriam para ela e o histórico simulado.
   */
  async testar(usuario: UsuarioAutenticado, id: string, entidadeId: string) {
    const automacao = await this.automacoes.obter(usuario, id);
    const avaliacao = this.automacoes.avaliar(automacao);
    if (avaliacao.erros.length > 0) {
      throw new DadosInvalidosException(avaliacao.erros[0], {
        problemas: avaliacao.erros.map((mensagem) => ({ mensagem })),
      });
    }
    const alvo = await this.iniciador.resolverAlvo(
      automacao.entidade as EntidadeDeAutomacao,
      entidadeId,
    );
    if (!alvo || !this.iniciador.noEscopo(automacao, alvo)) {
      throw new NaoEncontradoException(
        `Não encontramos esse ${automacao.entidade} para o teste.`,
      );
    }
    const motivo = await this.iniciador.conferir(automacao, alvo);
    const { execucao } = await this.passos.iniciar(
      {
        tipo: 'AUTOMACAO',
        nome: automacao.nome,
        definicao: avaliacao.definicao,
        automacaoId: automacao.id,
        automacaoVersao: automacao.versao,
        entidade: alvo.entidade,
        entidadeId: alvo.entidadeId,
        contatoId: alvo.contatoId,
        negocioId: alvo.negocioId,
        conversaId: alvo.conversaId,
        teste: true,
        contexto: { gatilho: { tipo: 'TESTE' }, solicitadoPor: usuario.id },
      },
      { executarAgora: true },
    );
    await this.prisma.$transaction((tx) =>
      this.auditoria.registrar(tx, {
        acao: 'automacao.testada',
        entidade: 'automacao',
        entidadeId: automacao.id,
        resumo: `${usuario.nome} testou a automação "${automacao.nome}" em modo teste`,
        dados: { execucaoId: execucao.id, entidade: alvo.entidade, entidadeId },
      }),
    );
    return {
      condicoesAtendidas: motivo === null,
      motivoDasCondicoes: motivo,
      execucao: await this.detalhar(usuario, execucao.id),
    };
  }
}
