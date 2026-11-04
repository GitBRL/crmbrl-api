import {
  aplicarMapeamento,
  lerCaminho,
  segmentosDoCaminho,
  validarMapeamento,
} from './mapeamento';
import { resumir } from './processamento-entrada.service';

describe('Mapeamento — atualizações e formulário aninhado (R32.2, R32.4)', () => {
  it('R32.2 — caminhos com colchetes de formulário valem como pontos', () => {
    expect(segmentosDoCaminho('contact[fields][3]')).toEqual([
      'contact',
      'fields',
      '3',
    ]);
    expect(segmentosDoCaminho('lead.contatos[0].email')).toEqual([
      'lead',
      'contatos',
      '0',
      'email',
    ]);
    const corpo = { contact: { fields: { '3': 'Natal' } }, itens: [{ a: 1 }] };
    expect(lerCaminho(corpo, 'contact[fields][3]')).toBe('Natal');
    expect(lerCaminho(corpo, 'contact.fields.3')).toBe('Natal');
    expect(lerCaminho(corpo, 'itens[0].a')).toBe(1);
  });

  it('R32.4 — etapa, dono, status e motivoPerda são destinos aceitos e vêm como texto', () => {
    const validacao = validarMapeamento({
      campos: [
        { caminho: 'nome', destino: 'nome' },
        { caminho: 'email', destino: 'email' },
        { caminho: 'etapa', destino: 'etapa' },
        { caminho: 'vendedor', destino: 'dono' },
        { caminho: 'situacao', destino: 'status' },
        { caminho: 'motivo', destino: 'motivoPerda' },
        { caminho: 'plano', destino: 'negocio.camposPersonalizados.plano' },
      ],
    });
    expect(validacao.valido).toBe(true);
    if (!validacao.valido) {
      return;
    }
    const lead = aplicarMapeamento(validacao.mapeamento, {
      nome: 'Ana',
      email: 'ana@x.com',
      etapa: 3,
      vendedor: 'ana.vendas',
      situacao: 'won',
      motivo: 'Preço',
      plano: 'Pro',
    });
    expect(lead.problemas).toEqual([]);
    expect(lead.atualizacoes).toEqual({
      etapa: '3',
      dono: 'ana.vendas',
      status: 'won',
      motivoPerda: 'Preço',
    });
    expect(lead.camposDoNegocio).toEqual({ plano: 'Pro' });
  });

  it('R32.3 — no modo ATUALIZAR o nome não é obrigatório (mas e-mail ou telefone sim)', () => {
    const mapeamento = {
      campos: [{ caminho: 'email', destino: 'email' }],
      ignorarQuando: [],
    };
    expect(validarMapeamento(mapeamento).valido).toBe(false);
    expect(
      validarMapeamento(mapeamento, 'mapeamento', { exigirNome: false }).valido,
    ).toBe(true);
    const sem = aplicarMapeamento(mapeamento, { email: 'a@b.com' }, [], {
      exigirNome: false,
    });
    expect(sem.problemas).toEqual([]);
    expect(
      aplicarMapeamento(mapeamento, { email: 'a@b.com' }).problemas,
    ).toEqual([expect.stringMatching(/^Sem nome/) as string]);
    const semContato = aplicarMapeamento(
      { campos: [{ caminho: 'x', destino: 'etapa' }], ignorarQuando: [] },
      { x: 'Proposta' },
      [],
      { exigirNome: false },
    );
    expect(semContato.problemas[0]).toMatch(/^Sem e-mail nem telefone/);
  });
});

describe('Resumo do recebimento (R32.5, R32.6)', () => {
  const r = (
    indice: number,
    status: 'PROCESSADO' | 'IGNORADO' | 'ERRO',
    mensagem: string,
    avisos: string[] = [],
  ) => ({
    indice,
    rotulo: `lead ${indice + 1} de 3`,
    status,
    mensagem,
    contatoId: status === 'PROCESSADO' ? `c${indice}` : null,
    negocioId: status === 'PROCESSADO' ? `n${indice}` : null,
    avisos,
  });

  it('R32.6 — um item só: o resultado dele, com a mesma mensagem de sempre', () => {
    expect(
      resumir(
        [
          r(0, 'PROCESSADO', 'Contato "Ana" criado.', [
            'Etapa "X" não existe.',
          ]),
        ],
        1,
      ),
    ).toMatchObject({
      status: 'PROCESSADO',
      mensagem: 'Contato "Ana" criado.',
      contatoId: 'c0',
      avisos: ['Etapa "X" não existe.'],
    });
  });

  it('R32.6 — vários leads: ERRO se algum falhou, com a contagem, os motivos e os avisos por lead', () => {
    const resumo = resumir(
      [
        r(0, 'PROCESSADO', 'ok', ['Dono "x" não encontrado.']),
        r(1, 'ERRO', 'Sem nome.'),
        r(2, 'IGNORADO', 'Teste.'),
      ],
      3,
    );
    expect(resumo.status).toBe('ERRO');
    expect(resumo.mensagem).toBe(
      '3 itens: 1 processado(s), 1 ignorado(s), 1 com erro. lead 2 de 3: Sem nome. lead 3 de 3: Teste.',
    );
    expect(resumo.contatoId).toBe('c0');
    expect(resumo.avisos).toEqual(['lead 1 de 3: Dono "x" não encontrado.']);
  });

  it('R32.6 — todos processados ou ignorados, e corpo sem itens', () => {
    expect(
      resumir([r(0, 'PROCESSADO', 'a'), r(1, 'PROCESSADO', 'b')], 2).status,
    ).toBe('PROCESSADO');
    expect(
      resumir([r(0, 'IGNORADO', 'a'), r(1, 'IGNORADO', 'b')], 2).status,
    ).toBe('IGNORADO');
    expect(resumir([], 0)).toMatchObject({
      status: 'IGNORADO',
      contatoId: null,
    });
  });
});
