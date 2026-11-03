import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { ArquivoDto } from '../../arquivos/arquivos.dto';
import {
  DirecaoMensagem,
  type Prisma,
  StatusMensagem,
  TipoAtor,
  TipoMensagem,
} from '../../generated/prisma/client';
import {
  aparar,
  type Campos,
  iso,
  MENSAGEM_UUID,
  OpcionalNaoNulo,
  PessoaDto,
} from './comum.dto';

/** Tamanho máximo de uma mensagem de texto (e de uma nota interna). */
export const TAMANHO_MAXIMO_MENSAGEM = 4096;

/** O que acompanha a mensagem nas respostas e no tempo real. */
export const INCLUIR_MENSAGEM = {
  arquivo: true,
  autor: { select: { id: true, nome: true, avatarUrl: true } },
  respostaA: {
    select: {
      id: true,
      direcao: true,
      tipo: true,
      texto: true,
      excluidaEm: true,
      autor: { select: { nome: true } },
      arquivo: { select: { nome: true } },
    },
  },
} satisfies Prisma.MensagemInclude;

export type MensagemCompleta = Prisma.MensagemGetPayload<{
  include: typeof INCLUIR_MENSAGEM;
}>;

/** A mensagem citada numa resposta. */
export class MensagemCitadaDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ enum: DirecaoMensagem, enumName: 'DirecaoMensagem' })
  direcao: DirecaoMensagem;

  @ApiProperty({ enum: TipoMensagem, enumName: 'TipoMensagem' })
  tipo: TipoMensagem;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description: 'Texto (ou o nome do anexo); nulo se a mensagem foi excluída.',
  })
  texto: string | null;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description: 'Quem escreveu, se foi alguém da equipe.',
  })
  autorNome: string | null;
}

/**
 * Mensagem de uma conversa (§2.4). Direções: `ENTRADA` (do contato), `SAIDA`
 * (da equipe ou automática, para o contato), `INTERNA` (nota interna, só a
 * equipe vê) e `SISTEMA` (aviso na conversa: transferida, resolvida…).
 */
