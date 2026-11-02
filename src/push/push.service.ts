import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { AuditoriaService } from '../auditoria/auditoria.service';
import { CriptografiaService } from '../comum/criptografia/criptografia.service';
import {
  DadosInvalidosException,
  NaoEncontradoException,
  RegraVioladaException,
  ServicoIndisponivelException,
} from '../comum/erros/excecoes';
import { AMBIENTE, type Ambiente } from '../config/ambiente';
import { FilaService, type Trabalho } from '../fila/fila.service';
import type {
  Notificacao,
  Prisma,
  PushInscricao,
} from '../generated/prisma/client';
import { OuvintesDeNotificacao } from '../notificacoes/ouvintes-notificacao';
import { PrismaService, type Tx } from '../prisma/prisma.service';
import { verificarDestino } from '../webhooks/saida/protecao-ssrf';
import { cargaDaNotificacao, preferenciaDoTipo } from './mapeamento';
import {
  type CargaDoPush,
  FILA_PUSH,
  MAX_INSCRICOES_POR_USUARIO,
  REGRA_PUSH,
  TIPOS_DE_PREFERENCIA,
  type TipoDePreferencia,
} from './push.constantes';
import type { AlterarPreferenciasPushDto, InscreverPushDto } from './push.dto';
import {
  type AssinaturaDePush,
  SERVICO_DE_PUSH,
  type ServicoDePush,
} from './servico-de-push';

export interface TrabalhoDePush {
  notificacaoId: string;
  inscricaoId: string;
}

export type PreferenciasDePush = Record<TipoDePreferencia, boolean>;

/** O que aconteceu com um envio a um aparelho. */
export type DesfechoDoEnvio =
  | 'enviado'
  /** O serviço de push disse 404/410: a inscrição foi removida. */
  | 'expirada'
  /** Falha que tentar de novo não resolve (chave recusada, endereço bloqueado). */
  | 'recusada'
  /** Falha passageira (429, 5xx, rede): vale tentar de novo. */
  | 'passageira';

function todasLigadas(): PreferenciasDePush {
  return Object.fromEntries(
    TIPOS_DE_PREFERENCIA.map((tipo) => [tipo, true]),
  ) as PreferenciasDePush;
}

function preferenciasDe(guardadas: unknown): PreferenciasDePush {
  const prefs = todasLigadas();
  if (guardadas && typeof guardadas === 'object') {
    for (const tipo of TIPOS_DE_PREFERENCIA) {
      const valor = (guardadas as Record<string, unknown>)[tipo];
      if (typeof valor === 'boolean') {
        prefs[tipo] = valor;
      }
    }
  }
  return prefs;
}

/**
 * Notificações push (R26): inscrição por aparelho e pessoa, preferências por
 * tipo e envio a partir das notificações internas (um ouvinte do
 * `NotificacoesService`: nenhuma regra de negócio é repetida). O envio sai pela
 * fila, um job por notificação e aparelho; 404/410 do serviço de push remove a
 * inscrição. Endereços e chaves das inscrições nunca vão para logs, auditoria
 * ou respostas.
 */
@Injectable()
export class PushService implements OnModuleInit {
  private readonly log = new Logger(PushService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditoria: AuditoriaService,
    private readonly cripto: CriptografiaService,
    private readonly fila: FilaService,
    private readonly ouvintes: OuvintesDeNotificacao,
    @Inject(AMBIENTE) private readonly ambiente: Ambiente,
    @Inject(SERVICO_DE_PUSH) private readonly servico: ServicoDePush,
  ) {}

  async onModuleInit(): Promise<void> {
    this.ouvintes.registrar((tx, notificacoes) =>
      this.aoNotificar(tx, notificacoes),
    );
    await this.fila.trabalhar<TrabalhoDePush>(
      FILA_PUSH,
      (trabalho) => this.processar(trabalho),
      {
        tentativas: 3,
        intervaloEntreTentativasSegundos: 30,
        esperaExponencial: true,
        prazoDeExecucaoSegundos: 60,
        concorrencia: 4,
      },
    );
  }

  // ---- chave e inscrições ---------------------------------------------------------

  chavePublica(): string {
    this.exigirConfigurado();
    return this.ambiente.push.chavePublica as string;
  }

  async listarInscricoes(usuarioId: string): Promise<PushInscricao[]> {
    return this.prisma.pushInscricao.findMany({
      where: { usuarioId },
      orderBy: [{ criadoEm: 'desc' }, { id: 'desc' }],
    });
  }

