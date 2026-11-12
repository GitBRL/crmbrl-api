import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  aparar,
  apararOuNulo,
  maximo,
  MENSAGEM_BOOLEANO,
  MENSAGEM_OBJETO,
  MENSAGEM_OBRIGATORIO,
  MENSAGEM_TEXTO,
  MENSAGEM_UUID,
} from '../canais/comum/dto-comum';
import type { DirecaoLigacao, EstadoLigacao } from '../generated/prisma/client';
import {
  GravacaoDaLigacaoDto,
  ResumoDaLigacaoDto,
  TranscricaoDaLigacaoDto,
} from './gravacao/gravacao.dto';
import {
  RETENCAO_MAXIMA_DIAS,
  RETENCAO_MINIMA_DIAS,
} from './gravacao/gravacao.constantes';
import {
  TOQUE_MAXIMO_SEGUNDOS,
  TOQUE_MINIMO_SEGUNDOS,
} from './ligacoes.constantes';

/** Tamanho máximo de um SDP (as ofertas reais têm poucos KB). */
const LIMITE_DO_SDP = 100_000;

export class AtenderLigacaoDto {
  @ApiProperty({
    description:
      'Resposta SDP do navegador (`createAnswer` + `setLocalDescription`, depois de a coleta de candidatos ICE terminar ou estourar o tempo limite).',
  })
  @IsString(MENSAGEM_TEXTO)
  @IsNotEmpty(MENSAGEM_OBRIGATORIO)
  @MaxLength(LIMITE_DO_SDP, maximo(LIMITE_DO_SDP))
  sdp: string;
}

export class LigarDto {
  @ApiProperty({ description: 'Contato que vai receber a ligação.' })
  @IsUUID('all', MENSAGEM_UUID)
  contatoId: string;

  @ApiPropertyOptional({
    description:
      'Canal de WhatsApp oficial de onde ligar. Ausente: o canal da conversa do contato ou o único com ligações ativas.',
  })
  @IsOptional()
  @IsUUID('all', MENSAGEM_UUID)
  canalId?: string;

  @ApiProperty({
    description:
      'Oferta SDP do navegador (`createOffer` + `setLocalDescription`, depois da coleta de candidatos ICE).',
  })
  @IsString(MENSAGEM_TEXTO)
  @IsNotEmpty(MENSAGEM_OBRIGATORIO)
  @MaxLength(LIMITE_DO_SDP, maximo(LIMITE_DO_SDP))
  sdp: string;

  @ApiPropertyOptional({
    description:
      'Atividade de ligação (inclusive "Retornar ligação" e a etapa de ligação da régua) que esta ligação cumpre: se for atendida, ela é concluída.',
  })
  @IsOptional()
  @IsUUID('all', MENSAGEM_UUID)
  atividadeId?: string;
}

export class AnotarLigacaoDto {
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Anotação rápida da ligação (vai para a descrição da atividade). Nulo apaga.',
  })
  @Transform(apararOuNulo)
  @IsOptional()
  @IsString(MENSAGEM_TEXTO)
  @MaxLength(5000, maximo(5000))
  anotacao?: string | null;
}

export class PedirPermissaoDto {
  @ApiProperty()
  @IsUUID('all', MENSAGEM_UUID)
  contatoId: string;

  @ApiPropertyOptional({
    description: 'Canal oficial; ausente = como em `POST /ligacoes`.',
  })
  @IsOptional()
  @IsUUID('all', MENSAGEM_UUID)
  canalId?: string;

  @ApiPropertyOptional({
    description:
      'Texto da mensagem interativa (dentro da janela de 24 h). Ausente: texto padrão.',
  })
  @Transform(apararOuNulo)
  @IsOptional()
  @IsString(MENSAGEM_TEXTO)
  @MaxLength(1024, maximo(1024))
  texto?: string | null;

  @ApiPropertyOptional({
    description:
      'Fora da janela: template com o componente de permissão (`GET /whatsapp-oficial/canais/:id/templates`). Ausente: o primeiro aprovado.',
  })
  @IsOptional()
  @IsUUID('all', MENSAGEM_UUID)
  templateId?: string;

