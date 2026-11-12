import { readFile, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { PapelDaConexao } from '../../banco/papel-da-aplicacao';
import { AMBIENTE, type Ambiente } from '../../config/ambiente';
import { PrismaService } from '../../prisma/prisma.service';
import { ClienteWhisper } from '../../transcricao/cliente-whisper';
import {
  FILA_PROCESSAR_LIGACAO,
  FILA_RESUMIR_LIGACAO,
} from '../../transcricao/transcricao.constantes';
import {
  type Alerta,
  alertaDaTranscricao,
  alertaDoPapelDoBanco,
  alertaDoGateway,
  alertasDeBackup,
  alertasDeCanais,
  alertasDeDisco,
  alertasDeFilas,
  alertasDeNumeros,
  avaliarBackup,
  avaliarDisco,
  avaliarFila,
  canalComErroRecente,
  type FatosDeCanal,
  type FatosDeFila,
  type FatosDeNumero,
  numeroDesconectado,
  situacaoGeral,
  type StatusDoNumero,
} from './avaliacao';
import type { SaudeDoSistemaDto } from './saude-do-sistema.dto';

const PRAZO_DO_GATEWAY_MS = 3_000;
const ERROS_RECENTES = 10;
const MAXIMO_DE_FILAS = 200;

interface LinhaDeFila {
  name: string;
  pendentes: bigint;
  ativas: bigint;
  falhas: bigint;
  mais_antiga: Date | null;
  ativa_desde: Date | null;
}

/** Os fatos crus do sistema, antes de virarem alerta. */
export interface FatosDoSistema {
  filas: FatosDeFila[] | null;
  gateway: SaudeDoGatewayLida | null;
  /** Serviço de transcrição (R30). */
  transcricao: 'ok' | 'fora_do_ar' | 'desativada';
  numeros: FatosDeNumero[];
  canais: (FatosDeCanal & { ativo: boolean })[];
  errosTotal24h: number;
  errosRecentes: {
    id: string;
    criadoEm: Date;
    contexto: string;
    mensagem: string;
  }[];
  disco: { caminho: string; total: number; livre: number } | null;
  bancoBytes: number | null;
  backupTexto: string | null;
  /** R35.1: o papel com que a API conecta ao banco (`null` = não deu para ler). */
  papelDoBanco?: PapelDaConexao | null;
}

export interface SaudeDoGatewayLida {
  status: 'ok' | 'degradado';
  simulado: boolean;
}

/**
 * Painel "Saúde do sistema" (R27): junta filas, gateway e números de WhatsApp,
 * canais, erros recentes, disco e último backup, e decide quais são alertas.
 * Cada fonte que falha vira "indisponível" no painel, nunca derruba a consulta.
 */
@Injectable()
export class SaudeDoSistemaService {
  private readonly logger = new Logger(SaudeDoSistemaService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(AMBIENTE) private readonly ambiente: Ambiente,
    private readonly whisper: ClienteWhisper,
  ) {}

  async consultar(
    emailConfigurado: boolean,
    agora: Date = new Date(),
  ): Promise<{ painel: SaudeDoSistemaDto; alertas: Alerta[] }> {
    const fatos = await this.coletar();
    return this.montar(fatos, emailConfigurado, agora);
  }

  /** Produção rodando com segredo de desenvolvimento por escolha explícita (U4): alerta alto na tela. */
  private alertasDeConfiguracao(): Alerta[] {
    if (
      !this.ambiente.producao ||
      !this.ambiente.permitirSegredosDeDesenvolvimento
    ) {
      return [];
    }
    return [
      {
        chave: 'configuracao:segredos_de_desenvolvimento',
        codigo: 'segredos_de_desenvolvimento',
        gravidade: 'critico',
        titulo: 'Segredos de desenvolvimento em produção',
        detalhe:
          'PERMITIR_SEGREDOS_DE_DESENVOLVIMENTO=true: a API subiu mesmo com chave, token ou senha públicos de desenvolvimento.',
        dica: 'Defina valores próprios (veja o README, "Variáveis de ambiente") e remova PERMITIR_SEGREDOS_DE_DESENVOLVIMENTO. Não use dados reais enquanto isso.',
        porEmail: false,
      },
    ];
  }

  /** Só a parte pura: dos fatos ao painel e aos alertas. */
  montar(
    fatos: FatosDoSistema,
    emailConfigurado: boolean,
    agora: Date,
  ): { painel: SaudeDoSistemaDto; alertas: Alerta[] } {
    const filas = (fatos.filas ?? []).map((f) => avaliarFila(f, agora));
    const backup = avaliarBackup(fatos.backupTexto, agora);
    const disco = fatos.disco
      ? avaliarDisco(fatos.disco.caminho, fatos.disco.total, fatos.disco.livre)
      : null;
    const numerosAtivos = fatos.numeros.filter((n) => n.canalAtivo).length;
    const alertas = [
      ...alertasDeNumeros(fatos.numeros, agora),
      ...alertaDoGateway(fatos.gateway === null, numerosAtivos),
      ...alertaDaTranscricao(fatos.transcricao === 'fora_do_ar'),
      ...alertasDeFilas(filas),
      ...alertasDeBackup(backup),
      ...alertasDeCanais(
        fatos.canais.filter((c) => c.ativo),
        agora,
      ),
      ...alertasDeDisco(disco),
      ...this.alertasDeConfiguracao(),
      ...alertaDoPapelDoBanco(fatos.papelDoBanco),
    ].sort(
      (a, b) =>
        Number(b.gravidade === 'critico') - Number(a.gravidade === 'critico'),
    );
    const filasDaTranscricao = filas.filter(
      (f) =>
        f.nome === FILA_PROCESSAR_LIGACAO || f.nome === FILA_RESUMIR_LIGACAO,
    );
    const paradas = filas
      .map((f) => f.maisAntigaParadaSegundos)
      .filter((v): v is number => v !== null);
    const painel: SaudeDoSistemaDto = {
      geradoEm: agora.toISOString(),
      situacao: situacaoGeral(alertas),
      alertas,
      filas: {
        disponivel: fatos.filas !== null,
        itens: filas.map((f) => ({
          nome: f.nome,
          pendentes: f.pendentes,
          ativas: f.ativas,
          falhasRecentes: f.falhasRecentes,
          maisAntigaParadaSegundos: f.maisAntigaParadaSegundos,
          travada: f.travada,
        })),
        totalPendentes: filas.reduce((s, f) => s + f.pendentes, 0),
        totalAtivas: filas.reduce((s, f) => s + f.ativas, 0),
        totalFalhasRecentes: filas.reduce((s, f) => s + f.falhasRecentes, 0),
        maisAntigaParadaSegundos: paradas.length ? Math.max(...paradas) : null,
      },
      gateway: {
        status: fatos.gateway?.status ?? 'fora_do_ar',
        simulado: fatos.gateway?.simulado ?? this.ambiente.whatsapp.simulado,
      },
      transcricao: {
        situacao: fatos.transcricao,
        modelo: this.ambiente.transcricao.modelo,
        pendentes: filasDaTranscricao.reduce((s, f) => s + f.pendentes, 0),
        ativas: filasDaTranscricao.reduce((s, f) => s + f.ativas, 0),
        falhasRecentes: filasDaTranscricao.reduce(
          (s, f) => s + f.falhasRecentes,
          0,
        ),
      },
      numeros: fatos.numeros.map((n) => ({
        id: n.id,
        nome: n.nome,
        telefone: n.telefone,
        status: n.status,
        motivo: n.motivo,
        canalAtivo: n.canalAtivo,
        pausado: n.pausado,
        comProblema: numeroDesconectado(n, agora),
        desconectadoEm: n.desconectadoEm?.toISOString() ?? null,
      })),
      canais: fatos.canais.map((c) => ({
        id: c.id,
        tipo: c.tipo,
        nome: c.nome,
        ativo: c.ativo,
        ultimoErro: c.ultimoErro,
        ultimoErroEm: c.ultimoErroEm?.toISOString() ?? null,
        comErroRecente: canalComErroRecente(c, agora),
      })),
      erros: {
        total24h: fatos.errosTotal24h,
        recentes: fatos.errosRecentes.map((e) => ({
          id: e.id,
          criadoEm: e.criadoEm.toISOString(),
          contexto: e.contexto,
          mensagem: e.mensagem.slice(0, 300),
        })),
      },
      disco: disco ? { ...disco, bancoBytes: fatos.bancoBytes } : null,
      backup: {
        situacao: backup.situacao,
        ultimo: backup.ultimo,
        idadeHoras: backup.idadeHoras,
      },
      emailConfigurado,
    };
    return { painel, alertas };
  }

  async coletar(): Promise<FatosDoSistema> {
    const [
      filas,
      gateway,
      transcricao,
      numeros,
      canais,
      erros,
      disco,
      bancoBytes,
      backup,
      papelDoBanco,
    ] = await Promise.all([
      this.coletarFilas(),
      this.coletarGateway(),
      this.whisper.saude(),
      this.coletarNumeros(),
      this.coletarCanais(),
      this.coletarErros(),
      this.coletarDisco(),
      this.coletarTamanhoDoBanco(),
      this.lerBackup(),
      this.prisma.papelDaConexao().catch(() => null),
    ]);
    return {
      filas,
      gateway,
      transcricao,
      numeros,
      canais,
      errosTotal24h: erros.total,
      errosRecentes: erros.recentes,
      disco,
      bancoBytes,
      backupTexto: backup,
      papelDoBanco,
    };
  }

  private async coletarFilas(): Promise<FatosDeFila[] | null> {
    try {
      const linhas = await this.prisma.$queryRaw<LinhaDeFila[]>`
        SELECT name,
               count(*) FILTER (WHERE state::text IN ('created', 'retry') AND start_after <= now()) AS pendentes,
               count(*) FILTER (WHERE state::text = 'active') AS ativas,
               count(*) FILTER (WHERE state::text = 'failed' AND completed_on > now() - interval '24 hours') AS falhas,
               min(start_after) FILTER (WHERE state::text IN ('created', 'retry') AND start_after <= now()) AS mais_antiga,
               min(started_on) FILTER (WHERE state::text = 'active') AS ativa_desde
          FROM pgboss.job
         GROUP BY name
         ORDER BY name
         LIMIT ${MAXIMO_DE_FILAS}`;
      return linhas.map((l) => ({
        nome: l.name,
        pendentes: Number(l.pendentes),
        ativas: Number(l.ativas),
        falhasRecentes: Number(l.falhas),
        maisAntigaDesde: l.mais_antiga,
        ativaDesde: l.ativa_desde,
      }));
    } catch (erro) {
      this.logger.warn(
        `Filas indisponíveis para o painel: ${mensagemDe(erro)}`,
      );
      return null;
    }
  }

  private async coletarGateway(): Promise<SaudeDoGatewayLida | null> {
    try {
      const url = new URL('/saude', this.ambiente.whatsapp.urlInterna);
      const resposta = await fetch(url, {
        signal: AbortSignal.timeout(PRAZO_DO_GATEWAY_MS),
      });
      const corpo = (await resposta.json()) as {
        status?: string;
        simulado?: boolean;
      };
      return {
        status: resposta.ok && corpo.status === 'ok' ? 'ok' : 'degradado',
        simulado: corpo.simulado === true,
      };
    } catch {
      return null;
    }
  }

  private async coletarNumeros(): Promise<FatosDeNumero[]> {
    const numeros = await this.prisma.whatsappNumero.findMany({
      where: { canal: { excluidoEm: null } },
      include: { canal: { select: { ativo: true } } },
      orderBy: { nome: 'asc' },
    });
    return numeros.map((n) => ({
      id: n.id,
      nome: n.nome,
      telefone: n.telefone,
      status: n.status as StatusDoNumero,
      motivo: n.motivo,
      canalAtivo: n.canal.ativo,
      pausado: n.pausadoEm !== null,
      conectadoEm: n.conectadoEm,
      desconectadoEm: n.desconectadoEm,
      ultimoEventoEm: n.ultimoEventoEm,
    }));
  }

  private async coletarCanais(): Promise<
    (FatosDeCanal & { ativo: boolean })[]
  > {
    const canais = await this.prisma.canal.findMany({
      where: { excluidoEm: null, tipo: { not: 'WHATSAPP' } },
      select: {
        id: true,
        tipo: true,
        nome: true,
        ativo: true,
        ultimoErro: true,
        ultimoErroEm: true,
      },
      orderBy: [{ tipo: 'asc' }, { nome: 'asc' }],
    });
    return canais;
  }

  private async coletarErros(): Promise<{
    total: number;
    recentes: FatosDoSistema['errosRecentes'];
  }> {
    const desde = new Date(Date.now() - 24 * 3_600_000);
    const [total, recentes] = await Promise.all([
      this.prisma.logTecnico.count({
        where: { nivel: 'ERRO', criadoEm: { gte: desde } },
      }),
      this.prisma.logTecnico.findMany({
        where: { nivel: 'ERRO' },
        orderBy: { id: 'desc' },
        take: ERROS_RECENTES,
        select: { id: true, criadoEm: true, contexto: true, mensagem: true },
      }),
    ]);
    return {
      total,
      recentes: recentes.map((e) => ({ ...e, id: e.id.toString() })),
    };
  }

  /** O volume dos backups (mesmo disco dos dados); sem ele, a raiz do contêiner. */
  private async coletarDisco(): Promise<FatosDoSistema['disco']> {
    for (const caminho of [this.ambiente.backupDir, process.cwd()]) {
      try {
        const info = await statfs(caminho);
        const total = Number(info.blocks) * Number(info.bsize);
        const livre = Number(info.bavail) * Number(info.bsize);
        return { caminho, total, livre };
      } catch {
        // tenta o próximo
      }
    }
    return null;
  }

  private async coletarTamanhoDoBanco(): Promise<number | null> {
    try {
      const [linha] = await this.prisma.$queryRaw<
        { tamanho: bigint }[]
      >`SELECT pg_database_size(current_database()) AS tamanho`;
      return linha ? Number(linha.tamanho) : null;
    } catch {
      return null;
    }
  }

  /** O texto de `ultimo.json`, ou `null` se não existe (ou não dá para ler). */
  private async lerBackup(): Promise<string | null> {
    try {
      return await readFile(join(this.ambiente.backupDir, 'ultimo.json'), {
        encoding: 'utf8',
      });
    } catch {
      return null;
    }
  }
}

function mensagemDe(erro: unknown): string {
  return erro instanceof Error ? erro.message : String(erro);
}
