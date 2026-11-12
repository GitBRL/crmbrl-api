import { Injectable } from '@nestjs/common';
import { AuditoriaService } from '../auditoria/auditoria.service';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import {
  contextoAtual,
  executarComoSistemaNoBanco,
} from '../comum/contexto/contexto-requisicao';
import { calcularAlteracoes } from '../comum/dados/sanitizar';
import { lerValor } from '../comum/dominio/dinheiro';
import { normalizarUtm, type Utm } from '../comum/dominio/utm';
import {
  ConflitoException,
  DadosInvalidosException,
  NaoEncontradoException,
  RegraVioladaException,
  SemPermissaoException,
} from '../comum/erros/excecoes';
import { EventosDominioService } from '../eventos/eventos-dominio.service';
import type {
  EstrategiaDistribuicao,
  Etapa,
  Funil,
  Negocio,
  OrigemContato,
  Prisma,
} from '../generated/prisma/client';
import { NotificacoesService } from '../notificacoes/notificacoes.service';
import { TIPOS_NOTIFICACAO } from '../notificacoes/tipos-notificacao';
import { PrismaService, type Tx } from '../prisma/prisma.service';
import type {
  AcessoAosFunis,
  FunilParaAcesso,
  NegocioParaAcesso,
} from './acesso-funis';
import {
  acessosDoFunil,
  funisAcessiveis,
  podeSerResponsavelNoFunil,
} from './acessos-no-banco';
import {
  type AtualizarNegocioDto,
  type CriarNegocioDto,
  type MoverNegocioDto,
  type NegocioDaJornadaDto,
  type NegocioDetalheDto,
  NegocioDto,
  type ReabrirNegocioDto,
  type ResultadoMovimentacaoDto,
} from './dto/negocios.dto';
import {
  dadosDoEventoDeNegocio,
  linkDoNegocio,
  MotorDeNegociosService,
  motivoDePerdaObrigatorio,
  type PassagemExecutada,
  relacionadosDoNegocio,
} from './motor-de-negocios.service';
import { sdrPorContato } from './sdr-do-negocio';
import {
  INCLUIR_NEGOCIO,
  lerDataSemHora,
  type NegocioCompleto,
} from './negocio-completo';

/**
 * Entrada de `criarAutomatico` (contrato da Fase 1, §5) — usada pelos
 * webhooks de entrada. Valores em texto decimal (`'1500.00'`).
 */
export interface EntradaNegocioAutomatico {
  contatoId: string;
  empresaId?: string;
  funilId: string;
  etapaId: string;
  titulo?: string;
  valor?: string;
  valorRecorrente?: string;
  origem: OrigemContato;
  origemDetalhe?: string;
  utm?: Utm;
  estrategia: EstrategiaDistribuicao;
  responsavelFixoId?: string;
  /** Integração no modo "criar" (R32.3): cria um negócio novo mesmo com outro aberto do contato no funil (sem reconversão). */
  sempreCriar?: boolean;
  /** Integração (R32.3): com mais de um aberto, a reconversão vai para o mais recente (padrão: o mais antigo, R5.6). */
  abertoMaisRecente?: boolean;
  /** `false` não notifica o responsável (a importação manda uma só notificação por responsável ao concluir). Padrão: notifica. */
  notificar?: boolean;
  /**
   * Importação (R16.14): `fechado` cria o negócio já fechado na etapa de ganho
   * ou de perda (sem reconversão, sem passagens, sem notificação); `criadoEm`
   * é a data de criação na origem; `idExterno`, o id no sistema de origem
   * (também gravado no negócio aberto em que a reconversão caiu); `detalhes`
   * vai para a auditoria da criação.
   */
  importado?: {
    fechado?: { motivoPerda?: string | null; em: Date };
    criadoEm?: Date;
    idExterno?: string;
    detalhes?: Record<string, unknown>;
  };
}

/** Atualização de um negócio já importado (mesmo `idExterno`, R16.14). */
export interface EntradaAtualizacaoImportada {
  /** COMPLETAR só preenche o que está vazio; SOBRESCREVER troca e move. */
  modo: 'COMPLETAR' | 'SOBRESCREVER';
  titulo?: string;
  valor?: string;
  responsavelId?: string;
  motivoPerda?: string;
  /** Etapa de destino (a de ganho/perda no negócio fechado) e data do fechamento. */
  etapaId: string;
  fechadoEm?: Date;
}

/** Campos do negócio que a edição audita (antes/depois, R3.1). */
const CAMPOS_EDITAVEIS = [
  'titulo',
  'contatoId',
  'empresaId',
  'responsavelId',
  'valor',
  'valorRecorrente',
  'previsaoFechamento',
  'motivoPerda',
  'camposPersonalizados',
] as const;

/**
 * Negócios (R5.3–R5.9): criar, editar, mover, reabrir, assumir e excluir,
 * cada operação numa transação com auditoria, eventos e notificações — e a
 * criação automática (`criarAutomatico`) para os webhooks de entrada.
 *
 * Visibilidade e ações pelo nível da pessoa no funil (R5.9, R5.12,
 * `funisAcessiveis`): `VER` só lê; `MEMBRO` vê os seus e os sem responsável e
 * age neles; `GESTOR` age em todos; `CONFIGURAR` (líder do setor dono, C-level,
 * Admin) também reabre e exclui (R5.5). Negócio que a pessoa não vê responde
 * 404; o que ela só vê (`VER`), 403 nas ações.
 */
