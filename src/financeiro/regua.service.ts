import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { AuditoriaService } from '../auditoria/auditoria.service';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import { executarComoAtor } from '../comum/contexto/contexto-requisicao';
import { SemPermissaoException } from '../comum/erros/excecoes';
import { FilaService } from '../fila/fila.service';
import { Prisma, type ReguaEtapa } from '../generated/prisma/client';
import { NotificacoesService } from '../notificacoes/notificacoes.service';
import { PrismaService } from '../prisma/prisma.service';
import { travarChave } from '../prisma/travas';
import { dataLocal } from '../atividades/fuso-horario';
import { ContratosService } from './contratos.service';
import {
  deDataDoBanco,
  diasEntre,
  hojeLocal,
  minutosDoHorario,
  paraDataDoBanco,
  somarDias,
} from './datas';
import {
  AGENDA_DA_REGUA,
  DESCRICAO_DO_ATOR_DA_REGUA,
  FILA_REGUA_AGENDA,
  FUSO_DO_FINANCEIRO,
} from './financeiro.constantes';
import { ParcelasService, relacionadosDe } from './parcelas.service';
import { podeGerenciarARegua } from './permissoes-financeiro';
import {
  type ConfiguracaoDaRegua,
  ReguaConfiguracaoService,
  rotuloDoMarco,
} from './regua-configuracao.service';
import { ReguaEnvioService } from './regua-envio.service';
import {
  ReguaLigacoesService,
  TIPO_NOTIFICACAO_PROMESSA,
} from './regua-ligacoes.service';
import { TempoRealFinanceiro } from './tempo-real-financeiro.service';

export interface ResumoDaExecucao {
  titulos: number;
  etapas: number;
  mensagens: number;
  ligacoes: number;
  pulados: number;
  avisosDePromessa: number;
  atrasadas: number;
  contratosRenovados: number;
  contratosEncerrados: number;
  erros: number;
}

const LOTE = 200;

/**
 * Régua de cobrança (R24): a cada 15 minutos o cron confere se chegou o horário
 * configurado (padrão 09:00, America/Sao_Paulo) e executa a régua do dia uma vez;
 * "Executar agora" roda sob demanda. Cada título em aberto recebe a etapa do seu
 * marco (dias a partir do vencimento); quem entra atrasado recebe só a etapa mais
 * recente, e as que passaram além da tolerância são puladas (R24.3).
 */
@Injectable()
export class ReguaService implements OnModuleInit {
  private readonly logger = new Logger('ReguaDeCobranca');

  constructor(
    private readonly prisma: PrismaService,
    private readonly fila: FilaService,
    private readonly auditoria: AuditoriaService,
    private readonly notificacoes: NotificacoesService,
    private readonly configuracao: ReguaConfiguracaoService,
    private readonly envios: ReguaEnvioService,
    private readonly ligacoes: ReguaLigacoesService,
    private readonly parcelas: ParcelasService,
    private readonly contratos: ContratosService,
    private readonly tempoReal: TempoRealFinanceiro,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.fila.trabalhar(
      FILA_REGUA_AGENDA,
      async () => {
        await this.tique();
      },
      {
        tentativas: 0,
        prazoDeExecucaoSegundos: 15 * 60,
        guardarConcluidosPorSegundos: 24 * 3600,
      },
    );
    await this.fila.agendar(FILA_REGUA_AGENDA, AGENDA_DA_REGUA);
  }

  /**
   * Passo do cron (a cada 15 min): marca atrasos, expira ligações sem resultado e,
   * se já passou o horário da régua e hoje ainda não rodou, executa a do dia.
   */
  async tique(agora: Date = new Date()): Promise<{ executou: boolean }> {
    await executarComoAtor(
      { tipoAtor: 'SISTEMA', descricao: 'Agenda do Financeiro' },
      async () => {
        await this.parcelas.marcarAtrasadas(hojeLocal(agora));
        await this.ligacoes.expirar(agora);
      },
    );
    const config = await this.configuracao.configuracao();
    if (!config.ativa) return { executou: false };
    const local = dataLocal(agora, FUSO_DO_FINANCEIRO);
    if (local.hora * 60 + local.minuto < minutosDoHorario(config.horario)) {
      return { executou: false };
    }
    const resultado = await this.executar('AUTOMATICA', null, agora);
    return { executou: resultado !== null };
  }

