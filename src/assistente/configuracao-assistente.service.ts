/**
 * Configuração do assistente pelo Admin (R25): leitura, gravação auditada
 * (segredos cifrados, só os nomes do que mudou na auditoria) e o destino
 * efetivo dos chamados — a configuração do Admin primeiro e, campo a campo,
 * as variáveis `TICKETHUB_*` do servidor.
 */
import { Inject, Injectable } from '@nestjs/common';
import { AuditoriaService } from '../auditoria/auditoria.service';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import { CriptografiaService } from '../comum/criptografia/criptografia.service';
import { DadosInvalidosException } from '../comum/erros/excecoes';
import { AMBIENTE, type Ambiente } from '../config/ambiente';
import { PrismaService } from '../prisma/prisma.service';
import {
  juntarCabecalhos,
  validarCabecalhos,
} from '../webhooks/saida/cabecalhos-extras';
import {
  CHAVE_CONFIGURACAO_ASSISTENTE,
  REGRA_ASSISTENTE,
} from './assistente.constantes';
import {
  MODELO_CORPO_PADRAO,
  validarModeloCorpo,
} from './chamados/modelo-corpo';
import {
  type ConfiguracaoGravada,
  lerConfiguracaoAssistente,
  type ResultadoDoDestino,
} from './configuracao-assistente';
import type { ConfigurarAssistenteDto } from './dto/assistente.dto';

type Origem = 'admin' | 'ambiente' | null;

export interface VisaoDaConfiguracao {
  perguntasPorDia: number;
  orcamentoMensalTokens: number | null;
  destino: ConfiguracaoGravada['destino'];
  ticketHub: {
    url: string | null;
    urlPublica: string | null;
    email: string | null;
    senhaDefinida: boolean;
    prioridade: string;
    sistemaId: string | null;
    origem: { url: Origem; email: Origem; senha: Origem };
  };
  webhook: {
    url: string | null;
    cabecalhos: { nome: string; valorMascarado: string }[];
    segredoDefinido: boolean;
    segredoMascarado: string | null;
    modeloCorpo: string | null;
    modeloCorpoPadrao: string;
  };
  destinoPronto: boolean;
  motivoDestino: string | null;
}

function urlHttp(texto: string, campo: string): string {
  if (!URL.canParse(texto)) {
    throw new DadosInvalidosException('Dados inválidos.', {
      campos: [{ campo, mensagens: ['deve ser um endereço http(s) válido'] }],
    });
  }
  const url = new URL(texto);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) {
    throw new DadosInvalidosException('Dados inválidos.', {
      campos: [
        {
          campo,
          mensagens: [
            'use um endereço http:// ou https:// sem usuário e senha na URL',
          ],
        },
      ],
    });
  }
  return campo.startsWith('ticketHub')
    ? `${url.origin}${url.pathname.replace(/\/+$/, '')}`
    : url.toString();
}

