import { Injectable } from '@nestjs/common';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { deDataDoBanco, diasEntre, hojeLocal } from './datas';
import {
  sqlContratosDasPessoas,
  sqlContratosVisiveis,
  sqlParcelasDasPessoas,
  sqlParcelasVisiveis,
} from './permissoes-financeiro-sql';

type Usuario = Pick<UsuarioAutenticado, 'id' | 'papel' | 'area'>;

const NENHUM_ID = '00000000-0000-0000-0000-000000000000';

export type NivelDeRisco = 'BAIXO' | 'MEDIO' | 'ALTO';

export interface FatorDeRisco {
  tipo: 'ATRASO' | 'SATISFACAO' | 'SEM_INTERACAO';
  pontos: number;
  detalhe: string;
}

export interface RiscoDeChurn {
  contatoId: string;
  /** 0 a 100. */
  pontuacao: number;
  nivel: NivelDeRisco;
  fatores: FatorDeRisco[];
}

/** Pontos de cada fator (R23.4); a soma é limitada a 100. */
export function pontosDeAtraso(maiorAtrasoEmDias: number): number {
  if (maiorAtrasoEmDias < 1) return 0;
  if (maiorAtrasoEmDias <= 30) return 20;
  if (maiorAtrasoEmDias <= 60) return 35;
  return 50;
}

export function pontosDeSatisfacao(nota: number | null): number {
  if (nota === null) return 0;
  if (nota <= 2) return 30;
  return nota === 3 ? 15 : 0;
}

export function pontosDeSilencio(diasSemInteracao: number | null): number {
  if (diasSemInteracao === null) return 0;
  if (diasSemInteracao > 60) return 20;
  return diasSemInteracao > 30 ? 10 : 0;
}

export function nivelDaPontuacao(pontos: number): NivelDeRisco {
  if (pontos >= 60) return 'ALTO';
  return pontos >= 30 ? 'MEDIO' : 'BAIXO';
}

/**
 * Risco de churn (R23.4): atraso + satisfação baixa + sem interação, por contato
 * com contrato ativo ou título em aberto. Para o contato, o negócio de CS e o BI.
 * Só considera o que o usuário vê no Financeiro; fora disso o resultado é `null`.
 */
@Injectable()
export class RiscoDeChurnService {
  constructor(private readonly prisma: PrismaService) {}

  async doContato(
    usuario: Usuario,
    contatoId: string,
  ): Promise<RiscoDeChurn | null> {
    return (await this.calcular(usuario, [contatoId])).get(contatoId) ?? null;
  }

  /** Risco do contato do negócio (o negócio de CS é do cliente). */
  async doNegocio(
    usuario: Usuario,
    negocioId: string,
  ): Promise<RiscoDeChurn | null> {
    const negocio = await this.prisma.negocio.findFirst({
      where: { id: negocioId, excluidoEm: null },
      select: { contatoId: true },
    });
    return negocio ? this.doContato(usuario, negocio.contatoId) : null;
  }

