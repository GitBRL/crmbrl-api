import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { EmailService, type MensagemEmail } from '../../email/email.service';
import { FilaService } from '../../fila/fila.service';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  type Alerta,
  decidirEnvios,
  INTERVALO_DE_LEMBRETE_HORAS,
  type RegistroDeEnvios,
} from './avaliacao';
import { SaudeDoSistemaService } from './saude-do-sistema.service';

/** Fila (agendada) que confere a saúde e manda os alertas. */
export const FILA_MONITORAMENTO_DE_SAUDE = 'saude.monitorar';
/** Onde fica o registro do que já foi avisado (`configuracoes.valor`). */
export const CHAVE_DOS_ALERTAS_ENVIADOS = 'saude.alertas.enviados';

export interface ResultadoDoMonitoramento {
  ativos: number;
  enviados: number;
  destinatarios: number;
}

/**
 * Alertas por e-mail ao Admin (R27): número que desconecta, fila que trava,
 * gateway fora do ar, backup que falha ou atrasa. A cada 5 minutos confere o
 * painel; alerta novo sai na hora, o que continua só volta a cada
 * `INTERVALO_DE_LEMBRETE_HORAS` horas e, resolvido, é esquecido (se voltar,
 * avisa de novo). Sem SMTP, nada é enviado nem registrado.
 */
@Injectable()
export class AlertasDeSaudeService implements OnModuleInit {
  private readonly logger = new Logger(AlertasDeSaudeService.name);

  constructor(
    private readonly saude: SaudeDoSistemaService,
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly fila: FilaService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.fila.trabalhar(
      FILA_MONITORAMENTO_DE_SAUDE,
      () => this.monitorar().then(() => undefined),
      { tentativas: 0 },
    );
    await this.fila.agendar(FILA_MONITORAMENTO_DE_SAUDE, '*/5 * * * *');
  }

  async monitorar(agora: Date = new Date()): Promise<ResultadoDoMonitoramento> {
    const { alertas } = await this.saude.consultar(
      this.email.configurado,
      agora,
    );
    const registro = await this.lerRegistro();
    const decisao = decidirEnvios(alertas, registro, agora);
    if (!this.email.configurado) {
      // Sem SMTP não há como avisar: mantém o registro como está.
      return { ativos: alertas.length, enviados: 0, destinatarios: 0 };
    }
    let enviados = 0;
    let destinatarios = 0;
    const registroFinal = { ...decisao.registro };
    if (decisao.enviar.length > 0) {
      const admins = await this.prisma.usuario.findMany({
        where: { papel: 'ADMIN', ativo: true, desligadoEm: null },
        select: { email: true },
      });
      destinatarios = admins.length;
      const entregue =
        destinatarios > 0 &&
        (await this.enviar(
          admins.map((a) => a.email),
          decisao.enviar,
        ));
      if (entregue) {
        enviados = decisao.enviar.length;
      } else {
        // Não saiu: tenta de novo na próxima rodada.
        for (const alerta of decisao.enviar) {
          if (registro[alerta.chave] === undefined) {
            delete registroFinal[alerta.chave];
          } else {
            registroFinal[alerta.chave] = registro[alerta.chave];
          }
        }
      }
    }
    await this.gravarRegistro(registroFinal);
    return { ativos: alertas.length, enviados, destinatarios };
  }

  private async enviar(
    para: string[],
    alertas: readonly Alerta[],
  ): Promise<boolean> {
    try {
      const resultado = await this.email.enviar(montarEmail(para, alertas));
      return resultado.enviado;
    } catch (erro) {
      this.logger.warn(
        `Falha ao enviar o alerta de saúde: ${erro instanceof Error ? erro.message : String(erro)}`,
      );
      return false;
    }
  }

  private async lerRegistro(): Promise<RegistroDeEnvios> {
    const linha = await this.prisma.configuracao.findUnique({
      where: { chave: CHAVE_DOS_ALERTAS_ENVIADOS },
    });
    const valor = linha?.valor;
    if (typeof valor !== 'object' || valor === null || Array.isArray(valor)) {
      return {};
    }
    const registro: RegistroDeEnvios = {};
    for (const [chave, data] of Object.entries(valor)) {
      if (typeof data === 'string') {
        registro[chave] = data;
      }
    }
    return registro;
  }

  private async gravarRegistro(registro: RegistroDeEnvios): Promise<void> {
    const valor = registro as Prisma.InputJsonObject;
    await this.prisma.configuracao.upsert({
      where: { chave: CHAVE_DOS_ALERTAS_ENVIADOS },
      create: { chave: CHAVE_DOS_ALERTAS_ENVIADOS, valor },
      update: { valor },
    });
  }
}

function escaparHtml(texto: string): string {
  return texto
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** O e-mail com todos os alertas novos da rodada. */
export function montarEmail(
  para: string[],
  alertas: readonly Alerta[],
): MensagemEmail {
  const assunto =
    alertas.length === 1
      ? `[BRL CRM] ${alertas[0]?.titulo ?? 'Alerta de saúde'}`
      : `[BRL CRM] ${alertas.length} alertas de saúde do sistema`;
  const texto = [
    'O painel "Saúde do sistema" do BRL CRM encontrou:',
    '',
    ...alertas.flatMap((a) => [
      `* ${a.titulo}`,
      `  ${a.detalhe}`,
      `  O que fazer: ${a.dica}`,
      '',
    ]),
    `Se o problema continuar, você recebe um lembrete a cada ${INTERVALO_DE_LEMBRETE_HORAS} horas.`,
    'Veja o painel em Administração > Saúde do sistema.',
  ].join('\n');
  const html = `<!doctype html>
<html lang="pt-BR"><body style="font-family: Helvetica, Arial, sans-serif; color: #111; line-height: 1.5;">
<h2>Alerta de saúde do sistema</h2>
${alertas
  .map(
    (a) =>
      `<p><strong>${escaparHtml(a.titulo)}</strong><br>${escaparHtml(a.detalhe)}<br><em>O que fazer:</em> ${escaparHtml(a.dica)}</p>`,
  )
  .join('\n')}
<p style="color: #555; font-size: 13px;">Se o problema continuar, você recebe um lembrete a cada ${INTERVALO_DE_LEMBRETE_HORAS} horas. Veja o painel em Administração &gt; Saúde do sistema.</p>
</body></html>`;
  return { para, assunto, texto, html };
}
