import {
  compararNoRodizio,
  motivoSemAcessoAtivado,
  ordenarParaRodizio,
  proximoDoRodizio,
} from './rodizio';

const pessoa = (id: string, minuto: number) => ({
  id,
  criadoEm: new Date(Date.UTC(2026, 9, 1, 12, minuto)),
});

describe('rodízio (R5.8)', () => {
  const ana = pessoa('a0000000-0000-4000-8000-000000000001', 1);
  const bia = pessoa('b0000000-0000-4000-8000-000000000002', 2);
  const caio = pessoa('c0000000-0000-4000-8000-000000000003', 3);

  it('ordem estável: quem entrou primeiro; no empate, o id', () => {
    const gemeo = pessoa('00000000-0000-4000-8000-000000000009', 2);
    expect(
      ordenarParaRodizio([caio, bia, ana, gemeo]).map((p) => p.id),
    ).toEqual([ana.id, gemeo.id, bia.id, caio.id]);
    expect(compararNoRodizio(ana, ana)).toBe(0);
  });

  it('R5.8 — alterna em ordem e volta ao começo', () => {
    const todos = [caio, ana, bia];
    type Pessoa = ReturnType<typeof pessoa>;
    let ponteiro: Pessoa | null = null;
    const escolhidos: string[] = [];
    for (let i = 0; i < 7; i++) {
      const proximo: Pessoa | null = proximoDoRodizio(todos, ponteiro);
      escolhidos.push(proximo?.id ?? '');
      ponteiro = proximo;
    }
    expect(escolhidos).toEqual([
      ana.id,
      bia.id,
      caio.id,
      ana.id,
      bia.id,
      caio.id,
      ana.id,
    ]);
  });

  it('R5.8 — quem saiu do rodízio não trava a fila: segue do lugar dele', () => {
    expect(proximoDoRodizio([ana, caio], bia)).toBe(caio);
    expect(proximoDoRodizio([ana, bia], caio)).toBe(ana);
  });

  it('sem candidatos, ninguém (o serviço cai para o líder ou o C-level)', () => {
    expect(proximoDoRodizio([], ana)).toBeNull();
    expect(proximoDoRodizio([], null)).toBeNull();
  });
});

describe('rodízio — só quem já ativou o acesso (ajuste da R5.8)', () => {
  const ontem = new Date(Date.UTC(2026, 9, 21, 12));

  it('convite pendente (sem senha) fica fora', () => {
    expect(
      motivoSemAcessoAtivado({ acessoAtivadoEm: null, senhaHash: null }),
    ).toBe('CONVITE_PENDENTE');
  });

  it('senha temporária ainda não trocada no primeiro login fica fora', () => {
    expect(
      motivoSemAcessoAtivado({ acessoAtivadoEm: null, senhaHash: 'scrypt$…' }),
    ).toBe('PRIMEIRO_ACESSO_PENDENTE');
  });

  it('com o acesso ativado (marcado pelo banco), participa', () => {
    expect(
      motivoSemAcessoAtivado({ acessoAtivadoEm: ontem, senhaHash: 'scrypt$…' }),
    ).toBeNull();
  });
});
