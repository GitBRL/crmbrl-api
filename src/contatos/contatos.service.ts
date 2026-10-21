import { Injectable } from '@nestjs/common';
import { AuditoriaService } from '../auditoria/auditoria.service';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import { contextoAtual } from '../comum/contexto/contexto-requisicao';
import { calcularAlteracoes } from '../comum/dados/sanitizar';
import { normalizarEmailOpcional } from '../comum/dominio/email';
import { normalizarEtiquetas } from '../comum/dominio/etiquetas';
import { permissoesDoPapel } from '../comum/dominio/permissoes';
import { normalizarTelefoneOpcional } from '../comum/dominio/telefone';
import {
  ConflitoException,
  DadosInvalidosException,
  NaoEncontradoException,
  SemPermissaoException,
} from '../comum/erros/excecoes';
import {
  montarPagina,
  type Pagina,
  paraSkipTake,
} from '../comum/paginacao/paginacao';
import { EventosDominioService } from '../eventos/eventos-dominio.service';
import { type Contato, Prisma } from '../generated/prisma/client';
import { NotificacoesService } from '../notificacoes/notificacoes.service';
import { PrismaService, type Tx } from '../prisma/prisma.service';
import { travarChave } from '../prisma/travas';
import {
  anonimizarTexto,
  CAMPOS_ANONIMIZADOS,
  dadosDaAnonimizacao,
  termosPessoais,
} from './anonimizacao';
import { filtroDeBuscaDeContatos } from './busca';
import {
  NOTIFICACAO_CONTATO_ATRIBUIDO,
  TAMANHO_MAXIMO_NOME,
  TRAVA_EMAIL_DO_CONTATO,
  TRAVA_TELEFONE_DO_CONTATO,
} from './contatos.constantes';
import {
  aplicarPatchDosCampos,
  type ContatoNormalizado,
  type EntradaEncontrarOuCriar,
  jsonOuNulo,
  normalizarEntradaDeContato,
  normalizarTextoCurto,
  planejarReconversao,
} from './deduplicacao';
import type {
  ConsentimentoEntradaDto,
  EtiquetaEmUsoDto,
  FiltroEtiquetasDto,
} from './dto/comum.dto';
import {
  type AnonimizarContatoDto,
  type AtualizarContatoDto,
  ContatoDto,
  type CriarContatoDto,
  type FiltroContatosDto,
  type OrdenacaoDeContatos,
  type ResultadoCriacaoContatoDto,
} from './dto/contato.dto';
import type {
  FiltroDaLinhaDoTempoDto,
  RegistroDaLinhaDoTempoDto,
} from './dto/linha-do-tempo.dto';
import { EmpresasService } from './empresas.service';
import { grafiasDaEtiqueta, listarEtiquetasEmUso } from './etiquetas-em-uso';
import {
  CAMPOS_AUDITADOS_DO_CONTATO,
  descreverOrigem,
  instantaneoDoContato,
} from './instantaneos';
import { LinhaDoTempoService } from './linha-do-tempo.service';
import {
  type AlcanceDeEdicao,
  PermissoesContatosService,
} from './permissoes-contatos.service';
import { INCLUIR_NO_CONTATO } from './relacoes';
import { descreverAlteracoes } from './rotulos';

/** Resultado da deduplicação (contrato §5). */
export interface ResultadoEncontrarOuCriar {
  contato: Contato;
  /** `false`: o contato já existia e foi reconvertido (R4.2). */
  criado: boolean;
}

/** Folga para relógios dessincronizados ao recusar datas de consentimento "no futuro". */
const TOLERANCIA_DE_RELOGIO_MS = 5 * 60_000;

const ORDENACAO: Readonly<
  Record<
    OrdenacaoDeContatos,
    (ordem: Prisma.SortOrder) => Prisma.ContatoOrderByWithRelationInput
  >
> = {
  criadoEm: (ordem) => ({ criadoEm: ordem }),
  atualizadoEm: (ordem) => ({ atualizadoEm: ordem }),
  nome: (ordem) => ({ nome: ordem }),
  ultimaOrigemEm: (ordem) => ({ ultimaOrigemEm: ordem }),
};

/**
 * Contatos (R4): cadastro com deduplicação, origens, responsável, LGPD,
 * etiquetas e campos personalizados; linha do tempo (R3.5).
 *
 * Toda alteração acontece numa transação com a auditoria (R3.1), os eventos
 * de domínio (R10.1) e as notificações (R10.2). Ver contatos, todos veem;
 * editar segue a matriz §12; anonimizar, só o Admin (R4.6).
 */