  /** "Executar agora" (R24.2): só a gestão. */
  async executarAgora(usuario: UsuarioAutenticado) {
    if (!podeGerenciarARegua(usuario)) {
      throw new SemPermissaoException(
        'Só Admin, C-level e Líder de CS executam a régua.',
        { regra: 'R22.1' },
      );
    }
    const execucao = await this.executar('MANUAL', usuario);
    return execucao;
  }

  /**
   * Executa a régua do dia. Automática: uma por dia (índice único); devolve `null`
   * se hoje já rodou. Tudo roda com o ator AUTOMACAO "Régua de cobrança".
   */
  async executar(
    tipo: 'AUTOMATICA' | 'MANUAL',
    usuario: UsuarioAutenticado | null,
    agora: Date = new Date(),
  ) {
    const hoje = hojeLocal(agora);
    let execucao;
    try {
      execucao = await this.prisma.reguaExecucao.create({
        data: {
          tipo,
          dia: paraDataDoBanco(hoje),
          disparadaPorId: usuario?.id ?? null,
        },
      });
    } catch (erro) {
      if (
        erro instanceof Prisma.PrismaClientKnownRequestError &&
        erro.code === 'P2002'
      ) {
        return null;
      }
      throw erro;
    }
    const resumo: ResumoDaExecucao = {
      titulos: 0,
      etapas: 0,
      mensagens: 0,
      ligacoes: 0,
      pulados: 0,
      avisosDePromessa: 0,
      atrasadas: 0,
      contratosRenovados: 0,
      contratosEncerrados: 0,
      erros: 0,
    };
    this.tempoReal.regua({
      execucaoId: execucao.id,
      status: 'EM_ANDAMENTO',
      resumo: { ...resumo },
    });
    let erroGeral: string | null = null;
    try {
      await executarComoAtor(
        { tipoAtor: 'AUTOMACAO', descricao: DESCRICAO_DO_ATOR_DA_REGUA },
        () => this.rodar(execucao.id, hoje, agora, resumo),
      );
    } catch (erro) {
      erroGeral = erro instanceof Error ? erro.message : String(erro);
      this.logger.error(
        `Execução da régua ${execucao.id} falhou: ${erroGeral}`,
      );
    }
    const final = await this.prisma.$transaction(async (tx) => {
      const f = await tx.reguaExecucao.update({
        where: { id: execucao.id },
        data: {
          status: erroGeral ? 'FALHOU' : 'CONCLUIDA',
          erro: erroGeral,
          resumo: { ...resumo },
          concluidaEm: new Date(),
        },
      });
      await executarComoAtor(
        { tipoAtor: 'AUTOMACAO', descricao: DESCRICAO_DO_ATOR_DA_REGUA },
        () =>
          this.auditoria.registrar(tx, {
            acao:
              tipo === 'MANUAL'
                ? 'regua.executada_manualmente'
                : 'regua.executada',
            entidade: 'regua',
            entidadeId: execucao.id,
            resumo: `Régua de cobrança ${tipo === 'MANUAL' ? `executada por ${usuario?.nome ?? '—'}` : 'executada'}: ${resumo.titulos} títulos, ${resumo.mensagens} mensagens, ${resumo.ligacoes} ligações, ${resumo.pulados} puladas`,
            dados: { ...resumo, dia: hoje, erro: erroGeral, regra: 'R24.2' },
          }),
      );
      return f;
    });
    this.tempoReal.regua({
      execucaoId: final.id,
      status: final.status,
      resumo: { ...resumo },
    });
    return final;
  }

