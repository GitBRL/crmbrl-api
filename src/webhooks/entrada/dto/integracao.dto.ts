import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { AplicativoIntegracao } from '../../../generated/prisma/client';
import {
  aparar,
  MENSAGEM_TEXTO,
  maximo,
  mensagemDeValores,
} from '../../dto-comum';
import { CampoBuscadoDto, MapeamentoDto } from './webhook-entrada.dto';

// ---------------------------------------------------------------------------
// Catálogo (R32.1)
// ---------------------------------------------------------------------------

export class CampoDaCredencialDto {
  @ApiProperty({ example: 'chaveApi' })
  chave: string;

  @ApiProperty({ example: 'Chave da API' })
  rotulo: string;

  @ApiProperty({
    description:
      'Segredo: a tela usa campo de senha; a API só devolve mascarado.',
  })
  secreto: boolean;

  @ApiProperty()
  obrigatorio: boolean;

  @ApiProperty({ description: 'De onde copiar no aplicativo.' })
  descricao: string;

  @ApiPropertyOptional({ example: 'https://suaconta.api-us1.com' })
  exemplo?: string;
}

export class AutenticidadeDoAplicativoDto {
  @ApiProperty({
    enum: [
      'NENHUMA',
      'HMAC_X_ASSINATURA',
      'CHAVE_NO_CABECALHO',
      'TYPEFORM_ASSINATURA',
      'HOTMART_HOTTOK',
      'KIWIFY_ASSINATURA',
      'EDUZZ_ASSINATURA',
    ],
  })
  tipo: string;

  @ApiProperty({
    description: 'Como a integração confere que o envio veio do aplicativo.',
  })
  descricao: string;

  @ApiProperty({
    enum: ['NAO_USA', 'OPCIONAL', 'GERADO_PELO_CRM', 'OBRIGATORIO'],
    description:
      '`NAO_USA`: sem segredo; `OPCIONAL`: o Admin pode definir (`POST /webhooks/entradas/{id}/segredo`); `GERADO_PELO_CRM`: o CRM gera e registra no aplicativo (Typeform).',
  })
  segredo: string;

  @ApiProperty({ type: String, nullable: true, example: 'Segredo HMAC' })
  rotuloDoSegredo: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'X-Assinatura' })
  cabecalho: string | null;
}

export class PassoAPassoDto {
  @ApiProperty({ example: 'No Elementor' })
  titulo: string;

  @ApiProperty({ type: [String] })
  passos: string[];
}

export class ModeloDoAplicativoDto {
  @ApiProperty({ example: 'Elementor' })
  nome: string;

  @ApiProperty()
  descricao: string;

  @ApiProperty({ type: MapeamentoDto })
  mapeamento: MapeamentoDto;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description: 'Um corpo de exemplo como o mapeamento o enxerga.',
  })
  exemplo: Record<string, unknown>;
}

/** O que a tabela de eventos faz com um evento (plataformas de curso, R32.15). */
export class RegraDoEventoDto {
  @ApiProperty({
    enum: ['IGNORAR', 'ABRIR', 'GANHO', 'PERDIDO', 'ETIQUETAR'],
    description:
      '`IGNORAR`: nada. `ABRIR`: cria ou atualiza o negócio aberto do comprador na etapa (sem `etapaId`, a etapa inicial da integração). `GANHO`: marca o negócio como ganho, com valor e produto. `PERDIDO`: marca como perdido com motivo (age sobre o negócio da mesma transação ou o aberto do comprador; nunca cria). `ETIQUETAR`: só soma as etiquetas ao contato.',
  })
  acao: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  etapaId: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Motivo da perda (R5.5); sem ele vale o motivo padrão da integração.',
  })
  motivoPerda: string | null;

  @ApiProperty({ type: [String] })
  etiquetas: string[];
}

export class DefinicaoDeEventoDto {
  @ApiProperty({
    example: 'PURCHASE_APPROVED',
    description:
      'O código que a plataforma envia; é a chave da tabela `configuracao.eventos`.',
  })
  codigo: string;

  @ApiProperty({ example: 'Compra aprovada' })
  nome: string;

  @ApiProperty()
  descricao: string;

  @ApiProperty({
    enum: [
      'COMPRA',
      'PAGAMENTO_PENDENTE',
      'CARRINHO',
      'POS_VENDA',
      'ASSINATURA',
    ],
  })
  grupo: string;

