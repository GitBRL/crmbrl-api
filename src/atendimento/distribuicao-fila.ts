/**
 * Distribuição das conversas pela fila (R12) — a parte sem banco: quem
 * participa e quem é o próximo.
 *
 * - **Participantes:** sem lista definida (modo `AREA`), todos os membros
 *   ativos da área da fila, menos os retirados à mão; com lista (modo
 *   `LISTA`, alguma linha `participa = true`), só os da lista — que pode
 *   incluir o líder. Em qualquer modo, só entra quem já ativou o acesso
 *   (mesmo ajuste da R5.8).
 * - **Estratégias:** `RODIZIO` (ordem estável, ponteiro na fila), `MENOR_CARGA`
 *   (menos conversas em aberto; empate desempata pelo rodízio) e `MANUAL`
 *   (ninguém é escolhido: fica na fila até alguém assumir).
 */
import { ehLider, ehMembro, papeisDaArea } from '../comum/dominio/papeis';
import {
  motivoSemAcessoAtivado,
  type PosicaoNoRodizio,
  ordenarParaRodizio,
  proximoDoRodizio,
} from '../funis/rodizio';
import type { Area, EstrategiaFila, Papel } from '../generated/prisma/client';

export type ModoDosParticipantes = 'AREA' | 'LISTA';

/** Por que a pessoa está (ou não) na distribuição da fila. */
export type MotivoNaFila =
  /** Membro da área, sem lista definida. */
  | 'AREA'
  /** Está na lista da fila. */
  | 'NA_LISTA'
  /** Retirada à mão (modo área). */
  | 'RETIRADO'
  /** Fora da lista (modo lista). */
  | 'FORA_DA_LISTA'
  /** Líder da área: só entra pela lista. */
  | 'LIDER'
  /** Ainda não definiu a senha do convite. */
  | 'CONVITE_PENDENTE'
  /** Ainda não concluiu o primeiro acesso (senha temporária). */
  | 'PRIMEIRO_ACESSO_PENDENTE';

export interface UsuarioDaFila extends PosicaoNoRodizio {
  readonly nome: string;
  readonly papel: Papel;
  readonly avatarUrl: string | null;
  readonly acessoAtivadoEm: Date | null;
  readonly senhaHash: string | null;
}

export interface LinhaDeParticipacao {
  readonly usuarioId: string;
  readonly participa: boolean;
}

export interface PessoaNaFila<U extends UsuarioDaFila> {
  readonly usuario: U;
  /** Entra na distribuição agora. */
  readonly participa: boolean;
  readonly motivo: MotivoNaFila;
}

export interface ParticipantesDaFila<U extends UsuarioDaFila> {
  readonly modo: ModoDosParticipantes;
  /** Todas as pessoas ativas da área, na ordem do rodízio, com a situação de cada uma. */
  readonly pessoas: readonly PessoaNaFila<U>[];
  /** Quem recebe conversas, na ordem do rodízio. */
  readonly elegiveis: readonly U[];
}

/**
 * Quem participa da fila. `usuarios` são as pessoas **ativas** da área da fila
 * (líder e membros); `linhas`, os ajustes gravados em `fila_participantes`.
 */
export function participantesDaFila<U extends UsuarioDaFila>(
  area: Area,
  usuarios: readonly U[],
  linhas: readonly LinhaDeParticipacao[],
): ParticipantesDaFila<U> {
  const daArea = new Set<Papel>(papeisDaArea(area));
  const porUsuario = new Map(linhas.map((linha) => [linha.usuarioId, linha]));
  const modo: ModoDosParticipantes = linhas.some((linha) => linha.participa)
    ? 'LISTA'
    : 'AREA';
  const pessoas: PessoaNaFila<U>[] = [];
  for (const usuario of ordenarParaRodizio(
    usuarios.filter((item) => daArea.has(item.papel)),
  )) {
    const linha = porUsuario.get(usuario.id);
    let motivo: MotivoNaFila;
    let candidato: boolean;
    if (modo === 'LISTA') {
      candidato = linha?.participa === true;
      motivo = candidato ? 'NA_LISTA' : 'FORA_DA_LISTA';
    } else if (linha && !linha.participa) {
      candidato = false;
      motivo = 'RETIRADO';
    } else if (ehLider(usuario.papel)) {
      candidato = false;
      motivo = 'LIDER';
    } else {
      candidato = ehMembro(usuario.papel);
      motivo = 'AREA';
    }
    const semAcesso = candidato ? motivoSemAcessoAtivado(usuario) : null;
    pessoas.push({
      usuario,
      participa: candidato && semAcesso === null,
      motivo: semAcesso ?? motivo,
    });
  }
  return {
    modo,
    pessoas,
    elegiveis: pessoas
      .filter((pessoa) => pessoa.participa)
      .map((pessoa) => pessoa.usuario),
  };
}

/**
 * O próximo responsável pela estratégia da fila. `ponteiro` é o último
 * escolhido (`filas_atendimento.ultimo_usuario_id`); `cargas`, quantas
 * conversas em aberto cada elegível tem (só no `MENOR_CARGA`).
 */
export function escolherNaFila<U extends PosicaoNoRodizio>(
  estrategia: EstrategiaFila,
  elegiveis: readonly U[],
  ponteiro: PosicaoNoRodizio | null,
  cargas: ReadonlyMap<string, number> = new Map(),
): U | null {
  if (estrategia === 'MANUAL' || elegiveis.length === 0) {
    return null;
  }
  if (estrategia === 'RODIZIO') {
    return proximoDoRodizio(elegiveis, ponteiro);
  }
  const menor = Math.min(
    ...elegiveis.map((usuario) => cargas.get(usuario.id) ?? 0),
  );
  const empatados = elegiveis.filter(
    (usuario) => (cargas.get(usuario.id) ?? 0) === menor,
  );
  return proximoDoRodizio(empatados, ponteiro);
}
