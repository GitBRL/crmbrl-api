/**
 * Apoio dos testes de Disparos: gateway de WhatsApp falso (só o `verificar`),
 * relógio do ritmo e confirmações de entrega simuladas.
 */
import { AtendimentoService } from '../src/atendimento/atendimento.service';
import type { StatusDeEntrega } from '../src/atendimento/entrada';
import { ClienteGatewayWhatsapp } from '../src/canais/whatsapp/cliente-gateway';
import type { ResultadoDaVerificacao } from '../src/canais/whatsapp/contrato-gateway';
import { AgendadorDeEnvio } from '../src/disparos/agendador-de-envio.service';
import { FILA_DISPAROS_ENVIAR } from '../src/disparos/disparos.constantes';
import { EnvioDeCampanha } from '../src/disparos/envio-de-campanha.service';
import {
  type AppTeste,
  criarAppTeste,
  criarCanalWhatsapp,
  criarContato,
  drenarFilas,
  drenarTudo,
  type OpcoesAppTeste,
} from './utils';

/** O `ClienteGatewayWhatsapp` dos testes: diz que todo número tem WhatsApp, salvo os marcados. */
export class GatewayFalso {
  readonly semWhatsapp = new Set<string>();
  fora = false;
  readonly verificados: string[] = [];

  verificar(
    numeroId: string,
    telefone: string,
  ): Promise<ResultadoDaVerificacao> {
    void numeroId;
    this.verificados.push(telefone);
    if (this.fora) {
      return Promise.reject(new Error('gateway fora do ar'));
    }
    const existe = !this.semWhatsapp.has(telefone);
    return Promise.resolve({
      telefone,
      existe,
      jid: existe ? `${telefone}@s.whatsapp.net` : null,
      doCache: false,
    });
  }
}

export async function criarAppDeDisparos(
  gateway: GatewayFalso,
  opcoes: OpcoesAppTeste = {},
): Promise<AppTeste> {
  return criarAppTeste({
    ...opcoes,
    ajustar: (construtor) =>
      (opcoes.ajustar ? opcoes.ajustar(construtor) : construtor)
        .overrideProvider(ClienteGatewayWhatsapp)
        .useValue(gateway),
  });
}

/** Um número CONECTADO e `n` contatos com telefone. */
export async function cenarioWhatsapp(
  t: AppTeste,
  contatos = 3,
  numero: { limiteDiario?: number } = {},
) {
  const { canal, numero: whatsapp } = await criarCanalWhatsapp(t, {
    status: 'CONECTADO',
    telefone: '5511900000000',
    ...numero,
  });
  const lista = [];
  for (let i = 0; i < contatos; i++) {
    lista.push(
      await criarContato(t, {
        nome: `Pessoa ${i + 1} Teste`,
        telefone: `1198800${String(1000 + i)}`,
        email: null,
      }),
    );
  }
  return { canal, whatsapp, contatos: lista };
}

/** Passa o relógio do ritmo: libera o próximo envio da campanha agora e roda a fila. */
export async function proximaRodada(
  t: AppTeste,
  campanhaId: string,
): Promise<void> {
  const passado = new Date(Date.now() - 1000);
  await t.prisma.campanha.update({
    where: { id: campanhaId },
    data: { proximoEnvioEm: passado },
  });
  await t.get(AgendadorDeEnvio).agendar(campanhaId, passado);
  await drenarFilas(t, FILA_DISPAROS_ENVIAR);
  await drenarTudo(t);
}

/** Roda as rodadas necessárias até todos os pendentes saírem (no máximo `limite`). */
export async function enviarTudo(
  t: AppTeste,
  campanhaId: string,
  limite = 50,
): Promise<void> {
  for (let i = 0; i < limite; i++) {
    await proximaRodada(t, campanhaId);
    const campanha = await t.prisma.campanha.findUniqueOrThrow({
      where: { id: campanhaId },
    });
    const pendentes = await t.prisma.campanhaDestinatario.count({
      where: { campanhaId, status: 'PENDENTE' },
    });
    if (campanha.status !== 'EM_ANDAMENTO' || pendentes === 0) {
      return;
    }
  }
}

/** O gateway informa o status das mensagens da campanha que ainda estão PENDENTE. */
export async function confirmarEntrega(
  t: AppTeste,
  campanhaId: string,
  status: StatusDeEntrega = 'ENVIADA',
  erro?: string,
): Promise<number> {
  const mensagens = await t.prisma.mensagem.findMany({
    where: {
      direcao: 'SAIDA',
      status:
        status === 'FALHOU'
          ? { in: ['PENDENTE', 'ENVIADA'] }
          : { not: 'FALHOU' },
      destinatarioCampanha: { campanhaId },
    },
    orderBy: { ocorridaEm: 'asc' },
  });
  for (const m of mensagens) {
    if (m.idExterno) {
      await t
        .get(AtendimentoService)
        .atualizarStatus(m.canalId, m.idExterno, status, erro);
    }
  }
  return mensagens.length;
}

/** A varredura de cada minuto (sincroniza status, retoma paradas, ativa agendadas). */
export function varrer(t: AppTeste) {
  return t.get(EnvioDeCampanha).varrer();
}
