/**
 * Carrega do banco os acessos aos funis (R5.9, R5.11–R5.13) e aplica as regras
 * puras de `acesso-funis.ts`. Funcionam com o `PrismaService` ou dentro de uma
 * transação, sem injeção (como `setores-no-banco.ts`).
 *
 * - `funisAcessiveis(db, pessoa)`: o mapa `funil → nível` da pessoa — a base de
 *   **toda** consulta e ação de negócio. Guardado por requisição (o contexto da
 *   requisição HTTP ou do job): são poucos funis e poucas linhas de acesso.
 * - `acessosDoFunil(db, funil)`: os acessos de um funil, para saber o nível de
 *   **outras** pessoas nele (responsável válido, rodízio de funil restrito).
 */
import {
  type ContextoRequisicao,
  contextoAtual,
  haContexto,
} from '../comum/contexto/contexto-requisicao';
import { ehDiretoria, setorDaPessoa } from '../comum/dominio/papeis';
import type { Area } from '../comum/dominio/setores';
import type { Tx } from '../prisma/prisma.service';
import {
  type AcessoExtra,
  AcessoAosFunis,
  type FunilParaAcesso,
  type NivelNoFunil,
  nivelAlcanca,
  nivelEfetivo,
  type QuemAcessa,
} from './acesso-funis';

/** O pedaço do cliente Prisma que estas funções usam (cabe o serviço e a transação). */
export type LeitorDeAcessos = Pick<
  Tx,
  'funil' | 'acessoFunil' | 'acessoSetor' | 'setor'
>;

/** Cache por requisição: contexto → pessoa → mapa (as promessas, para não repetir a busca). */
const guardados = new WeakMap<
  ContextoRequisicao,
  Map<string, Promise<AcessoAosFunis>>
>();

function cacheDaRequisicao(): Map<string, Promise<AcessoAosFunis>> | undefined {
  if (!haContexto()) {
    return undefined;
  }
  const contexto = contextoAtual();
  let cache = guardados.get(contexto);
  if (!cache) {
    cache = new Map();
    guardados.set(contexto, cache);
  }
  return cache;
}

/** Descarta o que a requisição guardou (chame depois de mudar visibilidade ou acessos). */
export function esquecerAcessosDaRequisicao(): void {
  if (haContexto()) {
    guardados.delete(contextoAtual());
  }
}

/**
 * O nível da pessoa em cada funil que ela vê (R5.9, R5.11): o mapa usado por
 * todas as consultas e ações de negócio. Admin e C-level veem todos (sem busca).
 * Funis excluídos entram (os negócios fechados deles continuam consultáveis);
 * quem lista funis filtra `excluidoEm`.
 */
export function funisAcessiveis(
  db: LeitorDeAcessos,
  pessoa: QuemAcessa,
): Promise<AcessoAosFunis> {
  if (ehDiretoria(pessoa.papel)) {
    return Promise.resolve(AcessoAosFunis.deDiretoria(pessoa));
  }
  const cache = cacheDaRequisicao();
  const chave = `${pessoa.id}:${pessoa.papel}:${pessoa.area ?? ''}`;
  const guardado = cache?.get(chave);
  if (guardado) {
    return guardado;
  }
  const calculo = calcularAcessos(db, pessoa);
  cache?.set(chave, calculo);
  // Uma falha não fica guardada (a próxima chamada tenta de novo).
  calculo.catch(() => cache?.delete(chave));
  return calculo;
}

