/**
 * Apoio dos testes de integração do BI (`test/bi*.e2e-spec.ts`): dados com datas
 * montadas à mão (para os números serem conhecidos) e leitura dos painéis.
 */
import {
  type Area,
  type Conversa,
  type Negocio,
  Prisma,
  type StatusConversa,
  type Usuario,
} from '../src/generated/prisma/client';
import { statusDaEtapa } from '../src/funis/negocio-completo';
import type { PainelBi } from '../src/bi/bi.tipos';
import {
  type AppTeste,
  type ClienteHttp,
  criarCanal,
  criarContato,
  funilBase,
} from './utils';

export const MIN = 60_000;
export const HORA = 3_600_000;
export const DIA = 86_400_000;

/** Meia-noite UTC de hoje (as horas dos testes são UTC, para a hora local do BI ser previsível: UTC−3). */
export function hojeUtc(): Date {
  const base = new Date();
  base.setUTCHours(0, 0, 0, 0);
  return base;
}

/** `dias` antes de hoje (UTC) mais `horas` e `minutos` do dia. */
export function quando(dias: number, horas = 12, minutos = 0): Date {
  return new Date(
    hojeUtc().getTime() - dias * DIA + horas * HORA + minutos * MIN,
  );
}

/** Período dos testes: os 10 dias que terminam amanhã (inclui hoje); o anterior são os 10 antes. */
export function periodoDeTeste(): { de: string; ate: string } {
  const ate = new Date(hojeUtc().getTime() + DIA);
  const de = new Date(ate.getTime() - 10 * DIA);
  return { de: de.toISOString(), ate: ate.toISOString() };
}

export interface RespostaDoPainel {
  painel: string;
  periodo: { de: string; ate: string };
  anterior: { de: string; ate: string } | null;
  geradoEm: string;
  filtros: Record<string, unknown>;
  cartoes: {
    chave: string;
    valor: number | null;
    anterior: number | null;
    variacao: number | null;
    unidade: string;
  }[];
  tabelas: Record<
    string,
    {
      colunas: { chave: string; visivel: boolean }[];
      linhas: Record<string, string | number | boolean | null>[];
    }
  >;
  meta: Record<string, unknown>;
}

/** `GET /bi/:painel` sem cache (os testes mudam os dados entre uma consulta e outra). */
export async function consultarPainel(
  cliente: ClienteHttp,
  painel: PainelBi,
  filtros: Record<string, string | boolean | undefined> = {},
  esperado = 200,
): Promise<RespostaDoPainel> {
  const consulta = Object.fromEntries(
    Object.entries({ ...periodoDeTeste(), ...filtros }).filter(
      ([, valor]) => valor !== undefined,
    ),
  );
  const resposta = await cliente
    .get(`/api/v1/bi/${painel}`)
    .set('Cache-Control', 'no-cache')
    .query(consulta)
    .expect(esperado);
  return resposta.body as RespostaDoPainel;
}

export function cartao(painel: RespostaDoPainel, chave: string) {
  const encontrado = painel.cartoes.find((c) => c.chave === chave);
  if (!encontrado) {
    throw new Error(
      `Cartão ${chave} não existe (${painel.cartoes.map((c) => c.chave).join(', ')}).`,
    );
  }
  return encontrado;
}

export function linhasDa(painel: RespostaDoPainel, tabela: string) {
  const encontrada = painel.tabelas[tabela];
  if (!encontrada) {
    throw new Error(`Tabela ${tabela} não existe.`);
  }
  return encontrada.linhas;
}

// ---------------------------------------------------------------------------
// Negócios
// ---------------------------------------------------------------------------

export interface DadosDeNegocioBi {
  area: Area;
  etapa: string;
  responsavel?: Usuario | null;
  valor?: string;
  valorRecorrente?: string | null;
  criadoEm: Date;
  /** Quando virou ganho ou perdido (obrigatório em etapas finais). */
  fechadoEm?: Date;
  motivoPerda?: string;
  etapaDesde?: Date;
  previsao?: string | null;
  origem?: 'SITE' | 'WEBHOOK' | 'MANUAL' | 'WHATSAPP' | 'PASSAGEM';
  utm?: Record<string, string> | null;
}

