import { DadosInvalidosException } from '../comum/erros/excecoes';
import { type Contato, Prisma } from '../generated/prisma/client';
import {
  anonimizarTexto,
  dadosDaAnonimizacao,
  termosPessoais,
} from './anonimizacao';
import {
  digitosDaBusca,
  escaparLike,
  filtroDeBuscaDeContatos,
  filtroDeBuscaDeEmpresas,
} from './busca';
import {
  aplicarPatchDosCampos,
  type ContatoNormalizado,
  type EntradaDeContato,
  normalizarEntradaDeContato,
  planejarReconversao,
} from './deduplicacao';

const AGORA = new Date('2026-10-20T12:00:00.000Z');

function contatoExistente(dados: Partial<Contato> = {}): Contato {
  const criadoEm = new Date('2026-10-01T12:00:00.000Z');
  return {
    id: '00000000-0000-4000-8000-000000000001',
    nome: 'Maria Souza',
    email: 'maria@x.com',
    telefone: null,
    cargo: null,
    empresaId: null,
    responsavelId: null,
    primeiraOrigem: 'MANUAL',
    primeiraOrigemDetalhe: null,
    primeiraOrigemUtm: null,
    ultimaOrigem: 'MANUAL',
    ultimaOrigemDetalhe: null,
    ultimaOrigemUtm: null,
    ultimaOrigemEm: criadoEm,
    conversoes: 1,
    etiquetas: [],
    camposPersonalizados: {},
    optOutMarketing: false,
    optOutEm: null,
    consentimentoEm: null,
    consentimentoOrigem: null,
    criadoPorId: null,
    criadoEm,
    atualizadoEm: criadoEm,
    excluidoEm: null,
    ...dados,
  };
}

function entrada(dados: Partial<EntradaDeContato> = {}): ContatoNormalizado {
  return normalizarEntradaDeContato({
    nome: 'Maria',
    email: 'maria@x.com',
    origem: 'WEBHOOK',
    ...dados,
  });
}

function capturarErro(funcao: () => unknown): DadosInvalidosException {
  try {
    funcao();
  } catch (erro) {
    if (erro instanceof DadosInvalidosException) {
      return erro;
    }
    throw erro;
  }
  throw new Error('Era esperado um DadosInvalidosException.');
}

const LIVRE = {
  emailLivre: true,
  telefoneLivre: true,
  empresaId: null,
  responsavelId: null,
  agora: AGORA,
};

describe('normalizarEntradaDeContato (R4.1, R4.3, R4.7)', () => {
  it('R4.1 — e-mail em minúsculas e telefone em E.164 só com dígitos', () => {
    const dados = entrada({
      nome: '  Maria   Souza ',
      email: '  Maria.Souza@EMPRESA.com.br ',
      telefone: '(11) 98765-4321',
    });
    expect(dados).toMatchObject({
      nome: 'Maria Souza',
      email: 'maria.souza@empresa.com.br',
      telefone: '5511987654321',
      descartados: [],
    });
  });

  it('R4.1 — sem e-mail e sem telefone é recusado com a regra e os dois campos', () => {
    const erro = capturarErro(() =>
      entrada({ email: '  ', telefone: undefined }),
    );
    expect(erro.getStatus()).toBe(400);
    expect(erro.mensagem).toBe('O contato precisa de e-mail ou telefone.');
    expect(erro.detalhes).toMatchObject({
      regra: 'R4.1',
      campos: [
        { campo: 'email', mensagens: ['informe o e-mail ou o telefone'] },
        { campo: 'telefone', mensagens: ['informe o e-mail ou o telefone'] },
      ],
    });
  });

  it('R4.1 — nome obrigatório (espaços não contam)', () => {
    const erro = capturarErro(() => entrada({ nome: '   ' }));
    expect(erro.detalhes).toMatchObject({
      regra: 'R4.1',
      campos: [{ campo: 'nome', mensagens: ['é obrigatório'] }],
    });
  });

  it('R4.1 — telefone com DDD inexistente é recusado na entrada manual', () => {
    const erro = capturarErro(() => entrada({ telefone: '(20) 98765-4321' }));
    expect(erro.detalhes?.campos).toEqual([
      {
        campo: 'telefone',
        mensagens: ['deve ser um telefone válido (DDD 20 não existe)'],
      },
    ]);
  });

  it('automação (tolerante): meio de contato inválido é descartado se o outro for válido', () => {
    const dados = normalizarEntradaDeContato(
      {
        nome: 'Lead',
        email: 'nao-informado',
        telefone: '11 98765-4321',
        origem: 'WEBHOOK',
      },
      { tolerante: true },
    );
    expect(dados.email).toBeNull();
    expect(dados.telefone).toBe('5511987654321');
    expect(dados.descartados).toEqual([
      { campo: 'email', mensagens: ['deve ser um e-mail válido'] },
    ]);
  });

  it('automação (tolerante): sem nenhum meio de contato válido, recusa', () => {
    const erro = capturarErro(() =>
      normalizarEntradaDeContato(
        { nome: 'Lead', email: 'x', telefone: '123', origem: 'WEBHOOK' },
        { tolerante: true },
      ),
    );
    expect(erro.detalhes).toMatchObject({ regra: 'R4.1' });
    const campos = (erro.detalhes?.campos ?? []) as { campo: string }[];
    expect(campos.map(({ campo }) => campo)).toEqual(['email', 'telefone']);
  });

  it('R4.3/R4.7 — UTM só com as cinco chaves, etiquetas sem duplicatas e campos personalizados em JSON', () => {
    const dados = entrada({
      origemDetalhe: '  Landing   BF ',
      utm: { source: ' google ', medium: '', campaign: 'bf' },
      etiquetas: [' VIP ', 'vip', 'Lead  quente'],
      camposPersonalizados: { faturamento: '50 mil', '  ': 'x', data: AGORA },
    });
    expect(dados).toMatchObject({
      origemDetalhe: 'Landing BF',
      utm: { source: 'google', campaign: 'bf' },
      etiquetas: ['VIP', 'Lead quente'],
      camposPersonalizados: {
        faturamento: '50 mil',
        data: '2026-10-20T12:00:00.000Z',
      },
    });
  });

  it('recusa campos personalizados que não são objeto e origem desconhecida', () => {
    const erro = capturarErro(() =>
      normalizarEntradaDeContato({
        nome: 'Maria',
        email: 'maria@x.com',
        origem: 'FAX' as never,
        camposPersonalizados: ['a'] as never,
      }),
    );
    expect(erro.detalhes?.campos).toEqual([
      { campo: 'origem', mensagens: ['deve ser uma origem válida'] },
      { campo: 'camposPersonalizados', mensagens: ['deve ser um objeto'] },
    ]);
    expect(erro.detalhes?.regra).toBeUndefined();
  });
});

