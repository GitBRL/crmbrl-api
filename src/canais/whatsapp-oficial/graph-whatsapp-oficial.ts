import { Injectable } from '@nestjs/common';
import { GraphApi } from '../meta/graph-api';
import { LIMITE_DE_DOWNLOAD_BYTES } from './formato-meta';

/** Dados do número na Meta (`GET /{phone_number_id}?fields=…`). */
export interface DadosDoNumero {
  display_phone_number?: string;
  verified_name?: string;
  quality_rating?: string;
}

/** Um template como a Meta devolve (`GET /{waba_id}/message_templates`). */
export interface TemplateDaMeta {
  id?: string;
  name?: string;
  language?: string;
  category?: string;
  status?: string;
  components?: unknown[];
}

/** Páginas de templates lidas no máximo (200 por página). */
const MAXIMO_DE_PAGINAS = 10;

/**
 * Cliente da Cloud API do WhatsApp (R28) sobre o `GraphApi` da Meta: a base é
 * `META_GRAPH_URL` + `META_GRAPH_VERSAO` (a falsa nos testes e no ambiente dos
 * agentes), o token vai no `Authorization`. Rotas usadas:
 *
 * - `POST /{phone_number_id}/messages` e `POST /{phone_number_id}/media`;
 * - `GET /{media_id}` (devolve a `url`) + `GET <url>` com Bearer;
 * - `GET /{phone_number_id}?fields=display_phone_number,verified_name,quality_rating`;
 * - `GET /{waba_id}/message_templates`.
 */
@Injectable()
export class GraphWhatsappOficial {
  constructor(private readonly graph: GraphApi) {}

  /** Envia uma mensagem; devolve o wamid. */
  async enviar(
    token: string,
    phoneNumberId: string,
    corpo: Record<string, unknown>,
  ): Promise<string> {
    const resposta = await this.graph.postar<{
      messages?: Array<{ id?: string }>;
    }>(token, `${encodeURIComponent(phoneNumberId)}/messages`, corpo);
    const id = resposta.messages?.[0]?.id;
    if (!id) {
      throw new Error(
        'A Meta aceitou o envio mas não devolveu o id da mensagem.',
      );
    }
    return id;
  }

  /** Sobe uma mídia para o número; devolve o id dela (vale 30 dias). */
  async subirMidia(
    token: string,
    phoneNumberId: string,
    midia: { conteudo: Buffer; mime: string; nome: string },
  ): Promise<string> {
    const formulario = new FormData();
    formulario.append('messaging_product', 'whatsapp');
    formulario.append('type', midia.mime);
    formulario.append(
      'file',
      new Blob([new Uint8Array(midia.conteudo)], { type: midia.mime }),
      midia.nome,
    );
    const resposta = await this.graph.postarArquivo<{ id?: string }>(
      token,
      `${encodeURIComponent(phoneNumberId)}/media`,
      formulario,
    );
    if (!resposta.id) {
      throw new Error('A Meta aceitou a mídia mas não devolveu o id dela.');
    }
    return resposta.id;
  }

  /**
   * Baixa a mídia de uma mensagem recebida: `GET /{media_id}` devolve a URL
   * (vale 5 minutos) e o arquivo vem de `GET <url>` com o token (§6.3).
   */
  async baixarMidia(
    token: string,
    mediaId: string,
  ): Promise<{ conteudo: Buffer; mime: string | null }> {
    const dados = await this.graph.consultar<{
      url?: string;
      mime_type?: string;
    }>(token, encodeURIComponent(mediaId));
    if (!dados.url) {
      throw new Error('A Meta não devolveu o endereço da mídia.');
    }
    const baixada = await this.graph.baixar(
      dados.url,
      LIMITE_DE_DOWNLOAD_BYTES,
      token,
    );
    return {
      conteudo: baixada.conteudo,
      mime: baixada.mime ?? dados.mime_type ?? null,
    };
  }

  /** Número exibido, nome verificado e qualidade (teste de conexão). */
  dadosDoNumero(token: string, phoneNumberId: string): Promise<DadosDoNumero> {
    return this.graph.obter<DadosDoNumero>(token, phoneNumberId, [
      'display_phone_number',
      'verified_name',
      'quality_rating',
    ]);
  }

  /** Todos os templates da WABA (segue a paginação por cursor). */
  async listarTemplates(
    token: string,
    wabaId: string,
  ): Promise<TemplateDaMeta[]> {
    const templates: TemplateDaMeta[] = [];
    let depois: string | null = null;
    for (let pagina = 0; pagina < MAXIMO_DE_PAGINAS; pagina++) {
      const resposta: {
        data?: TemplateDaMeta[];
        paging?: { cursors?: { after?: string }; next?: string };
      } = await this.graph.consultar(
        token,
        `${encodeURIComponent(wabaId)}/message_templates?fields=id,name,language,category,status,components&limit=200${
          depois ? `&after=${encodeURIComponent(depois)}` : ''
        }`,
      );
      templates.push(...(resposta.data ?? []));
      depois = resposta.paging?.next
        ? (resposta.paging.cursors?.after ?? null)
        : null;
      if (!depois) {
        break;
      }
    }
    return templates;
  }
}
