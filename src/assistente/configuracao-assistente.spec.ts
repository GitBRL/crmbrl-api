import type { AuditoriaService } from '../auditoria/auditoria.service';
import type { Ambiente } from '../config/ambiente';
import type { CriptografiaService } from '../comum/criptografia/criptografia.service';
import type { PrismaService } from '../prisma/prisma.service';
import { lerConfiguracaoAssistente } from './configuracao-assistente';
import { ConfiguracaoAssistenteService } from './configuracao-assistente.service';

describe('R25 — configuração do assistente', () => {
  it('R25.5 — padrões e valores inválidos voltam ao padrão', () => {
    expect(lerConfiguracaoAssistente(undefined)).toEqual({
      perguntasPorDia: 30,
      orcamentoMensalTokens: 20_000_000,
      destino: 'TICKETHUB',
      ticketHub: {
        url: null,
        urlPublica: null,
        email: null,
        senhaCifrada: null,
        prioridade: 'media',
        sistemaId: null,
      },
      webhook: {
        url: null,
        cabecalhosCifrados: null,
        segredoCifrado: null,
        modeloCorpo: null,
      },
    });
    const c = lerConfiguracaoAssistente({
      perguntasPorDia: -1,
      orcamentoMensalTokens: null,
      destino: 'EMAIL',
      ticketHub: { prioridade: 'urgente', sistemaId: 'x' },
    });
    expect(c.perguntasPorDia).toBe(30);
    expect(c.orcamentoMensalTokens).toBeNull();
    expect(c.destino).toBe('TICKETHUB');
    expect(c.ticketHub.prioridade).toBe('media');
    expect(c.ticketHub.sistemaId).toBeNull();
  });

  describe('destino TicketHub (credenciais do servidor)', () => {
    const servico = () =>
      new ConfiguracaoAssistenteService(
        {} as PrismaService,
        {} as AuditoriaService,
        {
          decifrar: (v: string) => v.replace('cifrada:', ''),
        } as unknown as CriptografiaService,
        {
          ticketHub: {
            url: 'https://tickets.interno',
            email: 'servico@brl',
            senha: () => 'senha-do-servidor',
          },
        } as unknown as Ambiente,
      );
    const config = (ticketHub: Record<string, unknown>) =>
      lerConfiguracaoAssistente({ destino: 'TICKETHUB', ticketHub });

    it('sem URL própria, usa a conta do servidor', () => {
      const r = servico().destinoDe(config({}));
      expect(r).toMatchObject({
        pronto: true,
        destino: { url: 'https://tickets.interno', senha: 'senha-do-servidor' },
      });
    });

    it('com outra URL e sem credenciais gravadas, não envia a senha do servidor', () => {
      const r = servico().destinoDe(config({ url: 'https://captura.exemplo' }));
      expect(r.pronto).toBe(false);
      expect(JSON.stringify(r)).not.toContain('senha-do-servidor');
    });

    it('com outra URL e só o e-mail gravado, também não usa a senha do servidor', () => {
      const r = servico().destinoDe(
        config({ url: 'https://captura.exemplo', email: 'a@b.com' }),
      );
      expect(r.pronto).toBe(false);
    });

    it('com outra URL e e-mail e senha gravados, usa os gravados', () => {
      const r = servico().destinoDe(
        config({
          url: 'https://outro.exemplo',
          email: 'a@b.com',
          senhaCifrada: 'cifrada:minha-senha',
        }),
      );
      expect(r).toMatchObject({
        pronto: true,
        destino: { email: 'a@b.com', senha: 'minha-senha' },
      });
    });
  });
});
