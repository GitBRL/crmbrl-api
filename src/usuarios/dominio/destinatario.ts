/**
 * Quem recebe o que estava com um usuário desligado (R7.2) — função pura.
 *
 * - membro → o líder dele;
 * - líder → o C-level responsável (o líder dele);
 * - se o destinatário calculado estiver inativo, sobe na cadeia; se a cadeia
 *   acabar, vai para um C-level ativo (o mais antigo, na ordem recebida);
 * - C-level desligado → outro C-level ativo, escolhido pelo Admin no pedido;
 * - Admin desligado → o Admin que executa.
 *
 * Caso que a regra não cobre: a cadeia acaba e não há nenhum C-level ativo —
 * os itens ficam com o Admin que executa (`SEM_C_LEVEL_ATIVO`), para o
 * desligamento (que corta o acesso) nunca ficar impedido.
 */
import {
  type ComPapel,
  nivelDoPapel,
  rotuloDaPessoa,
} from '../../comum/dominio/papeis';
import { juntarNomes, type ProblemaDeRegra } from './hierarquia';

/** O mínimo de cada usuário para percorrer a cadeia de liderança. */
export interface UsuarioDaHierarquia extends ComPapel {
  readonly id: string;
  readonly nome: string;
  readonly ativo: boolean;
  readonly liderId: string | null;
}

/** Por que aquele destinatário foi escolhido (vai na prévia, na auditoria e no evento). */
export type MotivoDestinatario =
  /** Membro: o líder dele, ativo. */
  | 'LIDER'
  /** Líder: o C-level responsável, ativo. */
  | 'C_LEVEL_RESPONSAVEL'
  /** O destinatário calculado estava inativo: subiu na cadeia. */
  | 'SUBIU_NA_CADEIA'
  /** A cadeia acabou sem ninguém ativo: um C-level ativo. */
  | 'C_LEVEL_ATIVO'
  /** C-level desligado: o C-level ativo escolhido pelo Admin. */
  | 'ESCOLHIDO_PELO_ADMIN'
  /** Admin desligado: o Admin que executa. */
  | 'ADMIN_EXECUTOR'
  /** A cadeia acabou e não há C-level ativo: o Admin que executa. */
  | 'SEM_C_LEVEL_ATIVO';

export const MOTIVOS_DESTINATARIO: readonly MotivoDestinatario[] = [
  'LIDER',
  'C_LEVEL_RESPONSAVEL',
  'SUBIU_NA_CADEIA',
  'C_LEVEL_ATIVO',
  'ESCOLHIDO_PELO_ADMIN',
  'ADMIN_EXECUTOR',
  'SEM_C_LEVEL_ATIVO',
];

export type ResultadoDestinatario<
  U extends UsuarioDaHierarquia = UsuarioDaHierarquia,
> =
  | {
      readonly tipo: 'definido';
      readonly destinatario: U;
      readonly motivo: MotivoDestinatario;
      /** Inativos pulados ao subir na cadeia, na ordem em que foram encontrados. */
      readonly ignorados: readonly U[];
    }
  | {
      /** C-level desligado sem a escolha do Admin: a prévia mostra os candidatos. */
      readonly tipo: 'escolha_necessaria';
      readonly candidatos: readonly U[];
    }
  | ({ readonly tipo: 'invalido' } & ProblemaDeRegra);

export interface EntradaDoDestinatario<U extends UsuarioDaHierarquia> {
  /** Quem está sendo desligado. */
  readonly desligado: U;
  /** O Admin que executa o desligamento. */
  readonly executor: U;
  /**
   * Usuários conhecidos, para subir na cadeia e achar C-levels ativos. A ordem
   * importa: o C-level de reserva é o primeiro ativo da lista (o serviço passa
   * em ordem de criação).
   */
  readonly usuarios: readonly U[];
  /** O C-level escolhido pelo Admin (só no desligamento de um C-level). */
  readonly escolhidoId?: string | null;
}

/** Limite de saltos ao subir na cadeia (a hierarquia real tem no máximo 3 níveis). */
const SALTOS_MAXIMOS = 20;

