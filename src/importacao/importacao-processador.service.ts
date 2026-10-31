import { Injectable, Logger } from '@nestjs/common';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import { executarComoAtor } from '../comum/contexto/contexto-requisicao';
import { normalizarCnpjOpcional } from '../comum/dominio/cnpj';
import { ehEmailValido, normalizarEmail } from '../comum/dominio/email';
import {
  juntarEtiquetas,
  normalizarEtiquetas,
} from '../comum/dominio/etiquetas';
import { areaDoPapel } from '../comum/dominio/papeis';
import { normalizarTelefone } from '../comum/dominio/telefone';
import { ErroApi } from '../comum/erros/excecoes';
import { AuditoriaService } from '../auditoria/auditoria.service';
import { ArquivosService } from '../arquivos/arquivos.service';
import { UFS } from '../contatos/contatos.constantes';
import { ContatosService } from '../contatos/contatos.service';
import type { AtualizarContatoDto } from '../contatos/dto/contato.dto';
import type {
  AtualizarEmpresaDto,
  CriarEmpresaDto,
} from '../contatos/dto/empresa.dto';
import { EmpresasService } from '../contatos/empresas.service';
import { EventosDominioService } from '../eventos/eventos-dominio.service';
import { DistribuicaoService } from '../funis/distribuicao.service';
import {
  type Contato,
  type Empresa,
  type Importacao,
  Prisma,
  type ResultadoLinhaImportacao,
} from '../generated/prisma/client';
import { PrismaService, type Tx } from '../prisma/prisma.service';
import { EVENTOS_DO_SERVIDOR } from '../tempo-real/catalogo';
import { TempoRealPublicador } from '../tempo-real/tempo-real.publicador';
import { TempoRealService } from '../tempo-real/tempo-real.service';
import { ImportacaoDeParcelasService } from '../financeiro/importacao-de-parcelas.service';
import { PREFIXO_CAMPO_PERSONALIZADO } from './campos';
import { FILA_IMPORTACAO } from './importacao.constantes';
import {
  lerPlanilha,
  PlanilhaIlegivelError,
  type LinhaLida,
  type OpcoesDeLeitura,
} from './leitor-planilha';
import { gerarRelatorio } from './relatorio';

/** Linhas por lote: depois de cada um, os contadores são gravados e o progresso é emitido. */
export const LINHAS_POR_LOTE = 100;

interface ResultadoDaLinha {
  resultado: ResultadoLinhaImportacao;
  entidadeId?: string | null;
  motivo?: string | null;
  /** Já gravada na mesma transação da alteração. */
  gravada?: boolean;
}

type Valores = Record<string, string>;

/**
 * Processa uma importação na fila (R16.4–R16.8): lê a planilha, trata linha a
 * linha pelos serviços de contatos e empresas (as mesmas regras da criação
 * manual: R4.1 normalização, R4.2 deduplicação), grava o resultado de cada
 * linha e o progresso por lote, e no fim gera o relatório XLSX. Roda como o
 * usuário que iniciou a importação. Pode ser retomada: continua depois da
 * última linha gravada.
 */
@Injectable()
export class ImportacaoProcessadorService {
  private readonly logger = new Logger('Importacao');

  constructor(
    private readonly prisma: PrismaService,
    private readonly arquivos: ArquivosService,
    private readonly contatos: ContatosService,
    private readonly empresas: EmpresasService,
    private readonly distribuicao: DistribuicaoService,
    private readonly auditoria: AuditoriaService,
    private readonly eventos: EventosDominioService,
    private readonly publicador: TempoRealPublicador,
    private readonly tempoReal: TempoRealService,
    private readonly parcelas: ImportacaoDeParcelasService,
  ) {}

