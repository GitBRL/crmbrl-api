import { Module } from '@nestjs/common';
import {
  ChamadaClaudeService,
  OPCOES_CHAMADA_CLAUDE,
  type OpcoesDaChamada,
} from '../bi/analise/chamada-claude.service';
import { PROVIDER_CLIENTE_ANTHROPIC } from '../bi/analise/cliente-anthropic';
import { ClienteWhisper } from './cliente-whisper';
import { ProcessadorDeAudio, ProcessadorFfmpeg } from './processador-de-audio';
import {
  ESPERA_ENTRE_TENTATIVAS_S,
  TIMEOUT_DO_RESUMO_MS,
} from './transcricao.constantes';
import { TranscricaoService } from './transcricao.service';

/** Uma chamada ao Claude por resumo: duas tentativas (a segunda, em falha transitória). */
const OPCOES_DO_RESUMO: OpcoesDaChamada = {
  timeoutMs: TIMEOUT_DO_RESUMO_MS,
  esperaMs: Math.min(ESPERA_ENTRE_TENTATIVAS_S, 5) * 1000,
  tentativas: 2,
};

/**
 * Transcrição e resumo das ligações (R30): fila `transcricao.processar` (ffmpeg + whisper.cpp,
 * uma por vez) e `transcricao.resumir` (Claude, o mesmo cliente do BI e do assistente). Nos testes,
 * `ProcessadorDeAudio` e `CLIENTE_ANTHROPIC` são trocados por falsos e o whisper é um servidor em processo.
 */
@Module({
  providers: [
    TranscricaoService,
    ClienteWhisper,
    { provide: ProcessadorDeAudio, useClass: ProcessadorFfmpeg },
    ChamadaClaudeService,
    PROVIDER_CLIENTE_ANTHROPIC,
    { provide: OPCOES_CHAMADA_CLAUDE, useValue: OPCOES_DO_RESUMO },
  ],
  exports: [TranscricaoService, ClienteWhisper],
})
export class TranscricaoModule {}
