import {
  ApiProperty,
  ApiPropertyOptional,
  getSchemaPath,
} from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  MaxLength,
} from 'class-validator';
import {
  QUANTIDADE_MAXIMA_ETIQUETAS,
  TAMANHO_MAXIMO_ETIQUETA,
} from '../../../comum/dominio/etiquetas';
import { PaginacaoDto } from '../../../comum/paginacao/paginacao';
import {
  AlvoIntegracao,
  AplicativoIntegracao,
  EstrategiaDistribuicao,
  ModeloMapeamento,
  ModoIntegracao,
  StatusNegocio,
} from '../../../generated/prisma/client';
import {
  aparar,
  EtapaDoWebhookDto,
  FunilDoWebhookDto,
  lerBooleano,
  MENSAGEM_BOOLEANO,
  paraLista,
  MENSAGEM_TEXTO,
  MENSAGEM_UUID,
  maximo,
  mensagemDeValores,
  OpcionalNaoNulo,
  UsuarioDoWebhookDto,
} from '../../dto-comum';
import {
  TAMANHO_MAXIMO_NOME_WEBHOOK,
  TAMANHO_MAXIMO_SEGREDO,
  TAMANHO_MINIMO_SEGREDO,
} from '../../webhooks.constantes';

const MENSAGEM_ESTRATEGIA = {
  message: mensagemDeValores(Object.values(EstrategiaDistribuicao)),
};
const MENSAGEM_MODELO = {
  message: mensagemDeValores(Object.values(ModeloMapeamento)),
};
const MENSAGEM_APLICATIVO = {
  message: mensagemDeValores(Object.values(AplicativoIntegracao)),
};
const MENSAGEM_ALVO = {
  message: mensagemDeValores(Object.values(AlvoIntegracao)),
};
const MENSAGEM_MODO = {
  message: mensagemDeValores(Object.values(ModoIntegracao)),
};
const MENSAGEM_STATUS_INICIAL = {
  message: mensagemDeValores(Object.values(StatusNegocio)),
};
const MENSAGEM_SEGREDO = {
  message: `deve ter de ${TAMANHO_MINIMO_SEGREDO} a ${TAMANHO_MAXIMO_SEGREDO} caracteres`,
};

// ---------------------------------------------------------------------------
// Mapeamento (documentação e resposta)
// ---------------------------------------------------------------------------

export class RegraDeCampoDto {
  @ApiProperty({
    example: 'lead.contatos[0].email',
    description:
      'Caminho no corpo recebido: chaves separadas por ponto, índice de lista (`itens[0]`) e um curinga `*` opcional no último trecho (`planilha_*`).',
  })
  caminho: string;

  @ApiProperty({
    example: 'email',
    description:
      '`nome`, `email`, `telefone`, `empresa`, `cargo`, `titulo`, `valor`, `valorRecorrente`, `etiquetas`, ' +
      '`utm.source|medium|campaign|term|content` ou `camposPersonalizados.<chave>` (com curinga, a chave leva `*`).',
  })
  destino: string;
}

export class CondicaoParaIgnorarDto {
  @ApiProperty({ example: 'teste' })
  caminho: string;

  @ApiProperty({
    oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }],
    example: true,
    description:
      'Se o campo vier com este valor (sem diferenciar maiúsculas), o recebimento é ignorado.',
  })
  valor: string | number | boolean;
}

export class MapeamentoDto {
  @ApiProperty({
    type: [RegraDeCampoDto],
    description:
      'Regras na ordem: para o mesmo destino vale o primeiro caminho com valor (no e-mail e no telefone, o primeiro válido); etiquetas se somam.',
  })
  campos: RegraDeCampoDto[];

  @ApiProperty({ type: [CondicaoParaIgnorarDto] })
  ignorarQuando: CondicaoParaIgnorarDto[];
}

// ---------------------------------------------------------------------------
// Entrada (corpo e query)
// ---------------------------------------------------------------------------

