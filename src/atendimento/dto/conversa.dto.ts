import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import {
  QUANTIDADE_MAXIMA_ETIQUETAS,
  TAMANHO_MAXIMO_ETIQUETA,
} from '../../comum/dominio/etiquetas';
import { PaginacaoDto } from '../../comum/paginacao/paginacao';
import { ResumoFunilDto } from '../../funis/dto/comum.dto';
import {
  Area,
  DirecaoMensagem,
  ModoSdr,
  MotivoAtribuicao,
  PrioridadeConversa,
  type Prisma,
  SituacaoSdr,
  StatusConversa,
  StatusNegocio,
  TemperaturaSdr,
  TipoAtor,
  TipoCanal,
  TipoMensagem,
} from '../../generated/prisma/client';
import { situacaoDoSla } from '../sla';
import {
  aparar,
  apararOuNulo,
  type Campos,
  emMaiusculas,
  iso,
  MENSAGEM_UUID,
  OpcionalNaoNulo,
  paraBooleano,
  paraLista,
  paraListaEmMaiusculas,
  PessoaDto,
  ResumoCanalDto,
  ResumoFilaDto,
} from './comum.dto';
import { AREAS_DO_ATENDIMENTO, type AreaDoAtendimento } from './fila.dto';
import { TAMANHO_MAXIMO_MENSAGEM, TemplateParaEnviarDto } from './mensagem.dto';

/** Tamanho máximo da nota de uma transferência. */
export const TAMANHO_MAXIMO_NOTA = 1000;

/** O que acompanha a conversa nas listas e no tempo real. */
export const INCLUIR_CONVERSA = {
  canal: { select: { id: true, tipo: true, nome: true, ativo: true } },
  contato: {
    select: {
      id: true,
      nome: true,
      email: true,
      telefone: true,
      excluidoEm: true,
    },
  },
  fila: { select: { id: true, nome: true, area: true } },
  responsavel: { select: { id: true, nome: true, avatarUrl: true } },
  /** Onda G: o SDR com IA (selo "IA atendendo", temperatura). */
  sdr: {
    select: {
      situacao: true,
      modo: true,
      nota: true,
      temperatura: true,
    },
  },
  ultimaMensagem: {
    select: {
      id: true,
      direcao: true,
      tipo: true,
      texto: true,
      ocorridaEm: true,
      excluidaEm: true,
      autor: { select: { nome: true } },
      arquivo: { select: { nome: true } },
    },
  },
} satisfies Prisma.ConversaInclude;

export type ConversaCompleta = Prisma.ConversaGetPayload<{
  include: typeof INCLUIR_CONVERSA;
}>;

/** O detalhe acrescenta o negócio ligado e quem resolveu. */
export const INCLUIR_CONVERSA_DETALHE = {
  ...INCLUIR_CONVERSA,
  resolvidaPor: { select: { id: true, nome: true, avatarUrl: true } },
  negocio: {
    select: {
      id: true,
      titulo: true,
      status: true,
      excluidoEm: true,
      funil: { select: { id: true, nome: true, area: true } },
    },
  },
} satisfies Prisma.ConversaInclude;

export type ConversaDetalhada = Prisma.ConversaGetPayload<{
  include: typeof INCLUIR_CONVERSA_DETALHE;
}>;

const TAMANHO_DA_PREVIA = 160;

export class ContatoDaConversaDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'Maria Souza' })
  nome: string;

  @ApiPropertyOptional({ nullable: true, type: String })
  email: string | null;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description: 'E.164 só com dígitos.',
  })
  telefone: string | null;
}

export class UltimaMensagemDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ enum: DirecaoMensagem, enumName: 'DirecaoMensagem' })
  direcao: DirecaoMensagem;

  @ApiProperty({ enum: TipoMensagem, enumName: 'TipoMensagem' })
  tipo: TipoMensagem;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description: `Começo do texto (até ${TAMANHO_DA_PREVIA} caracteres) ou o nome do anexo.`,
  })
  previa: string | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  autorNome: string | null;

  @ApiProperty({ format: 'date-time' })
  ocorridaEm: string;
}