describe('planejarReconversao (R4.2, R4.3)', () => {
  it('R4.2 — completa só os campos vazios e não sobrescreve os preenchidos', () => {
    const existente = contatoExistente({ nome: 'Maria Souza', cargo: 'CEO' });
    const plano = planejarReconversao(
      existente,
      entrada({
        nome: 'Maria S.',
        email: 'maria@x.com',
        telefone: '11 98765-4321',
        cargo: 'Gerente',
      }),
      {
        ...LIVRE,
        empresaId: '00000000-0000-4000-8000-0000000000e1',
        responsavelId: '00000000-0000-4000-8000-0000000000a1',
      },
    );
    expect(plano.dados).toMatchObject({
      telefone: '5511987654321',
      empresaId: '00000000-0000-4000-8000-0000000000e1',
      responsavelId: '00000000-0000-4000-8000-0000000000a1',
    });
    expect(plano.dados).not.toHaveProperty('nome');
    expect(plano.dados).not.toHaveProperty('email');
    expect(plano.dados).not.toHaveProperty('cargo');
    expect(plano.camposCompletados).toEqual([
      'telefone',
      'empresaId',
      'responsavelId',
    ]);
  });

  it('R4.3 — troca a última origem (tipo, detalhe e UTM) e soma uma conversão; a primeira fica', () => {
    const plano = planejarReconversao(
      contatoExistente(),
      entrada({
        origem: 'WEBHOOK',
        origemDetalhe: 'Landing BF',
        utm: { source: 'google' },
      }),
      LIVRE,
    );
    expect(plano.dados).toEqual(
      expect.objectContaining({
        ultimaOrigem: 'WEBHOOK',
        ultimaOrigemDetalhe: 'Landing BF',
        ultimaOrigemUtm: { source: 'google' },
        ultimaOrigemEm: AGORA,
        conversoes: { increment: 1 },
      }),
    );
    for (const campo of [
      'primeiraOrigem',
      'primeiraOrigemDetalhe',
      'primeiraOrigemUtm',
    ]) {
      expect(plano.dados).not.toHaveProperty(campo);
    }
  });

  it('R4.3 — reconversão sem UTM limpa a UTM da última origem', () => {
    const plano = planejarReconversao(
      contatoExistente({ ultimaOrigemUtm: { source: 'antiga' } }),
      entrada({ origem: 'SITE' }),
      LIVRE,
    );
    expect(plano.dados.ultimaOrigemUtm).toBe(Prisma.DbNull);
    expect(plano.dados.ultimaOrigemDetalhe).toBeNull();
  });

  it('R4.2 — e-mail ou telefone que já são de outro contato não são copiados', () => {
    const plano = planejarReconversao(
      contatoExistente({ email: null, telefone: '5511987654321' }),
      entrada({ email: 'outra@x.com', telefone: '11 98765-4321' }),
      { ...LIVRE, emailLivre: false },
    );
    expect(plano.dados).not.toHaveProperty('email');
    expect(plano.camposCompletados).toEqual([]);
  });

  it('R4.7 — junta etiquetas sem duplicar e só acrescenta campos personalizados ausentes ou vazios', () => {
    const plano = planejarReconversao(
      contatoExistente({
        etiquetas: ['VIP'],
        camposPersonalizados: { faturamento: '10 mil', cidade: '' },
      }),
      entrada({
        etiquetas: ['vip', 'Black Friday'],
        camposPersonalizados: {
          faturamento: '99 mil',
          cidade: 'Recife',
          campanha: 'BF',
        },
      }),
      LIVRE,
    );
    expect(plano.dados.etiquetas).toEqual(['VIP', 'Black Friday']);
    expect(plano.dados.camposPersonalizados).toEqual({
      faturamento: '10 mil',
      cidade: 'Recife',
      campanha: 'BF',
    });
    expect(plano.camposCompletados).toEqual([
      'etiquetas',
      'camposPersonalizados.cidade',
      'camposPersonalizados.campanha',
    ]);
  });

  it('R4.6 — opt-out pedido agora vale; um opt-out existente nunca é desfeito', () => {
    const pedido = planejarReconversao(
      contatoExistente(),
      entrada({ optOutMarketing: true }),
      LIVRE,
    );
    expect(pedido.dados).toMatchObject({
      optOutMarketing: true,
      optOutEm: AGORA,
    });
    const existente = planejarReconversao(
      contatoExistente({ optOutMarketing: true, optOutEm: AGORA }),
      entrada({ optOutMarketing: false }),
      LIVRE,
    );
    expect(existente.dados).not.toHaveProperty('optOutMarketing');
  });

  it('R4.6 — consentimento só preenche quando o contato não tem um', () => {
    const consentimento = { em: AGORA, origem: 'Formulário' };
    expect(
      planejarReconversao(contatoExistente(), entrada({ consentimento }), LIVRE)
        .dados,
    ).toMatchObject({
      consentimentoEm: AGORA,
      consentimentoOrigem: 'Formulário',
    });
    expect(
      planejarReconversao(
        contatoExistente({ consentimentoOrigem: 'Evento' }),
        entrada({ consentimento }),
        LIVRE,
      ).dados,
    ).not.toHaveProperty('consentimentoOrigem');
  });
});

