import { problemasDaDefinicao } from '../comum/passos/definicao';
import { PASSOS_PADRAO } from '../comum/passos/passos-padrao';
import { MODELOS_PRONTOS } from './modelos-prontos';
import { conferirCondicoes } from './condicoes';
import { conferirGatilho } from './gatilho-config';
import { VALIDADORES_DE_ACAO } from './acoes-validacao';

const UUID = '3f1c2b0e-8a3d-4c55-9a51-2d8f8d7c1e10';

describe('Ações das automações (R19.4)', () => {
  it('R19.4 — WhatsApp exige modelo ou texto; e-mail também o assunto', () => {
    const whatsapp = VALIDADORES_DE_ACAO['acao.whatsapp'];
    const email = VALIDADORES_DE_ACAO['acao.email'];
    const passo = { id: 'p', tipo: 'x' };
    expect(whatsapp({}, passo)).toMatch(/modelo ou escreva/);
    expect(
      whatsapp({ texto: 'Olá {{contato.primeiro_nome}}' }, passo),
    ).toBeNull();
    expect(whatsapp({ texto: 'Olá {{coisa.estranha}}' }, passo)).toMatch(
      /Mensagem/,
    );
    expect(whatsapp({ modeloId: UUID }, passo)).toBeNull();
    expect(email({ texto: 'Oi' }, passo)).toMatch(/assunto/);
    expect(email({ texto: 'Oi', assunto: 'Bem-vindo' }, passo)).toBeNull();
  });

  it('R19.4 — atividade, mover etapa, atribuir, etiquetar e notificar conferem a configuração', () => {
    const passo = { id: 'p', tipo: 'x' };
    expect(
      VALIDADORES_DE_ACAO['acao.atividade'](
        { tipo: 'NOTA', titulo: 'x' },
        passo,
      ),
    ).toMatch(/tipo da atividade/);
    expect(
      VALIDADORES_DE_ACAO['acao.atividade'](
        {
          tipo: 'TAREFA',
          titulo: 'Ligar',
          prazo: { quantidade: 2, unidade: 'dias' },
        },
        passo,
      ),
    ).toBeNull();
    expect(VALIDADORES_DE_ACAO['acao.mover_etapa']({}, passo)).toMatch(/etapa/);
    expect(
      VALIDADORES_DE_ACAO['acao.atribuir'](
        { estrategia: 'RESPONSAVEL_FIXO' },
        passo,
      ),
    ).toMatch(/pessoa/);
    expect(
      VALIDADORES_DE_ACAO['acao.atribuir']({ estrategia: 'RODIZIO' }, passo),
    ).toBeNull();
    expect(VALIDADORES_DE_ACAO['acao.etiquetar']({}, passo)).toMatch(
      /etiqueta/,
    );
    expect(
      VALIDADORES_DE_ACAO['acao.etiquetar']({ adicionar: ['VIP'] }, passo),
    ).toBeNull();
    expect(
      VALIDADORES_DE_ACAO['acao.notificar'](
        { para: 'usuarios', titulo: 'x' },
        passo,
      ),
    ).toMatch(/pessoas/);
    expect(
      VALIDADORES_DE_ACAO['acao.criar_negocio'](
        { funilId: UUID, valor: 'abc' },
        passo,
      ),
    ).toMatch(/valor/);
  });

  it('R19.4 — condição aceita só os ramos "sim" e "nao"', () => {
    const segmento = {
      condicoes: [
        { campo: 'etiquetas', operador: 'contem_alguma', valor: ['vip'] },
      ],
    };
    const valida = VALIDADORES_DE_ACAO['condicao'];
    expect(
      valida(
        { segmento },
        { id: 'c', tipo: 'condicao', ramos: [{ id: 'sim', passos: [] }] },
      ),
    ).toBeNull();
    expect(
      valida(
        { segmento },
        { id: 'c', tipo: 'condicao', ramos: [{ id: 'talvez', passos: [] }] },
      ),
    ).toMatch(/sim/);
    expect(valida({}, { id: 'c', tipo: 'condicao' })).toMatch(/condição/);
  });

  it('R19.4 — os modelos prontos são automações válidas (gatilho, condições e passos)', () => {
    const tipos = new Map<string, never>();
    for (const p of PASSOS_PADRAO) {
      tipos.set(p.tipo, p.validar as never);
    }
    for (const [tipo, validar] of Object.entries(VALIDADORES_DE_ACAO)) {
      tipos.set(tipo, validar as never);
    }
    for (const modelo of MODELOS_PRONTOS) {
      const a = modelo.automacao;
      const gatilho = conferirGatilho({
        tipoGatilho: a.tipoGatilho,
        evento: a.evento,
        gatilhoConfig: a.gatilhoConfig,
        entidade: a.entidade,
      });
      expect({ modelo: modelo.chave, erros: gatilho.erros }).toEqual({
        modelo: modelo.chave,
        erros: [],
      });
      expect(conferirCondicoes(a.condicoes).erros).toEqual([]);
      expect(problemasDaDefinicao(a.definicao, { tipos })).toEqual([]);
    }
  });
});