  @ApiPropertyOptional({
    type: [String],
    description:
      'Valores das variáveis do corpo do template. Ausente: a primeira variável leva o primeiro nome do contato.',
  })
  @IsOptional()
  @IsArray({ message: 'deve ser uma lista' })
  @ArrayMaxSize(10, { message: 'no máximo 10 variáveis' })
  @IsString({ each: true, message: 'cada variável deve ser um texto' })
  @MaxLength(200, {
    each: true,
    message: 'cada variável aceita até 200 caracteres',
  })
  variaveis?: string[];
}

export class AtualizarConfiguracaoLigacoesDto {
  @ApiPropertyOptional({
    description:
      'Liga ou desliga as chamadas no número (chama `POST /{phone_number_id}/settings` na Meta; se a Meta recusar, nada é gravado).',
  })
  @IsOptional()
  @IsBoolean(MENSAGEM_BOOLEANO)
  ativa?: boolean;

  @ApiPropertyOptional({
    description: 'Mostra o botão "Ligar" para o cliente no CRM.',
  })
  @IsOptional()
  @IsBoolean(MENSAGEM_BOOLEANO)
  botaoVisivel?: boolean;

  @ApiPropertyOptional({
    type: 'object',
    nullable: true,
    additionalProperties: true,
    description:
      'Horário das ligações, no formato do horário de atendimento (`{ fusoHorario, dias }`). Nulo = o horário de atendimento do canal.',
  })
  @IsOptional()
  @IsObject(MENSAGEM_OBJETO)
  horario?: Record<string, unknown> | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Fila que atende as ligações. Nula = a fila padrão do canal.',
  })
  @IsOptional()
  @IsUUID('all', MENSAGEM_UUID)
  filaId?: string | null;

  @ApiPropertyOptional({ description: 'Gravar as ligações (R30).' })
  @IsOptional()
  @IsBoolean(MENSAGEM_BOOLEANO)
  gravar?: boolean;

  @ApiPropertyOptional({
    description:
      'O webhook de saída `ligacao.encerrada` leva o resumo da ligação (R30.9). Desligado por padrão: o resumo cita o cliente. O áudio e a transcrição nunca saem.',
  })
  @IsOptional()
  @IsBoolean(MENSAGEM_BOOLEANO)
  webhookIncluiResumo?: boolean;

  @ApiPropertyOptional({
    description: `Dias de guarda da gravação e da transcrição (${RETENCAO_MINIMA_DIAS} a ${RETENCAO_MAXIMA_DIAS}; padrão 365). Passado o prazo, ambas são apagadas; o registro, a duração e o resumo ficam.`,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'deve ser um número inteiro' })
  @Min(RETENCAO_MINIMA_DIAS, {
    message: `mínimo de ${RETENCAO_MINIMA_DIAS} dia`,
  })
  @Max(RETENCAO_MAXIMA_DIAS, {
    message: `máximo de ${RETENCAO_MAXIMA_DIAS} dias`,
  })
  retencaoDias?: number;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      'Áudio de aviso (arquivo enviado em `POST /arquivos?contexto=LIGACAO`, até 5 MB) que o navegador toca para o cliente ao atender. Nulo remove o aviso.',
  })
  @IsOptional()
  @IsUUID('all', MENSAGEM_UUID)
  avisoArquivoId?: string | null;

  @ApiPropertyOptional({
    description: `Segundos tocando antes de virar perdida (${TOQUE_MINIMO_SEGUNDOS} a ${TOQUE_MAXIMO_SEGUNDOS}; sempre abaixo do prazo de 30 a 60 s da Meta).`,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'deve ser um número inteiro' })
  @Min(TOQUE_MINIMO_SEGUNDOS, {
    message: `mínimo de ${TOQUE_MINIMO_SEGUNDOS} segundos`,
  })
  @Max(TOQUE_MAXIMO_SEGUNDOS, {
    message: `máximo de ${TOQUE_MAXIMO_SEGUNDOS} segundos`,
  })
  tempoDeToqueSegundos?: number;

  @ApiPropertyOptional({
    description:
      'Manda a mensagem automática ao cliente quando a ligação é perdida.',
  })
  @IsOptional()
  @IsBoolean(MENSAGEM_BOOLEANO)
  mensagemPerdidaAtiva?: boolean;

  @ApiPropertyOptional({ type: String, nullable: true })
  @Transform(apararOuNulo)
  @IsOptional()
  @IsString(MENSAGEM_TEXTO)
  @MaxLength(1000, maximo(1000))
  mensagemPerdida?: string | null;
}