  private async rodar(
    execucaoId: string,
    hoje: string,
    agora: Date,
    resumo: ResumoDaExecucao,
  ): Promise<void> {
    const config = await this.configuracao.configuracao();
    const renovacao = await this.contratos.processarVencimentos(hoje);
    resumo.contratosRenovados = renovacao.renovados;
    resumo.contratosEncerrados = renovacao.encerrados;
    resumo.atrasadas = await this.parcelas.marcarAtrasadas(hoje);
    const agenda = await this.envios.proximoHorarioDeWhatsapp();
    await this.promessasVencidas(
      execucaoId,
      hoje,
      config,
      agenda.proximo,
      resumo,
    );
    const etapas = (await this.configuracao.todasAsEtapas()).filter(
      (e) => e.ativa,
    );
    if (etapas.length === 0) return;
    const menorMarco = etapas[0].marco;
    const prazoDaLigacao = await this.ligacoes.prazoDaLigacao(agora);
    let cursor: string | undefined;
    for (;;) {
      const lote = await this.prisma.parcela.findMany({
        where: {
          status: { in: ['ABERTO', 'ATRASADO'] },
          vencimento: { lte: paraDataDoBanco(somarDias(hoje, -menorMarco)) },
          OR: [
            { promessaAte: null },
            { promessaAte: { lt: paraDataDoBanco(hoje) } },
          ],
        },
        orderBy: { id: 'asc' },
        take: LOTE,
        select: { id: true },
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      });
      if (lote.length === 0) break;
      cursor = lote.at(-1)?.id;
      for (const { id } of lote) {
        try {
          await this.processarParcela(id, {
            execucaoId,
            hoje,
            etapas,
            config,
            agenda: agenda.proximo,
            prazoDaLigacao,
            resumo,
          });
        } catch (erro) {
          resumo.erros++;
          this.logger.warn(
            `Título ${id}: ${erro instanceof Error ? erro.message : String(erro)}`,
          );
        }
      }
      this.tempoReal.regua({
        execucaoId,
        status: 'EM_ANDAMENTO',
        resumo: { ...resumo },
      });
    }
  }

  /** Promessa vencida sem pagamento: avisa o cliente e o CS, e a régua continua (R24.5). */
  private async promessasVencidas(
    execucaoId: string,
    hoje: string,
    config: ConfiguracaoDaRegua,
    agendarWhatsapp: () => Date,
    resumo: ResumoDaExecucao,
  ): Promise<void> {
    const vencidas = await this.prisma.parcela.findMany({
      where: {
        status: { in: ['ABERTO', 'ATRASADO'] },
        promessaAte: { lt: paraDataDoBanco(hoje) },
      },
      include: {
        contrato: {
          select: { id: true, produto: true, responsavelCsId: true },
        },
      },
    });
    for (const p of vencidas) {
      try {
        const contato = await this.envios.contatoDeCobranca(p);
        await this.prisma.$transaction(async (tx) => {
          await travarChave(tx, 'regua-parcela', p.id);
          await tx.$queryRaw`SELECT id FROM parcelas WHERE id = ${p.id}::uuid FOR UPDATE`;
          const atual = await tx.parcela.findUniqueOrThrow({
            where: { id: p.id },
          });
          if (!atual.promessaAte || deDataDoBanco(atual.promessaAte) >= hoje)
            return;
          if (atual.status !== 'ABERTO' && atual.status !== 'ATRASADO') return;
          const prometida = deDataDoBanco(atual.promessaAte);
          await tx.parcela.update({
            where: { id: p.id },
            data: { promessaAte: null },
          });
          let avisos = 0;
          if (contato) {
            avisos = await this.envios.criarAviso(tx, {
              parcela: atual,
              contato,
              produto: p.contrato?.produto ?? null,
              tipo: 'PROMESSA_NAO_CUMPRIDA',
              nome: 'Promessa não cumprida',
              texto: config.textoPromessaNaoCumprida,
              assuntoEmail:
                'Pagamento da parcela {{titulo.numero}} não identificado',
              promessaAte: prometida,
              execucaoId,
              hoje,
              agendarWhatsapp,
            });
          }
          const avisar = p.contrato?.responsavelCsId ?? contato?.responsavelId;
          if (avisar) {
            await this.notificacoes.notificar(tx, avisar, {
              tipo: TIPO_NOTIFICACAO_PROMESSA,
              titulo: 'Promessa de pagamento não cumprida',
              texto: `${contato?.nome ?? 'Cliente'} prometeu pagar o título ${p.numero} em ${prometida} e não pagou.`,
              link: `/financeiro/parcelas?parcela=${p.id}`,
              dados: { parcelaId: p.id },
            });
          }
          await this.auditoria.registrar(tx, {
            acao: 'regua.promessa_nao_cumprida',
            entidade: 'parcela',
            entidadeId: p.id,
            resumo: `Promessa do título ${p.numero} (${prometida}) não cumprida: o cliente foi avisado e a régua continua`,
            dados: { promessaAte: prometida, avisos, regra: 'R24.5' },
            relacionados: relacionadosDe(p),
          });
          resumo.avisosDePromessa++;
          resumo.mensagens += avisos;
        });
      } catch (erro) {
        resumo.erros++;
        this.logger.warn(
          `Promessa do título ${p.id}: ${erro instanceof Error ? erro.message : String(erro)}`,
        );
      }
    }
  }

