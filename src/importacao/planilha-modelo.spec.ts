import ExcelJS from 'exceljs';
import type { TipoImportacao } from '../generated/prisma/client';
import { camposDoTipo, sugerirMapeamento } from './campos';
import { lerPlanilha } from './leitor-planilha';
import { ABA_DE_AJUDA, gerarPlanilhaModelo } from './planilha-modelo';
import {
  lerDataDaPlanilha,
  lerValorDaPlanilha,
} from '../financeiro/campos-de-parcela';

const TIPOS: TipoImportacao[] = ['CONTATOS', 'EMPRESAS', 'PARCELAS'];

describe('Planilha modelo (R16.10)', () => {
  it.each(TIPOS)(
    'R16.10 — %s: o leitor da importação vê só o cabeçalho, com os rótulos dos campos',
    async (tipo) => {
      const modelo = await gerarPlanilhaModelo(tipo);
      const lida = await lerPlanilha(modelo, 'xlsx');
      expect(lida.colunas).toEqual(camposDoTipo(tipo).map((c) => c.rotulo));
      expect(lida.linhas).toEqual([]);
    },
  );

  it.each(TIPOS)(
    'R16.10 — %s: o mapeamento é sugerido sozinho para todas as colunas',
    async (tipo) => {
      const lida = await lerPlanilha(await gerarPlanilhaModelo(tipo), 'xlsx');
      const mapeamento = sugerirMapeamento(tipo, lida.colunas);
      const esperado = Object.fromEntries(
        camposDoTipo(tipo).map((c) => [c.rotulo, c.chave]),
      );
      expect(mapeamento).toEqual(esperado);
    },
  );

  it.each(TIPOS)(
    'R16.10 — %s: tem a aba "Como preencher" com uma linha por campo',
    async (tipo) => {
      const livro = new ExcelJS.Workbook();
      await livro.xlsx.load((await gerarPlanilhaModelo(tipo)) as never);
      expect(livro.worksheets[1].name).toBe(ABA_DE_AJUDA);
      const campos = camposDoTipo(tipo);
      campos.forEach((campo, i) => {
        const linha = livro.worksheets[1].getRow(i + 2);
        expect(linha.getCell(1).value).toBe(campo.rotulo);
        expect(linha.getCell(2).value).toBe(campo.obrigatorio ? 'Sim' : 'Não');
        expect(linha.getCell(3).text).not.toBe('');
      });
    },
  );

  async function preencher(
    tipo: TipoImportacao,
    valores: Record<string, ExcelJS.CellValue>,
  ) {
    const livro = new ExcelJS.Workbook();
    await livro.xlsx.load((await gerarPlanilhaModelo(tipo)) as never);
    const aba = livro.worksheets[0];
    const campos = camposDoTipo(tipo);
    campos.forEach((campo, i) => {
      if (campo.chave in valores) {
        aba.getRow(2).getCell(i + 1).value = valores[campo.chave];
      }
    });
    const reescrito = Buffer.from(await livro.xlsx.writeBuffer());
    const lida = await lerPlanilha(reescrito, 'xlsx');
    return Object.fromEntries(
      campos.map((c, i) => [c.chave, lida.linhas[0].valores[i]]),
    );
  }

  it('R16.10 — contatos: telefone e demais textos voltam intactos', async () => {
    const v = await preencher('CONTATOS', {
      nome: 'Maria Souza',
      email: 'maria@exemplo.com.br',
      telefone: '61999990000',
      etiquetas: 'cliente, indicação',
    });
    expect(v).toMatchObject({
      nome: 'Maria Souza',
      telefone: '61999990000',
      etiquetas: 'cliente, indicação',
    });
  });

  it('R16.10 — empresas: CNPJ com zero à esquerda volta intacto', async () => {
    const v = await preencher('EMPRESAS', {
      nome: 'Exemplo Ltda',
      cnpj: '00123456000100',
    });
    expect(v.cnpj).toBe('00123456000100');
  });

  it('R16.10 — parcelas: número com zeros, data e valor são aceitos pelo processador', async () => {
    const v = await preencher('PARCELAS', {
      numero: '000123',
      vencimento: new Date(Date.UTC(2026, 11, 10)),
      valor: 1234.56,
      pagoEm: '05/12/2026',
      valorPago: '1.234,56',
    });
    expect(v.numero).toBe('000123');
    expect(lerDataDaPlanilha(v.vencimento)).toBe('2026-12-10');
    expect(lerValorDaPlanilha(v.valor)).toBe('1234.56');
    expect(lerDataDaPlanilha(v.pagoEm)).toBe('2026-12-05');
    expect(lerValorDaPlanilha(v.valorPago)).toBe('1234.56');
  });
});