  @ApiProperty({
    type: RegraDoEventoDto,
    description: 'O que o evento faz sem configuração (o modelo `VENDAS`).',
  })
  padrao: RegraDoEventoDto;
}

export class ModeloDeEventosDto {
  @ApiProperty({
    example: 'VENDAS',
    enum: ['VENDAS', 'SO_COMPRAS', 'RECUPERACAO'],
  })
  codigo: string;

  @ApiProperty()
  nome: string;

  @ApiProperty()
  descricao: string;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'object' },
    description:
      'Uma regra por evento, no formato de `configuracao.eventos`. Aplicar o modelo é gravar este objeto (a tela escolhe a etapa dos eventos `ABRIR`).',
  })
  regras: Record<string, RegraDoEventoDto>;
}

export class EventosDoAplicativoDto {
  @ApiProperty({ type: [DefinicaoDeEventoDto] })
  eventos: DefinicaoDeEventoDto[];

  @ApiProperty({ type: [ModeloDeEventosDto] })
  modelos: ModeloDeEventosDto[];

  @ApiProperty({
    description:
      'Mostrar o filtro por produto (`configuracao.produtos`: ids ou nomes; vazio = todos).',
  })
  filtroPorProduto: boolean;
}

export class AplicativoDto {
  @ApiProperty({ enum: AplicativoIntegracao, enumName: 'AplicativoIntegracao' })
  aplicativo: AplicativoIntegracao;

  @ApiProperty({ example: 'Elementor' })
  nome: string;

  @ApiProperty()
  descricao: string;

  @ApiProperty({
    description:
      'Falso para os aplicativos que chegam na próxima etapa (Facebook Lead Ads, Hotmart, Kiwify, Eduzz): aparecem no catálogo, mas criar a integração dá 422.',
  })
  disponivel: boolean;

  @ApiProperty({
    enum: ['WEBHOOK', 'API'],
    description:
      '`WEBHOOK`: a ferramenta chama o endereço; `API`: o CRM busca na API do aplicativo.',
  })
  entrega: string;

  @ApiProperty({ type: [String], example: ['application/json'] })
  tiposDeConteudo: string[];

  @ApiProperty({ type: AutenticidadeDoAplicativoDto })
  autenticidade: AutenticidadeDoAplicativoDto;

  @ApiProperty({
    type: [CampoDaCredencialDto],
    nullable: true,
    description:
      'Campos da credencial que o assistente pede (passo "Ação e nome"), ou nulo se o aplicativo não usa credencial.',
  })
  credencial: CampoDaCredencialDto[] | null;

  @ApiProperty({
    description:
      'Mostrar "Buscar campos da integração" (`POST /webhooks/entradas/{id}/buscar-campos`).',
  })
  buscaCampos: boolean;

  @ApiProperty({
    description:
      'Mostrar a escolha do formulário (`GET /webhooks/entradas/{id}/formularios`).',
  })
  escolheFormulario: boolean;

  @ApiProperty({
    type: PassoAPassoDto,
    description: 'O passo a passo do lado da ferramenta (passo "Começar").',
  })
  passoAPasso: PassoAPassoDto;

  @ApiProperty({
    type: ModeloDoAplicativoDto,
    nullable: true,
    description:
      'O modelo de mapeamento pronto (`modeloMapeamento: DO_APLICATIVO`).',
  })
  modelo: ModeloDoAplicativoDto | null;

  @ApiProperty({
    type: [String],
    description: 'Dicas para o passo de mapeamento.',
  })
  dicas: string[];
  @ApiProperty({
    type: EventosDoAplicativoDto,
    nullable: true,
    description:
      'Plataformas de curso (Hotmart, Kiwify, Eduzz): os eventos conhecidos (com nome amigável e a ação padrão), os modelos prontos e o filtro por produto. Nulo nos demais aplicativos.',
  })
  eventos: EventosDoAplicativoDto | null;
}

export class CatalogoDeAplicativosDto {
  @ApiProperty({
    type: [AplicativoDto],
    description: 'Em ordem alfabética (como a tela do Clint).',
  })
  aplicativos: AplicativoDto[];