const ESTADOS_DE_LIGACAO: readonly EstadoLigacao[] = [
  'CHAMANDO',
  'TOCANDO',
  'EM_ANDAMENTO',
  'ENCERRADA',
  'PERDIDA',
  'RECUSADA',
  'SEM_RESPOSTA',
  'FALHOU',
];

const MENSAGEM_DATA_LIGACAO = 'deve ser uma data no formato ISO 8601';

/** Lista separada por vírgula (`?situacao=PERDIDA,RECUSADA`) ou repetida (`?situacao=A&situacao=B`). */
function emLista({ value }: { value: unknown }): unknown {
  if (value === undefined || value === null || value === '') return undefined;
  const itens = Array.isArray(value) ? value : [value];
  return itens
    .flatMap((item) => (typeof item === 'string' ? item.split(',') : [item]))
    .map((item) => (typeof item === 'string' ? item.trim() : item))
    .filter((item) => item !== '');
}

export class FiltroDeLigacoesDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID('all', MENSAGEM_UUID)
  contatoId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID('all', MENSAGEM_UUID)
  conversaId?: string;

  @ApiPropertyOptional({ enum: ['RECEBIDA', 'FEITA'] })
  @IsOptional()
  @Transform(aparar)
  @IsString(MENSAGEM_TEXTO)
  direcao?: DirecaoLigacao;

  @ApiPropertyOptional({
    enum: ESTADOS_DE_LIGACAO,
    isArray: true,
    description:
      'Situação (uma ou mais; separadas por vírgula): `ENCERRADA` (atendida), `PERDIDA` (recebida sem atendimento), `RECUSADA`, `SEM_RESPOSTA`, `FALHOU`, `EM_ANDAMENTO`…',
  })
  @IsOptional()
  @Transform(emLista)
  @IsArray({ message: 'deve ser uma lista' })
  @ArrayMaxSize(ESTADOS_DE_LIGACAO.length, { message: 'lista grande demais' })
  @IsIn(ESTADOS_DE_LIGACAO, {
    each: true,
    message: `cada situação deve ser uma destas: ${ESTADOS_DE_LIGACAO.join(', ')}`,
  })
  situacao?: EstadoLigacao[];

  @ApiPropertyOptional({
    description:
      'Quem atendeu (recebida) ou ligou (feita). `sem` = ligações sem atendente (as perdidas).',
  })
  @IsOptional()
  @Transform(aparar)
  @Matches(
    /^(sem|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i,
    {
      message: 'deve ser um identificador (UUID) válido ou "sem"',
    },
  )
  atendenteId?: string;

  @ApiPropertyOptional({ description: 'Fila da conversa da ligação.' })
  @IsOptional()
  @IsUUID('all', MENSAGEM_UUID)
  filaId?: string;

  @ApiPropertyOptional({ description: 'Canal (número) da ligação.' })
  @IsOptional()
  @IsUUID('all', MENSAGEM_UUID)
  canalId?: string;

  @ApiPropertyOptional({
    format: 'date-time',
    description:
      'Início do período (inclusivo), pela hora em que a ligação começou.',
  })
  @IsOptional()
  @IsISO8601({ strict: true }, { message: MENSAGEM_DATA_LIGACAO })
  de?: string;

  @ApiPropertyOptional({
    format: 'date-time',
    description: 'Fim do período (exclusivo).',
  })
  @IsOptional()
  @IsISO8601({ strict: true }, { message: MENSAGEM_DATA_LIGACAO })
  ate?: string;

  @ApiPropertyOptional({
    description:
      'Busca no texto das transcrições (full text em português, sem distinguir acento nem maiúscula; aceita aspas para frase, `-palavra` para excluir e `or`). Só acha ligações que o usuário pode ver. Cada item volta com os trechos que casaram.',
  })
  @IsOptional()
  @Transform(aparar)
  @IsString(MENSAGEM_TEXTO)
  @MaxLength(200, maximo(200))
  busca?: string;

  @ApiPropertyOptional({ default: 20, description: 'Até 100.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'deve ser um número inteiro' })
  @Min(1, { message: 'mínimo de 1' })
  @Max(100, { message: 'máximo de 100' })
  limite?: number;

  @ApiPropertyOptional({ description: '`proximoCursor` da página anterior.' })
  @IsOptional()
  @IsString(MENSAGEM_TEXTO)
  cursor?: string;
}

export class ConsultaDePermissaoDto {
  @ApiProperty()
  @IsUUID('all', MENSAGEM_UUID)
  contatoId: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID('all', MENSAGEM_UUID)
  canalId?: string;

  @ApiPropertyOptional({
    description:
      '`true` consulta a Meta (`GET call_permissions`) e atualiza o registro antes de responder.',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === 'true' || value === true
      ? true
      : value === 'false' || value === false
        ? false
        : value,
  )
  @IsBoolean(MENSAGEM_BOOLEANO)
  atualizar?: boolean;
}

// ---------------------------------------------------------------------------
// Saída
// ---------------------------------------------------------------------------

export class PessoaDaLigacaoDto {
  @ApiProperty() id: string;
  @ApiProperty() nome: string;
}

export class QualificacaoDaLigacaoDto {
  @ApiProperty({ type: Number, nullable: true }) id: number | null;
  @ApiProperty() nome: string;
  @ApiProperty({ type: String, nullable: true }) observacao: string | null;
  @ApiProperty({ type: Boolean, nullable: true }) conversao: boolean | null;
  @ApiProperty({ type: String, nullable: true }) qualificadaEm: string | null;
}

export class CampanhaDaLigacaoDto {
  @ApiProperty() id: number;
  @ApiProperty({ type: String, nullable: true }) nome: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: '`manual`, `dialer` ou `receptive`.',
  })
  modo: string | null;
}

export class ContatoDaLigacaoDto {
  @ApiProperty() id: string;
  @ApiProperty() nome: string;
  @ApiProperty({ type: String, nullable: true }) telefone: string | null;
  @ApiProperty({ type: String, nullable: true }) empresa: string | null;
}

export class LigacaoDto {
  @ApiProperty() id: string;
  @ApiProperty({ enum: ['RECEBIDA', 'FEITA'] }) direcao: DirecaoLigacao;
  @ApiProperty({
    enum: [
      'CHAMANDO',
      'TOCANDO',
      'EM_ANDAMENTO',
      'ENCERRADA',
      'PERDIDA',
      'RECUSADA',
      'SEM_RESPOSTA',
      'FALHOU',
    ],
  })
  estado: EstadoLigacao;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Código do desfecho (`tempo_esgotado`, `cliente_desligou`…).',
  })
  motivo: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'O motivo em português.',
  })
  motivoTexto: string | null;
  @ApiProperty({
    type: PessoaDaLigacaoDto,
    nullable: true,
    description: 'Canal do WhatsApp; `null` nas ligações do 3C+.',
  })
  canal: PessoaDaLigacaoDto | null;
  @ApiProperty({
    enum: ['WHATSAPP', 'TRESC_PLUS'],
    description: 'R34.3: de onde vem a ligação.',
  })
  provedor: 'WHATSAPP' | 'TRESC_PLUS';
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Id da chamada no 3C+ (`provedor = TRESC_PLUS`).',
  })
  idExterno: string | null;
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Negócio da ligação (3C+), quando identificado.',
  })
  negocioId: string | null;
  @ApiProperty({
    type: QualificacaoDaLigacaoDto,
    nullable: true,
    description: 'Qualificação dada no 3C+ (R34.3).',
  })
  qualificacao: QualificacaoDaLigacaoDto | null;
  @ApiProperty({
    type: CampanhaDaLigacaoDto,
    nullable: true,
    description: 'Campanha do 3C+ e modo da chamada.',
  })
  campanha: CampanhaDaLigacaoDto | null;
  @ApiProperty({ type: ContatoDaLigacaoDto }) contato: ContatoDaLigacaoDto;
  @ApiProperty({ type: String, nullable: true }) conversaId: string | null;
  @ApiProperty({
    type: PessoaDaLigacaoDto,
    nullable: true,
    description: 'Quem atendeu (recebida) ou ligou (feita).',
  })
  atendente: PessoaDaLigacaoDto | null;
  @ApiProperty({ type: String, nullable: true }) atividadeId: string | null;
  @ApiProperty({ type: String, nullable: true }) anotacao: string | null;
  @ApiProperty() iniciadaEm: string;
  @ApiProperty({ type: String, nullable: true }) tocouEm: string | null;
  @ApiProperty({ type: String, nullable: true }) atendidaEm: string | null;
  @ApiProperty({ type: String, nullable: true }) encerradaEm: string | null;
  @ApiProperty({ type: Number, nullable: true }) duracaoSegundos: number | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Recebida tocando: até quando toca.',
  })
  expiraEm: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Só a quem foi chamado, enquanto toca.',
  })
  ofertaSdp: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Só ao atendente de uma ligação feita, enquanto conecta.',
  })
  respostaSdp: string | null;
  @ApiProperty({ description: 'O canal grava esta ligação (R30).' })
  gravar: boolean;
  @ApiProperty({ type: GravacaoDaLigacaoDto }) gravacao: GravacaoDaLigacaoDto;
  @ApiProperty({ type: TranscricaoDaLigacaoDto })
  transcricao: TranscricaoDaLigacaoDto;
  @ApiProperty({ type: ResumoDaLigacaoDto }) resumo: ResumoDaLigacaoDto;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Erro da Meta, se houve.',
  })
  erroCodigo: number | null;
  @ApiProperty({ type: String, nullable: true }) erroMensagem: string | null;
}

