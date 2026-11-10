import { Injectable } from '@nestjs/common';
import { AuditoriaService } from '../auditoria/auditoria.service';
import { SessoesService } from '../auth/sessoes.service';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import { calcularAlteracoes } from '../comum/dados/sanitizar';
import {
  liderEsperado,
  nivelDoPapel,
  papelTemSetor,
  rotuloDoLiderEsperado,
  rotuloDoPapel,
} from '../comum/dominio/papeis';
import {
  ConflitoException,
  NaoEncontradoException,
  RegraVioladaException,
  SemPermissaoException,
} from '../comum/erros/excecoes';
import { EventosDominioService } from '../eventos/eventos-dominio.service';
import { NotificacoesService } from '../notificacoes/notificacoes.service';
import { TIPOS_NOTIFICACAO } from '../notificacoes/tipos-notificacao';
import { PrismaService, type Tx } from '../prisma/prisma.service';
import {
  escolherDestinatario,
  explicarDestinatario,
  type MotivoDestinatario,
  type ResultadoDestinatario,
  type UsuarioDaHierarquia,
} from './dominio/destinatario';
import {
  alertaDeEquipeSemLider,
  type ContagensDeEncaminhamento,
  descreverItens,
  notificacaoDeItensRecebidos,
  quantidade,
} from './dominio/encaminhamento';
import type {
  DesligarUsuarioDto,
  PreviaDesligamentoDto,
  ReativarUsuarioDto,
  ResultadoDesligamentoDto,
} from './dto/desligamento.dto';
import { INCLUIR_LIDER, UsuarioDto, UsuarioResumoDto } from './dto/usuario.dto';
import {
  exigirLiderValido,
  exigirOutroAdminAtivo,
  exigirSetorDoPapel,
  travarHierarquia,
} from './hierarquia-no-banco';
import { repetirEmConflito } from './repeticao';

/** Usuário como o desligamento o enxerga (cadeia de liderança + resumo). */
interface UsuarioDoDesligamento extends UsuarioDaHierarquia {
  readonly email: string;
  readonly desligadoEm: Date | null;
}

/** O que foi encaminhado, mais as sessões encerradas. */
interface ContagensDoDesligamento extends ContagensDeEncaminhamento {
  readonly sessoesRevogadas: number;
}

/** O que o desligamento faria agora — a base da prévia e da execução. */
interface PlanoDeDesligamento {
  readonly usuario: UsuarioDoDesligamento;
  readonly escolha: Exclude<
    ResultadoDestinatario<UsuarioDoDesligamento>,
    { tipo: 'invalido' }
  >;
  readonly liderados: readonly UsuarioDoDesligamento[];
  readonly contagens: ContagensDeEncaminhamento;
}

/**
 * Desligamento com encaminhamento (R7) e reativação (R7.5). Só o Admin executa
 * (R7.1, conferido no controller).
 *
 * O desligamento roda **numa única transação** (R7.3): marca o usuário como
 * desligado, revoga as sessões (R2.4), transfere atividades pendentes,
 * negócios abertos, contatos e empresas para o destinatário (R7.2), passa os
 * liderados para ele, tira o usuário dos rodízios, notifica o destinatário e,
 * se era líder, os Admins ("equipe sem líder"), audita com as contagens e
 * publica `usuario.desligado` (R7.4). As tabelas dos outros módulos são
 * alteradas aqui mesmo, pelo Prisma, para tudo andar junto.
 */
