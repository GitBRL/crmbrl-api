/**
 * Apoio dos testes do SDR com IA (R31): um cliente falso da Anthropic que
 * entende o pedido `turno_sdr` (o mesmo combinado da Anthropic falsa do
 * ambiente dos agentes). Sem roteiro, responde de forma determinística:
 *
 * - a última mensagem do lead tem "humano" ou "atendente": passar_humano;
 * - tem "matricular" ou "quero fechar": qualificado, com todos os critérios da
 *   linha `CRITERIOS:` preenchidos;
 * - tem padrões `chave: valor` de critérios: esses critérios (confiança 0,9) e continuar;
 * - senão: continuar com uma resposta educada.
 */
import type {
  ClienteAnthropic,
  FluxoDeMensagem,
  ParametrosDoFluxo,
} from '../src/bi/analise/cliente-anthropic';
import {
  ClienteAnthropicFalso,
  type RoteiroFalso,
} from './utils/anthropic-falso';

export interface TurnoFalso {
  resposta: string;
  criterios: { chave: string; valor: string; confianca: number }[];
  acao: 'continuar' | 'qualificado' | 'desqualificado' | 'passar_humano';
  motivo: string;
  resumo: string;
}

function textoDe(conteudo: unknown): string {
  if (typeof conteudo === 'string') {
    return conteudo;
  }
  if (Array.isArray(conteudo)) {
    return conteudo
      .map((b) =>
        typeof b === 'object' && b !== null && 'text' in b
          ? String((b as { text: unknown }).text)
          : '',
      )
      .join('\n');
  }
  return '';
}

function semAcento(texto: string): string {
  return texto.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

export function sistemaDoPedido(p: ParametrosDoFluxo): string {
  return textoDe(p.system);
}

/** O texto da última mensagem do usuário (a do lead). */
export function ultimaDoLead(p: ParametrosDoFluxo): string {
  const m = [...p.messages].reverse().find((x) => x.role === 'user');
  return textoDe(m?.content);
}

export function ehPedidoDoSdr(p: ParametrosDoFluxo): boolean {
  const formato = p.output_config?.format as
    { schema?: { title?: string } } | undefined;
  return formato?.schema?.title === 'turno_sdr';
}

/** Um valor aceito pelo tipo do critério (lido da linha do bloco `<criterios>` do prompt). */
function valorValido(sistema: string, chave: string): string {
  const linha = sistema
    .split('\n')
    .find((l) => l.startsWith(`- chave: ${chave};`));
  const tipo = /tipo: (\w+)/.exec(linha ?? '')?.[1] ?? 'texto';
  if (tipo === 'opcao') {
    const opcoes = /opções: ([^;]+)/.exec(linha ?? '')?.[1] ?? '';
    return opcoes.split('|')[0].trim();
  }
  if (tipo === 'data') {
    return '2027-02-01';
  }
  if (tipo === 'sim_nao') {
    return 'sim';
  }
  return tipo === 'numero' ? '10' : 'informado';
}

function turnoPadrao(p: ParametrosDoFluxo): TurnoFalso {
  const sistema = sistemaDoPedido(p);
  const lead = ultimaDoLead(p);
  const linha = /^CRITERIOS:[ \t]*(.*)$/m.exec(sistema)?.[1] ?? '';
  const chaves = linha
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);
  const q = semAcento(lead);
  if (/humano|atendente/.test(q)) {
    return {
      resposta:
        'Claro, vou chamar uma pessoa da equipe para continuar com você.',
      criterios: [],
      acao: 'passar_humano',
      motivo: 'O lead pediu para falar com uma pessoa.',
      resumo: 'Lead pediu atendimento humano.',
    };
  }
  const achados: TurnoFalso['criterios'] = [];
  for (const chave of chaves) {
    const variantes = [...new Set([chave, chave.replace(/_/g, ' ')])];
    const m = new RegExp(
      `(?:^|[\\s,;])(?:${variantes.join('|')})\\s*[:=]\\s*([^,;\\n]+)`,
      'i',
    ).exec(lead);
    if (m) {
      achados.push({ chave, valor: m[1].trim(), confianca: 0.9 });
    }
  }
  if (/matricular|quero fechar/.test(q)) {
    return {
      resposta:
        'Que ótimo! Vou passar você para a equipe comercial finalizar a matrícula.',
      criterios: chaves.map(
        (chave) =>
          achados.find((a) => a.chave === chave) ?? {
            chave,
            valor: valorValido(sistema, chave),
            confianca: 0.9,
          },
      ),
      acao: 'qualificado',
      motivo: 'O lead quer fechar e os critérios foram atendidos.',
      resumo: 'Lead quer se matricular; todos os critérios preenchidos.',
    };
  }
  if (achados.length > 0) {
    return {
      resposta: `Obrigada pelas informações (${achados.map((a) => a.chave).join(', ')}).`,
      criterios: achados,
      acao: 'continuar',
      motivo: 'Critérios descobertos na mensagem do lead.',
      resumo: `Descobertos: ${achados.map((a) => `${a.chave}=${a.valor}`).join('; ')}.`,
    };
  }
  return {
    resposta: 'Olá! Obrigada pela mensagem. Como posso ajudar você hoje?',
    criterios: [],
    acao: 'continuar',
    motivo: 'Sem critérios novos na mensagem.',
    resumo: 'Conversa em andamento.',
  };
}

type Proximo = Partial<TurnoFalso> | RoteiroFalso;

/**
 * Cliente falso do SDR: `responder(...)` enfileira respostas roteirizadas (a
 * próxima chamada usa a primeira); `roteiro(...)` enfileira falhas (erro,
 * travar…); sem fila, vale o comportamento padrão acima.
 */
export class SdrAnthropicFalso implements ClienteAnthropic {
  private readonly base = new ClienteAnthropicFalso();
  private readonly proximos: Proximo[] = [];

  get chamadas(): ParametrosDoFluxo[] {
    return this.base.chamadas;
  }

  responder(...turnos: Partial<TurnoFalso>[]): void {
    this.proximos.push(...turnos);
  }

  roteiro(...roteiros: RoteiroFalso[]): void {
    this.proximos.push(...roteiros);
  }

  /** Pausa entre os eventos do streaming (deixa o turno demorar, para testar corridas). */
  set atrasoMs(ms: number) {
    this.base.atrasoMs = ms;
  }

  limpar(): void {
    this.base.limpar();
    this.proximos.length = 0;
  }

  transmitir(
    parametros: ParametrosDoFluxo,
    opcoes: { signal: AbortSignal; timeout: number },
  ): FluxoDeMensagem {
    const proximo = this.proximos.shift();
    if (proximo && 'tipo' in proximo) {
      this.base.enfileirar(proximo);
    } else {
      const padrao = ehPedidoDoSdr(parametros) ? turnoPadrao(parametros) : {};
      this.base.enfileirar({
        tipo: 'resposta',
        corpo: { ...padrao, ...proximo },
      });
    }
    return this.base.transmitir(parametros, opcoes);
  }
}
