import { createHash, createHmac, pbkdf2Sync } from 'node:crypto';
import type pg from 'pg';
import {
  conferirSenhaDoDono,
  prepararPapelDaAplicacao,
  validarOpcoesDoPapel,
  verificadorScram,
} from './papel-da-aplicacao';

describe('papel da aplicação (R35.1)', () => {
  it('a senha vai ao banco como verificador SCRAM-SHA-256 (nunca o texto)', () => {
    const sal = Buffer.from('0123456789abcdef');
    const verificador = verificadorScram('senha-forte-de-teste-123', sal, 4096);
    const [cabeca, chaves] = verificador.split('$').slice(1);
    expect(verificador.startsWith('SCRAM-SHA-256$4096:')).toBe(true);
    expect(cabeca).toBe(`4096:${sal.toString('base64')}`);
    const salgada = pbkdf2Sync(
      'senha-forte-de-teste-123',
      sal,
      4096,
      32,
      'sha256',
    );
    const guardada = createHash('sha256')
      .update(createHmac('sha256', salgada).update('Client Key').digest())
      .digest('base64');
    const servidor = createHmac('sha256', salgada)
      .update('Server Key')
      .digest('base64');
    expect(chaves).toBe(`${guardada}:${servidor}`);
    expect(verificador).not.toContain('senha-forte');
  });

  it('valida nome e senha (a senha vai na URL: sem caracteres especiais)', () => {
    expect(
      validarOpcoesDoPapel({ nome: 'crmbrl_app', senha: 'a'.repeat(32) }),
    ).toEqual([]);
    expect(
      validarOpcoesDoPapel({ nome: 'CRM-App', senha: 'a'.repeat(32) }),
    ).toHaveLength(1);
    expect(
      validarOpcoesDoPapel({ nome: 'crmbrl_app', senha: 'curta' }),
    ).toHaveLength(1);
    expect(
      validarOpcoesDoPapel({
        nome: 'crmbrl_app',
        senha: 'com@arroba-e-espaco 1234',
      }),
    ).toHaveLength(1);
  });

  it('cria o papel sem superusuário nem BYPASSRLS, só DML, e a auditoria só com SELECT e INSERT', async () => {
    const enviados: string[] = [];
    const cliente = {
      query: jest.fn((texto: string) => {
        enviados.push(texto);
        if (texto.includes('current_user AS dono')) {
          return Promise.resolve({
            rows: [{ dono: 'crmbrl', banco: 'crmbrl' }],
          });
        }
        return Promise.resolve({ rows: [] });
      }),
    } as unknown as pg.ClientBase;
    const senha = 'senha-do-papel-0123456789';
    await expect(
      prepararPapelDaAplicacao(cliente, { nome: 'crmbrl_app', senha }),
    ).resolves.toEqual({ criado: true, donoDoBanco: 'crmbrl' });
    const sql = enviados.join('\n');
    expect(sql).toContain(
      'CREATE ROLE "crmbrl_app" WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS',
    );
    expect(sql).toContain("PASSWORD 'SCRAM-SHA-256$4096:");
    expect(sql).not.toContain(senha);
    expect(sql).toContain(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "crmbrl_app"',
    );
    expect(sql).toContain(
      'REVOKE INSERT, UPDATE, DELETE ON TABLE public."eventos_auditoria" FROM "crmbrl_app"',
    );
    expect(sql).toContain(
      'GRANT SELECT, INSERT ON TABLE public."eventos_auditoria" TO "crmbrl_app"',
    );
    expect(sql).toContain('REVOKE CREATE ON SCHEMA public FROM "crmbrl_app"');
    expect(sql).toContain(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES',
    );
    expect(sql).toContain(
      'CREATE SCHEMA IF NOT EXISTS "pgboss" AUTHORIZATION "crmbrl_app"',
    );
    expect(enviados.at(-1)).toBe('COMMIT');
  });

  it('recusa usar o próprio dono como papel da aplicação', async () => {
    const cliente = {
      query: jest.fn(() =>
        Promise.resolve({ rows: [{ dono: 'crmbrl_app', banco: 'x' }] }),
      ),
    } as unknown as pg.ClientBase;
    await expect(
      prepararPapelDaAplicacao(cliente, {
        nome: 'crmbrl_app',
        senha: 'b'.repeat(20),
      }),
    ).rejects.toThrow(/dono/);
  });

  it('U4 + R35.1: em produção, o dono com a senha de desenvolvimento recusa (ou só avisa com o escape), sem mostrar senha', () => {
    const fraca = 'postgresql://crmbrl:crmbrl@banco:5432/crmbrl';
    const forte = 'postgresql://crmbrl:Xy7-forte-do-dono-99@banco:5432/crmbrl';
    expect(
      conferirSenhaDoDono(fraca, { producao: false, permitir: false }),
    ).toEqual({});
    expect(
      conferirSenhaDoDono(forte, { producao: true, permitir: false }),
    ).toEqual({});
    const recusa = conferirSenhaDoDono(fraca, {
      producao: true,
      permitir: false,
    });
    expect(recusa.problema).toMatch(/DATABASE_URL_MIGRACAO/);
    expect(recusa.problema).toMatch(/PERMITIR_SEGREDOS_DE_DESENVOLVIMENTO/);
    const aviso = conferirSenhaDoDono(fraca, {
      producao: true,
      permitir: true,
    });
    expect(aviso.problema).toBeUndefined();
    expect(aviso.aviso).toMatch(/^ATENÇÃO:/);
    expect(
      conferirSenhaDoDono('não é url', { producao: true, permitir: false }),
    ).toEqual({});
  });
});
