/**
 * O `state` do login em outra janela (R32.14, R32.23, R32.25, R32.26), em funções puras.
 *
 * Formato: `<conexaoId>.<nonce>.<expiraEmSegundos>.<hmac>`. O `nonce` leva o Admin
 * que iniciou o login, o modo (`j` janela, `p` página) e, nas conexões de
 * aplicativo, o serviço (`typeform`, `rd-station`): `<aleatório>~<adminId>~<j|p>[~<serviço>]`.
 * O HMAC usa a chave de criptografia, separado por domínio (um `state` do Facebook
 * não vale nas conexões de aplicativo). O uso único é do banco (o hash do `nonce`
 * fica na conexão); aqui só se confere a assinatura e a validade.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const VALIDADE_DO_STATE_MS = 10 * 60_000;

export type ModoDeLogin = 'janela' | 'pagina';
export const MODOS_DE_LOGIN: readonly ModoDeLogin[] = ['janela', 'pagina'];

const FORMATO_DO_UUID = /^[0-9a-f-]{36}$/i;

export interface DadosDoState {
  readonly conexaoId: string;
  readonly nonce: string;
  readonly usuarioId: string;
  readonly modo: ModoDeLogin;
  /** Nas conexões de aplicativo: `typeform` ou `rd-station`. */
  readonly aplicativo: string | null;
}

export function novoNonce(
  usuarioId: string,
  modo: ModoDeLogin,
  aplicativo?: string,
): string {
  return [
    randomBytes(24).toString('base64url'),
    usuarioId,
    modo === 'janela' ? 'j' : 'p',
    ...(aplicativo ? [aplicativo] : []),
  ].join('~');
}

function mac(chave: string | Buffer, dominio: string, carga: string): string {
  return createHmac('sha256', chave)
    .update(`${dominio}:${carga}`)
    .digest('base64url');
}

export function assinarState(
  chave: string | Buffer,
  dominio: string,
  conexaoId: string,
  nonce: string,
  expiraEmSegundos: number,
): string {
  const carga = `${conexaoId}.${nonce}.${expiraEmSegundos}`;
  return `${carga}.${mac(chave, dominio, carga)}`;
}

export function lerState(
  chave: string | Buffer,
  dominio: string,
  valor: unknown,
  agora: number = Date.now(),
): DadosDoState | 'invalido' | 'vencido' {
  if (typeof valor !== 'string' || valor.length > 400) {
    return 'invalido';
  }
  const partes = valor.split('.');
  if (partes.length !== 4) {
    return 'invalido';
  }
  const [conexaoId, nonce, exp, assinatura] = partes;
  const esperado = Buffer.from(
    mac(chave, dominio, `${conexaoId}.${nonce}.${exp}`),
  );
  const recebido = Buffer.from(assinatura);
  if (
    esperado.length !== recebido.length ||
    !timingSafeEqual(esperado, recebido) ||
    !FORMATO_DO_UUID.test(conexaoId)
  ) {
    return 'invalido';
  }
  const [, usuarioId = '', modo = 'p', aplicativo = null] = nonce.split('~');
  if (!FORMATO_DO_UUID.test(usuarioId)) {
    return 'invalido';
  }
  return Number(exp) * 1000 < agora
    ? 'vencido'
    : {
        conexaoId,
        nonce,
        usuarioId,
        modo: modo === 'j' ? 'janela' : 'pagina',
        aplicativo,
      };
}

/**
 * O modo (e o serviço) escritos no `state`, SEM conferir a assinatura: serve só para
 * escolher entre dois destinos fixos do próprio CRM quando o `state` é inválido ou vencido
 * (nunca vira endereço de redirecionamento).
 */
export function dicasDoState(valor: unknown): {
  modo: ModoDeLogin;
  aplicativo: string | null;
} {
  const nonce = typeof valor === 'string' ? (valor.split('.')[1] ?? '') : '';
  const [, , modo, aplicativo] = nonce.split('~');
  return {
    modo: modo === 'j' ? 'janela' : 'pagina',
    aplicativo:
      aplicativo === 'typeform' || aplicativo === 'rd-station'
        ? aplicativo
        : null,
  };
}