export class MensagemDaConversaDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  conversaId: string;

  @ApiProperty({ enum: DirecaoMensagem, enumName: 'DirecaoMensagem' })
  direcao: DirecaoMensagem;

  @ApiProperty({ enum: TipoMensagem, enumName: 'TipoMensagem' })
  tipo: TipoMensagem;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description: 'Texto puro (nunca HTML). Nulo em mídia sem legenda.',
  })
  texto: string | null;

  @ApiPropertyOptional({ nullable: true, type: ArquivoDto })
  arquivo: ArquivoDto | null;

  @ApiPropertyOptional({
    nullable: true,
    type: PessoaDto,
    description:
      'Quem escreveu (saída e nota interna). Nulo na entrada (o autor é o contato) e nas automáticas.',
  })
  autor: PessoaDto | null;

  @ApiPropertyOptional({
    nullable: true,
    enum: TipoAtor,
    enumName: 'TipoAtor',
    description:
      '`USUARIO` (alguém da equipe), `SISTEMA` (respostas automáticas: fora do horário, pesquisa de satisfação), `AUTOMACAO`, `IA`. Nulo na entrada.',
  })
  autorTipo: TipoAtor | null;

  @ApiProperty({
    description:
      'Saída automática (fora do horário, pesquisa de satisfação, agradecimento).',
  })
  automatica: boolean;

  @ApiPropertyOptional({
    nullable: true,
    enum: StatusMensagem,
    enumName: 'StatusMensagem',
    description:
      'Só na saída: `PENDENTE` → `ENVIADA` → `ENTREGUE` → `LIDA`, ou `FALHOU` (com `erro`; dá para tentar de novo).',
  })
  status: StatusMensagem | null;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description: 'Motivo da falha, em português.',
  })
  erro: string | null;

  @ApiProperty({ description: 'Tentativas de envio feitas.' })
  tentativas: number;

  @ApiPropertyOptional({ nullable: true, type: MensagemCitadaDto })
  respostaA: MensagemCitadaDto | null;

  @ApiPropertyOptional({
    nullable: true,
    type: 'object',
    additionalProperties: true,
    description:
      'Detalhes por tipo e canal: localização `{ latitude, longitude, nome? }`, contato `{ vcard }`, reação `{ emoji }`, e-mail `{ de, para, cc, assunto }`…',
  })
  metadados: Record<string, unknown> | null;

  @ApiProperty({
    format: 'date-time',
    description: 'Quando aconteceu (a ordem da conversa).',
  })
  ocorridaEm: string;

  @ApiPropertyOptional({ nullable: true, type: String, format: 'date-time' })
  enviadaEm: string | null;

  @ApiPropertyOptional({ nullable: true, type: String, format: 'date-time' })
  entregueEm: string | null;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    format: 'date-time',
    description: 'Saída: lida pelo contato. Entrada: lida pela equipe.',
  })
  lidaEm: string | null;

  @ApiPropertyOptional({ nullable: true, type: String, format: 'date-time' })
  editadaEm: string | null;

  @ApiProperty({ description: 'Excluída (texto e anexo não aparecem mais).' })
  excluida: boolean;

  static de(mensagem: MensagemCompleta): Campos<MensagemDaConversaDto> {
    const excluida = mensagem.excluidaEm !== null;
    const citada = mensagem.respostaA;
    return {
      id: mensagem.id,
      conversaId: mensagem.conversaId,
      direcao: mensagem.direcao,
      tipo: mensagem.tipo,
      texto: excluida ? null : mensagem.texto,
      arquivo:
        excluida || !mensagem.arquivo || mensagem.arquivo.removidoEm
          ? null
          : ArquivoDto.de(mensagem.arquivo),
      autor: PessoaDto.ouNulo(mensagem.autor),
      autorTipo: mensagem.autorTipo,
      automatica: mensagem.direcao === 'SAIDA' && mensagem.autorId === null,
      status: mensagem.status,
      erro: mensagem.erro,
      tentativas: mensagem.tentativas,
      respostaA: citada
        ? {
            id: citada.id,
            direcao: citada.direcao,
            tipo: citada.tipo,
            texto: citada.excluidaEm
              ? null
              : (citada.texto ?? citada.arquivo?.nome ?? null),
            autorNome: citada.autor?.nome ?? null,
          }
        : null,
      metadados:
        mensagem.metadados &&
        typeof mensagem.metadados === 'object' &&
        !Array.isArray(mensagem.metadados)
          ? (mensagem.metadados as Record<string, unknown>)
          : null,
      ocorridaEm: mensagem.ocorridaEm.toISOString(),
      enviadaEm: iso(mensagem.enviadaEm),
      entregueEm: iso(mensagem.entregueEm),
      lidaEm: iso(mensagem.lidaEm),
      editadaEm: iso(mensagem.editadaEm),
      excluida,
    };
  }
}

/** `GET /atendimento/conversas/:id/mensagens`: página por cursor, das mais novas para as mais antigas. */
export class FiltroMensagensDto {
  @ApiPropertyOptional({
    description:
      'Cursor devolvido pela página anterior (`proximoCursor`): traz as mensagens mais antigas que ela.',
  })
  @IsOptional()
  @IsString({ message: 'deve ser um texto' })
  @MaxLength(200, { message: 'deve ter no máximo 200 caracteres' })
  cursor?: string;

  @ApiPropertyOptional({
    description: 'Mensagens por página (máximo 100).',
    default: 50,
    minimum: 1,
    maximum: 100,
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === undefined ? value : Number(value),
  )
  @IsInt({ message: 'deve ser um número inteiro' })
  @Min(1, { message: 'deve ser no mínimo 1' })
  @Max(100, { message: 'deve ser no máximo 100' })
  limite: number = 50;
}

/** Página de mensagens: dentro dela, em ordem cronológica (a mais antiga primeiro). */
export class PaginaMensagensDto {
  @ApiProperty({ type: [MensagemDaConversaDto] })
  itens: MensagemDaConversaDto[];

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description: 'Cursor das mensagens mais antigas; nulo quando não há mais.',
  })
  proximoCursor: string | null;
}

