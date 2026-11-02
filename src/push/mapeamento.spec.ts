import {
  cargaDaNotificacao,
  preferenciaDoTipo,
  urlDoFront,
} from './mapeamento';
import {
  PREFERENCIA_POR_TIPO_DE_NOTIFICACAO,
  TIPOS_DE_PREFERENCIA,
} from './push.constantes';

describe('mapeamento do push (R26)', () => {
  it('R26.3 — todo tipo de preferência é usado por algum tipo de notificação', () => {
    const usados = new Set(Object.values(PREFERENCIA_POR_TIPO_DE_NOTIFICACAO));
    expect([...usados].sort()).toEqual([...TIPOS_DE_PREFERENCIA].sort());
  });

  it('R26.3 — mapeia os tipos combinados e ignora os demais', () => {
    expect(preferenciaDoTipo('conversa.atribuida')).toBe('conversa_atribuida');
    expect(preferenciaDoTipo('chat.mencao')).toBe('mencao');
    expect(preferenciaDoTipo('atividade.atrasada')).toBe('atividade_vencendo');
    expect(preferenciaDoTipo('conversa.sla_resolucao')).toBe('sla_estourado');
    expect(preferenciaDoTipo('passagem.recebida')).toBe('negocio_atribuido');
    expect(preferenciaDoTipo('regua.ligacao')).toBe('parcela_atrasada');
    expect(preferenciaDoTipo('webhook_saida.falhou')).toBeNull();
    expect(preferenciaDoTipo('qualquer.coisa')).toBeNull();
  });

  it('R26.3 — só abre rotas internas do front', () => {
    expect(urlDoFront('/funis/comercial?negocio=1')).toBe(
      '/funis/comercial?negocio=1',
    );
    for (const ruim of [
      null,
      undefined,
      '',
      'https://x.com',
      '//x.com/a',
      '/\\x.com',
      `/${'a'.repeat(600)}`,
    ]) {
      expect(urlDoFront(ruim)).toBe('/notificacoes');
    }
  });

  it('R26.3 — corta título e corpo longos', () => {
    const carga = cargaDaNotificacao({
      id: 'n1',
      tipo: 'negocio.atribuido',
      titulo: 'T'.repeat(300),
      texto: null,
      link: null,
    });
    expect(carga.titulo).toHaveLength(100);
    expect(carga.corpo).toBe('');
    expect(carga.tag).toBe('negocio.atribuido:n1');
  });
});
