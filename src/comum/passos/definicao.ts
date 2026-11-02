/**
 * Definição de passos (Onda B, §2.1): o formato que o chatbot e as automações
 * gravam (`fluxos_chatbot.rascunho`, `fluxos_chatbot_versoes.definicao`,
 * `automacoes.definicao`, cópia em `execucoes.definicao`) e o editor em lista do
 * front monta.
 *
 * É uma lista de passos; um passo com ramos (condição, pergunta com opções) tem
 * listas aninhadas. Depois do último passo de um ramo, a execução segue para o
 * passo seguinte ao dono do ramo. `proximo` desvia para qualquer passo (ex.:
 * "voltar ao menu").
 *
 * ```json
 * { "passos": [
 *   { "id": "p1", "tipo": "mensagem", "config": { "texto": "Olá {{contato.primeiro_nome}}!" } },
 *   { "id": "p2", "tipo": "pergunta", "config": { "texto": "1) Vendas 2) Suporte" }, "ramos": [
 *     { "id": "vendas", "rotulo": "1", "passos": [{ "id": "p3", "tipo": "transferir", "config": { "filaId": "…" } }] },
 *     { "id": "suporte", "rotulo": "2", "passos": [{ "id": "p4", "tipo": "aguardar", "config": { "quantidade": 1, "unidade": "horas" } }] }
 *   ] },
 *   { "id": "p5", "tipo": "encerrar" }
 * ] }
 * ```
 */
import { DadosInvalidosException } from '../erros/excecoes';

export interface Passo<C = Record<string, unknown>> {
  /** Único na definição (o front gera, ex.: `p_k3j9`); estável entre edições. */
  id: string;
  /** Tipo registrado no `PassosService` (ex.: `mensagem`, `condicao`, `aguardar`). */
  tipo: string;
  /** Texto livre para o editor. */
  rotulo?: string;
  config?: C;
  /** Ramos (o passo escolhe um com `irParaRamo(id)`). */
  ramos?: Ramo[];
  /** Desvio depois de `seguir()`: id de outro passo. */
  proximo?: string;
}

export interface Ramo {
  /** Único dentro do passo (ex.: `sim`, `nao`, `opcao_1`, `senao`). */
  id: string;
  rotulo?: string;
  /** Dados do ramo para o passo (ex.: a condição ou a opção). */
  config?: Record<string, unknown>;
  passos: Passo[];
}

export interface DefinicaoDePassos {
  passos: Passo[];
}

export interface ProblemaDeDefinicao {
  /** Ex.: `passos[1].ramos[0].passos[0].tipo`. */
  caminho: string;
  mensagem: string;
  passoId?: string;
}

/** Valida um passo do tipo: devolve a mensagem do problema, ou nulo. */
export type ValidadorDeConfig = (
  config: Record<string, unknown>,
  passo: Passo,
) => string | null;

export interface OpcoesDeValidacaoDaDefinicao {
  /** Tipos aceitos e seus validadores (sem isso, qualquer tipo serve). */
  tipos?: ReadonlyMap<string, ValidadorDeConfig | undefined>;
  /** Limite de passos (padrão 200). */
  maximoDePassos?: number;
}

/** Valida a estrutura; lança `DadosInvalidosException` com `detalhes.problemas`. */
export function validarDefinicao(
  entrada: unknown,
  opcoes: OpcoesDeValidacaoDaDefinicao = {},
): DefinicaoDePassos {
  const problemas = problemasDaDefinicao(entrada, opcoes);
  if (problemas.length > 0) {
    throw new DadosInvalidosException(problemas[0].mensagem, { problemas });
  }
  return entrada as DefinicaoDePassos;
}

