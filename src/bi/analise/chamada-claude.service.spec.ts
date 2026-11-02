import Anthropic from '@anthropic-ai/sdk';
import {
  ClienteAnthropicFalso,
  erroDaApi,
} from '../../../test/utils/anthropic-falso';
import {
  ChamadaClaudeService,
  FalhaDaChamada,
  type ObservadorDaChamada,
} from './chamada-claude.service';
import type { ParametrosDoFluxo } from './cliente-anthropic';
import { conferirResposta } from './esquema-analise';

const PARAMETROS: ParametrosDoFluxo = {
  model: 'claude-opus-5-5',
  max_tokens: 1000,
  messages: [
    { role: 'user', content: 'Analise: {"painel":"cs","indicadores":[]}' },
  ],
};

const VALIDA = {
  resumo: 'Tudo certo.',
  destaques: [],
  riscos: [],
  acoes: [],
};

function observador() {
  const eventos: string[] = [];
  const textos: string[] = [];
  const obs: ObservadorDaChamada = {
    aoIniciarTentativa: (t, motivo) => eventos.push(`tentativa:${t}:${motivo}`),
    aoMudarDeFase: (fase) => eventos.push(`fase:${fase}`),
    aoReceberTexto: (texto) => textos.push(texto),
  };
  return { obs, eventos, textos };
}

describe('chamada ao Claude da análise (R21)', () => {
  let falso: ClienteAnthropicFalso;
  let servico: ChamadaClaudeService;

  beforeEach(() => {
    falso = new ClienteAnthropicFalso();
    servico = new ChamadaClaudeService(falso, {
      timeoutMs: 80,
      esperaMs: 5,
      tentativas: 2,
    });
  });

  it('R21 — streaming: fases, texto acumulado e tokens da resposta', async () => {
    falso.enfileirar({
      tipo: 'resposta',
      corpo: VALIDA,
      uso: {
        input_tokens: 10,
        output_tokens: 20,
        cache_read_input_tokens: 30,
        cache_creation_input_tokens: 40,
      },
    });
    const { obs, eventos, textos } = observador();
    const r = await servico.executar(
      PARAMETROS,
      obs,
      conferirResposta,
      new AbortController().signal,
    );
    expect(r.valor.resumo).toBe('Tudo certo.');
    expect(r.tentativas).toBe(1);
    expect(r.uso).toEqual({
      entrada: 10,
      saida: 20,
      cacheLeitura: 30,
      cacheEscrita: 40,
    });
    expect(eventos).toEqual([
      'tentativa:1:null',
      'fase:pensando',
      'fase:escrevendo',
    ]);
    expect(textos.length).toBeGreaterThan(2);
    expect(textos.at(-1)).toBe(JSON.stringify(VALIDA));
  });

  it('R21 — tempo esgotado: uma nova tentativa, que responde', async () => {
    falso.enfileirar({ tipo: 'travar' }, { tipo: 'resposta', corpo: VALIDA });
    const { obs, eventos } = observador();
    const r = await servico.executar(
      PARAMETROS,
      obs,
      conferirResposta,
      new AbortController().signal,
    );
    expect(r.tentativas).toBe(2);
    expect(eventos[0]).toBe('tentativa:1:null');
    expect(eventos).toContain('tentativa:2:tempo_esgotado');
    expect(falso.chamadas).toHaveLength(2);
  });

  it('R21 — tempo esgotado duas vezes: falha sem terceira tentativa', async () => {
    falso.enfileirar(
      { tipo: 'travar' },
      { tipo: 'travar' },
      { tipo: 'resposta' },
    );
    const { obs } = observador();
    await expect(
      servico.executar(
        PARAMETROS,
        obs,
        conferirResposta,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ codigo: 'tempo_esgotado', tentativas: 2 });
    expect(falso.chamadas).toHaveLength(2);
  });

  it('R21 — 529/5xx e erro no meio do streaming são repetidos; os tokens das duas tentativas somam', async () => {
    falso.enfileirar(
      { tipo: 'erro_no_meio', erro: erroDaApi(529, 'Overloaded') },
      {
        tipo: 'resposta',
        corpo: VALIDA,
        uso: { input_tokens: 100, output_tokens: 5 },
      },
    );
    const { obs, eventos } = observador();
    const r = await servico.executar(
      PARAMETROS,
      obs,
      conferirResposta,
      new AbortController().signal,
    );
    expect(eventos).toContain('tentativa:2:indisponivel');
    // 1ª tentativa: 1200 de entrada (message_start do falso) + 2ª: 100.
    expect(r.uso.entrada).toBe(1300);
    expect(r.uso.saida).toBe(1 + 5);
  });

  it('R21 — chave recusada (401) não é repetida', async () => {
    falso.enfileirar({
      tipo: 'erro',
      erro: erroDaApi(401, 'invalid x-api-key'),
    });
    const { obs } = observador();
    const erro = await servico
      .executar(PARAMETROS, obs, conferirResposta, new AbortController().signal)
      .catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(FalhaDaChamada);
    expect(erro).toMatchObject({ codigo: 'chave_recusada', tentativas: 1 });
    expect((erro as Error).message).not.toContain('x-api-key');
    expect(falso.chamadas).toHaveLength(1);
  });

  it('R21 — conexão caída é repetida; 400 não', async () => {
    falso.enfileirar(
      {
        tipo: 'erro',
        erro: new Anthropic.APIConnectionError({ message: 'reset' }),
      },
      { tipo: 'erro', erro: erroDaApi(400, 'bad') },
    );
    const { obs } = observador();
    await expect(
      servico.executar(
        PARAMETROS,
        obs,
        conferirResposta,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ codigo: 'erro', tentativas: 2 });
  });

  it('R21 — resposta fora do formato: nova tentativa; recusa e corte por max_tokens não', async () => {
    falso.enfileirar(
      { tipo: 'resposta', corpo: '{"resumo": ' },
      { tipo: 'resposta', corpo: VALIDA },
    );
    const { obs } = observador();
    const r = await servico.executar(
      PARAMETROS,
      obs,
      conferirResposta,
      new AbortController().signal,
    );
    expect(r.tentativas).toBe(2);

    falso.enfileirar({
      tipo: 'resposta',
      corpo: VALIDA,
      stopReason: 'refusal',
    });
    await expect(
      servico.executar(
        PARAMETROS,
        obs,
        conferirResposta,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ codigo: 'recusada', tentativas: 1 });

    falso.enfileirar({
      tipo: 'resposta',
      corpo: VALIDA,
      stopReason: 'max_tokens',
    });
    await expect(
      servico.executar(
        PARAMETROS,
        obs,
        conferirResposta,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ codigo: 'resposta_incompleta', tentativas: 1 });
  });

  it('R21 — cancelar (o front fechou) interrompe sem nova tentativa', async () => {
    falso.enfileirar({ tipo: 'travar' }, { tipo: 'resposta' });
    const cancelar = new AbortController();
    const { obs } = observador();
    setTimeout(() => cancelar.abort(), 10);
    await expect(
      servico.executar(PARAMETROS, obs, conferirResposta, cancelar.signal),
    ).rejects.toMatchObject({ codigo: 'cancelada' });
    expect(falso.chamadas).toHaveLength(1);
  });
});
