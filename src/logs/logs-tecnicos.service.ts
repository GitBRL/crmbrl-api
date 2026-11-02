import { Injectable, Logger } from '@nestjs/common';
import { contextoAtual } from '../comum/contexto/contexto-requisicao';
import { sanitizarObjeto } from '../comum/dados/sanitizar';
import type { NivelLog, Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface DadosHttpDoLog {
  metodo?: string;
  rota?: string;
  status?: number;
  duracaoMs?: number;
}

export interface EntradaLogTecnico {
  nivel: NivelLog;
  /** Origem: `HTTP`, `Fila:<nome>`, `Eventos`, `Email`, `Auth`… */
  contexto: string;
  mensagem: string;
  dados?: Record<string, unknown>;
  /** Erro capturado: nome, mensagem e pilha vão para `dados.erro`. */
  erro?: unknown;
  http?: DadosHttpDoLog;
}

/** Tamanho máximo da pilha de erro gravada. */
const TAMANHO_MAXIMO_PILHA = 4_000;

/**
 * Logs técnicos no banco (R3.6): erros 5xx, avisos e falhas de jobs, para o
 * Admin consultar. Cada registro também vai para o log do console.
 *
 * A gravação nunca falha para quem chama: se o banco estiver fora, o problema
 * fica só no console. Id da requisição e usuário vêm do contexto.
 *
 * ```ts
 * await this.logs.aviso('Webhooks', 'Destino desativado após 20 falhas', { webhookId });
 * await this.logs.erro('Fila:emails', 'Falha ao enviar', erro, { para });
 * ```
 */
@Injectable()
export class LogsTecnicosService {
  private readonly logger = new Logger('LogsTecnicos');

  constructor(private readonly prisma: PrismaService) {}

  aviso(
    contexto: string,
    mensagem: string,
    dados?: Record<string, unknown>,
  ): Promise<void> {
    return this.registrar({ nivel: 'AVISO', contexto, mensagem, dados });
  }

  erro(
    contexto: string,
    mensagem: string,
    erro?: unknown,
    dados?: Record<string, unknown>,
  ): Promise<void> {
    return this.registrar({ nivel: 'ERRO', contexto, mensagem, erro, dados });
  }

  async registrar(entrada: EntradaLogTecnico): Promise<void> {
    const contexto = contextoAtual();
    const dados = sanitizarObjeto({
      ...entrada.dados,
      ...(entrada.erro !== undefined ? { erro: descreverErro(entrada.erro) } : {}),
    });
    this.escreverNoConsole(entrada, contexto.requisicaoId);
    try {
      await this.prisma.logTecnico.create({
        data: {
          nivel: entrada.nivel,
          contexto: entrada.contexto,
          mensagem: entrada.mensagem.slice(0, 2_000),
          dados: dados && Object.keys(dados).length > 0 ? (dados as Prisma.InputJsonObject) : undefined,
          requisicaoId: contexto.requisicaoId,
          usuarioId: contexto.usuario?.id,
          metodo: entrada.http?.metodo,
          rota: entrada.http?.rota,
          status: entrada.http?.status,
          duracaoMs: entrada.http?.duracaoMs,
        },
      });
    } catch (falha) {
      this.logger.warn(
        `Não foi possível gravar o log técnico no banco: ${falha instanceof Error ? falha.message : String(falha)}`,
      );
    }
  }

  private escreverNoConsole(entrada: EntradaLogTecnico, requisicaoId: string): void {
    const parametros = {
      contexto: entrada.contexto,
      requisicaoId,
      ...(entrada.http ?? {}),
    };
    const mensagem = `[${entrada.contexto}] ${entrada.mensagem}`;
    switch (entrada.nivel) {
      case 'ERRO':
        this.logger.error(mensagem, pilhaDe(entrada.erro), parametros);
        break;
      case 'AVISO':
        this.logger.warn(mensagem, parametros);
        break;
      case 'INFO':
        this.logger.log(mensagem, parametros);
        break;
      default:
        this.logger.debug(mensagem, parametros);
    }
  }
}

/** Nome, mensagem, código e pilha (cortada) de um erro, para `dados.erro`. */
export function descreverErro(erro: unknown): Record<string, unknown> {
  if (erro instanceof Error) {
    const codigo = (erro as { code?: unknown }).code;
    return {
      nome: erro.name,
      mensagem: erro.message,
      ...(typeof codigo === 'string' ? { codigo } : {}),
      pilha: erro.stack?.slice(0, TAMANHO_MAXIMO_PILHA),
    };
  }
  return { mensagem: String(erro) };
}

function pilhaDe(erro: unknown): string | undefined {
  return erro instanceof Error ? erro.stack : undefined;
}
