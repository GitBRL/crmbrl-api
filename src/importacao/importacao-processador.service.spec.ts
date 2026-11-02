import { DadosInvalidosException } from '../comum/erros/excecoes';
import {
  camposDe,
  dividirEtiquetas,
  ehErroDeDados,
  motivoDoErro,
} from './importacao-processador.service';
import { formatoDoArquivo } from './importacao.service';

describe('Importação — regras puras (R16)', () => {
  it('R16.5 — etiquetas da célula separadas por vírgula, ponto e vírgula ou barra', () => {
    expect(dividirEtiquetas('vip, lead ; feira|  ')).toEqual([
      'vip',
      'lead',
      'feira',
    ]);
    expect(dividirEtiquetas(undefined)).toEqual([]);
  });

  it('R16.5 — campos personalizados saem do prefixo campos.', () => {
    expect(
      camposDe({ nome: 'A', 'campos.cidade': 'Recife', 'utm.source': 'x' }),
    ).toEqual({ cidade: 'Recife' });
  });

  it('R16.6 — erro de dados vira o motivo da linha; erro de infraestrutura propaga', () => {
    const erro = new DadosInvalidosException('Dados inválidos.', {
      campos: [{ campo: 'email', mensagens: ['formato inválido'] }],
    });
    expect(ehErroDeDados(erro)).toBe(true);
    expect(motivoDoErro(erro)).toBe(
      'Dados inválidos. (email: formato inválido)',
    );
    expect(motivoDoErro(new TypeError('CNPJ inválido: 1'))).toBe(
      'CNPJ inválido: 1',
    );
    expect(ehErroDeDados(new Error('conexão perdida'))).toBe(false);
  });

  it('R16.2 — só CSV e XLSX', () => {
    expect(formatoDoArquivo('x.CSV', 'text/plain')).toBe('csv');
    expect(formatoDoArquivo('x.xlsx', 'application/octet-stream')).toBe('xlsx');
    expect(formatoDoArquivo('x.pdf', 'application/pdf')).toBeNull();
  });
});
