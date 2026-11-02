import { FalhaDefinitivaDeEnvio } from '../../canais/adaptador-canal';
import type { OuvinteDaSessao } from './transporte';
import {
  telefoneSemWhatsappNoSimulador,
  telefoneSimulado,
  TransporteSimulado,
} from './transporte-simulado';

function ouvinteFalso() {
  const chamadas: Array<[string, ...unknown[]]> = [];
  const ouvinte: OuvinteDaSessao = {
    aoQr: (qr) => chamadas.push(['qr', qr]),
    aoConectar: (conta) => chamadas.push(['conectar', conta]),
    aoCair: (queda) => chamadas.push(['cair', queda]),
    aoReceber: (mensagem) => chamadas.push(['receber', mensagem]),
    aoStatus: (id, status) => chamadas.push(['status', id, status]),
    aoDigitando: () => chamadas.push(['digitando']),
  };
  return { ouvinte, chamadas };
}

describe('TransporteSimulado', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  const numero = {
    numeroId: '6f1c2b0e-8a3d-4c55-9a51-2d8f8d7c1e10',
    canalId: 'c',
    telefone: null,
    jaConectado: false,
  };
  const tempos = { qr: 10, conexao: 100, entrega: 20, leitura: 50 };

  it('mostra um QR e conecta sozinho com um telefone fixo do número', async () => {
    const { ouvinte, chamadas } = ouvinteFalso();
    const sessao = new TransporteSimulado(tempos).criar(numero, ouvinte);
    await sessao.iniciar();
    jest.advanceTimersByTime(10);
    expect(chamadas[0][0]).toBe('qr');
    expect(chamadas[0][1]).toMatch(/^SIMULADO-CRMBRL:/);
    jest.advanceTimersByTime(100);
    const telefone = telefoneSimulado(numero.numeroId);
    expect(telefone).toMatch(/^55119\d{8}$/);
    expect(chamadas[1]).toEqual([
      'conectar',
      { telefone, jid: `${telefone}@s.whatsapp.net` },
    ]);
  });

  it('com credenciais (reconexão), conecta sem QR', async () => {
    const { ouvinte, chamadas } = ouvinteFalso();
    const sessao = new TransporteSimulado(tempos).criar(
      { ...numero, jaConectado: true, telefone: '5511900001111' },
      ouvinte,
    );
    await sessao.iniciar();
    jest.advanceTimersByTime(10);
    expect(chamadas.map(([tipo]) => tipo)).toEqual(['conectar']);
  });

  it('envio aceito passa por entregue e lida; número terminado em 0000 não tem WhatsApp', async () => {
    const { ouvinte, chamadas } = ouvinteFalso();
    const sessao = new TransporteSimulado(tempos).criar(numero, ouvinte);
    await expect(
      sessao.enviar({
        idExterno: 'X',
        para: '5511988887777@s.whatsapp.net',
        tipo: 'TEXTO',
      }),
    ).rejects.toThrow('não está conectado');
    await sessao.iniciar();
    jest.advanceTimersByTime(110);
    await sessao.enviar({
      idExterno: 'X',
      para: '5511988887777@s.whatsapp.net',
      tipo: 'TEXTO',
    });
    jest.advanceTimersByTime(50);
    expect(chamadas.filter(([tipo]) => tipo === 'status')).toEqual([
      ['status', 'X', 'ENTREGUE'],
      ['status', 'X', 'LIDA'],
    ]);
    await expect(
      sessao.enviar({
        idExterno: 'Y',
        para: '5511933330000@s.whatsapp.net',
        tipo: 'TEXTO',
      }),
    ).rejects.toBeInstanceOf(FalhaDefinitivaDeEnvio);
    expect(telefoneSemWhatsappNoSimulador('5511933330000')).toBe(true);
    await expect(sessao.verificar('5511933330000')).resolves.toEqual({
      existe: false,
      jid: null,
    });
    await expect(sessao.verificar('5511988887777')).resolves.toEqual({
      existe: true,
      jid: '5511988887777@s.whatsapp.net',
    });
  });

  it('encerrar cancela o que estava agendado', async () => {
    const { ouvinte, chamadas } = ouvinteFalso();
    const sessao = new TransporteSimulado(tempos).criar(numero, ouvinte);
    await sessao.iniciar();
    await sessao.encerrar();
    jest.advanceTimersByTime(1_000);
    expect(chamadas).toEqual([]);
  });
});
