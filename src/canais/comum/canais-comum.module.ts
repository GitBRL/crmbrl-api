import { Module } from '@nestjs/common';
import { ArquivosPublicos } from './arquivos-publicos';
import { ConfiguracaoDeCanais } from './configuracao-de-canais.service';
import { LimitadorDeRequisicoes } from './limitador';
import { SegredosDoCanal } from './segredos-do-canal';

/**
 * Apoio comum dos canais extras (chat do site, e-mail, Meta): segredos
 * cifrados, configuração com auditoria e o limite de requisições das rotas
 * públicas. Importado por `WebchatModule`, `EmailCanalModule` e `MetaModule`.
 */
@Module({
  providers: [
    SegredosDoCanal,
    ConfiguracaoDeCanais,
    LimitadorDeRequisicoes,
    ArquivosPublicos,
  ],
  exports: [
    SegredosDoCanal,
    ConfiguracaoDeCanais,
    LimitadorDeRequisicoes,
    ArquivosPublicos,
  ],
})
export class CanaisComumModule {}