/** Campos comuns da criação e da edição. */
class CamposDoWebhookEntradaDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Funil de entrada (R8.1). Padrão: o funil-base de Marketing.',
  })
  @OpcionalNaoNulo()
  @IsUUID('all', MENSAGEM_UUID)
  funilId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Etapa de entrada, do funil escolhido (não pode ser a de perda). Padrão: "Novo lead" no Marketing; nos outros funis, a primeira etapa aberta.',
  })
  @OpcionalNaoNulo()
  @IsUUID('all', MENSAGEM_UUID)
  etapaId?: string;

  @ApiPropertyOptional({
    enum: EstrategiaDistribuicao,
    enumName: 'EstrategiaDistribuicao',
    default: 'RODIZIO',
    description:
      'Como o negócio criado ganha responsável (R5.8): rodízio da área, um responsável fixo ou o líder da área.',
  })
  @OpcionalNaoNulo()
  @IsEnum(EstrategiaDistribuicao, MENSAGEM_ESTRATEGIA)
  estrategia?: EstrategiaDistribuicao;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'Obrigatório com `RESPONSAVEL_FIXO`: usuário ativo que vê o funil (da área, C-level ou Admin).',
  })
  @IsOptional()
  @IsUUID('all', MENSAGEM_UUID)
  responsavelFixoId?: string | null;

  @ApiPropertyOptional({
    enum: ModeloMapeamento,
    enumName: 'ModeloMapeamento',
    default: 'GENERICO',
    description:
      '`GENERICO` e `DISPAROS_BRL` são modelos prontos do aplicativo Webhook (veja `GET /webhooks/entradas/modelos`); `DO_APLICATIVO` usa o modelo pronto do aplicativo (padrão dos demais aplicativos); `PERSONALIZADO` usa o `mapeamento`.',
  })
  @OpcionalNaoNulo()
  @IsEnum(ModeloMapeamento, MENSAGEM_MODELO)
  modeloMapeamento?: ModeloMapeamento;

  @ApiPropertyOptional({
    allOf: [{ $ref: getSchemaPath(MapeamentoDto) }],
    description:
      'Só com `PERSONALIZADO`: precisa de uma regra para `nome` e outra para `email` ou `telefone`.',
  })
  @OpcionalNaoNulo()
  @IsObject({ message: 'deve ser um objeto { campos, ignorarQuando }' })
  mapeamento?: Record<string, unknown>;

  @ApiPropertyOptional({
    type: [String],
    example: ['Landing', 'Black Friday'],
    description: 'Etiquetas acrescentadas a todo contato que chegar por aqui.',
  })
  @OpcionalNaoNulo()
  @IsArray({ message: 'deve ser uma lista' })
  @ArrayMaxSize(QUANTIDADE_MAXIMA_ETIQUETAS, {
    message: `deve ter no máximo ${QUANTIDADE_MAXIMA_ETIQUETAS} etiquetas`,
  })
  @IsString({ each: true, message: `(cada item) ${MENSAGEM_TEXTO}` })
  @MaxLength(TAMANHO_MAXIMO_ETIQUETA, {
    each: true,
    message: `(cada item) deve ter no máximo ${TAMANHO_MAXIMO_ETIQUETA} caracteres`,
  })
  etiquetasFixas?: string[];

  @ApiPropertyOptional({
    enum: AlvoIntegracao,
    enumName: 'AlvoIntegracao',
    default: 'NEGOCIO',
    description:
      'O que o recebimento cria ou atualiza: `NEGOCIO` (com o contato) ou só o `CONTATO` (R32.3).',
  })
  @OpcionalNaoNulo()
  @IsEnum(AlvoIntegracao, MENSAGEM_ALVO)
  alvo?: AlvoIntegracao;

  @ApiPropertyOptional({
    enum: ModoIntegracao,
    enumName: 'ModoIntegracao',
    default: 'CRIAR_OU_ATUALIZAR',
    description:
      '`CRIAR`: todo recebimento cria um negócio novo; `CRIAR_OU_ATUALIZAR`: atualiza o negócio aberto mais recente do contato no funil (registrando a reconversão) ou cria; `ATUALIZAR`: só atualiza (sem negócio aberto, o recebimento fica IGNORADO) (R32.3).',
  })
  @OpcionalNaoNulo()
  @IsEnum(ModoIntegracao, MENSAGEM_MODO)
  modo?: ModoIntegracao;

  @ApiPropertyOptional({
    enum: StatusNegocio,
    enumName: 'StatusNegocio',
    default: 'ABERTO',
    description:
      'Status do negócio criado. `PERDIDO` exige `motivoPerdaPadrao` (R5.5, R32.4).',
  })
  @OpcionalNaoNulo()
  @IsEnum(StatusNegocio, MENSAGEM_STATUS_INICIAL)
  statusInicial?: StatusNegocio;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: 200,
    description:
      'Motivo da perda quando o recebimento marca o negócio como perdido sem trazer o motivo (R5.5).',
  })
  @IsOptional()
  @Transform(aparar)
  @IsString({ message: MENSAGEM_TEXTO })
  @MaxLength(200, maximo(200))
  motivoPerdaPadrao?: string | null;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { type: 'string' },
    example: { urlConta: 'https://conta.api-us1.com', chaveApi: '…' },
    description:
      'Credencial do aplicativo (veja `credencial` no catálogo). Guardada cifrada (R10.3) e devolvida só mascarada. Na edição, só os campos enviados mudam; trocar a credencial tira a integração de "precisa de atenção".',
  })
  @OpcionalNaoNulo()
  @IsObject({ message: 'deve ser um objeto' })
  credencial?: Record<string, unknown>;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    example: { formularioId: 'lT9uwa' },
    description:
      'Configuração própria do aplicativo: `formularioId` (Typeform; o CRM registra o webhook nele) e `cabecalhoDeAutenticacao` (RD Station). `null` remove a chave.',
  })
  @OpcionalNaoNulo()
  @IsObject({ message: 'deve ser um objeto' })
  configuracao?: Record<string, unknown>;

  @ApiPropertyOptional({
    description:
      'Desativado, o endereço responde 410 (R8.7) e nada é registrado.',
  })
  @OpcionalNaoNulo()
  @IsBoolean(MENSAGEM_BOOLEANO)
  ativo?: boolean;
}

