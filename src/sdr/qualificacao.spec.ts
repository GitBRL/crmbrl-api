import {
  avaliarQualificacao,
  type CriterioDoMotor,
  formatarValor,
  interpretarTurno,
  interpretarValor,
  normalizarChave,
  temperaturaDaNota,
  type ValorDescoberto,
} from './qualificacao';

function criterio(
  parcial: Partial<CriterioDoMotor> & { chave: string },
): CriterioDoMotor {
  return {
    rotulo: parcial.chave,
    instrucao: 'descubra',
    tipo: 'TEXTO',
    opcoes: [],
    alvo: 'NENHUM',
    campo: null,
    peso: 10,
    obrigatorio: false,
    ...parcial,
  };
}

const PARAMETROS = {
  notaMinima: 60,
  faixas: { quente: 70, morno: 40 },
  confiancaMinima: 0.4,
};

const CRITERIOS = [
  criterio({ chave: 'curso', peso: 40, obrigatorio: true }),
  criterio({
    chave: 'modalidade',
    peso: 30,
    obrigatorio: true,
    tipo: 'OPCAO',
    opcoes: ['Presencial', 'EAD'],
  }),
  criterio({ chave: 'cidade', peso: 30 }),
];

function valores(...itens: ValorDescoberto[]): Map<string, ValorDescoberto> {
  return new Map(itens.map((i) => [i.chave, i]));
}

