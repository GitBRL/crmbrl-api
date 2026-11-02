import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { AMBIENTE, type Ambiente } from '../../config/ambiente';
import type {
  Canal,
  Conversa,
  Mensagem,
  Prisma,
  TipoCanal,
} from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  type AdaptadorCanal,
  FalhaDefinitivaDeEnvio,
  type PermissaoDeResposta,
  type ResultadoEnvio,
} from '../adaptador-canal';
import { ArquivosPublicos } from '../comum/arquivos-publicos';
import { ConfiguracaoDeCanais } from '../comum/configuracao-de-canais.service';
import { SegredosDoCanal } from '../comum/segredos-do-canal';
import { RegistroCanais, ROTULO_DO_TIPO_DE_CANAL } from '../registro-canais';
import { type SegredosMeta, tipoDoAnexoParaEnvio } from './eventos-meta';
import { ErroDaGraph, GraphApi } from './graph-api';

/** Por que não dá para responder fora da janela de 24 h da Meta (R14). */
export const MOTIVO_JANELA_FECHADA =
  'Passaram mais de 24 horas desde a última mensagem do contato: a Meta só permite responder dentro desse prazo.';

/** Validade do link do anexo que a Meta baixa ao enviar. */
const VALIDADE_DO_LINK_DO_ANEXO_MS = 60 * 60 * 1000;

/**
 * Janela de 24 h da Meta (R14): a resposta comum só cabe até
 * `conversa.janelaAte` (última mensagem do contato + 24 h).
 */
export function permissaoNaJanela(
  conversa: Pick<Conversa, 'janelaAte'>,
  agora: Date = new Date(),
): PermissaoDeResposta {
  return conversa.janelaAte && conversa.janelaAte > agora
    ? { pode: true }
    : { pode: false, motivo: MOTIVO_JANELA_FECHADA };
}

/** Partes de um envio: a Meta não junta anexo e texto numa mensagem só. */
type ParteDoEnvio = 'anexo' | 'texto';

function objeto(valor: unknown): Record<string, unknown> {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor)
    ? (valor as Record<string, unknown>)
    : {};
}

/** As partes já enviadas numa tentativa anterior (`metadados.meta.partes`). */
function partesEnviadas(
  metadados: unknown,
): Partial<Record<ParteDoEnvio, string>> {
  const partes = objeto(objeto(metadados).meta).partes;
  const lidas: Partial<Record<ParteDoEnvio, string>> = {};
  for (const parte of ['anexo', 'texto'] as const) {
    const mid = objeto(partes)[parte];
    if (typeof mid === 'string' && mid !== '') {
      lidas[parte] = mid;
    }
  }
  return lidas;
}

/** Erro passageiro do envio pela Graph (o Atendimento tenta de novo). */
class FalhaPassageiraDaMeta extends Error {
  constructor(mensagem: string) {
    super(mensagem);
    this.name = 'FalhaPassageiraDaMeta';
  }
}

/**
 * Base dos canais da Meta (Instagram e Messenger, §2.5, R14): envio pela Graph
 * API (`POST /<versão>/me/messages`, token de página do canal no cabeçalho),
 * só dentro da janela de 24 h. Anexo: a Meta baixa o arquivo por um link
 * assinado da API (vale 1 h); com texto, vão duas mensagens (anexo e texto).
 * O id externo é o `message_id` (mid) devolvido.
 */
@Injectable()
abstract class AdaptadorMeta implements AdaptadorCanal, OnModuleInit {
  abstract readonly tipo: TipoCanal;
  private readonly logger = new Logger('Meta');

  constructor(
    private readonly registro: RegistroCanais,
    private readonly prisma: PrismaService,
    private readonly segredos: SegredosDoCanal,
    private readonly graph: GraphApi,
    private readonly arquivosPublicos: ArquivosPublicos,
    private readonly configuracao: ConfiguracaoDeCanais,
    @Inject(AMBIENTE) private readonly ambiente: Ambiente,
  ) {}

  onModuleInit(): void {
    this.registro.registrar(this);
  }

  podeResponder(conversa: Conversa, _canal: Canal): PermissaoDeResposta {
    return permissaoNaJanela(conversa);
  }

