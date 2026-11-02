import {
  aplicarVariaveis,
  FORMATO_DO_ATALHO,
  normalizarAtalho,
  saudacao,
  telefoneLegivel,
  valoresDasVariaveis,
  variaveisDesconhecidas,
  variaveisDoTexto,
} from './variaveis';

describe('variáveis das respostas rápidas (R12)', () => {
  const valores = valoresDasVariaveis({
    contato: {
      nome: 'Maria  Souza',
      email: 'maria@exemplo.com',
      telefone: '5511988887777',
      empresa: null,
    },
    usuario: { nome: 'Ana Lima' },
    canal: { nome: 'WhatsApp Vendas' },
    // 23/10/2026 15h em São Paulo.
    agora: new Date('2026-10-23T18:00:00Z'),
  });

  it('preenche as variáveis conhecidas (com ou sem espaços) e apaga as vazias', () => {
    expect(
      aplicarVariaveis(
        '{{saudacao}}, {{ contato.primeiroNome }}! Sou {{usuario.primeiroNome}}, do {{canal.nome}}. {{contato.empresa}}Fone: {{contato.telefone}} em {{data.hoje}}',
        valores,
      ),
    ).toBe(
      'Boa tarde, Maria! Sou Ana, do WhatsApp Vendas. Fone: (11) 98888-7777 em 23/10/2026',
    );
  });

  it('variável desconhecida fica como está e é apontada no cadastro', () => {
    const texto = 'Oi {{contato.nome}} {{pedido.numero}} {{contato.nome}}';
    expect(variaveisDoTexto(texto)).toEqual(['contato.nome', 'pedido.numero']);
    expect(variaveisDesconhecidas(texto)).toEqual(['pedido.numero']);
    expect(aplicarVariaveis(texto, valores)).toBe(
      'Oi Maria  Souza {{pedido.numero}} Maria  Souza',
    );
  });

  it('saudação pela hora', () => {
    expect(saudacao(5)).toBe('Bom dia');
    expect(saudacao(11)).toBe('Bom dia');
    expect(saudacao(12)).toBe('Boa tarde');
    expect(saudacao(18)).toBe('Boa noite');
    expect(saudacao(2)).toBe('Boa noite');
  });

  it('telefone legível', () => {
    expect(telefoneLegivel('551133334444')).toBe('(11) 3333-4444');
    expect(telefoneLegivel('14155550100')).toBe('+14155550100');
    expect(telefoneLegivel(null)).toBeNull();
  });

  it('atalho: sem barra, minúsculas, sem espaços, até 40', () => {
    expect(normalizarAtalho(' /Boas-Vindas ')).toBe('boas-vindas');
    expect(FORMATO_DO_ATALHO.test('boas-vindas')).toBe(true);
    expect(FORMATO_DO_ATALHO.test('boas vindas')).toBe(false);
    expect(FORMATO_DO_ATALHO.test('a/b')).toBe(false);
    expect(FORMATO_DO_ATALHO.test('a'.repeat(41))).toBe(false);
  });
});