  /** Manipulador da fila `importacao.processar`. */
  async processar(importacaoId: string): Promise<void> {
    const importacao = await this.prisma.importacao.findUnique({
      where: { id: importacaoId },
      include: { criadoPor: true },
    });
    if (
      !importacao ||
      (importacao.status !== 'NA_FILA' && importacao.status !== 'PROCESSANDO')
    ) {
      return;
    }
    const criador = importacao.criadoPor;
    if (!criador?.ativo) {
      await this.falhar(
        importacao,
        'A pessoa que iniciou a importação não está mais ativa.',
      );
      return;
    }
    const usuario: UsuarioAutenticado = {
      id: criador.id,
      nome: criador.nome,
      email: criador.email,
      papel: criador.papel,
      area: areaDoPapel(criador.papel),
      liderId: criador.liderId,
      deveTrocarSenha: false,
      sessaoId: '',
    };
    await executarComoAtor(
      {
        tipoAtor: 'USUARIO',
        descricao: criador.nome,
        usuario: { id: criador.id, papel: criador.papel, nome: criador.nome },
      },
      () => this.executar(importacao, usuario),
    );
  }

  private async executar(
    importacao: Importacao,
    usuario: UsuarioAutenticado,
  ): Promise<void> {
    const iniciada = await this.prisma.importacao.updateMany({
      where: { id: importacao.id, status: { in: ['NA_FILA', 'PROCESSANDO'] } },
      data: {
        status: 'PROCESSANDO',
        iniciadaEm: importacao.iniciadaEm ?? new Date(),
        erro: null,
      },
    });
    if (iniciada.count === 0) {
      return;
    }
    await this.emitirProgresso(importacao.id);

    let planilha;
    try {
      const { conteudo } = await this.arquivos.lerConteudo(
        importacao.arquivoId,
      );
      planilha = await lerPlanilha(
        conteudo,
        importacao.formato as 'csv' | 'xlsx',
        importacao.leitura as OpcoesDeLeitura,
      );
    } catch (erro) {
      if (erro instanceof PlanilhaIlegivelError) {
        await this.falhar(importacao, erro.message);
        return;
      }
      throw erro;
    }
    if (planilha.colunas.join('\u0000') !== importacao.colunas.join('\u0000')) {
      await this.falhar(
        importacao,
        'As colunas do arquivo mudaram desde a prévia. Envie o arquivo de novo.',
      );
      return;
    }

    const ultima =
      (
        await this.prisma.importacaoLinha.aggregate({
          where: { importacaoId: importacao.id },
          _max: { numero: true },
        })
      )._max.numero ?? 0;
    const pendentes = planilha.linhas.filter((l) => l.numero > ultima);

    for (let i = 0; i < pendentes.length; i += LINHAS_POR_LOTE) {
      for (const linha of pendentes.slice(i, i + LINHAS_POR_LOTE)) {
        await this.tratarLinha(importacao, usuario, planilha.colunas, linha);
      }
      await this.gravarContadores(importacao.id);
      await this.emitirProgresso(importacao.id);
      const atual = await this.prisma.importacao.findUnique({
        where: { id: importacao.id },
        select: { status: true },
      });
      if (atual?.status !== 'PROCESSANDO') {
        // Cancelada no meio: para aqui (o cancelamento já foi auditado).
        return;
      }
    }
    await this.gravarContadores(importacao.id);
    await this.concluir(importacao.id);
  }

  // =========================================================================
  // Linha a linha
  // =========================================================================

  private async tratarLinha(
    importacao: Importacao,
    usuario: UsuarioAutenticado,
    colunas: readonly string[],
    linha: LinhaLida,
  ): Promise<void> {
    const original: Valores = {};
    colunas.forEach((coluna, i) => {
      original[coluna] = linha.valores[i] ?? '';
    });
    const valores = this.valoresMapeados(
      importacao.mapeamento as Record<string, string>,
      original,
    );
    let resultado: ResultadoDaLinha;
    try {
      resultado =
        Object.keys(valores).length === 0
          ? {
              resultado: 'IGNORADO',
              motivo: 'Linha sem valores nas colunas ligadas.',
            }
          : importacao.tipo === 'PARCELAS'
            ? await this.parcelas.tratarLinha(importacao, usuario, valores)
            : importacao.tipo === 'CONTATOS'
              ? await this.tratarContato(
                  importacao,
                  usuario,
                  linha.numero,
                  original,
                  valores,
                )
              : await this.tratarEmpresa(importacao, usuario, valores);
    } catch (erro) {
      if (!ehErroDeDados(erro)) {
        throw erro;
      }
      resultado = { resultado: 'ERRO', motivo: motivoDoErro(erro) };
    }
    if (!resultado.gravada) {
      await this.gravarLinha(
        this.prisma,
        importacao,
        linha.numero,
        resultado,
        original,
      );
    }
  }

