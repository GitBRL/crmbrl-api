import {
  aplicarMapeamento,
  expandirCuringa,
  lerCaminho,
  lerMapeamentoGravado,
  lerValorMonetario,
  MAPEAMENTO_DISPAROS_BRL,
  MAPEAMENTO_GENERICO,
  type Mapeamento,
  mapeamentoEfetivo,
  validarMapeamento,
} from './mapeamento';

describe('mapeamento dos webhooks de entrada (R8.1)', () => {
  describe('caminhos', () => {
    const corpo = {
      lead: { nome: 'Ana', contatos: [{ email: 'ana@x.com' }] },
      'utm.source': 'google',
      planilha_cidade: 'SP',
      planilha_uf: 'SP',
      outra: 1,
    };

    it('lê chaves aninhadas, índices de lista e chave com ponto na raiz', () => {
      expect(lerCaminho(corpo, 'lead.nome')).toBe('Ana');
      expect(lerCaminho(corpo, 'lead.contatos[0].email')).toBe('ana@x.com');
      expect(lerCaminho(corpo, 'lead.contatos.0.email')).toBe('ana@x.com');
      expect(lerCaminho(corpo, 'utm.source')).toBe('google');
      expect(lerCaminho(corpo, 'lead.inexistente')).toBeUndefined();
      expect(lerCaminho(corpo, 'lead.contatos.x')).toBeUndefined();
      expect(lerCaminho(corpo, 'toString')).toBeUndefined();
    });

    it('expande o curinga do último trecho, guardando o que ele casou', () => {
      expect(expandirCuringa(corpo, 'planilha_*')).toEqual([
        { chave: 'planilha_cidade', parte: 'cidade', valor: 'SP' },
        { chave: 'planilha_uf', parte: 'uf', valor: 'SP' },
      ]);
      expect(
        expandirCuringa(corpo, 'lead.*').map(({ chave }) => chave),
      ).toEqual(['nome', 'contatos']);
      expect(expandirCuringa(corpo, 'nada.*')).toEqual([]);
    });
  });

  describe('validação da configuração', () => {
    it('R8.1 — aceita um mapeamento personalizado bem formado', () => {
      const resultado = validarMapeamento({
        campos: [
          { caminho: ' lead.nome ', destino: 'nome' },
          { caminho: 'lead.email', destino: 'email' },
          { caminho: 'extras.*', destino: 'camposPersonalizados.extra_*' },
          { caminho: 'tags', destino: 'etiquetas' },
        ],
        ignorarQuando: [{ caminho: 'teste', valor: true }],
      });
      expect(resultado).toEqual({
        valido: true,
        mapeamento: {
          campos: [
            { caminho: 'lead.nome', destino: 'nome' },
            { caminho: 'lead.email', destino: 'email' },
            { caminho: 'extras.*', destino: 'camposPersonalizados.extra_*' },
            { caminho: 'tags', destino: 'etiquetas' },
          ],
          ignorarQuando: [{ caminho: 'teste', valor: true }],
        },
      });
    });

    it('R8.1 — recusa destino desconhecido, curinga fora do lugar e mapeamento sem nome ou meio de contato', () => {
      const ruim = validarMapeamento({
        campos: [
          { caminho: 'a..b', destino: 'nome' },
          { caminho: 'x', destino: 'sobrenome' },
          { caminho: 'a.*.b', destino: 'camposPersonalizados.*' },
          { caminho: 'y*', destino: 'email' },
          { caminho: 'z', destino: 'camposPersonalizados.*' },
        ],
        extra: 1,
      });
      expect(ruim.valido).toBe(false);
      const campos = !ruim.valido ? ruim.problemas.map((p) => p.campo) : [];
      expect(campos).toEqual([
        'mapeamento.campos.0.caminho',
        'mapeamento.campos.1.destino',
        'mapeamento.campos.2.caminho',
        'mapeamento.campos.3.destino',
        'mapeamento.campos.4.destino',
        'mapeamento.extra',
      ]);

      const semMeio = validarMapeamento({
        campos: [{ caminho: 'nome', destino: 'nome' }],
      });
      expect(semMeio.valido).toBe(false);
      expect(!semMeio.valido && semMeio.problemas[0].mensagens[0]).toMatch(
        /email" ou "telefone/,
      );
      expect(validarMapeamento({ campos: [] }).valido).toBe(false);
      expect(validarMapeamento(null).valido).toBe(false);
    });

    it('os modelos prontos passam na própria validação', () => {
      expect(validarMapeamento(MAPEAMENTO_GENERICO).valido).toBe(true);
      expect(validarMapeamento(MAPEAMENTO_DISPAROS_BRL).valido).toBe(true);
    });

    it('lê o mapeamento gravado com defesa e escolhe o efetivo pelo modelo', () => {
      expect(
        lerMapeamentoGravado({
          campos: [{ caminho: 1 }, { caminho: 'a', destino: 'nome' }],
        }),
      ).toEqual({
        campos: [{ caminho: 'a', destino: 'nome' }],
        ignorarQuando: [],
      });
      expect(lerMapeamentoGravado('lixo')).toEqual({
        campos: [],
        ignorarQuando: [],
      });
      expect(mapeamentoEfetivo('GENERICO', { campos: [] })).toBe(
        MAPEAMENTO_GENERICO,
      );
      expect(mapeamentoEfetivo('DISPAROS_BRL', null)).toBe(
        MAPEAMENTO_DISPAROS_BRL,
      );
    });
  });

  describe('aplicação (R8.5)', () => {
    it('R8.1 — modelo Genérico: name, email, phone e utm_*, normalizados', () => {
      const lead = aplicarMapeamento(
        MAPEAMENTO_GENERICO,
        {
          name: '  Maria   Souza ',
          email: 'MARIA@Empresa.com.br',
          phone: '(11) 98765-4321',
          utm_source: 'google',
          utm_campaign: 'bf',
          ignorado: 'x',
        },
        ['Site'],
      );
      expect(lead.problemas).toEqual([]);
      expect(lead.contato).toEqual({
        nome: 'Maria Souza',
        email: 'maria@empresa.com.br',
        telefone: '5511987654321',
        empresa: null,
        cargo: null,
      });
      expect(lead.utm).toEqual({ source: 'google', campaign: 'bf' });
      expect(lead.etiquetas).toEqual(['Site']);
    });

    it('R8.1 — modelo Disparos BRL: whatsapp de reserva, faturamento e planilha_* em campos personalizados', () => {
      const lead = aplicarMapeamento(MAPEAMENTO_DISPAROS_BRL, {
        name: 'Lead de Teste',
        email: '',
        phone: '(11) 9999',
        faturamento: 'Acima de R$ 80 mil',
        whatsapp: '5511999998888',
        campanha: 'Black Friday',
        origem: 'Disparos WhatsApp',
        planilha_cidade: 'São Paulo',
        planilha_vazia: '',
      });
      expect(lead.problemas).toEqual([]);
      expect(lead.contato.telefone).toBe('5511999998888');
      expect(lead.contato.email).toBeNull();
      expect(lead.camposPersonalizados).toEqual({
        whatsapp: '5511999998888',
        faturamento: 'Acima de R$ 80 mil',
        planilha_cidade: 'São Paulo',
      });
      expect(lead.utm).toEqual({
        campaign: 'Black Friday',
        source: 'Disparos WhatsApp',
      });
      expect(lead.avisos).toEqual([
        expect.stringMatching(/^Telefone "\(11\) 9999" \(phone\) inválido/),
      ]);
    });

    it('R8.1 — o envio de teste do sistema de disparos (teste=true) é ignorado', () => {
      for (const teste of [true, 'true', 'TRUE']) {
        const lead = aplicarMapeamento(MAPEAMENTO_DISPAROS_BRL, {
          name: 'Lead de Teste',
          phone: '(11) 99999-8888',
          teste,
        });
        expect(lead.ignorado).toMatch(/"teste" veio igual a true/);
      }
      expect(
        aplicarMapeamento(MAPEAMENTO_DISPAROS_BRL, {
          name: 'Ana',
          phone: '(11) 99999-8888',
          teste: false,
        }).ignorado,
      ).toBeNull();
    });

    it('R8.5 — corpo vazio é ignorado; lista ou corpo sem os campos viram problema', () => {
      expect(aplicarMapeamento(MAPEAMENTO_GENERICO, {}).ignorado).toMatch(
        /Corpo vazio/,
      );
      expect(aplicarMapeamento(MAPEAMENTO_GENERICO, [{}]).problemas[0]).toMatch(
        /lista/,
      );
      expect(
        aplicarMapeamento(MAPEAMENTO_GENERICO, { evento: 'ping' }).problemas,
      ).toEqual([
        expect.stringMatching(
          /Nenhum dos caminhos do mapeamento foi encontrado/,
        ),
      ]);
    });

    it('R4.1 — sem nome ou sem meio de contato válido é problema; meio inválido com outro válido é só aviso', () => {
      const semNome = aplicarMapeamento(MAPEAMENTO_GENERICO, {
        email: 'a@x.com',
      });
      expect(semNome.problemas).toEqual([
        'Sem nome: o caminho "name" não trouxe valor (R4.1).',
      ]);
      const semMeio = aplicarMapeamento(MAPEAMENTO_GENERICO, {
        name: 'Ana',
        email: 'nao-e-email',
        phone: '(20) 98765-4321',
      });
      expect(semMeio.problemas).toEqual([
        expect.stringMatching(
          /^Sem e-mail nem telefone válidos \(R4\.1\): E-mail "nao-e-email" \(email\) inválido; Telefone .*DDD 20/,
        ),
      ]);
      const comUmValido = aplicarMapeamento(MAPEAMENTO_GENERICO, {
        name: 'Ana',
        email: 'nao-e-email',
        phone: '11987654321',
      });
      expect(comUmValido.problemas).toEqual([]);
      expect(comUmValido.contato.telefone).toBe('5511987654321');
      expect(comUmValido.avisos).toEqual([
        'E-mail "nao-e-email" (email) inválido: ignorado.',
      ]);
    });

    it('vários caminhos para o mesmo destino: vale o primeiro com valor; etiquetas se somam', () => {
      const mapeamento: Mapeamento = {
        campos: [
          { caminho: 'nome', destino: 'nome' },
          { caminho: 'full_name', destino: 'nome' },
          { caminho: 'emails', destino: 'email' },
          { caminho: 'empresa.nome', destino: 'empresa' },
          { caminho: 'tags', destino: 'etiquetas' },
          { caminho: 'segmento', destino: 'etiquetas' },
          { caminho: 'extras.*', destino: 'camposPersonalizados.*' },
          { caminho: 'preco', destino: 'valor' },
          { caminho: 'mensalidade', destino: 'valorRecorrente' },
          { caminho: 'titulo', destino: 'titulo' },
        ],
        ignorarQuando: [],
      };
      const lead = aplicarMapeamento(
        mapeamento,
        {
          full_name: 'Bruno',
          emails: ['', 'BRUNO@x.com'],
          empresa: { nome: 'ACME' },
          tags: ['VIP', 'vip'],
          segmento: 'Varejo; Atacado',
          extras: { cidade: 'Recife', ativo: true },
          preco: 'R$ 1.500,50',
          mensalidade: 'abc',
          titulo: 42,
        },
        ['Fixa'],
      );
      expect(lead.contato.nome).toBe('Bruno');
      expect(lead.contato.email).toBe('bruno@x.com');
      expect(lead.contato.empresa).toBe('ACME');
      expect(lead.etiquetas).toEqual(['Fixa', 'VIP', 'Varejo', 'Atacado']);
      expect(lead.camposPersonalizados).toEqual({
        cidade: 'Recife',
        ativo: true,
      });
      expect(lead.negocio).toEqual({
        titulo: '42',
        valor: '1500.50',
        valorRecorrente: null,
      });
      expect(lead.avisos).toEqual([
        'Valor recorrente "abc" (mensalidade) ignorado: formato inválido.',
      ]);
      expect(lead.encontrados).toContainEqual({
        destino: 'camposPersonalizados.*',
        caminho: 'cidade',
      });
    });
  });

  describe('valores em reais', () => {
    it.each([
      [1500, '1500.00'],
      [1500.5, '1500.50'],
      ['1500', '1500.00'],
      ['1500.5', '1500.50'],
      ['1.500', '1500.00'],
      ['1.500,00', '1500.00'],
      ['1.500.000,9', '1500000.90'],
      ['1500,5', '1500.50'],
      ['1,500.00', '1500.00'],
      ['R$ 2.000,00', '2000.00'],
      ['0', '0.00'],
      ['007', '7.00'],
    ])('lê %p como %p', (entrada, esperado) => {
      expect(lerValorMonetario(entrada)).toBe(esperado);
    });

    it.each([[-1], ['-10'], ['abc'], ['1.5.5'], [true], [1e21], ['12,345,6']])(
      'recusa %p',
      (entrada) => {
        expect(lerValorMonetario(entrada)).toBeNull();
      },
    );
  });
});
