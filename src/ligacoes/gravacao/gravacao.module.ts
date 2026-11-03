import { Module } from '@nestjs/common';
import { AtividadesModule } from '../../atividades/atividades.module';
import { ContatosModule } from '../../contatos/contatos.module';
import { TranscricaoModule } from '../../transcricao/transcricao.module';
import { GravacaoController } from './gravacao.controller';
import { GravacaoService } from './gravacao.service';
import { LeituraDaGravacaoService } from './leitura-gravacao.service';
import { ReprocessamentoDaGravacaoService } from './reprocessamento-gravacao.service';
import { RetencaoDeGravacoesService } from './retencao-de-gravacoes.service';
import { SugestoesDeAtividadeService } from './sugestoes-de-atividade.service';

/**
 * Gravação, transcrição e resumo das ligações (R30): partes enviadas pelo navegador do atendente,
 * junção, áudio com `Range`, privacidade (LGPD), guarda com remoção diária, "Reprocessar" e
 * sugestões de atividade. O processamento (ffmpeg, whisper.cpp, Claude) é do `TranscricaoModule`.
 */
@Module({
  imports: [TranscricaoModule, ContatosModule, AtividadesModule],
  controllers: [GravacaoController],
  providers: [
    GravacaoService,
    LeituraDaGravacaoService,
    ReprocessamentoDaGravacaoService,
    SugestoesDeAtividadeService,
    RetencaoDeGravacoesService,
  ],
  exports: [GravacaoService, LeituraDaGravacaoService],
})
export class GravacaoModule {}
