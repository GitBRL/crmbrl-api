import type { Passo } from '../comum/passos/definicao';
import {
  campoDoContatoValido,
  nomeDeVariavelValido,
  validarCondicao,
  validarCriarAtividade,
  validarDefinirCampo,
  validarEtiquetar,
  validarMensagem,
  validarPerguntaAberta,
  validarPerguntaComOpcoes,
  validarTransferir,
  validarWebhook,
} from './configuracao-dos-passos';

const passo = (extra: Partial<Passo> = {}): Passo => ({
  id: 'p1',
  tipo: 'x',
  ...extra,
});

const OPCOES = [
  { id: 'a', rotulo: 'Sim' },
  { id: 'b', rotulo: 'Não' },
];

describe('R18 — validação da configuração dos passos', () => {
  it('R18.2 — mensagem: exige texto ou mídia e confere as variáveis', () => {
    expect(validarMensagem({})).toMatch(/texto/);
    expect(
      validarMensagem({ texto: 'Oi, {{contato.primeiro_nome}}' }),
    ).toBeNull();
    expect(validarMensagem({ arquivoId: 'abc' })).toBeNull();
    expect(validarMensagem({ texto: 'Oi {{contato.xyz}}' })).not.toBeNull();
  });

  it('R18.2 — pergunta com opções: 2 a 10 opções diferentes, ramos coerentes', () => {
    expect(
      validarPerguntaComOpcoes({ texto: 'Ok?', opcoes: OPCOES }, passo()),
    ).toBeNull();
    expect(
      validarPerguntaComOpcoes({ texto: '', opcoes: OPCOES }, passo()),
    ).toMatch(/pergunta/);
    expect(
      validarPerguntaComOpcoes({ texto: 'Ok?', opcoes: [OPCOES[0]] }, passo()),
    ).toMatch(/opções/);
    expect(
      validarPerguntaComOpcoes(
        { texto: 'Ok?', opcoes: [OPCOES[0], { id: 'c', rotulo: 'sim' }] },
        passo(),
      ),
    ).toMatch(/diferentes/);
    expect(
      validarPerguntaComOpcoes(
        { texto: 'Ok?', opcoes: OPCOES },
        passo({ ramos: [{ id: 'z', passos: [] }] }),
      ),
    ).toMatch(/não corresponde/);
    expect(
      validarPerguntaComOpcoes(
        { texto: 'Ok?', opcoes: OPCOES },
        passo({
          ramos: [
            { id: 'a', passos: [] },
            { id: 'sem_resposta', passos: [] },
            { id: 'invalida', passos: [] },
          ],
        }),
      ),
    ).toBeNull();
    expect(
      validarPerguntaComOpcoes(
        { texto: 'Ok?', opcoes: OPCOES, variavel: '1x' },
        passo(),
      ),
    ).toMatch(/variável/);
  });

  it('R18.5 — tempo sem resposta: lembrete precisa de texto e o encerramento vem depois', () => {
    const base = { texto: 'Ok?', opcoes: OPCOES };
    expect(
      validarPerguntaComOpcoes(
        {
          ...base,
          tempoSemResposta: {
            lembreteAposMinutos: 5,
            lembrete: 'Alô?',
            encerrarAposMinutos: 20,
          },
        },
        passo(),
      ),
    ).toBeNull();
    expect(
      validarPerguntaComOpcoes(
        { ...base, tempoSemResposta: { lembreteAposMinutos: 5 } },
        passo(),
      ),
    ).toMatch(/lembrete/);
    expect(
      validarPerguntaComOpcoes(
        {
          ...base,
          tempoSemResposta: {
            lembreteAposMinutos: 20,
            lembrete: 'x',
            encerrarAposMinutos: 10,
          },
        },
        passo(),
      ),
    ).toMatch(/depois do lembrete/);
    expect(
      validarPerguntaComOpcoes(
        { ...base, tempoSemResposta: { encerrarAposMinutos: 0 } },
        passo(),
      ),
    ).toMatch(/minutos/);
    expect(
      validarPerguntaComOpcoes({ ...base, tentativas: 99 }, passo()),
    ).toMatch(/Tentativas/);
  });

  it('R18.3 — pergunta aberta: variável obrigatória, validação e campo do contato conhecidos', () => {
    expect(
      validarPerguntaAberta({ texto: 'Nome?', variavel: 'nome' }, passo()),
    ).toBeNull();
    expect(validarPerguntaAberta({ texto: 'Nome?' }, passo())).toMatch(
      /variável/,
    );
    expect(
      validarPerguntaAberta(
        { texto: 'x', variavel: 'v', validacao: 'cpf' as never },
        passo(),
      ),
    ).toMatch(/validação/);
    expect(
      validarPerguntaAberta(
        { texto: 'x', variavel: 'v', campoContato: 'senha' },
        passo(),
      ),
    ).toMatch(/campo/);
    expect(
      validarPerguntaAberta(
        {
          texto: 'x',
          variavel: 'v',
          campoContato: 'campos.interesse',
          validacao: 'email',
        },
        passo(),
      ),
    ).toBeNull();
    expect(nomeDeVariavelValido('minha_var1')).toBe(true);
    expect(nomeDeVariavelValido('1a')).toBe(false);
    expect(campoDoContatoValido('campos.a-b')).toBe(false);
    expect(campoDoContatoValido('cargo')).toBe(true);
  });

  it('R18.4 — condição: precisa de ramos e cada condição completa', () => {
    expect(validarCondicao({}, passo())).toMatch(/ramo/);
    expect(
      validarCondicao(
        {},
        passo({
          ramos: [
            {
              id: 'r1',
              passos: [],
              config: { condicao: { tipo: 'etiqueta', etiqueta: 'VIP' } },
            },
            { id: 'senao', passos: [] },
          ],
        }),
      ),
    ).toBeNull();
    expect(
      validarCondicao(
        {},
        passo({
          ramos: [
            {
              id: 'r1',
              passos: [],
              config: { condicao: { tipo: 'etiqueta' } },
            },
          ],
        }),
      ),
    ).toMatch(/etiqueta/);
  });

  it('R18.4 — ações: configurações mínimas', () => {
    expect(validarEtiquetar({})).toMatch(/etiqueta/);
    expect(validarEtiquetar({ adicionar: ['VIP'] })).toBeNull();
    expect(validarEtiquetar({ remover: ['Frio'] })).toBeNull();
    expect(
      validarDefinirCampo({ campo: 'campos.x', valor: '{{variaveis.a}}' }),
    ).toBeNull();
    expect(validarDefinirCampo({ campo: 'senha', valor: 'x' })).toMatch(
      /campo/,
    );
    expect(validarCriarAtividade({ titulo: 'Ligar' })).toBeNull();
    expect(validarCriarAtividade({ titulo: '' })).toMatch(/título/);
    expect(validarCriarAtividade({ titulo: 'x', tipo: 'NOTA' })).toMatch(
      /tipo/,
    );
    expect(validarWebhook({ url: 'https://exemplo.com/x' })).toBeNull();
    expect(validarWebhook({ url: 'ftp://exemplo.com' })).toMatch(/http/);
    expect(validarWebhook({ url: 'https://u:p@exemplo.com' })).toMatch(
      /usuário/,
    );
    expect(validarWebhook({ url: 'nada' })).toMatch(/URL/);
    expect(validarTransferir({})).toBeNull();
    expect(validarTransferir({ filaId: 3 as never })).toMatch(/fila/);
  });
});
