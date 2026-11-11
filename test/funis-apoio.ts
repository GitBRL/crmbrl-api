/**
 * Apoio dos testes de integração dos funis (`test/funis*.e2e-spec.ts`).
 */
import type request from 'supertest';
import {
  type Negocio,
  Prisma,
  type Usuario,
} from '../src/generated/prisma/client';
import { statusDaEtapa } from '../src/funis/negocio-completo';
import {
  type AppTeste,
  type ClienteHttp,
  criarContato,
  funilBase,
} from './utils';
import type { Area } from '../src/comum/dominio/setores';

const MS_POR_DIA = 86_400_000;

/** `POST /negocios/:id/mover` com a etapa e o que mais vier no corpo. */
export function mover(
  cliente: ClienteHttp,
  negocioId: string,
  etapaId: string,
  extra: Record<string, unknown> = {},
): request.Test {
  return cliente.post(`/api/v1/negocios/${negocioId}/mover`, {
    etapaId,
    ...extra,
  });
}

/** Ids dos cartões de uma coluna do quadro, em ordem. */
export function cartoesDaColuna(
  quadro: { colunas: { etapa: { id: string }; negocios: { id: string }[] }[] },
  etapaId: string,
): string[] {
  const coluna = quadro.colunas.find(({ etapa }) => etapa.id === etapaId);
  return coluna ? coluna.negocios.map(({ id }) => id) : [];
}

export interface PassoDoHistorico {
  /** `chave` da etapa no funil-base. */
  etapa: string;
  /** Há quantos dias o negócio entrou nela. */
  diasAtras: number;
}

/**
 * Negócio num funil-base com um histórico de movimentação montado à mão (para
 * as métricas, R5.10): entra na primeira etapa dos `passos` e passa pelas
 * seguintes nas datas indicadas. Status, datas de ganho/perda, `etapaDesde` e
 * o tempo na etapa anterior saem dos passos.
 */
export async function criarNegocioComHistorico(
  t: AppTeste,
  area: Area,
  passos: readonly PassoDoHistorico[],
  opcoes: { responsavel?: Usuario | null; valor?: string } = {},
): Promise<Negocio> {
  const funil = await funilBase(t, area);
  const etapa = (chave: string) => {
    const encontrada = funil.etapas.find(
      (candidata) => candidata.chave === chave,
    );
    if (!encontrada) {
      throw new Error(`Etapa ${chave} não existe no funil de ${area}.`);
    }
    return encontrada;
  };
  const agora = Date.now();
  const quando = (dias: number) => new Date(agora - dias * MS_POR_DIA);
  const primeiro = passos[0];
  const ultimo = passos[passos.length - 1];
  const etapaAtual = etapa(ultimo.etapa);
  const status = statusDaEtapa(etapaAtual.tipo);
  const contato = await criarContato(t);
  return t.prisma.negocio.create({
    data: {
      titulo: `Histórico ${passos.map((passo) => passo.etapa).join('→')}`,
      contatoId: contato.id,
      funilId: funil.id,
      etapaId: etapaAtual.id,
      responsavelId: opcoes.responsavel?.id ?? null,
      status,
      valor: new Prisma.Decimal(opcoes.valor ?? '0'),
      criadoEm: quando(primeiro.diasAtras),
      etapaDesde: quando(ultimo.diasAtras),
      ganhoEm: status === 'GANHO' ? quando(ultimo.diasAtras) : null,
      perdidoEm: status === 'PERDIDO' ? quando(ultimo.diasAtras) : null,
      motivoPerda: status === 'PERDIDO' ? 'Montado pelo teste' : null,
      movimentacoes: {
        create: passos.map((passo, indice) => ({
          funilId: funil.id,
          deEtapaId: indice === 0 ? null : etapa(passos[indice - 1].etapa).id,
          paraEtapaId: etapa(passo.etapa).id,
          tipoAtor: 'SISTEMA' as const,
          segundosNaEtapaAnterior:
            indice === 0
              ? null
              : Math.round(
                  (passos[indice - 1].diasAtras - passo.diasAtras) * 86_400,
                ),
          criadoEm: quando(passo.diasAtras),
        })),
      },
    },
  });
}

/** Espera uma condição assíncrona (para coordenar transações nos testes de concorrência). */
export async function esperarAte(
  condicao: () => boolean | Promise<boolean>,
  limiteMs = 5_000,
): Promise<void> {
  const inicio = Date.now();
  while (!(await condicao())) {
    if (Date.now() - inicio > limiteMs) {
      throw new Error('Tempo esgotado esperando a condição.');
    }
    await new Promise((resolver) => setTimeout(resolver, 20));
  }
}
