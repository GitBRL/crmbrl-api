import { Injectable } from '@nestjs/common';
import { GraphApi } from '../canais/meta/graph-api';
import {
  type AcaoDeChamada,
  corpoDeAcao,
  corpoDeConfiguracao,
  corpoDeConnect,
  idDaChamadaCriada,
  type PermissaoNaMeta,
  permissaoDaMeta,
} from './formato-chamadas';

/** Quem é o cliente na Graph: telefone (E.164 só com dígitos) ou BSUID. */
export interface ClienteNaGraph {
  telefone: string | null;
  bsuid: string | null;
}

/**
 * Calling API do WhatsApp sobre o `GraphApi` (R29): a base é `META_GRAPH_URL` +
 * `META_GRAPH_VERSAO` (a Graph/Calling API falsa nos testes e no ambiente dos
 * agentes). Rotas usadas:
 *
 * - `POST /{phone_number_id}/calls` (ações `connect`, `pre_accept`, `accept`,
 *   `reject`, `terminate`);
 * - `POST /{phone_number_id}/settings` (liga e desliga as chamadas);
 * - `GET /{phone_number_id}/call_permissions?user_wa_id=…` (ou `recipient=<BSUID>`).
 *
 * O pedido de permissão (mensagem interativa ou template) sai por
 * `GraphWhatsappOficial.enviar` (`POST /{phone_number_id}/messages`). Os erros
 * chegam como `ErroDaGraph` (com o `codigo` da Meta).
 */
@Injectable()
export class GraphLigacoes {
  constructor(private readonly graph: GraphApi) {}

  /** `POST /{phone_number_id}/calls` com uma ação sobre uma ligação existente. */
  async agir(
    token: string,
    phoneNumberId: string,
    acao: AcaoDeChamada,
    idMeta: string,
    sdp?: string,
  ): Promise<void> {
    await this.graph.postar(
      token,
      `${encodeURIComponent(phoneNumberId)}/calls`,
      corpoDeAcao(acao, idMeta, sdp),
    );
  }

  /** `connect`: inicia a ligação feita com a oferta SDP do navegador; devolve o `wacid`. */
  async conectar(
    token: string,
    phoneNumberId: string,
    cliente: ClienteNaGraph,
    sdp: string,
    dadosOpacos: string,
  ): Promise<string> {
    const resposta = await this.graph.postar(
      token,
      `${encodeURIComponent(phoneNumberId)}/calls`,
      corpoDeConnect(cliente, sdp, dadosOpacos),
    );
    const id = idDaChamadaCriada(resposta);
    if (!id) {
      throw new Error('A Meta aceitou a ligação mas não devolveu o id dela.');
    }
    return id;
  }

  /** `POST /{phone_number_id}/settings`: liga ou desliga as chamadas no número. */
  async configurar(
    token: string,
    phoneNumberId: string,
    ativa: boolean,
  ): Promise<void> {
    await this.graph.postar(
      token,
      `${encodeURIComponent(phoneNumberId)}/settings`,
      corpoDeConfiguracao(ativa),
    );
  }

  /** `GET /{phone_number_id}/call_permissions`: a permissão do cliente e os limites, agora. */
  async permissoes(
    token: string,
    phoneNumberId: string,
    cliente: ClienteNaGraph,
  ): Promise<PermissaoNaMeta> {
    const consulta = cliente.telefone
      ? `user_wa_id=${encodeURIComponent(cliente.telefone)}`
      : `recipient=${encodeURIComponent(cliente.bsuid ?? '')}`;
    const resposta = await this.graph.consultar(
      token,
      `${encodeURIComponent(phoneNumberId)}/call_permissions?${consulta}`,
    );
    return permissaoDaMeta(resposta);
  }
}
