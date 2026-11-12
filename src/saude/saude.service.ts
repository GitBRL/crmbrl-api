import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import type { Ambiente } from '../config/ambiente';
import { AMBIENTE } from '../config/ambiente';
import { PrismaService } from '../prisma/prisma.service';
import {
  comPrazo,
  descreverFalhaDoBanco,
  detalharFalhaParaLog,
} from './falha-do-banco';

/** Prazo de cada consulta da verificação. O healthcheck do Docker espera até 5 s. */
export const PRAZO_DA_VERIFICACAO_MS = 3_000;

/** Corpo público de `GET /api/saude`: só o estado, para o healthcheck. */
export interface SaudePublica {
  status: 'ok' | 'degradado';
}

/**
 * Corpo de `GET /api/saude` para o Admin logado. É contrato com o front (`crmbrl`), que não
 * compartilha tipos com a API: mudou aqui, mude lá e em `docs/ARQUITETURA.md`.
 */
export interface Saude {
  /** `degradado` quando o banco falha — a resposta vem com HTTP 503. */
  status: 'ok' | 'degradado';
  /** Versão do `package.json`. */
  versao: string;
  /** `NODE_ENV`. */
  ambiente: string;
  /** Momento da verificação, em ISO 8601 (UTC). */
  horario: string;
  /** Segundos desde que o processo subiu. */
  uptimeSegundos: number;
  banco: SaudeDoBanco;
  /** `null` quando o banco falha. */
  migrations: SaudeDasMigrations | null;
  /** Avisos de configuração da subida (ex.: segredo de desenvolvimento permitido em produção). Sem valores secretos. */
  avisos: readonly string[];
}

export interface SaudeDoBanco {
  status: 'ok' | 'erro';
  /** Duração do `SELECT 1` (ou até a falha). */
  latenciaMs: number;
  /** Só com `status: 'erro'`: mensagem curta, sem segredo. */
  erro?: string;
}

export interface SaudeDasMigrations {
  /** Migrations concluídas e não revertidas (`_prisma_migrations`). */
  aplicadas: number;
  /** A aplicada por último, ou `null` se nenhuma foi aplicada. */
  ultima: string | null;
}

@Injectable()
export class SaudeService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SaudeService.name);
  private readonly versao = lerVersao();
  /** Se o banco respondia na verificação anterior: o log registra só as mudanças. */
  private bancoRespondia: boolean | undefined;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(AMBIENTE) private readonly ambiente: Ambiente,
  ) {}

  /** Confere o banco assim que a API sobe, para o log já dizer se ele responde. */
  async onApplicationBootstrap(): Promise<void> {
    await this.verificar();
  }

  async verificar(): Promise<Saude> {
    const { banco, migrations } = await this.verificarBanco();
    return {
      status: banco.status === 'ok' ? 'ok' : 'degradado',
      versao: this.versao,
      ambiente: this.ambiente.nodeEnv,
      horario: new Date().toISOString(),
      uptimeSegundos: Math.floor(process.uptime()),
      banco,
      migrations,
      avisos: this.ambiente.avisos,
    };
  }

  private async verificarBanco(): Promise<Pick<Saude, 'banco' | 'migrations'>> {
    const inicio = performance.now();
    const decorrido = () => Math.round(performance.now() - inicio);
    try {
      await comPrazo(this.prisma.$queryRaw`SELECT 1`, PRAZO_DA_VERIFICACAO_MS);
      const latenciaMs = decorrido();
      const migrations = await comPrazo(
        this.lerMigrations(),
        PRAZO_DA_VERIFICACAO_MS,
      );
      this.registrarMudanca(
        true,
        `Banco respondendo (${latenciaMs} ms). Migrations aplicadas: ${migrations.aplicadas}` +
          (migrations.ultima ? ` (última: ${migrations.ultima}).` : '.'),
      );
      return { banco: { status: 'ok', latenciaMs }, migrations };
    } catch (falha) {
      const erro = descreverFalhaDoBanco(falha);
      this.registrarMudanca(
        false,
        `Banco indisponível: ${erro} Detalhe: ${detalharFalhaParaLog(falha)} ` +
          '— GET /api/saude responde 503 até ele voltar.',
      );
      return {
        banco: { status: 'erro', latenciaMs: decorrido(), erro },
        migrations: null,
      };
    }
  }

  private async lerMigrations(): Promise<SaudeDasMigrations> {
    const [tabela] = await this.prisma.$queryRaw<{ existe: boolean }[]>`
      SELECT to_regclass('_prisma_migrations') IS NOT NULL AS existe`;
    if (!tabela?.existe) {
      // Banco que nunca recebeu `prisma migrate deploy`.
      return { aplicadas: 0, ultima: null };
    }
    const [resumo] = await this.prisma.$queryRaw<SaudeDasMigrations[]>`
      SELECT count(*)::int AS aplicadas,
             (array_agg(migration_name ORDER BY finished_at DESC, migration_name DESC))[1] AS ultima
        FROM _prisma_migrations
       WHERE finished_at IS NOT NULL
         AND rolled_back_at IS NULL`;
    return {
      aplicadas: resumo?.aplicadas ?? 0,
      ultima: resumo?.ultima ?? null,
    };
  }

  private registrarMudanca(respondeAgora: boolean, mensagem: string): void {
    if (respondeAgora === this.bancoRespondia) {
      return;
    }
    this.bancoRespondia = respondeAgora;
    if (respondeAgora) {
      this.logger.log(mensagem);
    } else {
      this.logger.warn(mensagem);
    }
  }
}

/** Versão do `package.json` mais próximo — o da API, tanto a partir de `src/` quanto de `dist/`. */
export function lerVersao(): string {
  let pasta = __dirname;
  while (!existsSync(join(pasta, 'package.json'))) {
    const acima = dirname(pasta);
    if (acima === pasta) {
      return '0.0.0';
    }
    pasta = acima;
  }
  const pacote = JSON.parse(
    readFileSync(join(pasta, 'package.json'), 'utf8'),
  ) as { version?: unknown };
  return typeof pacote.version === 'string' ? pacote.version : '0.0.0';
}