  private gravarLinha(
    tx: Tx,
    importacao: Importacao,
    numero: number,
    r: ResultadoDaLinha,
    original: Valores,
  ): Promise<unknown> {
    const dados =
      r.resultado === 'ERRO' || r.resultado === 'IGNORADO'
        ? (original as Prisma.InputJsonObject)
        : Prisma.DbNull;
    return tx.importacaoLinha.upsert({
      where: { importacaoId_numero: { importacaoId: importacao.id, numero } },
      create: {
        importacaoId: importacao.id,
        numero,
        resultado: r.resultado,
        entidadeId: r.entidadeId ?? null,
        motivo: r.motivo ?? null,
        dados,
      },
      update: {
        resultado: r.resultado,
        entidadeId: r.entidadeId ?? null,
        motivo: r.motivo ?? null,
        dados,
      },
    });
  }

  /** `{ campo: valor }` só com os campos ligados e preenchidos. */
  private valoresMapeados(
    mapeamento: Record<string, string>,
    original: Valores,
  ): Valores {
    const valores: Valores = {};
    for (const [coluna, campo] of Object.entries(mapeamento)) {
      const valor = (original[coluna] ?? '').trim();
      if (valor !== '') {
        valores[campo] = valor;
      }
    }
    return valores;
  }

  // ----- contatos ---------------------------------------------------------

  private async tratarContato(
    importacao: Importacao,
    usuario: UsuarioAutenticado,
    numero: number,
    original: Valores,
    v: Valores,
  ): Promise<ResultadoDaLinha> {
    if (!v.nome) {
      return { resultado: 'ERRO', motivo: 'Nome é obrigatório.' };
    }
    const notas: string[] = [];
    let email: string | undefined;
    let telefone: string | undefined;
    if (v.email) {
      if (ehEmailValido(v.email)) {
        email = normalizarEmail(v.email);
      } else {
        notas.push(`E-mail inválido ("${v.email}")`);
      }
    }
    if (v.telefone) {
      const lido = normalizarTelefone(v.telefone);
      if (lido.valido) {
        telefone = lido.telefone;
      } else {
        notas.push(`Telefone inválido ("${v.telefone}"): ${lido.motivo}`);
      }
    }
    if (!email && !telefone) {
      return {
        resultado: 'ERRO',
        motivo:
          notas.length > 0
            ? `${notas.join('; ')}.`
            : 'Informe e-mail ou telefone.',
      };
    }
    const etiquetas = juntarEtiquetas(
      importacao.etiquetas,
      dividirEtiquetas(v.etiquetas),
    );
    const camposPersonalizados = camposDe(v);
    const utm = utmDe(v);
    const detalhe = importacao.origemDetalhe ?? importacao.nome;
    const existente = await this.contatoExistente(email, telefone);
    const sufixo = notas.length > 0 ? ` (${notas.join('; ')})` : '';

    if (existente) {
      if (importacao.duplicados === 'IGNORAR') {
        return {
          resultado: 'IGNORADO',
          entidadeId: existente.id,
          motivo: 'Contato já cadastrado.',
        };
      }
      if (importacao.duplicados === 'SOBRESCREVER') {
        const alterou = await this.sobrescreverContato(usuario, existente, {
          nome: v.nome,
          email,
          telefone,
          cargo: v.cargo,
          empresaNome: v.empresa,
          etiquetas,
          camposPersonalizados,
        });
        return alterou
          ? {
              resultado: 'ATUALIZADO',
              entidadeId: existente.id,
              motivo: sufixo.trim() || null,
            }
          : {
              resultado: 'IGNORADO',
              entidadeId: existente.id,
              motivo: 'Contato já cadastrado, sem diferenças.',
            };
      }
    }

    const retorno = await this.prisma.$transaction(async (tx) => {
      const responsavelId = existente
        ? undefined
        : await this.responsavelDaLinha(tx, importacao);
      const { contato, criado } = await this.contatos.encontrarOuCriar(tx, {
        nome: v.nome,
        email,
        telefone,
        empresaNome: v.empresa,
        cargo: v.cargo,
        origem: 'IMPORTACAO',
        origemDetalhe: detalhe,
        utm,
        etiquetas,
        camposPersonalizados,
        responsavelId,
      });
      const r: ResultadoDaLinha = {
        resultado: criado ? 'CRIADO' : 'ATUALIZADO',
        entidadeId: contato.id,
        motivo: notas.length > 0 ? `${notas.join('; ')}.` : null,
        gravada: true,
      };
      await this.gravarLinha(tx, importacao, numero, r, original);
      return r;
    });
    return retorno;
  }

