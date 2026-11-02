import { AtendimentoService } from '../src/atendimento/atendimento.service';
import type { EntradaDeAtendimento } from '../src/atendimento/entrada';
import {
  type AdaptadorCanal,
  FalhaDefinitivaDeEnvio,
  type PermissaoDeResposta,
  type ResultadoEnvio,
} from '../src/canais/adaptador-canal';
import { RegistroCanais } from '../src/canais/registro-canais';
import { executarComoAtor } from '../src/comum/contexto/contexto-requisicao';
import type {
  Canal,
  Conversa,
  FilaAtendimento,
  Mensagem,
  TipoCanal,
  Usuario,
} from '../src/generated/prisma/client';
import { FILA_ENVIO_ATENDIMENTO } from '../src/atendimento/atendimento.constantes';
import {
  type AppTeste,
  criarCanal,
  criarEquipe,
  criarFila,
  criarUsuario,
  type DadosDeCanal,
  type DadosDeFila,
  drenarFilas,
  type Equipe,
} from './utils';

export type ModoDoAdaptador =
  'sincrono' | 'enfileirado' | 'definitiva' | 'passageira';

/**
 * Adaptador de canal falso para os testes do Atendimento: registra o que
 * recebeu e responde conforme o `modo` (envio síncrono, enfileirado, falha
 * definitiva ou passageira). `podeResponder` opcional (ex.: janela fechada).
 */
export class AdaptadorFalso implements AdaptadorCanal {
  readonly enviados: Array<{
    mensagem: Mensagem;
    conversa: Conversa;
    canal: Canal;
  }> = [];
  modo: ModoDoAdaptador = 'sincrono';
  bloqueio: PermissaoDeResposta | null = null;
  private sequencia = 0;

  constructor(readonly tipo: TipoCanal) {}

  enviar(
    mensagem: Mensagem,
    conversa: Conversa,
    canal: Canal,
  ): Promise<ResultadoEnvio> {
    this.enviados.push({ mensagem, conversa, canal });
    switch (this.modo) {
      case 'definitiva':
        return Promise.reject(
          new FalhaDefinitivaDeEnvio(
            'O destinatário não existe.',
            'sem_destino',
          ),
        );
      case 'passageira':
        return Promise.reject(new Error('provedor fora do ar'));
      case 'enfileirado':
        return Promise.resolve({
          idExterno: mensagem.idExterno ?? `FALSO-${++this.sequencia}`,
          enfileirado: true,
        });
      default:
        return Promise.resolve({ idExterno: `FALSO-${++this.sequencia}` });
    }
  }

  podeResponder(): PermissaoDeResposta {
    return this.bloqueio ?? { pode: true };
  }

  /** Os textos enviados, na ordem. */
  textos(): Array<string | null> {
    return this.enviados.map((item) => item.mensagem.texto);
  }
}

/** Troca o adaptador do tipo pelo falso; devolve o falso e a função que desfaz. */
export function usarAdaptadorFalso(
  t: AppTeste,
  tipo: TipoCanal = 'WEBCHAT',
): { adaptador: AdaptadorFalso; desfazer: () => void } {
  const adaptador = new AdaptadorFalso(tipo);
  const desfazer = t.get(RegistroCanais).substituir(adaptador);
  return { adaptador, desfazer };
}

/** Roda os jobs de envio do Atendimento (com `incluirAgendados`, as retentativas também). */
export function drenarEnvios(
  t: AppTeste,
  opcoes: { incluirAgendados?: boolean } = {},
): Promise<number> {
  return drenarFilas(t, FILA_ENVIO_ATENDIMENTO, opcoes);
}

export interface CenarioDoAtendimento {
  admin: Usuario;
  comercial: Equipe;
  cs: Equipe;
  marketing: Usuario;
  fila: FilaAtendimento;
  filaCs: FilaAtendimento;
  canal: Canal;
}

/**
 * Admin; C-level → líder comercial → 2 comerciais; o mesmo C-level → líder de
 * CS → 1 CS; 1 marketing; uma fila comercial (padrão do canal) e uma de CS;
 * um canal (`WEBCHAT` por padrão).
 */
export async function montarCenario(
  t: AppTeste,
  opcoes: { fila?: DadosDeFila; canal?: DadosDeCanal; membros?: number } = {},
): Promise<CenarioDoAtendimento> {
  const admin = await criarUsuario(t, { papel: 'ADMIN', nome: 'Admin' });
  const comercial = await criarEquipe(t, 'COMERCIAL', {
    membros: opcoes.membros ?? 2,
  });
  const cs = await criarEquipe(t, 'CS', {
    membros: 1,
    cLevel: comercial.cLevel,
  });
  const marketing = await criarUsuario(t, {
    papel: 'MARKETING',
    lider: await criarUsuario(t, {
      papel: 'LIDER_MARKETING',
      lider: comercial.cLevel,
    }),
  });
  const fila = await criarFila(t, {
    nome: 'Comercial',
    area: 'COMERCIAL',
    ...opcoes.fila,
  });
  const filaCs = await criarFila(t, { nome: 'Customer Success', area: 'CS' });
  const canal = await criarCanal(t, {
    tipo: 'WEBCHAT',
    nome: 'Chat do site',
    filaPadrao: fila,
    ...opcoes.canal,
  });
  return { admin, comercial, cs, marketing, fila, filaCs, canal };
}

let sequenciaDeEntrada = 0;

/** Uma mensagem do contato chegando pelo canal (como o módulo do canal faria). */
export function receberDoContato(
  t: AppTeste,
  canal: Canal,
  opcoes: {
    de?: string;
    texto?: string;
    nome?: string;
    email?: string;
    tipoRemetente?: EntradaDeAtendimento['remetente']['tipo'];
    recebidaEm?: Date;
    idExterno?: string;
  } = {},
) {
  sequenciaDeEntrada += 1;
  const tipo =
    opcoes.tipoRemetente ??
    (canal.tipo === 'WHATSAPP'
      ? 'WHATSAPP'
      : canal.tipo === 'EMAIL'
        ? 'EMAIL'
        : canal.tipo);
  return executarComoAtor(
    { tipoAtor: 'SISTEMA', descricao: 'Canal de teste' },
    () =>
      t.get(AtendimentoService).receber({
        canalId: canal.id,
        remetente: {
          tipo,
          valor: opcoes.de ?? 'visitante-1',
          nome: opcoes.nome ?? 'Maria Souza',
          ...(opcoes.email ? { email: opcoes.email } : {}),
        },
        mensagem: {
          idExterno: opcoes.idExterno ?? `ENTRADA-${sequenciaDeEntrada}`,
          tipo: 'TEXTO',
          texto: opcoes.texto ?? 'Olá, quero saber mais.',
          recebidaEm: opcoes.recebidaEm ?? new Date(),
        },
      }),
  );
}
