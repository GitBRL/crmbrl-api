import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** O cabeçalho de um template (texto, ou mídia que a mensagem precisa anexar). */
export class CabecalhoDoTemplateDto {
  @ApiProperty({
    enum: ['TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT', 'LOCATION'],
    description:
      'Com `IMAGE`, `VIDEO` ou `DOCUMENT` a mensagem leva o arquivo em `arquivoId` (é o cabeçalho).',
  })
  formato: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  texto: string | null;

  @ApiProperty({
    type: [String],
    description: 'Nomes das variáveis do cabeçalho de texto (`1`, `2`…).',
  })
  variaveis: string[];
}

export class CorpoDoTemplateDto {
  @ApiProperty({ example: 'Olá {{1}}, seu pedido {{2}} saiu para entrega.' })
  texto: string;

  @ApiProperty({
    type: [String],
    example: ['1', '2'],
    description:
      'Variáveis na ordem em que aparecem: `variaveis.corpo[i]` preenche a i-ésima.',
  })
  variaveis: string[];
}

export class BotaoDoTemplateDto {
  @ApiProperty({
    enum: ['QUICK_REPLY', 'URL', 'PHONE_NUMBER', 'COPY_CODE', 'OTHER'],
  })
  tipo: string;

  @ApiProperty()
  texto: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  url: string | null;

  @ApiProperty({
    type: [String],
    description: 'Só o botão de URL tem variável (no máximo uma).',
  })
  variaveis: string[];
}

/** Um template de mensagem aprovado (ou não) na conta do canal. */
export class TemplateDoCanalDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'pedido_enviado' })
  nome: string;

  @ApiProperty({ example: 'pt_BR' })
  idioma: string;

  @ApiProperty({
    example: 'UTILITY',
    description: '`MARKETING`, `UTILITY` ou `AUTHENTICATION`.',
  })
  categoria: string;

  @ApiProperty({
    example: 'APPROVED',
    description: 'Situação na Meta; só `APPROVED` envia.',
  })
  status: string;

  @ApiProperty({
    description: 'Dá para enviar agora (aprovado e de um formato suportado).',
  })
  usavel: boolean;

  @ApiPropertyOptional({ type: String, nullable: true })
  motivoIndisponivel: string | null;

  @ApiPropertyOptional({ type: CabecalhoDoTemplateDto, nullable: true })
  cabecalho: CabecalhoDoTemplateDto | null;

  @ApiProperty({ type: CorpoDoTemplateDto })
  corpo: CorpoDoTemplateDto;

  @ApiPropertyOptional({ type: String, nullable: true })
  rodape: string | null;

  @ApiProperty({ type: [BotaoDoTemplateDto] })
  botoes: BotaoDoTemplateDto[];

  @ApiProperty({ format: 'date-time' })
  sincronizadoEm: string;
}

/** Resposta de `GET /atendimento/conversas/:id/templates`. */
export class TemplatesDaConversaDto {
  @ApiProperty({
    description:
      'O canal da conversa trabalha com templates (WhatsApp oficial).',
  })
  suportado: boolean;

  @ApiProperty({
    description:
      'A janela de 24 h está aberta: dá para mensagem livre além dos templates.',
  })
  janelaAberta: boolean;

  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  janelaAte: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Aviso para a tela quando a janela está fechada.',
  })
  aviso: string | null;

  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  sincronizadoEm: string | null;

  @ApiProperty({
    type: [TemplateDoCanalDto],
    description: 'Só os que dá para enviar (aprovados).',
  })
  itens: TemplateDoCanalDto[];
}