async function calcularAcessos(
  db: LeitorDeAcessos,
  pessoa: QuemAcessa,
): Promise<AcessoAosFunis> {
  const meuSetor = setorDaPessoa(pessoa);
  const meuSetorAtivo = meuSetor
    ? ((
        await db.setor.findUnique({
          where: { chave: meuSetor },
          select: { ativo: true },
        })
      )?.ativo ?? false)
    : false;
  const alvos = [
    { usuarioId: pessoa.id },
    ...(meuSetor && meuSetorAtivo ? [{ area: meuSetor }] : []),
  ];
  const [acessosFunil, acessosSetor] = await Promise.all([
    db.acessoFunil.findMany({
      where: { OR: alvos },
      select: { funilId: true, area: true, usuarioId: true, nivel: true },
    }),
    db.acessoSetor.findMany({
      where: { OR: alvos },
      select: { areaDono: true, area: true, usuarioId: true, nivel: true },
    }),
  ]);
  const funis = await db.funil.findMany({
    where: {
      OR: [
        ...(meuSetor ? [{ area: meuSetor }] : []),
        { id: { in: acessosFunil.map(({ funilId }) => funilId) } },
        { area: { in: acessosSetor.map(({ areaDono }) => areaDono) } },
      ],
    },
    select: { id: true, area: true, visibilidade: true },
  });
  const setorAtivo = (area: Area) => area === meuSetor && meuSetorAtivo;
  const niveis = new Map<string, NivelNoFunil>();
  for (const funil of funis) {
    const nivel = nivelEfetivo(
      pessoa,
      funil,
      {
        doFunil: acessosFunil.filter(({ funilId }) => funilId === funil.id),
        doSetor: acessosSetor.filter(({ areaDono }) => areaDono === funil.area),
      },
      setorAtivo,
    );
    if (nivel) {
      niveis.set(funil.id, nivel);
    }
  }
  return AcessoAosFunis.comNiveis(pessoa, niveis);
}

/** Os acessos de um funil, prontos para dizer o nível de qualquer pessoa nele. */
export interface AcessosCarregados {
  readonly funil: FunilParaAcesso;
  nivelDe(pessoa: QuemAcessa): NivelNoFunil | null;
}

/**
 * Os acessos que valem para o funil (a lista dele e, se não for `RESTRITA`, a
 * do setor dono), com os setores-alvo ativos — para o nível de outras pessoas.
 */
export async function acessosDoFunil(
  db: LeitorDeAcessos,
  funil: FunilParaAcesso,
): Promise<AcessosCarregados> {
  const [doFunil, doSetor] = await Promise.all([
    db.acessoFunil.findMany({
      where: { funilId: funil.id },
      select: { area: true, usuarioId: true, nivel: true },
    }),
    funil.visibilidade === 'SETOR'
      ? db.acessoSetor.findMany({
          where: { areaDono: funil.area },
          select: { area: true, usuarioId: true, nivel: true },
        })
      : Promise.resolve([] as AcessoExtra[]),
  ]);
  const areas = [
    ...new Set(
      [...doFunil, ...doSetor].flatMap(({ area }) => (area ? [area] : [])),
    ),
  ];
  const ativos = new Set(
    areas.length > 0
      ? (
          await db.setor.findMany({
            where: { chave: { in: areas }, ativo: true },
            select: { chave: true },
          })
        ).map(({ chave }) => chave)
      : [],
  );
  const acessos = { doFunil, doSetor };
  return {
    funil,
    nivelDe: (pessoa) =>
      nivelEfetivo(pessoa, funil, acessos, (area) => ativos.has(area)),
  };
}

/**
 * R5.13: pode ser responsável por negócio do funil — pessoa ativa com nível
 * `MEMBRO` ou mais nele (do setor dono — no `RESTRITA`, os líderes e quem está na
 * lista —, com acesso `MEMBRO`/`GESTOR`, C-level ou Admin).
 */
export function podeSerResponsavel(
  acessos: AcessosCarregados,
  pessoa: QuemAcessa & { readonly ativo: boolean },
): boolean {
  return pessoa.ativo && nivelAlcanca(acessos.nivelDe(pessoa), 'MEMBRO');
}

/** `podeSerResponsavel` carregando os acessos do funil. */
export async function podeSerResponsavelNoFunil(
  db: LeitorDeAcessos,
  funil: FunilParaAcesso,
  pessoa: QuemAcessa & { readonly ativo: boolean },
): Promise<boolean> {
  if (!pessoa.ativo) {
    return false;
  }
  if (ehDiretoria(pessoa.papel)) {
    return true;
  }
  return podeSerResponsavel(await acessosDoFunil(db, funil), pessoa);
}