export class SlaDaConversaDto {
  @ApiPropertyOptional({
    nullable: true,
    type: String,
    format: 'date-time',
    description: 'Prazo da primeira resposta (nulo = fila sem esse SLA).',
  })
  primeiraRespostaAte: string | null;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    format: 'date-time',
    description: 'Prazo de resolução (nulo = fila sem esse SLA).',
  })
  resolucaoAte: string | null;

  @ApiProperty({
    description:
      'Sem primeira resposta e com o prazo vencido (o selo coral da lista).',
  })
  primeiraRespostaEstourada: boolean;

  @ApiProperty({ description: 'Em aberto e com o prazo de resolução vencido.' })
  resolucaoEstourada: boolean;
}

/** Conversa como a lista do Atendimento mostra (e o tempo real manda). */
/** Resumo do SDR com IA numa conversa (Onda G, R31). Nulo = a IA nunca atendeu. */
export class SdrDaConversaDto {
  @ApiProperty({
    enum: SituacaoSdr,
    enumName: 'SituacaoSdr',
    description:
      '`ATIVA` = a IA está atendendo (selo "IA atendendo"); as demais mostram por que parou.',
  })
  situacao: SituacaoSdr;

  @ApiProperty({
    enum: ModoSdr,
    enumName: 'ModoSdr',
    description: '`AUTOMATICO` responde sozinha; `SUGESTAO` só propõe.',
  })
  modo: ModoSdr;

  @ApiPropertyOptional({
    nullable: true,
    type: Number,
    description: '0 a 100.',
  })
  nota: number | null;

  @ApiPropertyOptional({
    nullable: true,
    enum: TemperaturaSdr,
    enumName: 'TemperaturaSdr',
  })
  temperatura: TemperaturaSdr | null;
}

export class ConversaResumoDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ type: ResumoCanalDto })
  canal: ResumoCanalDto;

  @ApiProperty({ type: ContatoDaConversaDto })
  contato: ContatoDaConversaDto;

  @ApiPropertyOptional({ nullable: true, type: ResumoFilaDto })
  fila: ResumoFilaDto | null;

  @ApiPropertyOptional({
    nullable: true,
    type: PessoaDto,
    description: 'Nulo = sem responsável (quem atende a fila pode assumir).',
  })
  responsavel: PessoaDto | null;

  @ApiProperty({ enum: StatusConversa, enumName: 'StatusConversa' })
  status: StatusConversa;

  @ApiProperty({ enum: PrioridadeConversa, enumName: 'PrioridadeConversa' })
  prioridade: PrioridadeConversa;

  @ApiPropertyOptional({ nullable: true, type: String })
  assunto: string | null;

  @ApiProperty({ type: [String] })
  etiquetas: string[];

  @ApiProperty({ description: 'Mensagens do contato ainda não lidas.' })
  naoLidas: number;

  @ApiPropertyOptional({ nullable: true, type: UltimaMensagemDto })
  ultimaMensagem: UltimaMensagemDto | null;

  @ApiPropertyOptional({ nullable: true, type: String, format: 'date-time' })
  ultimaMensagemEm: string | null;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    format: 'date-time',
    description: 'Última mensagem do contato.',
  })
  ultimaEntradaEm: string | null;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    format: 'date-time',
    description:
      'Desde quando o contato espera resposta (o tempo de espera da lista). Nulo = ninguém esperando.',
  })
  aguardandoDesde: string | null;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    format: 'date-time',
    description: 'Quando o responsável atual recebeu a conversa.',
  })
  atribuidaEm: string | null;

  @ApiProperty({ type: SlaDaConversaDto })
  sla: SlaDaConversaDto;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    format: 'date-time',
    description:
      'Instagram e Messenger: até quando cabe resposta comum (janela de 24 h da Meta).',
  })
  janelaAte: string | null;

  @ApiPropertyOptional({ nullable: true, type: String, format: 'uuid' })
  negocioId: string | null;

  @ApiPropertyOptional({
    nullable: true,
    type: SdrDaConversaDto,
    description:
      'SDR com IA (R31): situação, modo, nota e temperatura. Nulo = a IA nunca atendeu esta conversa.',
  })
  sdr: SdrDaConversaDto | null;

  @ApiProperty({ format: 'date-time' })
  criadoEm: string;

  @ApiPropertyOptional({ nullable: true, type: String, format: 'date-time' })
  resolvidaEm: string | null;

  static de(
    conversa: ConversaCompleta,
    agora: Date = new Date(),
  ): Campos<ConversaResumoDto> {
    const sla = situacaoDoSla(conversa, agora);
    const ultima = conversa.ultimaMensagem;
    return {
      id: conversa.id,
      canal: ResumoCanalDto.de(conversa.canal),
      contato: {
        id: conversa.contato.id,
        nome: conversa.contato.nome,
        email: conversa.contato.email,
        telefone: conversa.contato.telefone,
      },
      fila: ResumoFilaDto.ouNulo(conversa.fila),
      responsavel: PessoaDto.ouNulo(conversa.responsavel),
      status: conversa.status,
      prioridade: conversa.prioridade,
      assunto: conversa.assunto,
      etiquetas: conversa.etiquetas,
      naoLidas: conversa.naoLidas,
      ultimaMensagem: ultima
        ? {
            id: ultima.id,
            direcao: ultima.direcao,
            tipo: ultima.tipo,
            previa: ultima.excluidaEm
              ? null
              : (ultima.texto?.slice(0, TAMANHO_DA_PREVIA) ??
                ultima.arquivo?.nome ??
                null),
            autorNome: ultima.autor?.nome ?? null,
            ocorridaEm: ultima.ocorridaEm.toISOString(),
          }
        : null,
      ultimaMensagemEm: iso(conversa.ultimaMensagemEm),
      ultimaEntradaEm: iso(conversa.ultimaEntradaEm),
      aguardandoDesde: iso(conversa.aguardandoDesde),
      atribuidaEm: iso(conversa.atribuidaEm),
      sla: {
        primeiraRespostaAte: iso(conversa.slaPrimeiraRespostaAte),
        resolucaoAte: iso(conversa.slaResolucaoAte),
        primeiraRespostaEstourada: sla.primeiraRespostaEstourada,
        resolucaoEstourada: sla.resolucaoEstourada,
      },
      janelaAte: iso(conversa.janelaAte),
      negocioId: conversa.negocioId,
      sdr: conversa.sdr
        ? {
            situacao: conversa.sdr.situacao,
            modo: conversa.sdr.modo,
            nota: conversa.sdr.nota,
            temperatura: conversa.sdr.temperatura,
          }
        : null,
      criadoEm: conversa.criadoEm.toISOString(),
      resolvidaEm: iso(conversa.resolvidaEm),
    };
  }
}

