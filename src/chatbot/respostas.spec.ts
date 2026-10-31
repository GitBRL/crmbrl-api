import {
  casarOpcao,
  lerData,
  lerNumero,
  textoComOpcoes,
  textoDaPerguntaComOpcoes,
  validarResposta,
} from './respostas';

const OPCOES = [
  { id: 'vendas', rotulo: 'Quero comprar' },
  { id: 'suporte', rotulo: 'Preciso de suporte' },
  { id: 'outro', rotulo: 'Outro assunto' },
];

describe('R18 — respostas do contato às perguntas do bot', () => {
  it('R18.2 — chat do site manda só o texto (as opções vão como botões); WhatsApp e e-mail, numeradas', () => {
    expect(textoDaPerguntaComOpcoes(true, ' Como ajudo? ', OPCOES)).toBe(
      'Como ajudo?',
    );
    expect(textoDaPerguntaComOpcoes(false, 'Como ajudo?', OPCOES)).toBe(
      textoComOpcoes('Como ajudo?', OPCOES),
    );
  });

  describe('opções numeradas', () => {
    it('R18.3 — aceita o número, com pontuação, ou o texto da opção sem acento nem caixa', () => {
      expect(casarOpcao('2', OPCOES)?.id).toBe('suporte');
      expect(casarOpcao(' 3) ', OPCOES)?.id).toBe('outro');
      expect(casarOpcao('1.', OPCOES)?.id).toBe('vendas');
      expect(casarOpcao('PRECISO DE SUPORTE', OPCOES)?.id).toBe('suporte');
      expect(casarOpcao('quero  comprar', OPCOES)?.id).toBe('vendas');
    });

    it('R18.3 — número fora da lista, texto solto e vazio não casam', () => {
      expect(casarOpcao('0', OPCOES)).toBeNull();
      expect(casarOpcao('4', OPCOES)).toBeNull();
      expect(casarOpcao('talvez', OPCOES)).toBeNull();
      expect(casarOpcao('   ', OPCOES)).toBeNull();
    });

    it('R18.3 — monta o texto com as opções numeradas', () => {
      expect(textoComOpcoes('Como posso ajudar?', OPCOES)).toBe(
        'Como posso ajudar?\n\n1 - Quero comprar\n2 - Preciso de suporte\n3 - Outro assunto\n\nResponda com o número da opção.',
      );
    });
  });

  describe('validações da pergunta aberta', () => {
    it('R18.3 — e-mail: normaliza ou recusa', () => {
      expect(validarResposta('email', ' Ana@Exemplo.COM ')).toEqual({
        valido: true,
        valor: 'ana@exemplo.com',
      });
      expect(validarResposta('email', 'ana@')).toMatchObject({ valido: false });
    });

    it('R18.3 — telefone: E.164 só com dígitos; DDD inexistente é recusado', () => {
      expect(validarResposta('telefone', '(11) 98765-4321')).toEqual({
        valido: true,
        valor: '5511987654321',
      });
      expect(validarResposta('telefone', '(20) 98765-4321')).toMatchObject({
        valido: false,
      });
    });

    it('R18.3 — número: aceita 1.234,56 e 12,5; recusa texto', () => {
      expect(lerNumero('1.234,56')).toBe(1234.56);
      expect(lerNumero('12,5')).toBe(12.5);
      expect(lerNumero('R$ 300')).toBe(300);
      expect(lerNumero('doze')).toBeNull();
      expect(validarResposta('numero', 'abc')).toMatchObject({ valido: false });
      expect(validarResposta('numero', '42')).toEqual({
        valido: true,
        valor: 42,
      });
    });

    it('R18.3 — data: dd/mm/aaaa vira aaaa-mm-dd e datas que não existem são recusadas', () => {
      expect(lerData('25/12/2026')).toBe('2026-12-25');
      expect(lerData('5-3-26')).toBe('2026-03-05');
      expect(lerData('31/02/2026')).toBeNull();
      expect(lerData('ontem')).toBeNull();
      expect(validarResposta('data', '29/02/2028')).toEqual({
        valido: true,
        valor: '2028-02-29',
      });
    });

    it('R18.3 — texto: recusa só o vazio', () => {
      expect(validarResposta('texto', '  oi  ')).toEqual({
        valido: true,
        valor: 'oi',
      });
      expect(validarResposta('texto', '   ')).toMatchObject({ valido: false });
    });
  });
});
