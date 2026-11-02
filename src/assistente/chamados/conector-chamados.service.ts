/**
 * Envio de um chamado ao destino configurado (R25):
 *
 * - **TicketHub**: conta de serviço. `POST {url}/api/auth/login` com
 *   `{email, senha}` devolve `{token}` (JWT, guardado em memória até um 401);
 *   `POST {url}/api/chamados` com `Authorization: Bearer` e
 *   `{titulo (3–200), descricao (6–10000), prioridade, sistema_id?}` devolve
 *   201 com o chamado (`id` é o número). Formato de
 *   `ticket-hub/server/src/routes/{auth,chamados}.routes.js`.
 * - **Webhook**: `POST` do corpo montado pelo modelo do Admin, com os
 *   cabeçalhos extras e, havendo segredo, `X-CRM-Timestamp` e
 *   `X-CRM-Assinatura: sha256=HMAC(segredo, timestamp + "." + corpo)` (o mesmo
 *   formato dos webhooks de saída, R9.3).
 *
 * URLs vindas da configuração do Admin passam pela checagem de rede interna
 * (R9.1); a `TICKETHUB_URL` do servidor é confiável. Nenhuma senha, token ou
 * segredo vai para mensagens de erro ou logs.
 */
import { Inject, Injectable } from '@nestjs/common';
import { CriptografiaService } from '../../comum/criptografia/criptografia.service';
import { AMBIENTE, type Ambiente } from '../../config/ambiente';
import {
  conteudoAssinado,
  formatarAssinatura,
  timestampDoEnvio,
} from '../../webhooks/saida/envelope';
import { enviarPost } from '../../webhooks/saida/envio-http';
import { verificarDestino } from '../../webhooks/saida/protecao-ssrf';
import {
  DESCRICAO_TICKETHUB,
  PRAZO_DO_DESTINO_MS,
  TITULO_TICKETHUB,
} from '../assistente.constantes';
import type { DestinoEfetivo } from '../configuracao-assistente';
import {
  type DadosDoCorpo,
  numeroELinkDaResposta,
  renderizarCorpo,
} from './modelo-corpo';

/** Falha do envio (mensagem segura para gravar e mostrar ao Admin). */
export class ErroDoDestino extends Error {}

export interface ChamadoParaEnvio {
  id: string;
  titulo: string;
  /** Descrição completa (o texto da pessoa, o contexto e a conversa). */
  descricao: string;
  /** Dados do corpo do webhook. */
  corpo: DadosDoCorpo;
}

export interface ChamadoCriado {
  numero: string | null;
  link: string | null;
}

const AGENTE = 'BRL-CRM-Assistente/1.0';

function cortar(texto: string, limite: number): string {
  return texto.length > limite ? `${texto.slice(0, limite - 1)}…` : texto;
}

async function lerJson(resposta: Response): Promise<unknown> {
  try {
    const texto = (await resposta.text()).slice(0, 64_000);
    return texto ? (JSON.parse(texto) as unknown) : null;
  } catch {
    return null;
  }
}

function mensagemDoTicketHub(corpo: unknown): string {
  const m =
    typeof corpo === 'object' && corpo !== null
      ? (corpo as Record<string, unknown>).message
      : null;
  return typeof m === 'string' ? `: ${m.slice(0, 300)}` : '';
}

function falhaDeRede(erro: unknown): ErroDoDestino {
  const nome = erro instanceof Error ? erro.name : '';
  return new ErroDoDestino(
    nome === 'TimeoutError' || nome === 'AbortError'
      ? `O destino não respondeu em ${PRAZO_DO_DESTINO_MS / 1000} s.`
      : 'Não foi possível conectar ao destino.',
  );
}

@Injectable()
export class ConectorChamadosService {
  /** Token do TicketHub por `url|email`. */
  private readonly tokens = new Map<string, string>();

  constructor(
    private readonly cripto: CriptografiaService,
    @Inject(AMBIENTE) private readonly ambiente: Ambiente,
  ) {}

  /** Confere o endereço de destino escolhido pelo Admin (R9.1). */
  private async conferirRede(url: string): Promise<void> {
    const verificado = await verificarDestino(url, {
      producao: this.ambiente.producao,
      permitirRedeInterna: this.ambiente.webhooksPermitirRedeInterna,
    });
    if (!verificado.permitido) {
      throw new ErroDoDestino(`Envio bloqueado: ${verificado.mensagem}`);
    }
  }

  async enviar(
    destino: DestinoEfetivo,
    chamado: ChamadoParaEnvio,
  ): Promise<ChamadoCriado> {
    return destino.tipo === 'TICKETHUB'
      ? this.enviarAoTicketHub(destino, chamado)
      : this.enviarAoWebhook(destino, chamado);
  }

  /** Só o login no TicketHub (botão "Testar" do Admin); nada é criado. */
  async testar(destino: DestinoEfetivo): Promise<string> {
    if (destino.tipo === 'TICKETHUB') {
      if (destino.urlDoAdmin) {
        await this.conferirRede(destino.url);
      }
      this.tokens.delete(`${destino.url}|${destino.email}`);
      await this.entrar(destino);
      return 'Login no TicketHub feito com a conta de serviço.';
    }
    await this.conferirRede(destino.url);
    return 'O endereço do webhook é aceito (nada foi enviado).';
  }

