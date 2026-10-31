import { Injectable, OnModuleInit } from '@nestjs/common';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import { AuditoriaService } from '../auditoria/auditoria.service';
import { ArquivosService } from '../arquivos/arquivos.service';
import { ehDiretoria } from '../comum/dominio/papeis';
import { permissoesDoPapel } from '../comum/dominio/permissoes';
import { normalizarEtiquetas } from '../comum/dominio/etiquetas';
import {
  DadosInvalidosException,
  NaoEncontradoException,
  RegraVioladaException,
  SemPermissaoException,
} from '../comum/erros/excecoes';
import {
  montarPagina,
  paraSkipTake,
  type Pagina,
} from '../comum/paginacao/paginacao';
import { PermissoesContatosService } from '../contatos/permissoes-contatos.service';
import { FilaService } from '../fila/fila.service';
import type { Importacao, Prisma } from '../generated/prisma/client';
import { PrismaService, type Tx } from '../prisma/prisma.service';
import { EVENTOS_DO_SERVIDOR } from '../tempo-real/catalogo';
import { TempoRealService } from '../tempo-real/tempo-real.service';
import {
  aplicarModeloDeMapeamento,
  camposDoTipo,
  type Mapeamento,
  sugerirMapeamento,
  validarMapeamento,
} from './campos';
import {
  type AtualizarImportacaoDto,
  type CriadaImportacaoDto,
  type CriarImportacaoDto,
  type FiltroImportacoesDto,
  type FiltroLinhasDto,
  ImportacaoDto,
  type LinhaDeImportacaoDto,
  type PreviaDto,
} from './importacao.dto';
import {
  FILA_IMPORTACAO,
  LIMITE_DE_LINHAS_DA_IMPORTACAO,
} from './importacao.constantes';
import {
  cargaDeProgresso,
  ImportacaoProcessadorService,
} from './importacao-processador.service';
import {
  lerPlanilha,
  type OpcoesDeLeitura,
  PlanilhaIlegivelError,
  type PlanilhaLida,
} from './leitor-planilha';

const INCLUIR_CRIADOR = {
  criadoPor: { select: { id: true, nome: true } },
} as const;

/**
 * Importação de contatos e empresas (R16): envio, prévia, mapeamento, opções,
 * início, cancelamento, histórico e relatório. O processamento é do
 * `ImportacaoProcessadorService` (fila `importacao.processar`).
 */