export class CriarWebhookEntradaDto extends CamposDoWebhookEntradaDto {
  @ApiPropertyOptional({
    enum: AplicativoIntegracao,
    enumName: 'AplicativoIntegracao',
    default: 'WEBHOOK',
    description:
      'O aplicativo da integração (veja `GET /webhooks/aplicativos`). Não muda depois de criada.',
  })
  @OpcionalNaoNulo()
  @IsEnum(AplicativoIntegracao, MENSAGEM_APLICATIVO)
  aplicativo?: AplicativoIntegracao;

  @ApiProperty({
    example: 'Landing Black Friday',
    maxLength: TAMANHO_MAXIMO_NOME_WEBHOOK,
    description:
      'Único entre os pontos de entrada; vira o "detalhe" da origem dos contatos (R4.3).',
  })
  @Transform(aparar)
  @IsString({ message: MENSAGEM_TEXTO })
  @IsNotEmpty({ message: 'é obrigatório' })
  @MaxLength(TAMANHO_MAXIMO_NOME_WEBHOOK, maximo(TAMANHO_MAXIMO_NOME_WEBHOOK))
  nome: string;

  @ApiPropertyOptional({
    minLength: TAMANHO_MINIMO_SEGREDO,
    maxLength: TAMANHO_MAXIMO_SEGREDO,
    description:
      'Segredo HMAC (R8.3) já combinado com o sistema que envia. Com segredo, toda chamada precisa de `X-Assinatura`.',
  })
  @OpcionalNaoNulo()
  @IsString({ message: MENSAGEM_TEXTO })
  @Length(TAMANHO_MINIMO_SEGREDO, TAMANHO_MAXIMO_SEGREDO, MENSAGEM_SEGREDO)
  segredo?: string;