  private async contatoExistente(
    email: string | undefined,
    telefone: string | undefined,
  ): Promise<Contato | null> {
    if (email) {
      const porEmail = await this.prisma.contato.findFirst({
        where: { email, excluidoEm: null },
      });
      if (porEmail) {
        return porEmail;
      }
    }
    if (telefone) {
      return this.prisma.contato.findFirst({
        where: { telefone, excluidoEm: null },
      });
    }
    return null;
  }

  /** SOBRESCREVER (R16.5): os valores da planilha trocam os do contato; vazios não apagam. */
  private async sobrescreverContato(
    usuario: UsuarioAutenticado,
    existente: Contato,
    novo: {
      nome: string;
      email?: string;
      telefone?: string;
      cargo?: string;
      empresaNome?: string;
      etiquetas: string[];
      camposPersonalizados: Record<string, string>;
    },
  ): Promise<boolean> {
    const dto: Record<string, unknown> = { nome: novo.nome };
    if (novo.email && novo.email !== existente.email) {
      dto.email = novo.email;
    }
    if (novo.telefone && novo.telefone !== existente.telefone) {
      dto.telefone = novo.telefone;
    }
    if (novo.cargo) {
      dto.cargo = novo.cargo;
    }
    if (novo.empresaNome) {
      const empresa = await this.prisma.$transaction((tx) =>
        this.empresas.encontrarOuCriarPorNome(tx, novo.empresaNome!, {
          responsavelId: existente.responsavelId,
        }),
      );
      dto.empresaId = empresa.empresa.id;
    }
    if (novo.etiquetas.length > 0) {
      dto.etiquetas = juntarEtiquetas(existente.etiquetas, novo.etiquetas);
    }
    if (Object.keys(novo.camposPersonalizados).length > 0) {
      dto.camposPersonalizados = novo.camposPersonalizados;
    }
    await this.contatos.atualizar(
      usuario,
      existente.id,
      dto as AtualizarContatoDto,
    );
    const depois = await this.prisma.contato.findUniqueOrThrow({
      where: { id: existente.id },
      select: { atualizadoEm: true },
    });
    return depois.atualizadoEm.getTime() !== existente.atualizadoEm.getTime();
  }

  private async responsavelDaLinha(
    tx: Tx,
    importacao: Importacao,
  ): Promise<string | undefined> {
    if (
      importacao.estrategiaResponsavel === 'RESPONSAVEL_FIXO' &&
      importacao.responsavelId
    ) {
      return importacao.responsavelId;
    }
    if (
      importacao.estrategiaResponsavel === 'RODIZIO' &&
      importacao.areaRodizio
    ) {
      return (
        (await this.distribuicao.escolherResponsavel(
          tx,
          importacao.areaRodizio,
          'RODIZIO',
        )) ?? undefined
      );
    }
    // R4.5: sem estratégia, o responsável é quem importou (o contexto resolve).
    return undefined;
  }

  // ----- empresas ---------------------------------------------------------