export class TrechoEncontradoDto {
  @ApiProperty({ enum: ['atendente', 'cliente', 'participante'] })
  falante: string;
  @ApiProperty({ description: 'Segundo do áudio em que o trecho começa.' })
  inicio: number;
  @ApiProperty() texto: string;
}

export class LigacaoDoHistoricoDto extends LigacaoDto {
  @ApiProperty({
    type: [TrechoEncontradoDto],
    description:
      'Com `busca`: até 3 trechos da transcrição que casaram (clicar toca a gravação nesse ponto). Vazio sem busca.',
  })
  trechosEncontrados: TrechoEncontradoDto[];
}

export class ListaDeLigacoesDto {
  @ApiProperty({ type: [LigacaoDoHistoricoDto] })
  itens: LigacaoDoHistoricoDto[];
  @ApiProperty({ type: String, nullable: true }) proximoCursor: string | null;
  @ApiProperty({
    description:
      'Total de ligações que casam com os filtros e que o usuário pode ver (com `busca`, até 5000).',
  })
  total: number;
}

export class LigacoesDoUsuarioDto {
  @ApiProperty({
    type: LigacaoDto,
    nullable: true,
    description:
      'Ligação em curso (chamando, tocando ou em andamento) do usuário.',
  })
  emAndamento: LigacaoDto | null;
  @ApiProperty({
    type: [LigacaoDto],
    description:
      'Ligações recebidas que ainda tocam para o usuário (para retomar depois de recarregar a página).',
  })
  tocando: LigacaoDto[];
}