  // -------------------------------------------------------------------------
  // TicketHub
  // -------------------------------------------------------------------------

  private async entrar(
    d: Extract<DestinoEfetivo, { tipo: 'TICKETHUB' }>,
  ): Promise<string> {
    const chave = `${d.url}|${d.email}`;
    const guardado = this.tokens.get(chave);
    if (guardado) {
      return guardado;
    }
    let resposta: Response;
    try {
      resposta = await fetch(`${d.url}/api/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': AGENTE,
        },
        body: JSON.stringify({ email: d.email, senha: d.senha }),
        redirect: 'manual',
        signal: AbortSignal.timeout(PRAZO_DO_DESTINO_MS),
      });
    } catch (erro) {
      throw falhaDeRede(erro);
    }
    const corpo = await lerJson(resposta);
    if (!resposta.ok) {
      throw new ErroDoDestino(
        resposta.status === 401
          ? 'O TicketHub recusou o e-mail ou a senha da conta de serviço.'
          : `O login no TicketHub respondeu HTTP ${resposta.status}${mensagemDoTicketHub(corpo)}`,
      );
    }
    const token =
      typeof corpo === 'object' && corpo !== null
        ? (corpo as Record<string, unknown>).token
        : null;
    if (typeof token !== 'string' || !token) {
      throw new ErroDoDestino('O login no TicketHub não devolveu o token.');
    }
    this.tokens.set(chave, token);
    return token;
  }

  private async enviarAoTicketHub(
    d: Extract<DestinoEfetivo, { tipo: 'TICKETHUB' }>,
    chamado: ChamadoParaEnvio,
  ): Promise<ChamadoCriado> {
    if (d.urlDoAdmin) {
      await this.conferirRede(d.url);
    }
    let titulo = cortar(chamado.titulo.trim(), TITULO_TICKETHUB.max);
    if (titulo.length < TITULO_TICKETHUB.min) {
      titulo = 'Pedido pelo assistente do CRM';
    }
    let descricao = cortar(chamado.descricao.trim(), DESCRICAO_TICKETHUB.max);
    if (descricao.length < DESCRICAO_TICKETHUB.min) {
      descricao = `${descricao} (sem descrição)`;
    }
    const corpo = JSON.stringify({
      titulo,
      descricao,
      prioridade: d.prioridade,
      ...(d.sistemaId ? { sistema_id: d.sistemaId } : {}),
    });
    for (let tentativa = 1; tentativa <= 2; tentativa++) {
      const token = await this.entrar(d);
      let resposta: Response;
      try {
        resposta = await fetch(`${d.url}/api/chamados`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            'User-Agent': AGENTE,
          },
          body: corpo,
          redirect: 'manual',
          signal: AbortSignal.timeout(PRAZO_DO_DESTINO_MS),
        });
      } catch (erro) {
        throw falhaDeRede(erro);
      }
      const json = await lerJson(resposta);
      if (resposta.status === 401 && tentativa === 1) {
        // Token vencido ou revogado: entra de novo uma vez.
        this.tokens.delete(`${d.url}|${d.email}`);
        continue;
      }
      if (!resposta.ok) {
        throw new ErroDoDestino(
          `O TicketHub respondeu HTTP ${resposta.status} ao criar o chamado${mensagemDoTicketHub(json)}`,
        );
      }
      const { numero } = numeroELinkDaResposta(json);
      return { numero, link: `${d.urlPublica}/chamados` };
    }
    throw new ErroDoDestino(
      'O TicketHub recusou a sessão da conta de serviço.',
    );
  }

  // -------------------------------------------------------------------------
  // Webhook genérico
  // -------------------------------------------------------------------------

  private async enviarAoWebhook(
    d: Extract<DestinoEfetivo, { tipo: 'WEBHOOK' }>,
    chamado: ChamadoParaEnvio,
  ): Promise<ChamadoCriado> {
    await this.conferirRede(d.url);
    const corpo = renderizarCorpo(d.modeloCorpo, chamado.corpo);
    const cabecalhos: Record<string, string> = {
      ...d.cabecalhos,
      'Content-Type': 'application/json; charset=utf-8',
      'User-Agent': AGENTE,
      'X-CRM-Evento': 'assistente.chamado',
      'X-CRM-Entrega': chamado.id,
    };
    if (d.segredo) {
      const timestamp = timestampDoEnvio(new Date());
      cabecalhos['X-CRM-Timestamp'] = timestamp;
      cabecalhos['X-CRM-Assinatura'] = formatarAssinatura(
        this.cripto.assinarHmac(d.segredo, conteudoAssinado(timestamp, corpo)),
      );
    }
    const resultado = await enviarPost({
      url: d.url,
      corpo,
      cabecalhos,
      prazoMs: PRAZO_DO_DESTINO_MS,
      bytesDoTrecho: 16_000,
    });
    if (!resultado.sucesso) {
      throw new ErroDoDestino(
        resultado.erro ?? `O webhook respondeu HTTP ${resultado.statusHttp}.`,
      );
    }
    let json: unknown = null;
    try {
      json = resultado.trechoResposta
        ? (JSON.parse(resultado.trechoResposta) as unknown)
        : null;
    } catch {
      json = null;
    }
    return numeroELinkDaResposta(json);
  }
}
