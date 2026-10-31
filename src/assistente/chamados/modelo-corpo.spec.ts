import {
  type DadosDoCorpo,
  MODELO_CORPO_PADRAO,
  numeroELinkDaResposta,
  renderizarCorpo,
  validarModeloCorpo,
} from './modelo-corpo';

const DADOS: DadosDoCorpo = {
  chamadoId: 'c1',
  conversaId: 'v1',
  titulo: 'Relatório "novo"',
  descricao: 'linha 1\nlinha 2',
  categoria: 'erro_do_sistema',
  tela: '/funis/comercial',
  criadoEm: '2026-10-31T12:00:00.000Z',
  'usuario.nome': 'Ana',
  'usuario.email': 'ana@demo.local',
  'usuario.papel': 'Comercial',
  'usuario.area': 'Comercial',
  conversa: [
    { autor: 'pessoa', texto: 'oi' },
    { autor: 'assistente', texto: 'olá' },
  ],
  conversaTexto: '[Pessoa] oi\n\n[Assistente] olá',
};

describe('R25 — modelo do corpo do webhook de chamados', () => {
  it('R25.4 — o modelo padrão é válido e leva a conversa como lista', () => {
    expect(validarModeloCorpo(MODELO_CORPO_PADRAO)).toBeNull();
    const corpo = JSON.parse(renderizarCorpo(null, DADOS));
    expect(corpo.chamado.titulo).toBe('Relatório "novo"');
    expect(corpo.chamado.descricao).toBe('linha 1\nlinha 2');
    expect(corpo.usuario.email).toBe('ana@demo.local');
    expect(corpo.conversa).toEqual(DADOS.conversa);
  });

  it('R25.4 — modelo do Admin: variáveis no meio do texto e escape de JSON', () => {
    const modelo =
      '{"text":"[{{categoria}}] {{titulo}} — {{usuario.nome}}","fields":[{"v":"{{conversa}}"}],"n":1}';
    expect(validarModeloCorpo(modelo)).toBeNull();
    const corpo = JSON.parse(renderizarCorpo(modelo, DADOS));
    expect(corpo).toEqual({
      text: '[erro_do_sistema] Relatório "novo" — Ana',
      fields: [{ v: DADOS.conversa }],
      n: 1,
    });
  });

  it('R25.4 — modelo inválido ou com variável desconhecida é recusado', () => {
    expect(validarModeloCorpo('{"a": ')).toContain('JSON válido');
    expect(validarModeloCorpo('"texto"')).toContain('objeto');
    expect(validarModeloCorpo('{"a":"{{contato.cpf}}"}')).toContain(
      'contato.cpf',
    );
  });

  it('R25.4 — número e link na resposta do destino', () => {
    expect(numeroELinkDaResposta({ id: 'abc', titulo: 'x' })).toEqual({
      numero: 'abc',
      link: null,
    });
    expect(
      numeroELinkDaResposta({
        ticket: { numero: 42, url: 'https://suporte.exemplo.com/t/42' },
      }),
    ).toEqual({ numero: '42', link: 'https://suporte.exemplo.com/t/42' });
    expect(
      numeroELinkDaResposta({ protocolo: 'P-1', link: 'javascript:alert(1)' }),
    ).toEqual({ numero: 'P-1', link: null });
    expect(numeroELinkDaResposta('ok')).toEqual({ numero: null, link: null });
  });
});