export class LimiteDePedidoDto {
  @ApiProperty() pode: boolean;
  @ApiProperty({
    enum: ['limite_24h', 'limite_7d'],
    nullable: true,
    type: String,
  })
  motivo: 'limite_24h' | 'limite_7d' | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Quando o pedido volta a ser possível.',
  })
  liberaEm: string | null;
  @ApiProperty() usoNas24h: number;
  @ApiProperty() maximo24h: number;
  @ApiProperty() usoNos7d: number;
  @ApiProperty() maximo7d: number;
}

export class PermissaoDeLigacaoDto {
  @ApiProperty() contatoId: string;
  @ApiProperty() canalId: string;
  @ApiProperty({
    enum: ['NENHUMA', 'PEDIDA', 'CONCEDIDA', 'NEGADA', 'REVOGADA', 'EXPIRADA'],
  })
  situacao: string;
  @ApiProperty({
    enum: ['TEMPORARIA', 'PERMANENTE'],
    nullable: true,
    type: String,
  })
  tipo: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Temporária: até quando vale.',
  })
  validaAte: string | null;
  @ApiProperty({
    description:
      'Dá para ligar agora com o que o CRM sabe (a Meta é conferida de novo ao ligar).',
  })
  podeLigar: boolean;
  @ApiProperty({ type: LimiteDePedidoDto }) pedido: LimiteDePedidoDto;
  @ApiProperty({ type: String, nullable: true }) ultimoPedidoEm: string | null;
  @ApiProperty({ type: String, nullable: true }) respondidaEm: string | null;
  @ApiProperty({
    description:
      'Ligações feitas seguidas sem resposta (4 revogam a permissão na Meta).',
  })
  semRespostaSeguidas: number;
  @ApiProperty({
    description:
      'A janela de 24 h do canal está aberta para este contato (pedido interativo possível).',
  })
  janelaAberta: boolean;
  @ApiProperty({
    description:
      'Há template aprovado com o componente de permissão (pedido fora da janela).',
  })
  temTemplateDePermissao: boolean;
  @ApiProperty({ type: String, nullable: true }) consultadaEm: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Limite diário de ligações lido da Meta, quando a última consulta o informou.',
  })
  limiteDeLigacoes: string | null;
}