  private async tratarEmpresa(
    importacao: Importacao,
    usuario: UsuarioAutenticado,
    v: Valores,
  ): Promise<ResultadoDaLinha> {
    if (!v.nome) {
      return { resultado: 'ERRO', motivo: 'Nome é obrigatório.' };
    }
    const cnpj = normalizarCnpjOpcional(v.cnpj);
    const uf = v.uf ? v.uf.toUpperCase() : undefined;
    if (uf && !(UFS as readonly string[]).includes(uf)) {
      return { resultado: 'ERRO', motivo: `UF inválida ("${v.uf}").` };
    }
    const etiquetas = juntarEtiquetas(
      importacao.etiquetas,
      dividirEtiquetas(v.etiquetas),
    );
    const camposPersonalizados = camposDe(v);
    const campos = {
      nome: v.nome,
      cnpj: cnpj ?? undefined,
      site: v.site,
      email: v.email,
      telefone: v.telefone,
      segmento: v.segmento,
      cidade: v.cidade,
      uf,
    };
    const existente = await this.empresaExistente(v.nome, cnpj);
    if (!existente) {
      const responsavelId = await this.responsavelDaEmpresa(importacao);
      const criada = await this.empresas.criar(usuario, {
        ...campos,
        etiquetas,
        camposPersonalizados,
        responsavelId,
      } as CriarEmpresaDto);
      return { resultado: 'CRIADO', entidadeId: criada.id };
    }
    if (importacao.duplicados === 'IGNORAR') {
      return {
        resultado: 'IGNORADO',
        entidadeId: existente.id,
        motivo: 'Empresa já cadastrada.',
      };
    }
    const sobrescrever = importacao.duplicados === 'SOBRESCREVER';
    const atuais = existente as unknown as Record<string, unknown>;
    const dto: Record<string, unknown> = {};
    for (const [campo, valor] of Object.entries(campos)) {
      if (valor === undefined || campo === 'nome') {
        continue;
      }
      const atual = atuais[campo];
      const vazio = atual === null || atual === undefined || atual === '';
      if ((sobrescrever || vazio) && valor !== atual) {
        dto[campo] = valor;
      }
    }
    if (sobrescrever && campos.nome !== existente.nome) {
      dto.nome = campos.nome;
    }
    const todasEtiquetas = juntarEtiquetas(existente.etiquetas, etiquetas);
    if (
      todasEtiquetas.length !== normalizarEtiquetas(existente.etiquetas).length
    ) {
      dto.etiquetas = todasEtiquetas;
    }
    const existentesCampos = (existente.camposPersonalizados ?? {}) as Record<
      string,
      unknown
    >;
    const novosCampos = Object.fromEntries(
      Object.entries(camposPersonalizados).filter(
        ([chave, valor]) =>
          existentesCampos[chave] !== valor &&
          (sobrescrever || existentesCampos[chave] == null),
      ),
    );
    if (Object.keys(novosCampos).length > 0) {
      dto.camposPersonalizados = novosCampos;
    }
    if (Object.keys(dto).length === 0) {
      return {
        resultado: 'IGNORADO',
        entidadeId: existente.id,
        motivo: 'Empresa já cadastrada, nada a atualizar.',
      };
    }
    await this.empresas.atualizar(
      usuario,
      existente.id,
      dto as AtualizarEmpresaDto,
    );
    return { resultado: 'ATUALIZADO', entidadeId: existente.id };
  }