export class SatisfacaoDto {
  @ApiPropertyOptional({
    nullable: true,
    type: String,
    format: 'date-time',
    description: 'Quando a pesquisa foi enviada (vale por 24 h).',
  })
  solicitadaEm: string | null;

  @ApiPropertyOptional({
    nullable: true,
    type: Number,
    minimum: 1,
    maximum: 5,
  })
  nota: number | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  comentario: string | null;

  @ApiPropertyOptional({ nullable: true, type: String, format: 'date-time' })
  respondidaEm: string | null;

  @ApiProperty({ description: 'Ainda aceita a resposta do contato.' })
  aguardando: boolean;
}

export class NegocioDaConversaDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  titulo: string;

  @ApiProperty({ enum: StatusNegocio, enumName: 'StatusNegocio' })
  status: StatusNegocio;

  @ApiProperty({ type: ResumoFunilDto, description: 'O funil do negócio.' })
  funil: ResumoFunilDto;
}

export class PodeResponderDto {
  @ApiProperty()
  pode: boolean;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description: 'Por que não dá (ex.: janela de 24 h da Meta fechada).',
  })
  motivo: string | null;

  @ApiProperty({
    description:
      'Só dá para enviar um template aprovado (WhatsApp oficial fora da janela de 24 h): a tela troca o compositor livre pela lista de templates.',
  })
  apenasTemplate: boolean;
}

/** O que a pessoa pode fazer com a conversa (para os botões da tela). */
export class AcoesDaConversaDto {
  @ApiProperty({ description: 'Assumir: conversa em aberto sem responsável.' })
  assumir: boolean;

  @ApiProperty()
  transferir: boolean;

  @ApiProperty()
  resolver: boolean;

  @ApiProperty()
  reabrir: boolean;

  @ApiProperty({
    description:
      'Enviar mensagem ao contato (conversa em aberto e canal aceitando resposta).',
  })
  responder: boolean;

  @ApiProperty({
    description:
      'Enviar um template (`POST …/mensagens` com `template`): conversa em aberto num canal que usa templates.',
  })
  enviarTemplate: boolean;

