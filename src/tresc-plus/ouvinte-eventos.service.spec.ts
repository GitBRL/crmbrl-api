import {
  enderecoDoSocket,
  esperaDeReconexao,
  OuvinteDeEventosTrescPlus,
  type SocketDoTrescPlus,
} from './ouvinte-eventos.service';

describe('ouvinte de eventos do 3C+ (R34.4)', () => {
  it('backoff da reconexão: dobra de 1 s até o teto de 60 s, com jitter de ±25%', () => {
    const sem = (t: number) => esperaDeReconexao(t, () => 0.5);
    expect([0, 1, 2, 3, 4, 5, 6, 7, 30].map(sem)).toEqual([
      1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000,
    ]);
    expect(esperaDeReconexao(2, () => 0)).toBe(3000);
    expect(esperaDeReconexao(2, () => 1)).toBe(5000);
  });

  it('o endereço do socket é o configurado ou o host da API', () => {
    expect(enderecoDoSocket(null, 'https://3c.plus/api/v1')).toBe(
      'https://3c.plus',
    );
    expect(
      enderecoDoSocket('wss://events.3c.plus', 'https://3c.plus/api/v1'),
    ).toBe('wss://events.3c.plus');
  });

  describe('com um socket falso', () => {
    interface Falso extends SocketDoTrescPlus {
      ouvintes: Map<string, (...a: unknown[]) => void>;
      qualquer?: (e: string, ...a: unknown[]) => void;
      fechado: boolean;
      opcoes: Record<string, unknown>;
    }
    const criar = () => {
      const sockets: Falso[] = [];
      const fabrica = (
        _url: string,
        opcoes: Record<string, unknown>,
      ): Falso => {
        const s: Falso = {
          ouvintes: new Map(),
          fechado: false,
          opcoes,
          on(evento, fn) {
            s.ouvintes.set(evento, fn);
            return s;
          },
          onAny(fn) {
            s.qualquer = fn;
            return s;
          },
          close() {
            s.fechado = true;
          },
        };
        sockets.push(s);
        return s;
      };
      const estados: string[] = [];
      const recebidos: unknown[] = [];
      const config = {
        ativa: true,
        urlApi: 'https://3c.exemplo/api/v1',
        urlSocket: null,
        caminhoSocket: '/socket.io',
        formatoEnvelope: 'AUTO',
      };
      const conexao = {
        aoMudar: jest.fn(),
        ler: () => Promise.resolve(config),
        tokenDaEmpresa: () => 'tok',
        registrarEstadoDoOuvinte: (e: string) => {
          estados.push(e);
          return Promise.resolve();
        },
      };
      const ligacoes = {
        processarEvento: (e: unknown) => {
          recebidos.push(e);
          return Promise.resolve();
        },
      };
      const ouvinte = new OuvinteDeEventosTrescPlus(
        conexao as never,
        ligacoes as never,
        { trescPlus: { ouvinteAtivo: true } } as never,
        fabrica as never,
      );
      return { ouvinte, sockets, estados, recebidos };
    };

    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('conecta com o token na query e sem a reconexão do socket.io', async () => {
      const { ouvinte, sockets, estados } = criar();
      await ouvinte.iniciar();
      expect(sockets).toHaveLength(1);
      expect(sockets[0].opcoes).toMatchObject({
        path: '/socket.io',
        query: { token: 'tok' },
        reconnection: false,
        transports: ['websocket'],
      });
      sockets[0].ouvintes.get('connect')?.();
      expect(estados).toContain('conectado');
      ouvinte.parar();
      expect(sockets[0].fechado).toBe(true);
    });

    it('reconecta com backoff crescente depois de erro e zera ao conectar', async () => {
      const { ouvinte, sockets, estados } = criar();
      jest.spyOn(Math, 'random').mockReturnValue(0.5);
      await ouvinte.iniciar();
      sockets[0].ouvintes.get('connect_error')?.(new Error('recusado'));
      expect(estados.at(-1)).toBe('erro');
      jest.advanceTimersByTime(999);
      expect(sockets).toHaveLength(1);
      jest.advanceTimersByTime(2);
      expect(sockets).toHaveLength(2);
      sockets[1].ouvintes.get('connect_error')?.(new Error('recusado'));
      jest.advanceTimersByTime(1999);
      expect(sockets).toHaveLength(2);
      jest.advanceTimersByTime(2);
      expect(sockets).toHaveLength(3);
      sockets[2].ouvintes.get('connect')?.();
      sockets[2].ouvintes.get('disconnect')?.();
      expect(estados.at(-1)).toBe('reconectando');
      jest.advanceTimersByTime(1001);
      expect(sockets).toHaveLength(4);
      ouvinte.parar();
      jest.advanceTimersByTime(120_000);
      expect(sockets).toHaveLength(4);
      jest.restoreAllMocks();
    });

    it('entrega os eventos conhecidos em ordem e ignora o resto', async () => {
      const { ouvinte, sockets, recebidos } = criar();
      await ouvinte.iniciar();
      const s = sockets[0];
      s.qualquer?.('ping', {});
      s.qualquer?.('call-was-created', { call: { id: '1' } });
      s.qualquer?.('call-was-answered', { call: { id: '1' } });
      await ouvinte.aguardarFila();
      expect(recebidos.map((e) => (e as { tipo: string }).tipo)).toEqual([
        'call-was-created',
        'call-was-answered',
      ]);
      ouvinte.parar();
    });

    it('depois de parado, eventos e quedas antigas não fazem nada', async () => {
      const { ouvinte, sockets, recebidos } = criar();
      await ouvinte.iniciar();
      const antigo = sockets[0];
      ouvinte.parar();
      antigo.qualquer?.('call-was-created', { call: { id: '1' } });
      antigo.ouvintes.get('disconnect')?.();
      jest.advanceTimersByTime(120_000);
      await ouvinte.aguardarFila();
      expect(recebidos).toHaveLength(0);
      expect(sockets).toHaveLength(1);
    });
  });
});
