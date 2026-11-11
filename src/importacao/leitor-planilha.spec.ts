import { PassThrough } from 'node:stream';
import ExcelJS from 'exceljs';
import {
  dividirCsv,
  detectarSeparador,
  lerPlanilha,
  PlanilhaIlegivelError,
} from './leitor-planilha';

describe('Leitura de planilhas (R16.2)', () => {
  it('R16.2 — CSV com aspas, vírgula, aspas dobradas e quebra de linha dentro do campo', () => {
    const registros = dividirCsv(
      'a,b\r\n"x, y","diz ""oi"""\n"linha\nquebrada",z\n',
      ',',
    );
    expect(registros).toEqual([
      ['a', 'b'],
      ['x, y', 'diz "oi"'],
      ['linha\nquebrada', 'z'],
    ]);
  });

  it('R16.2 — detecta o separador (ponto e vírgula do Excel brasileiro)', () => {
    expect(detectarSeparador('Nome;E-mail;Telefone\nAna;a@a.com;11')).toBe(';');
    expect(detectarSeparador('"a;b",c,d\n')).toBe(',');
    expect(detectarSeparador('a\tb\tc\n')).toBe('\t');
  });

  it('R16.2 — lê o CSV: cabeçalho na linha 1, linhas vazias descartadas, números de linha do arquivo', async () => {
    const csv = '﻿Nome;E-mail\nAna;ana@x.com\n;\n\nBruno;bruno@x.com\n';
    const planilha = await lerPlanilha(Buffer.from(csv, 'utf-8'), 'csv');
    expect(planilha.colunas).toEqual(['Nome', 'E-mail']);
    expect(planilha.linhas).toEqual([
      { numero: 2, valores: ['Ana', 'ana@x.com'] },
      { numero: 5, valores: ['Bruno', 'bruno@x.com'] },
    ]);
    expect(planilha.leitura).toMatchObject({
      separador: ';',
      codificacao: 'utf-8',
    });
  });

  it('R16.2 — cai para latin1 quando o arquivo não é UTF-8', async () => {
    const planilha = await lerPlanilha(
      Buffer.from('Nome,Cargo\nJosé,Diretor Técnico\n', 'latin1'),
      'csv',
    );
    expect(planilha.leitura.codificacao).toBe('latin1');
    expect(planilha.linhas[0].valores).toEqual(['José', 'Diretor Técnico']);
  });

  it('R16.2 — cabeçalhos vazios e repetidos ganham nome único', async () => {
    const planilha = await lerPlanilha(
      Buffer.from('Nome,,Nome\nA,B,C\n'),
      'csv',
    );
    expect(planilha.colunas).toEqual(['Nome', 'Coluna 2', 'Nome (2)']);
  });

  it('R16.2 — cabeçalho vazio é recusado', async () => {
    await expect(
      lerPlanilha(Buffer.from('\n\n'), 'csv'),
    ).rejects.toBeInstanceOf(PlanilhaIlegivelError);
  });

  it('R16.2 — lê o XLSX: telefone numérico sem notação científica e datas em ISO', async () => {
    const livro = new ExcelJS.Workbook();
    const aba = livro.addWorksheet('Contatos');
    aba.addRow(['Nome', 'Telefone', 'Nascimento']);
    aba.addRow(['Ana', 5511987654321, new Date(Date.UTC(1990, 4, 17))]);
    const buffer = Buffer.from(await livro.xlsx.writeBuffer());
    const planilha = await lerPlanilha(buffer, 'xlsx');
    expect(planilha.colunas).toEqual(['Nome', 'Telefone', 'Nascimento']);
    expect(planilha.linhas).toEqual([
      { numero: 2, valores: ['Ana', '5511987654321', '1990-05-17'] },
    ]);
    expect(planilha.leitura.abas).toEqual(['Contatos']);
    await expect(
      lerPlanilha(buffer, 'xlsx', { aba: 'Outra' }),
    ).rejects.toBeInstanceOf(PlanilhaIlegivelError);
    await expect(
      lerPlanilha(Buffer.from('não é xlsx'), 'xlsx'),
    ).rejects.toBeInstanceOf(PlanilhaIlegivelError);
  });

  async function xlsxEmFluxo(
    cabecalho: (string | undefined)[],
    linhas: number,
  ): Promise<Buffer> {
    const pedacos: Buffer[] = [];
    const saida = new PassThrough();
    saida.on('data', (p: Buffer) => pedacos.push(p));
    const livro = new ExcelJS.stream.xlsx.WorkbookWriter({
      stream: saida,
      useSharedStrings: false,
    });
    const aba = livro.addWorksheet('a');
    aba.addRow(cabecalho).commit();
    for (let i = 0; i < linhas; i++) {
      aba.addRow([`Pessoa ${i}`, `p${i}@ex.com`]).commit();
    }
    await livro.commit();
    return Buffer.concat(pedacos);
  }

  it('R16.2 — planilha "larga" (célula em XFD1) é recusada sem estourar a memória', async () => {
    const cabecalho: (string | undefined)[] = ['nome', 'email'];
    cabecalho[16383] = 'x';
    const buffer = await xlsxEmFluxo(cabecalho, 100);
    await expect(lerPlanilha(buffer, 'xlsx')).rejects.toThrow(/colunas/);
  });

  it('R16.2 — célula solta fora do cabeçalho não alarga as linhas', async () => {
    const buffer = await xlsxEmFluxo(['nome', 'email'], 3);
    const planilha = await lerPlanilha(buffer, 'xlsx');
    expect(planilha.colunas).toEqual(['nome', 'email']);
    expect(planilha.linhas).toHaveLength(3);
  });

  it('R16.2 — mais de 50 mil linhas é recusado durante a leitura', async () => {
    const buffer = await xlsxEmFluxo(['nome', 'email'], 50_001);
    await expect(lerPlanilha(buffer, 'xlsx')).rejects.toThrow(/50\.000 linhas/);
    const ok = await xlsxEmFluxo(['nome', 'email'], 50_000);
    expect((await lerPlanilha(ok, 'xlsx')).linhas).toHaveLength(50_000);
  }, 60_000);

  it('R16.13 — sem cabeçalho: Coluna 1…N pela maior largura e a linha 1 é dado', async () => {
    const csv = Buffer.from('Ana,a@a.com\nBia,b@b.com,11999999999\n');
    const lida = await lerPlanilha(csv, 'csv', { semCabecalho: true });
    expect(lida.colunas).toEqual(['Coluna 1', 'Coluna 2', 'Coluna 3']);
    expect(lida.linhas.map((l) => l.numero)).toEqual([1, 2]);
    expect(lida.linhas[0].valores).toEqual(['Ana', 'a@a.com', '']);
    expect(lida.leitura.semCabecalho).toBe(true);
  });

  it('R16.13 — sem cabeçalho no XLSX', async () => {
    const livro = new ExcelJS.Workbook();
    const aba = livro.addWorksheet('Plan1');
    aba.addRow(['Ana', 'a@a.com']);
    aba.addRow(['Bia', 'b@b.com', 'x']);
    const buffer = Buffer.from(await livro.xlsx.writeBuffer());
    const lida = await lerPlanilha(buffer, 'xlsx', { semCabecalho: true });
    expect(lida.colunas).toEqual(['Coluna 1', 'Coluna 2', 'Coluna 3']);
    expect(lida.linhas).toHaveLength(2);
    expect(lida.linhas[0].valores[0]).toBe('Ana');
  });
});