  @ApiPropertyOptional({
    default: false,
    description:
      'Gera um segredo HMAC (mostrado só nesta resposta). Não combine com `segredo`.',
  })
  @OpcionalNaoNulo()
  @IsBoolean(MENSAGEM_BOOLEANO)
  gerarSegredo?: boolean;
}

export class AtualizarWebhookEntradaDto extends CamposDoWebhookEntradaDto {
  @ApiPropertyOptional({
    example: 'Landing Black Friday',
    maxLength: TAMANHO_MAXIMO_NOME_WEBHOOK,
  })
  @OpcionalNaoNulo()
  @Transform(aparar)
  @IsString({ message: MENSAGEM_TEXTO })
  @IsNotEmpty({ message: 'é obrigatório' })
  @MaxLength(TAMANHO_MAXIMO_NOME_WEBHOOK, maximo(TAMANHO_MAXIMO_NOME_WEBHOOK))
  nome?: string;
}

export class DefinirSegredoEntradaDto {
  @ApiPropertyOptional({
    minLength: TAMANHO_MINIMO_SEGREDO,
    maxLength: TAMANHO_MAXIMO_SEGREDO,
    description:
      'O segredo combinado com o sistema que envia. Sem ele, a API gera um e o mostra só nesta resposta.',
  })
  @OpcionalNaoNulo()
  @IsString({ message: MENSAGEM_TEXTO })
  @Length(TAMANHO_MINIMO_SEGREDO, TAMANHO_MAXIMO_SEGREDO, MENSAGEM_SEGREDO)
  segredo?: string;
}

export class FiltroIntegracoesDto extends PaginacaoDto {
  @ApiPropertyOptional({
    description: 'Parte do nome (sem diferenciar maiúsculas).',
  })
  @IsOptional()
  @Transform(aparar)
  @IsString({ message: MENSAGEM_TEXTO })
  @MaxLength(100, maximo(100))
  busca?: string;

  @ApiPropertyOptional({
    description: 'Só as ativas (`true`) ou só as desativadas (`false`).',
  })
  @IsOptional()
  @Transform(lerBooleano)
  @IsBoolean(MENSAGEM_BOOLEANO)
  ativo?: boolean;

  @ApiPropertyOptional({
    enum: AplicativoIntegracao,
    enumName: 'AplicativoIntegracao',
    isArray: true,
    description:
      'Um ou vários aplicativos (repita o parâmetro ou separe por vírgula).',
  })
  @IsOptional()
  @Transform(paraLista)
  @IsArray({ message: 'deve ser uma lista' })
  @IsEnum(AplicativoIntegracao, {
    each: true,
    message: `(cada item) ${mensagemDeValores(Object.values(AplicativoIntegracao))}`,
  })
  aplicativo?: AplicativoIntegracao[];

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Só as integrações deste funil.',
  })
  @IsOptional()
  @IsUUID('all', MENSAGEM_UUID)
  funilId?: string;

  @ApiPropertyOptional({
    description:
      'Só as que precisam de atenção (`true`) ou só as que não precisam (`false`).',
  })
  @IsOptional()
  @Transform(lerBooleano)
  @IsBoolean(MENSAGEM_BOOLEANO)
  precisaAtencao?: boolean;
}

export class FiltroWebhooksDto extends PaginacaoDto {
  @ApiPropertyOptional({
    description: 'Parte do nome (sem diferenciar maiúsculas).',
  })
  @IsOptional()
  @Transform(aparar)
  @IsString({ message: MENSAGEM_TEXTO })
  @MaxLength(100, maximo(100))
  busca?: string;

  @ApiPropertyOptional({
    description: 'Só os ativos (`true`) ou só os desativados (`false`).',
  })
  @IsOptional()
  @Transform(lerBooleano)
  @IsBoolean(MENSAGEM_BOOLEANO)
  ativo?: boolean;
}

// ---------------------------------------------------------------------------
// Saída
// ---------------------------------------------------------------------------

export class ContagemDeRecebimentosDto {
  @ApiProperty({
    example: 42,
    description: 'Recebimentos nas últimas 24 horas.',
  })
  total: number;

  @ApiProperty({ example: 1, description: 'Deles, com erro.' })
  erros: number;
}