  @ApiProperty()
  criarNegocio: boolean;
}

export class ConversaDetalheDto extends ConversaResumoDto {
  @ApiPropertyOptional({ nullable: true, type: String, format: 'date-time' })
  primeiraRespostaEm: string | null;

  @ApiPropertyOptional({ nullable: true, type: PessoaDto })
  resolvidaPor: PessoaDto | null;

  @ApiProperty({ description: 'Quantas vezes foi reaberta.' })
  reaberturas: number;

  @ApiProperty({ type: SatisfacaoDto })
  satisfacao: SatisfacaoDto;

  @ApiPropertyOptional({ nullable: true, type: NegocioDaConversaDto })
  negocio: NegocioDaConversaDto | null;

  @ApiProperty({ type: PodeResponderDto })
  podeResponder: PodeResponderDto;

  @ApiProperty({ type: AcoesDaConversaDto })
  acoes: AcoesDaConversaDto;
}

// ---------------------------------------------------------------------------
// Entrada
// ---------------------------------------------------------------------------

export const ESCOPOS_DE_CONVERSAS = [
  'MINHAS',
  'SEM_RESPONSAVEL',
  'TODAS',
] as const;
export type EscopoDeConversas = (typeof ESCOPOS_DE_CONVERSAS)[number];

/** `GET /atendimento/conversas`. */
export class FiltroConversasDto extends PaginacaoDto {
  @ApiPropertyOptional({
    enum: ESCOPOS_DE_CONVERSAS,
    default: 'TODAS',
    description:
      '`MINHAS` (comigo), `SEM_RESPONSAVEL` (aguardando alguém assumir) ou `TODAS` (todas as que vejo, R12).',
  })
  @IsOptional()
  @Transform(emMaiusculas)
  @IsIn(ESCOPOS_DE_CONVERSAS, {
    message: 'deve ser MINHAS, SEM_RESPONSAVEL ou TODAS',
  })
  escopo: EscopoDeConversas = 'TODAS';

  @ApiPropertyOptional({
    enum: StatusConversa,
    enumName: 'StatusConversa',
    isArray: true,
    description:
      'Padrão: as em aberto (`ABERTA`, `PENDENTE`). Repita ou separe por vírgula.',
  })
  @IsOptional()
  @Transform(paraListaEmMaiusculas)
  @IsArray({ message: 'deve ser uma lista' })
  @IsEnum(StatusConversa, {
    each: true,
    message: 'deve ser ABERTA, PENDENTE ou RESOLVIDA',
  })
  status?: StatusConversa[];

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('all', { message: MENSAGEM_UUID })
  filaId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('all', { message: MENSAGEM_UUID })
  canalId?: string;

