import { Injectable } from '@nestjs/common';
import { MuitasTentativasException } from '../comum/erros/excecoes';
import type { Tx } from '../prisma/prisma.service';
import { PrismaService } from '../prisma/prisma.service';
import { travarChave } from '../prisma/travas';

/** Limites da proteção contra força bruta (R2.5). */
export const LIMITES_DE_LOGIN = {
  /** Falhas para o mesmo e-mail… */
  falhasPorEmail: 5,
  /** …dentro desta janela… */
  janelaMinutos: 15,
  /** …bloqueiam o e-mail por este tempo, mesmo com a senha certa. */
  bloqueioMinutos: 15,
  /** Tentativas sem sucesso por IP na janela. */
  tentativasPorIp: 30,
} as const;

export type MotivoTentativa =
  | 'SUCESSO'
  | 'SENHA_INCORRETA'
  | 'USUARIO_INEXISTENTE'
  | 'SEM_SENHA'
  | 'USUARIO_DESLIGADO'
  | 'DOIS_FATORES_INCORRETO'
  | 'BLOQUEADO_EMAIL'
  | 'BLOQUEADO_IP';

/** Falhas de credencial: as que contam para o bloqueio do e-mail. */
const FALHAS_DE_CREDENCIAL: readonly MotivoTentativa[] = [
  'SENHA_INCORRETA',
  'USUARIO_INEXISTENTE',
  'SEM_SENHA',
  'DOIS_FATORES_INCORRETO',
];

export interface Bloqueio {
  readonly motivo: 'BLOQUEADO_EMAIL' | 'BLOQUEADO_IP';
  readonly ate: Date;
}

export interface NovaTentativa {
  email: string;
  ip?: string;
  usuarioId?: string | null;
  sucesso: boolean;
  motivo: MotivoTentativa;
  userAgent?: string;
}

const MINUTO_MS = 60_000;

/** Motivos de tentativa já bloqueada: ficam registrados, mas não contam no limite do IP nem renovam o bloqueio (R2.5). */
const MOTIVOS_DE_BLOQUEIO: readonly MotivoTentativa[] = [
  'BLOQUEADO_EMAIL',
  'BLOQUEADO_IP',
];

/** Resultado de `reservar`: o bloqueio em vigor ou o número da reserva da tentativa. */
export type Reserva =
  { bloqueio: Bloqueio } | { bloqueio?: undefined; reservaId: bigint };

/**
 * Proteção contra força bruta no login (R2.5).
 *
 * - **E-mail:** 5 falhas de credencial dentro de 15 minutos, sem login com
 *   sucesso entre elas, bloqueiam o e-mail por 15 minutos a partir da 5ª falha.
 *   Tentativas durante o bloqueio são registradas, mas não o prolongam.
 * - **IP:** 30 tentativas sem sucesso nos últimos 15 minutos bloqueiam o IP
 *   até a mais antiga delas sair da janela. Logins com sucesso e tentativas
 *   recusadas por já estarem bloqueadas (`BLOQUEADO_*`) não contam, e por isso
 *   não renovam o bloqueio.
 * - **Corrida:** `reservar` confere o bloqueio e grava a tentativa (como falha
 *   provisória) sob trava por IP e por e-mail, antes da verificação lenta da
 *   senha. N requisições simultâneas passam pela conferência uma de cada vez, e
 *   a falha provisória já conta para as seguintes. Quem decide o resultado
 *   apaga a reserva (`liberar`) e grava o desfecho real.
 *
 * Toda tentativa fica em `tentativas_login`.
 */
@Injectable()
export class ForcaBrutaService {
  constructor(private readonly prisma: PrismaService) {}

  /** Bloqueio em vigor para o e-mail ou o IP, ou `null`. */
  async verificar(
    email: string,
    ip: string | undefined,
    agora = new Date(),
    db: Tx = this.prisma,
  ): Promise<Bloqueio | null> {
    const ateEmail = await this.bloqueioDoEmail(email, agora, db);
    if (ateEmail) {
      return { motivo: 'BLOQUEADO_EMAIL', ate: ateEmail };
    }
    const ateIp = ip ? await this.bloqueioDoIp(ip, agora, db) : null;
    return ateIp ? { motivo: 'BLOQUEADO_IP', ate: ateIp } : null;
  }