export class CampoDaCredencialPreenchidoDto {
  @ApiProperty({ example: 'chaveApi' })
  chave: string;

  @ApiProperty({ example: 'Chave da API' })
  rotulo: string;

  @ApiProperty({ description: 'Segredo: só o final aparece (R10.3).' })
  secreto: boolean;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '••••••••3f9a',
    description:
      'O valor (mascarado se for segredo), ou nulo se não foi informado.',
  })
  valor: string | null;
}

export class CredencialDaIntegracaoDto {
  @ApiProperty({ description: 'Há credencial guardada.' })
  configurada: boolean;

  @ApiProperty({ type: [CampoDaCredencialPreenchidoDto] })
  campos: CampoDaCredencialPreenchidoDto[];
}

export class CampoBuscadoDto {
  @ApiProperty({
    example: 'contact.fields.3',
    description: 'O caminho para o mapeamento.',
  })
  caminho: string;

  @ApiProperty({ example: 'Cidade' })
  rotulo: string;

  @ApiProperty({ type: String, nullable: true, example: 'text' })
  tipo: string | null;
}

export class WebhookEntradaDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'Landing Black Friday' })
  nome: string;

  @ApiProperty({
    example: 'q3Xa9Lp0',
    description:
      'Começo do token, para reconhecer o endereço sem revelá-lo (R8.2).',
  })
  tokenPrefixo: string;

  @ApiProperty({
    example: 'https://crm.brl.com.br/api/v1/webhooks/entrada/q3Xa9Lp0…',
    description:
      'O endereço com o token cortado. O completo só aparece ao criar e ao regenerar o token (R8.2).',
  })
  enderecoMascarado: string;

  @ApiProperty({ type: FunilDoWebhookDto })
  funil: FunilDoWebhookDto;

  @ApiProperty({ type: EtapaDoWebhookDto })
  etapa: EtapaDoWebhookDto;

  @ApiProperty({
    enum: EstrategiaDistribuicao,
    enumName: 'EstrategiaDistribuicao',
  })
  estrategia: EstrategiaDistribuicao;

  @ApiProperty({ type: UsuarioDoWebhookDto, nullable: true })
  responsavelFixo: UsuarioDoWebhookDto | null;

  @ApiProperty({ enum: ModeloMapeamento, enumName: 'ModeloMapeamento' })
  modeloMapeamento: ModeloMapeamento;

  @ApiProperty({
    type: MapeamentoDto,
    description:
      'O mapeamento que vale: o do modelo pronto ou o personalizado.',
  })
  mapeamento: MapeamentoDto;

  @ApiProperty({ type: [String] })
  etiquetasFixas: string[];

  @ApiProperty({
    description: 'Com segredo, as chamadas precisam de `X-Assinatura` (R8.3).',
  })
  exigeAssinatura: boolean;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '••••••••3f9a',
    description: 'O segredo HMAC mascarado (R10.3).',
  })
  segredoMascarado: string | null;

  @ApiProperty({
    enum: AplicativoIntegracao,
    enumName: 'AplicativoIntegracao',
    example: 'WEBHOOK',
  })
  aplicativo: AplicativoIntegracao;

  @ApiProperty({ example: 'Webhook' })
  aplicativoNome: string;

  @ApiProperty({ enum: AlvoIntegracao, enumName: 'AlvoIntegracao' })
  alvo: AlvoIntegracao;

  @ApiProperty({ enum: ModoIntegracao, enumName: 'ModoIntegracao' })
  modo: ModoIntegracao;

  @ApiProperty({ enum: StatusNegocio, enumName: 'StatusNegocio' })
  statusInicial: StatusNegocio;

  @ApiProperty({ type: String, nullable: true })
  motivoPerdaPadrao: string | null;

  @ApiProperty({
    type: CredencialDaIntegracaoDto,
    description:
      'A credencial do aplicativo, com os segredos mascarados (R10.3).',
  })
  credencial: CredencialDaIntegracaoDto;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description:
      'Configuração própria do aplicativo (sem a lista de campos buscados, que vem em `camposBuscados`).',
  })
  configuracao: Record<string, unknown>;

  @ApiProperty({
    type: [CampoBuscadoDto],
    nullable: true,
    description:
      'Os campos da última busca pela credencial ("Buscar campos da integração"), ou nulo se ainda não houve.',
  })
  camposBuscados: CampoBuscadoDto[] | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  camposBuscadosEm: string | null;

  @ApiProperty({
    enum: ['ATIVA', 'INATIVA', 'PRECISA_ATENCAO'],
    description:
      'Situação para a lista: ativa, inativa ou precisa de atenção (credencial recusada, R32.9).',
  })
  situacao: 'ATIVA' | 'INATIVA' | 'PRECISA_ATENCAO';

  @ApiProperty({
    description: 'A credencial foi recusada pelo aplicativo (R32.9).',
  })
  precisaAtencao: boolean;

  @ApiProperty({ type: String, nullable: true })
  atencaoMotivo: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  atencaoEm: string | null;

  @ApiProperty({
    description:
      'O endereço completo pode ser reaberto (`GET /webhooks/entradas/{id}/endereco`). Falso nos pontos criados antes da Onda H: regenere o token.',
  })
  enderecoDisponivel: boolean;

  @ApiProperty()
  ativo: boolean;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  ultimoRecebimentoEm: string | null;

  @ApiProperty({ type: ContagemDeRecebimentosDto })
  recebimentos24h: ContagemDeRecebimentosDto;

  @ApiProperty({ type: UsuarioDoWebhookDto, nullable: true })
  criadoPor: UsuarioDoWebhookDto | null;

  @ApiProperty({ format: 'date-time' })
  criadoEm: string;

  @ApiProperty({ format: 'date-time' })
  atualizadoEm: string;
}