  async enviar(
    mensagem: Mensagem,
    conversa: Conversa,
    canal: Canal,
  ): Promise<ResultadoEnvio> {
    const janela = permissaoNaJanela(conversa);
    if (!janela.pode) {
      throw new FalhaDefinitivaDeEnvio(MOTIVO_JANELA_FECHADA, 'janela_fechada');
    }
    const { tokenPagina } = await this.segredos.ler<SegredosMeta>(canal);
    if (!tokenPagina) {
      throw new FalhaDefinitivaDeEnvio(
        `O token da página deste canal do ${ROTULO_DO_TIPO_DE_CANAL[canal.tipo]} não está configurado.`,
        'token_ausente',
      );
    }
    const destinatario = await this.destinatario(conversa, canal);
    const partes: Array<[ParteDoEnvio, Record<string, unknown>]> = [];
    if (mensagem.arquivoId) {
      const arquivo = await this.prisma.arquivo.findUnique({
        where: { id: mensagem.arquivoId },
      });
      if (!arquivo || arquivo.removidoEm) {
        throw new FalhaDefinitivaDeEnvio(
          'O anexo não existe mais.',
          'anexo_ausente',
        );
      }
      const { e, a } = this.arquivosPublicos.assinar(
        arquivo.id,
        `meta:${canal.id}`,
        VALIDADE_DO_LINK_DO_ANEXO_MS,
      );
      partes.push([
        'anexo',
        {
          attachment: {
            type: tipoDoAnexoParaEnvio(arquivo.mime),
            payload: {
              url: `${this.ambiente.urlPublica}/api/v1/publico/meta/arquivos/${arquivo.id}?c=${canal.id}&e=${e}&a=${a}`,
              is_reusable: false,
            },
          },
        },
      ]);
    }
    if (mensagem.texto?.trim()) {
      partes.push(['texto', { text: mensagem.texto.slice(0, 2000) }]);
    }
    if (partes.length === 0) {
      throw new FalhaDefinitivaDeEnvio(
        'A mensagem está vazia.',
        'mensagem_vazia',
      );
    }
    // Numa nova tentativa, a parte que já chegou ao contato não vai de novo.
    const enviadas = partesEnviadas(mensagem.metadados);
    let idExterno: string | undefined;
    for (const [parte, corpo] of partes) {
      if (enviadas[parte]) {
        idExterno = enviadas[parte];
        continue;
      }
      try {
        const resposta = await this.graph.enviarMensagem(
          tokenPagina,
          destinatario,
          corpo,
        );
        idExterno = resposta.message_id ?? idExterno;
        if (partes.length > 1 && resposta.message_id) {
          enviadas[parte] = resposta.message_id;
          await this.guardarPartes(mensagem, enviadas);
        }
      } catch (erro) {
        throw await this.traduzir(erro, canal);
      }
    }
    return { idExterno, enviadaEm: new Date() };
  }

  /** Guarda em `metadados.meta.partes` o mid de cada parte já enviada. */
  private async guardarPartes(
    mensagem: Pick<Mensagem, 'id' | 'metadados'>,
    partes: Partial<Record<ParteDoEnvio, string>>,
  ): Promise<void> {
    const metadados = objeto(mensagem.metadados);
    await this.prisma.mensagem.update({
      where: { id: mensagem.id },
      data: {
        metadados: {
          ...metadados,
          meta: { ...objeto(metadados.meta), partes },
        } as Prisma.InputJsonObject,
      },
    });
  }

  /** O PSID/IGSID do contato: o id da conversa, ou o identificador do contato no canal. */
  private async destinatario(
    conversa: Conversa,
    canal: Canal,
  ): Promise<string> {
    if (conversa.idExterno) {
      return conversa.idExterno;
    }
    const identificador = await this.prisma.contatoIdentificador.findFirst({
      where: {
        contatoId: conversa.contatoId,
        tipo: canal.tipo as 'INSTAGRAM' | 'MESSENGER',
      },
      orderBy: { ultimoUsoEm: 'desc' },
      select: { valor: true },
    });
    if (!identificador) {
      throw new FalhaDefinitivaDeEnvio(
        `O contato não tem conta no ${ROTULO_DO_TIPO_DE_CANAL[canal.tipo]} ligada a esta conversa.`,
        'destinatario_ausente',
      );
    }
    return identificador.valor;
  }

  private async traduzir(erro: unknown, canal: Canal): Promise<Error> {
    if (!(erro instanceof ErroDaGraph)) {
      return erro instanceof Error ? erro : new Error(String(erro));
    }
    if (erro.foraDaJanela) {
      return new FalhaDefinitivaDeEnvio(
        MOTIVO_JANELA_FECHADA,
        'janela_fechada',
      );
    }
    if (erro.tokenInvalido) {
      const mensagem = `O token da página do ${ROTULO_DO_TIPO_DE_CANAL[canal.tipo]} é inválido ou expirou: o Admin precisa gerar outro e salvar no canal.`;
      await this.configuracao.registrarErro(canal.id, mensagem);
      return new FalhaDefinitivaDeEnvio(mensagem, 'token_invalido');
    }
    if (erro.passageiro) {
      this.logger.warn(
        `Envio pela Graph falhou (vai tentar de novo): ${erro.message}`,
      );
      return new FalhaPassageiraDaMeta(erro.message);
    }
    return new FalhaDefinitivaDeEnvio(
      `A Meta recusou a mensagem: ${erro.message}`,
      `graph_${erro.codigo ?? erro.status}`,
    );
  }
}

@Injectable()
export class AdaptadorInstagram extends AdaptadorMeta {
  readonly tipo = 'INSTAGRAM' as const;
}

@Injectable()
export class AdaptadorMessenger extends AdaptadorMeta {
  readonly tipo = 'MESSENGER' as const;
}