/** Escolhe o destinatário do desligamento (R7.2). */
export function escolherDestinatario<U extends UsuarioDaHierarquia>(
  entrada: EntradaDoDestinatario<U>,
): ResultadoDestinatario<U> {
  const { desligado, executor, usuarios, escolhidoId } = entrada;
  if (desligado.id === executor.id) {
    return {
      tipo: 'invalido',
      regra: 'R7.2',
      mensagem:
        'Você não pode desligar a própria conta: peça a outro Admin, que recebe o que está com você.',
    };
  }
  const cLevelsAtivos = usuarios.filter(
    (usuario) =>
      usuario.papel === 'C_LEVEL' &&
      usuario.ativo &&
      usuario.id !== desligado.id,
  );

  switch (nivelDoPapel(desligado.papel)) {
    case 'ADMINISTRADOR':
      return {
        tipo: 'definido',
        destinatario: executor,
        motivo: 'ADMIN_EXECUTOR',
        ignorados: [],
      };

    case 'DIRETORIA': {
      if (cLevelsAtivos.length === 0) {
        return {
          tipo: 'invalido',
          regra: 'R7.2',
          mensagem: `Não há outro C-level ativo para receber o que está com ${desligado.nome}. Cadastre ou reative um C-level antes do desligamento.`,
        };
      }
      if (!escolhidoId) {
        return { tipo: 'escolha_necessaria', candidatos: cLevelsAtivos };
      }
      const escolhido = cLevelsAtivos.find(({ id }) => id === escolhidoId);
      if (!escolhido) {
        return {
          tipo: 'invalido',
          regra: 'R7.2',
          mensagem: `Quem recebe o que está com ${desligado.nome} (C-level) precisa ser outro C-level ativo.`,
          detalhes: { destinatarioId: escolhidoId },
        };
      }
      return {
        tipo: 'definido',
        destinatario: escolhido,
        motivo: 'ESCOLHIDO_PELO_ADMIN',
        ignorados: [],
      };
    }

    default: {
      // Líder ou membro: sobe pela cadeia de liderança até alguém ativo.
      const porId = new Map(usuarios.map((usuario) => [usuario.id, usuario]));
      const ignorados: U[] = [];
      const vistos = new Set<string>([desligado.id]);
      let proximoId = desligado.liderId;
      for (
        let salto = 0;
        proximoId && salto < SALTOS_MAXIMOS && !vistos.has(proximoId);
        salto++
      ) {
        vistos.add(proximoId);
        const candidato = porId.get(proximoId);
        if (!candidato) {
          break;
        }
        if (candidato.ativo) {
          return {
            tipo: 'definido',
            destinatario: candidato,
            motivo:
              ignorados.length > 0
                ? 'SUBIU_NA_CADEIA'
                : nivelDoPapel(desligado.papel) === 'LIDER'
                  ? 'C_LEVEL_RESPONSAVEL'
                  : 'LIDER',
            ignorados,
          };
        }
        ignorados.push(candidato);
        proximoId = candidato.liderId;
      }
      const reserva = cLevelsAtivos[0];
      return reserva
        ? {
            tipo: 'definido',
            destinatario: reserva,
            motivo: 'C_LEVEL_ATIVO',
            ignorados,
          }
        : {
            tipo: 'definido',
            destinatario: executor,
            motivo: 'SEM_C_LEVEL_ATIVO',
            ignorados,
          };
    }
  }
}

/** Frase da prévia explicando por que o destinatário é aquele. */
export function explicarDestinatario(
  desligado: Pick<UsuarioDaHierarquia, 'nome' | 'papel' | 'area'>,
  resultado: ResultadoDestinatario,
): string {
  const quem = `${desligado.nome} (${rotuloDaPessoa(desligado)})`;
  if (resultado.tipo === 'invalido') {
    return resultado.mensagem;
  }
  if (resultado.tipo === 'escolha_necessaria') {
    return `${quem} é C-level: escolha outro C-level ativo para receber o que está com ${desligado.nome}.`;
  }
  const destinatario = resultado.destinatario.nome;
  // "O líder … foi desligado": concorda com "líder", não com a pessoa.
  const pulados = juntarNomes(resultado.ignorados.map(({ nome }) => nome));
  const lideresDesligados =
    resultado.ignorados.length === 1
      ? `O líder de ${quem}, ${pulados}, foi desligado`
      : `Os líderes acima de ${quem} (${pulados}) foram desligados`;
  switch (resultado.motivo) {
    case 'LIDER':
      return `O que está com ${quem} vai para o líder, ${destinatario}.`;
    case 'C_LEVEL_RESPONSAVEL':
      return `O que está com ${quem} vai para o C-level responsável, ${destinatario}.`;
    case 'SUBIU_NA_CADEIA':
      return `${lideresDesligados}: o que está com ${desligado.nome} sobe na cadeia até ${destinatario}.`;
    case 'C_LEVEL_ATIVO':
      return resultado.ignorados.length > 0
        ? `${lideresDesligados} e a cadeia acabou: vai para um C-level ativo, ${destinatario}.`
        : `${quem} não tem líder: vai para um C-level ativo, ${destinatario}.`;
    case 'ESCOLHIDO_PELO_ADMIN':
      return `O que está com ${quem} vai para o C-level escolhido, ${destinatario}.`;
    case 'ADMIN_EXECUTOR':
      return `O que está com ${quem} vai para quem executa o desligamento, ${destinatario}.`;
    case 'SEM_C_LEVEL_ATIVO':
      return `Não há líder ativo na cadeia de ${quem} nem C-level ativo: fica com quem executa o desligamento, ${destinatario}.`;
  }
}
