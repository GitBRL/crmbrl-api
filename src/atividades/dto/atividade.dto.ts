import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  type Prisma,
  PrioridadeAtividade,
  ResultadoReuniao,
  StatusAtividade,
  TipoAtividade,
} from '../../generated/prisma/client';
import {
  ehAguardandoResultado,
  ehAtrasada,
  GRUPOS_DE_ATIVIDADES,
  type GrupoAtividade,
  grupoDaAtividade,
  type ReferenciaDeTempo,
} from '../regras-atividades';

const RESUMO_DE_USUARIO = {
  select: { id: true, nome: true, avatarUrl: true },
} as const;

/** O que a resposta de uma atividade precisa carregar junto (Prisma `include`). */
export const INCLUSOES_DA_ATIVIDADE = {
  responsavel: RESUMO_DE_USUARIO,
  criadoPor: RESUMO_DE_USUARIO,
  concluidaPor: RESUMO_DE_USUARIO,
  encaminhadaDe: RESUMO_DE_USUARIO,
  contato: { select: { id: true, nome: true } },
  empresa: { select: { id: true, nome: true } },
  negocio: {
    select: { id: true, titulo: true, funilId: true, responsavelId: true },
  },
} satisfies Prisma.AtividadeInclude;

export type AtividadeCompleta = Prisma.AtividadeGetPayload<{
  include: typeof INCLUSOES_DA_ATIVIDADE;
}>;

/**
 * Pessoa ligada à atividade (responsável, criador, quem concluiu, de quem veio).
 * O nome não repete o `UsuarioResumoDto` de usuários: o Swagger usa o nome da
 * classe como nome do schema, e um sobrescreveria o outro.
 */
export class UsuarioDaAtividadeDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'Ana Souza' })
  nome: string;

  @ApiPropertyOptional({ nullable: true, type: String })
  avatarUrl: string | null;
}

interface UsuarioResumivel {
  id: string;
  nome: string;
  avatarUrl: string | null;
}

function resumoDoUsuario(usuario: UsuarioResumivel): UsuarioDaAtividadeDto;
function resumoDoUsuario(
  usuario: UsuarioResumivel | null,
): UsuarioDaAtividadeDto | null;
function resumoDoUsuario(
  usuario: UsuarioResumivel | null,
): UsuarioDaAtividadeDto | null {
  return usuario
    ? { id: usuario.id, nome: usuario.nome, avatarUrl: usuario.avatarUrl }
    : null;
}

export class ContatoResumoDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'Maria Silva' })
  nome: string;
}

export class EmpresaResumoDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'ACME Ltda.' })
  nome: string;
}

export class NegocioResumoDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'ACME — plano anual' })
  titulo: string;

  @ApiProperty({ format: 'uuid' })
  funilId: string;
}