@Injectable()
export class ImportacaoService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly arquivos: ArquivosService,
    private readonly auditoria: AuditoriaService,
    private readonly fila: FilaService,
    private readonly permissoes: PermissoesContatosService,
    private readonly processador: ImportacaoProcessadorService,
    private readonly tempoReal: TempoRealService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.fila.trabalhar<{ importacaoId: string }>(
      FILA_IMPORTACAO,
      async ({ dados }) => this.processador.processar(dados.importacaoId),
      {
        tentativas: 3,
        intervaloEntreTentativasSegundos: 30,
        prazoDeExecucaoSegundos: 7200,
      },
    );
    // R16.9: a planilha e o relatório seguem a visibilidade da importação.
    this.arquivos.registrarVerificadorDeAcesso(
      'IMPORTACAO',
      (usuario, arquivo) =>
        this.podeVerArquivo(usuario, { arquivoId: arquivo.id }),
    );
    this.arquivos.registrarVerificadorDeAcesso(
      'RELATORIO',
      (usuario, arquivo) =>
        this.podeVerArquivo(usuario, { relatorioId: arquivo.id }),
    );
  }

  // =========================================================================
  // Permissão
  // =========================================================================

  /** R16.1: importa quem tem a permissão `importarContatos` (Admin, C-level e líderes). */
  garantirPodeImportar(usuario: UsuarioAutenticado): void {
    if (!permissoesDoPapel(usuario.papel).importarContatos) {
      throw new SemPermissaoException(
        'Só o Admin, a diretoria e os líderes importam planilhas.',
        { regra: 'R16.1' },
      );
    }
  }

  private visiveis(usuario: UsuarioAutenticado): Prisma.ImportacaoWhereInput {
    return ehDiretoria(usuario.papel) ? {} : { criadoPorId: usuario.id };
  }

  private async podeVerArquivo(
    usuario: UsuarioAutenticado,
    onde: { arquivoId: string } | { relatorioId: string },
  ): Promise<boolean> {
    const achada = await this.prisma.importacao.findFirst({
      where: { ...onde, ...this.visiveis(usuario) },
      select: { id: true },
    });
    return achada !== null;
  }

  // =========================================================================
  // Consulta
  // =========================================================================

  async listar(
    usuario: UsuarioAutenticado,
    filtro: FiltroImportacoesDto,
  ): Promise<Pagina<ImportacaoDto>> {
    this.garantirPodeImportar(usuario);
    const where: Prisma.ImportacaoWhereInput = {
      ...this.visiveis(usuario),
      ...(filtro.status ? { status: filtro.status } : {}),
      ...(filtro.tipo ? { tipo: filtro.tipo } : {}),
    };
    const [itens, total] = await Promise.all([
      this.prisma.importacao.findMany({
        where,
        include: INCLUIR_CRIADOR,
        orderBy: [{ criadoEm: 'desc' }, { id: 'desc' }],
        ...paraSkipTake(filtro),
      }),
      this.prisma.importacao.count({ where }),
    ]);
    return montarPagina(
      itens.map((i) => ImportacaoDto.de(i)),
      total,
      filtro,
    );
  }

  async detalhar(
    usuario: UsuarioAutenticado,
    id: string,
  ): Promise<ImportacaoDto> {
    return ImportacaoDto.de(await this.obter(usuario, id));
  }

  async obter(usuario: UsuarioAutenticado, id: string) {
    this.garantirPodeImportar(usuario);
    const importacao = await this.prisma.importacao.findFirst({
      where: { id, ...this.visiveis(usuario) },
      include: INCLUIR_CRIADOR,
    });
    if (!importacao) {
      throw new NaoEncontradoException('Importação não encontrada.');
    }
    return importacao;
  }

  async previa(
    usuario: UsuarioAutenticado,
    id: string,
    linhas: number,
  ): Promise<PreviaDto> {
    const importacao = await this.obter(usuario, id);
    const planilha = await this.ler(importacao);
    return montarPrevia(importacao.tipo, planilha, linhas);
  }

  async linhas(
    usuario: UsuarioAutenticado,
    id: string,
    filtro: FiltroLinhasDto,
  ): Promise<Pagina<LinhaDeImportacaoDto>> {
    await this.obter(usuario, id);
    const where: Prisma.ImportacaoLinhaWhereInput = {
      importacaoId: id,
      ...(filtro.resultado ? { resultado: filtro.resultado } : {}),
    };
    const [itens, total] = await Promise.all([
      this.prisma.importacaoLinha.findMany({
        where,
        orderBy: { numero: 'asc' },
        ...paraSkipTake(filtro),
      }),
      this.prisma.importacaoLinha.count({ where }),
    ]);
    return montarPagina(
      itens.map((l) => ({
        numero: l.numero,
        resultado: l.resultado,
        entidadeId: l.entidadeId,
        motivo: l.motivo,
        dados: (l.dados ?? null) as Record<string, unknown> | null,
      })),
      total,
      filtro,
    );
  }

  /** Arquivo do relatório XLSX (404 enquanto não existe). */
  async relatorio(usuario: UsuarioAutenticado, id: string) {
    const importacao = await this.obter(usuario, id);
    if (!importacao.relatorioId) {
      throw new NaoEncontradoException(
        'O relatório ainda não está disponível.',
      );
    }
    const arquivo = await this.arquivos.obter(importacao.relatorioId);
    return { arquivo, stream: await this.arquivos.abrirConteudo(arquivo) };
  }

  // =========================================================================
  // Fluxo
  // =========================================================================

  /** R16.2: cria o rascunho a partir de um arquivo já enviado (contexto IMPORTACAO). */
  async criar(
    usuario: UsuarioAutenticado,
    dto: CriarImportacaoDto,
  ): Promise<CriadaImportacaoDto> {
    this.garantirPodeImportar(usuario);
    const arquivo = await this.arquivos.obter(dto.arquivoId);
    if (
      arquivo.contexto !== 'IMPORTACAO' ||
      (arquivo.criadoPorId !== usuario.id && !ehDiretoria(usuario.papel))
    ) {
      throw new NaoEncontradoException('Arquivo não encontrado.');
    }
    const formato = formatoDoArquivo(arquivo.nome, arquivo.mime);
    if (!formato) {
      throw new DadosInvalidosException('Envie uma planilha CSV ou XLSX.', {
        campos: [
          {
            campo: 'arquivoId',
            mensagens: ['formato não aceito (use .csv ou .xlsx)'],
          },
        ],
      });
    }
    const leitura = limparLeitura(dto.leitura);
    const planilha = await this.lerArquivo(arquivo.id, formato, leitura);
    this.garantirTamanho(planilha);
    const sugestao = sugerirMapeamento(dto.tipo, planilha.colunas);
    const criada = await this.prisma.$transaction(async (tx) => {
      const importacao = await tx.importacao.create({
        data: {
          tipo: dto.tipo,
          nome: arquivo.nome,
          arquivoId: arquivo.id,
          formato,
          leitura: planilha.leitura as Prisma.InputJsonObject,
          colunas: planilha.colunas,
          totalLinhas: planilha.linhas.length,
          mapeamento: sugestao,
          criadoPorId: usuario.id,
        },
        include: INCLUIR_CRIADOR,
      });
      await this.auditoria.registrar(tx, {
        acao: 'importacao.criada',
        entidade: 'importacao',
        entidadeId: importacao.id,
        resumo: `Importação de ${rotuloDoTipo(dto.tipo)} criada a partir de "${arquivo.nome}" (${planilha.linhas.length} linhas)`,
        dados: {
          tipo: dto.tipo,
          formato,
          totalLinhas: planilha.linhas.length,
          regra: 'R16.2',
        },
      });
      return importacao;
    });
    return Object.assign(ImportacaoDto.de(criada), {
      previa: montarPrevia(dto.tipo, planilha, 10),
    });
  }

  /** R16.3: mapeamento e opções, só no rascunho. */
  async atualizar(
    usuario: UsuarioAutenticado,
    id: string,
    dto: AtualizarImportacaoDto,
  ): Promise<ImportacaoDto> {
    const atual = await this.obter(usuario, id);
    this.garantirStatus(
      atual,
      ['RASCUNHO'],
      'Só uma importação em rascunho pode ser alterada.',
    );
    const dados: Prisma.ImportacaoUncheckedUpdateInput = {};
    let colunas = atual.colunas;
    let mapeamento = atual.mapeamento as Mapeamento;

    if (dto.leitura) {
      const leitura = limparLeitura(dto.leitura);
      const planilha = await this.lerArquivo(
        atual.arquivoId,
        atual.formato as 'csv' | 'xlsx',
        leitura,
      );
      this.garantirTamanho(planilha);
      colunas = planilha.colunas;
      mapeamento = sugerirMapeamento(atual.tipo, colunas);
      dados.leitura = planilha.leitura as Prisma.InputJsonObject;
      dados.colunas = colunas;
      dados.totalLinhas = planilha.linhas.length;
      dados.mapeamento = mapeamento;
      dados.modeloId = null;
    }
    if (dto.modeloId !== undefined) {
      if (dto.modeloId === null) {
        dados.modeloId = null;
      } else {
        const modelo = await this.prisma.importacaoModelo.findFirst({
          where: { id: dto.modeloId, tipo: atual.tipo },
        });
        if (!modelo) {
          throw new DadosInvalidosException(
            'Modelo de mapeamento não encontrado.',
            {
              campos: [
                {
                  campo: 'modeloId',
                  mensagens: ['modelo não encontrado para este tipo'],
                },
              ],
            },
          );
        }
        mapeamento = aplicarModeloDeMapeamento(
          modelo.mapeamento as Record<string, unknown>,
          colunas,
        );
        dados.modeloId = modelo.id;
        dados.mapeamento = mapeamento;
        const opcoes = modelo.opcoes as {
          duplicados?: string;
          etiquetas?: string[];
        };
        if (
          dto.duplicados === undefined &&
          ['ATUALIZAR_VAZIOS', 'IGNORAR', 'SOBRESCREVER'].includes(
            opcoes.duplicados ?? '',
          )
        ) {
          dados.duplicados = opcoes.duplicados as Importacao['duplicados'];
        }
        if (dto.etiquetas === undefined && Array.isArray(opcoes.etiquetas)) {
          dados.etiquetas = normalizarEtiquetas(opcoes.etiquetas);
        }
      }
    } else if (dto.mapeamento !== undefined) {
      const problemas = validarMapeamento(
        atual.tipo,
        colunas,
        dto.mapeamento,
        false,
      );
      if (problemas.length > 0) {
        throw new DadosInvalidosException('O mapeamento tem problemas.', {
          regra: 'R16.3',
          campos: problemas.map((p) => ({
            campo: p.campo,
            mensagens: [p.mensagem],
          })),
        });
      }
      mapeamento = dto.mapeamento;
      dados.mapeamento = mapeamento;
    }
    if (dto.duplicados !== undefined) {
      dados.duplicados = dto.duplicados;
    }
    if (dto.etiquetas !== undefined) {
      dados.etiquetas = normalizarEtiquetas(dto.etiquetas);
    }
    if (dto.origemDetalhe !== undefined) {
      dados.origemDetalhe = dto.origemDetalhe?.trim() || null;
    }
    if (
      dto.estrategiaResponsavel !== undefined ||
      dto.responsavelId !== undefined ||
      dto.areaRodizio !== undefined
    ) {
      const estrategia =
        dto.estrategiaResponsavel === undefined
          ? atual.estrategiaResponsavel
          : dto.estrategiaResponsavel;
      const responsavelId =
        estrategia === 'RESPONSAVEL_FIXO'
          ? dto.responsavelId === undefined
            ? atual.responsavelId
            : dto.responsavelId
          : null;
      const area =
        estrategia === 'RODIZIO'
          ? dto.areaRodizio === undefined
            ? atual.areaRodizio
            : dto.areaRodizio
          : null;
      await this.validarResponsavel(usuario, estrategia, responsavelId, area);
      dados.estrategiaResponsavel = estrategia;
      dados.responsavelId = responsavelId;
      dados.areaRodizio = area;
    }
    const atualizada = await this.prisma.importacao.update({
      where: { id },
      data: dados,
      include: INCLUIR_CRIADOR,
    });
    return ImportacaoDto.de(atualizada);
  }

  /** R16.4: confere tudo e põe na fila. */
  async iniciar(
    usuario: UsuarioAutenticado,
    id: string,
  ): Promise<ImportacaoDto> {
    const atual = await this.obter(usuario, id);
    this.garantirStatus(
      atual,
      ['RASCUNHO'],
      'Esta importação já foi iniciada.',
    );
    const problemas = validarMapeamento(
      atual.tipo,
      atual.colunas,
      atual.mapeamento as Record<string, unknown>,
      true,
    );
    if (problemas.length > 0) {
      throw new RegraVioladaException(
        'R16.3',
        'Complete o mapeamento antes de importar.',
        {
          campos: problemas.map((p) => ({
            campo: p.campo,
            mensagens: [p.mensagem],
          })),
        },
      );
    }
    await this.validarResponsavel(
      usuario,
      atual.estrategiaResponsavel,
      atual.responsavelId,
      atual.areaRodizio,
    );
    return this.enfileirar(usuario, atual, 'importacao.iniciada', 'iniciada');
  }

  /** R16.7: retoma uma importação que falhou, depois da última linha gravada. */
  async retomar(
    usuario: UsuarioAutenticado,
    id: string,
  ): Promise<ImportacaoDto> {
    const atual = await this.obter(usuario, id);
    this.garantirStatus(
      atual,
      ['FALHOU'],
      'Só uma importação que falhou pode ser retomada.',
    );
    return this.enfileirar(usuario, atual, 'importacao.retomada', 'retomada');
  }

  private async enfileirar(
    usuario: UsuarioAutenticado,
    atual: Importacao,
    acao: string,
    verbo: string,
  ): Promise<ImportacaoDto> {
    const atualizada = await this.prisma.$transaction(async (tx) => {
      const mudou = await tx.importacao.updateMany({
        where: { id: atual.id, status: atual.status },
        data: { status: 'NA_FILA', erro: null },
      });
      if (mudou.count === 0) {
        throw new RegraVioladaException(
          'R16.4',
          'A situação da importação mudou. Recarregue a página.',
        );
      }
      await this.auditoria.registrar(tx, {
        acao,
        entidade: 'importacao',
        entidadeId: atual.id,
        resumo: `Importação "${atual.nome}" ${verbo}`,
        dados: {
          tipo: atual.tipo,
          totalLinhas: atual.totalLinhas,
          duplicados: atual.duplicados,
          etiquetas: atual.etiquetas,
          estrategiaResponsavel: atual.estrategiaResponsavel,
          regra: 'R16.4',
        },
      });
      await this.fila.enviar(
        FILA_IMPORTACAO,
        { importacaoId: atual.id },
        { tx },
      );
      return tx.importacao.findUniqueOrThrow({
        where: { id: atual.id },
        include: INCLUIR_CRIADOR,
      });
    });
    this.tempoReal.emitirParaUsuario(
      usuario.id,
      EVENTOS_DO_SERVIDOR.IMPORTACAO_PROGRESSO,
      cargaDeProgresso(atualizada),
    );
    return ImportacaoDto.de(atualizada);
  }

  /** R16.7: cancela; o que já foi gravado fica (não há desfazer). */
  async cancelar(
    usuario: UsuarioAutenticado,
    id: string,
  ): Promise<ImportacaoDto> {
    const atual = await this.obter(usuario, id);
    this.garantirStatus(
      atual,
      ['RASCUNHO', 'NA_FILA', 'PROCESSANDO', 'FALHOU'],
      'Esta importação já terminou.',
    );
    const cancelada = await this.prisma.$transaction(async (tx) => {
      const mudou = await tx.importacao.updateMany({
        where: { id, status: atual.status },
        data: { status: 'CANCELADA', concluidaEm: new Date() },
      });
      if (mudou.count === 0) {
        throw new RegraVioladaException(
          'R16.7',
          'A situação da importação mudou. Recarregue a página.',
        );
      }
      await this.auditoria.registrar(tx, {
        acao: 'importacao.cancelada',
        entidade: 'importacao',
        entidadeId: id,
        resumo: `Importação "${atual.nome}" cancelada com ${atual.processadas} de ${atual.totalLinhas ?? 0} linhas processadas`,
        dados: {
          processadas: atual.processadas,
          criados: atual.criados,
          atualizados: atual.atualizados,
          regra: 'R16.7',
        },
      });
      return tx.importacao.findUniqueOrThrow({
        where: { id },
        include: INCLUIR_CRIADOR,
      });
    });
    if (cancelada.criadoPorId) {
      this.tempoReal.emitirParaUsuario(
        cancelada.criadoPorId,
        EVENTOS_DO_SERVIDOR.IMPORTACAO_PROGRESSO,
        cargaDeProgresso(cancelada),
      );
    }
    return ImportacaoDto.de(cancelada);
  }

  /** Apaga um rascunho, uma importação cancelada ou que falhou (e a planilha enviada). */
  async remover(usuario: UsuarioAutenticado, id: string): Promise<void> {
    const atual = await this.obter(usuario, id);
    this.garantirStatus(
      atual,
      ['RASCUNHO', 'CANCELADA', 'FALHOU'],
      'Só rascunhos, importações canceladas ou que falharam podem ser apagadas.',
    );
    await this.prisma.$transaction(async (tx) => {
      await tx.importacao.delete({ where: { id } });
      await this.auditoria.registrar(tx, {
        acao: 'importacao.removida',
        entidade: 'importacao',
        entidadeId: id,
        resumo: `Importação "${atual.nome}" apagada`,
        dados: { status: atual.status },
      });
      await this.arquivos.remover(atual.arquivoId, { tx });
    });
  }

  // =========================================================================
  // Internos
  // =========================================================================

  private garantirStatus(
    importacao: Importacao,
    aceitos: Importacao['status'][],
    mensagem: string,
  ): void {
    if (!aceitos.includes(importacao.status)) {
      throw new RegraVioladaException('R16.4', mensagem, {
        status: importacao.status,
      });
    }
  }

  private garantirTamanho(planilha: PlanilhaLida): void {
    if (planilha.linhas.length === 0) {
      throw new RegraVioladaException(
        'R16.2',
        'A planilha não tem linhas de dados.',
      );
    }
    if (planilha.linhas.length > LIMITE_DE_LINHAS_DA_IMPORTACAO) {
      throw new RegraVioladaException(
        'R16.2',
        `A planilha tem ${planilha.linhas.length} linhas; o máximo é ${LIMITE_DE_LINHAS_DA_IMPORTACAO.toLocaleString('pt-BR')}. Divida o arquivo.`,
        { limite: LIMITE_DE_LINHAS_DA_IMPORTACAO },
      );
    }
  }

  private ler(importacao: Importacao): Promise<PlanilhaLida> {
    return this.lerArquivo(
      importacao.arquivoId,
      importacao.formato as 'csv' | 'xlsx',
      importacao.leitura as OpcoesDeLeitura,
    );
  }

  private async lerArquivo(
    arquivoId: string,
    formato: 'csv' | 'xlsx',
    leitura: OpcoesDeLeitura,
  ): Promise<PlanilhaLida> {
    const { conteudo } = await this.arquivos.lerConteudo(arquivoId);
    try {
      return await lerPlanilha(conteudo, formato, leitura);
    } catch (erro) {
      if (erro instanceof PlanilhaIlegivelError) {
        throw new DadosInvalidosException(erro.message, {
          regra: 'R16.2',
          campos: [{ campo: 'arquivoId', mensagens: [erro.message] }],
        });
      }
      throw erro;
    }
  }

  /** R16.6: o responsável fixo é um usuário ativo ao alcance de quem importa; o rodízio pede a área. */
  private async validarResponsavel(
    usuario: UsuarioAutenticado,
    estrategia: Importacao['estrategiaResponsavel'],
    responsavelId: string | null,
    area: Importacao['areaRodizio'],
  ): Promise<void> {
    if (estrategia === 'RESPONSAVEL_FIXO') {
      if (!responsavelId) {
        throw new DadosInvalidosException('Escolha o responsável.', {
          campos: [
            {
              campo: 'responsavelId',
              mensagens: ['é obrigatório com responsável fixo'],
            },
          ],
        });
      }
      const alcance = await this.permissoes.alcance(usuario);
      await this.prisma.$transaction((tx: Tx) =>
        this.permissoes.garantirPodeAtribuir(
          tx,
          alcance,
          responsavelId,
          'contato',
        ),
      );
    }
    if (estrategia === 'RODIZIO' && !area) {
      throw new DadosInvalidosException('Escolha a área do rodízio.', {
        campos: [
          { campo: 'areaRodizio', mensagens: ['é obrigatória com rodízio'] },
        ],
      });
    }
  }
}

