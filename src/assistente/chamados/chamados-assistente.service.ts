/**
 * Chamados do assistente (R25). Só nascem com a confirmação explícita da
 * pessoa (`POST …/chamado {confirmar: true}`), para uma resposta cuja
 * categoria pede chamado; nunca a partir do texto do modelo. O envio sai pela
 * fila (`assistente.enviar-chamado`), com novas tentativas em 1 min, 5 min,
 * 15 min, 1 h e 3 h; ao final, a pessoa é avisada (número/link ou falha) e,
 * na falha, os Admins também.
 */
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { AuditoriaService } from '../../auditoria/auditoria.service';
import type { UsuarioAutenticado } from '../../auth/usuario-autenticado';
import {
  ConflitoException,
  NaoEncontradoException,
  RegraVioladaException,
  ServicoIndisponivelException,
} from '../../comum/erros/excecoes';
import { rotuloDoPapel } from '../../comum/dominio/papeis';
import { nomeDoSetor } from '../../comum/dominio/setores';
import { FilaService } from '../../fila/fila.service';
import type {
  AssistenteChamado,
  CategoriaAssistente,
} from '../../generated/prisma/client';
import { NotificacoesService } from '../../notificacoes/notificacoes.service';
import { PrismaService, type Tx } from '../../prisma/prisma.service';
import {
  CATEGORIAS_DE_CHAMADO,
  DESCRICAO_TICKETHUB,
  ESPERAS_DO_CHAMADO_S,
  FILA_CHAMADOS,
  MAX_TENTATIVAS_CHAMADO,
  REGRA_ASSISTENTE,
  ROTULO_DA_CATEGORIA,
} from '../assistente.constantes';
import { ConfiguracaoAssistenteService } from '../configuracao-assistente.service';
import type {
  AbrirChamadoDto,
  ChamadoAssistenteDto,
} from '../dto/assistente.dto';
import {
  type ChamadoParaEnvio,
  ConectorChamadosService,
  ErroDoDestino,
} from './conector-chamados.service';
import type { MensagemDaConversa } from './modelo-corpo';

interface TrabalhoDoChamado {
  chamadoId: string;
}

/** Pares da conversa enviados no chamado (os mais recentes). */
const PARES_NO_CHAMADO = 20;

export function chamadoParaDto(c: AssistenteChamado): ChamadoAssistenteDto {
  return {
    id: c.id,
    conversaId: c.conversaId,
    perguntaId: c.perguntaId,
    titulo: c.titulo,
    descricao: c.descricao,
    tela: c.tela,
    categoria: c.categoria,
    destino: c.destino,
    status: c.status,
    tentativas: c.tentativas,
    proximaTentativaEm: c.proximaTentativaEm?.toISOString() ?? null,
    ultimoErro: c.ultimoErro,
    numero: c.numero,
    link: c.link,
    criadoEm: c.criadoEm.toISOString(),
    enviadoEm: c.enviadoEm?.toISOString() ?? null,
  };
}

function cortar(texto: string, limite: number): string {
  return texto.length > limite ? `${texto.slice(0, limite - 1)}…` : texto;
}

@Injectable()
export class ChamadosAssistenteService implements OnModuleInit {
  private readonly log = new Logger('AssistenteIa');

  constructor(
    private readonly prisma: PrismaService,
    private readonly fila: FilaService,
    private readonly auditoria: AuditoriaService,
    private readonly notificacoes: NotificacoesService,
    private readonly configuracao: ConfiguracaoAssistenteService,
    private readonly conector: ConectorChamadosService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.fila.trabalhar<TrabalhoDoChamado>(
      FILA_CHAMADOS,
      (trabalho) => this.tentarEnviar(trabalho.dados.chamadoId),
      {
        // A agenda de novas tentativas é feita com jobs novos; estas só
        // cobrem falhas inesperadas (banco fora, API derrubada no meio).
        tentativas: 2,
        intervaloEntreTentativasSegundos: 120,
        prazoDeExecucaoSegundos: 90,
        concorrencia: 2,
      },
    );
  }

  private agendar(
    tx: Tx,
    chamadoId: string,
    tentativa: number,
    executarEm?: Date,
  ): Promise<string | null> {
    return this.fila.enviar(
      FILA_CHAMADOS,
      { chamadoId },
      { tx, executarEm, chaveUnica: `${chamadoId}:${tentativa}` },
    );
  }