  /** Contatos em risco (do mais alto ao mais baixo), com contrato ativo/suspenso ou título em aberto visíveis. */
  async ranking(
    usuario: Usuario,
    opcoes: {
      nivelMinimo?: NivelDeRisco;
      limite?: number;
      /** Só contratos e títulos destas pessoas de CS (filtro do BI). */
      pessoas?: readonly string[] | null;
    } = {},
  ): Promise<(RiscoDeChurn & { contato: { id: string; nome: string } })[]> {
    const candidatos = await this.prisma.$queryRaw<{ contato_id: string }[]>`
      SELECT DISTINCT c.contato_id FROM contratos c
      WHERE c.contato_id IS NOT NULL AND c.status::text IN ('ATIVO', 'SUSPENSO')
        AND ${sqlContratosVisiveis(usuario)} AND ${sqlContratosDasPessoas(opcoes.pessoas)}
      UNION
      SELECT DISTINCT p.contato_id FROM parcelas p
      WHERE p.contato_id IS NOT NULL AND p.status::text IN ('ABERTO', 'ATRASADO')
        AND ${sqlParcelasVisiveis(usuario)} AND ${sqlParcelasDasPessoas(opcoes.pessoas)}`;
    const ids = candidatos.map((x) => x.contato_id);
    const mapa = await this.calcular(usuario, ids);
    const ordem = { BAIXO: 0, MEDIO: 1, ALTO: 2 } as const;
    const minimo = ordem[opcoes.nivelMinimo ?? 'MEDIO'];
    const filtrados = [...mapa.values()]
      .filter((r) => ordem[r.nivel] >= minimo)
      .sort((a, b) => b.pontuacao - a.pontuacao)
      .slice(0, opcoes.limite ?? 50);
    const contatos = await this.prisma.contato.findMany({
      where: { id: { in: filtrados.map((r) => r.contatoId) } },
      select: { id: true, nome: true },
    });
    const nomes = new Map(contatos.map((c) => [c.id, c]));
    return filtrados.map((r) => ({
      ...r,
      contato: nomes.get(r.contatoId) ?? { id: r.contatoId, nome: '—' },
    }));
  }

  /** Contagem de contatos por nível (para o BI). */
  async contagemPorNivel(
    usuario: Usuario,
    pessoas?: readonly string[] | null,
  ): Promise<Record<NivelDeRisco, number>> {
    const todos = await this.ranking(usuario, {
      nivelMinimo: 'BAIXO',
      limite: 100_000,
      pessoas,
    });
    const r: Record<NivelDeRisco, number> = { BAIXO: 0, MEDIO: 0, ALTO: 0 };
    for (const x of todos) r[x.nivel] += 1;
    return r;
  }