export class ConfiguracaoLigacoesDto {
  @ApiProperty() canalId: string;
  @ApiProperty() ativa: boolean;
  @ApiProperty() botaoVisivel: boolean;
  @ApiProperty({
    type: 'object',
    nullable: true,
    additionalProperties: true,
    description: 'Horário próprio das ligações; nulo = o do canal.',
  })
  horario: Record<string, unknown> | null;
  @ApiProperty({
    type: 'object',
    nullable: true,
    additionalProperties: true,
    description:
      'Horário que vale de fato (o próprio ou o do canal); nulo = 24 h.',
  })
  horarioEfetivo: Record<string, unknown> | null;
  @ApiProperty({ type: String, nullable: true }) filaId: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Fila que de fato atende (a escolhida ou a padrão do canal).',
  })
  filaEfetivaId: string | null;
  @ApiProperty() gravar: boolean;
  @ApiProperty({ description: 'Dias de guarda da gravação e da transcrição.' })
  retencaoDias: number;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Áudio de aviso do canal (o navegador toca ao atender: `GET /ligacoes/canais/:canalId/aviso`).',
  })
  avisoArquivoId: string | null;
  @ApiProperty() tempoDeToqueSegundos: number;
  @ApiProperty() mensagemPerdidaAtiva: boolean;
  @ApiProperty({
    description: 'O webhook `ligacao.encerrada` leva o resumo (R30.9).',
  })
  webhookIncluiResumo: boolean;
  @ApiProperty({ type: String, nullable: true }) mensagemPerdida: string | null;
  @ApiProperty({ type: String, nullable: true }) sincronizadaEm: string | null;
  @ApiProperty({ type: String, nullable: true }) ultimoErroMeta: string | null;
  @ApiProperty({
    description:
      'Webhook: o Admin precisa assinar o campo `calls` no app da Meta.',
  })
  campoDoWebhook: string;
}

export class CanalParaLigarDto {
  @ApiProperty() id: string;
  @ApiProperty() nome: string;
  @ApiProperty() botaoVisivel: boolean;
}

export class ConfiguracaoWebrtcDto {
  @ApiProperty({
    type: [String],
    description:
      'Servidores STUN para o `RTCPeerConnection` (vazio por padrão: sem TURN).',
  })
  stunUrls: string[];
}
