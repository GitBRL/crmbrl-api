import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { listarProblemas } from '../../comum/validacao/validacao';
import { FiltroAuditoriaDto } from './auditoria-consulta.dto';
import {
  aparar,
  ehDataComFuso,
  paraBooleano,
  paraData,
  paraLista,
} from './filtro-de-consulta.dto';

function validar(consulta: Record<string, unknown>) {
  const filtro = plainToInstance(FiltroAuditoriaDto, consulta);
  const problemas = listarProblemas(
    validateSync(filtro, { whitelist: true, forbidNonWhitelisted: true }),
  );
  return { filtro, problemas };
}

describe('FiltroAuditoriaDto', () => {
  it('R3.4 — listas pela vírgula ou pelo parâmetro repetido, booleano e limite', () => {
    const { filtro, problemas } = validar({
      acao: ['negocio.movido, negocio.ganho', 'usuario.login'],
      tipoAtor: 'USUARIO,WEBHOOK',
      incluirRelacionados: 'true',
      entidade: ' contato ',
      entidadeId: 'abc',
      limite: '10',
      texto: '  ',
    });
    expect(problemas).toEqual([]);
    expect(filtro).toMatchObject({
      acao: ['negocio.movido', 'negocio.ganho', 'usuario.login'],
      tipoAtor: ['USUARIO', 'WEBHOOK'],
      incluirRelacionados: true,
      entidade: 'contato',
      limite: 10,
      texto: undefined,
    });
  });

  it('padrões: 50 por página, sem relacionados', () => {
    const { filtro, problemas } = validar({});
    expect(problemas).toEqual([]);
    expect(filtro.limite).toBe(50);
    expect(filtro.incluirRelacionados).toBe(false);
  });

  it('recusa datas sem fuso, tipo de ator desconhecido, limite acima de 100 e campo estranho', () => {
    const { problemas } = validar({
      de: '2026-10-20T10:00:00',
      ate: '2026-13-01',
      tipoAtor: 'ROBO',
      limite: '101',
      usuarioId: 'nao-e-uuid',
      ordem: 'asc',
    });
    const porCampo = Object.fromEntries(
      problemas.map(({ campo, mensagens }) => [campo, mensagens]),
    );
    expect(porCampo).toEqual({
      de: ['deve ser uma data ISO 8601 com fuso (ex.: 2026-10-20T03:00:00Z)'],
      ate: ['deve ser uma data ISO 8601 com fuso (ex.: 2026-10-20T03:00:00Z)'],
      tipoAtor: [
        '(cada item) deve ser um destes valores: USUARIO, SISTEMA, WEBHOOK, AUTOMACAO, IA',
      ],
      limite: ['deve ser no máximo 100'],
      usuarioId: ['deve ser um identificador (UUID) válido'],
      ordem: ['não é um campo aceito'],
    });
  });
});

describe('conversores da query', () => {
  it('paraLista', () => {
    expect(paraLista({ value: undefined })).toBeUndefined();
    expect(paraLista({ value: 'a, b,,c' })).toEqual(['a', 'b', 'c']);
    expect(paraLista({ value: ['a', 'b,c'] })).toEqual(['a', 'b', 'c']);
    expect(paraLista({ value: '' })).toEqual([]);
  });

  it('paraBooleano', () => {
    expect(paraBooleano({ value: 'true' })).toBe(true);
    expect(paraBooleano({ value: '1' })).toBe(true);
    expect(paraBooleano({ value: 'false' })).toBe(false);
    expect(paraBooleano({ value: '0' })).toBe(false);
    expect(paraBooleano({ value: 'talvez' })).toBe('talvez');
  });

  it('aparar', () => {
    expect(aparar({ value: '  x ' })).toBe('x');
    expect(aparar({ value: '   ' })).toBeUndefined();
    expect(aparar({ value: 3 })).toBe(3);
  });

  it('paraData devolve o "+" do fuso que chegou como espaço', () => {
    expect(paraData({ value: ' 2026-10-20T03:00:00 03:00 ' })).toBe(
      '2026-10-20T03:00:00+03:00',
    );
    expect(paraData({ value: '2026-10-20T03:00:00-03:00' })).toBe(
      '2026-10-20T03:00:00-03:00',
    );
    expect(paraData({ value: '' })).toBeUndefined();
  });

  it('datas ISO 8601: só a data, ou com fuso; calendário válido', () => {
    expect(ehDataComFuso('2026-10-20')).toBe(true);
    expect(ehDataComFuso('2026-10-20T03:00Z')).toBe(true);
    expect(ehDataComFuso('2026-10-20T03:00:00.123Z')).toBe(true);
    expect(ehDataComFuso('2026-10-20T03:00:00-03:00')).toBe(true);
    expect(ehDataComFuso('2026-10-20T03:00:00')).toBe(false);
    expect(ehDataComFuso('2026-02-30')).toBe(false);
    expect(ehDataComFuso('20/10/2026')).toBe(false);
    expect(ehDataComFuso(20261020)).toBe(false);
  });
});