// ---------------------------------------------------------------------------

export function rotuloDoTipo(tipo: Importacao['tipo']): string {
  return tipo === 'CONTATOS' ? 'contatos' : 'empresas';
}

/** `csv` ou `xlsx` pelo nome (ou tipo) do arquivo; `null` se não for planilha aceita. */
export function formatoDoArquivo(
  nome: string,
  mime: string,
): 'csv' | 'xlsx' | null {
  const n = nome.toLowerCase();
  if (n.endsWith('.xlsx') || mime.includes('spreadsheetml')) {
    return 'xlsx';
  }
  if (n.endsWith('.csv') || mime === 'text/csv') {
    return 'csv';
  }
  return null;
}

function limparLeitura(
  leitura: AtualizarImportacaoDto['leitura'],
): OpcoesDeLeitura {
  const limpa: OpcoesDeLeitura = {};
  if (leitura?.separador) limpa.separador = leitura.separador;
  if (leitura?.codificacao) limpa.codificacao = leitura.codificacao;
  if (leitura?.aba) limpa.aba = leitura.aba;
  if (leitura?.linhaCabecalho) limpa.linhaCabecalho = leitura.linhaCabecalho;
  return limpa;
}

function montarPrevia(
  tipo: Importacao['tipo'],
  planilha: PlanilhaLida,
  linhas: number,
): PreviaDto {
  return {
    colunas: planilha.colunas,
    linhas: planilha.linhas
      .slice(0, linhas)
      .map((l) => ({ numero: l.numero, valores: l.valores })),
    totalLinhas: planilha.linhas.length,
    sugestao: sugerirMapeamento(tipo, planilha.colunas),
    ...(planilha.leitura.abas ? { abas: planilha.leitura.abas } : {}),
  };
}

export { camposDoTipo };