  @ApiPropertyOptional({
    enum: TipoCanal,
    enumName: 'TipoCanal',
    isArray: true,
  })
  @IsOptional()
  @Transform(paraListaEmMaiusculas)
  @IsArray({ message: 'deve ser uma lista' })
  @IsEnum(TipoCanal, {
    each: true,
    message:
      'deve ser WHATSAPP, WHATSAPP_OFICIAL, WEBCHAT, EMAIL, INSTAGRAM ou MESSENGER',
  })
  tipoCanal?: TipoCanal[];

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('all', { message: MENSAGEM_UUID })
  responsavelId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Conversas de um contato (inclua `status=RESOLVIDA` para o histórico).',
  })
  @IsOptional()
  @IsUUID('all', { message: MENSAGEM_UUID })
  contatoId?: string;

  @ApiPropertyOptional({
    isArray: true,
    type: String,
    description: 'Tem alguma destas etiquetas.',
  })
  @IsOptional()
  @Transform(paraLista)
  @IsArray({ message: 'deve ser uma lista' })
  @IsString({ each: true, message: 'deve ser um texto' })
  etiqueta?: string[];

  @ApiPropertyOptional({
    enum: PrioridadeConversa,
    enumName: 'PrioridadeConversa',
    isArray: true,
  })
  @IsOptional()
  @Transform(paraListaEmMaiusculas)
  @IsArray({ message: 'deve ser uma lista' })
  @IsEnum(PrioridadeConversa, {
    each: true,
    message: 'deve ser BAIXA, NORMAL, ALTA ou URGENTE',
  })
  prioridade?: PrioridadeConversa[];

  @ApiPropertyOptional({ description: 'Só as com mensagens não lidas.' })
  @IsOptional()
  @Transform(paraBooleano)
  @IsBoolean({ message: 'deve ser verdadeiro ou falso' })
  naoLidas?: boolean;

  @ApiPropertyOptional({
    description: 'Só as com SLA estourado (primeira resposta ou resolução).',
  })
  @IsOptional()
  @Transform(paraBooleano)
  @IsBoolean({ message: 'deve ser verdadeiro ou falso' })
  slaEstourado?: boolean;

  @ApiPropertyOptional({
    description:
      'SDR com IA (R31): `true` = só as que a IA atendeu ou atende (têm estado do SDR, em qualquer situação); `false` = só as que a IA nunca atendeu.',
  })
  @IsOptional()
  @Transform(paraBooleano)
  @IsBoolean({ message: 'deve ser verdadeiro ou falso' })
  atendidasPelaIa?: boolean;

  @ApiPropertyOptional({
    enum: ModoSdr,
    enumName: 'ModoSdr',
    isArray: true,
    description:
      'Modo do SDR com que a IA assumiu a conversa (`AUTOMATICO` ou `SUGESTAO`). Implica `atendidasPelaIa`.',
  })
  @IsOptional()
  @Transform(paraListaEmMaiusculas)
  @IsArray({ message: 'deve ser uma lista' })
  @IsEnum(ModoSdr, {
    each: true,
    message: 'deve ser AUTOMATICO ou SUGESTAO',
  })
  sdrModo?: ModoSdr[];

  @ApiPropertyOptional({
    enum: SituacaoSdr,
    enumName: 'SituacaoSdr',
    isArray: true,
    description:
      'Situação do SDR na conversa (`ATIVA` = IA atendendo agora, `HUMANO`, `PASSADA_HUMANO`, `QUALIFICADA`, `DESQUALIFICADA`, `ENCERRADA`). Implica `atendidasPelaIa`.',
  })
  @IsOptional()
  @Transform(paraListaEmMaiusculas)
  @IsArray({ message: 'deve ser uma lista' })
  @IsEnum(SituacaoSdr, {
    each: true,
    message:
      'deve ser ATIVA, HUMANO, PASSADA_HUMANO, QUALIFICADA, DESQUALIFICADA ou ENCERRADA',
  })
  sdrSituacao?: SituacaoSdr[];

  @ApiPropertyOptional({
    description: 'Nome, e-mail ou telefone do contato, ou o assunto.',
    maxLength: 100,
  })
  @IsOptional()
  @Transform(aparar)
  @IsString({ message: 'deve ser um texto' })
  @MaxLength(100, { message: 'deve ter no máximo 100 caracteres' })
  busca?: string;
}

export class ContadoresDeConversasDto {
  @ApiProperty({ description: 'Em aberto comigo.' })
  minhas: number;

  @ApiProperty({ description: 'Em aberto sem responsável, entre as que vejo.' })
  semResponsavel: number;

  @ApiProperty({ description: 'Em aberto, entre todas as que vejo.' })
  todas: number;

  @ApiProperty({
    description:
      'O número do menu (`nao-lidas.atendimento`): conversas em aberto com mensagens não lidas que estão comigo ou sem responsável nas filas da minha área.',
  })
  naoLidas: number;
}

export class PaginaConversasDto {
  @ApiProperty({ type: [ConversaResumoDto] })
  itens: ConversaResumoDto[];

  @ApiProperty()
  total: number;

  @ApiProperty()
  pagina: number;

  @ApiProperty()
  porPagina: number;

  @ApiProperty({ type: ContadoresDeConversasDto })
  contadores: ContadoresDeConversasDto;
}

/** `PATCH /atendimento/conversas/:id`: só os campos enviados mudam. */
export class AtualizarConversaDto {
  @ApiPropertyOptional({
    enum: ['ABERTA', 'PENDENTE'],
    description:
      '`PENDENTE` = aguardando o contato (continua em aberto). Para resolver ou reabrir, use as ações próprias.',
  })
  @OpcionalNaoNulo()
  @Transform(emMaiusculas)
  @IsIn(['ABERTA', 'PENDENTE'], { message: 'deve ser ABERTA ou PENDENTE' })
  status?: 'ABERTA' | 'PENDENTE';

