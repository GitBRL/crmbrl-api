import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArquivoDto } from '../../arquivos/arquivos.dto';
import { Area, Papel, TipoChatCanal } from '../../generated/prisma/client';
import { TIPOS_DE_REFERENCIA, type TipoReferencia } from '../regras-chat';

/** Pessoa como o chat mostra (autor, membro, outra pessoa da direta, busca de pessoas). */
export class ChatPessoaDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'Ana Lima' })
  nome: string;

  @ApiPropertyOptional({ nullable: true, type: String })
  avatarUrl: string | null;

  @ApiProperty({ enum: Papel, enumName: 'Papel' })
  papel: Papel;

  @ApiProperty({ example: 'Comercial' })
  rotuloPapel: string;

  @ApiPropertyOptional({ enum: Area, enumName: 'Area', nullable: true })
  area: Area | null;

  @ApiProperty({ description: '`false`: desligada (o histórico continua).' })
  ativo: boolean;

  @ApiProperty({
    description:
      'Com o CRM aberto agora (tempo real conectado). Fotografia do momento da resposta.',
  })
  online: boolean;
}

/** Item citado numa mensagem, já resolvido. */
export class ChatReferenciaDto {
  @ApiProperty({ enum: TIPOS_DE_REFERENCIA })
  tipo: TipoReferencia;

  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description:
      'Título do negócio ou nome do contato/empresa; `null` se o item não existe mais.',
    example: 'ACME — implantação',
  })
  titulo: string | null;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description:
      'Rota do front (`/funis/<funilId>?negocio=<id>`, `/contatos/<id>`, `/empresas/<id>`). Quem não vê o negócio (R5.9) recebe 404 ao abrir.',
    example: '/contatos/6f1c2b0e-8a3d-4c55-9a51-2d8f8d7c1e10',
  })
  link: string | null;

  @ApiProperty({
    description: '`false`: excluído, anonimizado ou inexistente (sem link).',
  })
  disponivel: boolean;
}

/** Pedaço do texto, na ordem: texto puro, menção ou referência. */
export class ChatParteDto {
  @ApiProperty({ enum: ['texto', 'mencao', 'referencia'] })
  tipo: 'texto' | 'mencao' | 'referencia';

  @ApiProperty({
    description:
      'O que mostrar: o texto, `@Nome` ou o título do item citado (`item indisponível` se sumiu).',
    example: '@Ana Lima',
  })
  texto: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Só nas menções.',
  })
  usuarioId?: string;

  @ApiPropertyOptional({
    type: ChatReferenciaDto,
    description: 'Só nas referências.',
  })
  referencia?: ChatReferenciaDto;
}

/** A mensagem citada numa resposta. */
export class ChatMensagemCitadaDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description: 'Nome de quem escreveu (`null` em aviso do sistema).',
  })
  autor: string | null;

  @ApiProperty({
    description: 'Resumo do texto (até 140 caracteres, menções como `@Nome`).',
  })
  resumo: string;

  @ApiPropertyOptional({ nullable: true, type: String })
  anexoNome: string | null;

  @ApiProperty()
  excluida: boolean;
}

export class ChatMensagemDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  canalId: string;

  @ApiPropertyOptional({
    nullable: true,
    type: ChatPessoaDto,
    description: '`null` nos avisos do sistema ("Ana adicionou Pedro").',
  })
  autor: ChatPessoaDto | null;

  @ApiProperty({ description: 'Aviso do sistema (sem autor).' })
  sistema: boolean;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description:
      'O texto como foi escrito, com as marcações `<@id>`/`<negocio:id>`… (para editar). `null` se excluída ou só anexo.',
  })
  texto: string | null;

  @ApiProperty({
    type: [ChatParteDto],
    description: 'O texto já resolvido, em pedaços, para montar a bolha.',
  })
  partes: ChatParteDto[];

  @ApiPropertyOptional({ nullable: true, type: ArquivoDto })
  anexo: ArquivoDto | null;

  @ApiProperty({
    type: [String],
    description: 'Ids de quem foi mencionado (e notificado).',
  })
  mencoes: string[];

  @ApiProperty({ type: [ChatReferenciaDto] })
  referencias: ChatReferenciaDto[];

  @ApiPropertyOptional({ nullable: true, type: ChatMensagemCitadaDto })
  respostaA: ChatMensagemCitadaDto | null;

  @ApiPropertyOptional({ nullable: true, type: String, format: 'date-time' })
  editadaEm: string | null;

  @ApiProperty({
    description: 'Excluída pelo autor: texto e anexo somem para todos.',
  })
  excluida: boolean;

  @ApiPropertyOptional({ nullable: true, type: String, format: 'date-time' })
  excluidaEm: string | null;

  @ApiProperty({ format: 'date-time' })
  criadaEm: string;
}

/** Prévia da última mensagem na lista de canais. */
export class ChatUltimaMensagemDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiPropertyOptional({ nullable: true, type: String, format: 'uuid' })
  autorId: string | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  autorNome: string | null;

  @ApiProperty({
    description:
      'Resumo (até 140 caracteres; "Anexo: nome" sem texto; "Mensagem excluída").',
  })
  resumo: string;

  @ApiProperty()
  excluida: boolean;

  @ApiProperty({ format: 'date-time' })
  criadaEm: string;
}

