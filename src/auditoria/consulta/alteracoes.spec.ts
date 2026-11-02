import { calcularAlteracoes } from '../../comum/dados/sanitizar';
import { extrairAlteracoes, lerRelacionados } from './alteracoes';

describe('alteracoes', () => {
  it('R3.4 — lê o diff no formato da base (calcularAlteracoes)', () => {
    const dados = {
      alteracoes: calcularAlteracoes(
        { titulo: 'ACME', valor: 10, senha: 'a', etapa: 'Proposta' },
        { titulo: 'ACME 2', valor: 10, senha: 'b', etapa: 'Negociação' },
      ),
    };
    // Em ordem alfabética: o jsonb não guarda a ordem das chaves.
    expect(extrairAlteracoes(dados)).toEqual([
      { campo: 'etapa', antes: 'Proposta', depois: 'Negociação' },
      { campo: 'senha', antes: '[omitido]', depois: '[omitido]' },
      { campo: 'titulo', antes: 'ACME', depois: 'ACME 2' },
    ]);
  });

  it('R3.1 — campo sensível gravado como "[omitido]" pelo sanitizador continua no diff, sem valor', () => {
    expect(
      extrairAlteracoes({
        alteracoes: {
          nome: { antes: 'Ana', depois: 'Ana Souza' },
          senhaHash: '[omitido]',
        },
      }),
    ).toEqual([
      { campo: 'nome', antes: 'Ana', depois: 'Ana Souza' },
      { campo: 'senhaHash', antes: '[omitido]', depois: '[omitido]' },
    ]);
  });

  it('aceita também uma lista [{ campo, antes, depois }]', () => {
    expect(
      extrairAlteracoes({
        alteracoes: [
          { campo: 'nome', antes: 'Ana', depois: 'Ana Souza' },
          { campo: 'email', depois: 'ana@x.com' },
          { antes: 1, depois: 2 },
          'lixo',
        ],
      }),
    ).toEqual([
      { campo: 'nome', antes: 'Ana', depois: 'Ana Souza' },
      { campo: 'email', antes: null, depois: 'ana@x.com' },
    ]);
  });

  it('sem diff (ou num formato desconhecido) devolve lista vazia', () => {
    expect(extrairAlteracoes(null)).toEqual([]);
    expect(extrairAlteracoes(undefined)).toEqual([]);
    expect(extrairAlteracoes({ contagens: { negocios: 2 } })).toEqual([]);
    expect(extrairAlteracoes({ alteracoes: 'texto' })).toEqual([]);
    expect(extrairAlteracoes({ alteracoes: { campo: 3 } })).toEqual([]);
    expect(extrairAlteracoes([1, 2])).toEqual([]);
  });

  it('separa as referências relacionadas em entidade e id', () => {
    expect(
      lerRelacionados([
        'contato:6f1c2b0e-8a3d-4c55-9a51-2d8f8d7c1e10',
        'regra_distribuicao:abc:def',
        'sem-separador',
        ':sem-entidade',
        'sem-id:',
      ]),
    ).toEqual([
      { entidade: 'contato', id: '6f1c2b0e-8a3d-4c55-9a51-2d8f8d7c1e10' },
      { entidade: 'regra_distribuicao', id: 'abc:def' },
    ]);
  });
});