  @ApiPropertyOptional({
    enum: PrioridadeConversa,
    enumName: 'PrioridadeConversa',
  })
  @OpcionalNaoNulo()
  @Transform(emMaiusculas)
  @IsEnum(PrioridadeConversa, {
    message: 'deve ser BAIXA, NORMAL, ALTA ou URGENTE',
  })
  prioridade?: PrioridadeConversa;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    maxLength: 200,
    description: '`null` ou vazio apaga.',
  })
  @IsOptional()
  @Transform(apararOuNulo)
  @IsString({ message: 'deve ser um texto' })
  @MaxLength(200, { message: 'deve ter no máximo 200 caracteres' })
  assunto?: string | null;

  @ApiPropertyOptional({
    type: [String],
    description: `Substitui as etiquetas (até ${QUANTIDADE_MAXIMA_ETIQUETAS}, com até ${TAMANHO_MAXIMO_ETIQUETA} caracteres cada).`,
  })
  @OpcionalNaoNulo()
  @IsArray({ message: 'deve ser uma lista' })
  @ArrayMaxSize(QUANTIDADE_MAXIMA_ETIQUETAS, {
    message: `deve ter no máximo ${QUANTIDADE_MAXIMA_ETIQUETAS} etiquetas`,
  })
  @IsString({ each: true, message: 'deve ser um texto' })
  etiquetas?: string[];

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    format: 'uuid',
    description:
      'Liga a um negócio do mesmo contato que você vê (`null` desliga).',
  })
  @IsOptional()
  @IsUUID('all', { message: MENSAGEM_UUID })
  negocioId?: string | null;
}

/**
 * `POST /atendimento/conversas/:id/transferir`: para uma pessoa, para outra
 * fila ou para os dois. Só para fila: a conversa entra na distribuição dela.
 */
export class TransferirConversaDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Novo responsável (ativo, de uma área que usa o Atendimento).',
  })
  @OpcionalNaoNulo()
  @IsUUID('all', { message: MENSAGEM_UUID })
  usuarioId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Nova fila. Sem pessoa, a conversa é distribuída pela estratégia da fila.',
  })
  @OpcionalNaoNulo()
  @IsUUID('all', { message: MENSAGEM_UUID })
  filaId?: string;

  @ApiPropertyOptional({
    maxLength: TAMANHO_MAXIMO_NOTA,
    description: 'Nota para quem recebe (aparece na conversa e no histórico).',
  })
  @OpcionalNaoNulo()
  @Transform(aparar)
  @IsString({ message: 'deve ser um texto' })
  @MaxLength(TAMANHO_MAXIMO_NOTA, {
    message: `deve ter no máximo ${TAMANHO_MAXIMO_NOTA} caracteres`,
  })
  nota?: string;
}

/** `POST /atendimento/conversas/:id/resolver`. */
export class ResolverConversaDto {
  @ApiPropertyOptional({
    default: true,
    description:
      'Envia a pesquisa de satisfação (se o canal tiver a pesquisa ligada).',
  })
  @IsOptional()
  @IsBoolean({ message: 'deve ser verdadeiro ou falso' })
  enviarPesquisa: boolean = true;
}

/** `POST /atendimento/conversas/:id/negocio`: cria um negócio para o contato da conversa. */
export class CriarNegocioDaConversaDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Padrão: o funil-base da área da fila (ou da sua área).',
  })
  @OpcionalNaoNulo()
  @IsUUID('all', { message: MENSAGEM_UUID })
  funilId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Padrão: a primeira etapa aberta do funil.',
  })
  @OpcionalNaoNulo()
  @IsUUID('all', { message: MENSAGEM_UUID })
  etapaId?: string;

  @ApiPropertyOptional({
    maxLength: 200,
    description: 'Padrão: o nome do contato.',
  })
  @OpcionalNaoNulo()
  @Transform(aparar)
  @IsString({ message: 'deve ser um texto' })
  @IsNotEmpty({ message: 'é obrigatório' })
  @MaxLength(200, { message: 'deve ter no máximo 200 caracteres' })
  titulo?: string;

  @ApiPropertyOptional({
    example: '1500.00',
    description: 'Valor em reais (texto decimal).',
  })
  @OpcionalNaoNulo()
  @IsString({ message: 'deve ser um texto' })
  @Matches(/^\d{1,13}(\.\d{1,2})?$/, {
    message: 'deve ser um valor em reais, como 1500.00',
  })
  valor?: string;
}