describe('Qualificação do SDR (R31)', () => {
  describe('interpretarValor', () => {
    it('R31.4 — texto vazio é recusado e texto comprido é cortado', () => {
      expect(interpretarValor({ tipo: 'TEXTO', opcoes: [] }, '  ')).toEqual({
        ok: false,
        motivo: 'valor vazio',
      });
      const r = interpretarValor(
        { tipo: 'TEXTO', opcoes: [] },
        'a'.repeat(500),
      );
      expect(r.ok && String(r.valor).length).toBe(300);
    });

    it('R31.4 — opção ignora caixa e acento e devolve a opção cadastrada', () => {
      const c = { tipo: 'OPCAO' as const, opcoes: ['Híbrido', 'EAD'] };
      expect(interpretarValor(c, 'hibrido')).toEqual({
        ok: true,
        valor: 'Híbrido',
      });
      expect(interpretarValor(c, 'ead')).toEqual({ ok: true, valor: 'EAD' });
      expect(interpretarValor(c, 'presencial').ok).toBe(false);
    });

    it('R31.4 — número aceita formato brasileiro', () => {
      const c = { tipo: 'NUMERO' as const, opcoes: [] };
      expect(interpretarValor(c, 'R$ 1.500,50')).toEqual({
        ok: true,
        valor: 1500.5,
      });
      expect(interpretarValor(c, '1.500')).toEqual({ ok: true, valor: 1500 });
      expect(interpretarValor(c, '12')).toEqual({ ok: true, valor: 12 });
      expect(interpretarValor(c, 'muito').ok).toBe(false);
    });

    it('R31.4 — data aceita AAAA-MM-DD e dd/mm/aaaa e recusa data impossível', () => {
      const c = { tipo: 'DATA' as const, opcoes: [] };
      expect(interpretarValor(c, '2027-02-01')).toEqual({
        ok: true,
        valor: '2027-02-01',
      });
      expect(interpretarValor(c, '3/2/2027')).toEqual({
        ok: true,
        valor: '2027-02-03',
      });
      expect(interpretarValor(c, '2027-02-30').ok).toBe(false);
      expect(interpretarValor(c, 'ano que vem').ok).toBe(false);
    });

    it('R31.4 — sim/não vira booleano', () => {
      const c = { tipo: 'SIM_NAO' as const, opcoes: [] };
      expect(interpretarValor(c, 'Sim')).toEqual({ ok: true, valor: true });
      expect(interpretarValor(c, 'não')).toEqual({ ok: true, valor: false });
      expect(interpretarValor(c, 'talvez').ok).toBe(false);
    });
  });

  it('R31.4 — chave normalizada: minúsculas, sem acento, com _', () => {
    expect(normalizarChave(' Forma de Pagamento ')).toBe('forma_de_pagamento');
    expect(normalizarChave('Início')).toBe('inicio');
  });

  it('R31.4 — valor formatado para a tela e para a nota', () => {
    expect(formatarValor({ tipo: 'DATA' }, '2027-02-01')).toBe('01/02/2027');
    expect(formatarValor({ tipo: 'SIM_NAO' }, true)).toBe('Sim');
    expect(formatarValor({ tipo: 'NUMERO' }, 12)).toBe('12');
  });

  describe('nota, temperatura e qualificado', () => {
    it('R31.4 — nota pelos pesos dos critérios descobertos com confiança suficiente', () => {
      const a = avaliarQualificacao(
        CRITERIOS,
        valores(
          { chave: 'curso', valor: 'Enfermagem', confianca: 0.9 },
          { chave: 'cidade', valor: 'Recife', confianca: 0.3 },
        ),
        PARAMETROS,
      );
      // cidade (0,3) fica abaixo da confiança mínima (0,4): só o curso vale.
      expect(a.nota).toBe(40);
      expect(a.temperatura).toBe('MORNO');
      expect(a.faltamObrigatorios).toEqual(['modalidade']);
      expect(a.qualificado).toBe(false);
    });

    it('R31.4 — faixas: quente, morno e frio', () => {
      const f = PARAMETROS.faixas;
      expect(temperaturaDaNota(70, f)).toBe('QUENTE');
      expect(temperaturaDaNota(69, f)).toBe('MORNO');
      expect(temperaturaDaNota(40, f)).toBe('MORNO');
      expect(temperaturaDaNota(39, f)).toBe('FRIO');
    });

    it('R31.4 — qualificado exige os obrigatórios e a nota mínima', () => {
      const todos = valores(
        { chave: 'curso', valor: 'Enfermagem', confianca: 0.9 },
        { chave: 'modalidade', valor: 'EAD', confianca: 0.8 },
      );
      expect(avaliarQualificacao(CRITERIOS, todos, PARAMETROS)).toMatchObject({
        nota: 70,
        temperatura: 'QUENTE',
        qualificado: true,
      });
      // Nota mínima mais alta que a nota obtida.
      expect(
        avaliarQualificacao(CRITERIOS, todos, { ...PARAMETROS, notaMinima: 80 })
          .qualificado,
      ).toBe(false);
    });

    it('R31.4 — sem critérios configurados nunca qualifica', () => {
      expect(avaliarQualificacao([], new Map(), PARAMETROS).qualificado).toBe(
        false,
      );
    });
  });

  describe('interpretarTurno', () => {
    it('R31.4 — aceita o que é válido e recusa o resto, com o motivo', () => {
      const r = interpretarTurno({
        criterios: CRITERIOS,
        anteriores: new Map(),
        daIa: [
          { chave: 'curso', valor: 'Enfermagem', confianca: 0.9 },
          { chave: 'modalidade', valor: 'noturno', confianca: 0.9 },
          { chave: 'cidade', valor: 'Recife', confianca: 0.1 },
          { chave: 'inventada', valor: 'x', confianca: 1 },
        ],
        acao: 'CONTINUAR',
        parametros: PARAMETROS,
      });
      expect(r.aceitos.map((a) => a.chave)).toEqual(['curso']);
      expect(r.recusados).toEqual([
        { chave: 'modalidade', motivo: 'fora das opções do critério' },
        { chave: 'cidade', motivo: 'confiança baixa' },
        { chave: 'inventada', motivo: 'critério desconhecido' },
      ]);
      expect(r.semAvanco).toBe(false);
    });

    it('R31.4 — qualificado sem os obrigatórios volta a continuar, com o motivo', () => {
      const r = interpretarTurno({
        criterios: CRITERIOS,
        anteriores: new Map(),
        daIa: [{ chave: 'curso', valor: 'Enfermagem', confianca: 0.9 }],
        acao: 'QUALIFICADO',
        parametros: PARAMETROS,
      });
      expect(r.acao).toBe('CONTINUAR');
      expect(r.motivoDaTroca).toContain('modalidade');
    });

    it('R31.4 — qualificado com tudo em dia se mantém', () => {
      const r = interpretarTurno({
        criterios: CRITERIOS,
        anteriores: valores({
          chave: 'curso',
          valor: 'Enfermagem',
          confianca: 0.9,
        }),
        daIa: [{ chave: 'modalidade', valor: 'ead', confianca: 0.9 }],
        acao: 'QUALIFICADO',
        parametros: PARAMETROS,
      });
      expect(r.acao).toBe('QUALIFICADO');
      expect(r.motivoDaTroca).toBeNull();
      expect(r.valores.get('modalidade')?.valor).toBe('EAD');
    });

    it('R31.4 — repetir o mesmo valor não é avanço; corrigir o valor é', () => {
      const anteriores = valores({
        chave: 'curso',
        valor: 'Enfermagem',
        confianca: 0.9,
      });
      const igual = interpretarTurno({
        criterios: CRITERIOS,
        anteriores,
        daIa: [{ chave: 'curso', valor: 'Enfermagem', confianca: 0.9 }],
        acao: 'CONTINUAR',
        parametros: PARAMETROS,
      });
      expect(igual.semAvanco).toBe(true);
      const corrigido = interpretarTurno({
        criterios: CRITERIOS,
        anteriores,
        daIa: [{ chave: 'curso', valor: 'Direito', confianca: 0.9 }],
        acao: 'CONTINUAR',
        parametros: PARAMETROS,
      });
      expect(corrigido.aceitos).toHaveLength(1);
      expect(corrigido.valores.get('curso')?.valor).toBe('Direito');
    });

    it('R31.4 — a confiança é limitada a 0–1', () => {
      const r = interpretarTurno({
        criterios: CRITERIOS,
        anteriores: new Map(),
        daIa: [{ chave: 'cidade', valor: 'Recife', confianca: 7 }],
        acao: 'CONTINUAR',
        parametros: PARAMETROS,
      });
      expect(r.aceitos[0].confianca).toBe(1);
    });
  });
});
