/**
 * Para onde o retorno público do login leva o navegador (R32.23). Em modo `janela`, a
 * página `/retorno-login` do front (que avisa o assistente e fecha a janela); em modo
 * `pagina`, a tela de Integrações, como antes. Os destinos são fixos e partem de
 * `URL_PUBLICA`: nada do que a Meta, o Typeform ou o RD devolvem vira endereço.
 */
import type { ModoDeLogin } from './estado-do-login';

export type AplicativoDoRetorno = 'facebook' | 'typeform' | 'rd-station';
export type ResultadoDoLogin = 'conectado' | 'cancelado' | 'erro';

export const CAMINHO_DA_PAGINA_DE_RETORNO = '/retorno-login';
export const CAMINHO_DA_TELA_DE_INTEGRACOES = '/integracoes';

export interface DesfechoDoLogin {
  readonly aplicativo: AplicativoDoRetorno;
  readonly resultado: ResultadoDoLogin;
  readonly conexaoId: string | null;
  readonly motivo: string | null;
  readonly mensagem: string | null;
}

export function destinoDoRetorno(
  urlPublica: string,
  modo: ModoDeLogin,
  desfecho: DesfechoDoLogin,
): string {
  const parametros = new URLSearchParams();
  if (modo === 'janela') {
    parametros.set('app', desfecho.aplicativo);
    parametros.set('resultado', desfecho.resultado);
  } else {
    parametros.set(desfecho.aplicativo, desfecho.resultado);
  }
  if (desfecho.conexaoId) {
    parametros.set('conexao', desfecho.conexaoId);
  }
  if (desfecho.motivo) {
    parametros.set('motivo', desfecho.motivo);
  }
  if (desfecho.mensagem) {
    parametros.set('mensagem', desfecho.mensagem);
  }
  const caminho =
    modo === 'janela'
      ? CAMINHO_DA_PAGINA_DE_RETORNO
      : CAMINHO_DA_TELA_DE_INTEGRACOES;
  return `${urlPublica}${caminho}?${parametros.toString()}`;
}