  private async empresaExistente(
    nome: string,
    cnpj: string | null,
  ): Promise<Empresa | null> {
    if (cnpj) {
      const porCnpj = await this.prisma.empresa.findFirst({
        where: { cnpj, excluidoEm: null },
      });
      if (porCnpj) {
        return porCnpj;
      }
    }
    const [achada] = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM empresas
       WHERE excluido_em IS NULL
         AND lower(regexp_replace(btrim(nome), '\\s+', ' ', 'g')) = lower(regexp_replace(btrim(${nome}), '\\s+', ' ', 'g'))
         AND (${cnpj}::text IS NULL OR cnpj IS NULL)
       ORDER BY criado_em, id
       LIMIT 1`;
    return achada
      ? this.prisma.empresa.findUniqueOrThrow({ where: { id: achada.id } })
      : null;
  }

  private async responsavelDaEmpresa(
    importacao: Importacao,
  ): Promise<string | undefined> {
    if (
      importacao.estrategiaResponsavel === 'RESPONSAVEL_FIXO' &&
      importacao.responsavelId
    ) {
      return importacao.responsavelId;
    }
    if (
      importacao.estrategiaResponsavel === 'RODIZIO' &&
      importacao.areaRodizio
    ) {
      const area = importacao.areaRodizio;
      return (
        (await this.prisma.$transaction((tx) =>
          this.distribuicao.escolherResponsavel(tx, area, 'RODIZIO'),
        )) ?? undefined
      );
    }
    return undefined;
  }

  // =========================================================================
  // Contadores, progresso, fim
  // =========================================================================

  /** Recalcula os contadores a partir das linhas gravadas (certo mesmo depois de retomar). */
  private async gravarContadores(importacaoId: string): Promise<void> {
    const grupos = await this.prisma.importacaoLinha.groupBy({
      by: ['resultado'],
      where: { importacaoId },
      _count: { _all: true },
    });
    const n = (r: ResultadoLinhaImportacao) =>
      grupos.find((g) => g.resultado === r)?._count._all ?? 0;
    await this.prisma.importacao.update({
      where: { id: importacaoId },
      data: {
        criados: n('CRIADO'),
        atualizados: n('ATUALIZADO'),
        ignorados: n('IGNORADO'),
        erros: n('ERRO'),
        processadas: grupos.reduce((soma, g) => soma + g._count._all, 0),
      },
    });
  }

  /** Emite `importacao.progresso` agora (efêmero) para quem importou. */
  async emitirProgresso(importacaoId: string): Promise<void> {
    const i = await this.prisma.importacao.findUnique({
      where: { id: importacaoId },
    });
    if (!i?.criadoPorId) {
      return;
    }
    this.tempoReal.emitirParaUsuario(
      i.criadoPorId,
      EVENTOS_DO_SERVIDOR.IMPORTACAO_PROGRESSO,
      cargaDeProgresso(i),
    );
  }

  private async concluir(importacaoId: string): Promise<void> {
    const importacao = await this.prisma.importacao.findUniqueOrThrow({
      where: { id: importacaoId },
    });
    if (importacao.status !== 'PROCESSANDO') {
      return;
    }
    const concluidaEm = new Date();
    const problemas = await this.prisma.importacaoLinha.findMany({
      where: { importacaoId, resultado: { in: ['ERRO', 'IGNORADO'] } },
      orderBy: { numero: 'asc' },
    });
    const relatorio = await gerarRelatorio(
      { ...importacao, concluidaEm, status: 'CONCLUIDA' },
      problemas.map((p) => ({
        numero: p.numero,
        resultado: p.resultado,
        motivo: p.motivo,
        dados: (p.dados ?? null) as Record<string, unknown> | null,
      })),
    );
    await this.prisma.$transaction(async (tx) => {
      const travada = await tx.importacao.updateMany({
        where: { id: importacaoId, status: 'PROCESSANDO' },
        data: { concluidaEm },
      });
      if (travada.count === 0) {
        return;
      }
      const arquivo = await this.arquivos.salvar(
        relatorio,
        {
          nome: `relatorio-${importacao.nome.replace(/\.[^.]+$/, '')}.xlsx`,
          mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          contexto: 'RELATORIO',
          criadoPorId: importacao.criadoPorId,
        },
        { tx },
      );
      const final = await tx.importacao.update({
        where: { id: importacaoId },
        data: { status: 'CONCLUIDA', relatorioId: arquivo.id },
      });
      const contagens = {
        criados: final.criados,
        atualizados: final.atualizados,
        ignorados: final.ignorados,
        erros: final.erros,
      };
      await this.auditoria.registrar(tx, {
        acao: 'importacao.concluida',
        entidade: 'importacao',
        entidadeId: final.id,
        resumo: `Importação de ${final.tipo === 'CONTATOS' ? 'contatos' : final.tipo === 'PARCELAS' ? 'parcelas' : 'empresas'} "${final.nome}" concluída: ${final.criados} criados, ${final.atualizados} atualizados, ${final.ignorados} ignorados, ${final.erros} com erro`,
        dados: {
          tipo: final.tipo,
          totalLinhas: final.totalLinhas,
          duplicados: final.duplicados,
          regra: 'R16.8',
          ...contagens,
        },
      });
      await this.eventos.publicar(tx, 'importacao.concluida', {
        importacaoId: final.id,
        tipo: final.tipo,
        ...contagens,
      });
      if (final.criadoPorId) {
        await this.publicador.emitirAposCommit(tx, {
          salas: `usuario:${final.criadoPorId}`,
          evento: EVENTOS_DO_SERVIDOR.IMPORTACAO_PROGRESSO,
          dados: cargaDeProgresso(final),
        });
      }
    });
  }

  /** A importação inteira falhou (arquivo ilegível…): status FALHOU, sem tentar de novo. */
  async falhar(importacao: Importacao, motivo: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const atual = await tx.importacao.updateMany({
        where: {
          id: importacao.id,
          status: { in: ['NA_FILA', 'PROCESSANDO'] },
        },
        data: { status: 'FALHOU', erro: motivo },
      });
      if (atual.count === 0) {
        return;
      }
      await this.auditoria.registrar(tx, {
        acao: 'importacao.falhou',
        entidade: 'importacao',
        entidadeId: importacao.id,
        resumo: `Importação "${importacao.nome}" falhou: ${motivo}`,
        dados: { motivo, regra: 'R16.8' },
      });
    });
    this.logger.warn(`Importação ${importacao.id} falhou: ${motivo}`);
    await this.emitirProgresso(importacao.id);
  }
}

export { FILA_IMPORTACAO };

export function cargaDeProgresso(i: Importacao) {
  return {
    importacaoId: i.id,
    status: i.status,
    totalLinhas: i.totalLinhas,
    processadas: i.processadas,
    criados: i.criados,
    atualizados: i.atualizados,
    ignorados: i.ignorados,
    erros: i.erros,
    relatorioId: i.relatorioId,
  };
}

// ---------------------------------------------------------------------------
// Funções puras
// ---------------------------------------------------------------------------

/** Etiquetas de uma célula: separadas por vírgula, ponto e vírgula ou barra vertical. */
export function dividirEtiquetas(texto: string | undefined): string[] {
  return texto
    ? texto
        .split(/[,;|]/)
        .map((e) => e.trim())
        .filter(Boolean)
    : [];
}

/** Campos `campos.<chave>` do registro. */
export function camposDe(v: Valores): Record<string, string> {
  const campos: Record<string, string> = {};
  for (const [campo, valor] of Object.entries(v)) {
    if (campo.startsWith(PREFIXO_CAMPO_PERSONALIZADO)) {
      campos[campo.slice(PREFIXO_CAMPO_PERSONALIZADO.length)] = valor;
    }
  }
  return campos;
}

function utmDe(v: Valores): Record<string, string> | undefined {
  const utm: Record<string, string> = {};
  for (const [campo, valor] of Object.entries(v)) {
    if (campo.startsWith('utm.')) {
      utm[campo.slice(4)] = valor;
    }
  }
  return Object.keys(utm).length > 0 ? utm : undefined;
}

/** Erro por causa dos dados da linha (a linha vira ERRO); outros erros param o lote para tentar de novo. */
export function ehErroDeDados(erro: unknown): boolean {
  return (
    erro instanceof ErroApi ||
    erro instanceof TypeError ||
    (erro instanceof Prisma.PrismaClientKnownRequestError &&
      erro.code === 'P2002')
  );
}

/** Mensagem em português para o relatório. */
export function motivoDoErro(erro: unknown): string {
  if (erro instanceof ErroApi) {
    const campos = erro.detalhes?.campos as
      Array<{ campo: string; mensagens: string[] }> | undefined;
    const detalhe = campos?.length
      ? ` (${campos.map((c) => `${c.campo}: ${c.mensagens.join(', ')}`).join('; ')})`
      : '';
    return `${erro.mensagem}${detalhe}`;
  }
  if (erro instanceof Prisma.PrismaClientKnownRequestError) {
    return 'Valor duplicado: já existe outro registro com este e-mail, telefone ou CNPJ.';
  }
  return erro instanceof Error ? erro.message : 'Erro ao tratar a linha.';
}
