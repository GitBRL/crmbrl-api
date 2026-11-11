/**
 * Listas de acessos extras (R5.11): validação dos alvos e o cálculo do que muda
 * ao substituir a lista — usados pelo funil (`acessos_funil`) e pelo setor
 * (`acessos_setor`).
 */
import { rotuloDaArea } from '../comum/dominio/papeis';
import type { Area } from '../comum/dominio/setores';
import {
  DadosInvalidosException,
  RegraVioladaException,
} from '../comum/erros/excecoes';
import type { NivelAcesso } from '../generated/prisma/client';
import type { Tx } from '../prisma/prisma.service';
import type { NovoAcessoDto } from './dto/acessos.dto';

/** Um alvo validado: um setor inteiro ou uma pessoa, com o nível. */
export interface AcessoPedido {
  readonly area: Area | null;
  readonly usuarioId: string | null;
  readonly nivel: NivelAcesso;
}

/** Uma linha já gravada (de qualquer das duas tabelas). */
export interface AcessoGravado {
  readonly id: string;
  readonly area: Area | null;
  readonly usuarioId: string | null;
  readonly nivel: NivelAcesso;
}

/** Chave do alvo: `setor:CS` ou `pessoa:<uuid>`. */
export function chaveDoAlvo(acesso: {
  readonly area: Area | null;
  readonly usuarioId: string | null;
}): string {
  return acesso.usuarioId
    ? `pessoa:${acesso.usuarioId}`
    : `setor:${acesso.area}`;
}

/**
 * Confere a lista pedida (R5.11): cada linha com exatamente um alvo e cada alvo
 * uma vez só (400); setor e pessoa existem; o setor dono não é alvo; um alvo
 * **novo** precisa estar ativo (os que já estavam na lista continuam mesmo se o
 * setor foi desativado ou a pessoa desligada — eles só não contam). 422 com
 * `detalhes.regra = 'R5.11'`.
 */
export async function validarAcessosPedidos(
  db: Pick<Tx, 'setor' | 'usuario'>,
  areaDono: Area,
  pedidos: readonly NovoAcessoDto[],
  gravados: readonly AcessoGravado[],
): Promise<AcessoPedido[]> {
  const problemas: { campo: string; mensagens: string[] }[] = [];
  const vistos = new Set<string>();
  const lista: AcessoPedido[] = [];
  pedidos.forEach((pedido, indice) => {
    const temArea = !!pedido.area;
    const temPessoa = !!pedido.usuarioId;
    if (temArea === temPessoa) {
      problemas.push({
        campo: `acessos.${indice}`,
        mensagens: ['informe o setor (area) ou a pessoa (usuarioId), só um'],
      });
      return;
    }
    const acesso: AcessoPedido = {
      area: temArea ? (pedido.area as Area) : null,
      usuarioId: temPessoa ? (pedido.usuarioId as string).toLowerCase() : null,
      nivel: pedido.nivel,
    };
    const chave = chaveDoAlvo(acesso);
    if (vistos.has(chave)) {
      problemas.push({
        campo: `acessos.${indice}`,
        mensagens: ['alvo repetido na lista'],
      });
      return;
    }
    vistos.add(chave);
    lista.push(acesso);
  });
  if (problemas.length > 0) {
    throw new DadosInvalidosException(
      'Confira a lista de acessos: cada linha leva um setor ou uma pessoa, sem repetir.',
      { campos: problemas },
    );
  }
  const jaGravados = new Set(gravados.map(chaveDoAlvo));
  const areas = lista.flatMap(({ area }) => (area ? [area] : []));
  const pessoas = lista.flatMap(({ usuarioId }) =>
    usuarioId ? [usuarioId] : [],
  );
  if (areas.includes(areaDono)) {
    throw new RegraVioladaException(
      'R5.11',
      `O setor ${rotuloDaArea(areaDono)} já é o dono: ele não entra na lista de acessos.`,
      { area: areaDono },
    );
  }
  const [setores, usuarios] = await Promise.all([
    areas.length > 0
      ? db.setor.findMany({
          where: { chave: { in: areas } },
          select: { chave: true, nome: true, ativo: true },
        })
      : Promise.resolve([]),
    pessoas.length > 0
      ? db.usuario.findMany({
          where: { id: { in: pessoas } },
          select: { id: true, nome: true, ativo: true },
        })
      : Promise.resolve([]),
  ]);
  const setorPorChave = new Map(setores.map((s) => [s.chave, s]));
  const pessoaPorId = new Map(usuarios.map((u) => [u.id, u]));
  for (const acesso of lista) {
    const novo = !jaGravados.has(chaveDoAlvo(acesso));
    if (acesso.area) {
      const setor = setorPorChave.get(acesso.area);
      if (!setor) {
        throw new RegraVioladaException(
          'R5.11',
          `O setor ${acesso.area} não existe.`,
          { area: acesso.area },
        );
      }
      if (novo && !setor.ativo) {
        throw new RegraVioladaException(
          'R5.11',
          `O setor ${setor.nome} está desativado: escolha um setor ativo.`,
          { area: acesso.area },
        );
      }
    } else {
      const pessoa = pessoaPorId.get(acesso.usuarioId as string);
      if (!pessoa) {
        throw new RegraVioladaException(
          'R5.11',
          'A pessoa escolhida não existe.',
          { usuarioId: acesso.usuarioId },
        );
      }
      if (novo && !pessoa.ativo) {
        throw new RegraVioladaException(
          'R5.11',
          `${pessoa.nome} está desligado(a): escolha uma pessoa ativa.`,
          { usuarioId: acesso.usuarioId },
        );
      }
    }
  }
  return lista;
}

/** O que muda ao trocar a lista gravada pela pedida. */
export interface MudancaDeAcessos {
  readonly criar: AcessoPedido[];
  readonly atualizar: { id: string; nivel: NivelAcesso }[];
  readonly remover: string[];
}

export function mudancaDeAcessos(
  gravados: readonly AcessoGravado[],
  pedidos: readonly AcessoPedido[],
): MudancaDeAcessos {
  const porAlvo = new Map(gravados.map((g) => [chaveDoAlvo(g), g]));
  const pedidosPorAlvo = new Map(pedidos.map((p) => [chaveDoAlvo(p), p]));
  const criar: AcessoPedido[] = [];
  const atualizar: { id: string; nivel: NivelAcesso }[] = [];
  for (const [chave, pedido] of pedidosPorAlvo) {
    const gravado = porAlvo.get(chave);
    if (!gravado) {
      criar.push(pedido);
    } else if (gravado.nivel !== pedido.nivel) {
      atualizar.push({ id: gravado.id, nivel: pedido.nivel });
    }
  }
  const remover = gravados
    .filter((g) => !pedidosPorAlvo.has(chaveDoAlvo(g)))
    .map(({ id }) => id);
  return { criar, atualizar, remover };
}

/** A lista em forma estável para a auditoria (antes/depois): `{ alvo, nivel }` em ordem. */
export function resumoDosAcessos(
  acessos: readonly {
    area: Area | null;
    usuarioId: string | null;
    nivel: NivelAcesso;
  }[],
): { alvo: string; nivel: NivelAcesso }[] {
  return acessos
    .map((a) => ({ alvo: chaveDoAlvo(a), nivel: a.nivel }))
    .sort((a, b) => a.alvo.localeCompare(b.alvo));
}