describe('campos personalizados no PATCH (R4.7)', () => {
  it('mescla: chaves enviadas substituem, null apaga, ausentes ficam', () => {
    expect(
      aplicarPatchDosCampos(
        { a: 1, b: 'x', c: true },
        { b: 'y', c: null, d: [1] },
      ),
    ).toEqual({ a: 1, b: 'y', d: [1] });
  });

  it('null no lugar do objeto limpa tudo', () => {
    expect(aplicarPatchDosCampos({ a: 1 }, null)).toEqual({});
  });
});

describe('anonimização (R4.6)', () => {
  it('troca nome, e-mail e telefone por palavra inteira, sem diferenciar maiúsculas', () => {
    const termos = termosPessoais({
      nome: 'Maria',
      email: 'maria@x.com',
      telefone: '5511987654321',
    });
    expect(
      anonimizarTexto(
        'Ligar para MARIA (maria@x.com, 11987654321) — Mariana não',
        termos,
      ),
    ).toBe(
      'Ligar para Contato anonimizado (Contato anonimizado, Contato anonimizado) — Mariana não',
    );
  });

  it('apaga os dados pessoais e mantém o tipo da origem', () => {
    const dados = dadosDaAnonimizacao({ optOutEm: null }, AGORA);
    expect(dados).toMatchObject({
      nome: 'Contato anonimizado',
      email: null,
      telefone: null,
      cargo: null,
      empresaId: null,
      etiquetas: [],
      camposPersonalizados: {},
      optOutMarketing: true,
      optOutEm: AGORA,
      excluidoEm: AGORA,
    });
    expect(dados).not.toHaveProperty('primeiraOrigem');
    expect(dados).not.toHaveProperty('primeiraOrigemUtm');
  });
});

describe('busca de contatos e empresas', () => {
  it('escapa os curingas do LIKE', () => {
    expect(escaparLike('50%_a\\b')).toBe('50\\%\\_a\\\\b');
  });

  it('telefone digitado vira busca pelos dígitos (sem o zero de longa distância)', () => {
    expect(digitosDaBusca('(011) 98765-4321')).toBe('11987654321');
    expect(filtroDeBuscaDeContatos('(11) 98765-4321')).toEqual({
      OR: [
        { telefone: { contains: '11987654321' } },
        { email: { contains: '(11) 98765-4321' } },
      ],
    });
  });

  it('cada palavra precisa aparecer no nome ou no e-mail', () => {
    expect(filtroDeBuscaDeContatos(' maria  gmail ')).toEqual({
      AND: [
        {
          OR: [
            { nome: { contains: 'maria', mode: 'insensitive' } },
            { email: { contains: 'maria' } },
          ],
        },
        {
          OR: [
            { nome: { contains: 'gmail', mode: 'insensitive' } },
            { email: { contains: 'gmail' } },
          ],
        },
      ],
    });
    expect(filtroDeBuscaDeContatos('   ')).toBeUndefined();
  });

  it('empresa: CNPJ com pontuação também é procurado sem ela', () => {
    expect(filtroDeBuscaDeEmpresas('11.222.333')).toMatchObject({
      OR: expect.arrayContaining([{ cnpj: { contains: '11222333' } }]),
    });
  });
});
