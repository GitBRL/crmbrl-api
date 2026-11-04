import {
  acharEtapa,
  etapaPelaVariavel,
  lerStatus,
  normalizarNome,
  statusDoTipo,
} from './atualizacoes';

const etapas = [
  { id: 'e1', nome: 'Novo lead', tipo: 'ABERTA' as const },
  { id: 'e2', nome: 'Qualificação', tipo: 'ABERTA' as const },
  { id: 'e3', nome: 'Proposta enviada', tipo: 'ABERTA' as const },
  { id: 'e4', nome: 'Ganho', tipo: 'GANHO' as const },
  { id: 'e5', nome: 'Perdido', tipo: 'PERDIDO' as const },
];

describe('Atualizações pelo recebimento (R32.4)', () => {
  it('R32.4 — normaliza nomes sem acento, maiúsculas nem espaços repetidos', () => {
    expect(normalizarNome('  QUALIFICAÇÃO   da  Venda ')).toBe(
      'qualificacao da venda',
    );
  });

  it('R32.4 — etapa por nome (sem diferenciar maiúsculas e acentos) ou posição de 1 a n', () => {
    expect(acharEtapa(etapas, 'qualificacao')?.id).toBe('e2');
    expect(acharEtapa(etapas, ' PROPOSTA   ENVIADA ')?.id).toBe('e3');
    expect(acharEtapa(etapas, '1')?.id).toBe('e1');
    expect(acharEtapa(etapas, '5')?.id).toBe('e5');
    expect(acharEtapa(etapas, '0')).toBeNull();
    expect(acharEtapa(etapas, '6')).toBeNull();
    expect(acharEtapa(etapas, 'Inexistente')).toBeNull();
    expect(acharEtapa(etapas, '')).toBeNull();
  });

  it('R32.4 — o nome vale antes da posição (etapa chamada "2")', () => {
    const lista = [
      { id: 'a', nome: 'Primeira', tipo: 'ABERTA' as const },
      { id: 'b', nome: '1', tipo: 'ABERTA' as const },
    ];
    expect(acharEtapa(lista, '1')?.id).toBe('b');
    expect(acharEtapa(lista, '2')?.id).toBe('b');
  });

  it('R32.4 — status: aberto, ganho, perdido e também open, won, lost', () => {
    expect(lerStatus('Aberto')).toBe('ABERTO');
    expect(lerStatus('open')).toBe('ABERTO');
    expect(lerStatus(' GANHO ')).toBe('GANHO');
    expect(lerStatus('won')).toBe('GANHO');
    expect(lerStatus('Perdido')).toBe('PERDIDO');
    expect(lerStatus('lost')).toBe('PERDIDO');
    expect(lerStatus('talvez')).toBeNull();
    expect(statusDoTipo('GANHO')).toBe('GANHO');
    expect(statusDoTipo('ABERTA')).toBe('ABERTO');
  });

  it('R32.8 — Typeform: variável com o nome da etapa e valor ligado pede a etapa', () => {
    expect(
      etapaPelaVariavel(etapas, { score: 0, qualificacao: 1, Ganho: 0 })?.id,
    ).toBe('e2');
    expect(etapaPelaVariavel(etapas, { 'PROPOSTA ENVIADA': 'sim' })?.id).toBe(
      'e3',
    );
    expect(
      etapaPelaVariavel(etapas, { Ganho: 0, 'Novo lead': '0' }),
    ).toBeNull();
    expect(etapaPelaVariavel(etapas, { score: 10 })).toBeNull();
  });
});