/** Valores das variáveis de um template (R28), na ordem em que aparecem em cada componente. */
export class VariaveisDoTemplateDto {
  @ApiPropertyOptional({ type: [String], maxItems: 10 })
  @IsOptional()
  @IsArray({ message: 'deve ser uma lista' })
  @ArrayMaxSize(10, { message: 'deve ter no máximo 10 valores' })
  @IsString({ each: true, message: 'cada valor deve ser um texto' })
  @MaxLength(1024, {
    each: true,
    message: 'cada valor deve ter no máximo 1024 caracteres',
  })
  cabecalho?: string[];

  @ApiPropertyOptional({
    type: [String],
    maxItems: 20,
    description:
      '`corpo[i]` preenche a i-ésima variável do corpo (`TemplateDoCanal.corpo.variaveis`).',
  })
  @IsOptional()
  @IsArray({ message: 'deve ser uma lista' })
  @ArrayMaxSize(20, { message: 'deve ter no máximo 20 valores' })
  @IsString({ each: true, message: 'cada valor deve ser um texto' })
  @MaxLength(1024, {
    each: true,
    message: 'cada valor deve ter no máximo 1024 caracteres',
  })
  corpo?: string[];

  @ApiPropertyOptional({
    type: [String],
    nullable: true,
    maxItems: 10,
    description:
      'Um valor por botão do template (`null` nos que não têm variável).',
  })
  @IsOptional()
  @IsArray({ message: 'deve ser uma lista' })
  @ArrayMaxSize(10, { message: 'deve ter no máximo 10 valores' })
  botoes?: Array<string | null>;
}

/** Template a enviar (canais com templates: WhatsApp oficial, R28). */
export class TemplateParaEnviarDto {
  @ApiProperty({
    format: 'uuid',
    description:
      'Id de um template de `GET /atendimento/conversas/:id/templates`.',
  })
  @IsUUID('all', { message: MENSAGEM_UUID })
  templateId: string;

  @ApiPropertyOptional({ type: VariaveisDoTemplateDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => VariaveisDoTemplateDto)
  variaveis?: VariaveisDoTemplateDto;
}

/**
 * `POST /atendimento/conversas/:id/mensagens`: texto e/ou anexo (enviado
 * antes por `POST /arquivos?contexto=MENSAGEM`). Vai para o contato pelo canal.
 */
export class EnviarMensagemDto {
  @ApiPropertyOptional({
    maxLength: TAMANHO_MAXIMO_MENSAGEM,
    description: 'Texto (ou legenda do anexo).',
  })
  @OpcionalNaoNulo()
  @Transform(aparar)
  @IsString({ message: 'deve ser um texto' })
  @MaxLength(TAMANHO_MAXIMO_MENSAGEM, {
    message: `deve ter no máximo ${TAMANHO_MAXIMO_MENSAGEM} caracteres`,
  })
  texto?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Anexo já enviado (contexto `MENSAGEM`) — ou o anexo de uma resposta rápida.',
  })
  @OpcionalNaoNulo()
  @IsUUID('all', { message: MENSAGEM_UUID })
  arquivoId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Mensagem da conversa que esta responde (citação).',
  })
  @OpcionalNaoNulo()
  @IsUUID('all', { message: MENSAGEM_UUID })
  respostaAId?: string;

  @ApiPropertyOptional({
    type: TemplateParaEnviarDto,
    description:
      'Template aprovado (WhatsApp oficial), com as variáveis. Vale dentro e fora da janela de 24 h e dispensa `texto` (o texto sai do template). Se o template tem mídia no cabeçalho, mande o arquivo em `arquivoId`.',
  })
  @OpcionalNaoNulo()
  @ValidateNested()
  @Type(() => TemplateParaEnviarDto)
  template?: TemplateParaEnviarDto;
}

/** `POST /atendimento/conversas/:id/notas`: nota interna (só a equipe vê). */
export class CriarNotaDto {
  @ApiProperty({ maxLength: TAMANHO_MAXIMO_MENSAGEM })
  @Transform(aparar)
  @IsString({ message: 'deve ser um texto' })
  @IsNotEmpty({ message: 'é obrigatório' })
  @MaxLength(TAMANHO_MAXIMO_MENSAGEM, {
    message: `deve ter no máximo ${TAMANHO_MAXIMO_MENSAGEM} caracteres`,
  })
  texto: string;
}
