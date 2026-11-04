import {
  caminhosDoItem,
  consolidarCampos,
  mascararExemplo,
} from './campos-recebidos';

describe('Campos recebidos (R32.7)', () => {
  it('R32.7 — mascara e-mail, telefone, valores longos e campos sensíveis', () => {
    expect(mascararExemplo('email', 'maria@empresa.com.br')).toBe(
      'ma•••@empresa.com.br',
    );
    expect(mascararExemplo('phone', '(11) 98765-4321')).toBe('•••••••4321');
    expect(mascararExemplo('nome', 'Maria Souza')).toBe('Mar•••');
    expect(mascararExemplo('utm_source', 'google')).toBe('goo•••');
    expect(mascararExemplo('senha', 'abc123')).toBe('••••');
    expect(mascararExemplo('flag', true)).toBe('true');
    expect(mascararExemplo('vazio', '   ')).toBeNull();
    expect(mascararExemplo('n', 12)).toBe('12');
  });

  it('R32.7 — lista os caminhos de folha (objetos aninhados, listas de objetos e de textos)', () => {
    const caminhos = caminhosDoItem({
      contact: { email: 'a@b.com', fields: { '3': 'Natal' } },
      tags: ['x', 'y'],
      leads: [{ nome: 'A' }, { nome: 'B' }],
    }).map(({ caminho }) => caminho);
    expect(caminhos).toEqual([
      'contact.email',
      'contact.fields.3',
      'tags',
      'leads[0].nome',
      'leads[1].nome',
    ]);
  });

  it('R32.7 — consolida vários itens: contagem, tipo e exemplo mascarado do primeiro valor', () => {
    const campos = consolidarCampos([
      { email: 'ana@x.com', valor: 10, ativo: true },
      { email: 'beto@x.com', cidade: 'Natal' },
    ]);
    expect(campos).toEqual([
      {
        caminho: 'email',
        tipo: 'texto',
        exemplo: 'an•••@x.com',
        ocorrencias: 2,
      },
      { caminho: 'valor', tipo: 'numero', exemplo: '10', ocorrencias: 1 },
      { caminho: 'ativo', tipo: 'booleano', exemplo: 'true', ocorrencias: 1 },
      { caminho: 'cidade', tipo: 'texto', exemplo: 'Nat•••', ocorrencias: 1 },
    ]);
  });
});