  @ApiProperty({
    type: 'array',
    items: {
      type: 'object',
      properties: {
        destino: { type: 'string', example: 'etapa' },
        descricao: { type: 'string' },
      },
    },
    description:
      'Todos os destinos do mapeamento (campos do CRM), inclusive etapa, dono, status e motivoPerda.',
  })
  destinos: { destino: string; descricao: string }[];
}

// ---------------------------------------------------------------------------
// Credencial, busca de campos e formulários (R32.8, R32.9)
// ---------------------------------------------------------------------------

export class TestarCredencialDto {
  @ApiProperty({ enum: AplicativoIntegracao, enumName: 'AplicativoIntegracao' })
  @IsEnum(AplicativoIntegracao, {
    message: mensagemDeValores(Object.values(AplicativoIntegracao)),
  })
  aplicativo: AplicativoIntegracao;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    example: { chaveApi: '…' },
  })
  @IsObject({ message: 'deve ser um objeto' })
  credencial: Record<string, unknown>;
}

export class ResultadoDoTesteDaCredencialDto {
  @ApiProperty({ description: 'O aplicativo aceitou a credencial.' })
  valida: boolean;

  @ApiProperty({ example: 'Credencial aceita.' })
  mensagem: string;
}

export class CamposBuscadosDto {
  @ApiProperty({ type: [CampoBuscadoDto] })
  campos: CampoBuscadoDto[];

  @ApiProperty({ format: 'date-time' })
  buscadosEm: string;
}

export class FormularioDto {
  @ApiProperty({ example: 'lT9uwa' })
  id: string;

  @ApiProperty({ example: 'Contato do site' })
  titulo: string;

  @ApiProperty({ type: String, nullable: true })
  url: string | null;

  @ApiProperty({ type: String, nullable: true })
  atualizadoEm: string | null;
}

export class FiltroFormulariosDto {
  @ApiPropertyOptional({ description: 'Parte do título do formulário.' })
  @IsOptional()
  @Transform(aparar)
  @IsString({ message: MENSAGEM_TEXTO })
  @MaxLength(100, maximo(100))
  busca?: string;
}

export class SincronizacaoDto {
  @ApiProperty({
    description: 'O webhook está registrado no formulário do aplicativo.',
  })
  registrado: boolean;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Por que não foi possível (credencial recusada, endereço antigo…).',
  })
  erro: string | null;
}

export class EnderecoDaIntegracaoDto {
  @ApiProperty({
    example: 'https://crm.brl.com.br/api/v1/webhooks/entrada/q3Xa9Lp0bZ…',
    description:
      'O endereço completo, com o token (só o Admin chega aqui). Para copiar no passo "Endereço".',
  })
  url: string;
}

// ---------------------------------------------------------------------------
// Campos recebidos (R32.7)
// ---------------------------------------------------------------------------

export class FiltroCamposRecebidosDto {
  @ApiPropertyOptional({
    minimum: 1,
    maximum: 50,
    default: 20,
    description: 'Quantos dos últimos recebimentos ler.',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' && value.trim() !== '' ? Number(value) : value,
  )
  @IsInt({ message: 'deve ser um número inteiro' })
  @Min(1, { message: 'deve ser pelo menos 1' })
  @Max(50, { message: 'deve ser no máximo 50' })
  limite?: number;
}

export class CampoRecebidoDto {
  @ApiProperty({
    example: 'fields.email',
    description: 'O caminho como o mapeamento o escreve.',
  })
  caminho: string;

  @ApiProperty({ enum: ['texto', 'numero', 'booleano', 'lista', 'objeto'] })
  tipo: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'ma•••@empresa.com.br',
    description:
      'Um valor de exemplo, mascarado (e-mails, telefones e valores longos).',
  })
  exemplo: string | null;

  @ApiProperty({
    example: 4,
    description: 'Em quantos dos recebimentos lidos o campo apareceu.',
  })
  ocorrencias: number;
}

export class CamposRecebidosDto {
  @ApiProperty({ type: [CampoRecebidoDto] })
  campos: CampoRecebidoDto[];

  @ApiProperty({
    example: 5,
    description: 'Quantos recebimentos (com corpo guardado) foram lidos.',
  })
  recebimentosLidos: number;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'O recebimento mais recente lido.',
  })
  ultimoRecebimentoEm: string | null;
}
