import { Injectable } from '@nestjs/common';
import { AuditoriaService } from '../auditoria/auditoria.service';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import {
  NaoEncontradoException,
  RegraVioladaException,
  ServicoIndisponivelException,
} from '../comum/erros/excecoes';
import { funisAcessiveis } from '../funis/acessos-no-banco';
import { veNegocio } from '../funis/negocios-visiveis';
import type { Ligacao, TrescPlusVinculo } from '../generated/prisma/client';
import { INCLUIR_LIGACAO, paraLigacaoDto } from '../ligacoes/ligacao-dto';
import type { LigacaoDto } from '../ligacoes/ligacoes.dto';
import { PrismaService } from '../prisma/prisma.service';
import {
  ClienteTrescPlus,
  comoObjeto,
  desembrulhar,
  listaDe,
  numeroDe,
  textoDe,
} from './cliente-tresc-plus';
import { ConexaoTrescPlusService } from './conexao.service';
import { traduzindo } from './erros-tresc-plus';
import {
  descricaoDaAtividade,
  LigacoesTrescService,
  cargaDaLigacao,
} from './ligacoes-tresc.service';
import { REGRA_TRESC_PLUS } from './tresc-plus.constantes';
import type {
  CampanhaTrescDto,
  EntrarNaCampanhaDto,
  EstadoDoAgenteDto,
  LigarTrescDto,
  PausaTrescDto,
  QualificacaoTrescDto,
  QualificarLigacaoDto,
} from './tresc-plus.dto';
import { somenteDigitos, telefoneDoTresc, telefoneParaTresc } from './telefone';
import { VinculosTrescPlusService } from './vinculos.service';
import { salas } from '../tempo-real/catalogo';
import { TempoRealService } from '../tempo-real/tempo-real.service';

/** `YYYY-MM-DD HH:mm:ss` no fuso de São Paulo (o formato do agendamento do 3C+). */
export function dataParaTresc(data: Date): string {
  const partes = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(data);
  return partes.replace('T', ' ');
}

/** Qualificações de uma campanha a partir de `GET /campaigns/{id}` (lacuna: não há rota de catálogo). */
export function qualificacoesDaCampanha(corpo: unknown): Array<{
  id: number;
  nome: string;
  cor: string | null;
  conversao: boolean | null;
  permiteAgendar: boolean;
}> {
  const campanha = comoObjeto(desembrulhar(corpo));
  const lista = campanha
    ? (campanha.qualifications ??
      campanha.qualification_list ??
      campanha.qualificacoes)
    : null;
  if (!Array.isArray(lista)) return [];
  return lista.flatMap((item) => {
    const o = comoObjeto(item);
    if (o) {
      const id = numeroDe(o.id);
      if (id === null) return [];
      return [
        {
          id,
          nome: textoDe(o.name) ?? `Qualificação ${id}`,
          cor: textoDe(o.color),
          conversao: typeof o.conversion === 'boolean' ? o.conversion : null,
          permiteAgendar: o.allow_schedule === true,
        },
      ];
    }
    const id = numeroDe(item);
    return id === null
      ? []
      : [
          {
            id,
            nome: `Qualificação ${id}`,
            cor: null,
            conversao: null,
            permiteAgendar: false,
          },
        ];
  });
}

/**
 * Agente e ligação (R34.5): entrar e sair da campanha, pausas, estado, ligar, desligar, listar as
 * qualificações e qualificar. Cada ação usa o token do próprio vendedor; os erros do 3C+ viram
 * mensagens claras em português. O estado do agente vem dos eventos do socket (`agent-*`) e é
 * atualizado de forma otimista pelas ações.
 */