@Injectable()
export class NegociosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly motor: MotorDeNegociosService,
    private readonly auditoria: AuditoriaService,
    private readonly eventos: EventosDominioService,
    private readonly notificacoes: NotificacoesService,
  ) {}

  /**
   * O negócio e a jornada dele (R5.7): de onde veio e o que gerou nos outros
   * funis, com a área de cada um e se quem consulta o vê (R5.9) — quem não vê
   * fica sabendo só que existe um negócio naquela área.
   */
  async detalhar(
    usuario: UsuarioAutenticado,
    id: string,
  ): Promise<NegocioDetalheDto> {
    const { negocio, acesso } = await this.carregarVisivel(
      this.prisma,
      usuario,
      id,
    );
    const LIGADO = {
      id: true,
      responsavelId: true,
      funilId: true,
      funil: { select: { area: true } },
    } satisfies Prisma.NegocioSelect;
    // R35.2: a jornada mostra que existe um negócio ligado em outro setor (só
    // o id, a área e se a pessoa o vê): lida como sistema; o recorte é o abaixo.
    const origem = negocio.negocioOrigemId
      ? await executarComoSistemaNoBanco(() =>
          this.prisma.negocio.findFirst({
            where: { id: negocio.negocioOrigemId as string, excluidoEm: null },
            select: LIGADO,
          }),
        )
      : null;
    const gerados = await executarComoSistemaNoBanco(() =>
      this.prisma.negocio.findMany({
        where: { negocioOrigemId: negocio.id, excluidoEm: null },
        orderBy: [{ criadoEm: 'asc' }, { id: 'asc' }],
        select: LIGADO,
      }),
    );
    const daJornada = (
      ligado: Prisma.NegocioGetPayload<{ select: typeof LIGADO }>,
    ): NegocioDaJornadaDto => ({
      id: ligado.id,
      area: ligado.funil.area,
      visivel: acesso.podeVerNegocio(ligado),
    });
    const sdr = (await sdrPorContato(this.prisma, [negocio.contatoId])).get(
      negocio.contatoId,
    );
    return Object.assign(NegocioDto.de(negocio, new Date(), sdr ?? null), {
      jornada: {
        origem: origem ? daJornada(origem) : null,
        gerados: gerados.map(daJornada),
      },
    });
  }

  /**
   * Criação manual (R5.3): livre — não deduplica (R5.6). Padrões: etapa = a
   * primeira aberta; título = nome do contato; empresa = a do contato;
   * responsável = quem cria. Entrar já numa etapa de perda exige motivo
   * (R5.5) e entrar no gatilho de uma passagem a executa (R5.7).
   */
  async criar(
    usuario: UsuarioAutenticado,
    dto: CriarNegocioDto,
  ): Promise<NegocioDto> {
    const negocio = await this.prisma.$transaction(async (tx) => {
      const funil = await this.funilParaCriar(tx, usuario, dto.funilId);
      if (!funil.ativo) {
        throw new RegraVioladaException(
          'R5.1',
          `O funil ${funil.nome} está arquivado e não recebe negócios.`,
          { funilId: funil.id },
        );
      }
      const etapa = dto.etapaId
        ? await this.etapaDoFunil(tx, funil, dto.etapaId)
        : await this.primeiraEtapaAberta(tx, funil.id);
      if (etapa.tipo === 'PERDIDO' && !dto.motivoPerda) {
        throw motivoDePerdaObrigatorio();
      }
      const contato = await this.contatoAtivo(tx, dto.contatoId);
      const empresaId =
        dto.empresaId === undefined ? contato.empresaId : dto.empresaId;
      if (empresaId) {
        await this.empresaAtiva(tx, empresaId);
      }
      const responsavelId =
        dto.responsavelId === undefined ? usuario.id : dto.responsavelId;
      if (responsavelId) {
        await this.validarResponsavel(tx, responsavelId, funil);
      }
      const criado = await this.motor.criar(tx, {
        titulo: dto.titulo ?? contato.nome,
        contatoId: contato.id,
        empresaId,
        funil,
        etapa,
        responsavelId,
        valor: lerValor(dto.valor ?? '0'),
        valorRecorrente:
          dto.valorRecorrente === undefined || dto.valorRecorrente === null
            ? null
            : lerValor(dto.valorRecorrente),
        previsaoFechamento: dto.previsaoFechamento
          ? lerDataSemHora(dto.previsaoFechamento)
          : null,
        motivoPerda: dto.motivoPerda ?? null,
        origem: dto.origem ?? 'MANUAL',
        origemDetalhe: dto.origemDetalhe || null,
        utm: normalizarUtm(dto.utm as Record<string, unknown> | undefined),
        camposPersonalizados: dto.camposPersonalizados ?? {},
        negocioOrigemId: null,
        criadoPorId: usuario.id,
      });
      if (responsavelId && responsavelId !== usuario.id) {
        await this.notificarAtribuicao(tx, criado, usuario.nome);
      }
      await this.motor.executarPassagens(tx, criado);
      return criado;
    });
    return NegocioDto.de(negocio);
  }

  /** Edição dos dados (não da etapa): auditada campo a campo (R3.1). */
  async atualizar(
    usuario: UsuarioAutenticado,
    id: string,
    dto: AtualizarNegocioDto,
  ): Promise<NegocioDto> {
    const negocio = await this.prisma.$transaction(async (tx) => {
      const antes = await this.carregarParaAgir(tx, usuario, id);
      const dados: Prisma.NegocioUncheckedUpdateInput = {};
      if (dto.titulo !== undefined) {
        dados.titulo = dto.titulo;
      }
      if (dto.contatoId !== undefined && dto.contatoId !== antes.contatoId) {
        dados.contatoId = (await this.contatoAtivo(tx, dto.contatoId)).id;
      }
      if (dto.empresaId !== undefined && dto.empresaId !== antes.empresaId) {
        if (dto.empresaId) {
          await this.empresaAtiva(tx, dto.empresaId);
        }
        dados.empresaId = dto.empresaId;
      }
      if (
        dto.responsavelId !== undefined &&
        dto.responsavelId !== antes.responsavelId
      ) {
        if (dto.responsavelId) {
          await this.validarResponsavel(tx, dto.responsavelId, antes.funil);
        }
        dados.responsavelId = dto.responsavelId;
      }
      if (dto.valor !== undefined) {
        dados.valor = lerValor(dto.valor);
      }
      if (dto.valorRecorrente !== undefined) {
        dados.valorRecorrente =
          dto.valorRecorrente === null ? null : lerValor(dto.valorRecorrente);
      }
      if (dto.previsaoFechamento !== undefined) {
        dados.previsaoFechamento =
          dto.previsaoFechamento === null
            ? null
            : lerDataSemHora(dto.previsaoFechamento);
      }
      if (dto.motivoPerda !== undefined) {
        if (antes.status !== 'PERDIDO') {
          throw new RegraVioladaException(
            'R5.5',
            'Só negócio perdido tem motivo de perda.',
            { status: antes.status },
          );
        }
        dados.motivoPerda = dto.motivoPerda;
      }
      if (dto.camposPersonalizados !== undefined) {
        dados.camposPersonalizados =
          dto.camposPersonalizados as Prisma.InputJsonObject;
      }
      if (Object.keys(dados).length === 0) {
        return antes;
      }
      const depois = await tx.negocio.update({
        where: { id },
        data: dados,
        include: INCLUIR_NEGOCIO,
      });
      const alteracoes = calcularAlteracoes(antes, depois, CAMPOS_EDITAVEIS);
      if (Object.keys(alteracoes).length === 0) {
        return depois;
      }
      await this.auditoria.registrar(tx, {
        acao: 'negocio.atualizado',
        entidade: 'negocio',
        entidadeId: depois.id,
        resumo: `Negócio "${depois.titulo}" atualizado (${Object.keys(alteracoes).join(', ')})`,
        dados: { alteracoes },
        relacionados: relacionadosDoNegocio(depois),
      });
      await this.eventos.publicar(
        tx,
        'negocio.atualizado',
        dadosDoEventoDeNegocio(depois, { alteracoes }),
      );
      if (
        'responsavelId' in alteracoes &&
        depois.responsavelId &&
        depois.responsavelId !== usuario.id
      ) {
        await this.notificarAtribuicao(tx, depois, usuario.nome);
      }
      return depois;
    });
    return NegocioDto.de(negocio);
  }

  /**
   * Move o negócio para outra etapa do mesmo funil (R5.4) ou só reposiciona o
   * cartão na mesma etapa. Perda exige motivo (400, R5.5); tirar um negócio
   * ganho ou perdido da etapa é reabrir, só do líder da área, C-level e Admin
   * (R5.5). As passagens disparadas rodam na mesma transação (R5.7).
   */
  async mover(
    usuario: UsuarioAutenticado,
    id: string,
    dto: MoverNegocioDto,
  ): Promise<ResultadoMovimentacaoDto> {
    const { negocio, passagens } = await this.prisma.$transaction(
      async (tx) => {
        const { negocio: atual, acesso } = await this.carregarVisivel(
          tx,
          usuario,
          id,
          true,
        );
        this.exigirAcao(acesso, atual);
        const destino = await tx.etapa.findUnique({
          where: { id: dto.etapaId },
        });
        if (!destino) {
          throw new NaoEncontradoException('Etapa não encontrada.');
        }
        if (destino.funilId !== atual.funilId) {
          throw new RegraVioladaException(
            'R5.4',
            'Não se move um negócio para a etapa de outro funil: isso é papel das passagens.',
            { funilId: atual.funilId, etapaId: destino.id },
          );
        }
        if (destino.id === atual.etapaId) {
          return {
            negocio: await this.reposicionar(tx, atual, dto),
            passagens: [],
          };
        }
        if (
          atual.status !== 'ABERTO' &&
          !acesso.podeConfigurarFunil(atual.funilId)
        ) {
          throw this.semPermissaoParaReabrir();
        }
        if (destino.tipo === 'PERDIDO' && !dto.motivoPerda) {
          throw motivoDePerdaObrigatorio();
        }
        const posicao = await this.motor.posicaoEntreVizinhos(
          tx,
          destino.id,
          atual.id,
          dto.depoisDeId,
          dto.antesDeId,
        );
        const movido = await this.motor.entrarNaEtapa(tx, atual, destino, {
          motivoPerda: dto.motivoPerda ?? null,
          posicao,
        });
        return {
          negocio: movido,
          passagens: await this.motor.executarPassagens(tx, movido),
        };
      },
    );
    return { negocio: NegocioDto.de(negocio), passagens };
  }

  /**
   * Reabre um negócio ganho ou perdido (R5.5: líder da área, C-level e Admin),
   * levando-o para a etapa aberta informada — ou para a etapa aberta em que
   * estava antes de fechar.
   */
  async reabrir(
    usuario: UsuarioAutenticado,
    id: string,
    dto: ReabrirNegocioDto,
  ): Promise<ResultadoMovimentacaoDto> {
    const { negocio, passagens } = await this.prisma.$transaction(
      async (tx) => {
        const { negocio: atual, acesso } = await this.carregarVisivel(
          tx,
          usuario,
          id,
          true,
        );
        if (atual.status === 'ABERTO') {
          throw new ConflitoException('O negócio já está aberto.');
        }
        if (!acesso.podeConfigurarFunil(atual.funilId)) {
          throw this.semPermissaoParaReabrir();
        }
        const destino = dto.etapaId
          ? await tx.etapa.findFirst({
              where: { id: dto.etapaId, funilId: atual.funilId },
            })
          : await this.etapaParaReabrir(tx, atual);
        if (!destino || destino.tipo !== 'ABERTA') {
          throw new RegraVioladaException(
            'R5.5',
            'Reabrir leva o negócio para uma etapa aberta do mesmo funil.',
            { etapaId: dto.etapaId ?? null },
          );
        }
        const reaberto = await this.motor.entrarNaEtapa(tx, atual, destino, {
          posicao: await this.motor.posicaoNoTopo(tx, destino.id, atual.id),
        });
        return {
          negocio: reaberto,
          passagens: await this.motor.executarPassagens(tx, reaberto),
        };
      },
    );
    return { negocio: NegocioDto.de(negocio), passagens };
  }

  /** R5.9, R5.12: quem age no funil (`MEMBRO` ou mais) assume um negócio ainda sem responsável. */
  async assumir(usuario: UsuarioAutenticado, id: string): Promise<NegocioDto> {
    const negocio = await this.prisma.$transaction(async (tx) => {
      const atual = await this.carregarParaAgir(tx, usuario, id);
      if (atual.responsavelId === usuario.id) {
        return atual;
      }
      if (atual.responsavelId !== null) {
        throw new ConflitoException(
          'O negócio já tem responsável. Peça ao líder para transferir.',
          { responsavelId: atual.responsavelId },
        );
      }
      const depois = await tx.negocio.update({
        where: { id },
        data: { responsavelId: usuario.id },
        include: INCLUIR_NEGOCIO,
      });
      const alteracoes = calcularAlteracoes(atual, depois, ['responsavelId']);
      await this.auditoria.registrar(tx, {
        acao: 'negocio.assumido',
        entidade: 'negocio',
        entidadeId: depois.id,
        resumo: `${usuario.nome} assumiu o negócio "${depois.titulo}"`,
        dados: { alteracoes },
        relacionados: relacionadosDoNegocio(depois),
      });
      await this.eventos.publicar(
        tx,
        'negocio.atualizado',
        dadosDoEventoDeNegocio(depois, { alteracoes }),
      );
      return depois;
    });
    return NegocioDto.de(negocio);
  }

  /** Exclusão lógica (`excluidoEm`), pelo líder da área, C-level ou Admin. */
  async excluir(usuario: UsuarioAutenticado, id: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const { negocio: atual, acesso } = await this.carregarVisivel(
        tx,
        usuario,
        id,
        true,
      );
      if (!acesso.podeConfigurarFunil(atual.funilId)) {
        throw new SemPermissaoException(
          'Só o líder do setor do funil, o C-level e o Admin excluem negócios.',
          { regra: 'R5.12' },
        );
      }
      const excluido = await tx.negocio.update({
        where: { id },
        data: { excluidoEm: new Date() },
        include: INCLUIR_NEGOCIO,
      });
      await this.auditoria.registrar(tx, {
        acao: 'negocio.excluido',
        entidade: 'negocio',
        entidadeId: id,
        resumo: `Negócio "${excluido.titulo}" excluído de ${excluido.funil.nome}`,
        dados: {
          status: excluido.status,
          etapa: { id: excluido.etapa.id, nome: excluido.etapa.nome },
          valor: excluido.valor,
        },
        relacionados: relacionadosDoNegocio(excluido),
      });
      await this.eventos.publicar(
        tx,
        'negocio.excluido',
        dadosDoEventoDeNegocio(excluido),
      );
    });
  }

  /**
   * Criação automática (contrato §5) — webhooks de entrada (R8.5), **dentro
   * da transação de quem chama** (com o ator do contexto, ex.: `WEBHOOK`):
   *
   * 1. confere funil (existe, não excluído nem arquivado), etapa (do funil e
   *    não de perda), contato e empresa (não excluídos);
   * 2. R5.6: com um negócio **aberto** do contato no funil, registra a
   *    reconversão nele (`negocio.reconvertido`) em vez de criar outro;
   * 3. senão, distribui (R5.8, pela `estrategia`) e cria (`negocio.criado`);
   * 4. notifica o responsável (`negocio.atribuido`: lead novo ou que voltou)
   *    — quem chama não precisa notificar de novo;
   * 5. se a etapa for gatilho de passagem, executa a passagem (R5.7).
   *
   * Padrões: título = nome do contato; empresa = a do contato; valor = 0.
   * Erros de configuração saem como `RegraVioladaException` (422) e valor fora
   * do formato como `DadosInvalidosException` (400).
   */
  async criarAutomatico(
    tx: Tx,
    entrada: EntradaNegocioAutomatico,
  ): Promise<{ negocio: Negocio; criado: boolean; reconversao: boolean }> {
    const funil = await tx.funil.findFirst({
      where: { id: entrada.funilId, excluidoEm: null },
    });
    if (!funil) {
      throw new RegraVioladaException(
        'R5.1',
        'O funil de destino não existe ou foi excluído.',
        { funilId: entrada.funilId },
      );
    }
    if (!funil.ativo) {
      throw new RegraVioladaException(
        'R5.1',
        `O funil ${funil.nome} está arquivado e não recebe negócios.`,
        { funilId: funil.id },
      );
    }
    const etapa = await tx.etapa.findFirst({
      where: { id: entrada.etapaId, funilId: funil.id },
    });
    if (!etapa) {
      throw new RegraVioladaException(
        'R5.4',
        'A etapa de entrada não pertence ao funil informado.',
        { funilId: funil.id, etapaId: entrada.etapaId },
      );
    }
    const importado = entrada.importado;
    if (etapa.tipo === 'PERDIDO' && !importado?.fechado) {
      throw new RegraVioladaException(
        'R5.5',
        'Um negócio automático não entra direto na etapa de perda (ela exige motivo).',
        { etapaId: etapa.id },
      );
    }
    const contato = await this.contatoAtivo(tx, entrada.contatoId);
    const empresaId = entrada.empresaId ?? contato.empresaId ?? null;
    if (entrada.empresaId) {
      await this.empresaAtiva(tx, entrada.empresaId);
    }
    const resultado = await this.motor.criarOuReconverter(tx, {
      contatoId: contato.id,
      empresaId,
      funil,
      etapa,
      titulo: entrada.titulo?.trim() || contato.nome,
      valor: this.lerValorDaAutomacao(entrada.valor, 'valor') ?? lerValor('0'),
      valorRecorrente: this.lerValorDaAutomacao(
        entrada.valorRecorrente,
        'valorRecorrente',
      ),
      origem: entrada.origem,
      origemDetalhe: entrada.origemDetalhe?.trim() || null,
      utm: normalizarUtm(entrada.utm as Record<string, unknown> | undefined),
      estrategia: entrada.estrategia,
      responsavelFixoId: entrada.responsavelFixoId ?? null,
      negocioOrigemId: null,
      sempreCriar: entrada.sempreCriar || !!importado?.fechado,
      abertoMaisRecente: entrada.abertoMaisRecente,
      criadoEm: importado?.criadoEm,
      fechadoEm: importado?.fechado?.em,
      idExterno: importado?.idExterno ?? null,
      motivoPerda: importado?.fechado?.motivoPerda ?? null,
      detalhesDaCriacao: importado?.detalhes,
    });
    let { negocio } = resultado;
    if (importado?.idExterno && resultado.reconversao && !negocio.idExterno) {
      // A reconversão caiu num negócio aberto sem id de origem: ele passa a tê-lo (reimportar não repete).
      negocio = {
        ...negocio,
        ...(await tx.negocio.update({
          where: { id: negocio.id },
          data: { idExterno: importado.idExterno },
          select: { idExterno: true },
        })),
      };
    }
    const ator = contextoAtual().usuario?.id;
    if (
      entrada.notificar !== false &&
      negocio.responsavelId &&
      negocio.responsavelId !== ator &&
      (resultado.criado ||
        (await this.responsavelVe(tx, funil, negocio.responsavelId)))
    ) {
      await this.notificacoes.notificar(tx, negocio.responsavelId, {
        tipo: TIPOS_NOTIFICACAO.NEGOCIO_ATRIBUIDO,
        titulo: resultado.criado
          ? 'Novo lead para você'
          : `${contato.nome} voltou a converter`,
        texto: resultado.criado
          ? `${contato.nome} chegou${entrada.origemDetalhe ? ` por ${entrada.origemDetalhe}` : ''} e entrou em ${funil.nome} / ${etapa.nome}.`
          : `O negócio "${negocio.titulo}" continua aberto com você; a reconversão foi registrada.`,
        link: linkDoNegocio(negocio),
        dados: {
          negocioId: negocio.id,
          contatoId: contato.id,
          reconversao: resultado.reconversao,
        },
      });
    }
    if (resultado.criado && !importado?.fechado) {
      await this.motor.executarPassagens(tx, negocio);
    }
    return {
      negocio,
      criado: resultado.criado,
      reconversao: resultado.reconversao,
    };
  }

  /**
   * Atualiza um negócio já importado (mesmo `idExterno`, R16.14), dentro da
   * transação da linha: COMPLETAR só preenche valor, título, responsável e
   * motivo vazios; SOBRESCREVER troca esses campos e, se a etapa de destino
   * mudou, move pelo motor (histórico, auditoria e eventos), sem passagens.
   * Reabrir um negócio fechado segue a regra R5.5. `aviso` explica o que não
   * foi feito (outro funil, sem permissão para reabrir).
   */
  async atualizarImportado(
    tx: Tx,
    usuario: UsuarioAutenticado,
    negocioId: string,
    entrada: EntradaAtualizacaoImportada,
  ): Promise<{ negocio: NegocioCompleto; alterou: boolean; aviso?: string }> {
    await tx.$queryRaw`SELECT id FROM negocios WHERE id = ${negocioId}::uuid FOR UPDATE`;
    const antes = await tx.negocio.findFirst({
      where: { id: negocioId, excluidoEm: null },
      include: INCLUIR_NEGOCIO,
    });
    if (!antes) {
      throw new NaoEncontradoException('Negócio não encontrado.');
    }
    const acesso = await funisAcessiveis(tx, usuario);
    if (!acesso.podeAgirNoNegocio(antes)) {
      // R5.12: o mesmo id de origem não dá acesso a negócio de funil que a pessoa não edita.
      return {
        negocio: antes,
        alterou: false,
        aviso:
          'O negócio já importado está num funil em que você não edita negócios: não foi atualizado.',
      };
    }
    const completar = entrada.modo === 'COMPLETAR';
    const dados: Prisma.NegocioUncheckedUpdateInput = {};
    if (entrada.titulo && (completar ? !antes.titulo.trim() : true)) {
      dados.titulo = entrada.titulo;
    }
    if (entrada.valor !== undefined) {
      const valor = lerValor(entrada.valor);
      if (completar ? antes.valor.isZero() && !valor.isZero() : true) {
        dados.valor = valor;
      }
    }
    if (
      entrada.responsavelId &&
      entrada.responsavelId !== antes.responsavelId &&
      (completar ? antes.responsavelId === null : true)
    ) {
      await this.validarResponsavel(tx, entrada.responsavelId, antes.funil);
      dados.responsavelId = entrada.responsavelId;
    }
    if (
      entrada.motivoPerda &&
      antes.status === 'PERDIDO' &&
      (completar ? !antes.motivoPerda : true)
    ) {
      dados.motivoPerda = entrada.motivoPerda;
    }
    let atual: NegocioCompleto = antes;
    let alterou = false;
    if (Object.keys(dados).length > 0) {
      const depois = await tx.negocio.update({
        where: { id: antes.id },
        data: dados,
        include: INCLUIR_NEGOCIO,
      });
      const alteracoes = calcularAlteracoes(antes, depois, CAMPOS_EDITAVEIS);
      if (Object.keys(alteracoes).length > 0) {
        alterou = true;
        await this.auditoria.registrar(tx, {
          acao: 'negocio.atualizado',
          entidade: 'negocio',
          entidadeId: depois.id,
          resumo: `Negócio "${depois.titulo}" atualizado pela importação (${Object.keys(alteracoes).join(', ')})`,
          dados: { alteracoes },
          relacionados: relacionadosDoNegocio(depois),
        });
        await this.eventos.publicar(
          tx,
          'negocio.atualizado',
          dadosDoEventoDeNegocio(depois, { alteracoes }),
        );
      }
      atual = depois;
    }
    let aviso: string | undefined;
    if (!completar && entrada.etapaId !== atual.etapaId) {
      const destino = await tx.etapa.findUnique({
        where: { id: entrada.etapaId },
      });
      if (!destino || destino.funilId !== atual.funilId) {
        aviso = 'O negócio já importado está em outro funil: não foi movido.';
      } else if (
        atual.status !== 'ABERTO' &&
        !acesso.podeConfigurarFunil(atual.funilId)
      ) {
        aviso =
          'Sem permissão para reabrir o negócio já importado: não foi movido.';
      } else {
        atual = await this.motor.entrarNaEtapa(tx, atual, destino, {
          motivoPerda: entrada.motivoPerda ?? null,
          posicao: await this.motor.posicaoNoTopo(tx, destino.id, atual.id),
          fechadoEm: entrada.fechadoEm ?? null,
        });
        alterou = true;
      }
    }
    return { negocio: atual, alterou, ...(aviso ? { aviso } : {}) };
  }

  /**
   * Leva um negócio aberto para outra etapa **do mesmo funil** por uma
   * automação (o SDR com IA, R31), dentro da transação de quem chama e sem a
   * checagem de permissão de pessoa (o ator do contexto responde pela
   * auditoria). Executa as passagens cujo gatilho é a etapa de destino (R5.7).
   * Na etapa em que já está, só executa as passagens que ainda não rodaram.
   */
  async moverAutomatico(
    tx: Tx,
    negocioId: string,
    etapaId: string,
  ): Promise<{ negocio: NegocioCompleto; passagens: PassagemExecutada[] }> {
    await tx.$queryRaw`SELECT id FROM negocios WHERE id = ${negocioId}::uuid FOR UPDATE`;
    const atual = await tx.negocio.findFirst({
      where: { id: negocioId, excluidoEm: null },
      include: INCLUIR_NEGOCIO,
    });
    if (!atual) {
      throw new NaoEncontradoException('Negócio não encontrado.');
    }
    const destino = await tx.etapa.findUnique({ where: { id: etapaId } });
    if (!destino || destino.funilId !== atual.funilId) {
      throw new RegraVioladaException(
        'R5.4',
        'A etapa de destino não pertence ao funil do negócio.',
        { funilId: atual.funilId, etapaId },
      );
    }
    if (destino.tipo === 'PERDIDO') {
      throw new RegraVioladaException(
        'R5.5',
        'Uma automação não leva o negócio direto para a etapa de perda (ela exige motivo).',
        { etapaId },
      );
    }
    if (destino.id === atual.etapaId) {
      return {
        negocio: atual,
        passagens: await this.motor.executarPassagens(tx, atual),
      };
    }
    const posicao = await this.motor.posicaoNoTopo(tx, destino.id, atual.id);
    const movido = await this.motor.entrarNaEtapa(tx, atual, destino, {
      motivoPerda: null,
      posicao,
    });
    return {
      negocio: movido,
      passagens: await this.motor.executarPassagens(tx, movido),
    };
  }

  // -------------------------------------------------------------------------
  // Apoio
  // -------------------------------------------------------------------------

  /**
   * O negócio, se existir, não estiver excluído e o usuário puder vê-lo
   * (R5.9) — senão 404 —, com os níveis da pessoa. Com `travar`, a linha fica
   * presa até o fim da transação: movimentações simultâneas do mesmo negócio
   * entram em fila.
   */
  private async carregarVisivel(
    tx: Tx,
    usuario: UsuarioAutenticado,
    id: string,
    travar = false,
  ): Promise<{ negocio: NegocioCompleto; acesso: AcessoAosFunis }> {
    if (travar) {
      await tx.$queryRaw`SELECT id FROM negocios WHERE id = ${id}::uuid FOR UPDATE`;
    }
    const negocio = await tx.negocio.findFirst({
      where: { id, excluidoEm: null },
      include: INCLUIR_NEGOCIO,
    });
    const acesso = await funisAcessiveis(tx, usuario);
    if (!negocio || !acesso.podeVerNegocio(negocio)) {
      throw new NaoEncontradoException('Negócio não encontrado.');
    }
    return { negocio, acesso };
  }

  /** `carregarVisivel` travado, exigindo que a pessoa possa agir no negócio (R5.12). */
  private async carregarParaAgir(
    tx: Tx,
    usuario: UsuarioAutenticado,
    id: string,
  ): Promise<NegocioCompleto> {
    const { negocio, acesso } = await this.carregarVisivel(
      tx,
      usuario,
      id,
      true,
    );
    this.exigirAcao(acesso, negocio);
    return negocio;
  }

  /**
   * R5.12: quem só vê o funil (`VER`) não cria, edita, move, assume, ganha nem
   * perde; o `MEMBRO` que vê todos age só nos seus e nos sem responsável.
   */
  private exigirAcao(acesso: AcessoAosFunis, negocio: NegocioParaAcesso): void {
    if (!acesso.podeAgirNoNegocio(negocio)) {
      throw new SemPermissaoException(
        acesso.nivel(negocio.funilId) === 'MEMBRO'
          ? 'Você só pode ver este negócio: neste funil você edita e move só os seus e os sem responsável.'
          : 'Você só pode ver os negócios deste funil: não pode editar, mover nem assumir.',
        { regra: 'R5.12' },
      );
    }
  }

  private async reposicionar(
    tx: Tx,
    atual: NegocioCompleto,
    dto: MoverNegocioDto,
  ): Promise<NegocioCompleto> {
    if (!dto.depoisDeId && !dto.antesDeId) {
      return atual;
    }
    const posicao = await this.motor.posicaoEntreVizinhos(
      tx,
      atual.etapaId,
      atual.id,
      dto.depoisDeId,
      dto.antesDeId,
    );
    const negocio = await tx.negocio.update({
      where: { id: atual.id },
      data: { posicao },
      include: INCLUIR_NEGOCIO,
    });
    await this.auditoria.registrar(tx, {
      acao: 'negocio.reposicionado',
      entidade: 'negocio',
      entidadeId: negocio.id,
      resumo: `Negócio "${negocio.titulo}" reposicionado em ${negocio.etapa.nome}`,
      dados: {
        alteracoes: { posicao: { antes: atual.posicao, depois: posicao } },
      },
      relacionados: relacionadosDoNegocio(negocio),
    });
    return negocio;
  }

  /** A etapa aberta de onde o negócio saiu ao fechar; sem ela, a primeira aberta. */
  private async etapaParaReabrir(
    tx: Tx,
    atual: NegocioCompleto,
  ): Promise<Etapa> {
    const fechamento = await tx.negocioMovimentacao.findFirst({
      where: { negocioId: atual.id, paraEtapaId: atual.etapaId },
      orderBy: { criadoEm: 'desc' },
      include: { deEtapa: true },
    });
    const anterior = fechamento?.deEtapa;
    if (
      anterior &&
      anterior.tipo === 'ABERTA' &&
      anterior.funilId === atual.funilId
    ) {
      return anterior;
    }
    return this.primeiraEtapaAberta(tx, atual.funilId);
  }

  /** O funil, se a pessoa o vê (senão 404) e cria nele (`MEMBRO` ou mais, senão 403 — R5.12). */
  private async funilParaCriar(
    tx: Tx,
    usuario: UsuarioAutenticado,
    funilId: string,
  ): Promise<Funil> {
    const funil = await tx.funil.findFirst({
      where: { id: funilId, excluidoEm: null },
    });
    const acesso = await funisAcessiveis(tx, usuario);
    if (!funil || !acesso.podeVerFunil(funil.id)) {
      throw new NaoEncontradoException('Funil não encontrado.');
    }
    if (!acesso.podeCriarNoFunil(funil.id)) {
      throw new SemPermissaoException(
        `Você só pode ver os negócios do funil ${funil.nome}: não pode criar negócios nele.`,
        { regra: 'R5.12', funilId: funil.id },
      );
    }
    return funil;
  }

  private async etapaDoFunil(
    tx: Tx,
    funil: Funil,
    etapaId: string,
  ): Promise<Etapa> {
    const etapa = await tx.etapa.findUnique({ where: { id: etapaId } });
    if (!etapa || etapa.funilId !== funil.id) {
      throw new RegraVioladaException(
        'R5.4',
        `A etapa informada não é do funil ${funil.nome}.`,
        { funilId: funil.id, etapaId },
      );
    }
    return etapa;
  }

  private async primeiraEtapaAberta(tx: Tx, funilId: string): Promise<Etapa> {
    const etapa = await tx.etapa.findFirst({
      where: { funilId, tipo: 'ABERTA' },
      orderBy: [{ ordem: 'asc' }, { criadoEm: 'asc' }],
    });
    if (!etapa) {
      // R5.2 garante ao menos uma aberta; só um banco mexido à mão cai aqui.
      throw new RegraVioladaException('R5.2', 'O funil não tem etapa aberta.', {
        funilId,
      });
    }
    return etapa;
  }

  private async contatoAtivo(tx: Tx, contatoId: string) {
    const contato = await tx.contato.findFirst({
      where: { id: contatoId, excluidoEm: null },
      select: { id: true, nome: true, empresaId: true },
    });
    if (!contato) {
      throw new RegraVioladaException(
        'R5.3',
        'O contato informado não existe ou foi excluído.',
        { contatoId },
      );
    }
    return contato;
  }

  private async empresaAtiva(tx: Tx, empresaId: string): Promise<void> {
    const empresa = await tx.empresa.findFirst({
      where: { id: empresaId, excluidoEm: null },
      select: { id: true },
    });
    if (!empresa) {
      throw new RegraVioladaException(
        'R5.3',
        'A empresa informada não existe ou foi excluída.',
        { empresaId },
      );
    }
  }

  /**
   * Responsável (R5.3, R5.13): usuário ativo que age no funil — do setor dono
   * (no `RESTRITA`, os líderes e quem está na lista), com acesso `MEMBRO` ou
   * `GESTOR`, C-level ou Admin.
   */
  private async validarResponsavel(
    tx: Tx,
    responsavelId: string,
    funil: FunilParaAcesso,
  ): Promise<void> {
    const responsavel = await tx.usuario.findUnique({
      where: { id: responsavelId },
      select: { id: true, ativo: true, papel: true, area: true },
    });
    if (!responsavel || !responsavel.ativo) {
      throw new RegraVioladaException(
        'R5.3',
        'O responsável precisa ser um usuário ativo.',
        { responsavelId },
      );
    }
    if (!(await podeSerResponsavelNoFunil(tx, funil, responsavel))) {
      throw new RegraVioladaException(
        'R5.13',
        'O responsável precisa atuar no funil: ser do setor dono (no funil restrito, líder ou da lista) ou ter acesso como membro ou gestor.',
        { responsavelId, area: funil.area, funilId: funil.id },
      );
    }
  }

  /**
   * R5.9: o responsável ainda vê o funil? (Na reconversão, o dono pode ter
   * perdido o acesso — ex.: o funil ficou restrito —, e não é avisado.)
   */
  private async responsavelVe(
    tx: Tx,
    funil: FunilParaAcesso,
    responsavelId: string,
  ): Promise<boolean> {
    const pessoa = await tx.usuario.findUnique({
      where: { id: responsavelId },
      select: { id: true, papel: true, area: true },
    });
    return (
      !!pessoa && (await acessosDoFunil(tx, funil)).nivelDe(pessoa) !== null
    );
  }

  private async notificarAtribuicao(
    tx: Tx,
    negocio: NegocioCompleto,
    quem: string,
  ): Promise<void> {
    if (!negocio.responsavelId) {
      return;
    }
    await this.notificacoes.notificar(tx, negocio.responsavelId, {
      tipo: TIPOS_NOTIFICACAO.NEGOCIO_ATRIBUIDO,
      titulo: 'Negócio atribuído a você',
      texto: `${quem} deixou "${negocio.titulo}" (${negocio.funil.nome} / ${negocio.etapa.nome}) com você.`,
      link: linkDoNegocio(negocio),
      dados: { negocioId: negocio.id },
    });
  }

  private semPermissaoParaReabrir(): SemPermissaoException {
    return new SemPermissaoException(
      'Só o líder do setor do funil, o C-level e o Admin reabrem negócio ganho ou perdido.',
      { regra: 'R5.5' },
    );
  }

  private lerValorDaAutomacao(
    valor: string | undefined,
    campo: string,
  ): Prisma.Decimal | null {
    if (valor === undefined || valor === null || valor.trim() === '') {
      return null;
    }
    try {
      return lerValor(valor.trim());
    } catch {
      throw new DadosInvalidosException(
        `Valor inválido em ${campo}: use reais com até 2 casas, com ponto (ex.: 1500.00).`,
        {
          campos: [
            {
              campo,
              mensagens: ['deve ser um valor em reais com até 2 casas'],
            },
          ],
        },
      );
    }
  }
}