export function problemasDaDefinicao(
  entrada: unknown,
  opcoes: OpcoesDeValidacaoDaDefinicao = {},
): ProblemaDeDefinicao[] {
  const problemas: ProblemaDeDefinicao[] = [];
  if (!ehObjeto(entrada) || !Array.isArray(entrada.passos)) {
    return [
      {
        caminho: 'passos',
        mensagem: 'A definição precisa de uma lista "passos".',
      },
    ];
  }
  const ids = new Set<string>();
  const desvios: Array<{ caminho: string; alvo: string; passoId: string }> = [];
  let total = 0;
  const maximo = opcoes.maximoDePassos ?? 200;

  const visitarLista = (lista: unknown[], caminho: string) => {
    lista.forEach((bruto, indice) => {
      const aqui = `${caminho}[${indice}]`;
      if (++total > maximo) {
        if (total === maximo + 1) {
          problemas.push({
            caminho: aqui,
            mensagem: `No máximo ${maximo} passos.`,
          });
        }
        return;
      }
      if (!ehObjeto(bruto)) {
        problemas.push({ caminho: aqui, mensagem: 'Passo inválido.' });
        return;
      }
      const id = bruto.id;
      if (typeof id !== 'string' || !id.trim() || id.length > 100) {
        problemas.push({
          caminho: `${aqui}.id`,
          mensagem: 'Todo passo precisa de um id.',
        });
        return;
      }
      if (ids.has(id)) {
        problemas.push({
          caminho: `${aqui}.id`,
          mensagem: `Id de passo repetido: "${id}".`,
          passoId: id,
        });
      }
      ids.add(id);
      if (typeof bruto.tipo !== 'string' || !bruto.tipo) {
        problemas.push({
          caminho: `${aqui}.tipo`,
          mensagem: 'Todo passo precisa de um tipo.',
          passoId: id,
        });
      } else if (opcoes.tipos && !opcoes.tipos.has(bruto.tipo)) {
        problemas.push({
          caminho: `${aqui}.tipo`,
          mensagem: `Tipo de passo desconhecido: "${bruto.tipo}".`,
          passoId: id,
        });
      } else if (bruto.config !== undefined && !ehObjeto(bruto.config)) {
        problemas.push({
          caminho: `${aqui}.config`,
          mensagem: 'A configuração do passo precisa ser um objeto.',
          passoId: id,
        });
      } else {
        const validador = opcoes.tipos?.get(bruto.tipo);
        const problema = validador?.(
          (bruto.config ?? {}) as Record<string, unknown>,
          bruto as unknown as Passo,
        );
        if (problema) {
          problemas.push({
            caminho: `${aqui}.config`,
            mensagem: problema,
            passoId: id,
          });
        }
      }
      if (bruto.proximo !== undefined) {
        if (typeof bruto.proximo !== 'string') {
          problemas.push({
            caminho: `${aqui}.proximo`,
            mensagem: 'Desvio inválido.',
            passoId: id,
          });
        } else {
          desvios.push({
            caminho: `${aqui}.proximo`,
            alvo: bruto.proximo,
            passoId: id,
          });
        }
      }
      if (bruto.ramos !== undefined) {
        if (!Array.isArray(bruto.ramos)) {
          problemas.push({
            caminho: `${aqui}.ramos`,
            mensagem: 'Os ramos precisam ser uma lista.',
            passoId: id,
          });
          return;
        }
        const idsDosRamos = new Set<string>();
        bruto.ramos.forEach((ramo: unknown, r: number) => {
          const caminhoDoRamo = `${aqui}.ramos[${r}]`;
          if (
            !ehObjeto(ramo) ||
            typeof ramo.id !== 'string' ||
            !ramo.id ||
            !Array.isArray(ramo.passos)
          ) {
            problemas.push({
              caminho: caminhoDoRamo,
              mensagem: 'Todo ramo precisa de id e de uma lista "passos".',
              passoId: id,
            });
            return;
          }
          if (idsDosRamos.has(ramo.id)) {
            problemas.push({
              caminho: `${caminhoDoRamo}.id`,
              mensagem: `Ramo repetido: "${ramo.id}".`,
              passoId: id,
            });
          }
          idsDosRamos.add(ramo.id);
          visitarLista(ramo.passos, `${caminhoDoRamo}.passos`);
        });
      }
    });
  };
  visitarLista(entrada.passos, 'passos');
  for (const desvio of desvios) {
    if (!ids.has(desvio.alvo)) {
      problemas.push({
        caminho: desvio.caminho,
        mensagem: `O desvio aponta para um passo que não existe: "${desvio.alvo}".`,
        passoId: desvio.passoId,
      });
    }
  }
  return problemas;
}

interface PassoIndexado {
  passo: Passo;
  lista: Passo[];
  indice: number;
  /** Passo dono do ramo em que este está (nulo no nível de cima). */
  dono: string | null;
}

/** Índice da definição para navegar: próximo passo, primeiro do ramo… */
export class IndiceDePassos {
  private readonly porId = new Map<string, PassoIndexado>();

  constructor(readonly definicao: DefinicaoDePassos) {
    const indexar = (lista: Passo[], dono: string | null) => {
      lista.forEach((passo, indice) => {
        this.porId.set(passo.id, { passo, lista, indice, dono });
        for (const ramo of passo.ramos ?? []) {
          indexar(ramo.passos, passo.id);
        }
      });
    };
    indexar(definicao.passos ?? [], null);
  }

  get primeiro(): string | null {
    return this.definicao.passos?.[0]?.id ?? null;
  }

  obter(passoId: string): Passo | null {
    return this.porId.get(passoId)?.passo ?? null;
  }

  existe(passoId: string): boolean {
    return this.porId.has(passoId);
  }

  /**
   * Passo seguinte em sequência (ignora `proximo`): o próximo da mesma lista;
   * no fim de um ramo, o seguinte ao dono do ramo; no fim de tudo, nulo.
   */
  emSequencia(passoId: string): string | null {
    const item = this.porId.get(passoId);
    if (!item) {
      return null;
    }
    if (item.indice + 1 < item.lista.length) {
      return item.lista[item.indice + 1].id;
    }
    return item.dono ? this.emSequencia(item.dono) : null;
  }

  /** Para onde vai depois de `seguir()`: o desvio (`proximo`) ou a sequência. */
  depoisDe(passoId: string): string | null {
    const passo = this.obter(passoId);
    return passo?.proximo ?? this.emSequencia(passoId);
  }

  /**
   * Primeiro passo do ramo; ramo vazio segue como `depoisDe(passo)`. Lança se
   * o ramo não existir.
   */
  entrarNoRamo(passoId: string, ramoId: string): string | null {
    const passo = this.obter(passoId);
    const ramo = passo?.ramos?.find((r) => r.id === ramoId);
    if (!ramo) {
      throw new Error(`O passo "${passoId}" não tem o ramo "${ramoId}".`);
    }
    return ramo.passos[0]?.id ?? this.depoisDe(passoId);
  }
}

function ehObjeto(valor: unknown): valor is Record<string, unknown> {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor);
}
