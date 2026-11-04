import { Injectable } from '@nestjs/common';
import { AuditoriaService } from '../auditoria/auditoria.service';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import { contextoAtual } from '../comum/contexto/contexto-requisicao';
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
  Area,
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
import {
  podeExcluirNegocio,
  podeReabrirNegocio,
  podeSerResponsavelNaArea,
  podeVerArea,
  podeVerNegocio,
} from './acesso-funis';
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
 * Visibilidade (R5.9): Admin e C-level veem todos; o líder, os da sua área; o
 * membro, os da sua área em que é responsável e os sem responsável. Quem vê
 * pode editar e mover, menos reabrir (R5.5). Negócio que a pessoa não vê
 * responde 404.
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
    const negocio = await this.carregarVisivel(this.prisma, usuario, id);
    const LIGADO = {
      id: true,
      responsavelId: true,
      funil: { select: { area: true } },
    } satisfies Prisma.NegocioSelect;
    const origem = negocio.negocioOrigemId
      ? await this.prisma.negocio.findFirst({
          where: { id: negocio.negocioOrigemId, excluidoEm: null },
          select: LIGADO,
        })
      : null;
    const gerados = await this.prisma.negocio.findMany({
      where: { negocioOrigemId: negocio.id, excluidoEm: null },
      orderBy: [{ criadoEm: 'asc' }, { id: 'asc' }],
      select: LIGADO,
    });
    const daJornada = (
      ligado: Prisma.NegocioGetPayload<{ select: typeof LIGADO }>,
    ): NegocioDaJornadaDto => ({
      id: ligado.id,
      area: ligado.funil.area,
      visivel: podeVerNegocio(usuario, ligado),
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
      const funil = await this.funilVisivel(tx, usuario, dto.funilId);
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
        await this.validarResponsavel(tx, responsavelId, funil.area);
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
      const antes = await this.carregarVisivel(tx, usuario, id, true);
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
          await this.validarResponsavel(
            tx,
            dto.responsavelId,
            antes.funil.area,
          );
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
        const atual = await this.carregarVisivel(tx, usuario, id, true);
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
          !podeReabrirNegocio(usuario, atual.funil.area)
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
        const atual = await this.carregarVisivel(tx, usuario, id, true);
        if (atual.status === 'ABERTO') {
          throw new ConflitoException('O negócio já está aberto.');
        }
        if (!podeReabrirNegocio(usuario, atual.funil.area)) {
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

  /** R5.9: o membro assume um negócio da sua área ainda sem responsável. */
  async assumir(usuario: UsuarioAutenticado, id: string): Promise<NegocioDto> {
    const negocio = await this.prisma.$transaction(async (tx) => {
      const atual = await this.carregarVisivel(tx, usuario, id, true);
      if (atual.responsavelId === usuario.id) {
        return atual;
      }
      if (atual.responsavelId !== null) {
        throw new ConflitoException(
          'O negócio já tem responsável. Peça ao líder para transferir.',
          { responsavelId: atual.responsavelId },
        );
      }
      if (!podeSerResponsavelNaArea(usuario.papel, atual.funil.area)) {
        throw new RegraVioladaException(
          'R5.9',
          'Só quem é da área do funil (ou C-level/Admin) assume o negócio.',
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
      const atual = await this.carregarVisivel(tx, usuario, id, true);
      if (!podeExcluirNegocio(usuario, atual.funil.area)) {
        throw new SemPermissaoException(
          'Só o líder da área, o C-level e o Admin excluem negócios.',
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
    if (etapa.tipo === 'PERDIDO') {
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
      sempreCriar: entrada.sempreCriar,
      abertoMaisRecente: entrada.abertoMaisRecente,
    });
    const { negocio } = resultado;
    const ator = contextoAtual().usuario?.id;
    if (negocio.responsavelId && negocio.responsavelId !== ator) {
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
    if (resultado.criado) {
      await this.motor.executarPassagens(tx, negocio);
    }
    return {
      negocio,
      criado: resultado.criado,
      reconversao: resultado.reconversao,
    };
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
   * (R5.9) — senão 404. Com `travar`, a linha fica presa até o fim da
   * transação: movimentações simultâneas do mesmo negócio entram em fila.
   */
  private async carregarVisivel(
    tx: Tx,
    usuario: UsuarioAutenticado,
    id: string,
    travar = false,
  ): Promise<NegocioCompleto> {
    if (travar) {
      await tx.$queryRaw`SELECT id FROM negocios WHERE id = ${id}::uuid FOR UPDATE`;
    }
    const negocio = await tx.negocio.findFirst({
      where: { id, excluidoEm: null },
      include: INCLUIR_NEGOCIO,
    });
    if (!negocio || !podeVerNegocio(usuario, negocio)) {
      throw new NaoEncontradoException('Negócio não encontrado.');
    }
    return negocio;
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

  private async funilVisivel(
    tx: Tx,
    usuario: UsuarioAutenticado,
    funilId: string,
  ): Promise<Funil> {
    const funil = await tx.funil.findFirst({
      where: { id: funilId, excluidoEm: null },
    });
    if (!funil || !podeVerArea(usuario, funil.area)) {
      throw new NaoEncontradoException('Funil não encontrado.');
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

  /** Responsável: usuário ativo que vê o funil (R5.3, R5.9). */
  private async validarResponsavel(
    tx: Tx,
    responsavelId: string,
    area: Area,
  ): Promise<void> {
    const responsavel = await tx.usuario.findUnique({
      where: { id: responsavelId },
      select: { id: true, ativo: true, papel: true },
    });
    if (!responsavel || !responsavel.ativo) {
      throw new RegraVioladaException(
        'R5.3',
        'O responsável precisa ser um usuário ativo.',
        { responsavelId },
      );
    }
    if (!podeSerResponsavelNaArea(responsavel.papel, area)) {
      throw new RegraVioladaException(
        'R5.9',
        'O responsável precisa ser da área do funil (ou C-level/Admin): quem é de outra área não vê o negócio.',
        { responsavelId, area },
      );
    }
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
      'Só o líder da área, o C-level e o Admin reabrem negócio ganho ou perdido.',
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
