import {
  alertaDoPapelDoBanco,
  alertaDoGateway,
  alertasDeBackup,
  alertasDeCanais,
  alertasDeDisco,
  alertasDeFilas,
  alertasDeNumeros,
  avaliarBackup,
  avaliarDisco,
  avaliarFila,
  decidirEnvios,
  duracaoEmTexto,
  type FatosDeNumero,
  INTERVALO_DE_LEMBRETE_HORAS,
  lerUltimoBackup,
  situacaoGeral,
} from './avaliacao';

const AGORA = new Date('2026-10-31T12:00:00.000Z');
const antes = (segundos: number) => new Date(+AGORA - segundos * 1000);

const numero = (extra: Partial<FatosDeNumero> = {}): FatosDeNumero => ({
  id: 'n1',
  nome: 'Comercial',
  telefone: '5511999990000',
  status: 'CONECTADO',
  motivo: null,
  canalAtivo: true,
  pausado: false,
  conectadoEm: antes(86_400),
  desconectadoEm: null,
  ultimoEventoEm: null,
  ...extra,
});

describe('Saúde do sistema — regras (R27)', () => {
  describe('filas', () => {
    const base = {
      nome: 'f',
      pendentes: 0,
      ativas: 0,
      falhasRecentes: 0,
      maisAntigaDesde: null,
      ativaDesde: null,
    };

    it('R27.1 — fila sem espera não está travada', () => {
      const fila = avaliarFila(base, AGORA);
      expect(fila.travada).toBe(false);
      expect(fila.maisAntigaParadaSegundos).toBeNull();
    });

    it('R27.1 — pendente esperando mais de 10 min trava a fila', () => {
      const fila = avaliarFila(
        { ...base, pendentes: 3, maisAntigaDesde: antes(11 * 60) },
        AGORA,
      );
      expect(fila.travada).toBe(true);
      expect(fila.maisAntigaParadaSegundos).toBe(660);
      const [alerta] = alertasDeFilas([fila]);
      expect(alerta).toMatchObject({
        chave: 'fila:f',
        gravidade: 'critico',
        porEmail: true,
      });
    });

    it('R27.1 — pendente recente não trava; job ativo há mais de 1 h trava', () => {
      expect(
        avaliarFila({ ...base, maisAntigaDesde: antes(120) }, AGORA).travada,
      ).toBe(false);
      const longa = avaliarFila({ ...base, ativaDesde: antes(3_700) }, AGORA);
      expect(longa.travada).toBe(true);
      expect(longa.motivoDaTrava).toContain('em execução');
    });
  });

  describe('números de WhatsApp', () => {
    it('R27.2 — conectado não alerta', () => {
      expect(alertasDeNumeros([numero()], AGORA)).toEqual([]);
    });

    it('R27.2 — desconectado há mais que a carência alerta; recém-caído, não', () => {
      const caido = numero({
        status: 'DESCONECTADO',
        desconectadoEm: antes(600),
        motivo: 'Desconectado pelo celular',
      });
      const [alerta] = alertasDeNumeros([caido], AGORA);
      expect(alerta?.codigo).toBe('numero_desconectado');
      expect(alerta?.detalhe).toContain('Desconectado pelo celular');
      const recente = numero({
        status: 'DESCONECTADO',
        desconectadoEm: antes(30),
      });
      expect(alertasDeNumeros([recente], AGORA)).toEqual([]);
    });

    it('R27.2 — número que nunca conectou, canal inativo e CONECTANDO não alertam', () => {
      const semAlerta = [
        numero({
          status: 'DESCONECTADO',
          conectadoEm: null,
          desconectadoEm: antes(9_999),
        }),
        numero({
          status: 'DESCONECTADO',
          canalAtivo: false,
          desconectadoEm: antes(9_999),
        }),
        numero({ status: 'CONECTANDO', desconectadoEm: antes(9_999) }),
      ];
      expect(alertasDeNumeros(semAlerta, AGORA)).toEqual([]);
    });

    it('R27.2 — erro e banimento alertam na hora, cada um com sua chave', () => {
      const alertas = alertasDeNumeros(
        [
          numero({ id: 'a', status: 'ERRO', motivo: 'falha' }),
          numero({ id: 'b', status: 'BANIDO' }),
        ],
        AGORA,
      );
      expect(alertas.map((a) => [a.chave, a.codigo])).toEqual([
        ['numero:a', 'numero_desconectado'],
        ['numero:b', 'numero_banido'],
      ]);
    });
  });

  describe('backup', () => {
    const registro = (extra: object = {}) =>
      JSON.stringify({
        inicio: antes(3_700).toISOString(),
        fim: antes(3_600).toISOString(),
        arquivo: 'crmbrl-2026-10-31.dump',
        tamanhoBytes: 1234,
        ok: true,
        erro: null,
        ...extra,
      });

    it('R27.3 — sem arquivo: "nenhum backup registrado", sem e-mail', () => {
      const backup = avaliarBackup(null, AGORA);
      expect(backup.situacao).toBe('nenhum');
      const [alerta] = alertasDeBackup(backup);
      expect(alerta?.titulo).toBe('Nenhum backup registrado');
      expect(alerta?.porEmail).toBe(false);
    });

    it('R27.3 — backup recente e ok não alerta', () => {
      const backup = avaliarBackup(registro(), AGORA);
      expect(backup).toMatchObject({ situacao: 'ok', idadeHoras: 1 });
      expect(alertasDeBackup(backup)).toEqual([]);
    });

    it('R27.3 — backup com ok=false falha e avisa por e-mail com o erro', () => {
      const backup = avaliarBackup(
        registro({ ok: false, erro: 'disco cheio' }),
        AGORA,
      );
      expect(backup.situacao).toBe('falhou');
      const [alerta] = alertasDeBackup(backup);
      expect(alerta).toMatchObject({ codigo: 'backup_falhou', porEmail: true });
      expect(alerta?.detalhe).toContain('disco cheio');
    });

    it('R27.3 — backup velho (mais de 36 h) está atrasado', () => {
      const velho = registro({ fim: antes(40 * 3_600).toISOString() });
      const backup = avaliarBackup(velho, AGORA);
      expect(backup.situacao).toBe('atrasado');
      expect(alertasDeBackup(backup)[0]?.codigo).toBe('backup_atrasado');
    });

    it('R27.3 — arquivo corrompido ou incompleto é ilegível (só aviso)', () => {
      for (const texto of ['{não é json', '[]', '{"ok":true}', 'null']) {
        expect(avaliarBackup(texto, AGORA).situacao).toBe('ilegivel');
      }
      const [alerta] = alertasDeBackup(avaliarBackup('{', AGORA));
      expect(alerta).toMatchObject({ gravidade: 'aviso', porEmail: false });
    });

    it('R27.3 — lê o formato combinado e ignora campos de tipo errado', () => {
      expect(
        lerUltimoBackup(
          JSON.stringify({
            fim: AGORA.toISOString(),
            ok: true,
            tamanhoBytes: 'x',
            erro: 5,
          }),
        ),
      ).toMatchObject({ tamanhoBytes: null, erro: null, arquivo: null });
    });
  });

  describe('disco, canais, gateway', () => {
    it('R27.4 — limiares de espaço livre', () => {
      expect(avaliarDisco('/', 100, 50).situacao).toBe('ok');
      expect(avaliarDisco('/', 100, 10).situacao).toBe('aviso');
      expect(avaliarDisco('/', 100, 3).situacao).toBe('critico');
      expect(alertasDeDisco(avaliarDisco('/', 100, 3))[0]?.gravidade).toBe(
        'critico',
      );
      expect(alertasDeDisco(null)).toEqual([]);
    });

    it('R27.5 — só erro de canal das últimas 24 h vira aviso', () => {
      const canal = (id: string, horas: number | null) => ({
        id,
        tipo: 'EMAIL',
        nome: id,
        ultimoErro: horas === null ? null : 'IMAP recusou o login',
        ultimoErroEm: horas === null ? null : antes(horas * 3_600),
      });
      const alertas = alertasDeCanais(
        [canal('novo', 2), canal('velho', 48), canal('limpo', null)],
        AGORA,
      );
      expect(alertas.map((a) => a.chave)).toEqual(['canal:novo']);
    });

    it('R27.6 — gateway fora do ar só alerta havendo números ativos', () => {
      expect(alertaDoGateway(true, 0)).toEqual([]);
      expect(alertaDoGateway(false, 2)).toEqual([]);
      expect(alertaDoGateway(true, 1)[0]).toMatchObject({
        codigo: 'gateway_fora_do_ar',
        porEmail: true,
      });
    });
  });

  describe('antirrepetição (R27.7)', () => {
    const alerta = (chave: string, porEmail = true) => ({
      chave,
      codigo: 'x',
      gravidade: 'critico' as const,
      titulo: chave,
      detalhe: '',
      dica: '',
      porEmail,
    });

    it('alerta novo sai e entra no registro', () => {
      const d = decidirEnvios([alerta('a')], {}, AGORA);
      expect(d.enviar.map((x) => x.chave)).toEqual(['a']);
      expect(d.registro).toEqual({ a: AGORA.toISOString() });
    });

    it('o que já foi avisado não repete antes do intervalo e volta depois dele', () => {
      const registro = { a: antes(3_600).toISOString() };
      expect(decidirEnvios([alerta('a')], registro, AGORA).enviar).toEqual([]);
      const depois = new Date(+AGORA + INTERVALO_DE_LEMBRETE_HORAS * 3_600_000);
      expect(
        decidirEnvios([alerta('a')], registro, depois).enviar,
      ).toHaveLength(1);
    });

    it('o que se resolveu sai do registro (se voltar, avisa de novo)', () => {
      const registro = { a: antes(60).toISOString() };
      const d = decidirEnvios([], registro, AGORA);
      expect(d.registro).toEqual({});
      expect(
        decidirEnvios([alerta('a')], d.registro, AGORA).enviar,
      ).toHaveLength(1);
    });

    it('alertas sem e-mail não entram no registro', () => {
      const d = decidirEnvios([alerta('s', false)], {}, AGORA);
      expect(d).toEqual({ enviar: [], registro: {} });
    });
  });

  it('situação geral e duração em texto', () => {
    expect(situacaoGeral([])).toBe('ok');
    expect(
      situacaoGeral(
        alertasDeCanais([], AGORA).concat(alertaDoGateway(true, 1)),
      ),
    ).toBe('critico');
    expect(duracaoEmTexto(45)).toBe('45 s');
    expect(duracaoEmTexto(125 * 60)).toBe('2 h 5 min');
    expect(duracaoEmTexto(28 * 3600)).toBe('1 d 4 h');
  });
});

describe('alertaDoPapelDoBanco (R35.1)', () => {
  it('avisa quando a API usa um papel que ignora a RLS (o dono); com o papel próprio, nada', () => {
    expect(
      alertaDoPapelDoBanco({ usuario: 'crmbrl_app', ignoraRls: false }),
    ).toEqual([]);
    expect(alertaDoPapelDoBanco(null)).toEqual([]);
    const [alerta] = alertaDoPapelDoBanco({
      usuario: 'crmbrl',
      ignoraRls: true,
    });
    expect(alerta).toMatchObject({
      codigo: 'banco_sem_papel_proprio',
      gravidade: 'aviso',
      porEmail: false,
    });
    expect(alerta.detalhe).toContain('crmbrl');
    expect(alerta.dica).toContain('BANCO_APP_SENHA');
  });
});
