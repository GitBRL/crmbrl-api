import {
  aplicarModeloDeMapeamento,
  campoValido,
  chaveDeCampoPersonalizado,
  normalizarColuna,
  formatoDeOrigem,
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

  describe('exportação do Clint (R16.14)', () => {
    const cabecalho = [
      'id',
      'created_at',
      'name',
      'email',
      'ddi',
      'phone',
      'complete_phone',
      'organization_name',
      'tags',
      'status',
      'stage',
      'value',
      'lost_status',
      'user_email',
      'user_name',
      'origin',
      'won_at',
      'lost_at',
      'deal_name',
      'role',
      'origem',
      'utm_source',
    ];

    it('R16.14 — liga origin ao funil, stage à etapa, status ao status do negócio e o resto', () => {
      const m = sugerirMapeamento('CONTATOS', cabecalho);
      expect(m).toMatchObject({
        id: 'negocio.idExterno',
        created_at: 'negocio.criadoEm',
        name: 'nome',
        email: 'email',
        complete_phone: 'telefone',
        organization_name: 'empresa',
        tags: 'etiquetas',
        status: 'negocio.status',
        stage: 'negocio.etapa',
        value: 'negocio.valor',
        lost_status: 'negocio.motivoPerda',
        user_email: 'responsavel',
        origin: 'negocio.funil',
        won_at: 'negocio.ganhoEm',
        lost_at: 'negocio.perdidoEm',
        deal_name: 'negocio.titulo',
        role: 'cargo',
        utm_source: 'utm.source',
      });
    });

    it('R16.14 — `origem` (campo de formulário) não vira funil; `phone` e `ddi` ficam de fora com `complete_phone`', () => {
      const m = sugerirMapeamento('CONTATOS', cabecalho);
      expect(m.origem).toBeUndefined();
      expect(m.phone).toBeUndefined();
      expect(m.ddi).toBeUndefined();
      expect(m.user_name).toBeUndefined();
    });

    it('R16.14 — `phone` sozinho continua sendo o telefone e nenhum campo é ligado a duas colunas', () => {
      expect(sugerirMapeamento('CONTATOS', ['phone', 'name']).phone).toBe(
        'telefone',
      );
      const m = sugerirMapeamento('CONTATOS', cabecalho);
      const campos = Object.values(m);
      expect(new Set(campos).size).toBe(campos.length);
    });

    it('R16.14 — com o cabeçalho completo da exportação real (100 colunas), `organization_name` vai para a empresa e as colunas de formulário não tomam campos do contato', () => {
      const completo = [
        'id',
        'created_at',
        'name',
        'email',
        'ddi',
        'phone',
        'complete_phone',
        'organization_name',
        'tags',
        'status',
        'stage',
        'value',
        'lost_status',
        'user_email',
        'user_name',
        'user_phone',
        'user_link',
        'origin',
        'won_at',
        'lost_at',
        'valid_phone',
        'contact_faturamento',
        'app',
        'ad_id',
        'ad_name',
        'form_id',
        'lead_id',
        'form_name',
        'campaign_id',
        'campaign_name',
        'user_id',
        'voce_esta_fazendo_o',
        'role',
        'sobrenome',
        'contact_notes',
        'duplicate_phone',
        '1_faturamento_mensal',
        'city',
        '1_numero_de_colabora',
        'area_de_atuacao',
        'qual_o_seu_principal',
        'mensagem',
        'utm_medium',
        'utm_source',
        'utm_content',
        'utm_campaign',
        'tipo_de_evento',
        'origem',
        'email_2',
        'motivo_de_contrataca',
        'user',
        'username',
        'url',
        'principal_dificuldad',
        'n_colaboradores',
        'qual_e_o_dia_provave',
        'contact_deseja_realizar_um_e',
        'qual_e_o_maior_desaf',
        'whatsapp_number',
        'tipo_de_ingresso',
        '_numero_de_colaborad',
        'qual_e_o_dia_provave_1',
        'currency',
        'voce_esta_fazendo_o_1',
        'contact_qual_dessas_frases_d',
        'segment',
        'faturamento_mensal',
        'local_da_edicao',
        'doc',
        'cadencia',
        'contactName',
        'contactEmail',
        'contactPhone',
        'maior_desafio',
        'socio',
        'qual_e_o_maior_desaf_1',
        'perfil',
        'company',
        '1_faturamento_anual',
        'indicacao',
        'contato_amigo_nome',
        'contato_amigo_instag',
        'contato_amigo_motivo',
        'contato_amigo_nome_d',
        'contato_amigo_telefo',
        'cnpj',
        'employees',
        'conhece_ravell_nava',
        'por_que_voce_deveria',
        'qual_a_sua_margem_de',
        'utm_term',
        'deal_name',
        'produto_de_entrada',
        'organization_deseja_realizar_um_e',
        'deal_faturamento',
        'pode_fazer_um_invest',
        'faz_parte_de_algum_p',
        'userId',
        'state',
        'category',
      ];
      const m = sugerirMapeamento('CONTATOS', completo);
      expect(m).toMatchObject({
        name: 'nome',
        email: 'email',
        complete_phone: 'telefone',
        organization_name: 'empresa',
        origin: 'negocio.funil',
        stage: 'negocio.etapa',
        status: 'negocio.status',
        user_email: 'responsavel',
        id: 'negocio.idExterno',
      });
      expect(m.company).toBeUndefined();
      expect(m.origem).toBeUndefined();
      const campos = Object.values(m);
      expect(new Set(campos).size).toBe(campos.length);
    });

    it('R16.14 — reconhece o formato pelo cabeçalho (origin, stage, status e user_email)', () => {
      expect(formatoDeOrigem(cabecalho)).toBe('CLINT');
      expect(formatoDeOrigem(['Nome', 'Etapa', 'Status'])).toBeNull();
      expect(formatoDeOrigem(['origin', 'stage', 'status'])).toBeNull();
    });
  });
});