  /** Abre o chamado de uma resposta da própria pessoa (com confirmação). */
  async abrir(
    usuario: UsuarioAutenticado,
    perguntaId: string,
    dto: AbrirChamadoDto,
  ): Promise<ChamadoAssistenteDto> {
    const destino = await this.configuracao.destino();
    if (!destino.pronto) {
      throw new ServicoIndisponivelException(
        'A abertura de chamados não está configurada. Fale com o Admin.',
        { regra: REGRA_ASSISTENTE, motivo: 'destino_nao_configurado' },
      );
    }
    return this.prisma.$transaction(async (tx) => {
      const pergunta = await tx.assistentePergunta.findUnique({
        where: { id: perguntaId },
        include: { chamado: true },
      });
      if (!pergunta || pergunta.usuarioId !== usuario.id) {
        throw new NaoEncontradoException('Resposta não encontrada.');
      }
      if (pergunta.status !== 'CONCLUIDA' || !pergunta.categoria) {
        throw new RegraVioladaException(
          REGRA_ASSISTENTE,
          'Só dá para abrir chamado a partir de uma resposta concluída.',
        );
      }
      if (!CATEGORIAS_DE_CHAMADO.includes(pergunta.categoria)) {
        throw new RegraVioladaException(
          REGRA_ASSISTENTE,
          'Esta resposta não pede chamado: ele é aberto para funcionalidades que não existem ou erros do sistema.',
          { categoria: pergunta.categoria },
        );
      }
      if (pergunta.chamado) {
        throw new ConflitoException(
          'Já foi aberto um chamado para esta resposta.',
          { regra: REGRA_ASSISTENTE, chamadoId: pergunta.chamado.id },
        );
      }
      const titulo =
        dto.titulo ??
        (pergunta.resumoDoPedido && pergunta.resumoDoPedido.length >= 3
          ? cortar(pergunta.resumoDoPedido, 200)
          : cortar(pergunta.pergunta, 200));
      const chamado = await tx.assistenteChamado.create({
        data: {
          conversaId: pergunta.conversaId,
          perguntaId: pergunta.id,
          usuarioId: usuario.id,
          titulo,
          descricao: dto.descricao || pergunta.pergunta,
          tela: pergunta.tela,
          categoria: pergunta.categoria,
          destino: destino.destino.tipo,
        },
      });
      await this.agendar(tx, chamado.id, 1);
      await this.auditoria.registrar(tx, {
        acao: 'assistente.chamado_solicitado',
        entidade: 'assistente_chamado',
        entidadeId: chamado.id,
        resumo: `${usuario.nome} confirmou a abertura de um chamado pelo assistente de IA (${ROTULO_DA_CATEGORIA[pergunta.categoria]})`,
        dados: {
          perguntaId: pergunta.id,
          conversaId: pergunta.conversaId,
          categoria: pergunta.categoria,
          destino: chamado.destino,
          regra: REGRA_ASSISTENTE,
        },
      });
      return chamadoParaDto(chamado);
    });
  }

  /** Um chamado da própria pessoa (ou qualquer um, para o Admin). */
  async detalhe(
    usuario: UsuarioAutenticado,
    id: string,
  ): Promise<ChamadoAssistenteDto> {
    const chamado = await this.prisma.assistenteChamado.findUnique({
      where: { id },
    });
    if (
      !chamado ||
      (chamado.usuarioId !== usuario.id && usuario.papel !== 'ADMIN')
    ) {
      throw new NaoEncontradoException('Chamado não encontrado.');
    }
    return chamadoParaDto(chamado);
  }

