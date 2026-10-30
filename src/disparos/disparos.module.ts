import { Module } from '@nestjs/common';

/**
 * Disparos (R17, contrato da Onda B §2.3): campanhas com público por segmento
 * (`SegmentosService`) ou lista importada, mensagem por modelo
 * (`ModelosService`, semente = id do destinatário), rodízio de números, ritmo
 * anti-banimento, janela de envio, respostas e opt-out pelos gatilhos
 * (`GatilhosService.registrarDestino`), relatório e exportação. Também o CRUD de
 * `ModeloMensagem` (rota `/modelos-mensagem`) e a configuração `disparos`.
 *
 * Esqueleto da base (`base-api-b`): o `disparos-api` preenche. O schema
 * (`Campanha`, `CampanhaCanal`, `CampanhaDestinatario`, `ModeloMensagem`,
 * `Configuracao`) já existe.
 */
@Module({
  controllers: [],
  providers: [],
  exports: [],
})
export class DisparosModule {}