/** Negócio com datas e valores definidos (grava direto, como as outras fábricas). */
export async function criarNegocioBi(
  t: AppTeste,
  dados: DadosDeNegocioBi,
): Promise<Negocio> {
  const funil = await funilBase(t, dados.area);
  const etapa = funil.etapas.find((e) => e.chave === dados.etapa);
  if (!etapa) {
    throw new Error(`Etapa ${dados.etapa} não existe.`);
  }
  const status = statusDaEtapa(etapa.tipo);
  const contato = await criarContato(t);
  return t.prisma.negocio.create({
    data: {
      titulo: `BI ${dados.area} ${dados.etapa}`,
      contatoId: contato.id,
      funilId: funil.id,
      etapaId: etapa.id,
      responsavelId: dados.responsavel?.id ?? null,
      status,
      valor: new Prisma.Decimal(dados.valor ?? '0'),
      valorRecorrente:
        dados.valorRecorrente == null
          ? null
          : new Prisma.Decimal(dados.valorRecorrente),
      criadoEm: dados.criadoEm,
      etapaDesde: dados.etapaDesde ?? dados.criadoEm,
      ganhoEm: status === 'GANHO' ? (dados.fechadoEm ?? dados.criadoEm) : null,
      perdidoEm:
        status === 'PERDIDO' ? (dados.fechadoEm ?? dados.criadoEm) : null,
      motivoPerda:
        status === 'PERDIDO'
          ? (dados.motivoPerda ?? 'Sem motivo informado')
          : null,
      previsaoFechamento: dados.previsao
        ? new Date(`${dados.previsao}T00:00:00.000Z`)
        : null,
      origem: dados.origem ?? 'MANUAL',
      utm: dados.utm ?? undefined,
    },
  });
}

/** Define a probabilidade das etapas do funil-base (por `chave`). */
export async function definirProbabilidades(
  t: AppTeste,
  area: Area,
  probabilidades: Record<string, number>,
): Promise<void> {
  const funil = await funilBase(t, area);
  for (const etapa of funil.etapas) {
    if (probabilidades[etapa.chave ?? ''] !== undefined) {
      await t.prisma.etapa.update({
        where: { id: etapa.id },
        data: { probabilidade: probabilidades[etapa.chave ?? ''] },
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Conversas
// ---------------------------------------------------------------------------

export interface DadosDeConversaBi {
  canalId: string;
  filaId: string | null;
  responsavel?: Usuario | null;
  criadoEm: Date;
  status?: StatusConversa;
  /** Minutos depois de `criadoEm`. */
  primeiraRespostaApos?: number;
  resolvidaApos?: number;
  slaPrimeiraRespostaApos?: number;
  slaResolucaoApos?: number;
  nota?: number;
  notaRespondidaApos?: number;
}

export async function criarConversaBi(
  t: AppTeste,
  dados: DadosDeConversaBi,
): Promise<Conversa> {
  const contato = await criarContato(t);
  const apos = (minutos: number | undefined) =>
    minutos === undefined
      ? null
      : new Date(dados.criadoEm.getTime() + minutos * MIN);
  const resolvidaEm = apos(dados.resolvidaApos);
  return t.prisma.conversa.create({
    data: {
      canalId: dados.canalId,
      contatoId: contato.id,
      filaId: dados.filaId,
      responsavelId: dados.responsavel?.id ?? null,
      status: dados.status ?? (resolvidaEm ? 'RESOLVIDA' : 'ABERTA'),
      criadoEm: dados.criadoEm,
      primeiraRespostaEm: apos(dados.primeiraRespostaApos),
      resolvidaEm,
      slaPrimeiraRespostaAte: apos(dados.slaPrimeiraRespostaApos),
      slaResolucaoAte: apos(dados.slaResolucaoApos),
      satisfacaoNota: dados.nota ?? null,
      satisfacaoRespondidaEm:
        dados.nota === undefined
          ? null
          : apos(dados.notaRespondidaApos ?? (dados.resolvidaApos ?? 0) + 5),
    },
  });
}

export { criarCanal };
