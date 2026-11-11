/**
 * Histórico de dúvidas, só do Admin (R25): todas as perguntas com filtros
 * (categoria, área, pessoa, período, módulo, avaliação…), os temas mais
 * pedidos sem resposta, os chamados abertos, o uso do mês e a exportação
 * (XLSX ou CSV com `;`, auditada).
 */
import { Injectable } from '@nestjs/common';
import { ArquivoDto } from '../arquivos/arquivos.dto';
import { ArquivosService } from '../arquivos/arquivos.service';
import { AuditoriaService } from '../auditoria/auditoria.service';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import { rotuloDoPapel } from '../comum/dominio/papeis';
import { nomeDoSetor } from '../comum/dominio/setores';
import {
  montarPagina,
  type Pagina,
  paraSkipTake,
} from '../comum/paginacao/paginacao';
import { escreverExportacao } from '../financeiro/exportacao';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  type Categoria,
  REGRA_ASSISTENTE,
  ROTULO_DA_CATEGORIA,
} from './assistente.constantes';
import {
  AssistenteService,
  inicioDeHoje,
  inicioDoDiaTexto,
  inicioDoMes,
  perguntaParaDto,
  totalDeTokens,
} from './assistente.service';
import { BaseDeConhecimentoService } from './base-de-conhecimento';
import { chamadoParaDto } from './chamados/chamados-assistente.service';
import { ConfiguracaoAssistenteService } from './configuracao-assistente.service';
import type {
  ChamadoAssistenteDto,
  ExportarHistoricoAssistenteDto,
  FiltroChamadosAssistenteDto,
  FiltroHistoricoAssistenteDto,
  FiltroPeriodoAssistenteDto,
  PerguntaAssistenteDto,
} from './dto/assistente.dto';

/** Linhas máximas da exportação. */
const MAX_LINHAS_EXPORTACAO = 20_000;

export interface TemaSemResposta {
  resumo: string;
  modulo: string;
  categoria: Categoria;
  total: number;
  pessoas: number;
  ultimaEm: string;
  exemploPerguntaId: string;
}

function periodo(
  f: FiltroPeriodoAssistenteDto,
): Prisma.DateTimeFilter | undefined {
  if (!f.de && !f.ate) {
    return undefined;
  }
  return {
    ...(f.de ? { gte: inicioDoDiaTexto(f.de) } : {}),
    ...(f.ate ? { lt: inicioDoDiaTexto(f.ate, true) } : {}),
  };
}