/** Canal como a lista do chat mostra — do ponto de vista de quem pergunta. */
export class ChatCanalDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ enum: TipoChatCanal, enumName: 'TipoChatCanal' })
  tipo: TipoChatCanal;

  @ApiProperty({
    description: 'Nome para mostrar (na direta, o nome da outra pessoa).',
    example: 'Geral',
  })
  nome: string;

  @ApiPropertyOptional({ nullable: true, type: String })
  descricao: string | null;

  @ApiPropertyOptional({ enum: Area, enumName: 'Area', nullable: true })
  area: Area | null;

  @ApiPropertyOptional({
    nullable: true,
    type: ChatPessoaDto,
    description: 'Só na direta: a outra pessoa.',
  })
  outraPessoa: ChatPessoaDto | null;

  @ApiProperty({ example: 12 })
  totalMembros: number;

  @ApiProperty({ description: 'Você administra o grupo.' })
  administrador: boolean;

  @ApiProperty({
    description:
      'Você está no canal pelo papel (Geral e áreas): não dá para sair, só silenciar.',
  })
  automatico: boolean;

  @ApiProperty()
  silenciado: boolean;

  @ApiProperty({
    description: 'Mensagens de outras pessoas depois da sua última leitura.',
  })
  naoLidas: number;

  @ApiProperty({ description: 'Dessas, quantas mencionam você.' })
  mencoesNaoLidas: number;

  @ApiPropertyOptional({ nullable: true, type: String, format: 'date-time' })
  ultimaLeituraEm: string | null;

  @ApiPropertyOptional({ nullable: true, type: ChatUltimaMensagemDto })
  ultimaMensagem: ChatUltimaMensagemDto | null;

  @ApiPropertyOptional({ nullable: true, type: String, format: 'date-time' })
  ultimaMensagemEm: string | null;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    format: 'date-time',
    description: 'Grupo arquivado: só leitura.',
  })
  arquivadoEm: string | null;

  @ApiProperty({ description: 'Você pode enviar mensagens agora.' })
  podeEnviar: boolean;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description: 'Por que não pode enviar (grupo arquivado, pessoa desligada).',
  })
  motivoSemEnvio: string | null;

  @ApiProperty({
    description:
      'Você pode renomear, mexer nas pessoas e arquivar (administrador de grupo).',
  })
  podeGerenciar: boolean;

  @ApiProperty({ description: 'Você pode sair (só grupos).' })
  podeSair: boolean;

  @ApiProperty({ format: 'date-time' })
  criadoEm: string;
}

export class ChatMembroDto {
  @ApiProperty({ type: ChatPessoaDto })
  usuario: ChatPessoaDto;

  @ApiProperty()
  administrador: boolean;

  @ApiProperty({ description: 'Entrou pelo papel (Geral e áreas).' })
  automatico: boolean;

  @ApiProperty({ format: 'date-time' })
  entrouEm: string;
}

export class ResultadoDiretaChatDto {
  @ApiProperty({ description: '`false`: a conversa já existia.' })
  criada: boolean;

  @ApiProperty({ type: ChatCanalDto })
  canal: ChatCanalDto;
}

export class PaginaChatMensagensDto {
  @ApiProperty({
    type: [ChatMensagemDto],
    description: 'Da mais antiga para a mais nova.',
  })
  itens: ChatMensagemDto[];

  @ApiProperty({ description: 'Há mensagens mais antigas que a primeira.' })
  temAnteriores: boolean;

  @ApiProperty({ description: 'Há mensagens mais novas que a última.' })
  temPosteriores: boolean;
}

export class NaoLidasDoCanalChatDto {
  @ApiProperty({ format: 'uuid' })
  canalId: string;

  @ApiProperty()
  naoLidas: number;

  @ApiProperty()
  mencoes: number;

  @ApiProperty()
  silenciado: boolean;
}

export class ChatNaoLidasDto {
  @ApiProperty({
    description:
      'O número do menu: não lidas dos canais não silenciados (e não arquivados), mais as menções nos silenciados. É o mesmo `chat` do evento `nao-lidas`.',
    example: 4,
  })
  total: number;

  @ApiProperty({
    type: [NaoLidasDoCanalChatDto],
    description: 'Só os canais com alguma não lida.',
  })
  canais: NaoLidasDoCanalChatDto[];
}

export class ResumoDoCanalNaBuscaChatDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ enum: TipoChatCanal, enumName: 'TipoChatCanal' })
  tipo: TipoChatCanal;

  @ApiProperty({ description: 'Na direta, o nome da outra pessoa.' })
  nome: string;
}

export class ResultadoBuscaChatDto {
  @ApiProperty({ type: ChatMensagemDto })
  mensagem: ChatMensagemDto;

  @ApiProperty({ type: ResumoDoCanalNaBuscaChatDto })
  canal: ResumoDoCanalNaBuscaChatDto;
}