export class AtividadeDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ enum: TipoAtividade, enumName: 'TipoAtividade' })
  tipo: TipoAtividade;

  @ApiProperty({ example: 'Ligar para apresentar a proposta' })
  titulo: string;

  @ApiPropertyOptional({ nullable: true, type: String })
  descricao: string | null;

  @ApiProperty({ enum: StatusAtividade, enumName: 'StatusAtividade' })
  status: StatusAtividade;

  @ApiProperty({ enum: PrioridadeAtividade, enumName: 'PrioridadeAtividade' })
  prioridade: PrioridadeAtividade;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    format: 'date-time',
    description:
      'Data da atividade: o vencimento; na reunião, igual ao início (a API mantém).',
  })
  venceEm: string | null;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    format: 'date-time',
    description: 'Início da reunião (R6.1); nulo nos outros tipos.',
  })
  inicioEm: string | null;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    format: 'date-time',
    description: 'Fim da reunião (R6.1); nulo nos outros tipos.',
  })
  fimEm: string | null;

  @ApiProperty({
    description:
      'R6.3 — pendente com o prazo no passado (o vencimento; na reunião, o fim). Calculado na hora da resposta.',
  })
  atrasada: boolean;

  @ApiPropertyOptional({
    enum: ResultadoReuniao,
    enumName: 'ResultadoReuniao',
    nullable: true,
    description:
      'R6.6 — resultado da reunião concluída; nulo = sem resultado (e em outros tipos).',
  })
  resultadoReuniao: ResultadoReuniao | null;

  @ApiPropertyOptional({
    format: 'uuid',
    nullable: true,
    type: String,
    description:
      'R6.6 — a reunião de origem, quando esta nasceu de uma remarcação.',
  })
  remarcadaDeId: string | null;

  @ApiProperty({
    description:
      'R6.6 — reunião pendente com o início no passado. Calculado na hora da resposta.',
  })
  aguardandoResultado: boolean;

  @ApiPropertyOptional({
    enum: GRUPOS_DE_ATIVIDADES,
    enumName: 'GrupoAtividade',
    nullable: true,
    description:
      'Agrupamento da agenda, calculado na hora da resposta (fuso padrão America/Sao_Paulo, ou o `fusoHorario` da consulta). Nulo para nota e cancelada.',
  })
  grupo: GrupoAtividade | null;

  @ApiProperty({ type: UsuarioDaAtividadeDto })
  responsavel: UsuarioDaAtividadeDto;

  @ApiPropertyOptional({ type: UsuarioDaAtividadeDto, nullable: true })
  criadoPor: UsuarioDaAtividadeDto | null;

  @ApiPropertyOptional({ nullable: true, type: String, format: 'date-time' })
  concluidaEm: string | null;

  @ApiPropertyOptional({ type: UsuarioDaAtividadeDto, nullable: true })
  concluidaPor: UsuarioDaAtividadeDto | null;

  @ApiPropertyOptional({ nullable: true, type: String, format: 'date-time' })
  canceladaEm: string | null;

  @ApiPropertyOptional({ type: ContatoResumoDto, nullable: true })
  contato: ContatoResumoDto | null;

  @ApiPropertyOptional({ type: EmpresaResumoDto, nullable: true })
  empresa: EmpresaResumoDto | null;

  @ApiPropertyOptional({ type: NegocioResumoDto, nullable: true })
  negocio: NegocioResumoDto | null;

  @ApiPropertyOptional({
    type: UsuarioDaAtividadeDto,
    nullable: true,
    description:
      'De quem a atividade veio quando foi encaminhada por desligamento (R7.3).',
  })
  encaminhadaDe: UsuarioDaAtividadeDto | null;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    format: 'date-time',
    description: 'Quando foi encaminhada por desligamento (R7.3).',
  })
  encaminhadaEm: string | null;

  @ApiProperty({ format: 'date-time' })
  criadoEm: string;

  @ApiProperty({ format: 'date-time' })
  atualizadoEm: string;

  static de(
    atividade: AtividadeCompleta,
    referencia: ReferenciaDeTempo,
  ): AtividadeDto {
    const iso = (data: Date | null) => data?.toISOString() ?? null;
    return {
      id: atividade.id,
      tipo: atividade.tipo,
      titulo: atividade.titulo,
      descricao: atividade.descricao,
      status: atividade.status,
      prioridade: atividade.prioridade,
      venceEm: iso(atividade.venceEm),
      inicioEm: iso(atividade.inicioEm),
      fimEm: iso(atividade.fimEm),
      atrasada: ehAtrasada(atividade, referencia.agora),
      aguardandoResultado: ehAguardandoResultado(atividade, referencia.agora),
      resultadoReuniao: atividade.resultadoReuniao,
      remarcadaDeId: atividade.remarcadaDeId,
      grupo: grupoDaAtividade(atividade, referencia),
      responsavel: resumoDoUsuario(atividade.responsavel),
      criadoPor: resumoDoUsuario(atividade.criadoPor),
      concluidaEm: iso(atividade.concluidaEm),
      concluidaPor: resumoDoUsuario(atividade.concluidaPor),
      canceladaEm: iso(atividade.canceladaEm),
      contato: atividade.contato
        ? { id: atividade.contato.id, nome: atividade.contato.nome }
        : null,
      empresa: atividade.empresa
        ? { id: atividade.empresa.id, nome: atividade.empresa.nome }
        : null,
      negocio: atividade.negocio
        ? {
            id: atividade.negocio.id,
            titulo: atividade.negocio.titulo,
            funilId: atividade.negocio.funilId,
          }
        : null,
      encaminhadaDe: resumoDoUsuario(atividade.encaminhadaDe),
      encaminhadaEm: iso(atividade.encaminhadaEm),
      criadoEm: atividade.criadoEm.toISOString(),
      atualizadoEm: atividade.atualizadoEm.toISOString(),
    };
  }
}

export class GrupoDeAtividadesDto {
  @ApiProperty({ enum: GRUPOS_DE_ATIVIDADES, enumName: 'GrupoAtividade' })
  grupo: GrupoAtividade;

  @ApiProperty({ example: 'Próximos 7 dias' })
  rotulo: string;

  @ApiProperty({
    description: 'Quantas atividades o grupo tem (todas, não só as listadas).',
    example: 4,
  })
  total: number;

  @ApiProperty({
    type: [AtividadeDto],
    description:
      'As primeiras `limitePorGrupo`; as demais saem em `GET /atividades?grupo=…`.',
  })
  itens: AtividadeDto[];
}

export class ReferenciaDosGruposDto {
  @ApiProperty({ format: 'date-time', description: 'O "agora" do cálculo.' })
  agora: string;

  @ApiProperty({ example: 'America/Sao_Paulo' })
  fusoHorario: string;

  @ApiProperty({ format: 'date-time' })
  inicioDeHoje: string;

  @ApiProperty({ format: 'date-time', description: 'Fim de "hoje".' })
  inicioDeAmanha: string;

  @ApiProperty({
    format: 'date-time',
    description: 'Fim dos "próximos 7 dias" (de amanhã até hoje + 7).',
  })
  fimDosProximos7Dias: string;

  static de(referencia: ReferenciaDeTempo): ReferenciaDosGruposDto {
    return {
      agora: referencia.agora.toISOString(),
      fusoHorario: referencia.fusoHorario,
      inicioDeHoje: referencia.inicioDeHoje.toISOString(),
      inicioDeAmanha: referencia.inicioDeAmanha.toISOString(),
      fimDosProximos7Dias: referencia.fimDosProximos7Dias.toISOString(),
    };
  }
}

export class AtividadesAgrupadasDto {
  @ApiProperty({ type: ReferenciaDosGruposDto })
  referencia: ReferenciaDosGruposDto;

  @ApiProperty({
    type: [GrupoDeAtividadesDto],
    description:
      'Sempre os seis grupos, nesta ordem: ATRASADAS, HOJE, PROXIMOS_7_DIAS, MAIS_TARDE, SEM_DATA, CONCLUIDAS.',
  })
  grupos: GrupoDeAtividadesDto[];
}
