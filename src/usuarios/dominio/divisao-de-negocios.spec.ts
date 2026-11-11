import { dividirNegocios } from './divisao-de-negocios';

const pessoa = (
  id: string,
  papel: 'ADMIN' | 'C_LEVEL' | 'LIDER' | 'MEMBRO',
  area: string | null,
  ativo = true,
) => ({ id, papel, area, ativo });

const comercial = { id: 'f-com', nome: 'Comercial', area: 'COMERCIAL' };
const cs = { id: 'f-cs', nome: 'Customer Success', area: 'CS' };
const pos = { id: 'f-pos', nome: 'Pós-venda', area: 'POS_VENDA' };

const admin = pessoa('admin', 'ADMIN', null);
const cLevel = pessoa('clevel', 'C_LEVEL', null);
const liderCom = pessoa('lider-com', 'LIDER', 'COMERCIAL');
const liderCsInativo = pessoa('lider-cs-velho', 'LIDER', 'CS', false);
const liderCs = pessoa('lider-cs', 'LIDER', 'CS');
const membro = pessoa('membro', 'MEMBRO', 'COMERCIAL');

describe('divisão dos negócios no desligamento (ajuste da R7.3, R5.13)', () => {
  it('R7.3 — o destinatário fica com os funis em que atua; os outros vão para o líder ativo do setor dono', () => {
    const partes = dividirNegocios({
      negocios: [
        { id: 'n1', funil: comercial },
        { id: 'n2', funil: cs },
        { id: 'n3', funil: comercial },
        { id: 'n4', funil: cs },
      ],
      destinatario: liderCom,
      desligadoId: membro.id,
      executor: admin,
      usuarios: [admin, cLevel, liderCom, liderCsInativo, liderCs, membro],
      destinatarioAtua: (funil) => funil.area === 'COMERCIAL',
    });
    expect(
      partes.map((p) => [p.destinatario.id, p.motivo, p.negocioIds, p.funis]),
    ).toEqual([
      ['lider-com', 'DESTINATARIO', ['n1', 'n3'], [comercial]],
      ['lider-cs', 'LIDER_DO_SETOR_DO_FUNIL', ['n2', 'n4'], [cs]],
    ]);
  });

  it('R7.3/R7.2 — sem líder ativo no setor do funil, um C-level ativo; sem C-level, o Admin que executa', () => {
    const base = {
      negocios: [{ id: 'n1', funil: pos }],
      destinatario: liderCom,
      desligadoId: membro.id,
      executor: admin,
      destinatarioAtua: () => false,
    };
    expect(
      dividirNegocios({ ...base, usuarios: [admin, cLevel, liderCom] })[0],
    ).toMatchObject({ destinatario: cLevel, motivo: 'C_LEVEL' });
    expect(
      dividirNegocios({
        ...base,
        usuarios: [admin, pessoa('clevel', 'C_LEVEL', null, false), liderCom],
      })[0],
    ).toMatchObject({ destinatario: admin, motivo: 'ADMIN' });
  });

  it('R7.3 — o próprio desligado nunca recebe, e a parte do destinatário vem primeiro', () => {
    const partes = dividirNegocios({
      negocios: [
        { id: 'n1', funil: cs },
        { id: 'n2', funil: comercial },
      ],
      destinatario: liderCom,
      desligadoId: liderCs.id,
      executor: admin,
      usuarios: [admin, liderCs, liderCom],
      destinatarioAtua: (funil) => funil.area === 'COMERCIAL',
    });
    expect(
      partes.map((p) => [p.destinatario.id, p.motivo, p.negocioIds]),
    ).toEqual([
      ['lider-com', 'DESTINATARIO', ['n2']],
      ['admin', 'ADMIN', ['n1']],
    ]);
  });
});