/** Normaliza o resumo para agrupar ("Exportar contatos." ≈ "exportar contatos"). */
function chaveDoTema(texto: string): string {
  return texto
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function dataHora(d: Date): string {
  return d.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

@Injectable()
export class HistoricoAssistenteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditoria: AuditoriaService,
    private readonly arquivos: ArquivosService,
    private readonly assistente: AssistenteService,
    private readonly configuracao: ConfiguracaoAssistenteService,
    private readonly base: BaseDeConhecimentoService,
  ) {}

  private onde(
    f: FiltroHistoricoAssistenteDto,
  ): Prisma.AssistentePerguntaWhereInput {
    const where: Prisma.AssistentePerguntaWhereInput = {};
    const criadoEm = periodo(f);
    if (criadoEm) where.criadoEm = criadoEm;
    if (f.categoria) where.categoria = f.categoria;
    if (f.area) where.area = f.area === 'SEM_AREA' ? null : f.area;
    if (f.usuarioId) where.usuarioId = f.usuarioId;
    if (f.modulo) where.modulo = f.modulo;
    if (f.resolvido !== undefined) where.resolvido = f.resolvido;
    if (f.avaliacao) {
      where.avaliacao = f.avaliacao === 'SEM_AVALIACAO' ? null : f.avaliacao;
    }
    if (f.comChamado !== undefined) {
      where.chamado = f.comChamado ? { isNot: null } : { is: null };
    }
    if (f.busca?.trim()) {
      const busca = f.busca.trim();
      where.OR = [
        { pergunta: { contains: busca, mode: 'insensitive' } },
        { resposta: { contains: busca, mode: 'insensitive' } },
        { resumoDoPedido: { contains: busca, mode: 'insensitive' } },
      ];
    }
    return where;
  }

  async historico(
    f: FiltroHistoricoAssistenteDto,
  ): Promise<Pagina<PerguntaAssistenteDto>> {
    const where = this.onde(f);
    const [itens, total] = await Promise.all([
      this.prisma.assistentePergunta.findMany({
        where,
        orderBy: { criadoEm: 'desc' },
        ...paraSkipTake(f),
        include: {
          chamado: true,
          conversa: {
            select: {
              papel: true,
              usuario: { select: { id: true, nome: true } },
            },
          },
        },
      }),
      this.prisma.assistentePergunta.count({ where }),
    ]);
    return montarPagina(
      itens.map((p) =>
        Object.assign(perguntaParaDto(p), {
          tokens: totalDeTokens(p),
          usuario: {
            id: p.conversa.usuario.id,
            nome: p.conversa.usuario.nome,
            papel: p.conversa.papel,
            area: p.area,
          },
        }),
      ),
      total,
      f,
    );
  }

  /**
   * Temas mais pedidos sem resposta: perguntas concluídas com `resolvido`
   * falso (fora do escopo não conta) ou avaliadas como não úteis, agrupadas
   * pelo resumo do pedido normalizado. Os 20 maiores grupos.
   */
  async temas(f: FiltroPeriodoAssistenteDto): Promise<TemaSemResposta[]> {
    const criadoEm = periodo(f);
    const linhas = await this.prisma.assistentePergunta.findMany({
      where: {
        status: 'CONCLUIDA',
        ...(criadoEm ? { criadoEm } : {}),
        OR: [
          { resolvido: false, NOT: { categoria: 'fora_do_escopo' } },
          { avaliacao: 'NAO_UTIL' },
        ],
      },
      orderBy: { criadoEm: 'desc' },
      take: 5000,
      select: {
        id: true,
        resumoDoPedido: true,
        pergunta: true,
        modulo: true,
        categoria: true,
        usuarioId: true,
        criadoEm: true,
      },
    });
    const grupos = new Map<
      string,
      TemaSemResposta & { usuarios: Set<string> }
    >();
    for (const l of linhas) {
      const resumo = (l.resumoDoPedido || l.pergunta).slice(0, 200);
      const chave = `${l.modulo}|${chaveDoTema(resumo)}`;
      const g = grupos.get(chave);
      if (g) {
        g.total++;
        g.usuarios.add(l.usuarioId);
      } else {
        grupos.set(chave, {
          resumo,
          modulo: l.modulo,
          categoria: (l.categoria ?? 'duvida_de_uso') as Categoria,
          total: 1,
          pessoas: 0,
          ultimaEm: l.criadoEm.toISOString(),
          exemploPerguntaId: l.id,
          usuarios: new Set([l.usuarioId]),
        });
      }
    }
    return [...grupos.values()]
      .map(({ usuarios, ...g }) => ({ ...g, pessoas: usuarios.size }))
      .sort((a, b) => b.total - a.total || b.ultimaEm.localeCompare(a.ultimaEm))
      .slice(0, 20);
  }

  async chamados(
    f: FiltroChamadosAssistenteDto,
  ): Promise<Pagina<ChamadoAssistenteDto>> {
    const criadoEm = periodo(f);
    const where: Prisma.AssistenteChamadoWhereInput = {
      ...(criadoEm ? { criadoEm } : {}),
      ...(f.status ? { status: f.status } : {}),
    };
    const [itens, total] = await Promise.all([
      this.prisma.assistenteChamado.findMany({
        where,
        orderBy: { criadoEm: 'desc' },
        ...paraSkipTake(f),
        include: { usuario: { select: { id: true, nome: true } } },
      }),
      this.prisma.assistenteChamado.count({ where }),
    ]);
    return montarPagina(
      itens.map((c) =>
        Object.assign(chamadoParaDto(c), {
          usuario: { id: c.usuario.id, nome: c.usuario.nome },
        }),
      ),
      total,
      f,
    );
  }

  /** Configuração (mascarada), uso do mês e a base de conhecimento lida. */
  async painel() {
    const config = await this.configuracao.ler();
    const [tokensNoMes, perguntasHoje, perguntasNoMes] = await Promise.all([
      this.assistente.tokensNoMes(),
      this.prisma.assistentePergunta.count({
        where: { criadoEm: { gte: inicioDeHoje() } },
      }),
      this.prisma.assistentePergunta.count({
        where: {
          criadoEm: { gte: inicioDoMes() },
        },
      }),
    ]);
    const base = this.base.atual();
    return {
      ...this.configuracao.visao(config),
      uso: {
        tokensNoMes,
        orcamentoMensalTokens: config.orcamentoMensalTokens,
        perguntasHoje,
        perguntasNoMes,
      },
      baseDeConhecimento: {
        artigos: base.artigos.map((a) => ({
          arquivo: a.arquivo,
          titulo: a.titulo,
        })),
        avisos: base.avisos,
      },
    };
  }

  async exportar(
    usuario: UsuarioAutenticado,
    f: ExportarHistoricoAssistenteDto,
  ): Promise<ArquivoDto> {
    const { formato, ...filtro } = f;
    const linhas = await this.prisma.assistentePergunta.findMany({
      where: this.onde(filtro as FiltroHistoricoAssistenteDto),
      orderBy: { criadoEm: 'desc' },
      take: MAX_LINHAS_EXPORTACAO,
      include: {
        chamado: true,
        conversa: {
          select: {
            papel: true,
            area: true,
            usuario: { select: { nome: true } },
          },
        },
      },
    });
    const hoje = new Date().toISOString().slice(0, 10);
    const arquivo = await escreverExportacao(this.arquivos, {
      base: `duvidas-assistente-${hoje}`,
      formato,
      folha: 'Dúvidas',
      cabecalho: [
        'Data',
        'Pessoa',
        'Papel',
        'Área',
        'Tela',
        'Pergunta',
        'Resposta',
        'Categoria',
        'Resolvido',
        'Resumo do pedido',
        'Avaliação',
        'Chamado',
        'Situação do chamado',
        'Tokens',
        'Situação',
      ],
      linhas: linhas.map((p) => [
        dataHora(p.criadoEm),
        p.conversa.usuario.nome,
        rotuloDoPapel(p.conversa.papel, p.conversa.area),
        p.area ? nomeDoSetor(p.area) : '',
        p.tela,
        p.pergunta,
        p.resposta ?? '',
        p.categoria ? ROTULO_DA_CATEGORIA[p.categoria as Categoria] : '',
        p.resolvido === null ? '' : p.resolvido ? 'Sim' : 'Não',
        p.resumoDoPedido ?? '',
        p.avaliacao === 'UTIL'
          ? 'Útil'
          : p.avaliacao === 'NAO_UTIL'
            ? 'Não útil'
            : '',
        p.chamado?.numero ?? (p.chamado ? 'sem número' : ''),
        p.chamado?.status ?? '',
        totalDeTokens(p),
        p.status,
      ]),
      usuarioId: usuario.id,
    });
    await this.prisma.$transaction((tx) =>
      this.auditoria.registrar(tx, {
        acao: 'assistente.historico_exportado',
        entidade: 'assistente_pergunta',
        entidadeId: null,
        resumo: `${usuario.nome} exportou ${linhas.length} perguntas do assistente de IA (${formato.toUpperCase()})`,
        dados: {
          linhas: linhas.length,
          formato,
          arquivoId: arquivo.id,
          filtros: filtro,
          regra: REGRA_ASSISTENTE,
        },
      }),
    );
    return ArquivoDto.de(arquivo);
  }
}
