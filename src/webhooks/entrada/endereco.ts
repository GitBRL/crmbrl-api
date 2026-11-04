import { PREFIXO_DAS_ROTAS, VERSAO_PADRAO_DA_API } from '../../aplicacao';

/** Caminho do endereço público, sem o token (R8.2). */
export const CAMINHO_DO_ENDERECO = `/${PREFIXO_DAS_ROTAS}/v${VERSAO_PADRAO_DA_API}/webhooks/entrada/`;

/** Endereço completo (R8.2): `URL_PUBLICA/api/v1/webhooks/entrada/<token>`. */
export function montarEndereco(urlPublica: string, token: string): string {
  return `${urlPublica}${CAMINHO_DO_ENDERECO}${token}`;
}
