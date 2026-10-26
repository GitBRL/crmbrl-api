import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  CABECALHO_ATOR,
  decodificarAtor,
  type EstadoDoNumero,
  gerarIdDeMensagemWhatsapp,
  jidDoTelefone,
  type ResultadoDaVerificacao,
} from '../../canais/whatsapp/contrato-gateway';
import { normalizarTelefone } from '../../comum/dominio/telefone';
import {
  DadosInvalidosException,
  NaoEncontradoException,
} from '../../comum/erros/excecoes';
import { ParseIdPipe } from '../../comum/validacao/parse-id.pipe';
import {
  GerenciadorDeNumeros,
  tipoPelaMidia,
} from '../gerenciador-de-numeros.service';
import {
  DesconectarNoGatewayDto,
  DigitandoNoGatewayDto,
  EntradaDoSimuladorDto,
  VerificarNumeroNoGatewayDto,
} from './gateway.dto';
import { SemTokenInterno } from './token-interno.guard';

/**
 * HTTP interno do gateway de WhatsApp (rotas em `ROTAS_DO_GATEWAY`). Só na rede
 * do compose, com o token interno (menos a saúde). Conectar e desconectar
 * gravam a auditoria em nome de quem pediu na API (cabeçalho `x-ator`).
 */
@Controller()
export class GatewayController {
  constructor(private readonly numeros: GerenciadorDeNumeros) {}

  /** Healthcheck do container: 200 com o banco e a fila de pé; 503 senão. */
  @Get('saude')
  @SemTokenInterno()
  async saude(@Res() resposta: Response): Promise<void> {
    const saude = await this.numeros.saude();
    resposta
      .status(
        saude.status === 'ok' ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE,
      )
      .set('Cache-Control', 'no-store')
      .json(saude);
  }

  @Post('numeros/:id/conectar')
  @HttpCode(HttpStatus.ACCEPTED)
  conectar(
    @Param('id', ParseIdPipe) id: string,
    @Headers(CABECALHO_ATOR) ator?: string,
  ): Promise<EstadoDoNumero> {
    return this.numeros.conectar(id, decodificarAtor(ator));
  }

  @Post('numeros/:id/desconectar')
  @HttpCode(HttpStatus.OK)
  desconectar(
    @Param('id', ParseIdPipe) id: string,
    @Body() corpo: DesconectarNoGatewayDto,
    @Headers(CABECALHO_ATOR) ator?: string,
  ): Promise<EstadoDoNumero> {
    return this.numeros.desconectar(
      id,
      { sair: corpo.sair },
      decodificarAtor(ator),
    );
  }

  @Get('numeros/:id/status')
  status(@Param('id', ParseIdPipe) id: string): Promise<EstadoDoNumero> {
    return this.numeros.estado(id);
  }

  @Post('numeros/:id/verificar')
  @HttpCode(HttpStatus.OK)
  verificar(
    @Param('id', ParseIdPipe) id: string,
    @Body() corpo: VerificarNumeroNoGatewayDto,
  ): Promise<ResultadoDaVerificacao> {
    return this.numeros.verificar(id, corpo.telefone);
  }

  /** "Digitando…" do atendente para o contato (melhor esforço: 204 mesmo desconectado). */
  @Post('numeros/:id/digitando')
  @HttpCode(HttpStatus.NO_CONTENT)
  async digitando(
    @Param('id', ParseIdPipe) id: string,
    @Body() corpo: DigitandoNoGatewayDto,
  ): Promise<void> {
    await this.numeros.digitando(id, corpo.para, corpo.ativo);
  }

  /** Injeta uma mensagem "recebida" pelo número conectado (só no modo simulado). */
  @Post('simulador/receber')
  @HttpCode(HttpStatus.ACCEPTED)
  async receberSimulada(
    @Body() corpo: EntradaDoSimuladorDto,
  ): Promise<{ idExterno: string }> {
    if (!this.numeros.simulado) {
      throw new NaoEncontradoException(
        'O simulador só existe com WHATSAPP_SIMULADO=true.',
      );
    }
    const telefone = normalizarTelefone(corpo.de);
    if (!telefone.valido) {
      throw new DadosInvalidosException(telefone.motivo, {
        campos: [{ campo: 'de', mensagens: [telefone.motivo] }],
      });
    }
    if (!corpo.texto && !corpo.midia) {
      throw new DadosInvalidosException('Informe o texto ou a mídia.');
    }
    const midia = corpo.midia
      ? {
          conteudo: Buffer.from(corpo.midia.base64, 'base64'),
          nome: corpo.midia.nome,
          mime: corpo.midia.mime,
        }
      : null;
    const idExterno = gerarIdDeMensagemWhatsapp();
    await this.numeros.receberSimulada(corpo.numeroId, {
      idExterno,
      remetenteJid: jidDoTelefone(telefone.telefone),
      telefone: telefone.telefone,
      nome: corpo.nome ?? null,
      tipo: corpo.tipo ?? (midia ? tipoPelaMidia(midia.mime) : 'TEXTO'),
      texto: corpo.texto ?? null,
      midia,
      respondeAIdExterno: corpo.respondeA ?? null,
      recebidaEm: new Date(),
    });
    return { idExterno };
  }
}
