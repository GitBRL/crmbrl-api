import { MODELOS_PRONTOS, type Mapeamento } from '../entrada/mapeamento';
import { itemUnico } from './comum';
import { cabecalho } from './seguranca';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type {
  AdaptadorDeAplicativo,
  EntradaDeAutenticidade,
  ResultadoDeAutenticidade,
} from './tipos';

/** `X-Assinatura: sha256=<hex>`: o HMAC-SHA256 do corpo bruto (R8.3). */
export function conferirAssinaturaHmac(
  segredo: string,
  corpoBruto: Buffer,
  assinatura: string | null,
): boolean {
  if (!assinatura) {
    return false;
  }
  const recebida = assinatura
    .trim()
    .replace(/^sha256=/i, '')
    .toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(recebida)) {
    return false;
  }
  const esperada = createHmac('sha256', segredo).update(corpoBruto).digest();
  return timingSafeEqual(esperada, Buffer.from(recebida, 'hex'));
}

function verificar(entrada: EntradaDeAutenticidade): ResultadoDeAutenticidade {
  if (!entrada.segredo) {
    return { ok: true };
  }
  const assinatura = cabecalho(entrada.cabecalhos, 'x-assinatura');
  if (conferirAssinaturaHmac(entrada.segredo, entrada.corpoBruto, assinatura)) {
    return { ok: true };
  }
  return {
    ok: false,
    mensagem: assinatura
      ? 'Assinatura inválida: X-Assinatura não confere com o HMAC-SHA256 do corpo.'
      : 'Assinatura ausente: este webhook exige X-Assinatura: sha256=<hmac do corpo>.',
  };
}

const MODELO_GENERICO: Mapeamento = MODELOS_PRONTOS.GENERICO.mapeamento;

/** Webhook: o ponto de entrada genérico do R8, como sempre foi (R32.2). */
export const adaptadorWebhook: AdaptadorDeAplicativo = {
  definicao: {
    aplicativo: 'WEBHOOK',
    nome: 'Webhook',
    descricao:
      'Receba leads de qualquer sistema que envie um POST (JSON ou formulário) para o endereço da integração.',
    disponivel: true,
    entrega: 'WEBHOOK',
    tiposDeConteudo: ['application/json', 'application/x-www-form-urlencoded'],
    autenticidade: {
      tipo: 'HMAC_X_ASSINATURA',
      descricao:
        'Opcional: com segredo, toda chamada precisa de X-Assinatura: sha256=<HMAC-SHA256 do corpo>.',
      segredo: 'OPCIONAL',
      rotuloDoSegredo: 'Segredo HMAC',
      cabecalho: 'X-Assinatura',
    },
    credencial: null,
    buscaCampos: false,
    escolheFormulario: false,
    passoAPasso: {
      titulo: 'No sistema que envia',
      passos: [
        'Cadastre o endereço da integração como destino de um webhook (método POST).',
        'Envie o corpo em JSON (Content-Type: application/json) ou como formulário (application/x-www-form-urlencoded), com até 256 KB.',
        'Se criar um segredo, assine o corpo bruto com HMAC-SHA256 e envie no cabeçalho X-Assinatura como sha256=<hex>.',
        'Dispare um envio de teste e use "Atualizar campos recebidos" no mapeamento para ver os campos que chegaram.',
      ],
    },
    modelo: {
      nome: MODELOS_PRONTOS.GENERICO.nome,
      descricao: MODELOS_PRONTOS.GENERICO.descricao,
      mapeamento: MODELO_GENERICO,
      exemplo: MODELOS_PRONTOS.GENERICO.exemplo,
    },
    dicas: [],
  },
  normalizarCorpo: itemUnico,
  verificarAutenticidade: verificar,
};
