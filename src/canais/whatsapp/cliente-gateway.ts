import { Inject, Injectable, Logger } from '@nestjs/common';
import { contextoAtual } from '../../comum/contexto/contexto-requisicao';
import {
  ConflitoException,
  DadosInvalidosException,
  NaoEncontradoException,
  ServicoIndisponivelException,
} from '../../comum/erros/excecoes';
import { AMBIENTE, type Ambiente } from '../../config/ambiente';
import {
  CABECALHO_ATOR,
  CABECALHO_TOKEN_INTERNO,
  codificarAtor,
  type EstadoDoNumero,
  type PedidoDeDigitando,
  type ResultadoDaVerificacao,
  ROTAS_DO_GATEWAY,
} from './contrato-gateway';

/** Prazo de cada comando ao gateway. */
const PRAZO_DO_COMANDO_MS = 15_000;

/** Prazo do "digitando…" (melhor esforço: não segura ninguém). */
const PRAZO_DO_DIGITANDO_MS = 3_000;

/**
 * Comandos síncronos da API ao gateway de WhatsApp (HTTP interno em
 * `WHATSAPP_URL_INTERNA`, com `X-Token-Interno`). Envios não passam por aqui:
 * vão pela fila do número (`filaDeEnvio`).
 *
 * Erros: gateway fora do ar → 503; número desconhecido → 404; número não
 * conectado (verificar) → 409; pedido recusado pelo gateway (4xx) → 400 com a
 * mensagem dele. Cada comando leva o id da requisição (`X-Request-Id`, para
 * correlacionar os logs) e quem pediu (`x-ator`, para a auditoria do gateway).
 */
@Injectable()
export class ClienteGatewayWhatsapp {
  private readonly logger = new Logger('WhatsApp');

  constructor(@Inject(AMBIENTE) private readonly ambiente: Ambiente) {}

  /** Inicia a conexão do número (o QR chega pelo evento `whatsapp.conexao`). */
  conectar(numeroId: string): Promise<EstadoDoNumero> {
    return this.pedir('POST', ROTAS_DO_GATEWAY.conectar(numeroId), {});
  }

  /** Desconecta; com `sair`, faz logout (o número precisa ler o QR de novo). */
  desconectar(
    numeroId: string,
    opcoes: { sair?: boolean } = {},
  ): Promise<EstadoDoNumero> {
    return this.pedir('POST', ROTAS_DO_GATEWAY.desconectar(numeroId), {
      sair: opcoes.sair ?? false,
    });
  }

  status(numeroId: string): Promise<EstadoDoNumero> {
    return this.pedir('GET', ROTAS_DO_GATEWAY.status(numeroId));
  }

  /** O telefone tem WhatsApp? (com cache no gateway) */
  verificar(
    numeroId: string,
    telefone: string,
  ): Promise<ResultadoDaVerificacao> {
    return this.pedir('POST', ROTAS_DO_GATEWAY.verificar(numeroId), {
      telefone,
    });
  }

  /** "Digitando…" do atendente para o contato. Melhor esforço: nunca lança. */
  async digitando(numeroId: string, pedido: PedidoDeDigitando): Promise<void> {
    await this.pedir<void>(
      'POST',
      ROTAS_DO_GATEWAY.digitando(numeroId),
      pedido,
      PRAZO_DO_DIGITANDO_MS,
    ).catch(() => undefined);
  }

  private async pedir<T>(
    metodo: 'GET' | 'POST',
    caminho: string,
    corpo?: object,
    prazoMs = PRAZO_DO_COMANDO_MS,
  ): Promise<T> {
    const url = `${this.ambiente.whatsapp.urlInterna}${caminho}`;
    const contexto = contextoAtual();
    const pedido: RequestInit = {
      method: metodo,
      headers: {
        [CABECALHO_TOKEN_INTERNO]: this.ambiente.whatsapp.tokenInterno,
        'x-request-id': contexto.requisicaoId,
        ...(contexto.usuario
          ? {
              [CABECALHO_ATOR]: codificarAtor({
                id: contexto.usuario.id,
                nome: contexto.usuario.nome,
                papel: contexto.usuario.papel,
              }),
            }
          : {}),
        ...(corpo ? { 'content-type': 'application/json' } : {}),
      },
      signal: AbortSignal.timeout(prazoMs),
      redirect: 'error',
    };
    if (corpo) {
      pedido.body = JSON.stringify(corpo);
    }
    let resposta: Response;
    try {
      resposta = await fetch(url, pedido);
    } catch (erro) {
      this.logger.warn(
        `Gateway de WhatsApp não respondeu (${metodo} ${caminho}): ${erro instanceof Error ? erro.message : String(erro)}`,
      );
      throw new ServicoIndisponivelException(
        'O serviço de WhatsApp não está respondendo agora. Tente de novo em instantes.',
      );
    }
    const texto = await resposta.text();
    const dados = lerJson(texto);
    if (resposta.ok) {
      return dados as T;
    }
    const mensagem =
      typeof dados === 'object' &&
      dados !== null &&
      typeof (dados as { mensagem?: unknown }).mensagem === 'string'
        ? (dados as { mensagem: string }).mensagem
        : undefined;
    if (resposta.status === 404) {
      throw new NaoEncontradoException(
        mensagem ?? 'Número de WhatsApp não encontrado.',
      );
    }
    if (resposta.status === 409) {
      throw new ConflitoException(
        mensagem ?? 'O número de WhatsApp não está conectado.',
      );
    }
    if (resposta.status >= 400 && resposta.status < 500) {
      if (resposta.status === 401 || resposta.status === 403) {
        this.logger.error(
          'O gateway de WhatsApp recusou o token interno: confira WHATSAPP_TOKEN_INTERNO na API e no gateway.',
        );
        throw new ServicoIndisponivelException(
          'O serviço de WhatsApp está mal configurado. Avise o administrador.',
        );
      }
      throw new DadosInvalidosException(
        mensagem ?? 'O serviço de WhatsApp recusou o pedido.',
      );
    }
    throw new ServicoIndisponivelException(
      mensagem ??
        'O serviço de WhatsApp falhou agora. Tente de novo em instantes.',
    );
  }
}

function lerJson(texto: string): unknown {
  if (!texto) {
    return undefined;
  }
  try {
    return JSON.parse(texto) as unknown;
  } catch {
    return undefined;
  }
}
