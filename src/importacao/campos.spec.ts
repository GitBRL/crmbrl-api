import {
  aplicarModeloDeMapeamento,
  campoValido,
  chaveDeCampoPersonalizado,
  normalizarColuna,
  sugerirMapeamento,
  validarMapeamento,
  camposDoTipo,
  grupoDoCampo,
} from './campos';

describe('Mapeamento de colunas (R16.3)', () => {
  it('R16.3 — normaliza o nome da coluna sem acento nem caixa', () => {
    expect(normalizarColuna('  E-MAIL ')).toBe('e mail');
    expect(normalizarColuna('Função')).toBe('funcao');
  });

  it('R16.3 — sugere campos pelos nomes das colunas, cada campo uma vez', () => {
    expect(
      sugerirMapeamento('CONTATOS', [
        'Nome',
        'E-mail',
        'Celular',
        'Whatsapp',
        'Cidade',
        'Empresa',
      ]),
    ).toEqual({
      Nome: 'nome',
      'E-mail': 'email',
      Celular: 'telefone',
      Empresa: 'empresa',
    });
  });

  it('R16.3 — empresas sugerem CNPJ, UF e segmento', () => {
    expect(
      sugerirMapeamento('EMPRESAS', [
        'Razão Social',
        'CNPJ',
        'Estado',
        'Setor',
      ]),
    ).toEqual({
      'Razão Social': 'nome',
      CNPJ: 'cnpj',
      Estado: 'uf',
      Setor: 'segmento',
    });
  });

  it('R16.3 — o modelo salvo se aplica às colunas do arquivo sem acento nem caixa', () => {
    expect(
      aplicarModeloDeMapeamento(
        { 'E-mail': 'email', TELEFONE: 'telefone', Outra: 'campos.x' },
        ['e-mail', 'Telefone', 'Nome'],
      ),
    ).toEqual({ 'e-mail': 'email', Telefone: 'telefone' });
  });

  it('R16.3 — campos personalizados: chave em minúsculas, números e _', () => {
    expect(campoValido('CONTATOS', 'campos.cidade_2')).toBe(true);
    expect(campoValido('CONTATOS', 'campos.Cidade')).toBe(false);
    expect(campoValido('CONTATOS', 'cnpj')).toBe(false);
    expect(campoValido('EMPRESAS', 'cnpj')).toBe(true);
    expect(chaveDeCampoPersonalizado('Data de Nascimento')).toBe(
      'data_de_nascimento',
    );
    expect(chaveDeCampoPersonalizado('2025 meta')).toBe('c_2025_meta');
  });

  it('R16.3 — recusa coluna inexistente, campo inválido e campo repetido', () => {
    const problemas = validarMapeamento(
      'CONTATOS',
      ['A', 'B', 'C'],
      { A: 'email', B: 'email', C: 'inventado', Z: 'nome' },
      false,
    );
    expect(problemas.map((p) => p.campo)).toEqual(['B', 'C', 'Z']);
  });

  it('R16.3 — para importar, contatos precisam de nome e de e-mail ou telefone', () => {
    expect(
      validarMapeamento('CONTATOS', ['A'], { A: 'nome' }, true),
    ).toHaveLength(1);
    expect(
      validarMapeamento(
        'CONTATOS',
        ['A', 'B'],
        { A: 'nome', B: 'telefone' },
        true,
      ),
    ).toEqual([]);
    expect(validarMapeamento('EMPRESAS', ['A'], { A: 'nome' }, true)).toEqual(
      [],
    );
    expect(
      validarMapeamento('EMPRESAS', ['A'], { A: 'cnpj' }, true),
    ).toHaveLength(1);
  });

  it('R16.12 — sinônimos de funil, etapa, responsável, valor e título do negócio', () => {
    expect(
      sugerirMapeamento('CONTATOS', [
        'Nome',
        'E-mail',
        'Pipeline',
        'Fase',
        'Vendedor',
        'Valor',
        'Oportunidade',
      ]),
    ).toEqual({
      Nome: 'nome',
      'E-mail': 'email',
      Pipeline: 'negocio.funil',
      Fase: 'negocio.etapa',
      Vendedor: 'responsavel',
      Valor: 'negocio.valor',
      Oportunidade: 'negocio.titulo',
    });
    const m = sugerirMapeamento('CONTATOS', [
      'Funil',
      'Estágio',
      'Atendente',
      'Dono',
    ]);
    expect(m).toEqual({
      Funil: 'negocio.funil',
      Estágio: 'negocio.etapa',
      Atendente: 'responsavel',
    });
  });

  it('R16.12 — campos de negócio só existem para contatos e têm grupo', () => {
    expect(campoValido('CONTATOS', 'negocio.valorRecorrente')).toBe(true);
    expect(campoValido('EMPRESAS', 'negocio.funil')).toBe(false);
    const campos = camposDoTipo('CONTATOS');
    expect(
      grupoDoCampo(
        'CONTATOS',
        campos.find((c) => c.chave === 'negocio.funil')!,
      ),
    ).toBe('Negócio');
    expect(
      grupoDoCampo(
        'CONTATOS',
        campos.find((c) => c.chave === 'nome')!,
      ),
    ).toBe('Contato');
    expect(grupoDoCampo('EMPRESAS', camposDoTipo('EMPRESAS')[0])).toBe(
      'Empresa',
    );
    expect(grupoDoCampo('PARCELAS', camposDoTipo('PARCELAS')[0])).toBe(
      'Parcela',
    );
  });
});