  /** Idempotente por `endpoint`: repetir atualiza chaves e nome (e passa o aparelho para quem inscreveu por último). */
  async inscrever(
    usuarioId: string,
    dto: InscreverPushDto,
  ): Promise<{ id: string; nova: boolean }> {
    this.exigirConfigurado();
    await this.conferirEndereco(dto.endpoint);
    const chavesCifradas = this.cripto.cifrar(JSON.stringify(dto.keys));
    return this.prisma.$transaction(async (tx) => {
      const existente = await tx.pushInscricao.findUnique({
        where: { endpoint: dto.endpoint },
        select: { id: true, usuarioId: true },
      });
      const inscricao = await tx.pushInscricao.upsert({
        where: { endpoint: dto.endpoint },
        create: {
          usuarioId,
          endpoint: dto.endpoint,
          chavesCifradas,
          aparelho: dto.aparelho,
        },
        update: {
          usuarioId,
          chavesCifradas,
          aparelho: dto.aparelho,
          ultimoErro: null,
        },
      });
      if (!existente || existente.usuarioId !== usuarioId) {
        await this.auditoria.registrar(tx, {
          acao: 'push.inscricao_criada',
          entidade: 'push_inscricao',
          entidadeId: inscricao.id,
          resumo: `Aparelho "${dto.aparelho}" inscrito para notificações push`,
          dados: {
            aparelho: dto.aparelho,
            servico: new URL(dto.endpoint).host,
            reaproveitada: existente !== null,
            regra: REGRA_PUSH,
          },
        });
        await this.limitarInscricoes(tx, usuarioId, inscricao.id);
      }
      return { id: inscricao.id, nova: !existente };
    });
  }

