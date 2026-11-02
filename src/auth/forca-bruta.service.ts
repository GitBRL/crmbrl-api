import { Injectable } from '@nestjs/common';
import type { Tx } from '../prisma/prisma.service';
import { PrismaService } from '../prisma/prisma.service';

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
  | 'BLOQUEADO_EMAIL'
  | 'BLOQUEADO_IP';

/** Falhas de credencial: as que contam para o bloqueio do e-mail. */
const FALHAS_DE_CREDENCIAL: readonly MotivoTentativa[] = [
  'SENHA_INCORRETA',
  'USUARIO_INEXISTENTE',
  'SEM_SENHA',
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

/**
 * Proteção contra força bruta no login (R2.5).
 *
 * - **E-mail:** 5 falhas de credencial dentro de 15 minutos, sem login com
 *   sucesso entre elas, bloqueiam o e-mail por 15 minutos a partir da 5ª falha.
 *   Tentativas durante o bloqueio são registradas, mas não o prolongam.
 * - **IP:** 30 tentativas sem sucesso (de qualquer tipo, inclusive as já
 *   bloqueadas) nos últimos 15 minutos bloqueiam o IP até a mais antiga delas
 *   sair da janela. Logins com sucesso não contam.
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