@Injectable()
export class DesligamentoService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditoria: AuditoriaService,
    private readonly eventos: EventosDominioService,
    private readonly notificacoes: NotificacoesService,
    private readonly sessoes: SessoesService,
  ) {}

  /** Prévia (R7.1): quem vai receber e quanto, sem alterar nada. */
  async previa(
    admin: UsuarioAutenticado,
    id: string,
    destinatarioId?: string,
  ): Promise<PreviaDesligamentoDto> {
    const plano = await this.planejar(this.prisma, admin, id, destinatarioId);
    const { usuario, escolha } = plano;
    const definido = escolha.tipo === 'definido' ? escolha : null;
    return {
      usuario: UsuarioResumoDto.de(usuario),
      destinatario: definido
        ? UsuarioResumoDto.de(definido.destinatario)
        : null,
      motivoDestinatario: definido?.motivo ?? null,
      explicacao: explicarDestinatario(usuario, escolha),
      exigeEscolha: usuario.papel === 'C_LEVEL',
      candidatos:
        escolha.tipo === 'escolha_necessaria'
          ? escolha.candidatos.map((candidato) =>
              UsuarioResumoDto.de(candidato),
            )
          : [],
      ignorados: (definido?.ignorados ?? []).map((ignorado) =>
        UsuarioResumoDto.de(ignorado),
      ),
      contagens: { ...plano.contagens },
      liderados: plano.liderados.map((liderado) =>
        UsuarioResumoDto.de(liderado),
      ),
      alertaEquipeSemLider: nivelDoPapel(usuario.papel) === 'LIDER',
    };
  }

  /**
   * Executa o desligamento (R7.2–R7.4), tudo numa transação — repetida se o
   * banco a abortar por deadlock com outra transação (nada fica pela metade).
   */
  async desligar(
    admin: UsuarioAutenticado,
    id: string,
    dto: DesligarUsuarioDto,
  ): Promise<ResultadoDesligamentoDto> {
    const resultado = await repetirEmConflito(() =>
      this.prisma.$transaction(async (tx) => {
        await travarHierarquia(tx);
        // Trava os rodízios (R5.8): uma distribuição em curso termina antes, e a
        // seguinte já enxerga o usuário desligado.
        await tx.$queryRaw`SELECT id FROM regras_distribuicao ORDER BY area FOR UPDATE`;
        const plano = await this.planejar(tx, admin, id, dto.destinatarioId);
        if (plano.escolha.tipo !== 'definido') {
          throw new RegraVioladaException(
            'R7.2',
            `${plano.usuario.nome} é C-level: informe em destinatarioId outro C-level ativo para receber o que está com ${plano.usuario.nome}.`,
            {
              candidatos: plano.escolha.candidatos.map((candidato) =>
                UsuarioResumoDto.de(candidato),
              ),
            },
          );
        }
        return this.executar(tx, plano.usuario, plano.escolha);
      }),
    );
    const usuario = await this.prisma.usuario.findUniqueOrThrow({
      where: { id },
      include: INCLUIR_LIDER,
    });
    return {
      usuario: UsuarioDto.completo(usuario),
      destinatario: UsuarioResumoDto.de(resultado.destinatario),
      motivoDestinatario: resultado.motivo,
      contagens: resultado.contagens,
    };
  }

  /**
   * Reativa (R7.5): exige um líder válido para o papel (o mesmo ou um novo) e
   * **não** devolve o que foi encaminhado. O usuário volta à regra padrão dos
   * rodízios da área.
   */
  async reativar(id: string, dto: ReativarUsuarioDto): Promise<UsuarioDto> {
    return this.prisma.$transaction(async (tx) => {
      await travarHierarquia(tx);
      const antes = await tx.usuario.findUnique({
        where: { id },
        include: INCLUIR_LIDER,
      });
      if (!antes) {
        throw new NaoEncontradoException('Usuário não encontrado.');
      }
      if (antes.ativo) {
        throw new ConflitoException(`O usuário ${antes.nome} já está ativo.`, {
          regra: 'R7.5',
        });
      }
      const papel = dto.papel ?? antes.papel;
      // Volta a um setor ativo (R1.9): o de antes ou o pedido.
      const area = await exigirSetorDoPapel(
        tx,
        papel,
        papelTemSetor(papel)
          ? dto.area !== undefined
            ? dto.area
            : antes.area
          : null,
      );
      const esperado = liderEsperado({ papel, area });
      if (esperado && !dto.liderId) {
        throw new RegraVioladaException(
          'R7.5',
          `Para reativar ${antes.nome} como ${rotuloDoPapel(papel, area)}, defina um líder válido: um ${rotuloDoLiderEsperado(esperado)} ativo.`,
          { papel, area, liderEsperado: esperado },
        );
      }
      const liderId = await exigirLiderValido(
        tx,
        { papel, area },
        dto.liderId ?? null,
        antes.id,
      );
      const depois = await tx.usuario.update({
        where: { id },
        data: { ativo: true, desligadoEm: null, papel, area, liderId },
        include: INCLUIR_LIDER,
      });
      // De volta à regra padrão dos rodízios (o desligamento o tirou de todos).
      const { count: exclusoesDeRodizio } =
        await tx.regraDistribuicaoParticipante.deleteMany({
          where: { usuarioId: id, participa: false },
        });
      await this.auditoria.registrar(tx, {
        acao: 'usuario.reativado',
        entidade: 'usuario',
        entidadeId: id,
        resumo:
          `Reativação de ${depois.nome} como ${rotuloDoPapel(depois.papel, depois.area)}` +
          (depois.lider ? `, respondendo a ${depois.lider.nome}` : ''),
        dados: {
          alteracoes: calcularAlteracoes(antes, depois, [
            'ativo',
            'desligadoEm',
            'papel',
            'area',
            'liderId',
          ]),
          desligadoDesde: antes.desligadoEm,
          exclusoesDeRodizioRemovidas: exclusoesDeRodizio,
        },
        relacionados: { usuario: depois.liderId },
      });
      return UsuarioDto.completo(depois);
    });
  }

  /**
   * Monta o plano: o usuário, o destinatário (R7.2), os liderados e as
   * contagens. Recusa quem já está desligado (R7.6), o último Admin (R1.4) e
   * destinatários inválidos. `db` é o `PrismaService` na prévia e a transação
   * na execução.
   */
  private async planejar(
    db: Tx,
    admin: UsuarioAutenticado,
    id: string,
    destinatarioId: string | undefined,
  ): Promise<PlanoDeDesligamento> {
    const usuarios: UsuarioDoDesligamento[] = await db.usuario.findMany({
      select: {
        id: true,
        nome: true,
        email: true,
        papel: true,
        area: true,
        ativo: true,
        liderId: true,
        desligadoEm: true,
      },
      orderBy: [{ criadoEm: 'asc' }, { id: 'asc' }],
    });
    // Quem executa pode ter sido desligado por outro Admin no mesmo instante.
    const executor = usuarios.find((candidato) => candidato.id === admin.id);
    if (!executor?.ativo) {
      throw new SemPermissaoException('Seu acesso foi desativado.');
    }
    const usuario = usuarios.find((candidato) => candidato.id === id);
    if (!usuario) {
      throw new NaoEncontradoException('Usuário não encontrado.');
    }
    if (!usuario.ativo) {
      throw new ConflitoException(
        `O usuário ${usuario.nome} já está desligado.`,
        {
          regra: 'R7.6',
          desligadoEm: usuario.desligadoEm?.toISOString() ?? null,
        },
      );
    }
    if (usuario.papel === 'ADMIN') {
      await exigirOutroAdminAtivo(db, usuario, 'desligar');
    }

    const escolha = escolherDestinatario({
      desligado: usuario,
      executor,
      usuarios,
      escolhidoId: usuario.papel === 'C_LEVEL' ? destinatarioId : undefined,
    });
    if (escolha.tipo === 'invalido') {
      throw new RegraVioladaException(
        escolha.regra,
        escolha.mensagem,
        escolha.detalhes,
      );
    }
    if (
      escolha.tipo === 'definido' &&
      destinatarioId &&
      destinatarioId !== escolha.destinatario.id
    ) {
      // Fora do C-level, o destinatário não é escolhido: o informado confirma a prévia.
      throw new ConflitoException(
        `Quem recebe o que está com ${usuario.nome} é ${escolha.destinatario.nome}, não o destinatário informado — ` +
          'a situação mudou desde a prévia ou a escolha não se aplica. Confira a prévia de novo.',
        {
          regra: 'R7.2',
          destinatarioCalculado: UsuarioResumoDto.de(escolha.destinatario),
        },
      );
    }

    const destinatarioDefinido =
      escolha.tipo === 'definido' ? escolha.destinatario.id : null;
    const liderados = usuarios.filter(
      (candidato) =>
        candidato.liderId === usuario.id &&
        candidato.ativo &&
        candidato.id !== destinatarioDefinido,
    );
    const [atividades, negocios, contatos, empresas, webhooks, passagens] =
      await Promise.all([
        db.atividade.count({
          where: { responsavelId: id, status: 'PENDENTE' },
        }),
        db.negocio.count({
          where: { responsavelId: id, status: 'ABERTO', excluidoEm: null },
        }),
        db.contato.count({ where: { responsavelId: id, excluidoEm: null } }),
        db.empresa.count({ where: { responsavelId: id, excluidoEm: null } }),
        db.webhookEntrada.count({
          where: { responsavelFixoId: id, excluidoEm: null },
        }),
        db.passagem.count({ where: { responsavelFixoId: id } }),
      ]);
    return {
      usuario,
      escolha,
      liderados,
      contagens: {
        atividades,
        negocios,
        contatos,
        empresas,
        liderados: liderados.length,
        responsavelFixo: webhooks + passagens,
      },
    };
  }

  /** Aplica o desligamento dentro da transação `tx`. */
  private async executar(
    tx: Tx,
    usuario: UsuarioDoDesligamento,
    escolha: Extract<
      ResultadoDestinatario<UsuarioDoDesligamento>,
      { tipo: 'definido' }
    >,
  ): Promise<{
    destinatario: UsuarioDoDesligamento;
    motivo: MotivoDestinatario;
    contagens: ContagensDoDesligamento;
  }> {
    const { destinatario, motivo } = escolha;
    const agora = new Date();
    const de = { id: usuario.id, nome: usuario.nome };
    const para = { id: destinatario.id, nome: destinatario.nome };

    // Acesso cortado na hora (R2.4): desligado, sessões e links de senha.
    await tx.usuario.update({
      where: { id: usuario.id },
      data: { ativo: false, desligadoEm: agora },
    });
    const sessoesRevogadas = await this.sessoes.revogarTodas(
      tx,
      usuario.id,
      'desligamento',
    );
    const { count: linksDeSenhaInvalidados } = await tx.tokenSenha.updateMany({
      where: { usuarioId: usuario.id, usadoEm: null, invalidadoEm: null },
      data: { invalidadoEm: agora },
    });
    // Aparelhos de push saem junto (R26.1): quem foi desligado não recebe mais notificações.
    const aparelhos = await tx.pushInscricao.findMany({
      where: { usuarioId: usuario.id },
      select: { id: true, aparelho: true },
    });
    if (aparelhos.length > 0) {
      await tx.pushInscricao.deleteMany({ where: { usuarioId: usuario.id } });
      for (const { id, aparelho } of aparelhos) {
        await this.auditoria.registrar(tx, {
          acao: 'push.inscricao_removida',
          entidade: 'push_inscricao',
          entidadeId: id,
          resumo: `Aparelho "${aparelho}" removido das notificações push: desligamento de ${usuario.nome}`,
          dados: { aparelho, motivo: 'desligamento', regra: 'R26' },
        });
      }
    }

    // O que estava com ele vai para o destinatário (R7.3).
    const atividades = await tx.atividade.updateManyAndReturn({
      where: { responsavelId: usuario.id, status: 'PENDENTE' },
      data: {
        responsavelId: destinatario.id,
        encaminhadaDeId: usuario.id,
        encaminhadaEm: agora,
      },
      select: {
        id: true,
        titulo: true,
        contatoId: true,
        empresaId: true,
        negocioId: true,
      },
    });
    const negocios = await tx.negocio.updateManyAndReturn({
      where: { responsavelId: usuario.id, status: 'ABERTO', excluidoEm: null },
      data: { responsavelId: destinatario.id },
      select: { id: true, titulo: true, contatoId: true, empresaId: true },
    });
    const contatos = await tx.contato.updateManyAndReturn({
      where: { responsavelId: usuario.id, excluidoEm: null },
      data: { responsavelId: destinatario.id },
      select: { id: true, nome: true, empresaId: true },
    });
    const empresas = await tx.empresa.updateManyAndReturn({
      where: { responsavelId: usuario.id, excluidoEm: null },
      data: { responsavelId: destinatario.id },
      select: { id: true, nome: true },
    });
    // Distribuições com responsável fixo seguem o mesmo destino.
    const webhooks = await tx.webhookEntrada.updateManyAndReturn({
      where: { responsavelFixoId: usuario.id, excluidoEm: null },
      data: { responsavelFixoId: destinatario.id },
      select: { id: true, nome: true },
    });
    const passagens = await tx.passagem.updateManyAndReturn({
      where: { responsavelFixoId: usuario.id },
      data: { responsavelFixoId: destinatario.id },
      select: { id: true, nome: true },
    });
    // Os liderados passam a responder ao destinatário até o Admin definir um novo líder.
    const liderados = await tx.usuario.updateManyAndReturn({
      where: {
        liderId: usuario.id,
        ativo: true,
        id: { not: destinatario.id },
      },
      data: { liderId: destinatario.id },
      select: { id: true, nome: true },
    });
    const rodizios = await this.tirarDosRodizios(tx, usuario.id);

    const contagens: ContagensDoDesligamento = {
      atividades: atividades.length,
      negocios: negocios.length,
      contatos: contatos.length,
      empresas: empresas.length,
      liderados: liderados.length,
      responsavelFixo: webhooks.length + passagens.length,
      sessoesRevogadas,
    };

    // Auditoria de cada encaminhamento (R3.2): aparece na linha do tempo de cada item (R3.5).
    const sufixo = `de ${usuario.nome} para ${destinatario.nome} (desligamento)`;
    const detalhe = { de, para, motivo: 'desligamento' };
    for (const atividade of atividades) {
      await this.auditoria.registrar(tx, {
        acao: 'atividade.encaminhada',
        entidade: 'atividade',
        entidadeId: atividade.id,
        resumo: `Atividade "${atividade.titulo}" encaminhada ${sufixo}`,
        dados: detalhe,
        relacionados: {
          contato: atividade.contatoId,
          empresa: atividade.empresaId,
          negocio: atividade.negocioId,
        },
      });
    }
    for (const negocio of negocios) {
      await this.auditoria.registrar(tx, {
        acao: 'negocio.encaminhado',
        entidade: 'negocio',
        entidadeId: negocio.id,
        resumo: `Negócio "${negocio.titulo}" encaminhado ${sufixo}`,
        dados: {
          ...detalhe,
          alteracoes: {
            responsavelId: { antes: usuario.id, depois: destinatario.id },
          },
        },
        relacionados: {
          contato: negocio.contatoId,
          empresa: negocio.empresaId,
        },
      });
    }
    for (const contato of contatos) {
      await this.auditoria.registrar(tx, {
        acao: 'contato.encaminhado',
        entidade: 'contato',
        entidadeId: contato.id,
        resumo: `Contato ${contato.nome} encaminhado ${sufixo}`,
        dados: {
          ...detalhe,
          alteracoes: {
            responsavelId: { antes: usuario.id, depois: destinatario.id },
          },
        },
        relacionados: { empresa: contato.empresaId },
      });
    }
    for (const empresa of empresas) {
      await this.auditoria.registrar(tx, {
        acao: 'empresa.encaminhada',
        entidade: 'empresa',
        entidadeId: empresa.id,
        resumo: `Empresa ${empresa.nome} encaminhada ${sufixo}`,
        dados: {
          ...detalhe,
          alteracoes: {
            responsavelId: { antes: usuario.id, depois: destinatario.id },
          },
        },
      });
    }
    for (const webhook of webhooks) {
      await this.auditoria.registrar(tx, {
        acao: 'webhook_entrada.responsavel_fixo_alterado',
        entidade: 'webhook_entrada',
        entidadeId: webhook.id,
        resumo: `Webhook de entrada "${webhook.nome}": responsável fixo passou ${sufixo}`,
        dados: detalhe,
      });
    }
    for (const passagem of passagens) {
      await this.auditoria.registrar(tx, {
        acao: 'passagem.responsavel_fixo_alterado',
        entidade: 'passagem',
        entidadeId: passagem.id,
        resumo: `Passagem "${passagem.nome}": responsável fixo passou ${sufixo}`,
        dados: detalhe,
      });
    }
    for (const liderado of liderados) {
      await this.auditoria.registrar(tx, {
        acao: 'usuario.lider_alterado',
        entidade: 'usuario',
        entidadeId: liderado.id,
        resumo: `${liderado.nome} passou a responder a ${destinatario.nome} com o desligamento de ${usuario.nome}, até a definição de um novo líder`,
        dados: {
          ...detalhe,
          alteracoes: {
            liderId: { antes: usuario.id, depois: destinatario.id },
          },
        },
        relacionados: { usuario: destinatario.id },
      });
    }

    // R7.4: o destinatário é notificado.
    const aviso = notificacaoDeItensRecebidos(
      usuario.nome,
      contagens,
      liderados.map(({ nome }) => nome),
    );
    if (aviso) {
      await this.notificacoes.notificar(tx, destinatario.id, {
        tipo: TIPOS_NOTIFICACAO.ITENS_ENCAMINHADOS,
        titulo: aviso.titulo,
        texto: aviso.texto,
        link: '/atividades',
        dados: { desligadoId: usuario.id, contagens },
      });
    }
    // R7.3: líder desligado → os Admins recebem "equipe sem líder".
    const area = papelTemSetor(usuario.papel) ? usuario.area : null;
    if (nivelDoPapel(usuario.papel) === 'LIDER' && area) {
      const alerta = alertaDeEquipeSemLider(
        { nome: usuario.nome, papel: usuario.papel, area },
        destinatario.nome,
        liderados.length,
      );
      await this.notificacoes.notificarAdmins(tx, {
        tipo: TIPOS_NOTIFICACAO.EQUIPE_SEM_LIDER,
        titulo: alerta.titulo,
        texto: alerta.texto,
        link: '/administracao/usuarios',
        dados: {
          area,
          liderDesligadoId: usuario.id,
          destinatarioId: destinatario.id,
          liderados: liderados.map(({ id }) => id),
        },
      });
    }

    // R7.4: a auditoria guarda as contagens.
    const itens = descreverItens(contagens);
    await this.auditoria.registrar(tx, {
      acao: 'usuario.desligado',
      entidade: 'usuario',
      entidadeId: usuario.id,
      resumo:
        `Desligamento de ${usuario.nome} (${rotuloDoPapel(usuario.papel, usuario.area)})` +
        (itens ? ` — para ${destinatario.nome}: ${itens}` : '') +
        (liderados.length > 0
          ? `; ${quantidade(liderados.length, 'liderado passou', 'liderados passaram')} a responder a ${destinatario.nome}`
          : ''),
      dados: {
        papel: usuario.papel,
        area,
        destinatario: {
          ...para,
          papel: destinatario.papel,
          area: destinatario.area,
        },
        motivoDestinatario: motivo,
        lideresIgnorados: escolha.ignorados.map(({ id, nome }) => ({
          id,
          nome,
        })),
        contagens: {
          ...contagens,
          linksDeSenhaInvalidados,
          rodizios,
        },
        liderados: liderados.map(({ id }) => id),
      },
      relacionados: { usuario: destinatario.id },
    });

    // R7.4 / R9.2: o evento vai para os webhooks de saída.
    await this.eventos.publicar(tx, 'usuario.desligado', {
      usuario: {
        id: usuario.id,
        nome: usuario.nome,
        email: usuario.email,
        papel: usuario.papel,
        area,
      },
      destinatario: {
        id: destinatario.id,
        nome: destinatario.nome,
        email: destinatario.email,
        papel: destinatario.papel,
        area: destinatario.area,
      },
      motivoDestinatario: motivo,
      desligadoEm: agora,
      contagens,
    });

    return { destinatario, motivo, contagens };
  }

  /**
   * Tira o usuário de todos os rodízios (R7.3, R5.8): `participa = false` em
   * cada regra, inclusive onde ele estava incluído de propósito. Devolve em
   * quantas regras.
   */
  private async tirarDosRodizios(tx: Tx, usuarioId: string): Promise<number> {
    const regras = await tx.regraDistribuicao.findMany({
      select: { id: true },
    });
    for (const regra of regras) {
      await tx.regraDistribuicaoParticipante.upsert({
        where: { regraId_usuarioId: { regraId: regra.id, usuarioId } },
        create: { regraId: regra.id, usuarioId, participa: false },
        update: { participa: false },
      });
    }
    return regras.length;
  }
}