  /** Calcula o risco de vários contatos de uma vez; sem contrato nem título visível, o contato fica de fora. */
  async calcular(
    usuario: Usuario,
    contatoIds: readonly string[],
    agora: Date = new Date(),
  ): Promise<Map<string, RiscoDeChurn>> {
    const resultado = new Map<string, RiscoDeChurn>();
    if (contatoIds.length === 0) return resultado;
    const hoje = hojeLocal(agora);
    const contatos = await this.prisma.contato.findMany({
      where: { id: { in: [...contatoIds] }, excluidoEm: null },
      select: { id: true, empresaId: true },
    });
    const empresas = [
      ...new Set(contatos.flatMap((c) => (c.empresaId ? [c.empresaId] : []))),
    ];
    if (contatos.length === 0) return resultado;
    const idsContatos = contatos.map((c) => c.id);
    const idsEmpresas = empresas.length > 0 ? empresas : [NENHUM_ID];
    const [contratos, parcelas, conversas, notas, atividades] =
      await Promise.all([
        // Agregados no banco: só o que a pontuação usa (início mais antigo, vencimento mais antigo, últimas datas).
        this.prisma.$queryRaw<
          {
            contato_id: string | null;
            empresa_id: string | null;
            inicio: Date;
          }[]
        >`SELECT c.contato_id, c.empresa_id, MIN(c.inicio_em) AS inicio FROM contratos c
          WHERE c.status::text IN ('ATIVO', 'SUSPENSO')
            AND (c.contato_id IN (${Prisma.join(idsContatos.map((i) => Prisma.sql`${i}::uuid`))})
              OR c.empresa_id IN (${Prisma.join(idsEmpresas.map((i) => Prisma.sql`${i}::uuid`))}))
            AND ${sqlContratosVisiveis(usuario)}
          GROUP BY 1, 2`,
        this.prisma.$queryRaw<
          {
            contato_id: string | null;
            empresa_id: string | null;
            vencimento: Date;
          }[]
        >`SELECT p.contato_id, p.empresa_id, MIN(p.vencimento) AS vencimento FROM parcelas p
          WHERE p.status::text IN ('ABERTO', 'ATRASADO')
            AND (p.contato_id IN (${Prisma.join(idsContatos.map((i) => Prisma.sql`${i}::uuid`))})
              OR (p.contato_id IS NULL AND p.empresa_id IN (${Prisma.join(idsEmpresas.map((i) => Prisma.sql`${i}::uuid`))})))
            AND ${sqlParcelasVisiveis(usuario)}
          GROUP BY 1, 2`,
        this.prisma.$queryRaw<{ contato_id: string; ultima: Date | null }[]>`
          SELECT contato_id, MAX(ultima_mensagem_em) AS ultima FROM conversas
          WHERE contato_id IN (${Prisma.join(idsContatos.map((i) => Prisma.sql`${i}::uuid`))})
          GROUP BY 1`,
        this.prisma.$queryRaw<{ contato_id: string; nota: number }[]>`
          SELECT DISTINCT ON (contato_id) contato_id, satisfacao_nota AS nota FROM conversas
          WHERE contato_id IN (${Prisma.join(idsContatos.map((i) => Prisma.sql`${i}::uuid`))})
            AND satisfacao_nota IS NOT NULL AND satisfacao_respondida_em IS NOT NULL
          ORDER BY contato_id, satisfacao_respondida_em DESC`,
        this.prisma.$queryRaw<{ contato_id: string; ultima: Date | null }[]>`
          SELECT contato_id, MAX(concluida_em) AS ultima FROM atividades
          WHERE contato_id IN (${Prisma.join(idsContatos.map((i) => Prisma.sql`${i}::uuid`))})
            AND status::text = 'CONCLUIDA'
          GROUP BY 1`,
      ]);
    for (const c of contatos) {
      const contratosDele = contratos.filter(
        (x) =>
          x.contato_id === c.id ||
          (x.empresa_id && x.empresa_id === c.empresaId),
      );
      const parcelasDele = parcelas.filter(
        (x) =>
          x.contato_id === c.id ||
          (x.contato_id === null && x.empresa_id === c.empresaId),
      );
      if (contratosDele.length === 0 && parcelasDele.length === 0) continue;
      const fatores: FatorDeRisco[] = [];
      const maiorAtraso = Math.max(
        0,
        ...parcelasDele.map((p) =>
          diasEntre(deDataDoBanco(p.vencimento), hoje),
        ),
      );
      const pa = pontosDeAtraso(maiorAtraso);
      if (pa > 0) {
        fatores.push({
          tipo: 'ATRASO',
          pontos: pa,
          detalhe: `Título atrasado há ${maiorAtraso} dia(s)`,
        });
      }
      const nota = notas.find((x) => x.contato_id === c.id)?.nota ?? null;
      const ps = pontosDeSatisfacao(nota);
      if (ps > 0) {
        fatores.push({
          tipo: 'SATISFACAO',
          pontos: ps,
          detalhe: `Última nota de satisfação: ${nota}`,
        });
      }
      const datas = [
        conversas.find((x) => x.contato_id === c.id)?.ultima,
        atividades.find((x) => x.contato_id === c.id)?.ultima,
      ].flatMap((d) => (d ? [d.getTime()] : []));
      const inicioMaisAntigo = Math.min(
        ...contratosDele.map((x) => x.inicio.getTime()),
        agora.getTime(),
      );
      const ultima = datas.length > 0 ? Math.max(...datas) : null;
      const dias =
        ultima !== null
          ? Math.floor((agora.getTime() - ultima) / 86_400_000)
          : Math.floor((agora.getTime() - inicioMaisAntigo) / 86_400_000);
      const pi = pontosDeSilencio(dias);
      if (pi > 0) {
        fatores.push({
          tipo: 'SEM_INTERACAO',
          pontos: pi,
          detalhe:
            ultima !== null
              ? `Sem interação há ${dias} dias`
              : `Nenhuma interação registrada (${dias} dias de contrato)`,
        });
      }
      const pontuacao = Math.min(
        100,
        fatores.reduce((s, f) => s + f.pontos, 0),
      );
      resultado.set(c.id, {
        contatoId: c.id,
        pontuacao,
        nivel: nivelDaPontuacao(pontuacao),
        fatores,
      });
    }
    return resultado;
  }
}