export class WebhookEntradaCriadoDto {
  @ApiProperty({ type: WebhookEntradaDto })
  webhook: WebhookEntradaDto;

  @ApiProperty({
    example: 'https://crm.brl.com.br/api/v1/webhooks/entrada/q3Xa9Lp0bZ…',
    description:
      'Endereço completo, com o token (R8.2). Copie agora: depois só aparece mascarado.',
  })
  url: string;

  @ApiPropertyOptional({
    description:
      'O segredo HMAC gerado (só quando `gerarSegredo`). Copie agora.',
  })
  segredo?: string;
}

export class TokenRegeneradoDto {
  @ApiProperty({ type: WebhookEntradaDto })
  webhook: WebhookEntradaDto;

  @ApiProperty({
    description:
      'O endereço novo, completo. O anterior para de funcionar na hora (404).',
  })
  url: string;
}

export class SegredoDefinidoDto {
  @ApiProperty({ type: WebhookEntradaDto })
  webhook: WebhookEntradaDto;

  @ApiPropertyOptional({
    description: 'O segredo gerado pela API (só quando ela gera). Copie agora.',
  })
  segredo?: string;
}

export class DestinoDeMapeamentoDto {
  @ApiProperty({ example: 'telefone' })
  destino: string;

  @ApiProperty({ example: 'Telefone do contato (E.164; DDD validado).' })
  descricao: string;
}

export class ModeloDeMapeamentoDto {
  @ApiProperty({ enum: ['GENERICO', 'DISPAROS_BRL'] })
  modelo: string;

  @ApiProperty({ example: 'Disparos BRL' })
  nome: string;

  @ApiProperty()
  descricao: string;

  @ApiProperty({ type: MapeamentoDto })
  mapeamento: MapeamentoDto;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description: 'Um corpo de exemplo nesse formato.',
  })
  exemplo: Record<string, unknown>;
}

export class ModelosDeMapeamentoDto {
  @ApiProperty({ type: [ModeloDeMapeamentoDto] })
  modelos: ModeloDeMapeamentoDto[];

  @ApiProperty({
    type: [DestinoDeMapeamentoDto],
    description:
      'Destinos aceitos num mapeamento personalizado (além de `camposPersonalizados.<chave>`).',
  })
  destinos: DestinoDeMapeamentoDto[];
}