  /** O Admin manda de novo um chamado que falhou (as tentativas recomeçam). */
  async reenviar(
    usuario: UsuarioAutenticado,
    id: string,
  ): Promise<ChamadoAssistenteDto> {
    const destino = await this.configuracao.destino();
    if (!destino.pronto) {
      throw new ServicoIndisponivelException(destino.motivo, {
        regra: REGRA_ASSISTENTE,
        motivo: 'destino_nao_configurado',
      });
    }
    return this.prisma.$transaction(async (tx) => {
      const chamado = await tx.assistenteChamado.findUnique({ where: { id } });
      if (!chamado) {
        throw new NaoEncontradoException('Chamado não encontrado.');
      }
      if (chamado.status !== 'FALHOU') {
        throw new ConflitoException(
          'Só um chamado que falhou pode ser reenviado.',
          { regra: REGRA_ASSISTENTE, status: chamado.status },
        );
      }
      const atualizado = await tx.assistenteChamado.update({
        where: { id },
        data: {
          status: 'PENDENTE',
          tentativas: 0,
          proximaTentativaEm: null,
          destino: destino.destino.tipo,
        },
      });
      await this.agendar(tx, id, Date.now());
      await this.auditoria.registrar(tx, {
        acao: 'assistente.chamado_reenviado',
        entidade: 'assistente_chamado',
        entidadeId: id,
        resumo: `${usuario.nome} reenviou um chamado do assistente de IA que tinha falhado`,
        dados: { destino: atualizado.destino, regra: REGRA_ASSISTENTE },
      });
      return chamadoParaDto(atualizado);
    });
  }

  // -------------------------------------------------------------------------
  // Envio (job da fila)
  // -------------------------------------------------------------------------

  /** Monta o texto e os dados do corpo a partir do chamado e da conversa. */
  private async montar(id: string): Promise<{
    chamado: AssistenteChamado;
    envio: ChamadoParaEnvio;
    usuarioId: string;
  } | null> {
    const chamado = await this.prisma.assistenteChamado.findUnique({
      where: { id },
      include: {
        usuario: { select: { id: true, nome: true, email: true } },
        pergunta: { select: { criadoEm: true } },
        conversa: { select: { papel: true, area: true } },
      },
    });
    if (!chamado) {
      return null;
    }
    const perguntas = await this.prisma.assistentePergunta.findMany({
      where: {
        conversaId: chamado.conversaId,
        status: 'CONCLUIDA',
        criadoEm: { lte: chamado.pergunta.criadoEm },
      },
      orderBy: { criadoEm: 'desc' },
      take: PARES_NO_CHAMADO,
      select: { pergunta: true, resposta: true },
    });
    perguntas.reverse();
    const conversa: MensagemDaConversa[] = perguntas.flatMap((p) => [
      { autor: 'pessoa' as const, texto: p.pergunta },
      { autor: 'assistente' as const, texto: p.resposta ?? '' },
    ]);
    const papel = rotuloDoPapel(chamado.conversa.papel, chamado.conversa.area);
    const area = chamado.conversa.area
      ? nomeDoSetor(chamado.conversa.area)
      : '';
    const conversaTexto = conversa
      .map(
        (m) => `[${m.autor === 'pessoa' ? 'Pessoa' : 'Assistente'}] ${m.texto}`,
      )
      .join('\n\n');
    const cabecalho =
      `${chamado.descricao}\n\n` +
      `— Aberto pelo assistente de ajuda do BRL CRM —\n` +
      `Pessoa: ${chamado.usuario.nome} <${chamado.usuario.email}> (${papel}${area ? `, ${area}` : ''})\n` +
      `Tela: ${chamado.tela}\n` +
      `Categoria: ${ROTULO_DA_CATEGORIA[chamado.categoria as CategoriaAssistente]}\n\n` +
      `Conversa:\n`;
    const espaco = DESCRICAO_TICKETHUB.max - cabecalho.length;
    const conversaCortada =
      conversaTexto.length > espaco
        ? `(início da conversa cortado)\n…${conversaTexto.slice(-(espaco - 40))}`
        : conversaTexto;
    return {
      chamado,
      usuarioId: chamado.usuario.id,
      envio: {
        id: chamado.id,
        titulo: chamado.titulo,
        descricao: `${cabecalho}${conversaCortada}`,
        corpo: {
          chamadoId: chamado.id,
          conversaId: chamado.conversaId,
          titulo: chamado.titulo,
          descricao: chamado.descricao,
          categoria: chamado.categoria,
          tela: chamado.tela,
          criadoEm: chamado.criadoEm.toISOString(),
          'usuario.nome': chamado.usuario.nome,
          'usuario.email': chamado.usuario.email,
          'usuario.papel': papel,
          'usuario.area': area,
          conversa,
          conversaTexto,
        },
      },
    };
  }