  /**
   * Confere o bloqueio e, se não houver, grava uma falha provisória do tipo
   * `motivo` (a reserva), tudo sob trava por IP e por e-mail (R2.5). Com bloqueio,
   * registra a tentativa recusada e devolve o bloqueio.
   */
  async reservar(
    tentativa: Omit<NovaTentativa, 'sucesso' | 'motivo'>,
    motivo: 'SENHA_INCORRETA' | 'DOIS_FATORES_INCORRETO',
    agora: Date,
  ): Promise<Reserva> {
    return this.prisma.$transaction(async (tx) => {
      // Ordem fixa das travas (IP, depois e-mail) para não haver impasse.
      await travarChave(tx, 'login-ip', tentativa.ip ?? '-');
      await travarChave(tx, 'login-email', tentativa.email);
      const bloqueio = await this.verificar(
        tentativa.email,
        tentativa.ip,
        agora,
        tx,
      );
      if (bloqueio) {
        await this.registrar(tx, {
          ...tentativa,
          sucesso: false,
          motivo: bloqueio.motivo,
        });
        return { bloqueio };
      }
      const criada = await tx.tentativaLogin.create({
        data: {
          email: tentativa.email.slice(0, 320),
          ip: tentativa.ip,
          usuarioId: tentativa.usuarioId ?? null,
          sucesso: false,
          motivo,
          userAgent: tentativa.userAgent,
        },
        select: { id: true },
      });
      return { reservaId: criada.id };
    });
  }

  /** Apaga a reserva de `reservar`, na mesma transação que grava o desfecho real. */
  async liberar(tx: Tx, reservaId: bigint | undefined): Promise<void> {
    if (reservaId !== undefined) {
      await tx.tentativaLogin.deleteMany({ where: { id: reservaId } });
    }
  }

  async registrar(tx: Tx, tentativa: NovaTentativa): Promise<void> {
    await tx.tentativaLogin.create({
      data: {
        email: tentativa.email.slice(0, 320),
        ip: tentativa.ip,
        usuarioId: tentativa.usuarioId ?? null,
        sucesso: tentativa.sucesso,
        motivo: tentativa.motivo,
        userAgent: tentativa.userAgent,
      },
    });
  }

  /** Até quando o e-mail está bloqueado, ou `null`. */
  async bloqueioDoEmail(
    email: string,
    agora: Date,
    db: Tx = this.prisma,
  ): Promise<Date | null> {
    const { falhasPorEmail, janelaMinutos, bloqueioMinutos } = LIMITES_DE_LOGIN;
    const ultimoSucesso = await db.tentativaLogin.findFirst({
      where: { email, sucesso: true },
      orderBy: { criadoEm: 'desc' },
      select: { criadoEm: true },
    });
    const limiteDaBusca =
      agora.getTime() - (janelaMinutos + bloqueioMinutos) * MINUTO_MS;
    const desde = new Date(
      Math.max(limiteDaBusca, ultimoSucesso?.criadoEm.getTime() ?? 0),
    );
    const falhas = await db.tentativaLogin.findMany({
      where: {
        email,
        sucesso: false,
        motivo: { in: [...FALHAS_DE_CREDENCIAL] },
        criadoEm: { gt: desde },
      },
      orderBy: { criadoEm: 'desc' },
      take: falhasPorEmail,
      select: { criadoEm: true },
    });
    if (falhas.length < falhasPorEmail) {
      return null;
    }
    const maisRecente = falhas[0].criadoEm.getTime();
    const maisAntiga = falhas[falhasPorEmail - 1].criadoEm.getTime();
    if (maisRecente - maisAntiga > janelaMinutos * MINUTO_MS) {
      return null;
    }
    const ate = maisRecente + bloqueioMinutos * MINUTO_MS;
    return ate > agora.getTime() ? new Date(ate) : null;
  }

  /** Até quando o IP está bloqueado, ou `null`. */
  async bloqueioDoIp(
    ip: string,
    agora: Date,
    db: Tx = this.prisma,
  ): Promise<Date | null> {
    const { tentativasPorIp, janelaMinutos } = LIMITES_DE_LOGIN;
    const janelaMs = janelaMinutos * MINUTO_MS;
    const [limite] = await db.tentativaLogin.findMany({
      where: {
        ip,
        sucesso: false,
        motivo: { notIn: [...MOTIVOS_DE_BLOQUEIO] },
        criadoEm: { gt: new Date(agora.getTime() - janelaMs) },
      },
      orderBy: { criadoEm: 'desc' },
      skip: tentativasPorIp - 1,
      take: 1,
      select: { criadoEm: true },
    });
    if (!limite) {
      return null;
    }
    const ate = limite.criadoEm.getTime() + janelaMs;
    return ate > agora.getTime() ? new Date(ate) : null;
  }
}

/** 429 com o tempo que falta para o bloqueio acabar (R2.5). */
export function excecaoDeBloqueio(
  bloqueio: Bloqueio,
  agora: Date,
): MuitasTentativasException {
  const segundos = Math.max(
    1,
    Math.ceil((bloqueio.ate.getTime() - agora.getTime()) / 1000),
  );
  const minutos = Math.ceil(segundos / 60);
  return new MuitasTentativasException(
    `Muitas tentativas de login. Tente de novo em ${minutos} minuto${minutos === 1 ? '' : 's'}.`,
    segundos,
    { regra: 'R2.5', motivo: bloqueio.motivo, ate: bloqueio.ate.toISOString() },
  );
}
