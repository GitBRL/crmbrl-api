import {
  areasDoChat,
  CANAIS_DO_SISTEMA,
  CHAVE_DO_GERAL,
  canaisAutomaticosPorPapel,
  chaveDaArea,
  chaveDaDireta,
  dividirTexto,
  extrairMarcacoes,
  lerReferencias,
  linkDaMensagem,
  lugarDoCanal,
  marcarMencao,
  marcarReferencia,
  normalizarTextoDaMensagem,
  resumir,
  sqlTextoSemMarcacoes,
} from './regras-chat';

const ANA = '6f1c2b0e-8a3d-4c55-9a51-2d8f8d7c1e10';
const PEDRO = '0b7e7f43-6c43-4c9e-b2f4-2f1f0d1e5a10';
const NEGOCIO = '11111111-2222-4333-8444-555555555555';

describe('regras do chat interno (R15)', () => {
  describe('canais do sistema', () => {
    it('Geral e um canal por área, com chaves estáveis', () => {
      expect(CANAIS_DO_SISTEMA.map((canal) => canal.chave)).toEqual([
        CHAVE_DO_GERAL,
        'area:MARKETING',
        'area:COMERCIAL',
        'area:CS',
      ]);
      expect(CANAIS_DO_SISTEMA[0]).toMatchObject({
        tipo: 'GERAL',
        nome: 'Geral',
        area: null,
      });
      expect(
        CANAIS_DO_SISTEMA.filter((canal) => canal.tipo === 'AREA').map(
          (canal) => [canal.area, canal.nome],
        ),
      ).toEqual([
        ['MARKETING', 'Marketing'],
        ['COMERCIAL', 'Comercial'],
        ['CS', 'Customer Success'],
      ]);
      expect(chaveDaArea('CS')).toBe('area:CS');
    });

    it('áreas de cada papel: a própria; C-level todas; Admin nenhuma', () => {
      expect(areasDoChat('COMERCIAL')).toEqual(['COMERCIAL']);
      expect(areasDoChat('LIDER_CS')).toEqual(['CS']);
      expect(areasDoChat('MARKETING')).toEqual(['MARKETING']);
      expect(areasDoChat('C_LEVEL')).toEqual(['MARKETING', 'COMERCIAL', 'CS']);
      expect(areasDoChat('ADMIN')).toEqual([]);
    });

    it('membros automáticos: todo papel no Geral e cada um nos canais das suas áreas', () => {
      const pares = canaisAutomaticosPorPapel();
      const doPapel = (papel: string) =>
        pares.filter(([p]) => p === papel).map(([, chave]) => chave);
      expect(doPapel('ADMIN')).toEqual(['geral']);
      expect(doPapel('COMERCIAL')).toEqual(['geral', 'area:COMERCIAL']);
      expect(doPapel('LIDER_MARKETING')).toEqual(['geral', 'area:MARKETING']);
      expect(doPapel('C_LEVEL')).toEqual([
        'geral',
        'area:MARKETING',
        'area:COMERCIAL',
        'area:CS',
      ]);
      expect(pares).toHaveLength(8 + 6 + 3);
    });

    it('a chave da direta não depende da ordem nem de maiúsculas', () => {
      const chave = chaveDaDireta(ANA, PEDRO);
      expect(chave).toBe(chaveDaDireta(PEDRO.toUpperCase(), ANA));
      expect(chave).toBe(`direto:${PEDRO}:${ANA}`);
    });
  });

  describe('marcações no texto', () => {
    it('divide texto, menções e referências na ordem', () => {
      const texto = `Oi ${marcarMencao(ANA)}, veja o ${marcarReferencia('negocio', NEGOCIO)}!`;
      expect(dividirTexto(texto)).toEqual([
        { tipo: 'texto', texto: 'Oi ' },
        { tipo: 'mencao', usuarioId: ANA },
        { tipo: 'texto', texto: ', veja o ' },
        { tipo: 'referencia', referencia: { tipo: 'negocio', id: NEGOCIO } },
        { tipo: 'texto', texto: '!' },
      ]);
    });

    it('ignora marcações malformadas e normaliza o id para minúsculas', () => {
      expect(dividirTexto('<@nao-e-uuid> e <pedido:123>')).toEqual([
        { tipo: 'texto', texto: '<@nao-e-uuid> e <pedido:123>' },
      ]);
      expect(dividirTexto(`<@${ANA.toUpperCase()}>`)).toEqual([
        { tipo: 'mencao', usuarioId: ANA },
      ]);
      expect(dividirTexto('')).toEqual([]);
      expect(dividirTexto(null)).toEqual([]);
    });

    it('extrai menções e referências sem repetidos', () => {
      const texto = [
        marcarMencao(ANA),
        marcarMencao(PEDRO),
        marcarMencao(ANA),
        marcarReferencia('contato', NEGOCIO),
        marcarReferencia('contato', NEGOCIO),
        marcarReferencia('empresa', NEGOCIO),
      ].join(' ');
      expect(extrairMarcacoes(texto)).toEqual({
        mencoes: [ANA, PEDRO],
        referencias: [
          { tipo: 'contato', id: NEGOCIO },
          { tipo: 'empresa', id: NEGOCIO },
        ],
      });
      expect(extrairMarcacoes(undefined)).toEqual({
        mencoes: [],
        referencias: [],
      });
    });
  });

  describe('lugares e links', () => {
    it('descreve o canal nos títulos das notificações', () => {
      expect(lugarDoCanal({ tipo: 'GERAL', nome: 'Geral' })).toBe(
        'no canal Geral',
      );
      expect(lugarDoCanal({ tipo: 'GRUPO', nome: 'Lançamento' })).toBe(
        'no grupo Lançamento',
      );
      expect(lugarDoCanal({ tipo: 'DIRETO', nome: null })).toBe(
        'numa conversa direta',
      );
      expect(linkDaMensagem('c1', 'm1')).toBe('/chat/c1?mensagem=m1');
    });

    it('a busca ignora as marcações (expressão SQL fixa sobre a coluna)', () => {
      expect(sqlTextoSemMarcacoes('m.texto')).toBe(
        "regexp_replace(coalesce(m.texto, ''), '<(@|negocio:|contato:|empresa:)[0-9a-fA-F-]{36}>', ' ', 'g')",
      );
    });
  });

  describe('texto da mensagem', () => {
    it('apara, troca CRLF por LF e transforma vazio em null', () => {
      expect(normalizarTextoDaMensagem('  oi\r\ntudo bem?\r ')).toBe(
        'oi\ntudo bem?',
      );
      expect(normalizarTextoDaMensagem('   \n ')).toBeNull();
      expect(normalizarTextoDaMensagem(undefined)).toBeNull();
      expect(normalizarTextoDaMensagem(null)).toBeNull();
    });

    it('resume em uma linha e corta com reticências', () => {
      expect(resumir('linha 1\n\nlinha   2')).toBe('linha 1 linha 2');
      const longo = 'a'.repeat(200);
      const resumo = resumir(longo, 10);
      expect(resumo).toHaveLength(10);
      expect(resumo.endsWith('…')).toBe(true);
    });

    it('lê as referências guardadas com segurança', () => {
      expect(
        lerReferencias([
          { tipo: 'negocio', id: NEGOCIO },
          { tipo: 'pedido', id: NEGOCIO },
          { tipo: 'contato' },
          'lixo',
          null,
        ]),
      ).toEqual([{ tipo: 'negocio', id: NEGOCIO }]);
      expect(lerReferencias({})).toEqual([]);
      expect(lerReferencias(null)).toEqual([]);
    });
  });
});
