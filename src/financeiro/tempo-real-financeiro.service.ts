import { Injectable } from '@nestjs/common';
import type { Parcela } from '../generated/prisma/client';
import { EVENTOS_DO_SERVIDOR, salas } from '../tempo-real/catalogo';
import type {
  CargaParcelaAtualizada,
  CargaReguaProgresso,
} from '../tempo-real/catalogo';
import { TempoRealService } from '../tempo-real/tempo-real.service';
import { hojeLocal, deDataDoBanco } from './datas';

/** Eventos efêmeros do Financeiro para quem gerencia (e o CS responsável). Chame depois do commit. */
@Injectable()
export class TempoRealFinanceiro {
  constructor(private readonly tempoReal: TempoRealService) {}

  parcela(
    parcela: Pick<
      Parcela,
      'id' | 'numero' | 'contratoId' | 'contatoId' | 'status' | 'vencimento'
    >,
    motivo: CargaParcelaAtualizada['motivo'],
    responsavelCsId?: string | null,
  ): void {
    const hoje = hojeLocal();
    const status =
      parcela.status === 'ABERTO' && deDataDoBanco(parcela.vencimento) < hoje
        ? 'ATRASADO'
        : parcela.status;
    this.tempoReal.emitir(
      this.salasDeGestao(responsavelCsId),
      EVENTOS_DO_SERVIDOR.PARCELA_ATUALIZADA,
      {
        parcelaId: parcela.id,
        numero: parcela.numero,
        contratoId: parcela.contratoId,
        contatoId: parcela.contatoId,
        status,
        motivo,
      },
    );
  }

  regua(carga: CargaReguaProgresso): void {
    this.tempoReal.emitir(
      this.salasDeGestao(),
      EVENTOS_DO_SERVIDOR.REGUA_PROGRESSO,
      carga,
    );
  }

  private salasDeGestao(responsavelCsId?: string | null): string[] {
    return [
      salas.papel('ADMIN'),
      salas.papel('C_LEVEL'),
      salas.papel('LIDER_CS'),
      ...(responsavelCsId ? [salas.usuario(responsavelCsId)] : []),
    ];
  }
}
