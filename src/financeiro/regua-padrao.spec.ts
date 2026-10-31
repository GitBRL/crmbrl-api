import { validarModelo } from '../comum/modelos/modelos';
import { MARCOS_PADRAO, VARIAVEIS_DO_TITULO } from './financeiro.constantes';
import {
  ETAPAS_PADRAO,
  TEXTO_PROMESSA_CONFIRMADA_PADRAO,
  TEXTO_PROMESSA_NAO_CUMPRIDA_PADRAO,
} from './regua-padrao';
import {
  naoContatarPorWhatsapp,
  variaveisDoTitulo,
} from './regua-envio.service';
import { Prisma } from '../generated/prisma/client';
import {
  lerConfiguracaoDaRegua,
  rotuloDoMarco,
} from './regua-configuracao.service';

describe('Financeiro — régua (R24.1)', () => {
  it('R24.1 — as etapas padrão seguem D-7, D-3, D0, D+3, D+5, D+7, D+15, D+30, D+45 e D+60', () => {
    expect(ETAPAS_PADRAO.map((e) => e.marco)).toEqual([...MARCOS_PADRAO]);
    expect(MARCOS_PADRAO.map(rotuloDoMarco)).toEqual([
      'D-7',
      'D-3',
      'D0',
      'D+3',
      'D+5',
      'D+7',
      'D+15',
      'D+30',
      'D+45',
      'D+60',
    ]);
  });

  it('R24.1 — todos os textos padrão usam só variáveis conhecidas', () => {
    const textos = [
      TEXTO_PROMESSA_CONFIRMADA_PADRAO,
      TEXTO_PROMESSA_NAO_CUMPRIDA_PADRAO,
      ...ETAPAS_PADRAO.flatMap((e) => [
        e.textoWhatsapp,
        e.assuntoEmail,
        e.textoEmail,
      ]),
    ].filter((t): t is string => !!t);
    for (const t of textos) {
      expect(
        validarModelo(t, {
          variaveisExtras: VARIAVEIS_DO_TITULO,
          permitirVariaveisDaExecucao: false,
        }).erros,
      ).toEqual([]);
    }
  });

  it('R24.1 — as etapas com ligação trazem roteiro e canal de mensagem', () => {
    for (const e of ETAPAS_PADRAO.filter((x) => x.ligacao)) {
      expect(e.roteiroLigacao).toBeTruthy();
    }
  });

  it('R24.1 — formata as variáveis do título', () => {
    const v = variaveisDoTitulo(
      {
        numero: 'T-1',
        valor: new Prisma.Decimal('1234.5'),
        vencimento: new Date('2026-11-05T00:00:00.000Z'),
        descricao: null,
        linkBoleto: null,
        linkPagamento: 'https://x.co/p',
        pix: null,
        promessaAte: null,
      },
      'Plano Pro',
      '2026-11-10',
      '2026-11-20',
    );
    expect(v['titulo.valor']).toBe('1.234,50');
    expect(v['titulo.vencimento']).toBe('05/11/2026');
    expect(v['titulo.dias_atraso']).toBe('5');
    expect(v['titulo.promessa']).toBe('20/11/2026');
    expect(v['titulo.link_boleto']).toBe('');
    expect(v['contrato.produto']).toBe('Plano Pro');
  });

  it('R24.7 — respeita a marca "não contatar por WhatsApp" (etiqueta ou campo)', () => {
    expect(
      naoContatarPorWhatsapp({
        etiquetas: ['nao-contatar-whatsapp'],
        camposPersonalizados: {},
      }),
    ).toBe(true);
    expect(
      naoContatarPorWhatsapp({
        etiquetas: [],
        camposPersonalizados: { nao_contatar_whatsapp: 'sim' },
      }),
    ).toBe(true);
    expect(
      naoContatarPorWhatsapp({
        etiquetas: [],
        camposPersonalizados: { nao_contatar_whatsapp: true },
      }),
    ).toBe(true);
    expect(
      naoContatarPorWhatsapp({
        etiquetas: [],
        camposPersonalizados: { nao_contatar_whatsapp: 'nao' },
      }),
    ).toBe(false);
    expect(
      naoContatarPorWhatsapp({
        etiquetas: ['marketing'],
        camposPersonalizados: {},
      }),
    ).toBe(false);
  });

  it('R24.2 — a configuração tem padrões (09:00, tolerância de 3 dias, limite das ligações 17:00)', () => {
    const c = lerConfiguracaoDaRegua(undefined);
    expect(c).toMatchObject({
      ativa: true,
      horario: '09:00',
      toleranciaDias: 3,
      horarioLimiteLigacoes: '17:00',
      pausada: false,
    });
    expect(
      lerConfiguracaoDaRegua({ horario: '25:99', toleranciaDias: -1 }),
    ).toMatchObject({ horario: '09:00', toleranciaDias: 3 });
  });
});