@Injectable()
export class ConfiguracaoAssistenteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditoria: AuditoriaService,
    private readonly cripto: CriptografiaService,
    @Inject(AMBIENTE) private readonly ambiente: Ambiente,
  ) {}

  async ler(): Promise<ConfiguracaoGravada> {
    const linha = await this.prisma.configuracao.findUnique({
      where: { chave: CHAVE_CONFIGURACAO_ASSISTENTE },
    });
    return lerConfiguracaoAssistente(linha?.valor);
  }

  private decifrar(cifrado: string | null): string | null {
    if (!cifrado) {
      return null;
    }
    try {
      return this.cripto.decifrar(cifrado);
    } catch {
      return null;
    }
  }

  private cabecalhosDe(c: ConfiguracaoGravada): Record<string, string> {
    const texto = this.decifrar(c.webhook.cabecalhosCifrados);
    if (!texto) {
      return {};
    }
    try {
      return JSON.parse(texto) as Record<string, string>;
    } catch {
      return {};
    }
  }

  /** O destino dos chamados pronto para uso, ou por que não está. */
  destinoDe(c: ConfiguracaoGravada): ResultadoDoDestino {
    if (c.destino === 'NENHUM') {
      return {
        pronto: false,
        motivo: 'O Admin desligou a abertura de chamados.',
      };
    }
    if (c.destino === 'WEBHOOK') {
      if (!c.webhook.url) {
        return {
          pronto: false,
          motivo: 'Falta a URL do webhook de chamados na configuração.',
        };
      }
      if (
        c.webhook.segredoCifrado &&
        !this.decifrar(c.webhook.segredoCifrado)
      ) {
        return {
          pronto: false,
          motivo:
            'O segredo do webhook não pode ser lido (a CHAVE_CRIPTOGRAFIA mudou?): grave-o de novo.',
        };
      }
      return {
        pronto: true,
        destino: {
          tipo: 'WEBHOOK',
          url: c.webhook.url,
          cabecalhos: this.cabecalhosDe(c),
          segredo: this.decifrar(c.webhook.segredoCifrado),
          modeloCorpo: c.webhook.modeloCorpo,
        },
      };
    }
    const amb = this.ambiente.ticketHub;
    const url = c.ticketHub.url ?? amb.url;
    // A conta de serviço do servidor (.env) só vai para a URL do servidor: com
    // outra URL informada pelo Admin, e-mail e senha têm de estar gravados na configuração.
    const urlDoAmbiente =
      c.ticketHub.url === null || c.ticketHub.url === amb.url;
    const email = c.ticketHub.email ?? (urlDoAmbiente ? amb.email : null);
    const senha = c.ticketHub.senhaCifrada
      ? this.decifrar(c.ticketHub.senhaCifrada)
      : urlDoAmbiente
        ? amb.senha()
        : null;
    if (!urlDoAmbiente && (!c.ticketHub.email || !senha)) {
      return {
        pronto: false,
        motivo:
          'Com uma URL do TicketHub diferente da do servidor, informe também o e-mail e a senha da conta de serviço dessa URL: as credenciais do servidor não são enviadas para outro endereço.',
      };
    }
    if (!url || !email || !senha) {
      return {
        pronto: false,
        motivo:
          'O TicketHub não está configurado: informe URL, e-mail e senha da conta de serviço (ou TICKETHUB_URL, TICKETHUB_EMAIL e TICKETHUB_SENHA no servidor).',
      };
    }
    return {
      pronto: true,
      destino: {
        tipo: 'TICKETHUB',
        url,
        urlPublica: c.ticketHub.urlPublica ?? url,
        email,
        senha,
        prioridade: c.ticketHub.prioridade,
        sistemaId: c.ticketHub.sistemaId,
        urlDoAdmin: c.ticketHub.url !== null,
      },
    };
  }

  async destino(): Promise<ResultadoDoDestino> {
    return this.destinoDe(await this.ler());
  }

  visao(c: ConfiguracaoGravada): VisaoDaConfiguracao {
    const amb = this.ambiente.ticketHub;
    const origem = (admin: unknown, ambiente: unknown): Origem =>
      admin ? 'admin' : ambiente ? 'ambiente' : null;
    const segredo = this.decifrar(c.webhook.segredoCifrado);
    const destino = this.destinoDe(c);
    return {
      perguntasPorDia: c.perguntasPorDia,
      orcamentoMensalTokens: c.orcamentoMensalTokens,
      destino: c.destino,
      ticketHub: {
        url: c.ticketHub.url ?? amb.url,
        urlPublica: c.ticketHub.urlPublica,
        email: c.ticketHub.email ?? amb.email,
        senhaDefinida: Boolean(c.ticketHub.senhaCifrada) || amb.senhaDefinida,
        prioridade: c.ticketHub.prioridade,
        sistemaId: c.ticketHub.sistemaId,
        origem: {
          url: origem(c.ticketHub.url, amb.url),
          email: origem(c.ticketHub.email, amb.email),
          senha: origem(c.ticketHub.senhaCifrada, amb.senhaDefinida),
        },
      },
      webhook: {
        url: c.webhook.url,
        cabecalhos: Object.entries(this.cabecalhosDe(c)).map(
          ([nome, valor]) => ({
            nome,
            valorMascarado: this.cripto.mascarar(valor),
          }),
        ),
        segredoDefinido: segredo !== null,
        segredoMascarado: segredo ? this.cripto.mascarar(segredo) : null,
        modeloCorpo: c.webhook.modeloCorpo,
        modeloCorpoPadrao: MODELO_CORPO_PADRAO,
      },
      destinoPronto: destino.pronto,
      motivoDestino: destino.pronto ? null : destino.motivo,
    };
  }

  /** Aplica a alteração parcial, grava e audita (sem valores de segredos). */
  async salvar(
    usuario: UsuarioAutenticado,
    dto: ConfigurarAssistenteDto,
  ): Promise<ConfiguracaoGravada> {
    return this.prisma.$transaction(async (tx) => {
      const linha = await tx.configuracao.findUnique({
        where: { chave: CHAVE_CONFIGURACAO_ASSISTENTE },
      });
      const antes = lerConfiguracaoAssistente(linha?.valor);
      const depois: ConfiguracaoGravada = structuredClone(antes);
      const mudou: string[] = [];
      const marcar = (campo: string, a: unknown, b: unknown) => {
        if (JSON.stringify(a) !== JSON.stringify(b)) {
          mudou.push(campo);
        }
      };
      if (dto.perguntasPorDia !== undefined) {
        depois.perguntasPorDia = dto.perguntasPorDia;
      }
      if (dto.orcamentoMensalTokens !== undefined) {
        depois.orcamentoMensalTokens = dto.orcamentoMensalTokens;
      }
      if (dto.destino !== undefined) {
        depois.destino = dto.destino;
      }
      const th = dto.ticketHub;
      if (th) {
        if (th.url !== undefined) {
          depois.ticketHub.url =
            th.url === null || !th.url.trim()
              ? null
              : urlHttp(th.url.trim(), 'ticketHub.url');
        }
        if (th.urlPublica !== undefined) {
          depois.ticketHub.urlPublica =
            th.urlPublica === null || !th.urlPublica.trim()
              ? null
              : urlHttp(th.urlPublica.trim(), 'ticketHub.urlPublica');
        }
        if (th.email !== undefined) {
          depois.ticketHub.email = th.email?.trim().toLowerCase() || null;
        }
        if (th.senha !== undefined) {
          depois.ticketHub.senhaCifrada =
            th.senha === null ? null : this.cripto.cifrar(th.senha);
        }
        if (th.prioridade !== undefined) {
          depois.ticketHub.prioridade = th.prioridade;
        }
        if (th.sistemaId !== undefined) {
          depois.ticketHub.sistemaId = th.sistemaId;
        }
      }
      const wh = dto.webhook;
      if (wh) {
        if (wh.url !== undefined) {
          depois.webhook.url =
            wh.url === null || !wh.url.trim()
              ? null
              : urlHttp(wh.url.trim(), 'webhook.url');
        }
        if (wh.cabecalhos !== undefined) {
          if (wh.cabecalhos === null) {
            depois.webhook.cabecalhosCifrados = null;
          } else {
            const lidos = validarCabecalhos(wh.cabecalhos, {
              permitirNulos: true,
            });
            if (!lidos.validos) {
              throw new DadosInvalidosException('Dados inválidos.', {
                campos: lidos.problemas.map((p) => ({
                  ...p,
                  campo: `webhook.cabecalhos${p.campo ? `.${p.campo}` : ''}`,
                })),
              });
            }
            const juntos = juntarCabecalhos(
              this.cabecalhosDe(antes),
              lidos.cabecalhos,
              lidos.removidos,
            );
            depois.webhook.cabecalhosCifrados = Object.keys(juntos).length
              ? this.cripto.cifrar(JSON.stringify(juntos))
              : null;
          }
        }
        if (wh.segredo !== undefined) {
          depois.webhook.segredoCifrado =
            wh.segredo === null ? null : this.cripto.cifrar(wh.segredo);
        }
        if (wh.modeloCorpo !== undefined) {
          const modelo = wh.modeloCorpo?.trim() || null;
          if (modelo) {
            const problema = validarModeloCorpo(modelo);
            if (problema) {
              throw new DadosInvalidosException('Dados inválidos.', {
                campos: [
                  { campo: 'webhook.modeloCorpo', mensagens: [problema] },
                ],
              });
            }
          }
          depois.webhook.modeloCorpo = modelo;
        }
      }
      marcar('perguntasPorDia', antes.perguntasPorDia, depois.perguntasPorDia);
      marcar(
        'orcamentoMensalTokens',
        antes.orcamentoMensalTokens,
        depois.orcamentoMensalTokens,
      );
      marcar('destino', antes.destino, depois.destino);
      for (const campo of [
        'url',
        'urlPublica',
        'email',
        'senhaCifrada',
        'prioridade',
        'sistemaId',
      ] as const) {
        marcar(
          `ticketHub.${campo === 'senhaCifrada' ? 'senha' : campo}`,
          antes.ticketHub[campo],
          depois.ticketHub[campo],
        );
      }
      for (const campo of [
        'url',
        'cabecalhosCifrados',
        'segredoCifrado',
        'modeloCorpo',
      ] as const) {
        marcar(
          `webhook.${campo.replace('Cifrados', '').replace('Cifrado', '')}`,
          antes.webhook[campo],
          depois.webhook[campo],
        );
      }
      await tx.configuracao.upsert({
        where: { chave: CHAVE_CONFIGURACAO_ASSISTENTE },
        create: {
          chave: CHAVE_CONFIGURACAO_ASSISTENTE,
          valor: { ...depois },
          atualizadoPorId: usuario.id,
        },
        update: { valor: { ...depois }, atualizadoPorId: usuario.id },
      });
      if (mudou.length) {
        await this.auditoria.registrar(tx, {
          acao: 'assistente.configurado',
          entidade: 'configuracao',
          entidadeId: null,
          resumo: `${usuario.nome} alterou a configuração do assistente de IA (${mudou.join(', ')})`,
          dados: {
            campos: mudou,
            limites: {
              perguntasPorDia: [antes.perguntasPorDia, depois.perguntasPorDia],
              orcamentoMensalTokens: [
                antes.orcamentoMensalTokens,
                depois.orcamentoMensalTokens,
              ],
            },
            destino: [antes.destino, depois.destino],
            regra: REGRA_ASSISTENTE,
          },
        });
      }
      return depois;
    });
  }
}
