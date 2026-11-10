import { papelESetor as comPapel } from '../comum/dominio/papeis-antigos.apoio-spec';
import { escolherNaFila, participantesDaFila } from './distribuicao-fila';

const pessoa = (
  id: string,
  minuto: number,
  papel: 'COMERCIAL' | 'LIDER_COMERCIAL' | 'CS',
  acesso: 'ativo' | 'convite' | 'primeiro' = 'ativo',
) => ({
  id,
  nome: id,
  ...comPapel(papel),
  avatarUrl: null,
  criadoEm: new Date(Date.UTC(2026, 9, 1, 12, minuto)),
  acessoAtivadoEm: acesso === 'ativo' ? new Date() : null,
  senhaHash: acesso === 'convite' ? null : 'scrypt$hash',
});

describe('distribuição pela fila (R12)', () => {
  const lider = pessoa('lider', 0, 'LIDER_COMERCIAL');
  const ana = pessoa('ana', 1, 'COMERCIAL');
  const bia = pessoa('bia', 2, 'COMERCIAL');
  const caio = pessoa('caio', 3, 'COMERCIAL', 'convite');
  const davi = pessoa('davi', 4, 'COMERCIAL', 'primeiro');
  const ester = pessoa('ester', 5, 'CS');
  const todos = [davi, caio, bia, ana, lider, ester];

  it('sem lista: os membros ativos da área que já ativaram o acesso, em ordem', () => {
    const resultado = participantesDaFila('COMERCIAL', todos, []);
    expect(resultado.modo).toBe('AREA');
    expect(resultado.elegiveis.map((u) => u.id)).toEqual(['ana', 'bia']);
    expect(
      resultado.pessoas.map((p) => [p.usuario.id, p.participa, p.motivo]),
    ).toEqual([
      ['lider', false, 'LIDER'],
      ['ana', true, 'AREA'],
      ['bia', true, 'AREA'],
      ['caio', false, 'CONVITE_PENDENTE'],
      ['davi', false, 'PRIMEIRO_ACESSO_PENDENTE'],
    ]);
  });

  it('sem lista, quem foi retirado à mão fica fora', () => {
    const resultado = participantesDaFila('COMERCIAL', todos, [
      { usuarioId: 'bia', participa: false },
    ]);
    expect(resultado.modo).toBe('AREA');
    expect(resultado.elegiveis.map((u) => u.id)).toEqual(['ana']);
    expect(resultado.pessoas.find((p) => p.usuario.id === 'bia')?.motivo).toBe(
      'RETIRADO',
    );
  });

  it('com lista: só quem está nela (o líder pode entrar); acesso ainda vale', () => {
    const resultado = participantesDaFila('COMERCIAL', todos, [
      { usuarioId: 'lider', participa: true },
      { usuarioId: 'caio', participa: true },
      { usuarioId: 'ana', participa: false },
    ]);
    expect(resultado.modo).toBe('LISTA');
    expect(resultado.elegiveis.map((u) => u.id)).toEqual(['lider']);
    expect(
      Object.fromEntries(
        resultado.pessoas.map((p) => [p.usuario.id, p.motivo]),
      ),
    ).toEqual({
      lider: 'NA_LISTA',
      ana: 'FORA_DA_LISTA',
      bia: 'FORA_DA_LISTA',
      caio: 'CONVITE_PENDENTE',
      davi: 'FORA_DA_LISTA',
    });
  });

  it('RODIZIO alterna a partir do ponteiro; MANUAL e sem elegíveis: ninguém', () => {
    const elegiveis = [bia, ana];
    expect(escolherNaFila('RODIZIO', elegiveis, null)?.id).toBe('ana');
    expect(escolherNaFila('RODIZIO', elegiveis, ana)?.id).toBe('bia');
    expect(escolherNaFila('RODIZIO', elegiveis, bia)?.id).toBe('ana');
    expect(escolherNaFila('MANUAL', elegiveis, null)).toBeNull();
    expect(escolherNaFila('RODIZIO', [], null)).toBeNull();
  });

  it('MENOR_CARGA escolhe quem tem menos em aberto; empate segue o rodízio', () => {
    const cargas = new Map([
      ['ana', 3],
      ['bia', 1],
    ]);
    expect(escolherNaFila('MENOR_CARGA', [ana, bia], null, cargas)?.id).toBe(
      'bia',
    );
    const empate = new Map([
      ['ana', 2],
      ['bia', 2],
    ]);
    expect(escolherNaFila('MENOR_CARGA', [ana, bia], ana, empate)?.id).toBe(
      'bia',
    );
    // Sem carga conhecida conta como zero.
    expect(escolherNaFila('MENOR_CARGA', [ana, bia], null, cargas)?.id).toBe(
      'bia',
    );
    expect(
      escolherNaFila('MENOR_CARGA', [ana, bia], null, new Map([['ana', 1]]))
        ?.id,
    ).toBe('bia');
  });
});