  async remover(usuarioId: string, id: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const inscricao = await tx.pushInscricao.findFirst({
        where: { id, usuarioId },
        select: { id: true, aparelho: true },
      });
      if (!inscricao) {
        throw new NaoEncontradoException('Aparelho não encontrado.');
      }
      await tx.pushInscricao.delete({ where: { id } });
      await this.auditoria.registrar(tx, {
        acao: 'push.inscricao_removida',
        entidade: 'push_inscricao',
        entidadeId: id,
        resumo: `Aparelho "${inscricao.aparelho}" removido das notificações push`,
        dados: { aparelho: inscricao.aparelho, regra: REGRA_PUSH },
      });
    });
  }

  // ---- preferências ---------------------------------------------------------------

  async preferencias(usuarioId: string): Promise<PreferenciasDePush> {
    const linha = await this.prisma.pushPreferencia.findUnique({
      where: { usuarioId },
    });
    return preferenciasDe(linha?.tipos);
  }

  async alterarPreferencias(
    usuarioId: string,
    dto: AlterarPreferenciasPushDto,
  ): Promise<PreferenciasDePush> {
    if (TIPOS_DE_PREFERENCIA.every((tipo) => dto.tipos[tipo] === undefined)) {
      throw new DadosInvalidosException('Informe ao menos um tipo.', {
        campos: [{ campo: 'tipos', mensagens: ['informe ao menos um tipo'] }],
      });
    }
    return this.prisma.$transaction(async (tx) => {
      const linha = await tx.pushPreferencia.findUnique({
        where: { usuarioId },
      });
      const antes = preferenciasDe(linha?.tipos);
      const depois = { ...antes };
      for (const tipo of TIPOS_DE_PREFERENCIA) {
        const novo = dto.tipos[tipo];
        if (novo !== undefined) {
          depois[tipo] = novo;
        }
      }
      const mudou = TIPOS_DE_PREFERENCIA.filter(
        (tipo) => antes[tipo] !== depois[tipo],
      );
      if (mudou.length > 0 || !linha) {
        await tx.pushPreferencia.upsert({
          where: { usuarioId },
          create: { usuarioId, tipos: depois },
          update: { tipos: depois },
        });
      }
      if (mudou.length > 0) {
        await this.auditoria.registrar(tx, {
          acao: 'push.preferencias_alteradas',
          entidade: 'push_preferencia',
          entidadeId: usuarioId,
          resumo: `Preferências de notificação push alteradas (${mudou.join(', ')})`,
          dados: {
            alteracoes: mudou.map((tipo) => ({
              tipo,
              de: antes[tipo],
              para: depois[tipo],
            })),
            regra: REGRA_PUSH,
          },
        });
      }
      return depois;
    });
  }

  // ---- envio ----------------------------------------------------------------------

  /** Push de teste para os aparelhos da própria pessoa (na hora, sem a fila). */
  async testar(
    usuarioId: string,
  ): Promise<{ enviados: number; falhas: number; removidas: number }> {
    this.exigirConfigurado();
    const inscricoes = await this.listarInscricoes(usuarioId);
    if (inscricoes.length === 0) {
      throw new RegraVioladaException(
        REGRA_PUSH,
        'Nenhum aparelho inscrito: ative as notificações neste aparelho primeiro.',
        { motivo: 'sem_inscricoes' },
      );
    }
    const carga: CargaDoPush = {
      titulo: 'BRL CRM',
      corpo: 'Notificação de teste: o push está funcionando neste aparelho.',
      url: '/notificacoes',
      tag: 'teste',
      notificacaoId: null,
    };
    const resultado = { enviados: 0, falhas: 0, removidas: 0 };
    for (const inscricao of inscricoes) {
      const desfecho = await this.entregar(inscricao, carga);
      if (desfecho === 'enviado') resultado.enviados++;
      else if (desfecho === 'expirada') resultado.removidas++;
      else resultado.falhas++;
    }
    await this.prisma.$transaction((tx) =>
      this.auditoria.registrar(tx, {
        acao: 'push.teste_enviado',
        entidade: 'push_inscricao',
        entidadeId: null,
        resumo: `Push de teste enviado (${resultado.enviados} de ${inscricoes.length} aparelhos)`,
        dados: { ...resultado, regra: REGRA_PUSH },
      }),
    );
    return resultado;
  }

  /**
   * Ouvinte das notificações internas, na transação que as criou: para cada
   * notificação de um tipo mapeado, com a preferência ligada, cria um job por
   * aparelho (só existe se a transação confirmar).
   */
  private async aoNotificar(
    tx: Tx,
    notificacoes: readonly Notificacao[],
  ): Promise<void> {
    if (!this.ambiente.push.configurada) {
      return;
    }
    const mapeadas = notificacoes.filter((n) => preferenciaDoTipo(n.tipo));
    if (mapeadas.length === 0) {
      return;
    }
    const usuarioIds = [...new Set(mapeadas.map((n) => n.usuarioId))];
    const [inscricoes, preferencias] = await Promise.all([
      tx.pushInscricao.findMany({
        where: { usuarioId: { in: usuarioIds } },
        select: { id: true, usuarioId: true },
      }),
      tx.pushPreferencia.findMany({
        where: { usuarioId: { in: usuarioIds } },
      }),
    ]);
    if (inscricoes.length === 0) {
      return;
    }
    const prefsPorUsuario = new Map(
      preferencias.map((p) => [p.usuarioId, preferenciasDe(p.tipos)]),
    );
    for (const notificacao of mapeadas) {
      const tipo = preferenciaDoTipo(notificacao.tipo) as TipoDePreferencia;
      const ligada = prefsPorUsuario.get(notificacao.usuarioId)?.[tipo] ?? true;
      if (!ligada) {
        continue;
      }
      for (const inscricao of inscricoes) {
        if (inscricao.usuarioId !== notificacao.usuarioId) {
          continue;
        }
        await this.fila.enviar<TrabalhoDePush>(
          FILA_PUSH,
          { notificacaoId: notificacao.id, inscricaoId: inscricao.id },
          { tx, chaveUnica: `${notificacao.id}:${inscricao.id}` },
        );
      }
    }
  }

  /** Manipulador da fila: um aparelho por job; falha passageira relança para o pg-boss tentar de novo. */
  async processar(trabalho: Trabalho<TrabalhoDePush>): Promise<void> {
    const { notificacaoId, inscricaoId } = trabalho.dados;
    const [notificacao, inscricao] = await Promise.all([
      this.prisma.notificacao.findUnique({ where: { id: notificacaoId } }),
      this.prisma.pushInscricao.findUnique({ where: { id: inscricaoId } }),
    ]);
    if (
      !notificacao ||
      !inscricao ||
      inscricao.usuarioId !== notificacao.usuarioId
    ) {
      return;
    }
    const tipo = preferenciaDoTipo(notificacao.tipo);
    if (!tipo) {
      return;
    }
    // A pessoa pode ter desligado o tipo entre a notificação e o envio.
    if (!(await this.preferencias(notificacao.usuarioId))[tipo]) {
      return;
    }
    const desfecho = await this.entregar(
      inscricao,
      cargaDaNotificacao(notificacao),
    );
    if (desfecho === 'passageira') {
      throw new Error('Falha passageira ao enviar o push.');
    }
  }

  /** Envia a carga a um aparelho e trata o resultado (registra o erro ou remove a inscrição expirada). */
  async entregar(
    inscricao: PushInscricao,
    carga: CargaDoPush,
  ): Promise<DesfechoDoEnvio> {
    const assinatura = this.assinaturaDe(inscricao);
    if (!assinatura) {
      await this.registrarErro(
        inscricao.id,
        'As chaves do aparelho não puderam ser lidas.',
      );
      return 'recusada';
    }
    const destino = await verificarDestino(inscricao.endpoint, {
      producao: this.ambiente.producao,
      permitirRedeInterna: this.ambiente.webhooksPermitirRedeInterna,
    });
    if (!destino.permitido) {
      await this.registrarErro(
        inscricao.id,
        'Endereço do serviço de push bloqueado.',
      );
      return destino.motivo === 'dns' ? 'passageira' : 'recusada';
    }
    const resultado = await this.servico.enviar(
      assinatura,
      JSON.stringify(carga),
    );
    if (resultado.ok) {
      await this.prisma.pushInscricao.updateMany({
        where: { id: inscricao.id },
        data: { ultimoEnvioEm: new Date(), ultimoErro: null },
      });
      return 'enviado';
    }
    if (resultado.status === 404 || resultado.status === 410) {
      await this.expirar(inscricao, resultado.status);
      return 'expirada';
    }
    await this.registrarErro(inscricao.id, resultado.mensagem);
    const passageira =
      resultado.status === null ||
      resultado.status === 429 ||
      resultado.status >= 500;
    return passageira ? 'passageira' : 'recusada';
  }

  // ---- apoio ----------------------------------------------------------------------

  private exigirConfigurado(): void {
    if (!this.ambiente.push.configurada) {
      throw new ServicoIndisponivelException(
        'As notificações push não estão configuradas neste servidor. Peça ao Admin para definir as chaves VAPID.',
        { motivo: 'nao_configurado' },
      );
    }
  }

  private async conferirEndereco(endpoint: string): Promise<void> {
    // Navegadores só entregam endereços https; o `web-push` também só fala https.
    if (!endpoint.startsWith('https://')) {
      throw new DadosInvalidosException('Endereço de push recusado.', {
        campos: [
          {
            campo: 'endpoint',
            mensagens: ['O endereço do serviço de push precisa ser https.'],
          },
        ],
      });
    }
    const verificado = await verificarDestino(endpoint, {
      producao: this.ambiente.producao,
      permitirRedeInterna: this.ambiente.webhooksPermitirRedeInterna,
    });
    if (!verificado.permitido) {
      throw new DadosInvalidosException('Endereço de push recusado.', {
        campos: [{ campo: 'endpoint', mensagens: [verificado.mensagem] }],
      });
    }
  }

  private assinaturaDe(inscricao: PushInscricao): AssinaturaDePush | null {
    try {
      const keys = JSON.parse(
        this.cripto.decifrar(inscricao.chavesCifradas),
      ) as AssinaturaDePush['keys'];
      return { endpoint: inscricao.endpoint, keys };
    } catch {
      return null;
    }
  }

  /** Passa do limite: remove os aparelhos mais antigos da pessoa. */
  private async limitarInscricoes(
    tx: Tx,
    usuarioId: string,
    manter: string,
  ): Promise<void> {
    const todas = await tx.pushInscricao.findMany({
      where: { usuarioId },
      orderBy: [{ criadoEm: 'desc' }, { id: 'desc' }],
      select: { id: true, aparelho: true },
    });
    const sobras = todas
      .filter(({ id }) => id !== manter)
      .slice(MAX_INSCRICOES_POR_USUARIO - 1);
    for (const sobra of sobras) {
      await tx.pushInscricao.delete({ where: { id: sobra.id } });
      await this.auditoria.registrar(tx, {
        acao: 'push.inscricao_removida',
        entidade: 'push_inscricao',
        entidadeId: sobra.id,
        resumo: `Aparelho "${sobra.aparelho}" removido: limite de ${MAX_INSCRICOES_POR_USUARIO} aparelhos`,
        dados: {
          aparelho: sobra.aparelho,
          motivo: 'limite',
          regra: REGRA_PUSH,
        },
      });
    }
  }

  private async expirar(
    inscricao: PushInscricao,
    status: number,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.pushInscricao.deleteMany({
        where: { id: inscricao.id },
      });
      if (count === 0) {
        return;
      }
      await this.auditoria.registrar(tx, {
        acao: 'push.inscricao_expirada',
        entidade: 'push_inscricao',
        entidadeId: inscricao.id,
        resumo: `Aparelho "${inscricao.aparelho}" removido: o serviço de push informou que a inscrição expirou`,
        dados: {
          aparelho: inscricao.aparelho,
          statusDoServico: status,
          regra: REGRA_PUSH,
        },
      });
    });
  }

  private async registrarErro(id: string, mensagem: string): Promise<void> {
    await this.prisma.pushInscricao.updateMany({
      where: { id },
      data: {
        ultimoErro: mensagem.slice(0, 300),
      } satisfies Prisma.PushInscricaoUpdateManyMutationInput,
    });
  }
}