/**
 * `POST /atendimento/conversas`: começa (ou continua) a conversa com um
 * contato num canal e envia a primeira mensagem.
 */
export class IniciarConversaDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('all', { message: MENSAGEM_UUID })
  canalId: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID('all', { message: MENSAGEM_UUID })
  contatoId: string;

  @ApiPropertyOptional({ maxLength: TAMANHO_MAXIMO_MENSAGEM })
  @OpcionalNaoNulo()
  @Transform(aparar)
  @IsString({ message: 'deve ser um texto' })
  @MaxLength(TAMANHO_MAXIMO_MENSAGEM, {
    message: `deve ter no máximo ${TAMANHO_MAXIMO_MENSAGEM} caracteres`,
  })
  texto?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @OpcionalNaoNulo()
  @IsUUID('all', { message: MENSAGEM_UUID })
  arquivoId?: string;

  @ApiPropertyOptional({
    type: TemplateParaEnviarDto,
    description:
      'Primeira mensagem por template (WhatsApp oficial: não há janela aberta com quem ainda não escreveu).',
  })
  @OpcionalNaoNulo()
  @ValidateNested()
  @Type(() => TemplateParaEnviarDto)
  template?: TemplateParaEnviarDto;

  @ApiPropertyOptional({
    maxLength: 200,
    description: 'Assunto (e-mail).',
  })
  @OpcionalNaoNulo()
  @Transform(aparar)
  @IsString({ message: 'deve ser um texto' })
  @MaxLength(200, { message: 'deve ter no máximo 200 caracteres' })
  assunto?: string;
}

/** Uma linha do histórico de quem cuidou da conversa. */
export class AtribuicaoDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ enum: MotivoAtribuicao, enumName: 'MotivoAtribuicao' })
  motivo: MotivoAtribuicao;

  @ApiPropertyOptional({ nullable: true, type: PessoaDto })
  de: PessoaDto | null;

  @ApiPropertyOptional({ nullable: true, type: PessoaDto })
  para: PessoaDto | null;

  @ApiPropertyOptional({ nullable: true, type: ResumoFilaDto })
  deFila: ResumoFilaDto | null;

  @ApiPropertyOptional({ nullable: true, type: ResumoFilaDto })
  paraFila: ResumoFilaDto | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  nota: string | null;

  @ApiPropertyOptional({
    nullable: true,
    type: PessoaDto,
    description: 'Quem fez (nulo = o sistema).',
  })
  por: PessoaDto | null;

  @ApiProperty({ enum: TipoAtor, enumName: 'TipoAtor' })
  tipoAtor: TipoAtor;

  @ApiProperty({ format: 'date-time' })
  criadoEm: string;
}

/** Pessoa que pode receber uma conversa (transferência). */
export class AtendenteDto extends PessoaDto {
  @ApiProperty({ example: 'COMERCIAL' })
  papel: string;

  @ApiProperty({ example: 'Comercial' })
  rotuloPapel: string;

  @ApiPropertyOptional({ nullable: true, enum: Area, enumName: 'Area' })
  area: Area | null;

  @ApiProperty({ description: 'Conversas em aberto com a pessoa agora.' })
  emAberto: number;

  @ApiProperty({ description: 'Com o CRM aberto agora (tempo real).' })
  conectado: boolean;
}

/** `GET /atendimento/atendentes`. */
export class FiltroAtendentesDto {
  @ApiPropertyOptional({ enum: AREAS_DO_ATENDIMENTO })
  @IsOptional()
  @Transform(emMaiusculas)
  @IsIn(AREAS_DO_ATENDIMENTO, { message: 'deve ser COMERCIAL ou CS' })
  area?: AreaDoAtendimento;

  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @Transform(aparar)
  @IsString({ message: 'deve ser um texto' })
  @MaxLength(100, { message: 'deve ter no máximo 100 caracteres' })
  busca?: string;
}

/** Contagem do menu (`nao-lidas.atendimento`). */
export class NaoLidasDoAtendimentoDto {
  @ApiProperty({
    description:
      'Conversas em aberto com mensagens não lidas que estão comigo ou sem responsável nas filas da minha área.',
  })
  atendimento: number;
}