  /** Uma tentativa de envio. Nunca lança (as novas tentativas são jobs novos). */
  async tentarEnviar(id: string): Promise<void> {
    const montado = await this.montar(id);
    if (!montado || montado.chamado.status !== 'PENDENTE') {
      return;
    }
    const { chamado, envio, usuarioId } = montado;
    const tentativa = chamado.tentativas + 1;
    let erro: string;
    try {
      const destino = await this.configuracao.destino();
      if (!destino.pronto) {
        throw new ErroDoDestino(destino.motivo);
      }
      const criado = await this.conector.enviar(destino.destino, envio);
      await this.prisma.$transaction(async (tx) => {
        const feito = await tx.assistenteChamado.updateMany({
          where: { id, status: 'PENDENTE' },
          data: {
            status: 'ENVIADO',
            tentativas: tentativa,
            destino: destino.destino.tipo,
            numero: criado.numero,
            link: criado.link,
            enviadoEm: new Date(),
            proximaTentativaEm: null,
            ultimoErro: null,
          },
        });
        if (feito.count === 0) {
          return;
        }
        await this.auditoria.registrar(tx, {
          acao: 'assistente.chamado_enviado',
          entidade: 'assistente_chamado',
          entidadeId: id,
          resumo: `Chamado do assistente de IA aberto no ${destino.destino.tipo === 'TICKETHUB' ? 'TicketHub' : 'webhook'}${criado.numero ? ` (nº ${criado.numero})` : ''}`,
          dados: {
            numero: criado.numero,
            destino: destino.destino.tipo,
            tentativas: tentativa,
            regra: REGRA_ASSISTENTE,
          },
        });
        await this.notificacoes.notificar(tx, usuarioId, {
          tipo: 'assistente.chamado_aberto',
          titulo: 'Seu chamado foi aberto',
          texto: criado.numero
            ? `"${chamado.titulo}" virou o chamado nº ${criado.numero}.`
            : `"${chamado.titulo}" foi enviado à equipe de suporte.`,
          link: null,
          dados: {
            chamadoId: id,
            numero: criado.numero,
            linkExterno: criado.link,
          },
        });
      });
      return;
    } catch (falha) {
      erro =
        falha instanceof ErroDoDestino
          ? falha.message
          : 'Falha inesperada ao enviar o chamado.';
      if (!(falha instanceof ErroDoDestino)) {
        this.log.error(
          `Falha inesperada no envio do chamado ${id}: ${falha instanceof Error ? falha.name : 'erro'}`,
        );
      }
    }
    const ultima = tentativa >= MAX_TENTATIVAS_CHAMADO;
    const proxima = ultima
      ? null
      : new Date(
          Date.now() +
            (ESPERAS_DO_CHAMADO_S[tentativa - 1] ??
              ESPERAS_DO_CHAMADO_S.at(-1)!) *
              1000,
        );
    await this.prisma.$transaction(async (tx) => {
      const feito = await tx.assistenteChamado.updateMany({
        where: { id, status: 'PENDENTE' },
        data: {
          status: ultima ? 'FALHOU' : 'PENDENTE',
          tentativas: tentativa,
          ultimoErro: erro.slice(0, 1000),
          proximaTentativaEm: proxima,
        },
      });
      if (feito.count === 0) {
        return;
      }
      if (proxima) {
        await this.agendar(tx, id, tentativa + 1, proxima);
        return;
      }
      await this.auditoria.registrar(tx, {
        acao: 'assistente.chamado_falhou',
        entidade: 'assistente_chamado',
        entidadeId: id,
        resumo: `O chamado do assistente de IA não pôde ser aberto depois de ${tentativa} tentativas`,
        dados: { erro, tentativas: tentativa, regra: REGRA_ASSISTENTE },
      });
      await this.notificacoes.notificar(tx, usuarioId, {
        tipo: 'assistente.chamado_falhou',
        titulo: 'Não foi possível abrir o seu chamado',
        texto: `"${chamado.titulo}" não chegou ao suporte. O Admin foi avisado.`,
        link: null,
        dados: { chamadoId: id },
      });
      await this.notificacoes.notificarAdmins(tx, {
        tipo: 'assistente.chamado_falhou',
        titulo: 'Chamado do assistente não foi aberto',
        texto: `Depois de ${tentativa} tentativas: ${erro.slice(0, 200)}`,
        link: '/administracao/duvidas',
        dados: { chamadoId: id },
      });
    });
  }
}