  /** Aplica a régua a um título (R24.3): etapa mais recente, tolerância, canais. */
  private async processarParcela(
    parcelaId: string,
    c: {
      execucaoId: string;
      hoje: string;
      etapas: ReguaEtapa[];
      config: ConfiguracaoDaRegua;
      agenda: () => Date;
      prazoDaLigacao: Date;
      resumo: ResumoDaExecucao;
    },
  ): Promise<void> {
    const parcela = await this.prisma.parcela.findUnique({
      where: { id: parcelaId },
      include: {
        contrato: { select: { id: true, numero: true, produto: true } },
      },
    });
    if (
      !parcela ||
      (parcela.status !== 'ABERTO' && parcela.status !== 'ATRASADO')
    )
      return;
    if (parcela.promessaAte && deDataDoBanco(parcela.promessaAte) >= c.hoje)
      return;
    c.resumo.titulos++;
    const offset = diasEntre(deDataDoBanco(parcela.vencimento), c.hoje);
    const registrados = await this.marcosRegistrados(
      parcela.id,
      parcela.cicloRegua,
    );
    const candidatas = c.etapas.filter(
      (e) => e.marco <= offset && !registrados.has(e.marco),
    );
    if (candidatas.length === 0) return;
    const maisRecente = candidatas[candidatas.length - 1];
    const superadas = candidatas.slice(0, -1);
    const atraso = offset - maisRecente.marco;
    const dentroDaTolerancia = atraso <= c.config.toleranciaDias;

    // Preparação fora da transação (leituras e renderização).
    const contato = dentroDaTolerancia
      ? await this.envios.contatoDeCobranca(parcela)
      : null;
    const mensagens = new Map<
      'WHATSAPP' | 'EMAIL',
      Awaited<ReturnType<ReguaEnvioService['prepararDaEtapa']>>
    >();
    let responsavelId: string | null = null;
    if (contato) {
      for (const canal of ['WHATSAPP', 'EMAIL'] as const) {
        if (canal === 'WHATSAPP' ? maisRecente.whatsapp : maisRecente.email) {
          mensagens.set(
            canal,
            await this.envios.prepararDaEtapa(
              maisRecente,
              canal,
              parcela,
              contato,
              parcela.contrato?.produto ?? null,
              c.hoje,
            ),
          );
        }
      }
      if (maisRecente.ligacao && contato.telefone) {
        responsavelId = await this.ligacoes.responsavelDaLigacao(
          parcela.contratoId,
          contato,
        );
      }
    }

    const dia = paraDataDoBanco(c.hoje);
    await this.prisma.$transaction(async (tx) => {
      await travarChave(tx, 'regua-parcela', parcela.id);
      await tx.$queryRaw`SELECT id FROM parcelas WHERE id = ${parcela.id}::uuid FOR UPDATE`;
      const atual = await tx.parcela.findUniqueOrThrow({
        where: { id: parcela.id },
      });
      if (
        (atual.status !== 'ABERTO' && atual.status !== 'ATRASADO') ||
        atual.cicloRegua !== parcela.cicloRegua
      )
        return;
      const jaFeitos = new Set(
        (
          await tx.reguaEnvio.findMany({
            where: {
              parcelaId: parcela.id,
              ciclo: atual.cicloRegua,
              tipo: 'ETAPA',
              marco: { not: null },
            },
            select: { marco: true },
          })
        ).map((e) => e.marco),
      );
      if (jaFeitos.has(maisRecente.marco)) return;
      const base = {
        parcelaId: parcela.id,
        ciclo: atual.cicloRegua,
        tipo: 'ETAPA',
        dia,
        execucaoId: c.execucaoId,
      } as const;
      for (const e of superadas.filter((s) => !jaFeitos.has(s.marco))) {
        await tx.reguaEnvio.create({
          data: {
            ...base,
            etapaId: e.id,
            marco: e.marco,
            etapaNome: e.nome,
            situacao: 'PULADO',
            motivo: `Superada pela etapa mais recente (${rotuloDoMarco(maisRecente.marco)}).`,
          },
        });
        c.resumo.pulados++;
      }
      const pular = async (motivo: string) => {
        await tx.reguaEnvio.create({
          data: {
            ...base,
            etapaId: maisRecente.id,
            marco: maisRecente.marco,
            etapaNome: maisRecente.nome,
            situacao: 'PULADO',
            motivo,
          },
        });
        c.resumo.pulados++;
        await this.auditoria.registrar(tx, {
          acao: 'regua.etapa_pulada',
          entidade: 'parcela',
          entidadeId: parcela.id,
          resumo: `Régua: etapa "${maisRecente.nome}" (${rotuloDoMarco(maisRecente.marco)}) pulada no título ${parcela.numero}: ${motivo}`,
          dados: { marco: maisRecente.marco, motivo, regra: 'R24.3' },
          relacionados: relacionadosDe(parcela),
        });
      };
      if (!dentroDaTolerancia) {
        await pular(
          `Além da tolerância de ${c.config.toleranciaDias} dia(s) (atraso de ${atraso} dia(s) na etapa).`,
        );
        return;
      }
      if (!contato) {
        await pular('Título sem contato para cobrança.');
        return;
      }
      c.resumo.etapas++;
      let ligacaoId: string | null = null;
      if (maisRecente.ligacao) {
        if (responsavelId) {
          const ligacao = await this.ligacoes.criarLigacao(tx, {
            parcela: atual,
            etapa: maisRecente,
            contato,
            contrato: parcela.contrato,
            execucaoId: c.execucaoId,
            hoje: c.hoje,
            diasEmAtraso: offset,
            prazoEm: c.prazoDaLigacao,
            responsavelId,
          });
          ligacaoId = ligacao.id;
          c.resumo.ligacoes++;
        } else {
          await tx.reguaEnvio.create({
            data: {
              ...base,
              etapaId: maisRecente.id,
              marco: maisRecente.marco,
              etapaNome: maisRecente.nome,
              canal: 'LIGACAO',
              situacao: 'PULADO',
              motivo: 'Cliente sem telefone para ligar.',
            },
          });
        }
      }
      for (const [canal, m] of mensagens) {
        if (m.pular) {
          await tx.reguaEnvio.create({
            data: {
              ...base,
              etapaId: maisRecente.id,
              marco: maisRecente.marco,
              etapaNome: maisRecente.nome,
              canal,
              situacao: 'PULADO',
              motivo: m.pular,
            },
          });
          c.resumo.pulados++;
          continue;
        }
        const retido = ligacaoId !== null;
        const agendadoPara = canal === 'WHATSAPP' ? c.agenda() : new Date();
        const envio = await tx.reguaEnvio.create({
          data: {
            ...base,
            etapaId: maisRecente.id,
            marco: maisRecente.marco,
            etapaNome: maisRecente.nome,
            canal,
            situacao: retido ? 'RETIDO' : 'AGENDADO',
            destino: m.destino,
            assunto: m.assunto,
            texto: m.texto,
            agendadoPara: retido ? null : agendadoPara,
            ligacaoId,
          },
        });
        if (!retido) {
          await this.envios.enfileirar(
            tx,
            envio,
            canal === 'WHATSAPP' ? agendadoPara : undefined,
          );
        }
        c.resumo.mensagens++;
      }
      await this.auditoria.registrar(tx, {
        acao: 'regua.etapa_executada',
        entidade: 'parcela',
        entidadeId: parcela.id,
        resumo: `Régua: etapa "${maisRecente.nome}" (${rotuloDoMarco(maisRecente.marco)}) aplicada ao título ${parcela.numero}`,
        dados: {
          marco: maisRecente.marco,
          canais: [...mensagens.keys(), ...(ligacaoId ? ['LIGACAO'] : [])],
          diasEmAtraso: offset,
          execucaoId: c.execucaoId,
          regra: 'R24.3',
        },
        relacionados: relacionadosDe(parcela),
      });
    });
  }

  private async marcosRegistrados(
    parcelaId: string,
    ciclo: number,
  ): Promise<Set<number>> {
    const linhas = await this.prisma.reguaEnvio.findMany({
      where: { parcelaId, ciclo, tipo: 'ETAPA', marco: { not: null } },
      select: { marco: true },
    });
    return new Set(linhas.flatMap((l) => (l.marco === null ? [] : [l.marco])));
  }
}
