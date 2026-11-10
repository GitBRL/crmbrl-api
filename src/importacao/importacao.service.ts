import { Injectable, OnModuleInit } from '@nestjs/common';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import { AuditoriaService } from '../auditoria/auditoria.service';
import { ArquivosService } from '../arquivos/arquivos.service';
import { ehDiretoria } from '../comum/dominio/papeis';
import { permissoesDoPapel } from '../comum/dominio/permissoes';
import { normalizarEtiquetas } from '../comum/dominio/etiquetas';
import {
  DadosInvalidosException,
  ErroApi,
  NaoEncontradoException,
  RegraVioladaException,
  SemPermissaoException,
} from '../comum/erros/excecoes';
import {
  montarPagina,
  paraSkipTake,
  type Pagina,
} from '../comum/paginacao/paginacao';
import { podeGerenciarARegua } from '../financeiro/permissoes-financeiro';
import { PermissoesContatosService } from '../contatos/permissoes-contatos.service';
import { FilaService } from '../fila/fila.service';
import type {
  Importacao,
  Prisma,
  TipoImportacao,
} from '../generated/prisma/client';
import { funisAcessiveis } from '../funis/acessos-no-banco';
import { gerarPlanilhaModelo } from './planilha-modelo';
import { PrismaService, type Tx } from '../prisma/prisma.service';
import { EVENTOS_DO_SERVIDOR } from '../tempo-real/catalogo';
import { TempoRealService } from '../tempo-real/tempo-real.service';
import {
  aplicarModeloDeMapeamento,
  camposDoTipo,
  formatoDeOrigem,
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
  type FunisDaPlanilhaDto,
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
import { DDI_PADRAO } from './ddi';
import {
  compilarFiltro,
  type FiltroDaPlanilha,
  MAXIMO_DE_REGRAS_DO_FILTRO,
  normalizarTextoDoFiltro,
  OPERADORES_SEM_VALOR,
  valorEmReais,
} from './filtro-de-linhas';
import {
  lerFiltro,
  lerNegocio,
  lerOpcoes,
  lerTraducaoDeEtapas,
  lerTraducaoDeFunis,
  type NegocioParaTodos,
  type TraducaoDeEtapas,
  type TraducaoDeFunis,
} from './opcoes';
import { lerStatusDoNegocio } from './dados-do-negocio';
import {
  acharEtapa,
  acharFunil,
  type FunilDoCache,
} from './negocio-da-importacao';
import {
  lerPlanilha,
  type OpcoesDeLeitura,
  PlanilhaIlegivelError,
  type PlanilhaLida,
} from './leitor-planilha';
import { garantirSetorAtivo } from '../setores/setores-no-banco';

const PADRAO_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    return montarPagina(await this.paraDtos(itens), total, filtro);
  }

  async detalhar(
    usuario: UsuarioAutenticado,
    id: string,
  ): Promise<ImportacaoDto> {
    return this.paraDto(await this.obter(usuario, id));
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
    return montarPrevia(
      importacao.tipo,
      planilha,
      linhas,
      lerOpcoes(importacao.opcoes).filtro,
    );
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

  /** R16.10: planilha modelo (mesma permissão de importar; parcelas, a mesma da criação). */
  async planilhaModelo(
    usuario: UsuarioAutenticado,
    tipo: TipoImportacao,
  ): Promise<Buffer> {
    this.garantirPodeImportar(usuario);
    if (tipo === 'PARCELAS' && !podeGerenciarARegua(usuario)) {
      throw new SemPermissaoException(
        'Só Admin, C-level e Líder de CS importam parcelas.',
        { regra: 'R22.1' },
      );
    }
    return gerarPlanilhaModelo(tipo);
  }

  /** R16.2: cria o rascunho a partir de um arquivo já enviado (contexto IMPORTACAO). */
  async criar(
    usuario: UsuarioAutenticado,
    dto: CriarImportacaoDto,
  ): Promise<CriadaImportacaoDto> {
    this.garantirPodeImportar(usuario);
    if (dto.tipo === 'PARCELAS' && !podeGerenciarARegua(usuario)) {
      throw new SemPermissaoException(
        'Só Admin, C-level e Líder de CS importam parcelas.',
        { regra: 'R22.1' },
      );
    }
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
    const sugestao = leitura.semCabecalho
      ? {}
      : sugerirMapeamento(dto.tipo, planilha.colunas);
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
    return Object.assign(await this.paraDto(criada), {
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
    const opcoesBrutas = {
      ...((atual.opcoes ?? {}) as Record<string, unknown>),
    };
    const opcoesAtuais = lerOpcoes(opcoesBrutas);
    let filtro: FiltroDaPlanilha | null = opcoesAtuais.filtro;
    let negocio: NegocioParaTodos | null = opcoesAtuais.negocio;
    let ddiPadrao = opcoesAtuais.ddiPadrao;
    let traducaoFunis = opcoesAtuais.traducaoFunis;
    let traducaoEtapas = opcoesAtuais.traducaoEtapas;
    let opcoesMudaram = false;

    if (dto.leitura) {
      const leitura = limparLeitura(dto.leitura);
      const planilha = await this.lerArquivo(
        atual.arquivoId,
        atual.formato as 'csv' | 'xlsx',
        leitura,
      );
      this.garantirTamanho(planilha);
      colunas = planilha.colunas;
      mapeamento = leitura.semCabecalho
        ? {}
        : sugerirMapeamento(atual.tipo, colunas);
      dados.leitura = planilha.leitura as Prisma.InputJsonObject;
      dados.colunas = colunas;
      dados.totalLinhas = planilha.linhas.length;
      dados.mapeamento = mapeamento;
      dados.modeloId = null;
      // Regra de filtro de coluna que não existe mais na nova leitura é descartada.
      if (filtro) {
        const antes = filtro.regras.length;
        filtro = descartarRegrasSemColuna(filtro, colunas);
        opcoesMudaram ||= (filtro?.regras.length ?? 0) !== antes;
      }
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
        // R16.11–R16.13: o modelo traz filtro (sem as colunas que o arquivo não tem), negócio e DDI.
        if (dto.filtro === undefined) {
          const doModelo = lerFiltro(
            (modelo.opcoes as Record<string, unknown>).filtro,
          );
          filtro = doModelo
            ? descartarRegrasSemColuna(doModelo, colunas)
            : null;
          opcoesMudaram = true;
        }
        if (dto.negocio === undefined && atual.tipo === 'CONTATOS') {
          const doModelo = lerNegocio(
            (modelo.opcoes as Record<string, unknown>).negocio,
          );
          negocio = doModelo
            ? await this.negocioAindaValido(usuario, doModelo)
            : null;
          opcoesMudaram = true;
        }
        if (dto.ddiPadrao === undefined) {
          ddiPadrao = lerOpcoes(modelo.opcoes).ddiPadrao;
          opcoesMudaram = true;
        }
        // R16.14: as traduções do modelo valem; as que não servem mais viram aviso na linha.
        if (dto.traducaoFunis === undefined) {
          traducaoFunis = lerOpcoes(modelo.opcoes).traducaoFunis;
          opcoesMudaram = true;
        }
        if (dto.traducaoEtapas === undefined) {
          traducaoEtapas = lerOpcoes(modelo.opcoes).traducaoEtapas;
          opcoesMudaram = true;
        }
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
    if (dto.filtro !== undefined) {
      filtro =
        dto.filtro === null
          ? null
          : this.validarFiltro(dto.filtro as FiltroDaPlanilha, colunas);
      opcoesMudaram = true;
    }
    if (dto.negocio !== undefined) {
      negocio =
        dto.negocio === null
          ? null
          : await this.validarNegocio(usuario, atual.tipo, dto.negocio);
      opcoesMudaram = true;
    }
    if (dto.ddiPadrao !== undefined) {
      ddiPadrao = dto.ddiPadrao;
      opcoesMudaram = true;
    }
    if (dto.traducaoFunis !== undefined) {
      traducaoFunis = await this.validarTraducaoDeFunis(
        usuario,
        atual.tipo,
        dto.traducaoFunis,
      );
      opcoesMudaram = true;
    }
    if (dto.traducaoEtapas !== undefined) {
      traducaoEtapas = await this.validarTraducaoDeEtapas(
        usuario,
        atual.tipo,
        dto.traducaoEtapas,
      );
      opcoesMudaram = true;
    }
    if (opcoesMudaram) {
      delete opcoesBrutas.filtro;
      delete opcoesBrutas.negocio;
      delete opcoesBrutas.ddiPadrao;
      delete opcoesBrutas.traducaoFunis;
      delete opcoesBrutas.traducaoEtapas;
      if (Object.keys(traducaoFunis).length > 0) {
        opcoesBrutas.traducaoFunis = traducaoFunis;
      }
      if (Object.keys(traducaoEtapas).length > 0) {
        opcoesBrutas.traducaoEtapas = traducaoEtapas;
      }
      if (filtro) opcoesBrutas.filtro = filtro;
      if (negocio) opcoesBrutas.negocio = negocio;
      if (ddiPadrao !== DDI_PADRAO) opcoesBrutas.ddiPadrao = ddiPadrao;
      dados.opcoes = opcoesBrutas as Prisma.InputJsonObject;
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
    return this.paraDto(atualizada);
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
    const opcoes = lerOpcoes(atual.opcoes);
    if (opcoes.negocio) {
      await this.validarNegocio(usuario, atual.tipo, opcoes.negocio);
    }
    if (opcoes.filtro) {
      const planilha = await this.ler(atual);
      const passa = compilarFiltro(opcoes.filtro, planilha.colunas);
      if (!planilha.linhas.some((l) => passa(l.valores))) {
        throw new RegraVioladaException(
          'R16.11',
          'Nenhuma linha da planilha passa no filtro.',
        );
      }
    }
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
          comFiltro: lerOpcoes(atual.opcoes).filtro !== null,
          comNegocio: lerOpcoes(atual.opcoes).negocio !== null,
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
    return this.paraDto(atualizada);
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
    return this.paraDto(cancelada);
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

  /** Nomes de funis e etapas do cartão "Negócio para todos" (id → nome), numa consulta só por tabela. */
  private async paraDtos(
    importacoes: Array<Parameters<typeof ImportacaoDto.de>[0]>,
  ): Promise<ImportacaoDto[]> {
    const funis = new Set<string>();
    const etapas = new Set<string>();
    for (const i of importacoes) {
      const n = lerOpcoes(i.opcoes).negocio;
      if (n) {
        funis.add(n.funilId);
        etapas.add(n.etapaId);
      }
    }
    const nomes = new Map<string, string>();
    if (funis.size > 0) {
      const [f, e] = await Promise.all([
        this.prisma.funil.findMany({
          where: { id: { in: [...funis] } },
          select: { id: true, nome: true },
        }),
        this.prisma.etapa.findMany({
          where: { id: { in: [...etapas] } },
          select: { id: true, nome: true },
        }),
      ]);
      for (const x of [...f, ...e]) nomes.set(x.id, x.nome);
    }
    return importacoes.map((i) => ImportacaoDto.de(i, nomes));
  }

  private async paraDto(
    importacao: Parameters<typeof ImportacaoDto.de>[0],
  ): Promise<ImportacaoDto> {
    return (await this.paraDtos([importacao]))[0];
  }

  /** R16.11: coluna existente, operador com valor quando precisa, até 10 regras (400). */
  private validarFiltro(
    filtro: FiltroDaPlanilha,
    colunas: readonly string[],
  ): FiltroDaPlanilha {
    const problemas: Array<{ campo: string; mensagens: string[] }> = [];
    if (filtro.regras.length === 0) {
      problemas.push({
        campo: 'filtro.regras',
        mensagens: ['informe ao menos uma regra'],
      });
    }
    if (filtro.regras.length > MAXIMO_DE_REGRAS_DO_FILTRO) {
      problemas.push({
        campo: 'filtro.regras',
        mensagens: [`no máximo ${MAXIMO_DE_REGRAS_DO_FILTRO} regras`],
      });
    }
    filtro.regras.forEach((r, i) => {
      if (!colunas.includes(r.coluna)) {
        problemas.push({
          campo: `filtro.regras.${i}.coluna`,
          mensagens: [`a coluna "${r.coluna}" não existe no arquivo`],
        });
      }
      if (
        !OPERADORES_SEM_VALOR.includes(r.operador) &&
        (r.valor === undefined || r.valor === null || r.valor.trim() === '')
      ) {
        problemas.push({
          campo: `filtro.regras.${i}.valor`,
          mensagens: ['informe o valor da comparação'],
        });
      }
    });
    if (problemas.length > 0) {
      throw new DadosInvalidosException('O filtro tem problemas.', {
        regra: 'R16.11',
        campos: problemas,
      });
    }
    return {
      combinacao: filtro.combinacao,
      regras: filtro.regras.map((r) => ({
        coluna: r.coluna,
        operador: r.operador,
        valor: OPERADORES_SEM_VALOR.includes(r.operador)
          ? null
          : (r.valor ?? null),
      })),
    };
  }

  /**
   * R16.12: o cartão "Negócio para todos" só vale para contatos; o funil existe
   * e a pessoa o vê (senão 404, R5.9), está ativo (422) e ela cria nele (a regra
   * da criação manual, R5.12 — 403); a etapa é do funil e não é a de perda (422);
   * o valor é um número ≥ 0 (400).
   */
  private async validarNegocio(
    usuario: UsuarioAutenticado,
    tipo: Importacao['tipo'],
    negocio: NegocioParaTodos,
  ): Promise<NegocioParaTodos> {
    if (tipo !== 'CONTATOS') {
      throw new DadosInvalidosException(
        'Só a importação de contatos cria negócios.',
        {
          regra: 'R16.12',
          campos: [{ campo: 'negocio', mensagens: ['só vale para contatos'] }],
        },
      );
    }
    const funil = await this.funilEscolhido(usuario, negocio.funilId);
    const etapa = await this.prisma.etapa.findFirst({
      where: { id: negocio.etapaId, funilId: funil.id },
    });
    if (!etapa) {
      throw new RegraVioladaException(
        'R5.4',
        `A etapa informada não é do funil ${funil.nome}.`,
        { funilId: funil.id, etapaId: negocio.etapaId },
      );
    }
    if (etapa.tipo === 'PERDIDO') {
      throw new RegraVioladaException(
        'R5.5',
        'Um negócio importado não entra direto na etapa de perda (ela exige motivo).',
        { etapaId: etapa.id },
      );
    }
    let valor: string | null = null;
    if (
      negocio.valor !== undefined &&
      negocio.valor !== null &&
      negocio.valor.trim() !== ''
    ) {
      valor = valorEmReais(negocio.valor);
      if (valor === null) {
        throw new DadosInvalidosException('O valor do negócio é inválido.', {
          regra: 'R16.12',
          campos: [
            {
              campo: 'negocio.valor',
              mensagens: ['deve ser um número maior ou igual a zero'],
            },
          ],
        });
      }
    }
    return {
      funilId: funil.id,
      etapaId: etapa.id,
      titulo: negocio.titulo?.trim() || null,
      valor,
    };
  }

  /**
   * R16.14: tradução de funis (`{ valor: funilId }`): só contatos (400); texto e id (400);
   * o funil existe e está ativo (422, R5.1) e a pessoa pode criar negócios nele (403, R5.9).
   * Chaves guardadas normalizadas (sem acento, caixa nem espaços extras).
   */
  private async validarTraducaoDeFunis(
    usuario: UsuarioAutenticado,
    tipo: Importacao['tipo'],
    bruto: Record<string, unknown>,
  ): Promise<TraducaoDeFunis> {
    this.garantirTraducaoValida(
      tipo,
      'traducaoFunis',
      bruto,
      (v) => typeof v === 'string' && PADRAO_UUID.test(v),
    );
    const traducao = lerTraducaoDeFunis(bruto);
    for (const funilId of new Set(Object.values(traducao))) {
      await this.funilParaTraducao(usuario, funilId);
    }
    return traducao;
  }

  /**
   * R16.14: tradução de etapas (`{ funilId: { valor: etapaId } }`): a etapa é do funil
   * (422, R5.4) e não é de perda (422, R5.5); o funil segue as regras da tradução de funis.
   */
  private async validarTraducaoDeEtapas(
    usuario: UsuarioAutenticado,
    tipo: Importacao['tipo'],
    bruto: Record<string, unknown>,
  ): Promise<TraducaoDeEtapas> {
    this.garantirTraducaoValida(
      tipo,
      'traducaoEtapas',
      bruto,
      (v) =>
        !!v &&
        typeof v === 'object' &&
        !Array.isArray(v) &&
        Object.values(v).every(
          (e) => typeof e === 'string' && PADRAO_UUID.test(e),
        ),
      true,
    );
    const traducao = lerTraducaoDeEtapas(bruto);
    for (const [funilId, etapas] of Object.entries(traducao)) {
      const funil = await this.funilParaTraducao(usuario, funilId);
      for (const etapaId of new Set(Object.values(etapas))) {
        const etapa = await this.prisma.etapa.findFirst({
          where: { id: etapaId, funilId: funil.id },
        });
        if (!etapa) {
          throw new RegraVioladaException(
            'R5.4',
            `A etapa informada não é do funil ${funil.nome}.`,
            { funilId: funil.id, etapaId },
          );
        }
        if (etapa.tipo === 'PERDIDO') {
          throw new RegraVioladaException(
            'R5.5',
            'Uma etapa de perda não recebe negócio aberto da planilha (ela exige motivo).',
            { etapaId },
          );
        }
      }
    }
    return traducao;
  }

  private garantirTraducaoValida(
    tipo: Importacao['tipo'],
    campo: string,
    bruto: Record<string, unknown>,
    valorValido: (valor: unknown) => boolean,
    chaveEhUuid = false,
  ): void {
    const mensagens: string[] = [];
    if (tipo !== 'CONTATOS' && Object.keys(bruto).length > 0) {
      mensagens.push('só vale para contatos');
    }
    for (const [chave, valor] of Object.entries(bruto)) {
      if (chaveEhUuid ? !PADRAO_UUID.test(chave) : chave.trim() === '') {
        mensagens.push(
          chaveEhUuid
            ? `"${chave}" não é um id de funil`
            : 'o valor da planilha não pode ser vazio',
        );
      } else if (!valorValido(valor)) {
        mensagens.push(`"${chave}": destino inválido`);
      }
    }
    if (mensagens.length > 0) {
      throw new DadosInvalidosException('A tradução tem problemas.', {
        regra: 'R16.14',
        campos: [{ campo, mensagens }],
      });
    }
  }

  private funilParaTraducao(usuario: UsuarioAutenticado, funilId: string) {
    return this.funilEscolhido(usuario, funilId);
  }

  /**
   * O funil escolhido por id (cartão "Negócio para todos" ou tradução, R16.12,
   * R16.14): o que não existe e o que a pessoa não vê respondem igual — 404, sem
   * nome nem etapas (R5.9); arquivado → 422 (`R5.1`); visto mas sem criar
   * negócios → 403 (`R5.12`).
   */
  private async funilEscolhido(usuario: UsuarioAutenticado, funilId: string) {
    const funil = await this.prisma.funil.findFirst({
      where: { id: funilId, excluidoEm: null },
    });
    const acesso = await funisAcessiveis(this.prisma, usuario);
    if (!funil || !acesso.podeVerFunil(funil.id)) {
      throw new NaoEncontradoException('Funil não encontrado.', {
        campo: 'funilId',
        funilId,
      });
    }
    if (!funil.ativo) {
      throw new RegraVioladaException(
        'R5.1',
        `O funil ${funil.nome} está arquivado e não recebe negócios.`,
        { funilId: funil.id },
      );
    }
    if (!acesso.podeCriarNoFunil(funil.id)) {
      throw new SemPermissaoException(
        `Você não pode criar negócios no funil ${funil.nome}.`,
        { regra: 'R5.12', funilId: funil.id },
      );
    }
    return funil;
  }

  /**
   * R16.14: conferência de funis e etapas da planilha com o mapeamento, o filtro, o cartão e as
   * traduções salvos. Agrupa as linhas que passam no filtro por valor de funil (e, nas linhas
   * abertas, por valor de etapa) e diz onde cada uma cairia.
   */
  async funisDaPlanilha(
    usuario: UsuarioAutenticado,
    id: string,
  ): Promise<FunisDaPlanilhaDto> {
    const importacao = await this.obter(usuario, id);
    const vazio: FunisDaPlanilhaDto = { funis: [], semFunil: 0 };
    if (importacao.tipo !== 'CONTATOS') {
      return vazio;
    }
    const opcoes = lerOpcoes(importacao.opcoes);
    const mapeamento = importacao.mapeamento as Mapeamento;
    const indiceDe = (campo: string): number => {
      const coluna = Object.entries(mapeamento).find(([, c]) => c === campo);
      return coluna ? importacao.colunas.indexOf(coluna[0]) : -1;
    };
    const iFunil = indiceDe('negocio.funil');
    const iEtapa = indiceDe('negocio.etapa');
    const iStatus = indiceDe('negocio.status');
    const planilha = await this.ler(importacao);
    const passa = compilarFiltro(opcoes.filtro, planilha.colunas);
    const linhas = opcoes.filtro
      ? planilha.linhas.filter((l) => passa(l.valores))
      : planilha.linhas;

    const acesso = await funisAcessiveis(this.prisma, usuario);
    // R5.9: funil que a pessoa não vê é como se não existisse (NAO_ENCONTRADO).
    const funisDb = await this.prisma.funil.findMany({
      where: {
        excluidoEm: null,
        ...(acesso.todos ? {} : { id: { in: acesso.idsVisiveis() } }),
      },
      orderBy: [{ criadoEm: 'asc' }, { id: 'asc' }],
      include: {
        etapas: { orderBy: [{ ordem: 'asc' }, { criadoEm: 'asc' }] },
      },
    });
    const funis: FunilDoCache[] = funisDb.map((f) => ({
      id: f.id,
      nome: f.nome,
      ativo: f.ativo,
      area: f.area,
      visibilidade: f.visibilidade,
      etapas: f.etapas.map((e) => ({ id: e.id, nome: e.nome, tipo: e.tipo })),
    }));

    interface GrupoDeEtapa {
      valor: string;
      linhas: number;
    }
    interface GrupoDeFunil {
      valor: string;
      linhas: number;
      porStatus: Record<'ABERTO' | 'GANHO' | 'PERDIDO', number>;
      etapas: Map<string, GrupoDeEtapa>;
    }
    const grupos = new Map<string, GrupoDeFunil>();
    let semFunil = 0;
    for (const linha of linhas) {
      const valorFunil =
        iFunil >= 0 ? (linha.valores[iFunil] ?? '').trim() : '';
      if (valorFunil === '') {
        semFunil++;
        continue;
      }
      const chave = normalizarTextoDoFiltro(valorFunil);
      let grupo = grupos.get(chave);
      if (!grupo) {
        grupo = {
          valor: valorFunil,
          linhas: 0,
          porStatus: { ABERTO: 0, GANHO: 0, PERDIDO: 0 },
          etapas: new Map(),
        };
        grupos.set(chave, grupo);
      }
      grupo.linhas++;
      const { status } = lerStatusDoNegocio(
        iStatus >= 0 ? linha.valores[iStatus] : undefined,
      );
      grupo.porStatus[status]++;
      const valorEtapa =
        iEtapa >= 0 ? (linha.valores[iEtapa] ?? '').trim() : '';
      if (status === 'ABERTO' && valorEtapa !== '') {
        const chaveEtapa = normalizarTextoDoFiltro(valorEtapa);
        const etapa = grupo.etapas.get(chaveEtapa);
        if (etapa) {
          etapa.linhas++;
        } else {
          grupo.etapas.set(chaveEtapa, { valor: valorEtapa, linhas: 1 });
        }
      }
    }

    return {
      semFunil,
      funis: [...grupos.values()].map((g) => {
        const achado = acharFunil(funis, g.valor, opcoes.traducaoFunis, (f) =>
          acesso.podeCriarNoFunil(f.id),
        );
        return {
          valor: g.valor,
          linhas: g.linhas,
          porStatus: g.porStatus,
          funil: achado.funil
            ? {
                id: achado.funil.id,
                nome: achado.funil.nome,
                area: achado.funil.area,
              }
            : null,
          como: achado.como,
          problema: achado.problema,
          etapas: [...g.etapas.values()].map((e) => {
            if (!achado.funil) {
              return {
                valor: e.valor,
                linhas: e.linhas,
                etapa: null,
                como: null,
                problema: 'NAO_ENCONTRADA' as const,
              };
            }
            const a = acharEtapa(achado.funil, e.valor, opcoes.traducaoEtapas);
            return {
              valor: e.valor,
              linhas: e.linhas,
              etapa: a.etapa
                ? { id: a.etapa.id, nome: a.etapa.nome, tipo: a.etapa.tipo }
                : null,
              como: a.como,
              problema: a.problema,
            };
          }),
        };
      }),
    };
  }

  /** Negócio de um modelo salvo: some em silêncio se o funil ou a etapa não servem mais. */
  private async negocioAindaValido(
    usuario: UsuarioAutenticado,
    negocio: NegocioParaTodos,
  ): Promise<NegocioParaTodos | null> {
    try {
      return await this.validarNegocio(usuario, 'CONTATOS', negocio);
    } catch (erro) {
      if (erro instanceof ErroApi) {
        return null;
      }
      throw erro;
    }
  }

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
      throw new DadosInvalidosException('Escolha o setor do rodízio.', {
        campos: [
          { campo: 'areaRodizio', mensagens: ['é obrigatória com rodízio'] },
        ],
      });
    }
    if (estrategia === 'RODIZIO' && area) {
      // R1.9: o rodízio é de um setor ativo.
      await garantirSetorAtivo(this.prisma, area, 'areaRodizio');
    }
  }
}

// ---------------------------------------------------------------------------

export function rotuloDoTipo(tipo: Importacao['tipo']): string {
  if (tipo === 'PARCELAS') {
    return 'parcelas';
  }
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

/** Tira do filtro as regras de colunas que o arquivo não tem; sem regras, sem filtro. */
export function descartarRegrasSemColuna(
  filtro: FiltroDaPlanilha,
  colunas: readonly string[],
): FiltroDaPlanilha | null {
  const regras = filtro.regras.filter((r) => colunas.includes(r.coluna));
  return regras.length === 0 ? null : { ...filtro, regras };
}

function limparLeitura(
  leitura: AtualizarImportacaoDto['leitura'],
): OpcoesDeLeitura {
  const limpa: OpcoesDeLeitura = {};
  if (leitura?.separador) limpa.separador = leitura.separador;
  if (leitura?.codificacao) limpa.codificacao = leitura.codificacao;
  if (leitura?.aba) limpa.aba = leitura.aba;
  if (leitura?.linhaCabecalho) limpa.linhaCabecalho = leitura.linhaCabecalho;
  if (leitura?.semCabecalho) limpa.semCabecalho = true;
  return limpa;
}

function montarPrevia(
  tipo: Importacao['tipo'],
  planilha: PlanilhaLida,
  linhas: number,
  filtro: FiltroDaPlanilha | null = null,
): PreviaDto {
  const passa = compilarFiltro(filtro, planilha.colunas);
  const aprovadas = filtro
    ? planilha.linhas.filter((l) => passa(l.valores))
    : planilha.linhas;
  return {
    colunas: planilha.colunas,
    linhas: aprovadas
      .slice(0, linhas)
      .map((l) => ({ numero: l.numero, valores: l.valores })),
    totalLinhas: planilha.linhas.length,
    linhasNoFiltro: aprovadas.length,
    sugestao: sugerirMapeamento(tipo, planilha.colunas),
    formatoOrigem:
      tipo === 'CONTATOS' ? formatoDeOrigem(planilha.colunas) : null,
    ...(planilha.leitura.abas ? { abas: planilha.leitura.abas } : {}),
  };
}

export { camposDoTipo };
