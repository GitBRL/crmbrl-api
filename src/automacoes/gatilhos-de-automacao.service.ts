import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ErroApi } from '../comum/erros/excecoes';
import {
  type GatilhoDisparado,
  GatilhosService,
} from '../comum/gatilhos/gatilhos.service';
import { PassosService } from '../comum/passos/passos.service';
import { LogsTecnicosService } from '../logs/logs-tecnicos.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  DESTINO_DE_GATILHO_AUTOMACOES,
  EVENTOS_DE_PARADA,
  MAXIMO_DE_AUTOMACOES_POR_EVENTO,
} from './automacoes.constantes';
import { AgendasDeAutomacao } from './agendas-de-automacao.service';
import { casaComFiltros } from './gatilho-config';
import {
  type EntidadeDeAutomacao,
  IniciadorDeExecucao,
} from './iniciador-de-execucao.service';
import { AGENDA_DE_VARREDURA } from './automacoes.constantes';

/**
 * Gatilhos de evento das automações (R19): recebe os eventos de domínio da
 * outbox (`GatilhosService.registrarDestino`), cancela as execuções que o evento
 * faz parar (respondeu, ganhou, perdeu) e inicia as automações ativas cujo
 * gatilho e filtros casam. A agenda (data relativa, recorrência, negócio
 * parado, atividade atrasada) fica em `AgendasDeAutomacao`.
 */
@Injectable()
export class GatilhosDeAutomacao implements OnModuleInit {
  constructor(
    private readonly gatilhos: GatilhosService,
    private readonly prisma: PrismaService,
    private readonly passos: PassosService,
    private readonly iniciador: IniciadorDeExecucao,
    private readonly agendas: AgendasDeAutomacao,
    private readonly logs: LogsTecnicosService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.gatilhos.registrarDestino({
      nome: DESTINO_DE_GATILHO_AUTOMACOES,
      eventos: '*',
      // Eventos no limite do encadeamento chegam para parar execuções; o
      // início confere o limite com `permiteEncadear` (profundidade e repetição).
      ignorarLimiteDeEncadeamento: true,
      aoDisparar: (g) => this.aoEvento(g),
    });
    await this.gatilhos.registrarAgenda({
      nome: DESTINO_DE_GATILHO_AUTOMACOES,
      cron: AGENDA_DE_VARREDURA,
      executar: (agora) => this.agendas.varrer(agora),
    });
  }

  async aoEvento(g: GatilhoDisparado): Promise<void> {
    await this.pararPorEvento(g);
    const automacoes = await this.prisma.automacao.findMany({
      where: {
        ativa: true,
        excluidoEm: null,
        tipoGatilho: 'EVENTO',
        evento: g.tipo,
      },
      orderBy: { criadoEm: 'asc' },
      take: MAXIMO_DE_AUTOMACOES_POR_EVENTO,
    });
    if (automacoes.length === 0) {
      return;
    }
    const texto =
      g.tipo === 'mensagem.recebida' && g.ids.mensagemId
        ? ((
            await this.prisma.mensagem.findUnique({
              where: { id: g.ids.mensagemId },
              select: { texto: true },
            })
          )?.texto ?? null)
        : null;
    let erroInesperado: unknown;
    for (const automacao of automacoes) {
      try {
        const entidade = automacao.entidade as EntidadeDeAutomacao;
        const entidadeId = idDaEntidade(entidade, g);
        if (
          !entidadeId ||
          !casaComFiltros(g.tipo, g.evento.dados, automacao.gatilhoConfig, {
            texto,
          })
        ) {
          continue;
        }
        await this.iniciador.iniciar({
          automacao,
          entidadeId,
          chaveDaOrigem: `evento:${g.evento.id}`,
          eventoId: g.evento.id,
          cadeia: g.cadeia,
          contexto: {
            gatilho: {
              tipo: 'EVENTO',
              evento: g.tipo,
              ocorridoEm: g.evento.ocorridoEm,
            },
            ids: g.ids,
          },
        });
      } catch (erro) {
        await this.logs.erro(
          'Automacoes',
          `Falha ao iniciar a automação "${automacao.nome}" para o evento ${g.tipo}`,
          erro,
          { automacaoId: automacao.id, eventoId: g.evento.id },
        );
        if (!(erro instanceof ErroApi)) {
          erroInesperado = erro;
        }
      }
    }
    if (erroInesperado) {
      // A outbox tenta de novo; o início é idempotente (`chaveUnica`).
      throw erroInesperado;
    }
  }

  /**
   * Critérios de parada por evento (R19): a pessoa respondeu, o negócio foi
   * ganho ou perdido. Só para execuções que começaram antes do evento.
   */
  async pararPorEvento(g: GatilhoDisparado): Promise<number> {
    if (!(EVENTOS_DE_PARADA as readonly string[]).includes(g.tipo)) {
      return 0;
    }
    const regra = ((): { criterio: string; motivo: string } | null => {
      switch (g.tipo) {
        case 'mensagem.recebida':
        case 'campanha.respondida':
          return { criterio: 'RESPONDEU', motivo: 'criterio:RESPONDEU' };
        case 'negocio.ganho':
          return { criterio: 'GANHOU', motivo: 'criterio:GANHOU' };
        case 'negocio.perdido':
          return { criterio: 'PERDEU', motivo: 'criterio:PERDEU' };
        default:
          return null;
      }
    })();
    if (!regra) {
      return 0;
    }
    const porNegocio = regra.criterio !== 'RESPONDEU';
    const alvos = porNegocio
      ? [
          ...(g.ids.negocioId ? [{ negocioId: g.ids.negocioId }] : []),
          ...(g.ids.contatoId ? [{ contatoId: g.ids.contatoId }] : []),
        ]
      : g.ids.contatoId
        ? [{ contatoId: g.ids.contatoId }]
        : [];
    if (alvos.length === 0) {
      return 0;
    }
    const execucoes = await this.prisma.execucao.findMany({
      where: {
        tipo: 'AUTOMACAO',
        teste: false,
        status: { in: ['EM_ANDAMENTO', 'AGUARDANDO'] },
        criadoEm: { lt: g.evento.ocorridoEm },
        automacao: { criteriosParada: { has: regra.criterio } },
        OR: alvos,
      },
      select: { id: true },
      take: 1_000,
    });
    let parou = 0;
    for (const { id } of execucoes) {
      if (await this.passos.cancelar(id, regra.motivo)) {
        parou += 1;
      }
    }
    return parou;
  }
}

function idDaEntidade(
  entidade: EntidadeDeAutomacao,
  g: GatilhoDisparado,
): string | undefined {
  switch (entidade) {
    case 'contato':
      return g.ids.contatoId;
    case 'negocio':
      return g.ids.negocioId;
    case 'atividade':
      return g.ids.atividadeId;
    case 'conversa':
      return g.ids.conversaId;
  }
}