@Injectable()
export class AgenteTrescPlusService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditoria: AuditoriaService,
    private readonly conexao: ConexaoTrescPlusService,
    private readonly vinculos: VinculosTrescPlusService,
    private readonly ligacoes: LigacoesTrescService,
    private readonly tempoReal: TempoRealService,
  ) {}

  // -------------------------------------------------------------------------
  // Estado
  // -------------------------------------------------------------------------

  async estado(
    usuario: UsuarioAutenticado,
    atualizar = false,
  ): Promise<EstadoDoAgenteDto> {
    let vinculo = await this.vinculos.doUsuario(usuario.id);
    const config = await this.conexao.ler();
    const campanhaPadrao =
      config.campanhaPadraoId !== null
        ? { id: config.campanhaPadraoId, nome: config.campanhaPadraoNome }
        : null;
    if (!vinculo) {
      return {
        vinculado: false,
        estado: 'desconectado',
        desde: null,
        campanha: null,
        modo: null,
        pausa: null,
        ligacaoId: null,
        campanhaPadrao,
      };
    }
    if (atualizar) vinculo = await this.sincronizar(vinculo);
    const ligacao = await this.prisma.ligacao.findFirst({
      where: {
        provedor: 'TRESC_PLUS',
        atendenteId: usuario.id,
        OR: [
          { estado: { in: ['CHAMANDO', 'TOCANDO', 'EM_ANDAMENTO'] } },
          {
            atendidaEm: { not: null },
            qualificadaEm: null,
            iniciadaEm: { gte: new Date(Date.now() - 30 * 60_000) },
          },
        ],
      },
      orderBy: { iniciadaEm: 'desc' },
      select: { id: true },
    });
    return {
      vinculado: true,
      estado: vinculo.estado,
      desde: vinculo.estadoDesde.toISOString(),
      campanha:
        vinculo.campanhaId !== null
          ? { id: vinculo.campanhaId, nome: vinculo.campanhaNome }
          : null,
      modo: vinculo.modo,
      pausa:
        vinculo.pausaId !== null
          ? { id: vinculo.pausaId, nome: vinculo.pausaNome }
          : null,
      ligacaoId: ligacao?.id ?? null,
      campanhaPadrao,
    };
  }

  /** Confere no 3C+ em que campanha o agente está (`GET /agent/loggedCampaign`). */
  private async sincronizar(
    vinculo: TrescPlusVinculo,
  ): Promise<TrescPlusVinculo> {
    try {
      const corpo = comoObjeto(
        desembrulhar(
          await (await this.vinculos.clienteDo(vinculo)).campanhaAtual(),
        ),
      );
      const id = corpo ? numeroDe(corpo.id) : null;
      if (id === null && vinculo.campanhaId !== null) {
        return await this.atualizarVinculo(vinculo, {
          estado: 'desconectado',
          campanhaId: null,
          campanhaNome: null,
          modo: null,
          pausaId: null,
          pausaNome: null,
        });
      }
      if (id !== null && id !== vinculo.campanhaId && corpo) {
        return await this.atualizarVinculo(vinculo, {
          campanhaId: id,
          campanhaNome: textoDe(corpo.name),
          ...(vinculo.estado === 'desconectado' ? { estado: 'ocioso' } : {}),
        });
      }
    } catch {
      // Sem resposta do 3C+: fica o que o CRM sabe.
    }
    return vinculo;
  }

  private async atualizarVinculo(
    vinculo: TrescPlusVinculo,
    dados: Partial<
      Pick<
        TrescPlusVinculo,
        | 'estado'
        | 'campanhaId'
        | 'campanhaNome'
        | 'modo'
        | 'pausaId'
        | 'pausaNome'
      >
    >,
  ): Promise<TrescPlusVinculo> {
    const atualizado = await this.prisma.trescPlusVinculo.update({
      where: { id: vinculo.id },
      data: {
        ...dados,
        ...(dados.estado && dados.estado !== vinculo.estado
          ? { estadoDesde: new Date() }
          : {}),
      },
    });
    this.ligacoes.emitirAgente(atualizado);
    return atualizado;
  }

  // -------------------------------------------------------------------------
  // Campanha e pausas
  // -------------------------------------------------------------------------

  async campanhas(usuario: UsuarioAutenticado): Promise<CampanhaTrescDto[]> {
    const vinculo = await this.vinculos.exigir(usuario.id);
    const corpo = await traduzindo(async () =>
      (await this.vinculos.clienteDo(vinculo)).campanhasDoAgente(),
    );
    return listaDe(corpo).flatMap((item) => {
      const c = comoObjeto(item);
      const id = c ? numeroDe(c.id) : null;
      if (!c || id === null) return [];
      return [
        {
          id,
          nome: textoDe(c.name) ?? `Campanha ${id}`,
          pausada: typeof c.paused === 'boolean' ? c.paused : null,
        },
      ];
    });
  }

  async entrar(
    usuario: UsuarioAutenticado,
    dto: EntrarNaCampanhaDto,
  ): Promise<EstadoDoAgenteDto> {
    const vinculo = await this.vinculos.exigir(usuario.id);
    const config = await this.conexao.ler();
    const campanhaId = dto.campanhaId ?? config.campanhaPadraoId;
    if (campanhaId === null || campanhaId === undefined) {
      throw new RegraVioladaException(
        REGRA_TRESC_PLUS,
        'Escolha uma campanha do 3C+ para entrar (ou peça ao Admin para definir a campanha padrão).',
        { motivo: 'sem_campanha' },
      );
    }
    const modo = dto.modo ?? 'manual';
    const cliente = await this.vinculos.clienteDo(vinculo);
    await traduzindo(() => cliente.entrarNaCampanha(campanhaId, modo));
    const nome =
      campanhaId === config.campanhaPadraoId
        ? config.campanhaPadraoNome
        : await this.nomeDaCampanha(cliente, campanhaId);
    await this.atualizarVinculo(vinculo, {
      estado: modo === 'manual' ? 'manual' : 'ocioso',
      campanhaId,
      campanhaNome: nome,
      modo,
      pausaId: null,
      pausaNome: null,
    });
    await this.auditar(
      usuario,
      'tresc-plus.agente-entrou',
      `${usuario.nome} entrou na campanha ${nome ?? campanhaId} do 3C+`,
      { campanhaId, modo },
    );
    return this.estado(usuario);
  }

  private async nomeDaCampanha(
    cliente: ClienteTrescPlus,
    id: number,
  ): Promise<string | null> {
    try {
      return textoDe(
        comoObjeto(desembrulhar(await cliente.campanha(id)))?.name,
      );
    } catch {
      return null;
    }
  }

  async sair(usuario: UsuarioAutenticado): Promise<EstadoDoAgenteDto> {
    const vinculo = await this.vinculos.exigir(usuario.id);
    await traduzindo(async () =>
      (await this.vinculos.clienteDo(vinculo)).sairDaCampanha(),
    );
    await this.atualizarVinculo(vinculo, {
      estado: 'desconectado',
      campanhaId: null,
      campanhaNome: null,
      modo: null,
      pausaId: null,
      pausaNome: null,
    });
    await this.auditar(
      usuario,
      'tresc-plus.agente-saiu',
      `${usuario.nome} saiu da campanha do 3C+`,
      {},
    );
    return this.estado(usuario);
  }

  async pausas(usuario: UsuarioAutenticado): Promise<PausaTrescDto[]> {
    const vinculo = await this.vinculos.exigir(usuario.id);
    const corpo = await traduzindo(async () =>
      (await this.vinculos.clienteDo(vinculo)).pausas(),
    );
    return listaDe(corpo).flatMap((item) => {
      const p = comoObjeto(item);
      const id = p ? numeroDe(p.id) : null;
      if (!p || id === null) return [];
      return [
        {
          id,
          nome: textoDe(p.name) ?? `Pausa ${id}`,
          minutos: numeroDe(p.minutes),
          cor: textoDe(p.color),
        },
      ];
    });
  }

  async entrarEmPausa(
    usuario: UsuarioAutenticado,
    intervaloId: number,
  ): Promise<EstadoDoAgenteDto> {
    const vinculo = await this.vinculos.exigir(usuario.id);
    const cliente = await this.vinculos.clienteDo(vinculo);
    const lista = await this.pausas(usuario);
    const pausa = lista.find((p) => p.id === intervaloId);
    await traduzindo(() => cliente.entrarEmPausa(intervaloId));
    await this.atualizarVinculo(vinculo, {
      estado: 'pausa',
      pausaId: intervaloId,
      pausaNome: pausa?.nome ?? null,
    });
    return this.estado(usuario);
  }

  async sairDaPausa(usuario: UsuarioAutenticado): Promise<EstadoDoAgenteDto> {
    const vinculo = await this.vinculos.exigir(usuario.id);
    await traduzindo(async () =>
      (await this.vinculos.clienteDo(vinculo)).sairDaPausa(),
    );
    await this.atualizarVinculo(vinculo, {
      estado: vinculo.modo === 'manual' ? 'manual' : 'ocioso',
      pausaId: null,
      pausaNome: null,
    });
    return this.estado(usuario);
  }

  // -------------------------------------------------------------------------
  // Ligar, desligar, qualificar
  // -------------------------------------------------------------------------

  async ligar(
    usuario: UsuarioAutenticado,
    dto: LigarTrescDto,
  ): Promise<LigacaoDto> {
    const vinculo = await this.vinculos.exigir(usuario.id);
    if (!dto.contatoId && !dto.negocioId) {
      throw new RegraVioladaException(
        REGRA_TRESC_PLUS,
        'Informe o contato ou o negócio a ligar.',
        { motivo: 'sem_destino' },
      );
    }
    let contatoId = dto.contatoId ?? null;
    let negocioId: string | null = null;
    if (dto.negocioId) {
      const negocio = await this.prisma.negocio.findFirst({
        where: { id: dto.negocioId, excluidoEm: null },
        select: {
          id: true,
          titulo: true,
          funilId: true,
          etapaId: true,
          responsavelId: true,
          contatoId: true,
          empresaId: true,
        },
      });
      const acesso = await funisAcessiveis(this.prisma, usuario);
      if (!negocio || !acesso.podeVerNegocio(negocio)) {
        throw new NaoEncontradoException('Negócio não encontrado.');
      }
      if (contatoId && contatoId !== negocio.contatoId) {
        throw new RegraVioladaException(
          REGRA_TRESC_PLUS,
          'O negócio não pertence a este contato.',
          { motivo: 'negocio_de_outro_contato' },
        );
      }
      negocioId = negocio.id;
      contatoId = negocio.contatoId;
    }
    const contato = await this.prisma.contato.findFirst({
      where: { id: contatoId ?? undefined, excluidoEm: null },
      select: { id: true, nome: true, telefone: true },
    });
    if (!contato) throw new NaoEncontradoException('Contato não encontrado.');
    const numero = dto.telefone ?? contato.telefone;
    const discagem = telefoneParaTresc(numero);
    if (!numero || discagem === null) {
      throw new RegraVioladaException(
        REGRA_TRESC_PLUS,
        dto.telefone
          ? 'O telefone informado é inválido para discagem.'
          : 'Este contato não tem telefone cadastrado.',
        { motivo: 'sem_telefone' },
      );
    }
    if (!negocioId) {
      // Sem negócio informado: o mais recente aberto do contato (como no receptivo).
      // R5.9: só entre os negócios que o vendedor vê.
      const encontrado = await this.ligacoes.resolverContato(
        this.prisma,
        { telefone: null, identifier: null, contatoId: contato.id },
        usuario,
      );
      negocioId = encontrado?.negocioId ?? null;
    }
    const config = await this.conexao.ler();
    const cliente = await this.vinculos.clienteDo(vinculo);
    const campanha = await this.garantirModoManual(
      vinculo,
      cliente,
      config.campanhaPadraoId,
      config.campanhaPadraoNome,
    );
    const resposta = await traduzindo(() => cliente.discar(discagem));
    const manual = comoObjeto(desembrulhar(resposta));
    const idExterno =
      textoDe(comoObjeto(manual?.call)?.id) ?? textoDe(manual?.id);
    if (!idExterno) {
      throw new ServicoIndisponivelException(
        'O 3C+ aceitou o pedido, mas não informou a ligação. Confira no painel do 3C+.',
        { regra: REGRA_TRESC_PLUS },
      );
    }
    const ligacao = await this.ligacoes.registrarFeita({
      idExterno,
      usuarioId: usuario.id,
      contatoId: contato.id,
      negocioId,
      telefone: telefoneDoTresc(numero) ?? somenteDigitos(numero),
      campanhaId: campanha.id,
      campanhaNome: campanha.nome,
    });
    return this.dto(ligacao.id, usuario);
  }

  /** Entra na campanha (padrão da empresa) e no modo manual, se o agente ainda não está. */
  private async garantirModoManual(
    vinculo: TrescPlusVinculo,
    cliente: ClienteTrescPlus,
    campanhaPadraoId: number | null,
    campanhaPadraoNome: string | null,
  ): Promise<{ id: number | null; nome: string | null }> {
    if (vinculo.campanhaId !== null && vinculo.modo === 'manual') {
      return { id: vinculo.campanhaId, nome: vinculo.campanhaNome };
    }
    if (vinculo.campanhaId === null) {
      if (campanhaPadraoId === null) {
        throw new RegraVioladaException(
          REGRA_TRESC_PLUS,
          'Entre em uma campanha do 3C+ antes de ligar (ou peça ao Admin para definir a campanha padrão).',
          { motivo: 'sem_campanha' },
        );
      }
      await traduzindo(() =>
        cliente.entrarNaCampanha(campanhaPadraoId, 'manual'),
      );
      // Alguns fluxos do 3C+ exigem `manual_call/enter` mesmo depois do login manual: tolera "já está".
      await cliente.entrarNoModoManual().catch(() => undefined);
      await this.atualizarVinculo(vinculo, {
        estado: 'manual',
        campanhaId: campanhaPadraoId,
        campanhaNome: campanhaPadraoNome,
        modo: 'manual',
      });
      return { id: campanhaPadraoId, nome: campanhaPadraoNome };
    }
    await traduzindo(() => cliente.entrarNoModoManual());
    await this.atualizarVinculo(vinculo, { estado: 'manual', modo: 'manual' });
    return { id: vinculo.campanhaId, nome: vinculo.campanhaNome };
  }

  private async daqueleVendedor(
    usuario: UsuarioAutenticado,
    id: string,
  ): Promise<Ligacao> {
    const ligacao = await this.prisma.ligacao.findFirst({
      where: { id, provedor: 'TRESC_PLUS', atendenteId: usuario.id },
    });
    if (!ligacao || !ligacao.idExterno) {
      throw new NaoEncontradoException('Ligação não encontrada.');
    }
    return ligacao;
  }

  async desligar(usuario: UsuarioAutenticado, id: string): Promise<LigacaoDto> {
    const vinculo = await this.vinculos.exigir(usuario.id);
    const ligacao = await this.daqueleVendedor(usuario, id);
    if (
      ['ENCERRADA', 'PERDIDA', 'RECUSADA', 'SEM_RESPOSTA', 'FALHOU'].includes(
        ligacao.estado,
      )
    ) {
      throw new RegraVioladaException(
        REGRA_TRESC_PLUS,
        'Esta ligação já terminou.',
        { motivo: 'ligacao_encerrada' },
      );
    }
    await traduzindo(async () =>
      (await this.vinculos.clienteDo(vinculo)).desligar(
        ligacao.idExterno ?? '',
      ),
    );
    await this.auditar(
      usuario,
      'tresc-plus.desligou',
      `${usuario.nome} desligou a ligação do 3C+`,
      { ligacaoId: id },
    );
    return this.dto(id, usuario);
  }

  async qualificacoes(
    usuario: UsuarioAutenticado,
    ligacaoId: string | null,
    campanhaId?: number,
  ): Promise<QualificacaoTrescDto[]> {
    const vinculo = await this.vinculos.exigir(usuario.id);
    let campanha = campanhaId ?? null;
    if (campanha === null && ligacaoId) {
      campanha = (await this.daqueleVendedor(usuario, ligacaoId)).campanhaId;
    }
    campanha ??=
      vinculo.campanhaId ?? (await this.conexao.ler()).campanhaPadraoId;
    if (campanha === null) {
      throw new RegraVioladaException(
        REGRA_TRESC_PLUS,
        'Informe a campanha para listar as qualificações.',
        { motivo: 'sem_campanha' },
      );
    }
    const cliente = await this.vinculos.clienteDo(vinculo);
    const corpo = await traduzindo(() => cliente.campanha(campanha));
    let lista = qualificacoesDaCampanha(corpo);
    if (
      lista.length > 0 &&
      lista.every((q) => q.nome.startsWith('Qualificação '))
    ) {
      // Só ids na campanha: tenta o catálogo do 3C+ para os nomes (lacuna da referência §11.3).
      try {
        const catalogo = qualificacoesDaCampanha({
          qualifications: listaDe(await cliente.qualificacoes()),
        });
        const porId = new Map(catalogo.map((q) => [q.id, q]));
        lista = lista.map((q) => porId.get(q.id) ?? q);
      } catch {
        // fica com os ids
      }
    }
    return lista;
  }

  async qualificar(
    usuario: UsuarioAutenticado,
    id: string,
    dto: QualificarLigacaoDto,
  ): Promise<LigacaoDto> {
    const vinculo = await this.vinculos.exigir(usuario.id);
    const ligacao = await this.daqueleVendedor(usuario, id);
    const catalogo = await this.qualificacoes(usuario, id);
    const escolhida = catalogo.find((q) => q.id === dto.qualificacaoId);
    if (!escolhida && catalogo.length > 0) {
      throw new RegraVioladaException(
        REGRA_TRESC_PLUS,
        'Essa qualificação não existe na campanha desta ligação.',
        { motivo: 'qualificacao_invalida' },
      );
    }
    if (dto.agendarPara && escolhida && !escolhida.permiteAgendar) {
      throw new RegraVioladaException(
        REGRA_TRESC_PLUS,
        'Essa qualificação não permite agendar um retorno.',
        { motivo: 'sem_agendamento' },
      );
    }
    const telefoneAgenda = dto.agendarPara
      ? (telefoneParaTresc(dto.telefoneDoAgendamento ?? ligacao.telefone) ??
        undefined)
      : undefined;
    await traduzindo(async () =>
      (await this.vinculos.clienteDo(vinculo)).qualificar(
        ligacao.idExterno ?? '',
        {
          qualificacaoId: dto.qualificacaoId,
          observacao: dto.observacao,
          telefone: telefoneAgenda,
          data: dto.agendarPara
            ? dataParaTresc(new Date(dto.agendarPara))
            : undefined,
        },
      ),
    );
    const atualizada = await this.prisma.$transaction(async (tx) => {
      const gravada = await tx.ligacao.update({
        where: { id },
        data: {
          qualificacaoId: dto.qualificacaoId,
          qualificacaoNome:
            escolhida?.nome ?? `Qualificação ${dto.qualificacaoId}`,
          qualificacaoNota: dto.observacao ?? null,
          qualificacaoConversao: escolhida?.conversao ?? null,
          qualificadaEm: new Date(),
        },
      });
      if (gravada.atividadeId) {
        await tx.atividade.updateMany({
          where: { id: gravada.atividadeId },
          data: { descricao: descricaoDaAtividade(gravada) },
        });
      }
      await this.auditoria.registrar(tx, {
        acao: 'ligacao.qualificada',
        entidade: 'ligacao',
        entidadeId: id,
        resumo: `${usuario.nome} qualificou a ligação do 3C+ como "${gravada.qualificacaoNome}"`,
        dados: {
          provedor: 'TRESC_PLUS',
          qualificacaoId: dto.qualificacaoId,
          agendada: !!dto.agendarPara,
          regra: REGRA_TRESC_PLUS,
        },
        relacionados: { contato: gravada.contatoId, usuario: usuario.id },
      });
      return gravada;
    });
    this.tempoReal.emitir(
      salas.usuario(usuario.id),
      'tresc.ligacao',
      cargaDaLigacao(
        atualizada,
        await veNegocio(this.prisma, usuario, atualizada.negocioId),
      ),
    );
    return this.dto(id, usuario);
  }

  private async dto(
    id: string,
    usuario: UsuarioAutenticado,
  ): Promise<LigacaoDto> {
    const completa = await this.prisma.ligacao.findUniqueOrThrow({
      where: { id },
      include: INCLUIR_LIGACAO,
    });
    return paraLigacaoDto(
      completa,
      usuario.id,
      usuario.papel,
      await veNegocio(this.prisma, usuario, completa.negocioId),
    );
  }

  private async auditar(
    usuario: UsuarioAutenticado,
    acao: string,
    resumo: string,
    dados: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.$transaction((tx) =>
      this.auditoria.registrar(tx, {
        acao,
        entidade: 'tresc_plus',
        resumo,
        dados: { ...dados, regra: REGRA_TRESC_PLUS },
        relacionados: { usuario: usuario.id },
      }),
    );
  }
}