@Injectable()
export class ContatosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditoria: AuditoriaService,
    private readonly eventos: EventosDominioService,
    private readonly notificacoes: NotificacoesService,
    private readonly empresas: EmpresasService,
    private readonly permissoes: PermissoesContatosService,
    private readonly linhaDoTempoService: LinhaDoTempoService,
  ) {}

  // ===========================================================================
  // Deduplicação — interface com webhooks, importação e passagens (contrato §5)
  // ===========================================================================

  /**
   * Deduplicação (R4.2), na transação de quem chama: procura um contato ativo
   * com o mesmo e-mail ou o mesmo telefone normalizado (o e-mail primeiro).
   *
   * - Achou: **reconverte** — completa os campos vazios sem sobrescrever os
   *   preenchidos, junta etiquetas e campos personalizados, troca a última
   *   origem (R4.3), soma uma conversão, audita `contato.reconvertido` e
   *   publica `contato.reconvertido` e `contato.atualizado`.
   * - Não achou: cria, com primeira e última origem iguais, audita e publica
   *   `contato.criado`. `empresaNome` vincula a empresa com o mesmo nome ou
   *   cria uma. Responsável: `responsavelId` (usuário ativo, R4.5) ou o
   *   usuário logado; numa automação sem responsável, fica sem —
   *   `definirResponsavelSeVazio` resolve depois que o negócio tiver um.
   *
   * Concorrência: trava as chaves do e-mail e do telefone antes de procurar;
   * duas chamadas com o mesmo valor se enfileiram e a segunda reconverte. O
   * índice único parcial do banco é a última barreira.
   *
   * Entrada de automação é tolerante: e-mail ou telefone inválido é
   * descartado (e registrado na auditoria) se o outro meio de contato for
   * válido. Sem nome ou sem nenhum meio válido, lança 400 com
   * `detalhes.regra = 'R4.1'`.
   *
   * ```ts
   * const { contato, criado } = await this.contatos.encontrarOuCriar(tx, {
   *   nome: 'Maria Souza', email: 'maria@x.com', origem: 'WEBHOOK',
   *   origemDetalhe: webhook.nome, utm: { source: 'google' },
   * });
   * ```
   */
  async encontrarOuCriar(
    tx: Tx,
    entrada: EntradaEncontrarOuCriar,
  ): Promise<{ contato: Contato; criado: boolean }> {
    const dados = normalizarEntradaDeContato(entrada, { tolerante: true });
    return this.deduplicar(tx, dados);
  }

  /**
   * R4.5: o contato sem responsável (e a empresa dele, se também não tiver)
   * passa a ser de `responsavelId` — ex.: o responsável do negócio que o
   * originou, escolhido pelo rodízio depois da deduplicação. Não mexe em quem
   * já tem responsável. Na transação de quem chama.
   */
  async definirResponsavelSeVazio(
    tx: Tx,
    contatoId: string,
    responsavelId: string,
  ): Promise<Contato> {
    const contato = await this.travarContatoAtivo(tx, contatoId);
    if (contato.responsavelId) {
      return contato;
    }
    await this.permissoes.garantirResponsavelAtivo(tx, responsavelId);
    const atualizado = await tx.contato.update({
      where: { id: contatoId },
      data: { responsavelId },
    });
    const alteracoes = calcularAlteracoes(contato, atualizado, [
      'responsavelId',
    ]);
    await this.auditoria.registrar(tx, {
      acao: 'contato.atualizado',
      entidade: 'contato',
      entidadeId: atualizado.id,
      resumo: `Contato "${atualizado.nome}" ganhou responsável (R4.5)`,
      dados: { alteracoes },
      relacionados: { empresa: atualizado.empresaId },
    });
    await this.eventos.publicar(tx, 'contato.atualizado', {
      ...instantaneoDoContato(atualizado),
      camposAlterados: ['responsavelId'],
      motivo: 'responsavel_padrao',
    });
    if (atualizado.empresaId) {
      await this.empresas.definirResponsavelSeVazio(
        tx,
        atualizado.empresaId,
        responsavelId,
      );
    }
    return atualizado;
  }

  // ===========================================================================
  // HTTP
  // ===========================================================================

  async listar(
    usuario: UsuarioAutenticado,
    filtro: FiltroContatosDto,
  ): Promise<Pagina<ContatoDto>> {
    if (filtro.responsavelId && filtro.semResponsavel === true) {
      throw new DadosInvalidosException(
        'Use responsavelId ou semResponsavel, não os dois.',
        {
          campos: [
            {
              campo: 'semResponsavel',
              mensagens: ['não combina com responsavelId'],
            },
          ],
        },
      );
    }
    const where: Prisma.ContatoWhereInput = { excluidoEm: null };
    if (filtro.responsavelId) {
      where.responsavelId = filtro.responsavelId;
    } else if (filtro.semResponsavel !== undefined) {
      where.responsavelId = filtro.semResponsavel ? null : { not: null };
    }
    if (filtro.empresaId) {
      where.empresaId = filtro.empresaId;
    }
    if (filtro.origem) {
      where.primeiraOrigem = filtro.origem;
    }
    if (filtro.ultimaOrigem) {
      where.ultimaOrigem = filtro.ultimaOrigem;
    }
    if (filtro.optOut !== undefined) {
      where.optOutMarketing = filtro.optOut;
    }
    if (filtro.etiqueta) {
      const grafias = await grafiasDaEtiqueta(
        this.prisma,
        'contatos',
        filtro.etiqueta,
      );
      if (grafias.length === 0) {
        return montarPagina([], 0, filtro);
      }
      where.etiquetas = { hasSome: grafias };
    }
    const busca = filtroDeBuscaDeContatos(filtro.busca);
    if (busca) {
      where.AND = [busca];
    }
    const ordem =
      filtro.ordem ?? (filtro.ordenarPor === 'nome' ? 'asc' : 'desc');
    const [contatos, total, alcance] = await Promise.all([
      this.prisma.contato.findMany({
        where,
        include: INCLUIR_NO_CONTATO,
        orderBy: [ORDENACAO[filtro.ordenarPor](ordem), { id: 'asc' }],
        ...paraSkipTake(filtro),
      }),
      this.prisma.contato.count({ where }),
      this.permissoes.alcance(usuario),
    ]);
    return montarPagina(
      contatos.map((contato) =>
        ContatoDto.de(contato, alcance.permite(contato.responsavelId)),
      ),
      total,
      filtro,
    );
  }

  etiquetasEmUso(filtro: FiltroEtiquetasDto): Promise<EtiquetaEmUsoDto[]> {
    return listarEtiquetasEmUso(this.prisma, 'contatos', filtro);
  }

  async detalhar(usuario: UsuarioAutenticado, id: string): Promise<ContatoDto> {
    const [contato, alcance] = await Promise.all([
      this.prisma.contato.findFirst({
        where: { id, excluidoEm: null },
        include: INCLUIR_NO_CONTATO,
      }),
      this.permissoes.alcance(usuario),
    ]);
    if (!contato) {
      throw new NaoEncontradoException('Contato não encontrado.');
    }
    return ContatoDto.de(contato, alcance.permite(contato.responsavelId));
  }

  /**
   * Criação manual (R4.1–R4.7). Passa pela deduplicação: com e-mail ou
   * telefone de um contato ativo, reconverte em vez de criar (R4.2) — o que
   * não depende do alcance de edição, porque nada preenchido é sobrescrito.
   */
  async criar(
    usuario: UsuarioAutenticado,
    dto: CriarContatoDto,
  ): Promise<ResultadoCriacaoContatoDto> {
    if (dto.empresaId && dto.empresaNome?.trim()) {
      throw new DadosInvalidosException(
        'Informe empresaId ou empresaNome, não os dois.',
        {
          campos: [
            {
              campo: 'empresaNome',
              mensagens: ['não combina com empresaId'],
            },
          ],
        },
      );
    }
    const dados = normalizarEntradaDeContato({
      nome: dto.nome,
      email: dto.email ?? undefined,
      telefone: dto.telefone ?? undefined,
      cargo: dto.cargo ?? undefined,
      empresaId: dto.empresaId ?? null,
      empresaNome: dto.empresaNome ?? undefined,
      origem: dto.origem ?? 'MANUAL',
      origemDetalhe: dto.origemDetalhe ?? undefined,
      utm: dto.utm ?? undefined,
      etiquetas: dto.etiquetas,
      camposPersonalizados: dto.camposPersonalizados,
      // R4.5: o padrão é quem criou.
      responsavelId: dto.responsavelId ?? usuario.id,
      consentimento: this.lerConsentimento(dto.consentimento),
      optOutMarketing: dto.optOutMarketing,
    });
    const alcance = await this.permissoes.alcance(usuario);
    const resultado = await this.prisma.$transaction(async (tx) => {
      if (dados.responsavelId && dados.responsavelId !== usuario.id) {
        await this.permissoes.garantirPodeAtribuir(
          tx,
          alcance,
          dados.responsavelId,
          'contato',
        );
      }
      if (dados.empresaId) {
        await this.empresas.garantirAtiva(tx, dados.empresaId);
      }
      return this.deduplicar(tx, dados);
    });
    return {
      criado: resultado.criado,
      contato: await this.carregarDto(resultado.contato.id, alcance),
    };
  }

  /**
   * Edição (PATCH), conforme a matriz §12. E-mail e telefone continuam únicos
   * entre os contatos ativos (409 com o id do outro contato) e sempre sobra
   * pelo menos um dos dois (R4.1). As origens não se editam (R4.3).
   */
  async atualizar(
    usuario: UsuarioAutenticado,
    id: string,
    dto: AtualizarContatoDto,
  ): Promise<ContatoDto> {
    const email =
      dto.email === undefined ? undefined : normalizarEmailOpcional(dto.email);
    const telefone =
      dto.telefone === undefined
        ? undefined
        : normalizarTelefoneOpcional(dto.telefone);
    const consentimento = this.lerConsentimento(dto.consentimento);
    const alcance = await this.permissoes.alcance(usuario);

    const contato = await this.prisma.$transaction(async (tx) => {
      // Mesma ordem de travas da deduplicação (chaves, depois a linha): sem impasse.
      if (email) {
        await travarChave(tx, TRAVA_EMAIL_DO_CONTATO, email);
      }
      if (telefone) {
        await travarChave(tx, TRAVA_TELEFONE_DO_CONTATO, telefone);
      }
      const antes = await this.travarContatoAtivo(tx, id);
      this.permissoes.garantirPodeEditar(
        alcance,
        antes.responsavelId,
        'contato',
      );

      const dados: Prisma.ContatoUncheckedUpdateInput = {};
      if (dto.nome !== undefined) {
        dados.nome = normalizarTextoCurto(
          dto.nome,
          TAMANHO_MAXIMO_NOME,
        ) as string;
      }
      if (email !== undefined && email !== antes.email) {
        if (email) {
          await this.garantirMeioLivre(tx, 'email', email, id);
        }
        dados.email = email;
      }
      if (telefone !== undefined && telefone !== antes.telefone) {
        if (telefone) {
          await this.garantirMeioLivre(tx, 'telefone', telefone, id);
        }
        dados.telefone = telefone;
      }
      const emailFinal = email === undefined ? antes.email : email;
      const telefoneFinal = telefone === undefined ? antes.telefone : telefone;
      if (!emailFinal && !telefoneFinal) {
        const mensagens = ['o contato precisa de e-mail ou telefone'];
        throw new DadosInvalidosException(
          'O contato precisa de e-mail ou telefone (R4.1).',
          {
            regra: 'R4.1',
            campos: [
              { campo: 'email', mensagens },
              { campo: 'telefone', mensagens },
            ],
          },
        );
      }
      if (dto.cargo !== undefined) {
        dados.cargo = normalizarTextoCurto(dto.cargo);
      }
      if (dto.empresaId !== undefined && dto.empresaId !== antes.empresaId) {
        if (dto.empresaId) {
          await this.empresas.garantirAtiva(tx, dto.empresaId);
        }
        dados.empresaId = dto.empresaId;
      }
      if (
        dto.responsavelId !== undefined &&
        dto.responsavelId !== antes.responsavelId
      ) {
        await this.permissoes.garantirPodeAtribuir(
          tx,
          alcance,
          dto.responsavelId,
          'contato',
        );
        dados.responsavelId = dto.responsavelId;
      }
      if (dto.etiquetas !== undefined) {
        dados.etiquetas = normalizarEtiquetas(dto.etiquetas);
      }
      if (dto.camposPersonalizados !== undefined) {
        dados.camposPersonalizados = aplicarPatchDosCampos(
          antes.camposPersonalizados,
          dto.camposPersonalizados,
        ) as Prisma.InputJsonObject;
      }
      if (
        dto.optOutMarketing !== undefined &&
        dto.optOutMarketing !== antes.optOutMarketing
      ) {
        // R4.6: o opt-out guarda quando foi pedido.
        dados.optOutMarketing = dto.optOutMarketing;
        dados.optOutEm = dto.optOutMarketing ? new Date() : null;
      }
      if (consentimento !== undefined) {
        dados.consentimentoEm = consentimento?.em ?? null;
        dados.consentimentoOrigem = consentimento?.origem ?? null;
      }

      const alteracoes = calcularAlteracoes(
        antes,
        { ...antes, ...dados },
        CAMPOS_AUDITADOS_DO_CONTATO,
      );
      if (Object.keys(alteracoes).length === 0) {
        return antes;
      }
      const depois = await tx.contato.update({ where: { id }, data: dados });
      await this.auditoria.registrar(tx, {
        acao: 'contato.atualizado',
        entidade: 'contato',
        entidadeId: depois.id,
        resumo: `Contato "${depois.nome}" atualizado: ${descreverAlteracoes(alteracoes)}`,
        dados: { alteracoes },
        relacionados: { empresa: depois.empresaId ?? antes.empresaId },
      });
      await this.eventos.publicar(tx, 'contato.atualizado', {
        ...instantaneoDoContato(depois),
        camposAlterados: Object.keys(alteracoes),
        motivo: 'edicao',
      });
      if (dados.responsavelId !== undefined) {
        await this.notificarAtribuicao(tx, depois);
      }
      return depois;
    });
    return this.carregarDto(contato.id, alcance);
  }

  /**
   * Exclusão lógica com anonimização (R4.6, LGPD), só pelo Admin. Apaga os
   * dados pessoais do contato (nome, e-mail, telefone, cargo, empresa,
   * detalhes de origem, etiquetas, campos personalizados e consentimento),
   * liga o opt-out e marca `excluidoEm`; tipo da origem, UTM e conversões
   * ficam para as métricas. Nos títulos dos negócios e nos títulos e
   * descrições das atividades do contato, nome, e-mail e telefone viram
   * "Contato anonimizado". A auditoria registra o fato sem os dados apagados.
   * Depois disso, o e-mail e o telefone ficam livres para um novo contato.
   */
  async anonimizar(
    usuario: UsuarioAutenticado,
    id: string,
    dto: AnonimizarContatoDto,
  ): Promise<void> {
    if (!permissoesDoPapel(usuario.papel).anonimizarContatos) {
      throw new SemPermissaoException('Só o Admin anonimiza contatos (R4.6).');
    }
    await this.prisma.$transaction(async (tx) => {
      const contato = await this.travarContatoAtivo(tx, id);
      const agora = new Date();
      const termos = termosPessoais(contato);
      const anonimizado = await tx.contato.update({
        where: { id },
        data: dadosDaAnonimizacao(contato, agora),
      });
      const negocios = await this.anonimizarNegocios(tx, contato.id, termos);
      const atividades = await this.anonimizarAtividades(
        tx,
        contato.id,
        termos,
      );
      await this.auditoria.registrar(tx, {
        acao: 'contato.anonimizado',
        entidade: 'contato',
        entidadeId: id,
        resumo: 'Contato anonimizado pelo Admin (LGPD, R4.6)',
        dados: {
          motivo: dto.motivo?.trim() || null,
          camposAnonimizados: [...CAMPOS_ANONIMIZADOS],
          negociosAtualizados: negocios,
          atividadesAtualizadas: atividades,
        },
        relacionados: { empresa: contato.empresaId },
      });
      await this.eventos.publicar(tx, 'contato.anonimizado', {
        contatoId: id,
        anonimizadoEm: agora,
      });
      await this.eventos.publicar(tx, 'contato.atualizado', {
        ...instantaneoDoContato(anonimizado),
        camposAlterados: [...CAMPOS_ANONIMIZADOS, 'optOutMarketing'],
        motivo: 'anonimizacao',
        anonimizado: true,
      });
    });
  }

  async linhaDoTempo(
    usuario: UsuarioAutenticado,
    id: string,
    filtro: FiltroDaLinhaDoTempoDto,
  ): Promise<Pagina<RegistroDaLinhaDoTempoDto>> {
    const existe = await this.prisma.contato.count({
      where: { id, excluidoEm: null },
    });
    if (existe === 0) {
      throw new NaoEncontradoException('Contato não encontrado.');
    }
    return this.linhaDoTempoService.listar(usuario, 'contato', id, filtro);
  }

  // ===========================================================================
  // Internos
  // ===========================================================================

  private async deduplicar(
    tx: Tx,
    dados: ContatoNormalizado,
  ): Promise<ResultadoEncontrarOuCriar> {
    // R4.2: as travas vêm antes da busca. Uma segunda transação com o mesmo
    // e-mail (ou telefone) espera aqui e, ao seguir, encontra o contato que a
    // primeira gravou.
    if (dados.email) {
      await travarChave(tx, TRAVA_EMAIL_DO_CONTATO, dados.email);
    }
    if (dados.telefone) {
      await travarChave(tx, TRAVA_TELEFONE_DO_CONTATO, dados.telefone);
    }
    const existente = await this.travarAtivoPorMeioDeContato(tx, dados);
    if (existente) {
      return {
        contato: await this.reconverter(tx, existente, dados),
        criado: false,
      };
    }
    return { contato: await this.criarNovo(tx, dados), criado: true };
  }

  /**
   * O contato ativo com o e-mail (primeiro) ou o telefone, já travado. `FOR NO
   * KEY UPDATE` serializa as escritas no contato sem barrar quem só o
   * referencia (a checagem de chave estrangeira de uma atividade ou negócio
   * novo pede `KEY SHARE`). Se outra transação anonimizar o contato enquanto
   * esta espera, a condição é reavaliada e ele deixa de ser encontrado.
   */
  private async travarAtivoPorMeioDeContato(
    tx: Tx,
    dados: ContatoNormalizado,
  ): Promise<Contato | null> {
    if (dados.email) {
      const [linha] = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM contatos
         WHERE email = ${dados.email} AND excluido_em IS NULL
         LIMIT 1 FOR NO KEY UPDATE`;
      if (linha) {
        return tx.contato.findUniqueOrThrow({ where: { id: linha.id } });
      }
    }
    if (dados.telefone) {
      const [linha] = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM contatos
         WHERE telefone = ${dados.telefone} AND excluido_em IS NULL
         LIMIT 1 FOR NO KEY UPDATE`;
      if (linha) {
        return tx.contato.findUniqueOrThrow({ where: { id: linha.id } });
      }
    }
    return null;
  }

  private async criarNovo(tx: Tx, dados: ContatoNormalizado): Promise<Contato> {
    const contexto = contextoAtual();
    const responsavelId = dados.responsavelId
      ? (
          await this.permissoes.garantirResponsavelAtivo(
            tx,
            dados.responsavelId,
          )
        ).id
      : (contexto.usuario?.id ?? null);
    const empresaId =
      dados.empresaId ??
      (dados.empresaNome
        ? (
            await this.empresas.encontrarOuCriarPorNome(tx, dados.empresaNome, {
              responsavelId,
            })
          ).empresa.id
        : null);
    const agora = new Date();
    const contato = await tx.contato.create({
      data: {
        nome: dados.nome,
        email: dados.email,
        telefone: dados.telefone,
        cargo: dados.cargo,
        empresaId,
        responsavelId,
        primeiraOrigem: dados.origem,
        primeiraOrigemDetalhe: dados.origemDetalhe,
        primeiraOrigemUtm: jsonOuNulo(dados.utm),
        ultimaOrigem: dados.origem,
        ultimaOrigemDetalhe: dados.origemDetalhe,
        ultimaOrigemUtm: jsonOuNulo(dados.utm),
        ultimaOrigemEm: agora,
        conversoes: 1,
        etiquetas: dados.etiquetas,
        camposPersonalizados:
          dados.camposPersonalizados as Prisma.InputJsonObject,
        optOutMarketing: dados.optOutMarketing,
        optOutEm: dados.optOutMarketing ? agora : null,
        consentimentoEm: dados.consentimento?.em ?? null,
        consentimentoOrigem: dados.consentimento?.origem ?? null,
        criadoPorId: contexto.usuario?.id ?? null,
      },
    });
    await this.auditoria.registrar(tx, {
      acao: 'contato.criado',
      entidade: 'contato',
      entidadeId: contato.id,
      resumo: `Contato "${contato.nome}" criado por ${descreverOrigem(dados.origem, dados.origemDetalhe)}`,
      dados: {
        alteracoes: calcularAlteracoes(
          {},
          contato,
          CAMPOS_AUDITADOS_DO_CONTATO,
        ),
        ...(dados.descartados.length > 0
          ? { descartados: dados.descartados }
          : {}),
      },
      relacionados: { empresa: contato.empresaId },
    });
    await this.eventos.publicar(
      tx,
      'contato.criado',
      instantaneoDoContato(contato),
    );
    await this.notificarAtribuicao(tx, contato);
    return contato;
  }

  private async reconverter(
    tx: Tx,
    existente: Contato,
    dados: ContatoNormalizado,
  ): Promise<Contato> {
    const agora = new Date();
    // E-mail ou telefone da entrada que já é de OUTRO contato ativo não é
    // copiado (o índice único recusaria): fica registrado como possível
    // duplicidade. As chaves estão travadas desde o começo.
    const emailDeOutro =
      !existente.email && dados.email
        ? await this.outroContatoCom(tx, 'email', dados.email, existente.id)
        : null;
    const telefoneDeOutro =
      !existente.telefone && dados.telefone
        ? await this.outroContatoCom(
            tx,
            'telefone',
            dados.telefone,
            existente.id,
          )
        : null;
    const responsavelId = existente.responsavelId
      ? null
      : await this.responsavelParaCompletar(tx, dados);
    let empresaId: string | null = null;
    if (!existente.empresaId) {
      if (dados.empresaId) {
        empresaId = dados.empresaId;
      } else if (dados.empresaNome) {
        empresaId = (
          await this.empresas.encontrarOuCriarPorNome(tx, dados.empresaNome, {
            responsavelId: existente.responsavelId ?? responsavelId,
          })
        ).empresa.id;
      }
    }
    const plano = planejarReconversao(existente, dados, {
      emailLivre: emailDeOutro === null,
      telefoneLivre: telefoneDeOutro === null,
      empresaId,
      responsavelId,
      agora,
    });
    const atualizado = await tx.contato.update({
      where: { id: existente.id },
      data: plano.dados,
    });
    const alteracoes = calcularAlteracoes(
      existente,
      atualizado,
      CAMPOS_AUDITADOS_DO_CONTATO,
    );
    const origem = {
      tipo: dados.origem,
      detalhe: dados.origemDetalhe,
      utm: dados.utm,
    };
    const deOutroContato = [
      ...(emailDeOutro ? [{ campo: 'email', contatoId: emailDeOutro }] : []),
      ...(telefoneDeOutro
        ? [{ campo: 'telefone', contatoId: telefoneDeOutro }]
        : []),
    ];
    await this.auditoria.registrar(tx, {
      acao: 'contato.reconvertido',
      entidade: 'contato',
      entidadeId: atualizado.id,
      resumo: `Contato "${atualizado.nome}" reconvertido por ${descreverOrigem(dados.origem, dados.origemDetalhe)}`,
      dados: {
        origem,
        conversoes: atualizado.conversoes,
        camposCompletados: plano.camposCompletados,
        alteracoes,
        ...(deOutroContato.length > 0 ? { deOutroContato } : {}),
        ...(dados.descartados.length > 0
          ? { descartados: dados.descartados }
          : {}),
      },
      relacionados: { empresa: atualizado.empresaId },
    });
    const instantaneo = instantaneoDoContato(atualizado);
    await this.eventos.publicar(tx, 'contato.reconvertido', {
      ...instantaneo,
      origem,
      camposCompletados: plano.camposCompletados,
    });
    await this.eventos.publicar(tx, 'contato.atualizado', {
      ...instantaneo,
      camposAlterados: Object.keys(alteracoes),
      motivo: 'reconversao',
    });
    if (plano.camposCompletados.includes('responsavelId')) {
      await this.notificarAtribuicao(tx, atualizado);
    }
    return atualizado;
  }

  /** Responsável para um contato existente sem responsável: o informado (ativo, R4.5) ou o usuário logado. */
  private async responsavelParaCompletar(
    tx: Tx,
    dados: ContatoNormalizado,
  ): Promise<string | null> {
    if (dados.responsavelId) {
      return (
        await this.permissoes.garantirResponsavelAtivo(tx, dados.responsavelId)
      ).id;
    }
    return contextoAtual().usuario?.id ?? null;
  }

  private async outroContatoCom(
    tx: Tx,
    campo: 'email' | 'telefone',
    valor: string,
    exceto: string,
  ): Promise<string | null> {
    const outro = await tx.contato.findFirst({
      where:
        campo === 'email'
          ? { email: valor, excluidoEm: null, NOT: { id: exceto } }
          : { telefone: valor, excluidoEm: null, NOT: { id: exceto } },
      select: { id: true },
    });
    return outro?.id ?? null;
  }

  /** R4.2: e-mail e telefone únicos entre os contatos ativos (409 com o id do outro contato). */
  private async garantirMeioLivre(
    tx: Tx,
    campo: 'email' | 'telefone',
    valor: string,
    exceto: string,
  ): Promise<void> {
    const outro = await this.outroContatoCom(tx, campo, valor, exceto);
    if (outro) {
      throw new ConflitoException(
        campo === 'email'
          ? 'Já existe um contato com este e-mail.'
          : 'Já existe um contato com este telefone.',
        {
          regra: 'R4.2',
          campos: [campo],
          restricao:
            campo === 'email'
              ? 'contatos_email_ativo_key'
              : 'contatos_telefone_ativo_key',
          contatoId: outro,
        },
      );
    }
  }

  /** Trava a linha do contato ativo (`FOR NO KEY UPDATE`) e a devolve; 404 se não existir. */
  private async travarContatoAtivo(tx: Tx, id: string): Promise<Contato> {
    const [linha] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM contatos WHERE id = ${id}::uuid AND excluido_em IS NULL FOR NO KEY UPDATE`;
    if (!linha) {
      throw new NaoEncontradoException('Contato não encontrado.');
    }
    return tx.contato.findUniqueOrThrow({ where: { id } });
  }

  /** Títulos de negócios do contato com nome, e-mail ou telefone dele (R4.6). */
  private async anonimizarNegocios(
    tx: Tx,
    contatoId: string,
    termos: readonly string[],
  ): Promise<number> {
    const negocios = await tx.negocio.findMany({
      where: { contatoId },
      select: { id: true, titulo: true, empresaId: true },
    });
    let alterados = 0;
    for (const negocio of negocios) {
      const titulo = anonimizarTexto(negocio.titulo, termos);
      if (titulo === negocio.titulo) {
        continue;
      }
      await tx.negocio.update({ where: { id: negocio.id }, data: { titulo } });
      await this.auditoria.registrar(tx, {
        acao: 'negocio.atualizado',
        entidade: 'negocio',
        entidadeId: negocio.id,
        resumo: 'Título do negócio anonimizado com o contato (LGPD, R4.6)',
        dados: { motivo: 'anonimizacao_do_contato', campos: ['titulo'] },
        relacionados: { contato: contatoId, empresa: negocio.empresaId },
      });
      alterados++;
    }
    return alterados;
  }

  /** Títulos e descrições das atividades do contato com nome, e-mail ou telefone dele (R4.6). */
  private async anonimizarAtividades(
    tx: Tx,
    contatoId: string,
    termos: readonly string[],
  ): Promise<number> {
    const atividades = await tx.atividade.findMany({
      where: { contatoId },
      select: {
        id: true,
        titulo: true,
        descricao: true,
        empresaId: true,
        negocioId: true,
      },
    });
    let alteradas = 0;
    for (const atividade of atividades) {
      const titulo = anonimizarTexto(atividade.titulo, termos);
      const descricao =
        atividade.descricao === null
          ? null
          : anonimizarTexto(atividade.descricao, termos);
      const campos = [
        ...(titulo !== atividade.titulo ? ['titulo'] : []),
        ...(descricao !== atividade.descricao ? ['descricao'] : []),
      ];
      if (campos.length === 0) {
        continue;
      }
      await tx.atividade.update({
        where: { id: atividade.id },
        data: { titulo, descricao },
      });
      await this.auditoria.registrar(tx, {
        acao: 'atividade.atualizada',
        entidade: 'atividade',
        entidadeId: atividade.id,
        resumo: 'Atividade anonimizada com o contato (LGPD, R4.6)',
        dados: { motivo: 'anonimizacao_do_contato', campos },
        relacionados: {
          contato: contatoId,
          empresa: atividade.empresaId,
          negocio: atividade.negocioId,
        },
      });
      alteradas++;
    }
    return alteradas;
  }

  /** Avisa quem recebeu o contato por ação de outra pessoa (R10.2, "lead atribuído"). */
  private async notificarAtribuicao(tx: Tx, contato: Contato): Promise<void> {
    const contexto = contextoAtual();
    if (
      !contato.responsavelId ||
      contexto.tipoAtor !== 'USUARIO' ||
      contexto.usuario?.id === contato.responsavelId
    ) {
      return;
    }
    await this.notificacoes.notificar(tx, contato.responsavelId, {
      tipo: NOTIFICACAO_CONTATO_ATRIBUIDO,
      titulo: 'Contato atribuído a você',
      texto: `${contexto.usuario?.nome ?? 'Alguém'} passou o contato ${contato.nome} para você.`,
      link: `/contatos/${contato.id}`,
      dados: { contatoId: contato.id },
    });
  }

  /** Consentimento da entrada (R4.6): `undefined` = não mexe; `null` = apaga. */
  private lerConsentimento(
    entrada: ConsentimentoEntradaDto | null | undefined,
  ): { em: Date; origem: string } | null | undefined {
    if (entrada === undefined || entrada === null) {
      return entrada;
    }
    const em = entrada.em ? new Date(entrada.em) : new Date();
    if (em.getTime() > Date.now() + TOLERANCIA_DE_RELOGIO_MS) {
      throw new DadosInvalidosException(
        'A data do consentimento não pode ser no futuro.',
        {
          campos: [
            {
              campo: 'consentimento.em',
              mensagens: ['não pode ser no futuro'],
            },
          ],
        },
      );
    }
    return { em, origem: entrada.origem.replace(/\s+/g, ' ').trim() };
  }

  /**
   * O DTO é montado depois do commit: um `include` com várias relações dentro
   * da transação faz o Prisma disparar consultas em paralelo na mesma conexão
   * (o `pg` 8 avisa; o 9 vai recusar).
   */
  private async carregarDto(
    id: string,
    alcance: AlcanceDeEdicao,
  ): Promise<ContatoDto> {
    const contato = await this.prisma.contato.findUniqueOrThrow({
      where: { id },
      include: INCLUIR_NO_CONTATO,
    });
    return ContatoDto.de(contato, alcance.permite(contato.responsavelId));
  }
}
