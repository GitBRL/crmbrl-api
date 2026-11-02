import {
  CHAVE_CONFIGURACAO_DISPAROS,
  MENSAGEM_DE_SAIDA_PADRAO,
  PALAVRAS_DE_SAIDA_PADRAO,
} from './disparos.constantes';

/** Configuração do módulo, em `configuracoes.disparos` (padrões no código). */
export interface ConfiguracaoDisparos {
  /** Campanha de membro só começa depois da aprovação do líder da área. */
  aprovacaoDoLider: boolean;
  /** Palavras que pedem o opt-out (a mensagem inteira, sem acento nem caixa). */
  palavrasDeSaida: string[];
  /** Confirmação enviada depois de aplicar o opt-out. */
  mensagemDeSaida: string;
}

export const CONFIGURACAO_PADRAO_DISPAROS: Readonly<ConfiguracaoDisparos> = {
  aprovacaoDoLider: false,
  palavrasDeSaida: [...PALAVRAS_DE_SAIDA_PADRAO],
  mensagemDeSaida: MENSAGEM_DE_SAIDA_PADRAO,
};

export { CHAVE_CONFIGURACAO_DISPAROS };

/** Lê o JSON salvo, completando com os padrões e descartando o que não serve. */
export function lerConfiguracaoDisparos(valor: unknown): ConfiguracaoDisparos {
  const bruto =
    valor && typeof valor === 'object' && !Array.isArray(valor)
      ? (valor as Record<string, unknown>)
      : {};
  const palavras = Array.isArray(bruto.palavrasDeSaida)
    ? bruto.palavrasDeSaida
        .filter((p): p is string => typeof p === 'string')
        .map((p) => p.trim())
        .filter((p) => p !== '')
    : [];
  const mensagem =
    typeof bruto.mensagemDeSaida === 'string' &&
    bruto.mensagemDeSaida.trim() !== ''
      ? bruto.mensagemDeSaida.trim()
      : CONFIGURACAO_PADRAO_DISPAROS.mensagemDeSaida;
  return {
    aprovacaoDoLider:
      typeof bruto.aprovacaoDoLider === 'boolean'
        ? bruto.aprovacaoDoLider
        : CONFIGURACAO_PADRAO_DISPAROS.aprovacaoDoLider,
    palavrasDeSaida:
      palavras.length > 0
        ? [...new Set(palavras)]
        : [...CONFIGURACAO_PADRAO_DISPAROS.palavrasDeSaida],
    mensagemDeSaida: mensagem,
  };
}
